import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';

const scheduled = new Map();

export function scheduleJailRelease(client, guildId, jailCase) {
  if (!jailCase?.releaseAt || !jailCase?.userId || !jailCase?.roleId) return;
  const key = `${guildId}:${jailCase.userId}`;
  const existing = scheduled.get(key);
  if (existing) clearTimeout(existing);
  const delay = Math.max(0, Math.min(jailCase.releaseAt - Date.now(), 2147483647));
  const timer = setTimeout(async () => {
    scheduled.delete(key);
    if (jailCase.releaseAt > Date.now()) {
      scheduleJailRelease(client, guildId, jailCase);
      return;
    }
    try {
      const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
      const member = await guild.members.fetch(jailCase.userId).catch(() => null);
      if (member?.roles.cache.has(jailCase.roleId)) await member.roles.remove(jailCase.roleId, 'Jail duration expired');
      const config = await getGuildConfig(client, guildId);
      const jail = config.jail ?? {};
      const activeCases = (jail.activeCases ?? []).filter(c => c.userId !== jailCase.userId);
      await updateGuildConfig(client, guildId, { jail: { ...jail, activeCases } });
    } catch (error) {
      // Keep failures visible; the stored releaseAt remains available for a later bot restart.
      console.error('Scheduled jail release failed:', error);
    }
  }, delay);
  timer.unref?.();
  scheduled.set(key, timer);
}

export async function initializeJailReleases(client) {
  for (const guild of client.guilds.cache.values()) {
    const config = await getGuildConfig(client, guild.id).catch(() => null);
    for (const jailCase of config?.jail?.activeCases ?? []) {
      if (jailCase.releaseAt) scheduleJailRelease(client, guild.id, jailCase);
    }
  }
}
