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
  if (!jail.voiceSoundEnabled || !jail.voiceSoundUrl) {
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

  try {
    const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    if (!botMember) return { status: 'skipped', reason: 'bot_member_unavailable' };

    // This also catches music players or other voice systems using the bot account.
    if (botMember.voice.channelId || getVoiceConnection(guild.id)) {
      return { status: 'skipped', reason: 'bot_busy' };
    }

    const voiceChannel = target.voice.channel
      ?? await guild.channels.fetch(voiceChannelId).catch(() => null);
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

    if (!isDiscordAttachmentUrl(jail.voiceSoundUrl)) {
      return { status: 'failed', reason: 'invalid_sound_url' };
    }
    if (typeof ffmpegPath !== 'string' || !ffmpegPath) {
      return { status: 'failed', reason: 'ffmpeg_unavailable' };
    }

    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

    player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
    });
    connection.subscribe(player);

    ffmpeg = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-re',
      '-i', jail.voiceSoundUrl,
      '-t', String(MAX_SOUND_SECONDS),
      '-vn',
      '-ac', '2',
      '-ar', '48000',
      '-c:a', 'libopus',
      '-b:a', '96k',
      '-f', 'ogg',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const playbackFinished = waitForPlayback(player, ffmpeg);
    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.OggOpus,
    });
    player.play(resource);
    await playbackFinished;

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
    logger.warn('Jail voice sound could not be played.', {
      guildId: guild.id,
      userId: target?.id,
      error: error?.message ?? String(error),
    });
    return { status: 'failed', reason: 'playback_failed' };
  } finally {
    try { player?.stop(true); } catch {}
    try { if (ffmpeg && !ffmpeg.killed) ffmpeg.kill('SIGKILL'); } catch {}
    try { connection?.destroy(); } catch {}
    activeVoiceSoundGuilds.delete(guild.id);
  }
}
