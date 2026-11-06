import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, RoleSelectMenuBuilder,
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
        { name: 'Jail roles', value: Array.isArray(jail.roles) && jail.roles.length ? jail.roles.map(item => `<@&${item.roleId}>`).join(', ') : 'None configured', inline: false },
        { name: 'Lawyer role', value: jail.lawyerRoleId ? `<@&${jail.lawyerRoleId}>` : 'None configured', inline: true },
        { name: 'Policeman roles', value: Array.isArray(jail.policemanRoleIds) && jail.policemanRoleIds.length ? jail.policemanRoleIds.map(id => `<@&${id}>`).join(', ') : 'None configured', inline: true },
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
        { name: 'Role-specific jail channels', value: Array.isArray(jail.roles) && jail.roles.length ? jail.roles.map(item => `<@&${item.roleId}> → ${item.channelId ? `<#${item.channelId}>` : 'Default channel'}`).join('\\n').slice(0, 1024) : 'No jail roles configured', inline: false },
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

async function saveJailRoleChannel(interaction, client, roleId, channelId) {
  const { getGuildConfig } = await import('../../services/config/guildConfig.js');
  const current = await getGuildConfig(client, interaction.guildId);
  const jail = { ...(current?.jail ?? {}) };
  const roles = Array.isArray(jail.roles) ? [...jail.roles] : [];
  const index = roles.findIndex(item => item?.roleId === roleId);
  if (index < 0) return interaction.update({ content: 'That role is no longer registered as a jail role. Nothing was changed.', embeds: [], components: [] });
  const previousChannelId = roles[index]?.channelId ?? null;
  if (channelId) {
    const selectedChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!selectedChannel || selectedChannel.type !== ChannelType.GuildText) return interaction.update({ content: 'Choose a valid text channel.', embeds: [], components: [] });
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
  return interaction.update({
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
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:page:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const page = interaction.customId.slice('jconfig:page:'.length);
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      return interaction.update(panelPayload(current?.jail ?? {}, page));
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'jconfig:channel_action') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const action = interaction.values[0];
      if (action === 'role_channel') {
        const { getGuildConfig } = await import('../../services/config/guildConfig.js');
        const current = await getGuildConfig(client, interaction.guildId);
        const roles = (current?.jail?.roles ?? []).filter(item => item?.roleId);
        if (!roles.length) return interaction.update({ content: 'No jail roles are configured yet. Add jail roles on the Roles page first.', embeds: [], components: [] });
        const ids = [...new Set(roles.map(item => item.roleId))];
        const guildRoles = (await Promise.all(ids.map(id => interaction.guild.roles.fetch(id).catch(() => null)))).filter(Boolean);
        const menu = new StringSelectMenuBuilder().setCustomId('jconfig:channel_role').setPlaceholder('Choose a configured jail role').setMinValues(1).setMaxValues(1)
          .addOptions(guildRoles.slice(0, 25).map(role => ({ label: role.name.slice(0, 100), value: role.id, description: 'Configured jail role' })));
        return interaction.update({ content: 'Choose the jail role whose channel you want to change.', embeds: [], components: [new ActionRowBuilder().addComponents(menu)] });
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
      const menu = new ChannelSelectMenuBuilder().setCustomId(`jconfig:set_channel:${setting.key}`)
        .setPlaceholder(`Choose ${setting.label.toLowerCase()}`).setChannelTypes(setting.type).setMinValues(1).setMaxValues(1);
      return interaction.update({ content: `Choose the ${setting.label.toLowerCase()}.`, embeds: [], components: [new ActionRowBuilder().addComponents(menu)] });
    }
    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('jconfig:set_channel:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const key = interaction.customId.slice('jconfig:set_channel:'.length);
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current?.jail ?? {}), [key]: interaction.values[0] };
      const labels = { channelId: 'Default jail channel', categoryId: 'Jail category', evidenceForumId: 'Evidence forum', logsChannelId: 'Logs channel', actionLogChannelId: 'Announcement channel' };
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, labels[key] || 'Channel setting', `**Channel:** <#${interaction.values[0]}>`);
      return interaction.update({ content: `Saved ${labels[key] || 'channel'}: <#${interaction.values[0]}>.`, embeds: [], components: [] });
    }
    if (interaction.isChannelSelectMenu() && interaction.customId === 'jconfig:action_log_channel') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current?.jail ?? {}), actionLogChannelId: interaction.values[0] };
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, 'Jail/unjail announcement channel', `**Channel:** <#${interaction.values[0]}>`);
      return interaction.update({ content: `Saved announcement channel: <#${interaction.values[0]}>.`, embeds: [], components: [] });
    }
    if (interaction.customId === 'jconfig:message_choice' && interaction.isStringSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const field = interaction.values[0];
      const setting = SETTINGS.find(item => item.value === field);
      if (!setting || !['jail_announcement', 'unjail_announcement'].includes(field)) return interaction.reply({ content: 'Invalid message setting.', flags: MessageFlags.Ephemeral });
      const modal = new ModalBuilder().setCustomId(`jconfigmodal:${field}`).setTitle(`Edit ${setting.label}`);
      const input = new TextInputBuilder().setCustomId('setting_value').setLabel('Message template')
        .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
        .setPlaceholder('Leave empty to restore the default message');
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }
    if (interaction.customId === 'jconfig:channel_role' && interaction.isStringSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const roleId = (selectedRoleIds ?? interaction.values)[0];
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const entry = (current?.jail?.roles ?? []).find(item => item?.roleId === roleId);
      if (!entry) return interaction.update({ content: 'That role is not currently registered as a jail role. Run /setup-jail first.', embeds: [], components: [] });
      const channelMenu = new ChannelSelectMenuBuilder()
        .setCustomId(`jconfig:channel:${roleId}`)
        .setPlaceholder('Choose the jail channel for this role')
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(1)
        .setMaxValues(1);
      return interaction.update({
        content: `Choose a jail channel for <@&${roleId}>. You can also choose **Use default jail channel** to make it fall back to the server default.`,
        embeds: [],
        components: [
          new ActionRowBuilder().addComponents(channelMenu),
          new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`jconfig:channel_default:${roleId}`).setLabel('Use default jail channel').setStyle(ButtonStyle.Secondary)),
        ],
      });
    }
    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('jconfig:channel:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const roleId = interaction.customId.slice('jconfig:channel:'.length);
      await saveJailRoleChannel(interaction, client, roleId, interaction.values[0]);
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:channel_default:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const roleId = interaction.customId.slice('jconfig:channel_default:'.length);
      await saveJailRoleChannel(interaction, client, roleId, null);
      return true;
    }
    if (interaction.customId === 'jconfig:role_action' && interaction.isStringSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const action = interaction.values[0];
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = current?.jail ?? {};
      let menu;
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
        const menu = new StringSelectMenuBuilder().setCustomId('jconfig:message_choice').setPlaceholder('Choose a message to edit')
          .addOptions(
            { label: 'Jail message', value: 'jail_announcement', description: 'Customize the message when a member is jailed' },
            { label: 'Unjail message', value: 'unjail_announcement', description: 'Customize the message when a member is released' },
          );
        const channel = new ChannelSelectMenuBuilder().setCustomId('jconfig:action_log_channel').setPlaceholder('Choose announcement channel')
          .setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1);
        return interaction.update({ content: '', embeds: [embed], components: [
          new ActionRowBuilder().addComponents(menu),
          new ActionRowBuilder().addComponents(channel),
        ] });
      }
      if (action === 'set_action_log_channel') {
        const channelMenu = new ChannelSelectMenuBuilder().setCustomId('jconfig:action_log_channel').setPlaceholder('Choose announcement channel').setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1);
        return interaction.update({ content: 'Choose the channel where jail and unjail announcements will be posted.', embeds: [], components: [new ActionRowBuilder().addComponents(channelMenu)] });
      }
      if (action === 'set_policeman' || action === 'add_jail_roles' || action === 'set_lawyer') {
        // These are explicit role-registration steps; only the selected role type is updated.
        menu = new RoleSelectMenuBuilder()
          .setCustomId(action === 'set_policeman' ? 'jconfig:policeman_roles' : action === 'add_jail_roles' ? 'jconfig:add_jail_roles' : 'jconfig:lawyer_role')
          .setMinValues(action === 'set_lawyer' ? 1 : action === 'add_jail_roles' ? 1 : 0)
          .setMaxValues(action === 'set_lawyer' ? 1 : action === 'add_jail_roles' ? 25 : 25)
          .setPlaceholder(action === 'set_policeman' ? 'Choose policeman roles (multiple allowed)' : action === 'add_jail_roles' ? 'Choose jail roles to register' : 'Choose the lawyer role');
      } else {
        const configuredIds = action === 'set_jail_channel'
          ? [...new Set((jail.roles ?? []).map(item => item?.roleId).filter(Boolean))]
          : [...new Set([
              ...(jail.roles ?? []).map(item => item?.roleId).filter(Boolean),
              jail.lawyerRoleId,
              ...(jail.policemanRoleIds ?? []),
            ].filter(Boolean))];
        const configuredRoles = (await Promise.all(configuredIds.map(id => interaction.guild.roles.fetch(id).catch(() => null)))).filter(Boolean);
        if (!configuredRoles.length) {
          return interaction.update({
            content: action === 'set_jail_channel'
              ? 'No jail roles are configured yet. Run /setup-jail first.'
              : 'There are no configured jail, lawyer, or policeman roles to remove.',
            embeds: [],
            components: [],
          });
        }
        menu = new StringSelectMenuBuilder()
          .setCustomId(action === 'set_jail_channel' ? 'jconfig:channel_role' : 'jconfig:remove_roles')
          .setMinValues(1)
          .setMaxValues(action === 'set_jail_channel' ? 1 : Math.min(25, configuredRoles.length))
          .setPlaceholder(action === 'set_jail_channel' ? 'Choose a configured jail role' : 'Choose configured roles to remove')
          .addOptions(configuredRoles.slice(0, 25).map(role => ({
            label: role.name.slice(0, 100),
            value: role.id,
            description: action === 'set_jail_channel' ? 'Configured jail role' : [
              (jail.roles ?? []).some(item => item?.roleId === role.id) ? 'Jail' : '',
              jail.lawyerRoleId === role.id ? 'Lawyer' : '',
              (jail.policemanRoleIds ?? []).includes(role.id) ? 'Policeman' : '',
            ].filter(Boolean).join(' / '),
          })));
      }
      return interaction.update({
        content: action === 'set_policeman'
          ? 'Select the policeman roles to authorize. Select none and submit to clear all policeman roles; no role will be created.'
          : action === 'add_jail_roles'
            ? 'Select existing server roles to register as jail roles. They will use the default jail channel unless you assign a different channel afterward.'
            : action === 'set_lawyer'
              ? 'Select one existing server role to use as the lawyer role.'
              : action === 'set_jail_channel'
                ? 'Select a jail role that is already registered in the jail configuration.'
                : 'Select only from roles already configured as jail, lawyer, or policeman roles.',
        embeds: [],
        components: [new ActionRowBuilder().addComponents(menu)],
      });
    }
    const roleSelectionActions = ['add_jail_roles', 'set_lawyer', 'set_policeman'];
    const pendingSelectionKey = `${interaction.guildId}:${interaction.user.id}`;
    if (interaction.isRoleSelectMenu() && roleSelectionActions.some(action => interaction.customId === `jconfig:${action === 'set_lawyer' ? 'lawyer_role' : action === 'set_policeman' ? 'policeman_roles' : action}`)) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const action = interaction.customId === 'jconfig:add_jail_roles' ? 'add_jail_roles' : interaction.customId === 'jconfig:lawyer_role' ? 'set_lawyer' : 'set_policeman';
      const selectedIds = [...new Set(interaction.values)].filter(id => id !== interaction.guildId);
      pendingRoleSelections.set(`${pendingSelectionKey}:${action}`, selectedIds);
      const selectedText = selectedIds.length ? selectedIds.map(id => `<@&${id}>`).join(', ') : 'None selected';
      return interaction.update({
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
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const action = interaction.customId.slice('jconfig:cancel_roles:'.length);
      pendingRoleSelections.delete(`${pendingSelectionKey}:${action}`);
      return interaction.update({ content: 'Role changes cancelled. Nothing was saved.', embeds: [], components: [] });
    }
    let savingRoleAction = null;
    let selectedRoleIds = null;
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:save_roles:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      savingRoleAction = interaction.customId.slice('jconfig:save_roles:'.length);
      selectedRoleIds = pendingRoleSelections.get(`${pendingSelectionKey}:${savingRoleAction}`);
      if (!selectedRoleIds) return interaction.update({ content: 'That role selection expired. Please select the roles again.', embeds: [], components: [] });
      pendingRoleSelections.delete(`${pendingSelectionKey}:${savingRoleAction}`);
      await interaction.deferUpdate();
    }
    if ((interaction.customId === 'jconfig:add_jail_roles' && interaction.isRoleSelectMenu()) || savingRoleAction === 'add_jail_roles') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      if (interaction.isRoleSelectMenu()) await interaction.deferUpdate();
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current?.jail ?? {}) };
      const existing = Array.isArray(jail.roles) ? [...jail.roles] : [];
      const selectedIds = selectedRoleIds ?? [...new Set(interaction.values)].filter(id => id !== interaction.guildId);
      if (!selectedIds.length) return interaction.editReply({ content: 'No jail roles selected. Nothing was changed.', embeds: [], components: [] });
      const combined = new Set([...existing.map(item => item?.roleId).filter(Boolean), ...selectedIds]);
      if (combined.size > 25) return interaction.editReply({ content: 'You can configure up to 25 jail roles. Remove some before adding more.', embeds: [], components: [] });
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
      await logConfigSave(interaction, jail, 'Jail roles added', `**Roles:** ${roles.map(role => `<@&${role.id}>`).join(', ')}`);
      return interaction.editReply({ content: `Registered ${roles.length} jail role(s): ${roles.map(role => `<@&${role.id}>`).join(', ')}. They use the default jail channel ${channelId ? `<#${channelId}>` : '(not configured)'} unless assigned a role-specific channel.`, embeds: [], components: [] });
    }
    if ((interaction.customId === 'jconfig:lawyer_role' && interaction.isRoleSelectMenu()) || savingRoleAction === 'set_lawyer') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const roleId = (selectedRoleIds ?? interaction.values)[0];
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
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const roleIds = selectedRoleIds ?? interaction.values;
      const jail = { ...(current.jail ?? {}), policemanRoleIds: roleIds };
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, 'Policeman roles', `**Roles:** ${roleIds.length ? roleIds.map(id => `<@&${id}>`).join(', ') : 'None'}`);
      return interaction.editReply({ content: `Saved ${roleIds.length} policeman role(s): ${roleIds.length ? roleIds.map(id => `<@&${id}>`).join(', ') : 'None'}.`, embeds: [], components: [] });
    }
    if (interaction.customId === 'jconfig:remove_roles' && interaction.isStringSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      if (!interaction.values.length) return interaction.update({ content: 'No roles selected. Nothing was changed.', embeds: [], components: [] });
      pendingRoleRemovals.set(`${interaction.guildId}:${interaction.user.id}`, interaction.values);
      return interaction.update({
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
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const key = `${interaction.guildId}:${interaction.user.id}`;
      const selected = pendingRoleRemovals.get(key) ?? [];
      if (!selected.length) return interaction.update({ content: 'That role selection expired. Open /config and try again.', embeds: [], components: [] });
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
        return interaction.update({ content: 'None of the selected roles are currently configured. Nothing was changed.', embeds: [], components: [] });
      }
      jail.roles = (jail.roles ?? []).filter(item => !removable.includes(item?.roleId));
      if (removable.includes(jail.lawyerRoleId)) jail.lawyerRoleId = null;
      jail.policemanRoleIds = (jail.policemanRoleIds ?? []).filter(id => !removable.includes(id));
      let rolesToDelete = [];
      if (interaction.customId === 'jconfig:remove_delete') {
        const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.reply({ content: 'I need Manage Roles permission to delete Discord roles.', flags: MessageFlags.Ephemeral });
        rolesToDelete = (await Promise.all(removable.map(id => interaction.guild.roles.fetch(id).catch(() => null)))).filter(Boolean);
        const blocked = rolesToDelete.filter(role => role.managed || botMember.roles.highest.comparePositionTo(role) <= 0);
        if (blocked.length) return interaction.reply({ content: `I cannot delete these roles. Move my highest role above them and check that they are not managed roles: ${blocked.map(role => role.name).join(', ')}.`, flags: MessageFlags.Ephemeral });
      }
      // Remove only the selected roles' old jail-resource overwrites; leave every other role and channel setting intact.
      for (const channelId of [jail.categoryId, jail.channelId, jail.evidenceForumId].filter(Boolean)) {
        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.permissionOverwrites) continue;
        for (const id of removable) await channel.permissionOverwrites.delete(id, 'Role unassigned from jail configuration').catch(() => null);
      }
      for (const role of rolesToDelete) await role.delete('Role removed from jail configuration by an administrator');
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, 'Roles removed', `**Roles:** ${removable.map(id => `<@&${id}>`).join(', ')}\n**Discord roles deleted:** ${interaction.customId === 'jconfig:remove_delete' ? 'Yes, where permitted' : 'No'}`);
      pendingRoleRemovals.delete(key);
      return interaction.update({ content: `Removed ${removable.length} role(s) from jail configuration${interaction.customId === 'jconfig:remove_delete' ? ' and deleted the Discord roles where permitted' : ''}.`, embeds: [], components: [] });
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
