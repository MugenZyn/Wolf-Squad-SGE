import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';

const scheduled = new Map();

export function cancelJailRelease(guildId, userId) {
  const prefix = `${guildId}:${userId}:`;
  for (const [key, timer] of scheduled.entries()) {
    if (key.startsWith(prefix) || key === `${guildId}:${userId}`) {
      clearTimeout(timer);
      scheduled.delete(key);
    }
  }
}

export function scheduleJailRelease(client, guildId, jailCase) {
  if (!jailCase?.releaseAt || !jailCase?.userId || !jailCase?.roleId || jailCase.sentencePaused) return;
  const key = `${guildId}:${jailCase.userId}:${jailCase.roleId}`;
  const existing = scheduled.get(key);
  if (existing) clearTimeout(existing);
  const releaseAt = Number(jailCase.releaseAt);
  const delay = Math.max(0, Math.min(releaseAt - Date.now(), 2147483647));

  const timer = setTimeout(async () => {
    scheduled.delete(key);
    try {
      let config = await getGuildConfig(client, guildId);
      let jail = config?.jail ?? {};
      let currentCase = (jail.activeCases ?? []).find(item =>
        item.userId === jailCase.userId && item.roleId === jailCase.roleId
      );

      // Another action may have paused, replaced, or removed this case while its timer was pending.
      if (!currentCase || currentCase.sentencePaused || !currentCase.releaseAt) return;
      if (Number(currentCase.releaseAt) > Date.now()) {
        scheduleJailRelease(client, guildId, currentCase);
        return;
      }

      const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
      const member = await guild.members.fetch(jailCase.userId).catch(() => null);

      if (!member) {
        // Protect against the leave event and sentence-expiry timer racing each other.
        const now = Date.now();
        const activeCases = (jail.activeCases ?? []).map(item =>
          item.userId === jailCase.userId && item.roleId === jailCase.roleId
            ? { ...item, sentencePaused: true, pausedAt: now, remainingSeconds: 0, releaseAt: null }
            : item
        );
        await updateGuildConfig(client, guildId, { jail: { ...jail, activeCases } });
        return;
      }

      if (member.roles.cache.has(jailCase.roleId)) {
        await member.roles.remove(jailCase.roleId, 'Jail duration expired');
      }

      // Re-read after the Discord role operation so a concurrent departure can pause the case.
      config = await getGuildConfig(client, guildId);
      jail = config?.jail ?? {};
      currentCase = (jail.activeCases ?? []).find(item =>
        item.userId === jailCase.userId && item.roleId === jailCase.roleId
      );
      if (!currentCase || currentCase.sentencePaused || !currentCase.releaseAt) return;
      if (Number(currentCase.releaseAt) > Date.now()) {
        scheduleJailRelease(client, guildId, currentCase);
        return;
      }

      const activeCases = (jail.activeCases ?? []).filter(item =>
        item.userId !== jailCase.userId || item.roleId !== jailCase.roleId
      );
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
      if (jailCase.releaseAt && !jailCase.sentencePaused) {
        scheduleJailRelease(client, guild.id, jailCase);
      }
    }
  }
}
