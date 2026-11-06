import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ChannelSelectMenuBuilder, PermissionFlagsBits, RoleSelectMenuBuilder, SlashCommandBuilder, MessageFlags } from 'discord.js';
import { updateGuildConfig } from '../../services/config/guildConfig.js';

const ID_PATTERN = /^\d{17,20}$/;
const JAIL_ALLOW = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];

export default {
  data: new SlashCommandBuilder().setName('setup-jail').setDescription('Open the interactive jail setup panel.').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.guild) return interaction.reply({ content: 'This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
    const { getGuildConfig } = await import('../../services/config/guildConfig.js');
    const current = await getGuildConfig(interaction.client, interaction.guild.id);
    const existingJail = current?.jail ?? {};
    if (hasExistingJailSetup(existingJail)) {
      return interaction.reply({
        content: 'A jail system is already configured in this server. Use /config to manage the existing jail system instead of setting up another one.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const token = `${interaction.guild.id}-${interaction.user.id}-${Date.now()}`;
    setupSessions.set(token, { guildId: interaction.guild.id, userId: interaction.user.id, page: 'roles', selections: {}, existing: {
      jailRoleIds: (existingJail.roles ?? []).map(item => item?.roleId).filter(Boolean),
      lawyerRoleId: existingJail.lawyerRoleId ?? null,
      policemanRoleIds: existingJail.policemanRoleIds ?? [],
      categoryId: existingJail.categoryId ?? null,
      jailChannelId: existingJail.channelId ?? null,
      evidenceForumId: existingJail.evidenceForumId ?? null,
    } });
    const timer = setTimeout(() => setupSessions.delete(token), 15 * 60 * 1000);
    timer.unref?.();
    return interaction.reply({ content: setupPanelText(setupSessions.get(token)), components: buildSetupPanel(token, 'roles'), flags: MessageFlags.Ephemeral });
  },

  async handleComponent(interaction, client) {
    const [, token, field] = interaction.customId.split(':');
    const session = setupSessions.get(token);
    if (!session || session.userId !== interaction.user.id || session.guildId !== interaction.guildId) {
      await interaction.reply({ content: 'This setup panel expired. Run /setup-jail again.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (interaction.isButton() && field === 'next') {
      session.page = 'channels';
      await interaction.update({ content: setupPanelText(session), components: buildSetupPanel(token, 'channels') });
      return true;
    }
    if (interaction.isButton() && field === 'back') {
      session.page = 'roles';
      await interaction.update({ content: setupPanelText(session), components: buildSetupPanel(token, 'roles') });
      return true;
    }
    if (interaction.isButton() && field === 'save') {
      setupSessions.delete(token);
      await interaction.deferUpdate();
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      await configureJail(interaction, await getGuildConfig(client, interaction.guildId), { ...session.existing, ...session.selections });
      return true;
    }
    if (interaction.isRoleSelectMenu() || interaction.isChannelSelectMenu()) {
      if (field === 'jailRoleIds' && interaction.isRoleSelectMenu()) {
        session.selections.jailRoleIds = interaction.values;
      } else if (field === 'policemanRoleIds' && interaction.isRoleSelectMenu()) {
        session.selections.policemanRoleIds = interaction.values;
      } else if (field === 'lawyerRoleId' && interaction.isRoleSelectMenu()) {
        if (interaction.values[0]) session.selections.lawyerRoleId = interaction.values[0];
        else delete session.selections.lawyerRoleId;
      } else if (field === 'categoryId' && interaction.isChannelSelectMenu()) {
        if (interaction.values[0]) session.selections.categoryId = interaction.values[0];
      } else if (field === 'jailChannelId' && interaction.isChannelSelectMenu()) {
        if (interaction.values[0]) session.selections.jailChannelId = interaction.values[0];
      } else if (field === 'evidenceForumId' && interaction.isChannelSelectMenu()) {
        if (interaction.values[0]) session.selections.evidenceForumId = interaction.values[0];
      }
      await interaction.update({ content: setupPanelText(session), components: buildSetupPanel(token, session.page) });
      return true;
    }
    return false;
  },
};

async function configureJail(interaction, guildConfig, selections = {}) {
    if (!interaction.inGuild() || !interaction.guild) return interaction.reply({ content: 'This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { guild, user } = interaction;
    const existingJail = guildConfig?.jail ?? {};
    if (hasExistingJailSetup(existingJail)) {
      return interaction.editReply('A jail system is already configured in this server. Use /config to manage the existing jail system instead of setting up another one.');
    }
    const oldJailRoleIds = (existingJail.roles ?? []).map(item => item?.roleId).filter(Boolean);
    const reason = `Jail setup requested by ${user.tag} (${user.id})`;
    let jailRoleIds = selections.jailRoleIds?.length ? selections.jailRoleIds : oldJailRoleIds;
    await guild.roles.fetch();
    if (!jailRoleIds.length) {
      const defaultRole = guild.roles.cache.find(role => role.name === 'SGE - JAIL')
        || await guild.roles.create({ name: 'SGE - JAIL', reason });
      jailRoleIds = [defaultRole.id];
    }
    const jailRoles = await Promise.all(jailRoleIds.map(id => guild.roles.fetch(id).catch(() => null)));
    if (jailRoles.some(role => !role)) return interaction.editReply('One or more selected jail roles could not be found.');
    const uniqueJailRoles = [...new Map(jailRoles.map(role => [role.id, role])).values()];
    let lawyerRoleId = selections.lawyerRoleId || existingJail.lawyerRoleId || null;
    const previousLawyerRoleId = existingJail.lawyerRoleId || null;
    const categoryId = selections.categoryId || existingJail.categoryId || null;
    const existingChannelId = selections.jailChannelId || existingJail.channelId || null;
    const requestedChannelName = null;
    const categoryName = null;
    const forumId = selections.evidenceForumId || existingJail.evidenceForumId || null;
    const forumName = 'jail-evidence';

    if ((lawyerRoleId && !ID_PATTERN.test(lawyerRoleId)) || (categoryId && !ID_PATTERN.test(categoryId)) || (existingChannelId && !ID_PATTERN.test(existingChannelId)) || (forumId && !ID_PATTERN.test(forumId))) return interaction.editReply('One of the supplied IDs is invalid.');

    const botMember = guild.members.me ?? await guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.editReply('I need Manage Roles permission to create or configure the jail roles.');
    if (uniqueJailRoles.some(role => role.guild.id !== guild.id || role.id === guild.id || role.permissions.has(PermissionFlagsBits.Administrator))) return interaction.editReply('Jail roles must be server roles, cannot be @everyone, and cannot have Administrator permission.');
    let lawyerRole = lawyerRoleId ? await guild.roles.fetch(lawyerRoleId).catch(() => null) : null;
    if (!lawyerRole) {
      await guild.roles.fetch();
      lawyerRole = guild.roles.cache.find(role => role.name === 'SGE - LAWYER') || await guild.roles.create({ name: 'SGE - LAWYER', reason });
      lawyerRoleId = lawyerRole.id;
    }
    if (lawyerRole.id === guild.id) return interaction.editReply('I could not use @everyone as the lawyer role.');
    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels) || !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.editReply('I need Manage Channels and Manage Roles permissions.');
    if (uniqueJailRoles.some(role => botMember.roles.highest.comparePositionTo(role) <= 0) || (lawyerRole && botMember.roles.highest.comparePositionTo(lawyerRole) <= 0)) return interaction.editReply('My highest role must be above all selected roles.');

    let jailChannel = existingChannelId ? await guild.channels.fetch(existingChannelId).catch(() => null) : null;
    if (existingChannelId && jailChannel?.type !== ChannelType.GuildText) return interaction.editReply('jail_channel_id must identify an existing text channel.');
    let category = null;
    if (categoryId) {
      category = await guild.channels.fetch(categoryId).catch(() => null);
      if (category?.type !== ChannelType.GuildCategory) return interaction.editReply('category_id must identify an existing category.');
    } else if (jailChannel?.parentId) {
      category = await guild.channels.fetch(jailChannel.parentId).catch(() => null);
    } else if (!jailChannel) {
      category = await guild.channels.create({ name: categoryName || 'JAIL', type: ChannelType.GuildCategory, reason });
    }
    if (category && jailChannel && jailChannel.parentId !== category.id) {
      await jailChannel.setParent(category.id, { lockPermissions: false, reason });
    }
    // Apply permissions only to the jail role selected for this setup.
    // Other configured jail roles and their permissions remain untouched.
    const allGuildChannels = await guild.channels.fetch();
    // Hide every other category from members with the current jail role.
    // This is applied only when /setup-jail is explicitly run; later staff edits remain untouched.
    const otherCategories = allGuildChannels.filter(channel =>
      channel.type === ChannelType.GuildCategory && channel.id !== category?.id
    );
    for (const otherCategory of otherCategories.values()) {
      for (const role of uniqueJailRoles) await otherCategory.permissionOverwrites.edit(role.id, { ViewChannel: false }, reason);
    }
    if (category) for (const role of uniqueJailRoles) await category.permissionOverwrites.edit(role.id, { ViewChannel: true }, reason);

    const existingRoleIds = new Set((existingJail.roles ?? []).map(item => item?.roleId).filter(Boolean));
    const combinedRoleIds = new Set([...existingRoleIds, ...uniqueJailRoles.map(role => role.id)]);
    if (combinedRoleIds.size > 25) return interaction.editReply('Discord role selectors support up to 25 jail roles. Remove some before adding more.');

    const botRoleIds = new Set(botMember.roles.cache.keys());
    const categoryOverwrites = category
      ? [...category.permissionOverwrites.cache.values()]
          .filter(overwrite => ![guild.id, ...uniqueJailRoles.map(role => role.id), lawyerRoleId, botMember.id].includes(overwrite.id) && !botRoleIds.has(overwrite.id))
          .map(overwrite => ({ id: overwrite.id, deny: [PermissionFlagsBits.ViewChannel] }))
      : [];
    if (!jailChannel) {
      jailChannel = await guild.channels.create({
        name: (requestedChannelName || 'jail').toLowerCase().replace(/\s+/g, '-'),
        type: ChannelType.GuildText,
        ...(category ? { parent: category.id } : {}),
        reason,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          ...categoryOverwrites,
          ...uniqueJailRoles.map(role => ({ id: role.id, allow: JAIL_ALLOW, deny: [PermissionFlagsBits.EmbedLinks] })),
          ...(lawyerRole ? [{ id: lawyerRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }] : []),
          { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ],
      });
    }

    await jailChannel.permissionOverwrites.edit(guild.id, { ViewChannel: false }, reason);
    for (const role of uniqueJailRoles) await jailChannel.permissionOverwrites.edit(role.id, { allow: JAIL_ALLOW, deny: [PermissionFlagsBits.EmbedLinks] }, reason);
    if (lawyerRole) await jailChannel.permissionOverwrites.edit(lawyerRole.id, { ViewChannel: true, ReadMessageHistory: true }, reason);

    let evidenceForum = forumId ? await guild.channels.fetch(forumId).catch(() => null) : null;
    if (forumId && evidenceForum?.type !== ChannelType.GuildForum) return interaction.editReply('evidence_forum_id must identify an existing forum channel.');
    if (!evidenceForum) {
      evidenceForum = await guild.channels.create({
        name: forumName, type: ChannelType.GuildForum,
        ...(category ? { parent: category.id } : {}),
        reason,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads] },
          ...(guildConfig?.modRole ? [{ id: guildConfig.modRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }] : []),
          ...(guildConfig?.adminRole ? [{ id: guildConfig.adminRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }] : []),
          ...(lawyerRole ? [{ id: lawyerRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }] : []),
        ],
      });
    } 
    // A lawyer-role change only touches that role's explicit access on these three resources.
    if (previousLawyerRoleId && previousLawyerRoleId !== lawyerRole.id) {
      for (const resource of [category, jailChannel, evidenceForum].filter(Boolean)) {
        await resource.permissionOverwrites.delete(previousLawyerRoleId, reason).catch(() => null);
      }
    }
    if (category) await category.permissionOverwrites.edit(lawyerRole.id, { ViewChannel: true, ReadMessageHistory: true }, reason);
    await jailChannel.permissionOverwrites.edit(lawyerRole.id, { ViewChannel: true, ReadMessageHistory: true }, reason);
    await evidenceForum.permissionOverwrites.edit(lawyerRole.id, { ViewChannel: true, ReadMessageHistory: true }, reason);

    let logsChannel = null;
    const existingLogsId = guildConfig?.jail?.logsChannelId;
    if (existingLogsId) logsChannel = await guild.channels.fetch(existingLogsId).catch(() => null);
    if (!logsChannel || logsChannel.type !== ChannelType.GuildText) {
      logsChannel = await guild.channels.create({
        name: 'jail-logs',
        type: ChannelType.GuildText,
        ...(category ? { parent: category.id } : {}),
        reason: 'Create default jail command logs channel',
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ],
      });
    }

    // Touch only the server default and bot access; preserve every other existing log overwrite.
    await logsChannel.permissionOverwrites.edit(guild.id, { ViewChannel: false }, 'Restrict default jail log visibility');
    await logsChannel.permissionOverwrites.edit(botMember.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }, 'Ensure bot can use jail logs');

    const roles = Array.isArray(existingJail.roles) ? [...existingJail.roles] : [];
    for (const role of uniqueJailRoles) {
      const index = roles.findIndex(item => item?.roleId === role.id);
      const entry = { roleId: role.id, channelId: jailChannel.id };
      if (index >= 0) roles[index] = entry;
      else roles.push(entry);
    }
    await updateGuildConfig(interaction.client, guild.id, {
      jail: { ...existingJail, channelId: jailChannel.id, categoryId: category?.id ?? null, evidenceForumId: evidenceForum.id, logsChannelId: logsChannel.id, lawyerRoleId, policemanRoleIds: selections.policemanRoleIds ?? existingJail.policemanRoleIds ?? [], roles }
    });
    await logsChannel.send({
      embeds: [{
        color: 0x2B8A3E,
        title: 'Command executed: /setup-jail',
        description: `**Staff:** <@${user.id}> (${user.id})\n**Jail roles:** ${uniqueJailRoles.map(role => `<@&${role.id}>`).join(', ')}\n**Jail channel:** <#${jailChannel.id}>\n**Evidence forum:** <#${evidenceForum.id}>\n**Logs channel:** <#${logsChannel.id}>`,
        timestamp: new Date().toISOString(),
      }],
      allowedMentions: { parse: [] },
    }).catch(() => null);

    return interaction.editReply('Jail system setup completed.');
}

const setupSessions = new Map();

function setupPanelText(session) {
  const s = session.selections;
  const jailRoleIds = s.jailRoleIds?.length ? s.jailRoleIds : session.existing.jailRoleIds;
  const policemanRoleIds = s.policemanRoleIds ?? session.existing.policemanRoleIds ?? [];
  const lawyerRoleId = s.lawyerRoleId ?? session.existing.lawyerRoleId;
  return [
    '**Jail setup**',
    `Jail roles: ${jailRoleIds.length ? jailRoleIds.map(id => `<@&${id}>`).join(', ') : 'Automatic (SGE - JAIL)'}`,
    `Lawyer role: ${lawyerRoleId ? `<@&${lawyerRoleId}>` : 'Automatic (SGE - LAWYER)'}`,
    `Policeman roles: ${policemanRoleIds.length ? policemanRoleIds.map(id => `<@&${id}>`).join(', ') : 'None'}`,
    `Category: ${s.categoryId ? `<#${s.categoryId}>` : 'Automatic (JAIL)'}`,
    `Jail channel: ${s.jailChannelId ? `<#${s.jailChannelId}>` : 'Automatic (jail)'}`,
    `Evidence forum: ${s.evidenceForumId ? `<#${s.evidenceForumId}>` : 'Automatic (jail-evidence)'}`,
    `Page: ${session.page === 'channels' ? 'Channels' : 'Roles'}`,
  ].join('\\n');
}

function buildSetupPanel(token, page = 'roles') {
  if (page === 'channels') {
    return [
      new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`jsetup:${token}:categoryId`).setPlaceholder('Select jail category').setChannelTypes(ChannelType.GuildCategory).setMinValues(0).setMaxValues(1)),
      new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`jsetup:${token}:jailChannelId`).setPlaceholder('Select default jail channel').setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1)),
      new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`jsetup:${token}:evidenceForumId`).setPlaceholder('Select jail evidence forum').setChannelTypes(ChannelType.GuildForum).setMinValues(0).setMaxValues(1)),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`jsetup:${token}:back`).setLabel('Back').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`jsetup:${token}:save`).setLabel('Save setup').setStyle(ButtonStyle.Success),
      ),
    ];
  }
  return [
    new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`jsetup:${token}:jailRoleIds`).setPlaceholder('Select jail roles').setMinValues(0).setMaxValues(25)),
    new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`jsetup:${token}:lawyerRoleId`).setPlaceholder('Select lawyer role').setMinValues(0).setMaxValues(1)),
    new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`jsetup:${token}:policemanRoleIds`).setPlaceholder('Select policeman roles (optional)').setMinValues(0).setMaxValues(25)),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`jsetup:${token}:next`).setLabel('Next: Channels').setStyle(ButtonStyle.Primary)),
  ];
}

function hasExistingJailSetup(jail = {}) {
  return Boolean(
    (Array.isArray(jail.roles) && jail.roles.some(item => item?.roleId)) ||
    jail.channelId ||
    jail.categoryId ||
    jail.evidenceForumId ||
    jail.logsChannelId ||
    jail.lawyerRoleId
  );
}
