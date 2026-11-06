import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits,
  SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { updateGuildConfig } from '../../services/config/guildConfig.js';

const SETTINGS = [
  { label: 'Default sentence', value: 'default_seconds', description: 'Seconds, or INFINITE' },
  { label: 'Minimum sentence', value: 'minimum_seconds', description: 'Minimum jail duration in seconds' },
  { label: 'Evidence messages', value: 'evidence_count', description: 'Number of messages to forward (1–10)' },
  { label: 'Default evidence note', value: 'default_message', description: 'Text shown in evidence; CLEAR removes it' },
  { label: 'Jail announcement', value: 'jail_announcement', description: 'Use {{user}}, {{server}}, {{moderator}}, {{role}}, {{reason}}, {{duration}}' },
  { label: 'Unjail announcement', value: 'unjail_announcement', description: 'Use {{user}}, {{server}}, {{moderator}}, {{roles}}' },
];

const pendingRoleRemovals = new Map();
const pendingRoleSelections = new Map();
const pendingChannelRolePickers = new Map();

const CONFIG_ROLE_PAGE_SIZE = 25;
const CONFIG_CHANNEL_ROLE_PAGE_SIZE = 25;

function formatRoleMentions(ids, maxLength = 900) {
  const mentions = [];
  let used = 0;
  for (const id of ids ?? []) {
    const mention = `<@&${id}>`;
    const addition = mentions.length ? `, ${mention}` : mention;
    if (used + addition.length > maxLength) break;
    mentions.push(mention);
    used += addition.length;
  }
  const remaining = Math.max(0, (ids?.length ?? 0) - mentions.length);
  return `${mentions.join(', ')}${remaining ? ` …and ${remaining} more` : ''}` || 'None';
}

function getFilteredRoleChoices(state) {
  const query = String(state?.searchQuery ?? '').trim().toLowerCase();
  return (state?.roles ?? []).filter(role => !query || role.name.toLowerCase().includes(query));
}

function buildPaginatedRoleMenu(customId, placeholder, state) {
  const roles = getFilteredRoleChoices(state);
  const pageCount = Math.max(1, Math.ceil(roles.length / CONFIG_ROLE_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, Number(state?.page) || 0), pageCount - 1);
  const selected = new Set(state?.selectedIds ?? []);
  const options = roles.slice(safePage * CONFIG_ROLE_PAGE_SIZE, (safePage + 1) * CONFIG_ROLE_PAGE_SIZE).map(role => ({
    label: role.name.slice(0, 100), value: role.id,
    description: state?.descriptionForRole?.(role) ?? 'Server role',
    default: selected.has(role.id),
  }));
  if (!options.length) options.push({ label: 'No matching roles found', value: '__no_roles__', description: 'Change or clear the search', disabled: true });
  return {
    menu: new StringSelectMenuBuilder().setCustomId(customId)
      .setPlaceholder(`${placeholder} (page ${safePage + 1}/${pageCount})`)
      .setMinValues(0).setMaxValues(state?.mode === 'single' ? 1 : Math.min(25, Math.max(1, options.length)))
      .addOptions(options),
    page: safePage, pageCount, roles,
  };
}

function updatePagedRoleSelection(state, page, values) {
  const roles = getFilteredRoleChoices(state);
  const currentPageIds = new Set(roles.slice(page * CONFIG_ROLE_PAGE_SIZE, (page + 1) * CONFIG_ROLE_PAGE_SIZE).map(role => role.id));
  const selectedValues = values.filter(value => currentPageIds.has(value));
  if (state.mode === 'single') {
    if (selectedValues.length) state.selectedIds = [selectedValues[0]];
  } else {
    state.selectedIds = [...new Set([
      ...(state.selectedIds ?? []).filter(id => !currentPageIds.has(id)),
      ...selectedValues,
    ])];
  }
  return state;
}

function buildRolePagerControls(prefix, state, options = {}) {
  const roles = getFilteredRoleChoices(state);
  const pageCount = Math.max(1, Math.ceil(roles.length / (options.pageSize ?? CONFIG_ROLE_PAGE_SIZE)));
  const page = Math.min(Math.max(0, state.page ?? 0), pageCount - 1);
  const controls = [
    new ButtonBuilder().setCustomId(`${prefix}:prev`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`${prefix}:search`).setLabel('Search roles').setStyle(ButtonStyle.Primary),
    ...(options.clearSelection ? [new ButtonBuilder().setCustomId(`${prefix}:clear`).setLabel('Clear selection').setStyle(ButtonStyle.Secondary)] : []),
    new ButtonBuilder().setCustomId(`${prefix}:clear_search`).setLabel('Clear search').setStyle(ButtonStyle.Secondary).setDisabled(!state.searchQuery),
    new ButtonBuilder().setCustomId(`${prefix}:next`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount - 1),
  ];
  return new ActionRowBuilder().addComponents(controls);
}
function formatDuration(value) {
  return value == null ? 'Infinite' : `${Number(value).toLocaleString()} seconds`;
}

function panelPayload(jail, page = 'settings') {
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('Jail configuration');
  const nav = new ActionRowBuilder().addComponents(
    ...[
      ['settings', 'Settings'],
      ['roles', 'Roles'],
      ['channels', 'Channels'],
      ['messages', 'Messages'],
    ].map(([value, label]) => new ButtonBuilder()
      .setCustomId(`jconfig:page:${value}`)
      .setLabel(label)
      .setStyle(page === value ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(page === value))
  );
  let controls = [];
  if (page === 'settings') {
    embed.setDescription('Configure jail durations and evidence defaults.')
      .addFields(
        { name: 'Default sentence', value: formatDuration(jail.defaultSentenceSeconds), inline: true },
        { name: 'Minimum sentence', value: formatDuration(jail.minimumSentenceSeconds ?? 600), inline: true },
        { name: 'Evidence messages', value: String(jail.evidenceMessageCount ?? 5), inline: true },
        { name: 'Default evidence note', value: jail.defaultMessage ? jail.defaultMessage.slice(0, 1000) : 'None', inline: false },
      );
    controls = SETTINGS.filter(setting => ['default_seconds', 'minimum_seconds', 'evidence_count', 'default_message'].includes(setting.value))
      .map(setting => new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId(`jconfig:${setting.value}`).setPlaceholder(`Change ${setting.label}`)
        .addOptions([{ label: setting.label, value: setting.value, description: setting.description }])));
  } else if (page === 'roles') {
    embed.setDescription('Manage which roles are used by the jail system.')
      .addFields(
        { name: 'Jail roles', value: Array.isArray(jail.roles) && jail.roles.length ? formatRoleMentions(jail.roles.map(item => item.roleId)) : 'None configured', inline: false },
        { name: 'Lawyer role', value: jail.lawyerRoleId ? `<@&${jail.lawyerRoleId}>` : 'None configured', inline: true },
        { name: 'Policeman roles', value: Array.isArray(jail.policemanRoleIds) && jail.policemanRoleIds.length ? formatRoleMentions(jail.policemanRoleIds) : 'None configured', inline: true },
      );
    const roleMenu = new StringSelectMenuBuilder().setCustomId('jconfig:role_action').setPlaceholder('Choose a role action')
      .addOptions(
        { label: 'Add jail roles', value: 'add_jail_roles', description: 'Register existing server roles as jail roles' },
        { label: 'Set lawyer role', value: 'set_lawyer', description: 'Choose the lawyer role' },
        { label: 'Choose policeman roles', value: 'set_policeman', description: 'Select multiple roles; choose none to clear' },
        { label: 'Remove roles', value: 'remove_roles', description: 'Unassign or delete configured roles' },
      );
    controls = [new ActionRowBuilder().addComponents(roleMenu)];
  } else if (page === 'channels') {
    embed.setDescription('All channel and category settings are managed here, separately from role settings.')
      .addFields(
        { name: 'Default jail channel', value: jail.channelId ? `<#${jail.channelId}>` : 'None configured', inline: true },
        { name: 'Jail category', value: jail.categoryId ? `<#${jail.categoryId}>` : 'None configured', inline: true },
        { name: 'Evidence forum', value: jail.evidenceForumId ? `<#${jail.evidenceForumId}>` : 'None configured', inline: true },
        { name: 'Logs channel', value: jail.logsChannelId ? `<#${jail.logsChannelId}>` : 'None configured', inline: true },
        { name: 'Announcement channel', value: jail.actionLogChannelId ? `<#${jail.actionLogChannelId}>` : 'None configured', inline: true },
        { name: 'Role-specific jail channels', value: Array.isArray(jail.roles) && jail.roles.length ? jail.roles.slice(0, 18).map(item => `<@&${item.roleId}> → ${item.channelId ? `<#${item.channelId}>` : 'Default channel'}`).join('\\n') + (jail.roles.length > 18 ? `\\n…and ${jail.roles.length - 18} more` : '') : 'No jail roles configured', inline: false },
      );
    const channelMenu = new StringSelectMenuBuilder().setCustomId('jconfig:channel_action').setPlaceholder('Choose a channel setting')
      .addOptions(
        { label: 'Default jail channel', value: 'default_jail', description: 'Choose the default channel for jailed members' },
        { label: 'Jail category', value: 'category', description: 'Choose the category for jail channels' },
        { label: 'Evidence forum', value: 'evidence_forum', description: 'Choose where jail evidence is stored' },
        { label: 'Logs channel', value: 'logs', description: 'Choose where moderation logs are sent' },
        { label: 'Announcement channel', value: 'announcement', description: 'Choose where jail and unjail announcements are posted' },
        { label: 'Role-specific jail channel', value: 'role_channel', description: 'Assign a channel to a specific jail role' },
      );
    controls = [new ActionRowBuilder().addComponents(channelMenu)];
  } else {
    embed.setDescription('Customize the messages sent when members are jailed or released.')
      .addFields(
        { name: 'Jail announcement', value: (jail.jailAnnouncement || '{{user}} HAS BEEN JAILED').slice(0, 1000), inline: false },
        { name: 'Unjail announcement', value: (jail.unjailAnnouncement || '{{user}} HAS BEEN UNJAILED').slice(0, 1000), inline: false },
        { name: 'Announcement channel', value: jail.actionLogChannelId ? `<#${jail.actionLogChannelId}>` : 'Not configured', inline: true },
        { name: 'Placeholders', value: '`{{user}}` `{{server}}` `{{moderator}}` `{{role}}` `{{reason}}` `{{duration}}` `{{roles}}`', inline: false },
      );
    const messageMenu = new StringSelectMenuBuilder().setCustomId('jconfig:message_choice').setPlaceholder('Choose a message to edit')
      .addOptions(
        { label: 'Jail message', value: 'jail_announcement', description: 'Customize the message when a member is jailed' },
        { label: 'Unjail message', value: 'unjail_announcement', description: 'Customize the message when a member is released' },
      );
    controls = [new ActionRowBuilder().addComponents(messageMenu)];
  }
  return { content: '', embeds: [embed], components: [...controls, nav], flags: MessageFlags.Ephemeral };
}

async function logConfigSave(interaction, jail, title, details) {
  const logsChannelId = jail?.logsChannelId;
  if (!logsChannelId) return;
  const logsChannel = await interaction.guild.channels.fetch(logsChannelId).catch(() => null);
  if (!logsChannel?.isTextBased?.() || !logsChannel.send) return;
  await logsChannel.send({
    embeds: [{
      color: 0x5865F2,
      title: `Configuration saved: ${title}`,
      description: `**Staff:** <@${interaction.user.id}> (${interaction.user.id})\n${details}`,
      timestamp: new Date().toISOString(),
    }],
    allowedMentions: { parse: [] },
  }).catch(() => null);
}


async function getJailChannelOptions(guild, jail = {}) {
  const categoryId = jail.categoryId ?? null;
  const channels = await guild.channels.fetch();
  const configuredIds = new Set([
    jail.channelId,
    ...(jail.roles ?? []).map(item => item?.channelId),
  ].filter(Boolean));
  return channels.filter(channel =>
    channel.type === ChannelType.GuildText &&
    (configuredIds.has(channel.id) || (categoryId && channel.parentId === categoryId))
  ).sort((a, b) => a.name.localeCompare(b.name));
}

function jailChannelMenu(roleId, page, channels) {
  const pageCount = Math.max(1, Math.ceil(channels.length / CONFIG_CHANNEL_ROLE_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, Number(page) || 0), pageCount - 1);
  const options = channels
    .slice(safePage * CONFIG_CHANNEL_ROLE_PAGE_SIZE, (safePage + 1) * CONFIG_CHANNEL_ROLE_PAGE_SIZE)
    .map(channel => ({
      label: channel.name.slice(0, 100),
      value: channel.id,
      description: channel.parent?.name ? `In ${channel.parent.name}`.slice(0, 100) : 'Jail channel',
    }));
  options.push({ label: '← Previous page', value: '__previous_page__', description: 'Show the previous jail channels', disabled: safePage === 0 });
  options.push({ label: 'Next page →', value: '__next_page__', description: 'Show more jail channels', disabled: safePage >= pageCount - 1 });
  return new StringSelectMenuBuilder()
    .setCustomId(`jconfig:channel:${roleId}:${safePage}`)
    .setPlaceholder(`Choose a jail channel (page ${safePage + 1}/${pageCount})`)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);
}

const CHANNEL_PICKER_PAGE_SIZE = 23;

async function getSelectableChannels(guild, type) {
  const channels = await guild.channels.fetch();
  return channels
    .filter(channel => channel.type === type)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildPaginatedChannelPicker(key, page, channels) {
  const pageCount = Math.max(1, Math.ceil(channels.length / CHANNEL_PICKER_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const options = channels
    .slice(safePage * CHANNEL_PICKER_PAGE_SIZE, (safePage + 1) * CHANNEL_PICKER_PAGE_SIZE)
    .map(channel => ({
      label: channel.name.slice(0, 100),
      value: channel.id,
      description: channel.parent?.name
        ? `In ${channel.parent.name}`.slice(0, 100)
        : 'Server channel',
    }));

  if (safePage > 0) {
    options.push({ label: '← Previous page', value: '__previous_page__', description: 'Show the previous set' });
  }
  if (safePage < pageCount - 1) {
    options.push({ label: 'Next page →', value: '__next_page__', description: 'Show more channels' });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`jconfig:pick_channel:${key}:${safePage}`)
    .setPlaceholder(`Choose ${({
      categoryId: 'a category',
      channelId: 'a text channel',
      evidenceForumId: 'an evidence forum',
      actionLogChannelId: 'an announcement channel',
      logsChannelId: 'a logs channel',
    })[key] ?? 'a channel'} (page ${safePage + 1}/${pageCount})`)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return {
    menu,
    content: `Choose the ${({
      categoryId: 'jail category',
      channelId: 'default jail channel',
      evidenceForumId: 'jail evidence forum',
      actionLogChannelId: 'announcement channel',
      logsChannelId: 'logs channel',
    })[key] ?? 'channel'} — page ${safePage + 1} of ${pageCount} (${channels.length} available).`,
  };
}

async function saveJailRoleChannel(interaction, client, roleId, channelId) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  const { getGuildConfig } = await import('../../services/config/guildConfig.js');
  const current = await getGuildConfig(client, interaction.guildId);
  const jail = { ...(current?.jail ?? {}) };
  const roles = Array.isArray(jail.roles) ? [...jail.roles] : [];
  const index = roles.findIndex(item => item?.roleId === roleId);
  if (index < 0) return interaction.editReply({ content: 'That role is no longer registered as a jail role. Nothing was changed.', embeds: [], components: [] });
  const previousChannelId = roles[index]?.channelId ?? null;
  if (channelId) {
    const selectedChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    const allowedJailChannels = await getJailChannelOptions(interaction.guild, jail);
    if (!selectedChannel || !allowedJailChannels.some(channel => channel.id === channelId)) return interaction.editReply({ content: 'Choose one of the available jail channels from the configured jail category.', embeds: [], components: [] });
    roles[index] = { ...roles[index], roleId, channelId };
  } else {
    roles[index] = { ...roles[index], roleId, channelId: null };
  }
  jail.roles = roles;
  const defaultChannelId = jail.channelId ?? null;
  const channelIds = [...new Set([defaultChannelId, previousChannelId, ...roles.map(item => item?.channelId).filter(Boolean)].filter(Boolean))];
  const roleIds = roles.map(item => item?.roleId).filter(Boolean);
  for (const id of channelIds) {
    const channel = await interaction.guild.channels.fetch(id).catch(() => null);
    if (!channel?.permissionOverwrites || channel.type !== ChannelType.GuildText) continue;
    for (const configuredRoleId of roleIds) {
      const configured = roles.find(item => item?.roleId === configuredRoleId);
      const effectiveChannelId = configured?.channelId || defaultChannelId;
      const canView = effectiveChannelId === channel.id;
      await channel.permissionOverwrites.edit(configuredRoleId, canView
        ? { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, EmbedLinks: false }
        : { ViewChannel: false }, 'Update jail role channel from /config');
    }
  }
  await updateGuildConfig(client, interaction.guildId, { jail });
  await logConfigSave(interaction, jail, 'Jail role channel', `**Role:** <@&${roleId}>\n**Channel:** ${channelId ? `<#${channelId}>` : 'Default jail channel'}`);
  return interaction.editReply({
    content: channelId
      ? `Saved: <@&${roleId}> now uses <#${channelId}>. Other configured jail roles are denied access to that role-specific channel.`
      : `Saved: <@&${roleId}> now falls back to the default jail channel ${defaultChannelId ? `<#${defaultChannelId}>` : '(not configured yet)'}.`,
    embeds: [],
    components: [],
  });
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
    return interaction.reply(panelPayload(guildConfig?.jail ?? {}, 'settings'));
  },

  async handleComponent(interaction, client) {
    const isComponent = interaction.isButton?.() || interaction.isStringSelectMenu?.() || interaction.isRoleSelectMenu?.() || interaction.isChannelSelectMenu?.();
    const opensModal = interaction.isStringSelectMenu?.() && (
      interaction.customId === 'jconfig:message_choice' ||
      (interaction.customId?.startsWith('jconfig:') && SETTINGS.some(setting => setting.value === interaction.values?.[0]))
    );
    if (isComponent && interaction.customId?.startsWith('jconfig:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
        return true;
      }
      // Acknowledge immediately, before database reads, Discord fetches, or permission updates.
      if (!opensModal && !interaction.deferred && !interaction.replied) if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    }
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:page:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const page = interaction.customId.slice('jconfig:page:'.length);
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      return interaction.editReply(panelPayload(current?.jail ?? {}, page));
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'jconfig:channel_action') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const action = interaction.values[0];
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      if (action === 'role_channel') {
        const roles = (current?.jail?.roles ?? []).filter(item => item?.roleId);
        if (!roles.length) return interaction.editReply({ content: 'No jail roles are configured yet. Add jail roles on the Roles page first.', embeds: [], components: [] });
        const ids = [...new Set(roles.map(item => item.roleId))];
        const guildRoles = (await Promise.all(ids.map(id => interaction.guild.roles.fetch(id).catch(() => null)))).filter(Boolean);
        const picker = buildPaginatedRoleMenu('jconfig:channel_role_page:0', 'Choose a configured jail role', guildRoles, 0, [], { multiple: false, clearable: false });
        return interaction.editReply({ content: `Choose the jail role whose channel you want to change. Page 1 of ${picker.pageCount}.`, embeds: [], components: [new ActionRowBuilder().addComponents(picker.menu)] });
      }
      const settings = {
        default_jail: { key: 'channelId', label: 'Default jail channel', type: ChannelType.GuildText },
        category: { key: 'categoryId', label: 'Jail category', type: ChannelType.GuildCategory },
        evidence_forum: { key: 'evidenceForumId', label: 'Evidence forum', type: ChannelType.GuildForum },
        logs: { key: 'logsChannelId', label: 'Logs channel', type: ChannelType.GuildText },
        announcement: { key: 'actionLogChannelId', label: 'Announcement channel', type: ChannelType.GuildText },
      };
      const setting = settings[action];
      if (!setting) return false;
      if (['default_jail', 'category', 'evidence_forum', 'announcement', 'logs'].includes(action)) {
        const channels = await getSelectableChannels(interaction.guild, setting.type);
        if (!channels.length) {
          const emptyLabels = {
            default_jail: 'text channels',
            category: 'categories',
            evidence_forum: 'forum channels',
            announcement: 'text channels',
            logs: 'text channels',
          };
          return interaction.editReply({
            content: `No ${emptyLabels[action]} were found in this server.`,
            embeds: [],
            components: [],
          });
        }
        const picker = buildPaginatedChannelPicker(setting.key, 0, channels);
        return interaction.editReply({ content: picker.content, embeds: [], components: [new ActionRowBuilder().addComponents(picker.menu)] });
      }
      const channels = await getSelectableChannels(interaction.guild, setting.type);
      if (!channels.length) return interaction.editReply({ content: `No ${setting.label.toLowerCase()} options were found in this server.`, embeds: [], components: [] });
      const picker = buildPaginatedChannelPicker(setting.key, 0, channels);
      return interaction.editReply({ content: picker.content, embeds: [], components: [new ActionRowBuilder().addComponents(picker.menu)] });
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('jconfig:pick_channel:')) {
      const [, , key, pageValue] = interaction.customId.split(':');
      const setting = {
        channelId: { label: 'Default jail channel', type: ChannelType.GuildText },
        categoryId: { label: 'Jail category', type: ChannelType.GuildCategory },
        evidenceForumId: { label: 'Evidence forum', type: ChannelType.GuildForum },
        actionLogChannelId: { label: 'Announcement channel', type: ChannelType.GuildText },
        logsChannelId: { label: 'Logs channel', type: ChannelType.GuildText },
      }[key] ?? null;
      if (!setting) return interaction.editReply({ content: 'Invalid channel setting.', embeds: [], components: [] });

      const selected = interaction.values[0];
      const currentPage = Number.parseInt(pageValue, 10) || 0;
      if (selected === '__previous_page__' || selected === '__next_page__') {
        const channels = await getSelectableChannels(interaction.guild, setting.type);
        const nextPage = selected === '__previous_page__' ? currentPage - 1 : currentPage + 1;
        const picker = buildPaginatedChannelPicker(key, nextPage, channels);
        return interaction.editReply({ content: picker.content, embeds: [], components: [new ActionRowBuilder().addComponents(picker.menu)] });
      }

      const selectedChannel = await interaction.guild.channels.fetch(selected).catch(() => null);
      if (!selectedChannel || selectedChannel.type !== setting.type) {
        return interaction.editReply({ content: `That is not a valid ${setting.label.toLowerCase()}.`, embeds: [], components: [] });
      }
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current?.jail ?? {}), [key]: selectedChannel.id };
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, setting.label, `**Selection:** <#${selectedChannel.id}>`);
      return interaction.editReply({
        content: `Saved ${setting.label.toLowerCase()}: <#${selectedChannel.id}>.`,
        embeds: [],
        components: [],
      });
    }
    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('jconfig:set_channel:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const key = interaction.customId.slice('jconfig:set_channel:'.length);
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current?.jail ?? {}), [key]: interaction.values[0] };
      const labels = { channelId: 'Default jail channel', categoryId: 'Jail category', evidenceForumId: 'Evidence forum', logsChannelId: 'Logs channel', actionLogChannelId: 'Announcement channel' };
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, labels[key] || 'Channel setting', `**Channel:** <#${interaction.values[0]}>`);
      return interaction.editReply({ content: `Saved ${labels[key] || 'channel'}: <#${interaction.values[0]}>.`, embeds: [], components: [] });
    }
    if (interaction.isChannelSelectMenu() && interaction.customId === 'jconfig:action_log_channel') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current?.jail ?? {}), actionLogChannelId: interaction.values[0] };
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, 'Jail/unjail announcement channel', `**Channel:** <#${interaction.values[0]}>`);
      return interaction.editReply({ content: `Saved announcement channel: <#${interaction.values[0]}>.`, embeds: [], components: [] });
    }
    if (interaction.customId === 'jconfig:message_choice' && interaction.isStringSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const field = interaction.values[0];
      const setting = SETTINGS.find(item => item.value === field);
      if (!setting || !['jail_announcement', 'unjail_announcement'].includes(field)) return interaction.editReply({ content: 'Invalid message setting.', flags: MessageFlags.Ephemeral });
      const modal = new ModalBuilder().setCustomId(`jconfigmodal:${field}`).setTitle(`Edit ${setting.label}`);
      const input = new TextInputBuilder().setCustomId('setting_value').setLabel('Message template')
        .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
        .setPlaceholder('Leave empty to restore the default message');
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('jconfig:channel_role_page:')) {
      const currentPage = Number.parseInt(interaction.customId.split(':').at(-1), 10) || 0;
      const selected = interaction.values[0];
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const ids = [...new Set((current?.jail?.roles ?? []).map(item => item?.roleId).filter(Boolean))];
      const guildRoles = (await Promise.all(ids.map(id => interaction.guild.roles.fetch(id).catch(() => null)))).filter(Boolean);
      if (selected === '__previous_page__' || selected === '__next_page__') {
        const nextPage = selected === '__previous_page__' ? currentPage - 1 : currentPage + 1;
        const picker = buildPaginatedRoleMenu(`jconfig:channel_role_page:${nextPage}`, 'Choose a configured jail role', guildRoles, nextPage, [], { multiple: false, clearable: false });
        return interaction.editReply({ content: `Choose the jail role whose channel you want to change. Page ${picker.page + 1} of ${picker.pageCount}.`, embeds: [], components: [new ActionRowBuilder().addComponents(picker.menu)] });
      }
      const roleId = selected;
      const entry = (current?.jail?.roles ?? []).find(item => item?.roleId === roleId);
      if (!entry) return interaction.editReply({ content: 'That role is not currently registered as a jail role. Nothing was changed.', embeds: [], components: [] });
      const channels = await getJailChannelOptions(interaction.guild, current?.jail ?? {});
      if (!channels.length) return interaction.editReply({ content: 'No jail channels found. Set the jail category first, or run /setup-jail to create the jail channels.', embeds: [], components: [] });
      const channelMenu = jailChannelMenu(roleId, 0, channels);
      return interaction.editReply({ content: `Choose a jail channel for <@&${roleId}>. You can also choose **Use default jail channel** to make it fall back to the server default.`, embeds: [], components: [
        new ActionRowBuilder().addComponents(channelMenu),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`jconfig:channel_default:${roleId}`).setLabel('Use default jail channel').setStyle(ButtonStyle.Secondary)),
      ] });
    }
    if (interaction.customId === 'jconfig:channel_role' && interaction.isStringSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const roleId = interaction.values[0];
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const entry = (current?.jail?.roles ?? []).find(item => item?.roleId === roleId);
      if (!entry) return interaction.editReply({ content: 'That role is not currently registered as a jail role. Run /setup-jail first.', embeds: [], components: [] });
      const channels = await getJailChannelOptions(interaction.guild, current?.jail ?? {});
      if (!channels.length) return interaction.editReply({ content: 'No jail channels found. Set the jail category first, or run /setup-jail to create the jail channels.', embeds: [], components: [] });
      const channelMenu = jailChannelMenu(roleId, 0, channels);
      return interaction.editReply({
        content: `Choose a jail channel for <@&${roleId}>. You can also choose **Use default jail channel** to make it fall back to the server default.`,
        embeds: [],
        components: [
          new ActionRowBuilder().addComponents(channelMenu),
          new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`jconfig:channel_default:${roleId}`).setLabel('Use default jail channel').setStyle(ButtonStyle.Secondary)),
        ],
      });
    }
    if ((interaction.isChannelSelectMenu() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('jconfig:channel:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const [, , roleId, pageValue] = interaction.customId.split(':');
      const selected = interaction.values[0];
      if (interaction.isStringSelectMenu() && (selected === '__previous_page__' || selected === '__next_page__')) {
        const { getGuildConfig } = await import('../../services/config/guildConfig.js');
        const current = await getGuildConfig(client, interaction.guildId);
        const entry = (current?.jail?.roles ?? []).find(item => item?.roleId === roleId);
        if (!entry) return interaction.editReply({ content: 'That jail role is no longer configured.', embeds: [], components: [] });
        const channels = await getJailChannelOptions(interaction.guild, current?.jail ?? {});
        const currentPage = Number.parseInt(pageValue, 10) || 0;
        const nextPage = selected === '__previous_page__' ? currentPage - 1 : currentPage + 1;
        const channelMenu = jailChannelMenu(roleId, nextPage, channels);
        return interaction.editReply({ content: `Choose a jail channel for <@&${roleId}>. Page ${nextPage + 1} of ${Math.max(1, Math.ceil(channels.length / CONFIG_CHANNEL_ROLE_PAGE_SIZE))}.`, embeds: [], components: [
          new ActionRowBuilder().addComponents(channelMenu),
          new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`jconfig:channel_default:${roleId}`).setLabel('Use default jail channel').setStyle(ButtonStyle.Secondary)),
        ] });
      }
      await saveJailRoleChannel(interaction, client, roleId, selected);
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:channel_default:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const roleId = interaction.customId.slice('jconfig:channel_default:'.length);
      await saveJailRoleChannel(interaction, client, roleId, null);
      return true;
    }
    if (interaction.customId === 'jconfig:role_action' && interaction.isStringSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const action = interaction.values[0];
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = current?.jail ?? {};
      const pendingSelectionKey = `${interaction.guildId}:${interaction.user.id}`;
      if (action === 'message_config') {
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('Jail message configuration')
          .setDescription('Choose which message to edit. Placeholders are replaced automatically.')
          .addFields(
            { name: 'Jail message', value: (jail.jailAnnouncement || '{{user}} HAS BEEN JAILED').slice(0, 1000) },
            { name: 'Unjail message', value: (jail.unjailAnnouncement || '{{user}} HAS BEEN UNJAILED').slice(0, 1000) },
            { name: 'Announcement channel', value: jail.actionLogChannelId ? `<#${jail.actionLogChannelId}>` : 'Not configured' },
            { name: 'Jail placeholders', value: '`{{user}}` `{{server}}` `{{moderator}}` `{{role}}` `{{reason}}` `{{duration}}`' },
            { name: 'Unjail placeholders', value: '`{{user}}` `{{server}}` `{{moderator}}` `{{roles}}`' },
          );
        const messageMenu = new StringSelectMenuBuilder().setCustomId('jconfig:message_choice').setPlaceholder('Choose a message to edit')
          .addOptions(
            { label: 'Jail message', value: 'jail_announcement', description: 'Customize the message when a member is jailed' },
            { label: 'Unjail message', value: 'unjail_announcement', description: 'Customize the message when a member is released' },
          );
        const channels = await getSelectableChannels(interaction.guild, ChannelType.GuildText);
        const picker = channels.length ? buildPaginatedChannelPicker('actionLogChannelId', 0, channels) : null;
        return interaction.editReply({ content: picker?.content ?? 'No text channels were found for announcements.', embeds: [embed], components: [
          new ActionRowBuilder().addComponents(messageMenu),
          ...(picker ? [new ActionRowBuilder().addComponents(picker.menu)] : []),
        ] });
      }
      if (action === 'set_action_log_channel') {
        const channels = await getSelectableChannels(interaction.guild, ChannelType.GuildText);
        if (!channels.length) return interaction.editReply({ content: 'No text channels were found in this server.', embeds: [], components: [] });
        const picker = buildPaginatedChannelPicker('actionLogChannelId', 0, channels);
        return interaction.editReply({ content: 'Choose the channel where jail and unjail announcements will be posted. ' + picker.content, embeds: [], components: [new ActionRowBuilder().addComponents(picker.menu)] });
      }
      if (action === 'set_policeman' || action === 'add_jail_roles' || action === 'set_lawyer') {
        const allRoles = await interaction.guild.roles.fetch();
        const roleChoices = [...allRoles.values()]
          .filter(role => role.id !== interaction.guildId && !role.managed)
          .sort((a, b) => a.name.localeCompare(b.name));
        if (!roleChoices.length) return interaction.editReply({ content: 'No selectable server roles were found.', embeds: [], components: [] });
        const state = { roles: roleChoices, selectedIds: [], page: 0, mode: action === 'set_lawyer' ? 'single' : 'multiple' };
        pendingRoleSelections.set(`${pendingSelectionKey}:${action}`, state);
        const placeholder = action === 'set_policeman' ? 'Choose policeman roles' : action === 'add_jail_roles' ? 'Choose jail roles to register' : 'Choose the lawyer role';
        const picker = buildPaginatedRoleMenu(`jconfig:role_page:${action}:0`, placeholder, roleChoices, 0, [], { multiple: action !== 'set_lawyer', clearable: true });
        const instructions = action === 'set_policeman'
          ? 'Select policeman roles across as many pages as needed. Use Clear all selected to remove every selection; Save with none selected to clear all policeman roles.'
          : action === 'add_jail_roles'
            ? 'Select existing server roles to register as jail roles across as many pages as needed. They use the default jail channel unless assigned a different channel afterward.'
            : 'Select one existing server role to use as the lawyer role. Use Clear all selected to remove the current choice before saving.';
        return interaction.editReply({ content: `${instructions} Page 1 of ${picker.pageCount}.`, embeds: [], components: [
          new ActionRowBuilder().addComponents(picker.menu),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`jconfig:save_roles:${action}`).setLabel('Save').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`jconfig:cancel_roles:${action}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          ),
        ] });
      }
      const configuredIds = action === 'set_jail_channel'
        ? [...new Set((jail.roles ?? []).map(item => item?.roleId).filter(Boolean))]
        : [...new Set([
            ...(jail.roles ?? []).map(item => item?.roleId).filter(Boolean),
            jail.lawyerRoleId,
            ...(jail.policemanRoleIds ?? []),
          ].filter(Boolean))];
      const configuredRoles = (await Promise.all(configuredIds.map(id => interaction.guild.roles.fetch(id).catch(() => null)))).filter(Boolean);
      if (!configuredRoles.length) {
        return interaction.editReply({
          content: action === 'set_jail_channel'
            ? 'No jail roles are configured yet. Run /setup-jail first.'
            : 'There are no configured jail, lawyer, or policeman roles to remove.',
          embeds: [], components: [],
        });
      }
      if (action === 'set_jail_channel') {
        const picker = buildPaginatedRoleMenu('jconfig:channel_role_page:0', 'Choose a configured jail role', configuredRoles, 0, [], { multiple: false, clearable: false });
        return interaction.editReply({ content: `Select a configured jail role to assign a channel. Page 1 of ${picker.pageCount}.`, embeds: [], components: [new ActionRowBuilder().addComponents(picker.menu)] });
      }
      const removalState = { roles: configuredRoles, selectedIds: [], page: 0, mode: 'multiple' };
      pendingRoleRemovals.set(pendingSelectionKey, removalState);
      const removePicker = buildPaginatedRoleMenu('jconfig:remove_page:0', 'Choose configured roles to remove', configuredRoles, 0, [], { multiple: true, clearable: true,
        descriptionForRole: role => [
          (jail.roles ?? []).some(item => item?.roleId === role.id) ? 'Jail' : '',
          jail.lawyerRoleId === role.id ? 'Lawyer' : '',
          (jail.policemanRoleIds ?? []).includes(role.id) ? 'Policeman' : '',
        ].filter(Boolean).join(' / '),
      });
      return interaction.editReply({ content: `Select configured roles across as many pages as needed. Selected: 0. Page 1 of ${removePicker.pageCount}.`, embeds: [], components: [
        new ActionRowBuilder().addComponents(removePicker.menu),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('jconfig:remove_keep').setLabel('Remove from configuration only').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('jconfig:remove_delete').setLabel('Remove and delete roles').setStyle(ButtonStyle.Danger),
        ),
      ] });
    }
    const roleSelectionActions = ['add_jail_roles', 'set_lawyer', 'set_policeman'];
    const pendingSelectionKey = `${interaction.guildId}:${interaction.user.id}`;
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('jconfig:role_page:')) {
      const [, , action, pageValue] = interaction.customId.split(':');
      const key = `${interaction.guildId}:${interaction.user.id}:${action}`;
      const state = pendingRoleSelections.get(key);
      if (!state) return interaction.editReply({ content: 'That role selection expired. Open /config and try again.', embeds: [], components: [] });
      updatePagedRoleSelection(state, Number.parseInt(pageValue, 10) || 0, interaction.values);
      pendingRoleSelections.set(key, state);
      const placeholder = action === 'set_policeman' ? 'Choose policeman roles' : action === 'add_jail_roles' ? 'Choose jail roles to register' : 'Choose the lawyer role';
      const picker = buildPaginatedRoleMenu(`jconfig:role_page:${action}:${state.page}`, placeholder, state.roles, state.page, state.selectedIds, { multiple: action !== 'set_lawyer', clearable: true });
      const instructions = action === 'set_policeman'
        ? `Select policeman roles across pages. Selected: ${state.selectedIds.length}. Save with none selected to clear all.`
        : action === 'add_jail_roles'
          ? `Select jail roles to register across pages. Selected: ${state.selectedIds.length}.`
          : `Choose one lawyer role. ${state.selectedIds.length ? 'One role selected.' : 'No role selected.'}`;
      return interaction.editReply({ content: `${instructions} Page ${picker.page + 1} of ${picker.pageCount}.`, embeds: [], components: [
        new ActionRowBuilder().addComponents(picker.menu),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`jconfig:save_roles:${action}`).setLabel('Save').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`jconfig:cancel_roles:${action}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        ),
      ] });
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('jconfig:remove_page:')) {
      const pageValue = interaction.customId.split(':').at(-1);
      const key = `${interaction.guildId}:${interaction.user.id}`;
      const state = pendingRoleRemovals.get(key);
      if (!state) return interaction.editReply({ content: 'That role selection expired. Open /config and try again.', embeds: [], components: [] });
      updatePagedRoleSelection(state, Number.parseInt(pageValue, 10) || 0, interaction.values);
      pendingRoleRemovals.set(key, state);
      const picker = buildPaginatedRoleMenu(`jconfig:remove_page:${state.page}`, 'Choose configured roles to remove', state.roles, state.page, state.selectedIds, { multiple: true, clearable: true });
      return interaction.editReply({ content: `Selected ${state.selectedIds.length} role(s). Page ${picker.page + 1} of ${picker.pageCount}. Choose whether to unassign them only or also delete the Discord roles.`, embeds: [], components: [
        new ActionRowBuilder().addComponents(picker.menu),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('jconfig:remove_keep').setLabel('Remove from configuration only').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('jconfig:remove_delete').setLabel('Remove and delete roles').setStyle(ButtonStyle.Danger),
        ),
      ] });
    }
    if (interaction.isRoleSelectMenu() && roleSelectionActions.some(action => interaction.customId === `jconfig:${action === 'set_lawyer' ? 'lawyer_role' : action === 'set_policeman' ? 'policeman_roles' : action}`)) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const action = interaction.customId === 'jconfig:add_jail_roles' ? 'add_jail_roles' : interaction.customId === 'jconfig:lawyer_role' ? 'set_lawyer' : 'set_policeman';
      const selectedIds = [...new Set(interaction.values)].filter(id => id !== interaction.guildId);
      pendingRoleSelections.set(`${pendingSelectionKey}:${action}`, selectedIds);
      const selectedText = selectedIds.length ? selectedIds.map(id => `<@&${id}>`).join(', ') : 'None selected';
      return interaction.editReply({
        content: `Selected role(s): ${selectedText}\\nPress **Save** to apply this change.`,
        embeds: [],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`jconfig:save_roles:${action}`).setLabel('Save').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`jconfig:cancel_roles:${action}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    }
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:cancel_roles:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const action = interaction.customId.slice('jconfig:cancel_roles:'.length);
      pendingRoleSelections.delete(`${pendingSelectionKey}:${action}`);
      return interaction.editReply({ content: 'Role changes cancelled. Nothing was saved.', embeds: [], components: [] });
    }
    let savingRoleAction = null;
    let selectedRoleIds = null;
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:save_roles:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      savingRoleAction = interaction.customId.slice('jconfig:save_roles:'.length);
      const roleSelection = pendingRoleSelections.get(`${pendingSelectionKey}:${savingRoleAction}`);
      selectedRoleIds = Array.isArray(roleSelection) ? roleSelection : roleSelection?.selectedIds;
      if (!selectedRoleIds) return interaction.editReply({ content: 'That role selection expired. Please select the roles again.', embeds: [], components: [] });
      pendingRoleSelections.delete(`${pendingSelectionKey}:${savingRoleAction}`);
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    }
    if ((interaction.customId === 'jconfig:add_jail_roles' && interaction.isRoleSelectMenu()) || savingRoleAction === 'add_jail_roles') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      if (interaction.isRoleSelectMenu()) if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current?.jail ?? {}) };
      const existing = Array.isArray(jail.roles) ? [...jail.roles] : [];
      const selectedIds = selectedRoleIds ?? [...new Set(interaction.values)].filter(id => id !== interaction.guildId);
      if (!selectedIds.length) return interaction.editReply({ content: 'No jail roles selected. Nothing was changed.', embeds: [], components: [] });
      const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.editReply({ content: 'I need Manage Roles permission to configure jail roles.', embeds: [], components: [] });
      const roles = (await Promise.all(selectedIds.map(id => interaction.guild.roles.fetch(id).catch(() => null)))).filter(Boolean);
      if (roles.length !== selectedIds.length || roles.some(role => role.managed || role.permissions.has(PermissionFlagsBits.Administrator) || botMember.roles.highest.comparePositionTo(role) <= 0)) {
        return interaction.editReply({ content: 'One or more selected roles are missing, managed, have Administrator permission, or are above my highest role.', embeds: [], components: [] });
      }
      const channelId = jail.channelId ?? null;
      for (const role of roles) {
        if (!existing.some(item => item?.roleId === role.id)) existing.push({ roleId: role.id, channelId: null });
      }
      jail.roles = existing;
      // Apply jail visibility to existing resources, matching setup behavior without changing unrelated settings.
      const channels = await interaction.guild.channels.fetch();
      for (const category of channels.filter(channel => channel.type === ChannelType.GuildCategory && channel.id !== jail.categoryId).values()) {
        for (const role of roles) await category.permissionOverwrites.edit(role.id, { ViewChannel: false }, 'Register jail role from /config');
      }
      for (const resourceId of [jail.categoryId, channelId].filter(Boolean)) {
        const resource = await interaction.guild.channels.fetch(resourceId).catch(() => null);
        if (!resource?.permissionOverwrites) continue;
        for (const role of roles) {
          await resource.permissionOverwrites.edit(role.id, resourceId === channelId
            ? { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, EmbedLinks: false }
            : { ViewChannel: true, ReadMessageHistory: true }, 'Register jail role from /config');
        }
      }
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, 'Jail roles added', `**Role count:** ${roles.length}\n**Roles:** ${formatRoleMentions(roles.map(role => role.id), 2500)}`);
      return interaction.editReply({ content: `Registered ${roles.length} jail role(s): ${formatRoleMentions(roles.map(role => role.id), 1000)}. They use the default jail channel ${channelId ? `<#${channelId}>` : '(not configured)'} unless assigned a role-specific channel.`, embeds: [], components: [] });
    }
    if ((interaction.customId === 'jconfig:lawyer_role' && interaction.isRoleSelectMenu()) || savingRoleAction === 'set_lawyer') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const roleId = (selectedRoleIds ?? interaction.values)[0];
      if (!roleId) return interaction.editReply({ content: 'No lawyer role was selected. Nothing was changed.', embeds: [], components: [] });
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current?.jail ?? {}) };
      const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.editReply({ content: 'I need Manage Roles permission to configure the lawyer role.', embeds: [], components: [] });
      const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
      if (!role || role.id === interaction.guildId || role.managed || botMember.roles.highest.comparePositionTo(role) <= 0) {
        return interaction.editReply({ content: 'Choose a valid, manageable server role below my highest role.', embeds: [], components: [] });
      }
      if (role.permissions.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'The lawyer role cannot have Administrator permission.', embeds: [], components: [] });
      const previousId = jail.lawyerRoleId ?? null;
      if (previousId && previousId !== role.id) {
        for (const resourceId of [jail.categoryId, jail.channelId, jail.evidenceForumId].filter(Boolean)) {
          const resource = await interaction.guild.channels.fetch(resourceId).catch(() => null);
          if (resource?.permissionOverwrites) await resource.permissionOverwrites.delete(previousId, 'Replace configured lawyer role').catch(() => null);
        }
      }
      jail.lawyerRoleId = role.id;
      for (const resourceId of [jail.categoryId, jail.channelId, jail.evidenceForumId].filter(Boolean)) {
        const resource = await interaction.guild.channels.fetch(resourceId).catch(() => null);
        if (resource?.permissionOverwrites) await resource.permissionOverwrites.edit(role.id, { ViewChannel: true, ReadMessageHistory: true }, 'Configure lawyer role from /config');
      }
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, 'Lawyer role', `**Role:** <@&${role.id}>`);
      return interaction.editReply({ content: `Saved lawyer role: <@&${role.id}>. It can view the configured jail category, jail channel, and evidence forum.`, embeds: [], components: [] });
    }
    if ((interaction.customId === 'jconfig:policeman_roles' && interaction.isRoleSelectMenu()) || savingRoleAction === 'set_policeman') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const roleIds = selectedRoleIds ?? interaction.values;
      const jail = { ...(current.jail ?? {}), policemanRoleIds: roleIds };
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, 'Policeman roles', `**Role count:** ${roleIds.length}\n**Roles:** ${formatRoleMentions(roleIds, 2500)}`);
      return interaction.editReply({ content: `Saved ${roleIds.length} policeman role(s): ${formatRoleMentions(roleIds, 1000)}.`, embeds: [], components: [] });
    }
    if (interaction.customId === 'jconfig:remove_roles' && interaction.isStringSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      if (!interaction.values.length) return interaction.editReply({ content: 'No roles selected. Nothing was changed.', embeds: [], components: [] });
      pendingRoleRemovals.set(`${interaction.guildId}:${interaction.user.id}`, { roles: interaction.values.map(id => ({ id, name: id })), selectedIds: interaction.values, page: 0, mode: 'multiple' });
      return interaction.editReply({
        content: `Selected ${interaction.values.length} role(s). Choose whether to unassign them only or also delete the Discord roles.`,
        embeds: [],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('jconfig:remove_keep').setLabel('Remove from configuration only').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('jconfig:remove_delete').setLabel('Remove and delete roles').setStyle(ButtonStyle.Danger),
          ),
        ],
      });
    }
    if ((interaction.customId === 'jconfig:remove_keep' || interaction.customId === 'jconfig:remove_delete') && interaction.isButton()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const key = `${interaction.guildId}:${interaction.user.id}`;
      const removalState = pendingRoleRemovals.get(key);
      const selected = Array.isArray(removalState) ? removalState : (removalState?.selectedIds ?? []);
      if (!selected.length) return interaction.editReply({ content: 'That role selection expired or no roles were selected. Open /config and try again.', embeds: [], components: [] });
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current.jail ?? {}) };
      const configured = new Set([
        ...(jail.roles ?? []).map(item => item?.roleId).filter(Boolean),
        jail.lawyerRoleId,
        ...(jail.policemanRoleIds ?? []),
      ]);
      const removable = selected.filter(id => configured.has(id));
      if (!removable.length) {
        pendingRoleRemovals.delete(key);
        return interaction.editReply({ content: 'None of the selected roles are currently configured. Nothing was changed.', embeds: [], components: [] });
      }
      jail.roles = (jail.roles ?? []).filter(item => !removable.includes(item?.roleId));
      if (removable.includes(jail.lawyerRoleId)) jail.lawyerRoleId = null;
      jail.policemanRoleIds = (jail.policemanRoleIds ?? []).filter(id => !removable.includes(id));
      let rolesToDelete = [];
      if (interaction.customId === 'jconfig:remove_delete') {
        const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.editReply({ content: 'I need Manage Roles permission to delete Discord roles.', flags: MessageFlags.Ephemeral });
        rolesToDelete = (await Promise.all(removable.map(id => interaction.guild.roles.fetch(id).catch(() => null)))).filter(Boolean);
        const blocked = rolesToDelete.filter(role => role.managed || botMember.roles.highest.comparePositionTo(role) <= 0);
        if (blocked.length) return interaction.editReply({ content: `I cannot delete these roles. Move my highest role above them and check that they are not managed roles: ${blocked.map(role => role.name).join(', ')}.`, flags: MessageFlags.Ephemeral });
      }
      // Remove only the selected roles' old jail-resource overwrites; leave every other role and channel setting intact.
      for (const channelId of [jail.categoryId, jail.channelId, jail.evidenceForumId].filter(Boolean)) {
        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.permissionOverwrites) continue;
        for (const id of removable) await channel.permissionOverwrites.delete(id, 'Role unassigned from jail configuration').catch(() => null);
      }
      for (const role of rolesToDelete) await role.delete('Role removed from jail configuration by an administrator');
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, 'Roles removed', `**Role count:** ${removable.length}\n**Roles:** ${formatRoleMentions(removable, 2500)}\n**Discord roles deleted:** ${interaction.customId === 'jconfig:remove_delete' ? 'Yes, where permitted' : 'No'}`);
      pendingRoleRemovals.delete(key);
      return interaction.editReply({ content: `Removed ${removable.length} role(s) from jail configuration${interaction.customId === 'jconfig:remove_delete' ? ' and deleted the Discord roles where permitted' : ''}.`, embeds: [], components: [] });
    }
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
        .setLabel(field === 'default_seconds' ? 'Seconds, or INFINITE' : field === 'default_message' ? 'Message text (or CLEAR)' : ['jail_announcement', 'unjail_announcement'].includes(field) ? 'Announcement template' : 'Value')
        .setStyle(['default_message', 'jail_announcement', 'unjail_announcement'].includes(field) ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(!['default_message', 'jail_announcement', 'unjail_announcement'].includes(field))
        .setMaxLength(['default_message', 'jail_announcement', 'unjail_announcement'].includes(field) ? 1000 : 20);
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
        else if (/^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 2147483647) jail.defaultSentenceSeconds = Number(raw);
        else return interaction.reply({ content: 'Enter a positive number of seconds or INFINITE.', flags: MessageFlags.Ephemeral });
        if (jail.defaultSentenceSeconds !== null && jail.defaultSentenceSeconds < Number(jail.minimumSentenceSeconds ?? 600)) {
          return interaction.reply({ content: `Default sentence cannot be below the minimum of ${jail.minimumSentenceSeconds ?? 600} seconds.`, flags: MessageFlags.Ephemeral });
        }
      } else if (field === 'minimum_seconds') {
        if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 2147483647) return interaction.reply({ content: 'Enter a positive number of seconds.', flags: MessageFlags.Ephemeral });
        const next = Number(raw);
        if (jail.defaultSentenceSeconds != null && jail.defaultSentenceSeconds < next) return interaction.reply({ content: 'Minimum cannot exceed the configured finite default sentence.', flags: MessageFlags.Ephemeral });
        jail.minimumSentenceSeconds = next;
      } else if (field === 'evidence_count') {
        if (!/^(?:[1-9]|10)$/.test(raw)) return interaction.reply({ content: 'Evidence message count must be between 1 and 10.', flags: MessageFlags.Ephemeral });
        jail.evidenceMessageCount = Number(raw);
      } else if (field === 'default_message') {
        jail.defaultMessage = raw.toUpperCase() === 'CLEAR' ? '' : raw;
      } else if (field === 'jail_announcement') {
        jail.jailAnnouncement = raw || '{{user}} HAS BEEN JAILED';
      } else if (field === 'unjail_announcement') {
        jail.unjailAnnouncement = raw || '{{user}} HAS BEEN UNJAILED';
      } else {
        return interaction.reply({ content: 'Unknown setting.', flags: MessageFlags.Ephemeral });
      }
      if (field === 'default_seconds') jail.defaultDuration = undefined;
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, SETTINGS.find(s => s.value === field).label, `**New value:** ${field === 'default_message' ? (jail.defaultMessage || 'None') : field === 'default_seconds' ? formatDuration(jail.defaultSentenceSeconds) : field === 'minimum_seconds' ? formatDuration(jail.minimumSentenceSeconds) : field === 'jail_announcement' ? jail.jailAnnouncement : field === 'unjail_announcement' ? jail.unjailAnnouncement : jail.evidenceMessageCount}`);
      return interaction.reply({ content: `Saved **${SETTINGS.find(s => s.value === field).label}**.`, flags: MessageFlags.Ephemeral });
    }
    return false;
  },
};
