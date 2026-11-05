import { ChannelType, PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from 'discord.js';
import { updateGuildConfig } from '../../services/config/guildConfig.js';

const ID_PATTERN = /^\d{17,20}$/;
const JAIL_CHANNEL_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];

export default {
  data: new SlashCommandBuilder()
    .setName('setup-jail')
    .setDescription('Create or configure a jail channel and evidence forum.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('channel_name').setDescription('Name for a new jail channel.').setRequired(true).setMaxLength(100))
    .addStringOption(o => o.setName('jail_role_id').setDescription('Role allowed to use the jail channel.').setRequired(true).setMinLength(17).setMaxLength(20))
    .addStringOption(o => o.setName('category_name').setDescription('Name for a new category (when no existing category ID is supplied).').setMaxLength(100))
    .addStringOption(o => o.setName('category_id').setDescription('Existing category ID.').setMinLength(17).setMaxLength(20))
    .addStringOption(o => o.setName('lawyer_role_id').setDescription('Optional role allowed to view the entire jail category and evidence forum.').setMinLength(17).setMaxLength(20))
    .addStringOption(o => o.setName('evidence_forum_id').setDescription('Use an existing forum channel instead of creating one.').setMinLength(17).setMaxLength(20))
    .addStringOption(o => o.setName('evidence_forum_name').setDescription('Name for a new evidence forum.').setMaxLength(100)),

  async execute(interaction, guildConfig) {
    if (!interaction.inGuild() || !interaction.guild) return interaction.reply({ content: 'This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { guild, user } = interaction;
    const channelName = interaction.options.getString('channel_name', true).trim().toLowerCase().replace(/\s+/g, '-');
    const jailRoleId = interaction.options.getString('jail_role_id', true).trim();
    const lawyerRoleId = interaction.options.getString('lawyer_role_id')?.trim() || null;
    const categoryId = interaction.options.getString('category_id')?.trim();
    const categoryName = interaction.options.getString('category_name')?.trim();
    const forumId = interaction.options.getString('evidence_forum_id')?.trim();
    const forumName = (interaction.options.getString('evidence_forum_name') || 'jail-evidence').trim().toLowerCase().replace(/\s+/g, '-');
    const reason = `Jail setup requested by ${user.tag} (${user.id})`;

    if (!ID_PATTERN.test(jailRoleId) || (lawyerRoleId && !ID_PATTERN.test(lawyerRoleId))) return interaction.editReply('One of the supplied role IDs is invalid.');
    const jailRole = await guild.roles.fetch(jailRoleId).catch(() => null);
    if (!jailRole || jailRole.id === guild.id || jailRole.permissions.has(PermissionFlagsBits.Administrator)) return interaction.editReply('The jail role must exist, cannot be @everyone, and cannot have Administrator permission.');
    const lawyerRole = lawyerRoleId ? await guild.roles.fetch(lawyerRoleId).catch(() => null) : null;
    if (lawyerRoleId && (!lawyerRole || lawyerRole.id === guild.id)) return interaction.editReply('I could not find the lawyer role.');
    if (lawyerRole && lawyerRole.permissions.has(PermissionFlagsBits.Administrator)) return interaction.editReply('The lawyer role already has Administrator permission; it does not need channel overwrites.');
    const botMember = guild.members.me ?? await guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels) || !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.editReply('I need Manage Channels and Manage Roles permissions.');
    if (botMember.roles.highest.comparePositionTo(jailRole) <= 0 || (lawyerRole && botMember.roles.highest.comparePositionTo(lawyerRole) <= 0)) return interaction.editReply('My highest role must be above both selected roles.');

    let category = categoryId ? await guild.channels.fetch(categoryId).catch(() => null) : null;
    if (categoryId && (!ID_PATTERN.test(categoryId) || category?.type !== ChannelType.GuildCategory)) return interaction.editReply('The category ID must identify an existing category in this server.');
    if (!category) {
      if (!categoryName) return interaction.editReply('Provide category_name or category_id.');
      category = await guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory, reason });
    }

    const botRoleIds = new Set(botMember.roles.cache.keys());
    const categoryOverwrites = [...category.permissionOverwrites.cache.values()]
      .filter(x => x.id !== guild.id && x.id !== jailRole.id && x.id !== lawyerRoleId && x.id !== botMember.id && !botRoleIds.has(x.id))
      .map(x => ({ id: x.id, deny: [PermissionFlagsBits.ViewChannel] }));
    const jailChannel = await guild.channels.create({
      name: channelName, type: ChannelType.GuildText, parent: category.id, reason,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        ...categoryOverwrites,
        { id: jailRole.id, allow: JAIL_CHANNEL_PERMISSIONS },
        ...(lawyerRole ? [{ id: lawyerRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }] : []),
      ],
    });

    let evidenceForum = forumId ? await guild.channels.fetch(forumId).catch(() => null) : null;
    if (forumId && evidenceForum?.type !== ChannelType.GuildForum) return interaction.editReply('evidence_forum_id must identify an existing forum channel.');
    if (!evidenceForum) {
      evidenceForum = await guild.channels.create({
        name: forumName, type: ChannelType.GuildForum, parent: category.id, reason,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          ...(lawyerRole ? [{ id: lawyerRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }] : []),
        ],
      });
    } else if (lawyerRole) {
      await evidenceForum.permissionOverwrites.edit(lawyerRole.id, { ViewChannel: true, ReadMessageHistory: true }, reason);
    }

    if (lawyerRole) {
      await category.permissionOverwrites.edit(lawyerRole.id, { ViewChannel: true, ReadMessageHistory: true }, reason);
      await jailChannel.permissionOverwrites.edit(lawyerRole.id, { ViewChannel: true, ReadMessageHistory: true }, reason);
    }

    const current = guildConfig ?? {};
    const existingJail = current.jail ?? {};
    const roles = Array.isArray(existingJail.roles) ? existingJail.roles.filter(x => x?.roleId !== jailRole.id) : [];
    roles.push({ roleId: jailRole.id, channelId: jailChannel.id });
    await updateGuildConfig(interaction.client, guild.id, {
      jail: { ...existingJail, channelId: jailChannel.id, categoryId: category.id, evidenceForumId: evidenceForum.id, lawyerRoleId, roles }
    });

    return interaction.editReply([
      `Jail channel created: ${jailChannel} (${jailChannel.id})`,
      `Jail category: ${category} (${category.id})`,
      `Evidence forum: ${evidenceForum} (${evidenceForum.id})`,
      `Jail role: <@&${jailRole.id}>`,
      lawyerRole ? `Lawyer role can view the entire category and evidence forum: <@&${lawyerRole.id}>` : 'No lawyer role configured.',
      'These permissions are set by this setup command. Later manual staff changes are left alone; the bot does not automatically synchronize or repair channel settings.'
    ].join('\n'));
  },
};
