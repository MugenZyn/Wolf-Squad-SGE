import 'dotenv/config';
import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { REST } from '@discordjs/rest';
import express from 'express';

import config from './config/application.js';
import { initializeDatabase } from './utils/database.js';
import { logger, startupLog, shutdownLog } from './utils/logger.js';
import { loadCommands, registerCommands as registerSlashCommands } from './handlers/loaders/commandLoader.js';
import pkg from '../package.json' with { type: 'json' };
import { EXPECTED_SCHEMA_VERSION, EXPECTED_SCHEMA_LABEL } from './config/database/schemaVersion.js';

class TitanBot extends Client {
  constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.config = config;
    this.commands = new Collection();
    this.events = new Collection();
    this.buttons = new Collection();
    this.selectMenus = new Collection();
    this.modals = new Collection();
    this.cooldowns = new Collection();
    this.db = null;
    this.rest = new REST({ version: '10' }).setToken(config.bot.token);
  }

  async start() {
    try {
      startupLog('Starting Wolf Squad jail bot...');
      startupLog('Initializing database...');
      const dbInstance = await initializeDatabase();
      this.db = dbInstance.db;
      const dbStatus = this.db.getStatus();

      if (dbStatus.isDegraded) {
        logger.warn('PostgreSQL unavailable; using temporary in-memory storage. Changes will not survive a restart.');
      } else {
        startupLog(`Database connected: ${dbStatus.connectionType}`);
      }

      this.startWebServer();
      startupLog('Loading jail commands...');
      await loadCommands(this);
      startupLog(`Loaded ${this.commands.size} jail commands`);

      await this.loadHandlers();
      startupLog('Logging into Discord...');
      await this.login(this.config.bot.token);
      startupLog('Discord login successful');

      await this.registerCommands();
      startupLog(`ONLINE | ${this.commands.size} commands | Jail system ready`);
    } catch (error) {
      logger.error('Failed to start bot:', error);
      process.exit(1);
    }
  }

  startWebServer() {
    const app = express();
    const port = Number(this.config.api?.port || process.env.PORT || 3000);
    const host = process.env.WEB_HOST || '0.0.0.0';

    app.get('/health', (req, res) => {
      const status = this.db?.getStatus?.() || { connectionType: 'none', isDegraded: true };
      res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: { connected: status.connectionType !== 'none', degraded: status.isDegraded, type: status.connectionType },
      });
    });

    app.get('/ready', (req, res) => {
      const status = this.db?.getStatus?.() || { connectionType: 'none', isDegraded: true };
      const ready = this.isReady() && !status.isDegraded;
      const metrics = {
        guildCount: this.guilds.cache.size,
        commandCount: this.commands.size,
        database: { mode: status.connectionType, degraded: status.isDegraded },
        schemaVersion: EXPECTED_SCHEMA_VERSION,
        schemaLabel: EXPECTED_SCHEMA_LABEL,
      };
      res.status(ready ? 200 : 503).json({ ready, metrics });
    });

    app.get('/', (req, res) => res.status(200).json({
      message: 'Wolf Squad Jail Bot Online',
      version: pkg.version,
      timestamp: new Date().toISOString(),
    }));

    this.webServer = app.listen(port, host, () => {
      startupLog(`Web server listening on ${host}:${port}`);
    });
    this.webServer.on('error', error => {
      logger.error('Web server error:', error);
      if (error.code === 'EADDRINUSE') logger.error(`Port ${port} is already in use.`);
    });
  }

  async loadHandlers() {
    for (const name of ['events', 'interactions']) {
      const module = await import(`./handlers/loaders/${name}.js`);
      await module.default(this);
      startupLog(`Loaded ${name}`);
    }
  }

  async registerCommands() {
    await registerSlashCommands(this, { clientId: this.config.bot.clientId });
  }

  async shutdown(reason = 'UNKNOWN') {
    shutdownLog(`Bot is shutting down (${reason})...`);
    try {
      if (this.webServer) await new Promise(resolve => this.webServer.close(resolve));
      if (this.db?.db?.pool) await this.db.db.pool.end();
      this.destroy();
      shutdownLog('Bot stopped successfully.');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown:', error);
      process.exit(1);
    }
  }
}

const bot = new TitanBot();
process.on('SIGTERM', () => bot.shutdown('SIGTERM'));
process.on('SIGINT', () => bot.shutdown('SIGINT'));
process.on('uncaughtException', error => {
  logger.error('Uncaught exception:', error);
  bot.shutdown('UNCAUGHT_EXCEPTION');
});
process.on('unhandledRejection', reason => {
  logger.error('Unhandled rejection:', reason);
});
bot.start();

export default TitanBot;
