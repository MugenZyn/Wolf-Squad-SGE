import { ChannelType, PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from 'discord.js';
import { updateGuildConfig } from '../../services/config/guildConfig.js';

const ID_PATTERN = /^\d{17,20}$/;
const JAIL_ALLOW = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];

export default {
  data: new SlashCommandBuilder()
    .setName('setup-jail')
    .setDescription('Create or configure a jail channel and evidence forum.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('jail_role_id').setDescription('Role allowed to use the jail channel.').setRequired(true).setMinLength(17).setMaxLength(20))
    .addStringOption(o => o.setName('channel_name').setDescription('Name for a new jail channel.').setMaxLength(100))
    .addStringOption(o => o.setName('jail_channel_id').setDescription('Use an existing text channel as the jail channel.').setMinLength(17).setMaxLength(20))
    .addStringOption(o => o.setName('category_name').setDescription('Name for a new category (when creating a channel).').setMaxLength(100))
    .addStringOption(o => o.setName('category_id').setDescription('Existing category ID.').setMinLength(17).setMaxLength(20))
    .addStringOption(o => o.setName('lawyer_role_id').setDescription('Optional role allowed to view the jail category and evidence forum.').setMinLength(17).setMaxLength(20))
    .addStringOption(o => o.setName('evidence_forum_id').setDescription('Use an existing forum channel.').setMinLength(17).setMaxLength(20))
    .addStringOption(o => o.setName('evidence_forum_name').setDescription('Name for a new evidence forum.').setMaxLength(100)),

  async execute(interaction, guildConfig) {
    if (!interaction.inGuild() || !interaction.guild) return interaction.reply({ content: 'This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { guild, user } = interaction;
    const jailRoleId = interaction.options.getString('jail_role_id', true).trim();
    const lawyerRoleId = interaction.options.getString('lawyer_role_id')?.trim() || null;
    const categoryId = interaction.options.getString('category_id')?.trim();
    const existingChannelId = interaction.options.getString('jail_channel_id')?.trim();
    const requestedChannelName = interaction.options.getString('channel_name')?.trim();
    const categoryName = interaction.options.getString('category_name')?.trim();
    const forumId = interaction.options.getString('evidence_forum_id')?.trim();
    const forumName = (interaction.options.getString('evidence_forum_name') || 'jail-evidence').trim().toLowerCase().replace(/\s+/g, '-');
    const reason = `Jail setup requested by ${user.tag} (${user.id})`;

    if (!ID_PATTERN.test(jailRoleId) || (lawyerRoleId && !ID_PATTERN.test(lawyerRoleId)) || (categoryId && !ID_PATTERN.test(categoryId)) || (existingChannelId && !ID_PATTERN.test(existingChannelId)) || (forumId && !ID_PATTERN.test(forumId))) return interaction.editReply('One of the supplied IDs is invalid.');
    if (!existingChannelId && !requestedChannelName) return interaction.editReply('Provide channel_name to create a jail channel, or jail_channel_id to use an existing one.');

    const jailRole = await guild.roles.fetch(jailRoleId).catch(() => null);
    if (!jailRole || jailRole.id === guild.id || jailRole.permissions.has(PermissionFlagsBits.Administrator)) return interaction.editReply('The jail role must exist, cannot be @everyone, and cannot have Administrator permission.');
    const lawyerRole = lawyerRoleId ? await guild.roles.fetch(lawyerRoleId).catch(() => null) : null;
    if (lawyerRoleId && (!lawyerRole || lawyerRole.id === guild.id)) return interaction.editReply('I could not find the lawyer role.');
    const botMember = guild.members.me ?? await guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels) || !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.editReply('I need Manage Channels and Manage Roles permissions.');
    if (botMember.roles.highest.comparePositionTo(jailRole) <= 0 || (lawyerRole && botMember.roles.highest.comparePositionTo(lawyerRole) <= 0)) return interaction.editReply('My highest role must be above both selected roles.');

    let jailChannel = existingChannelId ? await guild.channels.fetch(existingChannelId).catch(() => null) : null;
    if (existingChannelId && jailChannel?.type !== ChannelType.GuildText) return interaction.editReply('jail_channel_id must identify an existing text channel.');
    let category = null;
    if (categoryId) {
      category = await guild.channels.fetch(categoryId).catch(() => null);
      if (category?.type !== ChannelType.GuildCategory) return interaction.editReply('category_id must identify an existing category.');
    } else if (jailChannel?.parentId) {
      category = await guild.channels.fetch(jailChannel.parentId).catch(() => null);
    } else if (!jailChannel) {
      category = await guild.channels.create({ name: categoryName || 'jail', type: ChannelType.GuildCategory, reason });
    }
    if (category && jailChannel?.parentId !== category.id) {
      await jailChannel.setParent(category.id, { lockPermissions: false, reason });
    }
    const existingRoleCount = Array.isArray(guildConfig?.jail?.roles)
      ? guildConfig.jail.roles.filter(x => x?.roleId !== jailRole.id).length
      : 0;
    if (existingRoleCount >= 25) return interaction.editReply('Discord dropdowns support up to 25 registered jail roles. Remove one before adding another.');

    const botRoleIds = new Set(botMember.roles.cache.keys());
    if (!jailChannel) {
      jailChannel = await guild.channels.create({
        name: requestedChannelName.toLowerCase().replace(/\s+/g, '-'),
        type: ChannelType.GuildText,
        ...(category ? { parent: category.id } : {}),
        reason,
      });
    }

    if (category) {
      for (const overwrite of category.permissionOverwrites.cache.values()) {
        if ([guild.id, jailRole.id, lawyerRoleId, botMember.id].includes(overwrite.id) || botRoleIds.has(overwrite.id)) continue;
        await jailChannel.permissionOverwrites.edit(overwrite.id, { ViewChannel: false }, reason);
      }
    }
    await jailChannel.permissionOverwrites.edit(guild.id, { ViewChannel: false }, reason);
    await jailChannel.permissionOverwrites.edit(jailRole.id, { allow: JAIL_ALLOW, deny: [] }, reason);
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
    } else if (lawyerRole) {
      await evidenceForum.permissionOverwrites.edit(lawyerRole.id, { ViewChannel: true, ReadMessageHistory: true }, reason);
    }
    if (category && lawyerRole) await category.permissionOverwrites.edit(lawyerRole.id, { ViewChannel: true, ReadMessageHistory: true }, reason);
    if (lawyerRole) {
      await jailChannel.permissionOverwrites.edit(lawyerRole.id, { ViewChannel: true, ReadMessageHistory: true }, reason);
    }

    const existingJail = guildConfig?.jail ?? {};
    const roles = Array.isArray(existingJail.roles) ? existingJail.roles.filter(x => x?.roleId !== jailRole.id) : [];
    roles.push({ roleId: jailRole.id, channelId: jailChannel.id });
    await updateGuildConfig(interaction.client, guild.id, {
      jail: { ...existingJail, channelId: jailChannel.id, categoryId: category?.id ?? null, evidenceForumId: evidenceForum.id, lawyerRoleId, roles }
    });

    return interaction.editReply([
      `Jail channel configured: ${jailChannel} (${jailChannel.id})`,
      category ? `Jail category: ${category} (${category.id})` : 'The existing jail channel has no category; no category was created.',
      `Evidence forum: ${evidenceForum} (${evidenceForum.id})`,
      `Jail role: <@&${jailRole.id}>`,
      lawyerRole ? `Lawyer role can view the entire jail category and evidence forum: <@&${lawyerRole.id}>` : 'No lawyer role configured.',
      'Setup applies permissions once. Later manual staff changes are not automatically synchronized or repaired.'
    ].join('\n'));
  },
};
