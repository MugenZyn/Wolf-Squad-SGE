import { Events } from 'discord.js';
import { handleJailRoleRemoval } from '../services/manualJailReleaseService.js';
import {
  logMemberNameChange,
  logProfilePictureChange,
} from '../services/logging/profilePictureLogService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildMemberUpdate,
  async execute(oldMember, newMember, client) {
    await handleJailRoleRemoval(oldMember, newMember, client);

    // Server-specific avatars are separate from account profile pictures.
    if (oldMember.avatar !== newMember.avatar) {
      try {
        await logProfilePictureChange(client, newMember.guild, newMember, {
          scope: 'server',
          oldAvatarUrl: oldMember.displayAvatarURL({ size: 512, forceStatic: false }),
          newAvatarUrl: newMember.displayAvatarURL({ size: 512, forceStatic: false }),
        });
      } catch (error) {
        logger.warn(`Could not log server profile picture change for member ${newMember.id}:`, error);
      }
    }

    // Nicknames are guild-specific and are not emitted as global user updates.
    if (oldMember.nickname !== newMember.nickname) {
      try {
        await logMemberNameChange(client, newMember.guild, newMember, {
          title: 'Server Nickname Changed',
          changes: [{
            label: 'Nickname',
            oldValue: oldMember.nickname ?? 'None (using account name)',
            newValue: newMember.nickname ?? 'None (using account name)',
          }],
        });
      } catch (error) {
        logger.warn(`Could not log nickname change for member ${newMember.id}:`, error);
      }
    }
  },
};
