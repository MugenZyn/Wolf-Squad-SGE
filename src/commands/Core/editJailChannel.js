import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  MessageFlags,
} from 'discord.js';
import { updateGuildConfig } from '../../services/config/guildConfig.js';

const ID_PATTERN = /^\d{17,20}$/;

export default {
  data: new SlashCommandBuilder()
    .setName('edit-jail-channel')
    .setDescription('Change which jail role can access an existing jail channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option.setName('channel_id')
        .setDescription('ID of the jail text or forum channel to edit.')
        .setRequired(true)
        .setMinLength(17)
        .setMaxLength(20))
    .addStringOption((option) =>
      option.setName('jail_role_id')
        .setDescription('ID of the role that should access this channel.')
        .setRequired(true)
        .setMinLength(17)
        .setMaxLength(20))
    .addStringOption((option) =>
      option.setName('previous_role_id')
        .setDescription('ID of the old jail role overwrite to remove from this channel.')
        .setRequired(true)
        .setMinLength(17)
        .setMaxLength(20)),

  async execute(interaction, guildConfig) {
    if (!interaction.inGuild() || !interaction.guild) {
      return interaction.reply({ content: 'This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const { guild, user } = interaction;
    const channelId = interaction.options.getString('channel_id', true).trim();
    const jailRoleId = interaction.options.getString('jail_role_id', true).trim();
    const previousRoleId = interaction.options.getString('previous_role_id', true).trim();

    if (!ID_PATTERN.test(channelId)) return interaction.editReply('That does not look like a valid channel ID.');
    if (!ID_PATTERN.test(jailRoleId)) return interaction.editReply('That does not look like a valid role ID.');
    if (previousRoleId && !ID_PATTERN.test(previousRoleId)) return interaction.editReply('That does not look like a valid previous role ID.');

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildForum].includes(channel.type)) {
      return interaction.editReply('I could not find a text or forum channel with that ID in this server.');
    }

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
      return interaction.editReply('My highest role must be above the selected jail role in Server Settings → Roles.');
    }

    try {
      const reason = `Jail channel access updated by ${user.tag} (${user.id})`;
      const botMemberId = botMember.id;
      const botRoleIds = new Set(botMember.roles.cache.keys());
      const category = channel.parentId ? await guild.channels.fetch(channel.parentId).catch(() => null) : null;

      // Deny visibility to roles/members allowed by the parent category, except
      // the selected jail role and the bot itself. Other permission bits remain intact.
      if (category?.type === ChannelType.GuildCategory) {
        for (const overwrite of category.permissionOverwrites.cache.values()) {
          if (overwrite.id === guild.id || overwrite.id === jailRole.id || overwrite.id === guildConfig?.jail?.lawyerRoleId || overwrite.id === botMemberId || botRoleIds.has(overwrite.id)) continue;
          await channel.permissionOverwrites.edit(overwrite.id, { ViewChannel: false }, reason);
        }
      }

      // Keep the channel private to @everyone, then grant the selected role access.
      await channel.permissionOverwrites.edit(guild.id, {
        ViewChannel: false,
      }, reason);

      const allow = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ];
      if (channel.type === ChannelType.GuildForum) {
        allow.push(PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.CreatePublicThreads);
      }

      await channel.permissionOverwrites.edit(jailRole.id, {
        allow,
        deny: [],
      }, reason);

      const lawyerRoleId = guildConfig?.jail?.lawyerRoleId;
      if (lawyerRoleId) {
        const lawyerRole = await guild.roles.fetch(lawyerRoleId).catch(() => null);
        if (lawyerRole) await channel.permissionOverwrites.edit(lawyerRole.id, { ViewChannel: true, ReadMessageHistory: true }, reason);
      }

      let removedOldRole = false;
      if (previousRoleId !== jailRole.id && previousRoleId !== guild.id) {
        await channel.permissionOverwrites.delete(previousRoleId, `Previous jail role removed by ${user.tag} (${user.id})`).catch((error) => {
          if (error.code !== 10013 && error.code !== 10004) throw error;
        });
        removedOldRole = true;
      }

      const jail = guildConfig?.jail ?? {};
      const roles = (Array.isArray(jail.roles) ? jail.roles : []).filter(item => item?.roleId !== jailRole.id && item?.channelId !== channel.id);
      roles.push({ roleId: jailRole.id, channelId: channel.id });
      await updateGuildConfig(interaction.client, guild.id, { jail: { ...jail, channelId: channel.id, roles } });

      return interaction.editReply([
        `Updated ${channel} (${channel.id}).`,
        `The selected access role is now <@&${jailRole.id}> (${jailRole.id}).`,
        removedOldRole
          ? `Removed the previous role overwrite for ${previousRoleId}.`
          : 'No previous role overwrite was removed. Supply previous_role_id if you want the old jail role removed.',
        'Other category roles/members were denied channel visibility; unrelated permission bits and other channel overwrites were left intact. This channel is not force-synced to its category.',
      ].join('
'));
    } catch (error) {
      return interaction.editReply(`I couldn't fully update the channel permissions: ${error.message}`);
    }
  },
};
