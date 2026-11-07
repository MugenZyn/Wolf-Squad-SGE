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
    const onProcessClose = code => {
      exitCode = code;
      if (code !== 0) {
        finish(new Error(stderr.trim() || 'FFmpeg could not decode the configured jail sound.'));
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
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

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
      '-i', soundUrl,
      '-t', String(MAX_SOUND_SECONDS),
      '-vn',
      '-ac', '2',
      '-ar', '48000',
      '-c:a', 'libopus',
      '-b:a', '96k',
      '-f', 'ogg',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    playbackStage = 'streaming the decoded sound into Discord voice';
    const playbackFinished = waitForPlayback(player, ffmpeg);
    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.OggOpus,
    });
    player.play(resource);
    await playbackFinished;

    playbackStage = 'disconnecting the member after successful playback';
    const freshTarget = await guild.members.fetch(target.id).catch(() => target);
    if (freshTarget.voice.channelId) {
      try {
        await freshTarget.voice.disconnect('Jailed; the configured jail sound finished playing.');
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
    try { player?.stop(true); } catch {}
    try { if (ffmpeg && !ffmpeg.killed) ffmpeg.kill('SIGKILL'); } catch {}
    try { connection?.destroy(); } catch {}
    activeVoiceSoundGuilds.delete(guild.id);
  }
}
