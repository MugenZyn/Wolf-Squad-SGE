import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { updateGuildConfig } from '../../services/config/guildConfig.js';

export default {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure jail defaults.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('default-sentence').setDescription('Set the default jail sentence in seconds; leave blank for infinite.')
      .addIntegerOption(o => o.setName('seconds').setDescription('Default sentence length in seconds. Omit for infinite.').setMinValue(1).setMaxValue(2147483647)))
    .addSubcommand(s => s.setName('minimum-sentence').setDescription('Set the minimum allowed jail sentence in seconds.')
      .addIntegerOption(o => o.setName('seconds').setDescription('Minimum sentence length in seconds.').setRequired(true).setMinValue(1).setMaxValue(2147483647)))
    .addSubcommand(s => s.setName('evidence-count').setDescription('Set how many recent messages are forwarded (1–5).')
      .addIntegerOption(o => o.setName('count').setDescription('Number of target messages from the channel where /jail is run.').setRequired(true).setMinValue(1).setMaxValue(5)))
    .addSubcommand(s => s.setName('default-message').setDescription('Set the default note included in evidence posts.')
      .addStringOption(o => o.setName('message').setDescription('Leave blank to clear the default note.').setRequired(false).setMaxLength(1000))),

  async execute(interaction, guildConfig) {
    if (!interaction.inGuild() || !interaction.guild) return interaction.reply({ content: 'Use this command in a server.', flags: MessageFlags.Ephemeral });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
    const jail = guildConfig?.jail ?? {};
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'default-sentence') {
      const seconds = interaction.options.getInteger('seconds');
      const minimum = Math.max(1, Number(jail.minimumSentenceSeconds ?? 600));
      if (seconds !== null && seconds < minimum) {
        return interaction.reply({ content: `The default sentence cannot be below the configured minimum of ${minimum.toLocaleString()} seconds.`, flags: MessageFlags.Ephemeral });
      }
      await updateGuildConfig(interaction.client, interaction.guild.id, { jail: { ...jail, defaultSentenceSeconds: seconds, defaultDuration: undefined } });
      return interaction.reply({ content: seconds === null ? 'Default jail sentence set to **Infinite**.' : `Default jail sentence set to **${seconds.toLocaleString()} seconds**.`, flags: MessageFlags.Ephemeral });
    }
    if (subcommand === 'minimum-sentence') {
      const seconds = interaction.options.getInteger('seconds', true);
      const defaultSeconds = jail.defaultSentenceSeconds;
      if (defaultSeconds !== null && defaultSeconds !== undefined && defaultSeconds < seconds) {
        return interaction.reply({ content: `The configured default sentence is ${defaultSeconds} seconds. Set the default to infinite or at least ${seconds} seconds first.`, flags: MessageFlags.Ephemeral });
      }
      await updateGuildConfig(interaction.client, interaction.guild.id, { jail: { ...jail, minimumSentenceSeconds: seconds } });
      return interaction.reply({ content: `Minimum jail sentence set to **${seconds.toLocaleString()} seconds**.`, flags: MessageFlags.Ephemeral });
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
