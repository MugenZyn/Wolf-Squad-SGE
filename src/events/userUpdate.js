import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import {
  logMemberNameChange,
  logProfilePictureChange,
} from '../services/logging/profilePictureLogService.js';

export default {
  name: Events.UserUpdate,
  async execute(oldUser, newUser, client) {
    if (!oldUser || !newUser) return;

    const avatarChanged = oldUser.avatar !== newUser.avatar;
    const nameChanges = [];
    if (oldUser.username !== newUser.username) {
      nameChanges.push({
        label: 'Username',
        oldValue: oldUser.username,
        newValue: newUser.username,
      });
    }
    if (oldUser.globalName !== newUser.globalName) {
      nameChanges.push({
        label: 'Display name',
        oldValue: oldUser.globalName ?? 'None',
        newValue: newUser.globalName ?? 'None',
      });
    }
    if (!avatarChanged && !nameChanges.length) return;

    // Global account changes apply to every server where the member is present.
    for (const guild of client.guilds.cache.values()) {
      let member = guild.members.cache.get(newUser.id) ?? null;
      if (!member) {
        member = await guild.members.fetch(newUser.id).catch(() => null);
      }
      if (!member) continue;

      if (avatarChanged) {
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

      if (nameChanges.length) {
        try {
          await logMemberNameChange(client, guild, member, {
            title: 'Account Name Changed',
            changes: nameChanges,
          });
        } catch (error) {
          logger.warn(`Could not log account name change in guild ${guild.id}:`, error);
        }
      }
    }
  },
};
