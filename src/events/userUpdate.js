import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { logProfilePictureChange } from '../services/logging/profilePictureLogService.js';

export default {
  name: Events.UserUpdate,
  async execute(oldUser, newUser, client) {
    if (!oldUser || !newUser || oldUser.avatar === newUser.avatar) return;

    // A global user update is not tied to one guild. Log it anywhere the member
    // shares a server with this bot and an avatar-log channel has been configured.
    for (const guild of client.guilds.cache.values()) {
      let member = guild.members.cache.get(newUser.id) ?? null;
      if (!member) {
        member = await guild.members.fetch(newUser.id).catch(() => null);
      }
      if (!member) continue;

      try {
        await logProfilePictureChange(client, guild, member, {
          scope: 'account',
          oldAvatarUrl: oldUser.displayAvatarURL({ size: 512, forceStatic: false }),
          newAvatarUrl: newUser.displayAvatarURL({ size: 512, forceStatic: false }),
        });
      } catch (error) {
        logger.warn(`Could not log profile picture change in guild ${guild.id}:`, error);
      }
    }
  },
};
