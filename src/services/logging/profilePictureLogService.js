import { EmbedBuilder } from 'discord.js';
import { getGuildConfig } from '../config/guildConfig.js';

export async function logProfilePictureChange(client, guild, member, {
  scope = 'account',
  oldAvatarUrl,
  newAvatarUrl,
} = {}) {
  if (!client || !guild || !member || !oldAvatarUrl || !newAvatarUrl) return false;

  const config = await getGuildConfig(client, guild.id);
  const channelId = config?.logs?.avatarChangesChannelId;
  if (!channelId) return false;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') return false;

  const isServerAvatar = scope === 'server';
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(isServerAvatar ? 'Server Profile Picture Changed' : 'Profile Picture Changed')
    .setAuthor({
      name: member.user?.tag || member.user?.username || 'Unknown member',
      iconURL: newAvatarUrl,
    })
    .setDescription(
      `**Member:** ${member.user?.tag || member.user?.username || member.displayName || 'Unknown member'}\n**User ID:** ${member.id}\n**Type:** ${isServerAvatar ? 'Server-specific profile picture' : 'Account profile picture'}`
    )
    .setThumbnail(oldAvatarUrl)
    .setImage(newAvatarUrl)
    .setTimestamp();

  await channel.send({
    content: `<@${member.id}> changed their ${isServerAvatar ? 'server' : 'account'} profile picture.`,
    embeds: [embed],
    allowedMentions: { users: [member.id] },
  });
  return true;
}

/**
 * Log account names and server nicknames to the same member-change channel
 * used for profile-picture changes.
 */
export async function logMemberNameChange(client, guild, member, {
  title = 'Member Name Changed',
  changes = [],
} = {}) {
  if (!client || !guild || !member || !changes.length) return false;

  const config = await getGuildConfig(client, guild.id);
  const channelId = config?.logs?.avatarChangesChannelId;
  if (!channelId) return false;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') return false;

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(title)
    .setDescription(`**Member:** <@${member.id}>\n**User ID:** ${member.id}`)
    .addFields(changes.slice(0, 5).map(change => ({
      name: String(change.label || 'Name').slice(0, 256),
      value: `**Before:** ${String(change.oldValue ?? 'None').slice(0, 450)}\n**After:** ${String(change.newValue ?? 'None').slice(0, 450)}`,
      inline: false,
    })))
    .setTimestamp();

  await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
  return true;
}
