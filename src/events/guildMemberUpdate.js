import { Events } from 'discord.js';
import { handleJailRoleRemoval } from '../services/manualJailReleaseService.js';
import { logProfilePictureChange } from '../services/logging/profilePictureLogService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildMemberUpdate,
  async execute(oldMember, newMember, client) {
    await handleJailRoleRemoval(oldMember, newMember, client);

    // Guild-specific avatars are stored on the member, separately from the
    // account avatar handled by the UserUpdate event.
    if (oldMember.avatar === newMember.avatar) return;

    try {
      await logProfilePictureChange(client, newMember.guild, newMember, {
        scope: 'server',
        oldAvatarUrl: oldMember.displayAvatarURL({ size: 512, forceStatic: false }),
        newAvatarUrl: newMember.displayAvatarURL({ size: 512, forceStatic: false }),
      });
    } catch (error) {
      logger.warn(`Could not log server profile picture change for member ${newMember.id}:`, error);
    }
  },
};
