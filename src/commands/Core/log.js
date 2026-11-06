import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

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
    const policemanRoleIds = Array.isArray(guildConfig?.jail?.policemanRoleIds)
      ? guildConfig.jail.policemanRoleIds
      : [];
    const isPoliceman = policemanRoleIds.some(roleId => interaction.member?.roles?.cache?.has(roleId));

    if (!isPoliceman) {
      return interaction.reply({ content: 'You need a configured policeman role to view jail history.', flags: MessageFlags.Ephemeral });
    }

    const user = interaction.options.getUser('user', true);
    const history = (Array.isArray(guildConfig?.jail?.history) ? guildConfig.jail.history : [])
      .filter(entry => entry.userId === user.id)
      .sort((a, b) => Number(b.jailedAt || 0) - Number(a.jailedAt || 0));

    if (!history.length) {
      return interaction.reply({ content: `No recorded jail history found for <@${user.id}>.`, flags: MessageFlags.Ephemeral });
    }

    const pageSize = 10;
    const pageCount = Math.max(1, Math.ceil(history.length / pageSize));
    const token = interaction.id;
    const buildPayload = page => {
      const safePage = Math.min(Math.max(0, page), pageCount - 1);
      const start = safePage * pageSize;
      const entries = history.slice(start, start + pageSize);
      const fields = entries.map((entry, index) => ({
        name: `#${history.length - (start + index)} • ${new Date(entry.jailedAt || 0).toLocaleString()}`,
        value: [
          `**Reason:** ${String(entry.reason || 'No reason recorded').slice(0, 700)}`,
          `**Moderator:** ${entry.moderatorId ? `<@${entry.moderatorId}>` : 'Unknown'}`,
          `**Sentence:** ${formatSentence(entry.sentenceSeconds)}`,
          `**Jail role:** <@&${entry.roleId}>`,
        ].join('\n'),
      }));
      const components = pageCount > 1 ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`jlog:${token}:previous`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
        new ButtonBuilder().setCustomId(`jlog:${token}:next`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(safePage >= pageCount - 1),
      )] : [];
      return {
        embeds: [{
          color: 0x8B0000,
          title: `Jail history — ${user.tag}`,
          description: `**Member:** <@${user.id}> (${user.id})\nShowing records ${start + 1}–${Math.min(start + entries.length, history.length)} of ${history.length}.`,
          fields,
          footer: { text: `Page ${safePage + 1} of ${pageCount} · ${history.length} total records` },
        }],
        components,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      };
    };

    let page = 0;
    await interaction.reply(buildPayload(page));
    if (pageCount > 1) {
      const message = await interaction.fetchReply();
      while (true) {
        try {
          const selection = await message.awaitMessageComponent({
            time: 15 * 60 * 1000,
            filter: component => component.user.id === interaction.user.id && component.customId.startsWith(`jlog:${token}:`),
          });
          page = selection.customId.endsWith(':previous') ? Math.max(0, page - 1) : Math.min(pageCount - 1, page + 1);
          await selection.update(buildPayload(page));
        } catch {
          await interaction.editReply({ components: [] }).catch(() => null);
          break;
        }
      }
    }
  },
};
