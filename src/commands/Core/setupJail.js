import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  MessageFlags,
} from 'discord.js';

const ID_PATTERN = /^\d{17,20}$/;
const JAIL_CHANNEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
];

export default {
  data: new SlashCommandBuilder()
    .setName('setup-jail')
    .setDescription('Create a jail channel that is accessible to one selected jail role.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option.setName('category_name')
        .setDescription('Name for a new category (ignored when category_id is supplied).')
        .setRequired(false)
        .setMaxLength(100))
    .addStringOption((option) =>
      option.setName('channel_name')
        .setDescription('Name for this jail channel, e.g. basic-jail or solitary-confinement.')
        .setRequired(true)
        .setMaxLength(100))
    .addStringOption((option) =>
      option.setName('jail_role_id')
        .setDescription('Role ID allowed to view and use this jail channel.')
        .setRequired(true)
        .setMinLength(17)
        .setMaxLength(20))
    .addStringOption((option) =>
      option.setName('category_id')
        .setDescription('Optional existing category ID to put the new channel under.')
        .setRequired(false)
        .setMinLength(17)
        .setMaxLength(20)),

  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.guild) {
      return interaction.reply({ content: 'This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const { guild, user } = interaction;
    const categoryName = interaction.options.getString('category_name')?.trim();
    const channelName = interaction.options.getString('channel_name', true).trim().toLowerCase().replace(/\s+/g, '-');
    const jailRoleId = interaction.options.getString('jail_role_id', true).trim();
    const categoryId = interaction.options.getString('category_id')?.trim();
    const reason = `Jail channel setup requested by ${user.tag} (${user.id})`;

    if (!ID_PATTERN.test(jailRoleId)) return interaction.editReply('That does not look like a valid Discord role ID.');

    const jailRole = await guild.roles.fetch(jailRoleId).catch(() => null);
    if (!jailRole || jailRole.id === guild.id) return interaction.editReply('I could not find that role. The @everyone role cannot be used.');
    if (jailRole.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.editReply('That role has Administrator permission, which bypasses channel overwrites. Remove Administrator from it first.');
    }

    const botMember = guild.members.me ?? await guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels) || !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.editReply('I need Manage Channels and Manage Roles permissions.');
    }
    if (botMember.roles.highest.comparePositionTo(jailRole) <= 0) {
      return interaction.editReply('My highest role must be above the jail role in Server Settings → Roles.');
    }

    let category;
    let createdCategory = false;

    if (categoryId) {
      if (!ID_PATTERN.test(categoryId)) return interaction.editReply('That does not look like a valid category ID.');
      category = await guild.channels.fetch(categoryId).catch(() => null);
      if (!category || category.type !== ChannelType.GuildCategory) {
        return interaction.editReply('I could not find a category with that ID in this server.');
      }
    } else {
      if (!categoryName) return interaction.editReply('Provide category_name when you are not supplying category_id.');
      try {
        category = await guild.channels.create({
          name: categoryName,
          type: ChannelType.GuildCategory,
          reason,
          permissionOverwrites: [{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }],
        });
        createdCategory = true;
      } catch (error) {
        return interaction.editReply(`I couldn't create the jail category: ${error.message}`);
      }
    }

    try {
      const inheritedOverwrites = [...category.permissionOverwrites.cache.values()]
        .filter((overwrite) => overwrite.id !== guild.id && overwrite.id !== jailRole.id && overwrite.id !== botMember.id)
        .map((overwrite) => ({ id: overwrite.id, deny: [PermissionFlagsBits.ViewChannel] }));

      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category.id,
        reason,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          ...inheritedOverwrites,
          { id: jailRole.id, allow: JAIL_CHANNEL_PERMISSIONS },
        ],
      });

      return interaction.editReply([
        `Created jail channel ${channel} in ${category}.`,
        `Access role: <@&${jailRole.id}> (${jailRole.id}).`,
        createdCategory
          ? 'The new category hides its contents from @everyone; this channel grants access only through its selected role.'
          : 'The existing category permissions were not changed; this channel has its own role-specific access overwrites.',
        'Other role and member overwrites were not changed. Use /edit-jail-channel to change this channel’s jail role later.',
      ].join('\n'));
    } catch (error) {
      return interaction.editReply(`The category is ready, but I couldn't create the jail channel: ${error.message}`);
    }
  },
};
