const expectedRemovals = new Map();

function makeKey(guildId, userId, roleId) {
  return `${guildId}:${userId}:${roleId}`;
}

export function markExpectedJailRoleRemoval(guildId, userId, roleId) {
  const key = makeKey(guildId, userId, roleId);
  const existing = expectedRemovals.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => expectedRemovals.delete(key), 30000);
  timer.unref?.();
  expectedRemovals.set(key, timer);
}

export function clearExpectedJailRoleRemoval(guildId, userId, roleId) {
  const key = makeKey(guildId, userId, roleId);
  const timer = expectedRemovals.get(key);
  if (timer) clearTimeout(timer);
  expectedRemovals.delete(key);
}

export function consumeExpectedJailRoleRemoval(guildId, userId, roleId) {
  const key = makeKey(guildId, userId, roleId);
  const timer = expectedRemovals.get(key);
  if (!timer) return false;
  clearTimeout(timer);
  expectedRemovals.delete(key);
  return true;
}
