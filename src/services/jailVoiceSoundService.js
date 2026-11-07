import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  getVoiceConnections,
  joinVoiceChannel,
} from '@discordjs/voice';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';

const activeVoiceSoundGuilds = new Set();
const MAX_SOUND_SECONDS = 60;
const MAX_SOUND_BYTES = 15 * 1024 * 1024;
const PLAYBACK_TIMEOUT_MS = 75_000;

function isDiscordAttachmentUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname);
  } catch {
    return false;
  }
}


async function resolveStoredSoundUrl(guild, jail) {
  if (jail.voiceSoundChannelId && jail.voiceSoundMessageId) {
    const channel = await guild.channels.fetch(jail.voiceSoundChannelId).catch(() => null);
    const message = channel?.messages?.fetch
      ? await channel.messages.fetch(jail.voiceSoundMessageId).catch(() => null)
      : null;
    const attachment = message?.attachments?.first?.();
    if (attachment?.url) return attachment.url;
    return null;
  }
  return jail.voiceSoundUrl ?? null;
}

function waitForPlayback(player, ffmpeg) {
  return new Promise((resolve, reject) => {
    let started = false;
    let playerIdle = false;
    let exitCode = null;
    let settled = false;
    let stderr = '';

    const cleanup = () => {
      clearTimeout(timeout);
      player.off('stateChange', onStateChange);
      player.off('error', onPlayerError);
      ffmpeg.off('error', onProcessError);
      ffmpeg.off('close', onProcessClose);
      ffmpeg.stdin?.off('error', onInputError);
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const maybeFinish = () => {
      if (started && playerIdle && exitCode === 0) finish();
    };
    const onStateChange = (_oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Playing) started = true;
      if (started && newState.status === AudioPlayerStatus.Idle) playerIdle = true;
      maybeFinish();
    };
    const onPlayerError = error => finish(error);
    const onProcessError = error => finish(error);
    const onInputError = error => finish(new Error('Could not pass the sound file to FFmpeg: ' + error.message));
    const onProcessClose = (code, signal) => {
      exitCode = code;
      if (code !== 0) {
        const reason = stderr.trim() || (signal
          ? 'FFmpeg was terminated by signal ' + signal + '.'
          : 'FFmpeg exited with code ' + code + ' without reporting a decoding error.');
        finish(new Error(reason));
        return;
      }
      if (!started) {
        finish(new Error('The configured audio file did not produce playable sound.'));
        return;
      }
      maybeFinish();
    };

    const timeout = setTimeout(() => finish(new Error('Jail sound playback timed out.')), PLAYBACK_TIMEOUT_MS);
    timeout.unref?.();
    ffmpeg.stderr?.on('data', chunk => {
      stderr += chunk.toString();
      stderr = stderr.slice(-2000);
    });
    player.on('stateChange', onStateChange);
    player.once('error', onPlayerError);
    ffmpeg.once('error', onProcessError);
    ffmpeg.once('close', onProcessClose);
    ffmpeg.stdin?.once('error', onInputError);
  });
}

/**
 * Plays the configured jail sound in the target member's voice channel captured when /jail began.
 * The member is disconnected only after the complete sound is played successfully.
 * A bot already connected to voice is never moved or interrupted.
 */
export async function playJailVoiceSound(client, target, jail = {}, originalVoiceChannelId = null) {
  const hasConfiguredSound = Boolean(jail.voiceSoundUrl || (jail.voiceSoundChannelId && jail.voiceSoundMessageId));
  if (!jail.voiceSoundEnabled || !hasConfiguredSound) {
    return { status: 'skipped', reason: 'not_configured' };
  }

  const guild = target?.guild;
  const voiceChannelId = originalVoiceChannelId || target?.voice?.channelId;
  if (!guild || !voiceChannelId) {
    return { status: 'skipped', reason: 'not_in_voice' };
  }

  if (activeVoiceSoundGuilds.has(guild.id)) {
    return { status: 'skipped', reason: 'bot_busy' };
  }
  activeVoiceSoundGuilds.add(guild.id);

  let connection = null;
  let player = null;
  let ffmpeg = null;
  let voiceStateListener = null;
  let memberLeftVoice = false;
  let resolveMemberLeftVoice;
  const memberLeftVoicePromise = new Promise(resolve => {
    resolveMemberLeftVoice = resolve;
  });
  let playbackStage = 'checking bot voice permissions';

  try {
    const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    if (!botMember) return { status: 'skipped', reason: 'bot_member_unavailable' };

    // Keep the bot to one active voice connection globally; never interrupt music or audio in another server.
    if (activeVoiceSoundGuilds.size > 1 || getVoiceConnections().size > 0 || botMember.voice.channelId || getVoiceConnection(guild.id)) {
      return { status: 'skipped', reason: 'bot_busy' };
    }

    playbackStage = 'retrieving the saved sound attachment';
    const soundUrl = await resolveStoredSoundUrl(guild, jail);
    if (!isDiscordAttachmentUrl(soundUrl)) {
      return { status: 'failed', reason: 'sound_file_unavailable' };
    }

    playbackStage = 'checking the member voice channel';
    const voiceChannel = await guild.channels.fetch(voiceChannelId).catch(() => null);
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      return { status: 'skipped', reason: 'unsupported_voice_channel' };
    }

    const permissions = voiceChannel.permissionsFor(botMember);
    const requiredPermissions = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.Connect,
      PermissionFlagsBits.Speak,
      PermissionFlagsBits.MoveMembers,
    ];
    if (!permissions || requiredPermissions.some(permission => !permissions.has(permission))) {
      return { status: 'skipped', reason: 'missing_permissions' };
    }

    if (typeof ffmpegPath !== 'string' || !ffmpegPath) {
      return { status: 'failed', reason: 'ffmpeg_unavailable' };
    }

    playbackStage = 'downloading the saved sound attachment';
    const audioResponse = await fetch(soundUrl, { signal: AbortSignal.timeout(20_000) });
    if (!audioResponse.ok || !audioResponse.body) {
      throw new Error('Discord sound attachment download returned HTTP ' + audioResponse.status + '.');
    }
    const declaredLength = Number(audioResponse.headers.get('content-length') || 0);
    if (declaredLength > MAX_SOUND_BYTES) {
      throw new Error('The saved sound attachment exceeds the 15 MB limit.');
    }
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
    if (!audioBuffer.length) {
      throw new Error('Discord returned an empty sound attachment.');
    }
    if (audioBuffer.length > MAX_SOUND_BYTES) {
      throw new Error('The saved sound attachment exceeds the 15 MB limit.');
    }

    // Watch the member's original voice channel. Leaving or moving stops
    // playback and destroys the bot's voice connection immediately.
    voiceStateListener = (oldState, newState) => {
      const oldUserId = oldState.id ?? oldState.member?.id;
      if (oldUserId !== target.id || oldState.channelId !== voiceChannel.id || newState.channelId === voiceChannel.id) {
        return;
      }

      memberLeftVoice = true;
      resolveMemberLeftVoice();
      try { player?.stop(true); } catch {}
      try { if (ffmpeg && !ffmpeg.killed) ffmpeg.kill('SIGTERM'); } catch {}
      try { connection?.destroy(); } catch {}
    };
    client.on('voiceStateUpdate', voiceStateListener);

    const latestTarget = await guild.members.fetch(target.id).catch(() => target);
    if (!latestTarget.voice?.channelId || latestTarget.voice.channelId !== voiceChannel.id) {
      memberLeftVoice = true;
      resolveMemberLeftVoice();
      return { status: 'member_left', reason: 'member_left' };
    }

    playbackStage = 'joining the member voice channel';
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    playbackStage = 'waiting for Discord voice connection readiness';
    connection.on('error', voiceError => {
      const message = String(voiceError?.message ?? voiceError).replace(/https?:\/\/\S+/g, '[URL REDACTED]').slice(0, 1200);
      console.error('[jail-voice] Voice connection error: ' + message);
    });
    const connectionOutcome = await Promise.race([
      entersState(connection, VoiceConnectionStatus.Ready, 15_000)
        .then(() => 'ready')
        .catch(error => {
          if (memberLeftVoice) return 'member_left';
          throw error;
        }),
      memberLeftVoicePromise.then(() => 'member_left'),
    ]);
    if (connectionOutcome === 'member_left' || memberLeftVoice) {
      return { status: 'member_left', reason: 'member_left' };
    }

    player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
    });
    connection.subscribe(player);

    playbackStage = 'starting FFmpeg to decode the sound file';
    ffmpeg = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-re',
      '-i', 'pipe:0',
      '-t', String(MAX_SOUND_SECONDS),
      '-vn',
      '-ac', '2',
      '-ar', '48000',
      '-c:a', 'libopus',
      '-b:a', '96k',
      '-f', 'ogg',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    playbackStage = 'streaming the decoded sound into Discord voice';
    const playbackFinished = waitForPlayback(player, ffmpeg);
    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.OggOpus,
    });
    player.play(resource);
    ffmpeg.stdin.end(audioBuffer);

    const playbackOutcome = await Promise.race([
      playbackFinished.then(
        () => ({ status: 'finished' }),
        error => ({ status: 'error', error })
      ),
      memberLeftVoicePromise.then(() => ({ status: 'member_left' })),
    ]);
    if (playbackOutcome.status === 'member_left' || memberLeftVoice) {
      return { status: 'member_left', reason: 'member_left' };
    }
    if (playbackOutcome.status === 'error') {
      throw playbackOutcome.error;
    }

    const freshTarget = await guild.members.fetch(target.id).catch(() => target);
    if (memberLeftVoice || freshTarget.voice?.channelId !== voiceChannel.id) {
      return { status: 'member_left', reason: 'member_left' };
    }

    // The command applies jail roles and posts evidence after playback.
    // It disconnects the member after the jail roles have been assigned.
    return { status: 'played' };
  } catch (error) {
        logger.warn('Jail sound played, but the jailed member could not be disconnected from voice.', {
          guildId: guild.id,
          userId: target.id,
          error: error.message,
        });
        return { status: 'played_not_disconnected', reason: 'disconnect_failed' };
      }
    }

    return { status: 'played', disconnected: true };
  } catch (error) {
    if (memberLeftVoice) return { status: 'member_left', reason: 'member_left' };
    const rawError = error?.stack || error?.message || String(error);
    const safeError = String(rawError)
      .replace(/https?:\/\/\S+/g, '[URL REDACTED]')
      .slice(0, 1800);
    console.error('[jail-voice] Playback failed during "' + playbackStage + '": ' + safeError);
    logger.warn('Jail voice sound could not be played during "' + playbackStage + '": ' + safeError, {
      guildId: guild.id,
      userId: target?.id,
      error: error?.message ?? String(error),
      playbackStage,
    });
    return { status: 'failed', reason: 'playback_failed', playbackStage };
  } finally {
    if (voiceStateListener) client.off('voiceStateUpdate', voiceStateListener);
    try { player?.stop(true); } catch {}
    try { if (ffmpeg && !ffmpeg.killed) ffmpeg.kill('SIGKILL'); } catch {}
    try { connection?.destroy(); } catch {}
    activeVoiceSoundGuilds.delete(guild.id);
  }
}
