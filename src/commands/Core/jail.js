import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits,
  SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { memberHasModerationCommandAccess } from '../../utils/permissionGuard.js';
import { updateGuildConfig } from '../../services/config/guildConfig.js';
import { scheduleJailRelease } from '../../services/jailReleaseService.js';

function formatSentence(seconds) {
  if (seconds === null || seconds === undefined) return 'Infinite';
  let remaining = Math.max(0, Math.floor(seconds));
  const units = [
    ['year', 31536000], ['month', 2592000], ['day', 86400],
    ['hour', 3600], ['minute', 60], ['second', 1],
  ];
  const parts = [];
  for (const [name, size] of units) {
    const amount = Math.floor(remaining / size);
    if (amount > 0) {
      parts.push(`${amount} ${name}${amount === 1 ? '' : 's'}`);
      remaining %= size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(', ') || '0 seconds';
}

function legacySentenceSeconds(value) {
  const legacy = { '1h': 3600, '6h': 21600, '12h': 43200, '1d': 86400, '3d': 259200, '7d': 604800 };
  return Object.prototype.hasOwnProperty.call(legacy, value) ? legacy[value] : null;
}

function renderAnnouncement(template, values) {
  return String(template ?? '').replace(/\{\{(user|server|moderator|role|reason|duration)\}\}/gi, (_, key) => values[key.toLowerCase()] ?? '');
}

const JAIL_ROLE_PAGE_SIZE = 25;

function getFilteredJailRoles(roles, searchQuery = '') {
  const query = String(searchQuery ?? '').trim().toLowerCase();
  return roles.filter(role => !query || role.name.toLowerCase().includes(query));
}

function buildJailRoleMenu(token, roles, page, searchQuery = '') {
  const filtered = getFilteredJailRoles(roles, searchQuery);
  const pageCount = Math.max(1, Math.ceil(filtered.length / JAIL_ROLE_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, Number(page) || 0), pageCount - 1);
  const options = filtered.slice(safePage * JAIL_ROLE_PAGE_SIZE, (safePage + 1) * JAIL_ROLE_PAGE_SIZE)
    .map(role => ({ label: clip(role.name, 100), value: role.id, description: `Jail role: ${clip(role.name, 80)}` }));
  if (!options.length) options.push({ label: 'No matching jail roles found', value: '__no_roles__', description: 'Change or clear the search', disabled: true });
  return {
    menu: new StringSelectMenuBuilder().setCustomId(`choose_jail_role:${token}:${safePage}`)
      .setPlaceholder(`Choose a jail role (page ${safePage + 1}/${pageCount})`)
      .setMinValues(0).setMaxValues(1).addOptions(options),
    page: safePage, pageCount, filtered,
  };
}

function buildJailRolePager(token, page, pageCount, searchQuery = '') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`jail_role_nav:${token}:prev`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`jail_role_nav:${token}:search`).setLabel('Search roles').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`jail_role_nav:${token}:clear_search`).setLabel('Clear search').setStyle(ButtonStyle.Secondary).setDisabled(!searchQuery),
    new ButtonBuilder().setCustomId(`jail_role_nav:${token}:next`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount - 1),
  );
}

function clip(value, max = 1000) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

async function findExistingEvidenceThread(forum, userId, jail) {
  const knownIds = [
    ...(jail.activeCases ?? []).filter(item => item.userId === userId).map(item => item.evidenceThreadId),
    ...(jail.history ?? []).filter(item => item.userId === userId).map(item => item.evidenceThreadId),
  ].filter(Boolean);

  for (const id of [...new Set(knownIds)].reverse()) {
    const thread = await forum.guild.channels.fetch(id).catch(() => null);
    if (thread?.parentId === forum.id && thread.isThread?.()) return thread;
  }

  const checked = new Set();
  const findInThreads = async threads => {
    for (const thread of threads.values()) {
      if (checked.has(thread.id)) continue;
      checked.add(thread.id);
      const starter = await thread.fetchStarterMessage().catch(() => null);
      const memberField = starter?.embeds?.[0]?.fields?.find(field => /jailed member/i.test(field.name));
      if (memberField?.value?.includes(userId)) return thread;
    }
    return null;
  };

  const active = await forum.threads.fetchActive().catch(() => null);
  if (active?.threads) {
    const match = await findInThreads(active.threads);
    if (match) return match;
  }

  let before;
  while (true) {
    const archived = await forum.threads.fetchArchived({ type: 'public', limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!archived?.threads?.size) break;
    const match = await findInThreads(archived.threads);
    if (match) return match;
    const oldestThread = archived.threads.last();
    if (!archived.hasMore || !oldestThread || oldestThread.id === before) break;
    before = oldestThread.id;
  }
  return null;
}

export default {
  data: new SlashCommandBuilder()
    .setName('jail')
    .setDescription('Assign a registered jail role and forward evidence from this channel.')
    .addUserOption(o => o.setName('user').setDescription('Member to jail.').setRequired(true))
    .addIntegerOption(o => o.setName('duration').setDescription('Sentence length in seconds. Leave blank to use the configured default (infinite by default).').setMinValue(1).setMaxValue(2147483647))
    .addStringOption(o => o.setName('message').setDescription('Optional extra text for the evidence post.').setMaxLength(1000))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the jail sentence.').setRequired(false).setMaxLength(1000)),

  async execute(interaction, guildConfig) {
    if (!interaction.inGuild() || !interaction.guild) return interaction.reply({ content: 'Use this command in a server.', flags: MessageFlags.Ephemeral });
    if (!memberHasModerationCommandAccess(interaction.member, guildConfig, PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ content: 'You need Administrator, Manage Messages, or the configured moderator role to jail members.', flags: MessageFlags.Ephemeral });
    }

    const jail = guildConfig?.jail ?? {};
    const configuredRoles = Array.isArray(jail.roles) ? jail.roles : [];
    const roles = [];
    const configuredRoleIds = [...new Set(configuredRoles.map(item => item?.roleId).filter(Boolean))];
    const fetchedRoles = await Promise.all(configuredRoleIds.map(id => interaction.guild.roles.fetch(id).catch(() => null)));
    for (const role of fetchedRoles) {
      if (role && role.id !== interaction.guild.id) roles.push(role);
    }
    roles.sort((a, b) => a.name.localeCompare(b.name));
    if (!roles.length) return interaction.reply({ content: 'No jail roles are registered. Run /setup-jail first.', flags: MessageFlags.Ephemeral });
    const forum = jail.evidenceForumId ? await interaction.guild.channels.fetch(jail.evidenceForumId).catch(() => null) : null;
    if (!forum || forum.type !== 15) return interaction.reply({ content: 'The configured jail evidence forum is missing or is not a forum. Run /setup-jail again with a valid forum.', flags: MessageFlags.Ephemeral });

    const targetUser = interaction.options.getUser('user', true);
    let target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!target) return interaction.reply({ content: 'That member is not in this server.', flags: MessageFlags.Ephemeral });
    if (target.id === interaction.user.id || target.id === interaction.client.user.id || target.id === interaction.guild.ownerId) {
      return interaction.reply({ content: 'You cannot jail yourself, the bot, or the server owner.', flags: MessageFlags.Ephemeral });
    }
    if (interaction.member.id !== interaction.guild.ownerId && target.roles.highest.comparePositionTo(interaction.member.roles.highest) >= 0) {
      return interaction.reply({ content: 'Your highest role must be above the member you are jailing.', flags: MessageFlags.Ephemeral });
    }

    const assignableRoles = roles.filter(role => !target.roles.cache.has(role.id));
    if (!assignableRoles.length) {
      return interaction.reply({
        content: 'That member already has every registered jail role. No role was added.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const pickerToken = interaction.id;
    let selectedRoleId;
    let currentRolePage = 0;
    let roleSearchQuery = '';
    const firstPicker = buildJailRoleMenu(pickerToken, assignableRoles, currentRolePage, roleSearchQuery);
    const jailRolePickerPayload = picker => ({
      content: `Choose the jail role for **${clip(target.user.tag, 80)}**. ${roleSearchQuery ? `Search: ${roleSearchQuery}. ` : ''}Page ${picker.page + 1} of ${picker.pageCount}.`,
      components: [new ActionRowBuilder().addComponents(picker.menu), buildJailRolePager(pickerToken, picker.page, picker.pageCount, roleSearchQuery)],
    });
    await interaction.reply({ ...jailRolePickerPayload(firstPicker), flags: MessageFlags.Ephemeral });

    try {
      const promptMessage = await interaction.fetchReply();
      while (!selectedRoleId) {
        const selection = await promptMessage.awaitMessageComponent({
          time: 60000,
          filter: i => i.user.id === interaction.user.id && (
            i.customId.startsWith(`choose_jail_role:${pickerToken}:`) || i.customId.startsWith(`jail_role_nav:${pickerToken}:`)
          ),
        });
        if (selection.isButton()) {
          const control = selection.customId.split(':').at(-1);
          if (control === 'search') {
            const modal = new ModalBuilder().setCustomId(`jailrolemodal:${pickerToken}`).setTitle('Search jail roles');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('role_query').setLabel('Role name contains').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100).setPlaceholder('Leave empty to show all roles')));
            await selection.showModal(modal);
            const modalSubmit = await selection.awaitModalSubmit({
              time: 60000,
              filter: submit => submit.user.id === interaction.user.id && submit.customId === `jailrolemodal:${pickerToken}`,
            });
            roleSearchQuery = modalSubmit.fields.getTextInputValue('role_query').trim();
            currentRolePage = 0;
            const searchedPicker = buildJailRoleMenu(pickerToken, assignableRoles, currentRolePage, roleSearchQuery);
            await modalSubmit.update(jailRolePickerPayload(searchedPicker));
            continue;
          }
          if (control === 'clear_search') roleSearchQuery = '';
          else if (control === 'prev') currentRolePage = Math.max(0, currentRolePage - 1);
          else if (control === 'next') currentRolePage++;
          const nextPicker = buildJailRoleMenu(pickerToken, assignableRoles, currentRolePage, roleSearchQuery);
          currentRolePage = nextPicker.page;
          await selection.update(jailRolePickerPayload(nextPicker));
          continue;
        }
        selectedRoleId = selection.values[0];
        await selection.deferUpdate();
      }
    } catch {
      return interaction.editReply({ content: 'Jail role selection timed out. Run /jail again.', components: [] });
    }

    const selectedRole = assignableRoles.find(role => role.id === selectedRoleId);
    if (!selectedRole) return interaction.editReply({ content: 'That jail role is no longer available. Run /jail again.', components: [] });

    // Refresh the member in case another moderator assigned this role while the menu was open.
    target = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!target) return interaction.editReply({ content: 'That member is no longer in this server.', components: [] });
    if (target.roles.cache.has(selectedRole.id)) {
      return interaction.editReply({
        content: 'That member already has this jail role. No changes were made.',
        components: [],
      });
    }
    const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
    if (botMember.roles.highest.comparePositionTo(selectedRole) <= 0) return interaction.editReply({ content: 'My highest role must be above the selected jail role.', components: [] });

    await target.roles.add(selectedRole, `Jailed by ${interaction.user.tag} (${interaction.user.id})`);
    const evidenceLimit = Math.min(10, Math.max(1, Number(jail.evidenceMessageCount ?? 5)));
    const fetched = await interaction.channel.messages.fetch({ limit: 100 }).catch(() => null);
    const evidence = fetched
      ? [...fetched.values()].filter(message => message.author.id === target.id && !message.system).sort((a, b) => a.createdTimestamp - b.createdTimestamp).slice(-evidenceLimit)
      : [];
    const addon = interaction.options.getString('message')?.trim() || jail.defaultMessage?.trim() || '';
    const jailReason = interaction.options.getString('reason')?.trim() || 'None';
    const requestedSeconds = interaction.options.getInteger('duration');
    const configuredDefault = jail.defaultSentenceSeconds ?? legacySentenceSeconds(jail.defaultDuration);
    const sentenceSeconds = requestedSeconds ?? configuredDefault;
    const minimumSeconds = Math.max(1, Number(jail.minimumSentenceSeconds ?? 600));
    if (requestedSeconds !== null && requestedSeconds < minimumSeconds) {
      await target.roles.remove(selectedRole).catch(() => null);
      return interaction.editReply({
        content: `The minimum sentence is **${formatSentence(minimumSeconds)}** (${minimumSeconds} seconds). Your selected sentence was ${formatSentence(requestedSeconds)}.`,
        components: [],
      });
    }
    if (sentenceSeconds !== null && (!Number.isSafeInteger(sentenceSeconds) || sentenceSeconds < minimumSeconds)) {
      await target.roles.remove(selectedRole).catch(() => null);
      return interaction.editReply({
        content: `The configured default sentence is below the minimum of ${minimumSeconds} seconds. An administrator must update /config.`,
        components: [],
      });
    }
    const durationLabel = formatSentence(sentenceSeconds);
    const releaseAt = sentenceSeconds === null ? null : Date.now() + sentenceSeconds * 1000;

    await interaction.editReply({ content: `Jail role selected: <@&${selectedRole.id}>.`, components: [] });
    const response = await interaction.followUp({
      content: `<@!${target.id}> has been assigned <@&${selectedRole.id}>. Sentence: **${durationLabel}**.`,
      fetchReply: true,
      allowedMentions: { parse: [] },
    });
    const jumpUrl = evidence.length ? evidence[evidence.length - 1].url : response.url;
    const embed = new EmbedBuilder()
      .setTitle('Jail Evidence')
      .setColor(0x8B0000)
      .addFields(
        { name: 'Jailed member', value: `<@!${target.id}> (${target.id})`, inline: true },
        { name: 'Jailed by', value: `<@!${interaction.user.id}>`, inline: true },
        { name: 'Jail role', value: `<@&${selectedRole.id}>`, inline: true },
        { name: 'Sentence', value: sentenceSeconds === null ? 'Infinite' : `${durationLabel} (${sentenceSeconds.toLocaleString()} seconds)`, inline: true },
        { name: 'Original channel', value: `<#${interaction.channelId}> (${interaction.channelId})`, inline: true },
        { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
      )
      .setDescription(`**Reason:** ${clip(jailReason, 1800)}\n\n${addon ? `**Additional note:**\n${clip(addon, 1500)}` : 'No additional note was provided.'}`);
    if (evidence.length) {
      embed.addFields({
        name: `Forwarded messages (${evidence.length}/${evidenceLimit})`,
        value: 'Original messages are forwarded individually below.',
      });
      for (const message of evidence) {
        const attachmentLinks = [...message.attachments.values()].map(file => file.url);
        const copiedContent = [
          message.content?.trim(),
          ...attachmentLinks.map((url, index) => `Attachment ${index + 1}: ${url}`),
        ].filter(Boolean).join('\n');
        embed.addFields({
          name: `Copy · ${new Date(message.createdTimestamp).toISOString()} · ${clip(message.author.tag, 80)}`.slice(0, 256),
          value: clip(copiedContent || '[No text content; see forwarded message or attachment links]', 1000),
        });
      }
    } else {
      embed.addFields({ name: 'Recent messages', value: 'No recent messages from this member were found in the channel where /jail was run.' });
    }
    const jumpButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Jump to Context')
        .setStyle(ButtonStyle.Link)
        .setURL(jumpUrl)
    );

    let evidenceResult = 'Evidence post created.';
    let evidenceThreadId = null;
    try {
      let evidenceThread = await findExistingEvidenceThread(forum, target.id, jail);
      if (evidenceThread) {
        if (evidenceThread.archived) await evidenceThread.setArchived(false, 'Reuse existing member jail evidence thread');
        await evidenceThread.send({ embeds: [embed], components: [jumpButton], allowedMentions: { parse: [] } });
        evidenceResult = 'Added evidence to the existing member evidence channel.';
      } else {
        evidenceThread = await forum.threads.create({
          name: `Jail — ${target.user.username}`.slice(0, 100),
          message: { embeds: [embed], components: [jumpButton], allowedMentions: { parse: [] } },
          reason: `Jail evidence for ${target.id}`,
        });
      }
      evidenceThreadId = evidenceThread.id;

      let forwardedCount = 0;
      const forwardErrors = [];
      for (const message of evidence) {
        try {
          await message.forward(evidenceThread);
          forwardedCount++;
        } catch (error) {
          forwardErrors.push(`${message.id}: ${clip(error.message, 160)}`);
        }
      }
      if (forwardErrors.length) {
        evidenceResult = `Evidence post created. Forwarded ${forwardedCount}/${evidence.length} messages; ${forwardErrors.length} could not be forwarded.`;
      } else if (evidence.length) {
        evidenceResult = `Evidence post created. All ${forwardedCount} messages were forwarded.`;
      }
    } catch (error) {
      evidenceResult = `WARNING: member was jailed, but evidence forum post failed: ${clip(error.message, 300)}`;
    }

    const activeCases = Array.isArray(jail.activeCases)
      ? jail.activeCases.filter(c => c.userId !== target.id || c.roleId !== selectedRole.id)
      : [];
    activeCases.push({ userId: target.id, roleId: selectedRole.id, releaseAt, sentenceSeconds, evidenceThreadId });
    const history = Array.isArray(jail.history) ? jail.history : [];
    history.push({
      userId: target.id,
      username: target.user.tag,
      moderatorId: interaction.user.id,
      moderatorTag: interaction.user.tag,
      reason: jailReason,
      jailedAt: Date.now(),
      sentenceSeconds,
      releaseAt,
      roleId: selectedRole.id,
      evidenceThreadId,
    });
    await updateGuildConfig(interaction.client, interaction.guild.id, { jail: { ...jail, activeCases, history } });
    if (releaseAt) scheduleJailRelease(interaction.client, interaction.guild.id, { userId: target.id, roleId: selectedRole.id, releaseAt });
    const jailAnnouncement = renderAnnouncement(jail.jailAnnouncement || '{{user}} HAS BEEN JAILED', {
      user: `<@${target.id}>`, server: interaction.guild.name, moderator: `<@${interaction.user.id}>`,
      role: `<@&${selectedRole.id}>`, reason: jailReason, duration: durationLabel,
    });
    // Post the jail announcement in the channel where /jail was invoked,
    // rather than the jail role's private destination channel.
    const announcementChannelIds = [...new Set([interaction.channelId, jail.actionLogChannelId].filter(Boolean))];
    for (const channelId of announcementChannelIds) {
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased?.() && channel.send) await channel.send({ content: jailAnnouncement, preserveCase: true, allowedMentions: { parse: ['users', 'roles'] } }).catch(() => null);
    }
    await interaction.followUp({ content: evidenceResult, flags: MessageFlags.Ephemeral });
  },
};
