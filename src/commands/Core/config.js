import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { updateGuildConfig } from '../../services/config/guildConfig.js';

export default {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure jail defaults.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('jail-duration').setDescription('Set the default jail duration.')
      .addStringOption(o => o.setName('duration').setDescription('Default duration used by /jail.').setRequired(true)
        .addChoices(
          { name: 'Infinite (default)', value: 'infinite' },
          { name: '1 hour', value: '1h' }, { name: '6 hours', value: '6h' },
          { name: '12 hours', value: '12h' }, { name: '1 day', value: '1d' },
          { name: '3 days', value: '3d' }, { name: '7 days', value: '7d' },
        )))
    .addSubcommand(s => s.setName('evidence-count').setDescription('Set how many recent messages are forwarded (1–5).')
      .addIntegerOption(o => o.setName('count').setDescription('Number of target messages from the channel where /jail is run.').setRequired(true).setMinValue(1).setMaxValue(5)))
    .addSubcommand(s => s.setName('default-message').setDescription('Set the default note included in evidence posts.')
      .addStringOption(o => o.setName('message').setDescription('Leave blank to clear the default note.').setRequired(false).setMaxLength(1000))),

  async execute(interaction, guildConfig) {
    if (!interaction.inGuild() || !interaction.guild) return interaction.reply({ content: 'Use this command in a server.', flags: MessageFlags.Ephemeral });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
    const jail = guildConfig?.jail ?? {};
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'jail-duration') {
      const duration = interaction.options.getString('duration', true);
      await updateGuildConfig(interaction.client, interaction.guild.id, { jail: { ...jail, defaultDuration: duration } });
      return interaction.reply({ content: `Default jail duration set to **${duration}**.`, flags: MessageFlags.Ephemeral });
    }
    if (subcommand === 'evidence-count') {
      const count = interaction.options.getInteger('count', true);
      await updateGuildConfig(interaction.client, interaction.guild.id, { jail: { ...jail, evidenceMessageCount: count } });
      return interaction.reply({ content: `Evidence forwarding set to **${count}** recent message(s), maximum 5.`, flags: MessageFlags.Ephemeral });
    }
    const message = interaction.options.getString('message')?.trim() ?? '';
    await updateGuildConfig(interaction.client, interaction.guild.id, { jail: { ...jail, defaultMessage: message } });
    return interaction.reply({ content: message ? 'Default jail evidence note updated.' : 'Default jail evidence note cleared.', flags: MessageFlags.Ephemeral });
  },
};
