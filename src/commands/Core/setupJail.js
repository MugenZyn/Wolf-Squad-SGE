import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ChannelSelectMenuBuilder, PermissionFlagsBits, RoleSelectMenuBuilder, SlashCommandBuilder, MessageFlags, StringSelectMenuBuilder } from 'discord.js';
import { updateGuildConfig } from '../../services/config/guildConfig.js';

const ID_PATTERN = /^\d{17,20}$/;
const JAIL_ALLOW = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];

export default {
  data: new SlashCommandBuilder().setName('setup-jail').setDescription('Open the interactive jail setup panel.').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.guild) return interaction.reply({ content: 'This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { getGuildConfig } = await import('../../services/config/guildConfig.js');
    const current = await getGuildConfig(interaction.client, interaction.guild.id);
    const existingJail = current?.jail ?? {};
    if (hasExistingJailSetup(existingJail)) {
      return interaction.editReply({
        content: 'A jail system is already configured in this server. Use /config to manage the existing jail system instead of setting up another one.',
        embeds: [],
        components: [],
      });
    }
    const allChannels = await interaction.guild.channels.fetch();
    const channelChoices = {
      categoryId: allChannels
        .filter(channel => channel.type === ChannelType.GuildCategory)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(channel => ({ id: channel.id, name: channel.name })),
      jailChannelId: allChannels
        .filter(channel => channel.type === ChannelType.GuildText)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(channel => ({ id: channel.id, name: channel.name, parentName: channel.parent?.name ?? null })),
    };
    const token = `${interaction.guild.id}-${interaction.user.id}-${Date.now()}`;
    setupSessions.set(token, { guildId: interaction.guild.id, userId: interaction.user.id, page: 'roles', pages: {}, channelChoices, selections: { managePermissions: true }, existing: {
      jailRoleIds: (existingJail.roles ?? []).map(item => item?.roleId).filter(Boolean),
      lawyerRoleId: existingJail.lawyerRoleId ?? null,
      policemanRoleIds: existingJail.policemanRoleIds ?? [],
      categoryId: existingJail.categoryId ?? null,
      jailChannelId: existingJail.channelId ?? null,
      evidenceForumId: existingJail.evidenceForumId ?? null,
      actionLogChannelId: existingJail.actionLogChannelId ?? null,
    } });
    const timer = setTimeout(() => setupSessions.delete(token), 15 * 60 * 1000);
    timer.unref?.();
    return interaction.editReply({ content: '', embeds: [setupPanelEmbed(setupSessions.get(token))], components: buildSetupPanel(token, 'roles') });
  },

  async handleComponent(interaction, client) {
    const [, token, field, pageValue] = interaction.customId.split(':');
    const session = setupSessions.get(token);
    if (!session || session.userId !== interaction.user.id || session.guildId !== interaction.guildId) {
      await interaction.reply({ content: 'This setup panel expired. Run /setup-jail again.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (interaction.isButton() && field === 'next') {
      session.page = 'channels';
      await interaction.update({ content: '', embeds: [setupPanelEmbed(session)], components: buildSetupPanel(token, 'channels') });
      return true;
    }
    if (interaction.isButton() && field === 'back') {
      session.page = 'roles';
      await interaction.update({ content: '', embeds: [setupPanelEmbed(session)], components: buildSetupPanel(token, 'roles') });
      return true;
    }
    if (interaction.isButton() && field === 'permissions') {
      if (session.selections.managePermissions !== false && !hasCompleteExistingSelections(session)) {
        await interaction.reply({
          content: 'To skip permission edits, explicitly select an existing category, default jail channel, evidence forum, at least one jail role, and a lawyer role first.',
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      session.selections.managePermissions = session.selections.managePermissions === false;
      await interaction.update({ content: '', embeds: [setupPanelEmbed(session)], components: buildSetupPanel(token, 'channels') });
      return true;
    }
    if (interaction.isButton() && field === 'save') {
      if (session.selections.managePermissions === false && !hasCompleteExistingSelections(session)) {
        session.selections.managePermissions = true;
        await interaction.update({
          content: '',
          embeds: [setupPanelEmbed(session)],
          components: buildSetupPanel(token, 'channels'),
        });
        await interaction.followUp({
          content: 'Permission edits were turned back on because skipping requires an explicitly selected existing category, default jail channel, evidence forum, at least one jail role, and lawyer role.',
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      setupSessions.delete(token);
      await interaction.deferUpdate();
      await interaction.editReply({ content: 'CREATING...', embeds: [], components: [] });
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      await configureJail(interaction, await getGuildConfig(client, interaction.guildId), { ...session.existing, ...session.selections });
      return true;
    }
    if (interaction.isStringSelectMenu() && (field === 'categoryId' || field === 'jailChannelId')) {
      const choices = session.channelChoices?.[field] ?? [];
      const currentPage = Number.parseInt(pageValue, 10) || 0;
      const selected = interaction.values[0];
      if (selected === '__previous_page__' || selected === '__next_page__') {
        const pageCount = Math.max(1, Math.ceil(choices.length / SETUP_CHANNEL_PAGE_SIZE));
        session.pages[field] = Math.min(Math.max(0, currentPage + (selected === '__previous_page__' ? -1 : 1)), pageCount - 1);
      } else if (selected === '__clear__') {
        delete session.selections[field];
      } else if (choices.some(channel => channel.id === selected)) {
        session.selections[field] = selected;
      }
      const skipWasEnabled = session.selections.managePermissions === false;
      if (skipWasEnabled && !hasCompleteExistingSelections(session)) session.selections.managePermissions = true;
      await interaction.update({ content: '', embeds: [setupPanelEmbed(session)], components: buildSetupPanel(token, session.page) });
      if (skipWasEnabled && session.selections.managePermissions !== false) {
        await interaction.followUp({
          content: 'Permission edits were turned back on because one of the required existing selections was removed.',
          flags: MessageFlags.Ephemeral,
        });
      }
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
        else delete session.selections.categoryId;
      } else if (field === 'jailChannelId' && interaction.isChannelSelectMenu()) {
        if (interaction.values[0]) session.selections.jailChannelId = interaction.values[0];
        else delete session.selections.jailChannelId;
      } else if (field === 'evidenceForumId' && interaction.isChannelSelectMenu()) {
        if (interaction.values[0]) session.selections.evidenceForumId = interaction.values[0];
        else delete session.selections.evidenceForumId;
      } else if (field === 'actionLogChannelId' && interaction.isChannelSelectMenu()) {
        session.selections.actionLogChannelId = interaction.values[0] || null;
      }
      const skipWasEnabled = session.selections.managePermissions === false;
      if (skipWasEnabled && !hasCompleteExistingSelections(session)) session.selections.managePermissions = true;
      await interaction.update({ content: '', embeds: [setupPanelEmbed(session)], components: buildSetupPanel(token, session.page) });
      if (skipWasEnabled && session.selections.managePermissions !== false) {
        await interaction.followUp({
          content: 'Permission edits were turned back on because one of the required existing selections was removed.',
          flags: MessageFlags.Ephemeral,
        });
      }
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
    const managePermissions = selections.managePermissions ?? true;
    if (!managePermissions && !(
      selections.categoryId &&
      selections.jailChannelId &&
      selections.evidenceForumId &&
      Array.isArray(selections.jailRoleIds) &&
      selections.jailRoleIds.length > 0 &&
      selections.lawyerRoleId
    )) {
      return interaction.editReply('Permission edits cannot be skipped unless you explicitly select an existing category, default jail channel, evidence forum, at least one jail role, and lawyer role.');
    }
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
    const announcementChannelId = Object.hasOwn(selections, 'actionLogChannelId')
      ? selections.actionLogChannelId
      : (existingJail.actionLogChannelId ?? null);
    const forumName = 'jail-evidence';

    if ((lawyerRoleId && !ID_PATTERN.test(lawyerRoleId)) || (categoryId && !ID_PATTERN.test(categoryId)) || (existingChannelId && !ID_PATTERN.test(existingChannelId)) || (forumId && !ID_PATTERN.test(forumId)) || (announcementChannelId && !ID_PATTERN.test(announcementChannelId))) return interaction.editReply('One of the supplied IDs is invalid.');

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
    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels) || !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.editReply('I need Manage Channels and Manage Roles permissions to create any missing jail resources and configure roles.');
    if (uniqueJailRoles.some(role => botMember.roles.highest.comparePositionTo(role) <= 0) || (managePermissions && lawyerRole && botMember.roles.highest.comparePositionTo(lawyerRole) <= 0)) return interaction.editReply('My highest role must be above all selected jail roles and, when I manage permissions, the lawyer role.');

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
    if (managePermissions && category && jailChannel && jailChannel.parentId !== category.id) {
      await jailChannel.setParent(category.id, { lockPermissions: false, reason });
    }
    if (managePermissions) {
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
    }

    const existingRoleIds = new Set((existingJail.roles ?? []).map(item => item?.roleId).filter(Boolean));
    const combinedRoleIds = new Set([...existingRoleIds, ...uniqueJailRoles.map(role => role.id)]);
    if (combinedRoleIds.size > 25) return interaction.editReply('Discord role selectors support up to 25 jail roles. Remove some before adding more.');

    const botRoleIds = new Set(botMember.roles.cache.keys());
    const categoryOverwrites = managePermissions && category
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
        ...(managePermissions ? {
          permissionOverwrites: [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            ...categoryOverwrites,
            ...uniqueJailRoles.map(role => ({ id: role.id, allow: JAIL_ALLOW, deny: [PermissionFlagsBits.EmbedLinks] })),
            ...(lawyerRole ? [{ id: lawyerRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }] : []),
            { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          ],
        } : {}),
      });
    }

    if (managePermissions) {
      await jailChannel.permissionOverwrites.edit(guild.id, { ViewChannel: false }, reason);
      for (const role of uniqueJailRoles) await jailChannel.permissionOverwrites.edit(role.id, { allow: JAIL_ALLOW, deny: [PermissionFlagsBits.EmbedLinks] }, reason);
      if (lawyerRole) await jailChannel.permissionOverwrites.edit(lawyerRole.id, { ViewChannel: true, ReadMessageHistory: true }, reason);
    }

    let announcementChannel = announcementChannelId ? await guild.channels.fetch(announcementChannelId).catch(() => null) : null;
    if (announcementChannelId && announcementChannel?.type !== ChannelType.GuildText) {
      return interaction.editReply('announcement_channel_id must identify an existing text channel.');
    }

    let evidenceForum = forumId ? await guild.channels.fetch(forumId).catch(() => null) : null;
    if (forumId && evidenceForum?.type !== ChannelType.GuildForum) return interaction.editReply('evidence_forum_id must identify an existing forum channel.');
    if (!evidenceForum) {
      evidenceForum = await guild.channels.create({
        name: forumName, type: ChannelType.GuildForum,
        ...(category ? { parent: category.id } : {}),
        reason,
        ...(managePermissions ? {
          permissionOverwrites: [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads] },
            ...(guildConfig?.modRole ? [{ id: guildConfig.modRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }] : []),
            ...(guildConfig?.adminRole ? [{ id: guildConfig.adminRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }] : []),
            ...(lawyerRole ? [{ id: lawyerRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }] : []),
          ],
        } : {}),
      });
    } 
    if (managePermissions) {
      // A lawyer-role change only touches that role's explicit access on these three resources.
      if (previousLawyerRoleId && previousLawyerRoleId !== lawyerRole.id) {
        for (const resource of [category, jailChannel, evidenceForum].filter(Boolean)) {
          await resource.permissionOverwrites.delete(previousLawyerRoleId, reason).catch(() => null);
        }
      }
      if (category) await category.permissionOverwrites.edit(lawyerRole.id, { ViewChannel: true, ReadMessageHistory: true }, reason);
      await jailChannel.permissionOverwrites.edit(lawyerRole.id, { ViewChannel: true, ReadMessageHistory: true }, reason);
      await evidenceForum.permissionOverwrites.edit(lawyerRole.id, { ViewChannel: true, ReadMessageHistory: true }, reason);
    }

    let logsChannel = null;
    const existingLogsId = guildConfig?.jail?.logsChannelId;
    if (existingLogsId) logsChannel = await guild.channels.fetch(existingLogsId).catch(() => null);
    if (!logsChannel || logsChannel.type !== ChannelType.GuildText) {
      logsChannel = await guild.channels.create({
        name: 'jail-logs',
        type: ChannelType.GuildText,
        ...(category ? { parent: category.id } : {}),
        reason: 'Create default jail command logs channel',
        ...(managePermissions ? {
          permissionOverwrites: [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          ],
        } : {}),
      });
    }

    if (managePermissions) {
      // Touch only the server default and bot access; preserve every other existing log overwrite.
      await logsChannel.permissionOverwrites.edit(guild.id, { ViewChannel: false }, 'Restrict default jail log visibility');
      await logsChannel.permissionOverwrites.edit(botMember.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }, 'Ensure bot can use jail logs');
    }

    const roles = Array.isArray(existingJail.roles) ? [...existingJail.roles] : [];
    for (const role of uniqueJailRoles) {
      const index = roles.findIndex(item => item?.roleId === role.id);
      const entry = { roleId: role.id, channelId: jailChannel.id };
      if (index >= 0) roles[index] = entry;
      else roles.push(entry);
    }
    await updateGuildConfig(interaction.client, guild.id, {
      jail: { ...existingJail, channelId: jailChannel.id, categoryId: category?.id ?? null, evidenceForumId: evidenceForum.id, logsChannelId: logsChannel.id, actionLogChannelId: announcementChannel?.id ?? null, lawyerRoleId, policemanRoleIds: selections.policemanRoleIds ?? existingJail.policemanRoleIds ?? [], roles }
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

    return interaction.editReply(managePermissions
      ? 'Jail system setup completed. The bot configured the jail channel permissions.'
      : 'Jail system setup completed. Existing channel permissions and channel placement were left unchanged. Make sure the bot already has access to the jail, evidence, and logs channels.');
}

const setupSessions = new Map();

function setupPanelEmbed(session) {
  const s = session.selections;
  const jailRoleIds = s.jailRoleIds?.length ? s.jailRoleIds : session.existing.jailRoleIds;
  const policemanRoleIds = s.policemanRoleIds ?? session.existing.policemanRoleIds ?? [];
  const lawyerRoleId = s.lawyerRoleId ?? session.existing.lawyerRoleId;
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('Jail setup')
    .setDescription(session.page === 'channels'
      ? (session.selections.managePermissions === false
        ? 'Choose your existing jail channels. Permission edits are disabled: existing channel permissions and channel placement will be left unchanged. Make sure the bot already has access.'
        : 'Choose the channels used by the jail system. Leave a selection empty to create it automatically. The announcement channel is optional. Skip permission edits is available only after explicitly selecting an existing category, default jail channel, evidence forum, at least one jail role, and lawyer role.')
      : 'Choose the roles used by the jail system. Jail and lawyer roles are created automatically if left empty.')
    .addFields(
      { name: 'Jail roles', value: jailRoleIds.length ? jailRoleIds.map(id => `<@&${id}>`).join(', ') : 'Automatic (SGE - JAIL)', inline: false },
      { name: 'Lawyer role', value: lawyerRoleId ? `<@&${lawyerRoleId}>` : 'Automatic (SGE - LAWYER)', inline: true },
      { name: 'Policeman roles', value: policemanRoleIds.length ? policemanRoleIds.map(id => `<@&${id}>`).join(', ') : 'None', inline: true },
      { name: 'Category', value: s.categoryId ? `<#${s.categoryId}>` : 'Create automatically (JAIL)', inline: true },
      { name: 'Default jail channel', value: s.jailChannelId ? `<#${s.jailChannelId}>` : 'Create automatically (jail)', inline: true },
      { name: 'Evidence forum', value: s.evidenceForumId ? `<#${s.evidenceForumId}>` : 'Create automatically (jail-evidence)', inline: true },
      { name: 'Announcement channel', value: (s.actionLogChannelId ?? session.existing.actionLogChannelId) ? `<#${s.actionLogChannelId ?? session.existing.actionLogChannelId}>` : 'Optional (not set)', inline: true },
      ...(session.page === 'channels' ? [{ name: 'Channel permissions', value: s.managePermissions === false ? 'Leave existing permissions unchanged' : 'Bot configures jail permissions', inline: false }] : []),
      { name: 'Current page', value: session.page === 'channels' ? 'Channels' : 'Roles', inline: true },
    );
}

const SETUP_CHANNEL_PAGE_SIZE = 22;

function setupPaginatedChannelMenu(token, session, field, placeholder) {
  const choices = session?.channelChoices?.[field] ?? [];
  const pageCount = Math.max(1, Math.ceil(choices.length / SETUP_CHANNEL_PAGE_SIZE));
  const page = Math.min(Math.max(0, session?.pages?.[field] ?? 0), pageCount - 1);
  const options = choices
    .slice(page * SETUP_CHANNEL_PAGE_SIZE, (page + 1) * SETUP_CHANNEL_PAGE_SIZE)
    .map(channel => ({
      label: channel.name.slice(0, 100),
      value: channel.id,
      description: channel.parentName ? `In ${channel.parentName}`.slice(0, 100) : 'Server channel',
    }));

  if (choices.length) {
    options.push({ label: 'Clear selection (create automatically)', value: '__clear__', description: 'Leave this selection empty' });
    if (page > 0) options.push({ label: '← Previous page', value: '__previous_page__', description: 'Show the previous set of channels' });
    if (page < pageCount - 1) options.push({ label: 'Next page →', value: '__next_page__', description: 'Show more channels' });
  } else {
    options.push({ label: 'No matching channels available', value: '__none__', description: 'Create this resource automatically', disabled: true });
  }

  return new StringSelectMenuBuilder()
    .setCustomId(`jsetup:${token}:${field}:${page}`)
    .setPlaceholder(`${placeholder} (page ${page + 1}/${pageCount})`)
    .setMinValues(choices.length ? 1 : 0)
    .setMaxValues(1)
    .addOptions(options);
}

function buildSetupPanel(token, page = 'roles') {
  const session = setupSessions.get(token);
  if (page === 'channels') {
    return [
      new ActionRowBuilder().addComponents(setupPaginatedChannelMenu(token, session, 'categoryId', 'Select jail category')),
      new ActionRowBuilder().addComponents(setupPaginatedChannelMenu(token, session, 'jailChannelId', 'Select default jail channel')),
      new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`jsetup:${token}:evidenceForumId`).setPlaceholder('Select jail evidence forum').setChannelTypes(ChannelType.GuildForum).setMinValues(0).setMaxValues(1)),
      new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`jsetup:${token}:actionLogChannelId`).setPlaceholder('Select announcement channel (optional)').setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1)),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`jsetup:${token}:back`).setLabel('Back').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`jsetup:${token}:permissions`)
          .setLabel(session?.selections?.managePermissions === false ? 'Enable permission edits' : 'Skip permission edits')
          .setStyle(session?.selections?.managePermissions === false ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setDisabled(session?.selections?.managePermissions !== false && !hasCompleteExistingSelections(session)),
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

function hasCompleteExistingSelections(session) {
  const selections = session?.selections ?? {};
  return Boolean(
    selections.categoryId &&
    selections.jailChannelId &&
    selections.evidenceForumId &&
    Array.isArray(selections.jailRoleIds) &&
    selections.jailRoleIds.length > 0 &&
    selections.lawyerRoleId
  );
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
