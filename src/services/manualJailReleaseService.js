import { cancelJailRelease, scheduleJailRelease } from './jailReleaseService.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { consumeExpectedJailRoleRemoval } from './jailRoleUpdateGuard.js';

export async function handleJailRoleRemoval(oldMember, newMember, client) {
  if (!oldMember?.guild || !newMember?.guild || oldMember.id !== newMember.id) return false;

  const config = await getGuildConfig(client, newMember.guild.id);
  const jail = config?.jail ?? {};
  const activeCases = Array.isArray(jail.activeCases) ? jail.activeCases : [];
  const userCases = activeCases.filter(jailCase => jailCase?.userId === newMember.id);
  if (!userCases.length || !userCases.some(jailCase => !jailCase.sentencePaused)) return false;

  const configuredRoleIds = (jail.roles ?? []).map(item => item?.roleId).filter(Boolean);
  const trackedRoleIds = [...new Set([
    ...configuredRoleIds,
    ...userCases.map(jailCase => jailCase.roleId).filter(Boolean),
  ])];
  const removedRoleIds = trackedRoleIds.filter(roleId =>
    oldMember.roles.cache.has(roleId) && !newMember.roles.cache.has(roleId)
  );

  if (!removedRoleIds.length) return false;

  // Consume expected bot removals even when the member still has another jail role.
  // This prevents stale guards from affecting a later manual removal.
  const unexpectedRemovals = removedRoleIds.filter(roleId =>
    !consumeExpectedJailRoleRemoval(newMember.guild.id, newMember.id, roleId)
  );
  if (trackedRoleIds.some(roleId => newMember.roles.cache.has(roleId))) return false;
  if (!unexpectedRemovals.length) return false;

  const now = Date.now();
  const activeRoleIds = new Set(userCases.map(jailCase => jailCase.roleId).filter(Boolean));
  const remainingCases = activeCases.filter(jailCase => jailCase?.userId !== newMember.id);
  const history = Array.isArray(jail.history) ? jail.history.map(entry => {
    if (entry?.userId !== newMember.id || !activeRoleIds.has(entry.roleId) || entry.unjailedAt) return entry;
    return {
      ...entry,
      unjailedAt: now,
      unjailedBy: null,
      unjailedReason: 'All jail roles were manually removed',
      unjailedAutomatically: true,
    };
  }) : [];

  const evidenceThreadIds = [...new Set([
    ...userCases.map(jailCase => jailCase.evidenceThreadId),
    ...history
      .filter(entry => entry?.userId === newMember.id && activeRoleIds.has(entry.roleId) && entry.evidenceThreadId)
      .map(entry => entry.evidenceThreadId),
  ].filter(Boolean))];

  cancelJailRelease(newMember.guild.id, newMember.id);
  try {
    await updateGuildConfig(client, newMember.guild.id, {
      jail: { ...jail, activeCases: remainingCases, history },
    });
  } catch (error) {
    for (const jailCase of userCases) {
      if (jailCase.releaseAt && !jailCase.sentencePaused) scheduleJailRelease(client, newMember.guild.id, jailCase);
    }
    throw error;
  }

  const roleNames = [];
  for (const roleId of userCases.map(jailCase => jailCase.roleId).filter(Boolean)) {
    const role = await newMember.guild.roles.fetch(roleId).catch(() => null);
    roleNames.push(role?.name ?? roleId);
  }

  for (const threadId of evidenceThreadIds) {
    const thread = await newMember.guild.channels.fetch(threadId).catch(() => null);
    if (!thread?.isTextBased?.() || typeof thread.send !== 'function') continue;
    if (thread.archived && typeof thread.setArchived === 'function') {
      await thread.setArchived(false, 'Record manual jail-role removal').catch(() => null);
    }
    await thread.send({
      content: [
        'MEMBER UNJAILED',
        'ALL ACTIVE JAIL ROLES WERE REMOVED OUTSIDE THE BOT.',
        `**Jail role(s):** ${roleNames.join(', ') || 'Configured jail role'}`,
        `**Recorded at:** <t:${Math.floor(now / 1000)}:F>`,
      ].join('\n'),
      allowedMentions: { parse: [] },
    }).catch(error => {
      console.error(`Could not post manual unjail record in evidence thread ${threadId}:`, error);
    });
  }

  const logsChannel = jail.logsChannelId
    ? await newMember.guild.channels.fetch(jail.logsChannelId).catch(() => null)
    : null;
  if (logsChannel?.isTextBased?.() && typeof logsChannel.send === 'function') {
    await logsChannel.send({
      embeds: [{
        color: 0x2B8A3E,
        title: 'Member unjailed — roles removed manually',
        description: [
          `**User:** <@${newMember.id}> (${newMember.id})`,
          `**Jail role(s):** ${roleNames.join(', ') || 'Configured jail role'}`,
          '**Details:** All configured/active jail roles were removed outside the bot.',
          `**Time:** <t:${Math.floor(now / 1000)}:F>`,
          '**Sentence timer:** Cancelled',
        ].join('\n'),
        timestamp: new Date(now).toISOString(),
      }],
      allowedMentions: { parse: [] },
    }).catch(error => {
      console.error('Could not write manual unjail record to the logs channel:', error);
    });
  }

  return true;
}
