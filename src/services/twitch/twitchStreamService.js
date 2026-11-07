import { getGuildConfig, updateGuildConfig } from '../config/guildConfig.js';
import { logger, startupLog } from '../../utils/logger.js';

const TWITCH_API = 'https://api.twitch.tv/helix';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const POLL_INTERVAL_MS = 60_000;
const MAX_TRACKED_STREAMERS = 100;

let accessToken = null;
let accessTokenExpiresAt = 0;
let pollTimer = null;
let pollInProgress = false;
let missingCredentialsWarned = false;

function getCredentials() {
  const clientId = process.env.TWITCH_CLIENT_ID?.trim();
  const clientSecret = process.env.TWITCH_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function getAppAccessToken() {
  const credentials = getCredentials();
  if (!credentials) {
    if (!missingCredentialsWarned) {
      logger.warn('Twitch stream tracking is waiting for TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET environment variables.');
      missingCredentialsWarned = true;
    }
    throw new Error('Twitch API credentials are not configured. Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to the bot environment.');
  }

  if (accessToken && Date.now() < accessTokenExpiresAt - 60_000) return accessToken;

  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    grant_type: 'client_credentials',
  });
  const response = await fetch(TWITCH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.message || `Twitch token request failed with HTTP ${response.status}.`);
  }

  accessToken = data.access_token;
  accessTokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  missingCredentialsWarned = false;
  return accessToken;
}

async function twitchGet(path) {
  const credentials = getCredentials();
  const token = await getAppAccessToken();
  const response = await fetch(`${TWITCH_API}${path}`, {
    headers: {
      'Client-Id': credentials.clientId,
      Authorization: `Bearer ${token}`,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      accessToken = null;
      accessTokenExpiresAt = 0;
    }
    throw new Error(data.message || `Twitch API request failed with HTTP ${response.status}.`);
  }
  return data;
}

export async function lookupTwitchUser(login) {
  const normalizedLogin = String(login ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(normalizedLogin)) {
    throw new Error('Enter a valid Twitch username (letters, numbers, and underscores only).');
  }
  const data = await twitchGet(`/users?login=${encodeURIComponent(normalizedLogin)}`);
  const user = data.data?.[0];
  if (!user) throw new Error(`I could not find a Twitch account named ${normalizedLogin}.`);
  return {
    userId: user.id,
    login: user.login,
    displayName: user.display_name,
  };
}

function renderLiveMessage(template, streamer, stream) {
  const values = {
    streameruser: streamer.displayName || streamer.login,
    streamer: streamer.displayName || streamer.login,
    streamlink: `https://www.twitch.tv/${streamer.login}`,
    streamtitle: stream.title || 'Live on Twitch',
    game: stream.game_name || 'Unknown category',
    viewers: String(stream.viewer_count ?? 0),
    started: stream.started_at ? `<t:${Math.floor(new Date(stream.started_at).getTime() / 1000)}:R>` : '',
  };
  return String(template).replace(/\{\{(streameruser|streamer|streamlink|streamtitle|game|viewers|started)\}\}/gi,
    (_, key) => values[key.toLowerCase()] ?? '');
}

function chooseRandomMessage(messages) {
  const valid = (Array.isArray(messages) ? messages : [])
    .map(message => String(message ?? '').trim())
    .filter(Boolean)
    .slice(0, 10);
  const choices = valid.length ? valid : ['{{streameruser}} IS NOW LIVE {{streamlink}}'];
  return choices[Math.floor(Math.random() * choices.length)];
}

async function pollGuild(client, guild) {
  const config = await getGuildConfig(client, guild.id);
  const twitch = config?.twitch ?? {};
  const streamers = Array.isArray(twitch.streamers) ? twitch.streamers : [];
  if (!streamers.length) return;

  const ids = [...new Set(streamers.map(item => item?.userId).filter(Boolean))];
  if (!ids.length) return;

  const query = new URLSearchParams();
  for (const userId of ids.slice(0, MAX_TRACKED_STREAMERS)) query.append('user_id', userId);
  query.set('first', String(MAX_TRACKED_STREAMERS));
  const streamsData = await twitchGet(`/streams?${query.toString()}`);
  const liveByUserId = new Map((streamsData.data ?? []).map(stream => [stream.user_id, stream]));

  let channel = null;
  if (twitch.announcementChannelId) {
    channel = await guild.channels.fetch(twitch.announcementChannelId).catch(() => null);
  }
  const usableChannel = channel?.isTextBased?.() && typeof channel.send === 'function' ? channel : null;

  const nextStreamers = streamers.map(item => ({ ...item }));
  let changed = false;

  for (const streamer of nextStreamers) {
    const live = liveByUserId.get(streamer.userId);
    if (!live) {
      if (streamer.isLive !== false) {
        streamer.isLive = false;
        changed = true;
      }
      continue;
    }

    if (streamer.isLive !== true) {
      streamer.isLive = true;
      changed = true;
    }
    streamer.currentTitle = live.title || '';
    streamer.currentGame = live.game_name || '';
    streamer.viewerCount = Number(live.viewer_count || 0);

    if (streamer.lastStreamId === live.id || !usableChannel) continue;

    const message = renderLiveMessage(chooseRandomMessage(twitch.liveMessages), streamer, live);
    try {
      await usableChannel.send({
        content: message.slice(0, 2000),
        allowedMentions: { parse: [] },
        preserveCase: true,
      });
      streamer.lastStreamId = live.id;
      streamer.lastAnnouncedAt = Date.now();
      changed = true;
    } catch (error) {
      logger.warn(`Could not post Twitch live announcement in guild ${guild.id} for ${streamer.login}:`, error);
    }
  }

  if (!changed) return;

  // Merge status fields into the latest list so concurrent add/remove operations
  // from /stream are not lost while a Twitch poll is running.
  const latest = await getGuildConfig(client, guild.id);
  const latestTwitch = latest?.twitch ?? {};
  const statusByUserId = new Map(nextStreamers.map(item => [item.userId, item]));
  const mergedStreamers = (latestTwitch.streamers ?? []).map(current => {
    const status = statusByUserId.get(current.userId);
    return status ? {
      ...current,
      isLive: status.isLive,
      currentTitle: status.currentTitle ?? '',
      currentGame: status.currentGame ?? '',
      viewerCount: status.viewerCount ?? 0,
      lastStreamId: status.lastStreamId ?? current.lastStreamId ?? null,
      lastAnnouncedAt: status.lastAnnouncedAt ?? current.lastAnnouncedAt ?? null,
    } : current;
  });
  await updateGuildConfig(client, guild.id, {
    twitch: { ...latestTwitch, streamers: mergedStreamers },
  });
}

export async function pollTwitchStreams(client) {
  if (pollInProgress) return;
  pollInProgress = true;
  try {
    for (const guild of client.guilds.cache.values()) {
      try {
        await pollGuild(client, guild);
      } catch (error) {
        logger.warn(`Twitch stream check failed for guild ${guild.id}:`, error);
      }
    }
  } finally {
    pollInProgress = false;
  }
}

export function startTwitchStreamPolling(client) {
  if (pollTimer) return;
  if (!getCredentials()) {
    logger.warn('Twitch stream tracking is disabled until TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are configured.');
    return;
  }
  startupLog(`Twitch live-stream tracking enabled (checks every ${Math.round(POLL_INTERVAL_MS / 1000)} seconds)`);
  void pollTwitchStreams(client);
  pollTimer = setInterval(() => {
    void pollTwitchStreams(client);
  }, POLL_INTERVAL_MS);
  pollTimer.unref?.();
}

export const TWITCH_MAX_STREAMERS_PER_GUILD = MAX_TRACKED_STREAMERS;
