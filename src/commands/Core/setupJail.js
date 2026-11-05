import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  MessageFlags,
} from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('setup-jail')
    .setDescription('Create a jail channel and hide the rest of the server from a role.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName('channel_name')
        .setDescription('Name for the jail text channel.')
        .setRequired(true)
        .setMaxLength(100),
    )
    .addStringOption((option) =>
      option
        .setName('jail_role_id')
        .setDescription('ID of the existing role to jail.')
        .setRequired(true)
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
    const channelName = interaction.options.getString('channel_name', true).trim();
    const jailRoleId = interaction.options.getString('jail_role_id', true).trim();

    if (!/^\d{17,20}$/.test(jailRoleId)) {
      return interaction.editReply('That does not look like a valid Discord role ID.');
    }

    const jailRole = await guild.roles.fetch(jailRoleId).catch(() => null);
    if (!jailRole) {
      return interaction.editReply('I could not find that role in this server. Make sure you supplied the role ID.');
    }

    if (jailRole.id === guild.id) {
      return interaction.editReply('The @everyone role cannot be used as the jail role.');
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

    const existingChannels = await guild.channels.fetch();
    const reason = `Jail channel setup requested by ${user.tag} (${user.id})`;

    let jailChannel;
    try {
      jailChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
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
            ],
          },
        ],
      });
    } catch (error) {
      return interaction.editReply(`I couldn't create the jail channel: ${error.message}`);
    }

    let updated = 0;
    const failures = [];

    for (const channel of existingChannels.values()) {
      try {
        await channel.permissionOverwrites.edit(
          jailRole.id,
          { ViewChannel: false },
          reason,
        );
        updated += 1;
      } catch (error) {
        failures.push(`${channel.name} (${channel.id}): ${error.message}`);
      }
    }

    if (failures.length > 0) {
      return interaction.editReply(
        [
          `Created ${jailChannel} and updated ${updated}/${existingChannels.size} existing channels.`,
          `I couldn't update ${failures.length} channel(s), so the jail role may still be able to see some of the server:`,
          failures.slice(0, 8).map((failure) => `• ${failure}`).join('\n'),
          failures.length > 8 ? `...and ${failures.length - 8} more.` : '',
        ].filter(Boolean).join('\n'),
      );
    }

    return interaction.editReply(
      `Jail setup complete. Created ${jailChannel} and denied **View Channel** for <@&${jailRole.id}> on all ${updated} previously existing channels (including categories). The role can view and send messages in the new jail channel.`,
    );
  },
};
