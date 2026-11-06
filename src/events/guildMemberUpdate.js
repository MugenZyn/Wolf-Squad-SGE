import { Events } from 'discord.js';
import { handleJailRoleRemoval } from '../services/manualJailReleaseService.js';

export default {
  name: Events.GuildMemberUpdate,
  async execute(oldMember, newMember, client) {
    await handleJailRoleRemoval(oldMember, newMember, client);
  },
};
