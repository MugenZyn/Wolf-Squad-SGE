import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  MessageFlags,
} from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('setup-jail')
    .setDescription('Create or configure a jail category with its jail and evidence channels.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName('category_name')
        .setDescription('Name for the new jail category.')
        .setRequired(true)
        .setMaxLength(100),
    )
    .addStringOption((option) =>
      option
        .setName('jail_role_id')
        .setDescription('ID of the existing role that can access the jail category.')
        .setRequired(true)
        .setMinLength(17)
        .setMaxLength(20),
    )
    .addStringOption((option) =>
      option
        .setName('category_id')
        .setDescription('Optional: use an existing category ID instead of creating one.')
        .setRequired(false)
        .setMinLength(17)
        .setMaxLength(20),
    ),

  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.guild) {
      return interaction.reply({
        content: 'This command can only be used inside a server.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const { guild, user } = interaction;
    const categoryName = interaction.options.getString('category_name', true).trim();
    const jailRoleId = interaction.options.getString('jail_role_id', true).trim();
    const existingCategoryId = interaction.options.getString('category_id')?.trim();
    const reason = `Jail category setup requested by ${user.tag} (${user.id})`;

    if (!/^\d{17,20}$/.test(jailRoleId)) {
      return interaction.editReply('That does not look like a valid Discord role ID.');
    }

    const jailRole = await guild.roles.fetch(jailRoleId).catch(() => null);
    if (!jailRole || jailRole.id === guild.id) {
      return interaction.editReply('I could not find that jail role in this server. The @everyone role cannot be used.');
    }

    if (jailRole.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.editReply('That role has Administrator permission, which bypasses channel permission overwrites. Remove Administrator from it first.');
    }

    const botMember = guild.members.me ?? await guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)
      || !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.editReply('I need both **Manage Channels** and **Manage Roles** permissions to set up jail access.');
    }

    if (botMember.roles.highest.comparePositionTo(jailRole) <= 0) {
      return interaction.editReply('My highest role must be above the jail role in Server Settings → Roles.');
    }

    let category = null;
    let createdCategory = false;

    if (existingCategoryId) {
      if (!/^\d{17,20}$/.test(existingCategoryId)) {
        return interaction.editReply('That does not look like a valid category ID.');
      }

      category = await guild.channels.fetch(existingCategoryId).catch(() => null);
      if (!category || category.type !== ChannelType.GuildCategory) {
        return interaction.editReply('I could not find a category with that ID in this server.');
      }

      // Deliberately preserve every permission overwrite on a supplied category.
      // This lets admins maintain custom access for other roles without this
      // command silently replacing their choices.
    } else {
      try {
        category = await guild.channels.create({
          name: categoryName,
          type: ChannelType.GuildCategory,
          reason,
          permissionOverwrites: [
            {
              id: guild.id,
              deny: [PermissionFlagsBits.ViewChannel],
            },
            {
              id: jailRole.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessagesInThreads,
                PermissionFlagsBits.CreatePublicThreads,
              ],
            },
          ],
        });
        createdCategory = true;
      } catch (error) {
        return interaction.editReply(`I couldn't create the jail category: ${error.message}`);
      }
    }

    const createdChannels = [];
    const failures = [];

    try {
      const jailChannel = await guild.channels.create({
        name: 'jail',
        type: ChannelType.GuildText,
        parent: category.id,
        reason,
      });
      createdChannels.push(jailChannel);
    } catch (error) {
      failures.push(`jail text channel: ${error.message}`);
    }

    try {
      const evidenceChannel = await guild.channels.create({
        name: 'jail-evidence',
        type: ChannelType.GuildForum,
        parent: category.id,
        reason,
      });
      createdChannels.push(evidenceChannel);
    } catch (error) {
      failures.push(`jail evidence forum: ${error.message}`);
    }

    if (failures.length) {
      return interaction.editReply([
        `Category: ${category}${createdCategory ? ' (created)' : ' (existing; its permissions were left untouched)'}.`,
        createdChannels.length
          ? `Created: ${createdChannels.map((channel) => channel.toString()).join(', ')}.`
          : 'No channels were created successfully.',
        `Problems: ${failures.join(' | ')}`,
        'No existing channels were moved, edited, or force-synced.',
      ].join('\n'));
    }

    return interaction.editReply([
      `Jail category setup complete: ${category}.`,
      `Created ${createdChannels[0]} and forum channel ${createdChannels[1]}.`,
      createdCategory
        ? `The new category denies @everyone access and grants <@&${jailRole.id}> access. Both new channels inherit the category permissions.`
        : 'The existing category permissions were left exactly as they were. The new channels inherit its current permissions.',
      'Existing channels in the category were not changed or force-synced. You can manually adjust category and channel permissions at any time.',
    ].join('\n'));
  },
};
