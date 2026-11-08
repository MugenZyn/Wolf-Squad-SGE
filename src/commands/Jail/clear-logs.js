import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from '../../services/config/guildConfig.js';

export default {
  data: new SlashCommandBuilder()
    .setName('clear-logs')
    .setDescription('Clear a member’s saved jail history.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(option => option
      .setName('user')
      .setDescription('Member whose jail history should be cleared.')
      .setRequired(true)),

  async execute(interaction, guildConfig) {
    if (!interaction.inGuild() || !interaction.guild) {
      return interaction.reply({ content: 'Use this command in a server.', flags: MessageFlags.Ephemeral });
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'Only administrators can clear jail history.', flags: MessageFlags.Ephemeral });
    }

    const target = interaction.options.getUser('user', true);
    const current = await getGuildConfig(interaction.client, interaction.guild.id);
    const jail = current?.jail ?? {};
    const history = Array.isArray(jail.history) ? jail.history : [];
    const remainingHistory = history.filter(entry => entry?.userId !== target.id);
    const removedCount = history.length - remainingHistory.length;

    if (!removedCount) {
      return interaction.reply({
        content: `There is no saved jail history for <@!${target.id}>.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }

    await updateGuildConfig(interaction.client, interaction.guild.id, {
      jail: { ...jail, history: remainingHistory },
    });

    const logsChannel = jail.logsChannelId
      ? await interaction.guild.channels.fetch(jail.logsChannelId).catch(() => null)
      : null;
    if (logsChannel?.isTextBased?.() && logsChannel.send) {
      await logsChannel.send({
        embeds: [{
          color: 0xD4AC0D,
          title: 'Jail history cleared',
          description: `**Member:** <@${target.id}> (${target.id})\n**Cleared by:** <@${interaction.user.id}> (${interaction.user.id})\n**Records removed:** ${removedCount}\n\nEvidence forum threads and any active jail cases were left unchanged.`,
          timestamp: new Date().toISOString(),
        }],
        allowedMentions: { parse: [] },
      }).catch(() => null);
    }

    return interaction.reply({
      content: `Cleared ${removedCount} jail history record(s) for <@!${target.id}>. Evidence threads and active jail cases were left unchanged.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};
