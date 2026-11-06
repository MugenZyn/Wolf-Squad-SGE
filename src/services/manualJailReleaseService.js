import { cancelJailRelease, scheduleJailRelease } from './jailReleaseService.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { consumeExpectedJailRoleRemoval } from './jailRoleUpdateGuard.js';

function chunkListItems(items, maxLength = 1600, separator = ', ') {
  const chunks = [];
  let current = '';
  for (const item of items ?? []) {
    const rendered = String(item);
    const next = current ? current + separator + rendered : rendered;
    if (current && next.length > maxLength) {
      chunks.push(current);
      current = rendered;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

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
    const roleNameChunks = chunkListItems(roleNames);
    const roleSummary = !roleNames.length
      ? '**Jail role(s):** Configured jail role'
      : roleNameChunks.length === 1
        ? '**Jail role(s):** ' + roleNameChunks[0]
        : '**Jail role(s):** ' + roleNames.length + ' roles. The complete list follows.';
    const posted = await thread.send({
      content: [
        'MEMBER UNJAILED',
        'ALL ACTIVE JAIL ROLES WERE REMOVED OUTSIDE THE BOT.',
        roleSummary,
        '**Recorded at:** <t:' + Math.floor(now / 1000) + ':F>',
      ].join('\n'),
      allowedMentions: { parse: [] },
    }).then(() => true).catch(error => {
      console.error('Could not post manual unjail record in evidence thread ' + threadId + ':', error);
      return false;
    });
    if (posted && roleNameChunks.length > 1) {
      for (let index = 0; index < roleNameChunks.length; index++) {
        await thread.send({
          content: '**Jail roles removed manually (' + (index + 1) + '/' + roleNameChunks.length + '):**\n' + roleNameChunks[index],
          allowedMentions: { parse: [] },
        }).catch(error => {
          console.error('Could not post manual unjail role list in evidence thread ' + threadId + ':', error);
        });
      }
    }
  }

  const logsChannel = jail.logsChannelId
    ? await newMember.guild.channels.fetch(jail.logsChannelId).catch(() => null)
    : null;
  if (logsChannel?.isTextBased?.() && typeof logsChannel.send === 'function') {
    const roleNameChunks = chunkListItems(roleNames);
    await logsChannel.send({
      embeds: [{
        color: 0x2B8A3E,
        title: 'Member unjailed — roles removed manually',
        description: [
          '**User:** <@' + newMember.id + '> (' + newMember.id + ')',
          '**Jail roles removed:** ' + (roleNames.length || 'Configured'),
          '**Details:** All configured/active jail roles were removed outside the bot.',
          '**Time:** <t:' + Math.floor(now / 1000) + ':F>',
          '**Sentence timer:** Cancelled',
        ].join('\n'),
        timestamp: new Date(now).toISOString(),
      }],
      allowedMentions: { parse: [] },
    }).catch(error => {
      console.error('Could not write manual unjail record to the logs channel:', error);
    });
    for (let index = 0; index < roleNameChunks.length; index++) {
      await logsChannel.send({
        content: '**Jail roles removed manually (' + (index + 1) + '/' + roleNameChunks.length + '):**\n' + roleNameChunks[index],
        allowedMentions: { parse: [] },
      }).catch(error => {
        console.error('Could not post manual unjail role list to the logs channel:', error);
      });
    }
  }

  return true;
}
