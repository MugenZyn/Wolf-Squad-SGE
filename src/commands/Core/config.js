import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { updateGuildConfig } from '../../services/config/guildConfig.js';

export default {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Update jail settings. Provide one or more settings.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(o => o.setName('default_seconds').setDescription('Default sentence in seconds.').setMinValue(1).setMaxValue(2147483647))
    .addBooleanOption(o => o.setName('default_infinite').setDescription('Set the default sentence to infinite.'))
    .addIntegerOption(o => o.setName('minimum_seconds').setDescription('Minimum sentence in seconds.').setMinValue(1).setMaxValue(2147483647))
    .addIntegerOption(o => o.setName('evidence_count').setDescription('Recent messages to forward (1–5).').setMinValue(1).setMaxValue(5))
    .addStringOption(o => o.setName('default_message').setDescription('Default note for jail evidence. Use CLEAR to remove it.').setMaxLength(1000)),

  async execute(interaction, guildConfig) {
    if (!interaction.inGuild() || !interaction.guild) {
      return interaction.reply({ content: 'Use this command in a server.', flags: MessageFlags.Ephemeral });
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
    }

    const jail = guildConfig?.jail ?? {};
    const defaultSeconds = interaction.options.getInteger('default_seconds');
    const setInfinite = interaction.options.getBoolean('default_infinite');
    const minimumSeconds = interaction.options.getInteger('minimum_seconds');
    const evidenceCount = interaction.options.getInteger('evidence_count');
    const defaultMessage = interaction.options.getString('default_message');
    const hasChange = defaultSeconds !== null || setInfinite === true || minimumSeconds !== null ||
      evidenceCount !== null || defaultMessage !== null;

    if (!hasChange) {
      return interaction.reply({
        content: 'Provide at least one setting: default_seconds, default_infinite, minimum_seconds, evidence_count, or default_message.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (defaultSeconds !== null && setInfinite === true) {
      return interaction.reply({ content: 'Choose either default_seconds or default_infinite, not both.', flags: MessageFlags.Ephemeral });
    }

    const currentMinimum = Math.max(1, Number(jail.minimumSentenceSeconds ?? 600));
    const nextMinimum = minimumSeconds ?? currentMinimum;
    const nextDefault = setInfinite === true ? null : defaultSeconds !== null ? defaultSeconds :
      (jail.defaultSentenceSeconds ?? null);

    if (nextDefault !== null && nextDefault < nextMinimum) {
      return interaction.reply({
        content: `The default sentence cannot be below the minimum of ${nextMinimum.toLocaleString()} seconds.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const updates = { ...jail };
    if (defaultSeconds !== null || setInfinite === true) {
      updates.defaultSentenceSeconds = nextDefault;
      updates.defaultDuration = undefined;
    }
    if (minimumSeconds !== null) updates.minimumSentenceSeconds = minimumSeconds;
    if (evidenceCount !== null) updates.evidenceMessageCount = evidenceCount;
    if (defaultMessage !== null) updates.defaultMessage = defaultMessage.trim().toUpperCase() === 'CLEAR' ? '' : defaultMessage.trim();

    await updateGuildConfig(interaction.client, interaction.guild.id, { jail: updates });

    const changed = [];
    if (defaultSeconds !== null || setInfinite === true) {
      changed.push(`Default sentence: **${nextDefault === null ? 'Infinite' : `${nextDefault.toLocaleString()} seconds`}**`);
    }
    if (minimumSeconds !== null) changed.push(`Minimum sentence: **${minimumSeconds.toLocaleString()} seconds**`);
    if (evidenceCount !== null) changed.push(`Evidence messages: **${evidenceCount}**`);
    if (defaultMessage !== null) changed.push(`Default evidence note: **${updates.defaultMessage ? 'Updated' : 'Cleared'}**`);

    return interaction.reply({ content: changed.join('\n'), flags: MessageFlags.Ephemeral });
  },
};
