import { Events } from 'discord.js';
import { pauseJailCasesForDeparture } from '../services/jailMembershipService.js';

export default {
  name: Events.GuildMemberRemove,
  async execute(member, client) {
    await pauseJailCasesForDeparture(member, client);
  },
};
