import {
  ActionRowBuilder, EmbedBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits,
  SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { updateGuildConfig } from '../../services/config/guildConfig.js';

const SETTINGS = [
  { label: 'Default sentence', value: 'default_seconds', description: 'Seconds, or INFINITE' },
  { label: 'Minimum sentence', value: 'minimum_seconds', description: 'Minimum jail duration in seconds' },
  { label: 'Evidence messages', value: 'evidence_count', description: 'Number of messages to forward (1–5)' },
  { label: 'Default evidence note', value: 'default_message', description: 'Text shown in evidence; CLEAR removes it' },
];

function formatDuration(value) {
  return value == null ? 'Infinite' : `${Number(value).toLocaleString()} seconds`;
}

function panelPayload(jail) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('Jail configuration')
    .setDescription('Select a setting below to view or change it.')
    .addFields(
      { name: 'Default sentence', value: formatDuration(jail.defaultSentenceSeconds), inline: true },
      { name: 'Minimum sentence', value: formatDuration(jail.minimumSentenceSeconds ?? 600), inline: true },
      { name: 'Evidence messages', value: String(jail.evidenceMessageCount ?? 1), inline: true },
      { name: 'Default evidence note', value: jail.defaultMessage ? jail.defaultMessage.slice(0, 1000) : 'None', inline: false },
    );
  const menus = SETTINGS.map(setting => new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`jconfig:${setting.value}`)
      .setPlaceholder(`Change ${setting.label}`)
      .addOptions([{ label: setting.label, value: setting.value, description: setting.description }]),
  ));
  return { embeds: [embed], components: menus, flags: MessageFlags.Ephemeral };
}

export default {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('View and change jail configuration.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction, guildConfig) {
    if (!interaction.inGuild() || !interaction.guild) {
      return interaction.reply({ content: 'Use this command in a server.', flags: MessageFlags.Ephemeral });
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
    }
    return interaction.reply(panelPayload(guildConfig?.jail ?? {}));
  },

  async handleComponent(interaction, client) {
    if (interaction.customId.startsWith('jconfig:') && interaction.isStringSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
        return true;
      }
      const field = interaction.values[0];
      const setting = SETTINGS.find(s => s.value === field);
      if (!setting) return false;
      const modal = new ModalBuilder()
        .setCustomId(`jconfigmodal:${field}`)
        .setTitle(`Change ${setting.label}`);
      const input = new TextInputBuilder()
        .setCustomId('setting_value')
        .setLabel(field === 'default_seconds' ? 'Seconds, or INFINITE' : field === 'default_message' ? 'Message text (or CLEAR)' : 'Value')
        .setStyle(field === 'default_message' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(field !== 'default_message')
        .setMaxLength(field === 'default_message' ? 1000 : 20);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('jconfigmodal:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
        return true;
      }
      const field = interaction.customId.slice('jconfigmodal:'.length);
      const raw = interaction.fields.getTextInputValue('setting_value').trim();
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current.jail ?? {}) };
      if (field === 'default_seconds') {
        if (/^infinite$/i.test(raw)) jail.defaultSentenceSeconds = null;
        else if (/^\\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 2147483647) jail.defaultSentenceSeconds = Number(raw);
        else return interaction.reply({ content: 'Enter a positive number of seconds or INFINITE.', flags: MessageFlags.Ephemeral });
        if (jail.defaultSentenceSeconds !== null && jail.defaultSentenceSeconds < Number(jail.minimumSentenceSeconds ?? 600)) {
          return interaction.reply({ content: `Default sentence cannot be below the minimum of ${jail.minimumSentenceSeconds ?? 600} seconds.`, flags: MessageFlags.Ephemeral });
        }
      } else if (field === 'minimum_seconds') {
        if (!/^\\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 2147483647) return interaction.reply({ content: 'Enter a positive number of seconds.', flags: MessageFlags.Ephemeral });
        const next = Number(raw);
        if (jail.defaultSentenceSeconds != null && jail.defaultSentenceSeconds < next) return interaction.reply({ content: 'Minimum cannot exceed the configured finite default sentence.', flags: MessageFlags.Ephemeral });
        jail.minimumSentenceSeconds = next;
      } else if (field === 'evidence_count') {
        if (!/^[1-5]$/.test(raw)) return interaction.reply({ content: 'Evidence message count must be between 1 and 5.', flags: MessageFlags.Ephemeral });
        jail.evidenceMessageCount = Number(raw);
      } else if (field === 'default_message') {
        jail.defaultMessage = raw.toUpperCase() === 'CLEAR' ? '' : raw;
      } else {
        return interaction.reply({ content: 'Unknown setting.', flags: MessageFlags.Ephemeral });
      }
      if (field === 'default_seconds') jail.defaultDuration = undefined;
      await updateGuildConfig(client, interaction.guildId, { jail });
      return interaction.reply({ content: `Saved **${SETTINGS.find(s => s.value === field).label}**.`, flags: MessageFlags.Ephemeral });
    }
    return false;
  },
};
