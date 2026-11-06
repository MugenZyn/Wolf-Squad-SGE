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
];

const pendingRoleRemovals = new Map();

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
      { name: 'Evidence messages', value: String(jail.evidenceMessageCount ?? 5), inline: true },
      { name: 'Default evidence note', value: jail.defaultMessage ? jail.defaultMessage.slice(0, 1000) : 'None', inline: false },
      { name: 'Jail roles', value: Array.isArray(jail.roles) && jail.roles.length ? jail.roles.map(item => `<@&${item.roleId}>`).join(', ') : 'None configured', inline: false },
      { name: 'Jail role → channel', value: Array.isArray(jail.roles) && jail.roles.length ? jail.roles.map(item => ` <@&${item.roleId}> → ${(item.channelId || jail.channelId) ? `<#${item.channelId || jail.channelId}>` : 'No channel linked'}`).join('\n').slice(0, 1024) : 'None configured', inline: false },
      { name: 'Default jail channel', value: jail.channelId ? `<#${jail.channelId}>` : 'None configured', inline: true },
      { name: 'Jail category', value: jail.categoryId ? `<#${jail.categoryId}>` : 'None configured', inline: true },
      { name: 'Evidence forum', value: jail.evidenceForumId ? `<#${jail.evidenceForumId}>` : 'None configured', inline: true },
      { name: 'Logs channel', value: jail.logsChannelId ? `<#${jail.logsChannelId}>` : 'None configured', inline: true },
      { name: 'Lawyer role', value: jail.lawyerRoleId ? `<@&${jail.lawyerRoleId}>` : 'None configured', inline: true },
      { name: 'Policeman roles', value: Array.isArray(jail.policemanRoleIds) && jail.policemanRoleIds.length ? jail.policemanRoleIds.map(id => `<@&${id}>`).join(', ') : 'None configured', inline: false },
    );
  const menus = SETTINGS.map(setting => new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`jconfig:${setting.value}`)
      .setPlaceholder(`Change ${setting.label}`)
      .addOptions([{ label: setting.label, value: setting.value, description: setting.description }]),
  ));
  menus.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('jconfig:role_action')
      .setPlaceholder('Manage configured roles')
      .addOptions(
        { label: 'Add jail roles', value: 'add_jail_roles', description: 'Register existing server roles as jail roles' },
        { label: 'Set lawyer role', value: 'set_lawyer', description: 'Choose an existing server role as the lawyer role' },
        { label: 'Choose policeman roles', value: 'set_policeman', description: 'Select multiple roles; choose none to clear' },
        { label: 'Set a jail role channel', value: 'set_jail_channel', description: 'Choose which jail channel a specific jail role uses' },
        { label: 'Remove roles from jail configuration', value: 'remove_roles', description: 'Unassign jail, lawyer, or policeman roles' },
      ),
  ));
  return { embeds: [embed], components: menus, flags: MessageFlags.Ephemeral };
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
        ? { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }
        : { ViewChannel: false }, 'Update jail role channel from /config');
    }
  }
  await updateGuildConfig(client, interaction.guildId, { jail });
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
    return interaction.reply(panelPayload(guildConfig?.jail ?? {}));
  },

  async handleComponent(interaction, client) {
    if (interaction.customId === 'jconfig:channel_role' && interaction.isStringSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const roleId = interaction.values[0];
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
    if (interaction.customId === 'jconfig:add_jail_roles' && interaction.isRoleSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current?.jail ?? {}) };
      const existing = Array.isArray(jail.roles) ? [...jail.roles] : [];
      const selectedIds = [...new Set(interaction.values)].filter(id => id !== interaction.guildId);
      if (!selectedIds.length) return interaction.update({ content: 'No jail roles selected. Nothing was changed.', embeds: [], components: [] });
      const combined = new Set([...existing.map(item => item?.roleId).filter(Boolean), ...selectedIds]);
      if (combined.size > 25) return interaction.update({ content: 'You can configure up to 25 jail roles. Remove some before adding more.', embeds: [], components: [] });
      const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.update({ content: 'I need Manage Roles permission to configure jail roles.', embeds: [], components: [] });
      const roles = (await Promise.all(selectedIds.map(id => interaction.guild.roles.fetch(id).catch(() => null)))).filter(Boolean);
      if (roles.length !== selectedIds.length || roles.some(role => role.managed || role.permissions.has(PermissionFlagsBits.Administrator) || botMember.roles.highest.comparePositionTo(role) <= 0)) {
        return interaction.update({ content: 'One or more selected roles are missing, managed, have Administrator permission, or are above my highest role.', embeds: [], components: [] });
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
      for (const resourceId of [jail.categoryId, channelId, jail.evidenceForumId].filter(Boolean)) {
        const resource = await interaction.guild.channels.fetch(resourceId).catch(() => null);
        if (!resource?.permissionOverwrites) continue;
        for (const role of roles) {
          await resource.permissionOverwrites.edit(role.id, resourceId === channelId
            ? { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }
            : { ViewChannel: true, ReadMessageHistory: true }, 'Register jail role from /config');
        }
      }
      await updateGuildConfig(client, interaction.guildId, { jail });
      return interaction.update({ content: `Registered ${roles.length} jail role(s): ${roles.map(role => `<@&${role.id}>`).join(', ')}. They use the default jail channel ${channelId ? `<#${channelId}>` : '(not configured)'} unless assigned a role-specific channel.`, embeds: [], components: [] });
    }
    if (interaction.customId === 'jconfig:lawyer_role' && interaction.isRoleSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const roleId = interaction.values[0];
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current?.jail ?? {}) };
      const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.update({ content: 'I need Manage Roles permission to configure the lawyer role.', embeds: [], components: [] });
      const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
      if (!role || role.id === interaction.guildId || role.managed || botMember.roles.highest.comparePositionTo(role) <= 0) {
        return interaction.update({ content: 'Choose a valid, manageable server role below my highest role.', embeds: [], components: [] });
      }
      if (role.permissions.has(PermissionFlagsBits.Administrator)) return interaction.update({ content: 'The lawyer role cannot have Administrator permission.', embeds: [], components: [] });
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
      return interaction.update({ content: `Saved lawyer role: <@&${role.id}>. It can view the configured jail category, jail channel, and evidence forum.`, embeds: [], components: [] });
    }
    if (interaction.customId === 'jconfig:policeman_roles' && interaction.isRoleSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const roleIds = interaction.values;
      const jail = { ...(current.jail ?? {}), policemanRoleIds: roleIds };
      await updateGuildConfig(client, interaction.guildId, { jail });
      return interaction.update({ content: `Saved ${roleIds.length} policeman role(s): ${roleIds.length ? roleIds.map(id => `<@&${id}>`).join(', ') : 'None'}.`, embeds: [], components: [] });
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
