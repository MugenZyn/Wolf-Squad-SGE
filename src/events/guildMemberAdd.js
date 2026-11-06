import { Events } from 'discord.js';
import { resumePausedJailCases } from '../services/jailMembershipService.js';

export default {
  name: Events.GuildMemberAdd,
  async execute(member, client) {
    await resumePausedJailCases(member, client);
  },
};
