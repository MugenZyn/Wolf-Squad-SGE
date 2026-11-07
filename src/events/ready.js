import { Events } from 'discord.js';
import { startupLog, logger } from '../utils/logger.js';
import config from '../config/application.js';
import { initializeJailReleases } from '../services/jailReleaseService.js';
import { reconcilePausedJailCases } from '../services/jailMembershipService.js';
import { startTwitchStreamPolling } from '../services/twitch/twitchStreamService.js';

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    try {
      client.user.setPresence(config.bot.presence);
      const restoredCases = await reconcilePausedJailCases(client);
      if (restoredCases) startupLog(`Restored ${restoredCases} paused jail case(s) for members who rejoined while the bot was offline`);
      await initializeJailReleases(client);
      startTwitchStreamPolling(client);
      startupLog(`Ready as ${client.user.tag}`);
      startupLog(`Serving ${client.guilds.cache.size} server(s)`);
      startupLog(`Registered jail commands loaded: ${client.commands.size}`);
    } catch (error) {
      logger.error('Jail bot ready event failed:', error);
    }
  },
};
