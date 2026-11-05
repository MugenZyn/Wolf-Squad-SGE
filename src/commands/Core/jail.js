import {
  ActionRowBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits,
  SlashCommandBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { memberHasModerationCommandAccess } from '../../utils/permissionGuard.js';
import { updateGuildConfig } from '../../services/config/guildConfig.js';
import { scheduleJailRelease } from '../../services/jailReleaseService.js';

const DURATION_MS = { infinite: null, '1h': 3600000, '6h': 21600000, '12h': 43200000, '1d': 86400000, '3d': 259200000, '7d': 604800000 };

function clip(value, max = 1000) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

export default {
  data: new SlashCommandBuilder()
    .setName('jail')
    .setDescription('Assign a registered jail role and forward evidence from this channel.')
    .addUserOption(o => o.setName('user').setDescription('Member to jail.').setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Optional extra text for the evidence post.').setMaxLength(1000)),

  async execute(interaction, guildConfig) {
    if (!interaction.inGuild() || !interaction.guild) return interaction.reply({ content: 'Use this command in a server.', flags: MessageFlags.Ephemeral });
    if (!memberHasModerationCommandAccess(interaction.member, guildConfig, PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ content: 'You need Administrator, Manage Messages, or the configured moderator role to jail members.', flags: MessageFlags.Ephemeral });
    }

    const jail = guildConfig?.jail ?? {};
    const configuredRoles = Array.isArray(jail.roles) ? jail.roles : [];
    const roles = [];
    for (const item of configuredRoles.slice(0, 25)) {
      const role = await interaction.guild.roles.fetch(item.roleId).catch(() => null);
      if (role && role.id !== interaction.guild.id) roles.push(role);
    }
    if (!roles.length) return interaction.reply({ content: 'No jail roles are registered. Run /setup-jail first.', flags: MessageFlags.Ephemeral });
    const forum = jail.evidenceForumId ? await interaction.guild.channels.fetch(jail.evidenceForumId).catch(() => null) : null;
    if (!forum || forum.type !== 15) return interaction.reply({ content: 'The configured jail evidence forum is missing or is not a forum. Run /setup-jail again with a valid forum.', flags: MessageFlags.Ephemeral });

    const targetUser = interaction.options.getUser('user', true);
    const target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!target) return interaction.reply({ content: 'That member is not in this server.', flags: MessageFlags.Ephemeral });
    if (target.id === interaction.user.id || target.id === interaction.client.user.id || target.id === interaction.guild.ownerId) {
      return interaction.reply({ content: 'You cannot jail yourself, the bot, or the server owner.', flags: MessageFlags.Ephemeral });
    }
    if (interaction.member.id !== interaction.guild.ownerId && target.roles.highest.comparePositionTo(interaction.member.roles.highest) >= 0) {
      return interaction.reply({ content: 'Your highest role must be above the member you are jailing.', flags: MessageFlags.Ephemeral });
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId('choose_jail_role')
      .setPlaceholder('Choose a registered jail role')
      .addOptions(roles.map(role => ({ label: clip(role.name, 100), value: role.id, description: `Jail role: ${clip(role.name, 80)}` })));
    await interaction.reply({
      content: `Choose the jail role for **${clip(target.user.tag, 80)}**:`,
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral,
    });

    let selectedRoleId;
    try {
      const promptMessage = await interaction.fetchReply();
      const selection = await promptMessage.awaitMessageComponent({
        time: 60000,
        filter: i => i.user.id === interaction.user.id && i.customId === 'choose_jail_role',
      });
      selectedRoleId = selection.values[0];
      await selection.deferUpdate();
    } catch {
      return interaction.editReply({ content: 'Jail role selection timed out. Run /jail again.', components: [] });
    }

    const selectedRole = roles.find(role => role.id === selectedRoleId);
    if (!selectedRole) return interaction.editReply({ content: 'That jail role is no longer registered. Run /jail again.', components: [] });
    const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
    if (botMember.roles.highest.comparePositionTo(selectedRole) <= 0) return interaction.editReply({ content: 'My highest role must be above the selected jail role.', components: [] });

    await target.roles.add(selectedRole, `Jailed by ${interaction.user.tag} (${interaction.user.id})`);
    const evidenceLimit = Math.min(5, Math.max(1, Number(jail.evidenceMessageCount ?? 5)));
    const fetched = await interaction.channel.messages.fetch({ limit: 100 }).catch(() => null);
    const evidence = fetched
      ? [...fetched.values()].filter(message => message.author.id === target.id && !message.system).sort((a, b) => a.createdTimestamp - b.createdTimestamp).slice(-evidenceLimit)
      : [];
    const addon = interaction.options.getString('message')?.trim() || jail.defaultMessage?.trim() || '';
    const duration = jail.defaultDuration ?? 'infinite';
    const durationMs = Object.prototype.hasOwnProperty.call(DURATION_MS, duration) ? DURATION_MS[duration] : null;
    const releaseAt = durationMs ? Date.now() + durationMs : null;

    const response = await interaction.editReply({
      content: `<@!${target.id}> has been assigned <@&${selectedRole.id}>. Duration: **${duration}**.`,
      components: [],
      fetchReply: true,
    });
    const jumpUrl = response.url;
    const embed = new EmbedBuilder()
      .setTitle('Jail Evidence')
      .setColor(0x8B0000)
      .addFields(
        { name: 'Jailed member', value: `<@!${target.id}> (${target.id})`, inline: true },
        { name: 'Jailed by', value: `<@!${interaction.user.id}>`, inline: true },
        { name: 'Jail role', value: `<@&${selectedRole.id}>`, inline: true },
        { name: 'Duration', value: duration, inline: true },
        { name: 'Original channel', value: `<#${interaction.channelId}> (${interaction.channelId})`, inline: true },
        { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
      )
      .setURL(jumpUrl)
      .setDescription(addon ? `**Additional note:**\n${clip(addon, 3500)}` : 'No additional note was provided.');
    if (evidence.length) {
      const body = evidence.map(m => `**<t:${Math.floor(m.createdTimestamp / 1000)}:f>** — ${clip(m.content || '[No text content]', 700)}${m.attachments.size ? `\nAttachments: ${[...m.attachments.values()].map(a => a.url).join(' ')}` : ''}`).join('\n\n');
      embed.addFields({ name: `Recent messages from the jailed member (${evidence.length}/${evidenceLimit})`, value: clip(body, 1024) });
    } else {
      embed.addFields({ name: 'Recent messages', value: 'No recent messages from this member were found in the channel where /jail was run.' });
    }
    embed.addFields({ name: 'Jump to context', value: `[Open the jail action in <#${interaction.channelId}>](${jumpUrl})` });

    let evidenceResult = 'Evidence post created.';
    try {
      await forum.threads.create({
        name: `Jail — ${target.user.username}`.slice(0, 100),
        message: { embeds: [embed], allowedMentions: { parse: [] } },
        reason: `Jail evidence for ${target.id}`,
      });
    } catch (error) {
      evidenceResult = `WARNING: member was jailed, but evidence forum post failed: ${clip(error.message, 300)}`;
    }

    const activeCases = Array.isArray(jail.activeCases) ? jail.activeCases.filter(c => c.userId !== target.id) : [];
    activeCases.push({ userId: target.id, roleId: selectedRole.id, releaseAt });
    await updateGuildConfig(interaction.client, interaction.guild.id, { jail: { ...jail, activeCases } });
    if (releaseAt) scheduleJailRelease(interaction.client, interaction.guild.id, { userId: target.id, roleId: selectedRole.id, releaseAt });
    await interaction.followUp({ content: evidenceResult, flags: MessageFlags.Ephemeral });
  },
};
