import { Events, MessageFlags } from 'discord.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) {
      return interaction.reply({
        content: 'That command is no longer available. Please refresh Discord and try again.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }

    try {
      const guildConfig = interaction.guild
        ? await getGuildConfig(client, interaction.guild.id)
        : null;
      await command.execute(interaction, guildConfig, client);
    } catch (error) {
      logger.error(`Command /${interaction.commandName} failed:`, error);
      const payload = {
        content: 'The command failed. Check the bot logs for details.',
        flags: MessageFlags.Ephemeral,
      };
      try {
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch (replyError) {
        logger.warn('Could not send command error response:', replyError.message);
      }
    }
  },
};
