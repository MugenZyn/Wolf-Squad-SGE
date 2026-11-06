import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { memberHasModerationCommandAccess } from '../../utils/permissionGuard.js';

function formatSentence(seconds) {
  if (seconds === null || seconds === undefined) return 'Infinite';
  let remaining = Math.max(0, Math.floor(seconds));
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  const parts = [];
  for (const [name, size] of units) {
    const amount = Math.floor(remaining / size);
    if (amount) {
      parts.push(`${amount} ${name}${amount === 1 ? '' : 's'}`);
      remaining %= size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(', ') || '0 seconds';
}

export default {
  data: new SlashCommandBuilder()
    .setName('log')
    .setDescription('View a member’s jail history and reasons.')
    .addUserOption(o => o.setName('user').setDescription('Member whose jail history you want to view.').setRequired(true)),

  async execute(interaction, guildConfig) {
    if (!interaction.inGuild() || !interaction.guild) {
      return interaction.reply({ content: 'Use this command in a server.', flags: MessageFlags.Ephemeral });
    }
    if (!memberHasModerationCommandAccess(interaction.member, guildConfig, PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ content: 'You need Administrator, Manage Messages, or the configured moderator role to view jail history.', flags: MessageFlags.Ephemeral });
    }

    const user = interaction.options.getUser('user', true);
    const history = (Array.isArray(guildConfig?.jail?.history) ? guildConfig.jail.history : [])
      .filter(entry => entry.userId === user.id)
      .sort((a, b) => Number(b.jailedAt || 0) - Number(a.jailedAt || 0));

    if (!history.length) {
      return interaction.reply({ content: `No recorded jail history found for <@${user.id}>.`, flags: MessageFlags.Ephemeral });
    }

    const fields = history.slice(0, 10).map((entry, index) => ({
      name: `#${history.length - index} • ${new Date(entry.jailedAt || 0).toLocaleString()}`,
      value: [
        `**Reason:** ${String(entry.reason || 'No reason recorded').slice(0, 700)}`,
        `**Moderator:** ${entry.moderatorId ? `<@${entry.moderatorId}>` : 'Unknown'}`,
        `**Sentence:** ${formatSentence(entry.sentenceSeconds)}`,
        `**Jail role:** <@&${entry.roleId}>`,
      ].join('\n'),
    }));

    return interaction.reply({
      embeds: [{
        color: 0x8B0000,
        title: `Jail history — ${user.tag}`,
        description: `**Member:** <@${user.id}> (${user.id})\nShowing ${Math.min(10, history.length)} of ${history.length} recorded jail entries.`,
        fields,
        footer: { text: 'Only the 10 most recent entries are shown.' },
      }],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};
