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
      `**Member:** <@${member.id}>\n**User ID:** ${member.id}\n**Type:** ${isServerAvatar ? 'Server-specific profile picture' : 'Account profile picture'}`
    )
    .setThumbnail(oldAvatarUrl)
    .setImage(newAvatarUrl)
    .setTimestamp();

  await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
  return true;
}
