import { Events } from 'discord.js';
import { startupLog, logger } from '../utils/logger.js';
import config from '../config/application.js';
import { initializeJailReleases } from '../services/jailReleaseService.js';

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    try {
      client.user.setPresence(config.bot.presence);
      await initializeJailReleases(client);
      startupLog(`Ready as ${client.user.tag}`);
      startupLog(`Serving ${client.guilds.cache.size} server(s)`);
      startupLog(`Registered jail commands loaded: ${client.commands.size}`);
    } catch (error) {
      logger.error('Jail bot ready event failed:', error);
    }
  },
};
