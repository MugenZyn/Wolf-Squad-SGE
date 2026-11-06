import { Events, MessageFlags } from 'discord.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    if (interaction.isButton() || interaction.isRoleSelectMenu() || interaction.isChannelSelectMenu() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
      if (interaction.customId?.startsWith('jsetup:')) {
        const setupCommand = client.commands.get('setup-jail');
        if (setupCommand?.handleComponent) return setupCommand.handleComponent(interaction, client);
      }
      if (interaction.customId?.startsWith('jconfig:') || interaction.customId?.startsWith('jconfigmodal:')) {
        const configCommand = client.commands.get('config');
        if (configCommand?.handleComponent) return configCommand.handleComponent(interaction, client);
      }
      return;
    }
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

      if (interaction.guild && guildConfig?.jail?.logsChannelId) {
        const logChannel = await interaction.guild.channels.fetch(guildConfig.jail.logsChannelId).catch(() => null);
        if (logChannel?.isTextBased() && logChannel.guildId === interaction.guild.id) {
          const options = interaction.options?.data?.map(option => {
            const value = option.type === 1 || option.type === 2
              ? option.options?.map(child => `${child.name}=${String(child.value ?? child.user?.id ?? child.role?.id ?? child.channel?.id ?? '').slice(0, 150)}`).join(', ')
              : `${option.name}=${String(option.value ?? option.user?.id ?? option.role?.id ?? option.channel?.id ?? '').slice(0, 150)}`;
            return value;
          }).filter(Boolean).join(' | ') || 'No options';
          await logChannel.send({
            embeds: [{
              color: 0x2B8A3E,
              title: `Command executed: /${interaction.commandName}`,
              description: `**Staff:** <@${interaction.user.id}> (${interaction.user.id})\n**Channel:** <#${interaction.channelId}>\n**Details:** ${options.slice(0, 2500)}`,
              timestamp: new Date().toISOString(),
            }],
            allowedMentions: { parse: [] },
          }).catch(logError => logger.warn('Could not write command log:', logError.message));
        }
      }
    } catch (error) {
      logger.error(`Command /${interaction.commandName} failed:`, error);
      if (interaction.guild) {
        try {
          const failedConfig = await getGuildConfig(client, interaction.guild.id);
          const logChannel = failedConfig?.jail?.logsChannelId
            ? await interaction.guild.channels.fetch(failedConfig.jail.logsChannelId).catch(() => null)
            : null;
          if (logChannel?.isTextBased()) {
            await logChannel.send({
              embeds: [{
                color: 0xC0392B,
                title: `Command failed: /${interaction.commandName}`,
                description: `**Staff:** <@${interaction.user.id}> (${interaction.user.id})\n**Channel:** <#${interaction.channelId}>\n**Error:** ${String(error?.message ?? error).slice(0, 2500)}`,
                timestamp: new Date().toISOString(),
              }],
              allowedMentions: { parse: [] },
            });
          }
        } catch (logError) {
          logger.warn('Could not write failed command log:', logError.message);
        }
      }
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
