import { PermissionFlagsBits } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { cancelJailRelease, scheduleJailRelease } from './jailReleaseService.js';

function isPausedCase(jailCase) {
  return jailCase?.sentencePaused === true || Boolean(jailCase?.pausedAt);
}

export async function pauseJailCasesForDeparture(member, client) {
  if (!member?.guild || !member.id) return 0;

  const config = await getGuildConfig(client, member.guild.id);
  const jail = config?.jail ?? {};
  const activeCases = Array.isArray(jail.activeCases) ? [...jail.activeCases] : [];
  const now = Date.now();
  let pausedCount = 0;

  const updatedCases = activeCases.map(jailCase => {
    if (jailCase?.userId !== member.id || isPausedCase(jailCase)) return jailCase;

    const remainingSeconds = jailCase.releaseAt
      ? Math.max(0, (Number(jailCase.releaseAt) - now) / 1000)
      : null;

    pausedCount++;
    return {
      ...jailCase,
      sentencePaused: true,
      pausedAt: now,
      remainingSeconds,
      releaseAt: null,
    };
  });

  if (!pausedCount) return 0;

  // Cancel only after the persisted case has been read. Restore its timer if the write fails.
  cancelJailRelease(member.guild.id, member.id);
  try {
    await updateGuildConfig(client, member.guild.id, {
      jail: { ...jail, activeCases: updatedCases },
    });
  } catch (error) {
    for (const jailCase of activeCases) {
      if (jailCase?.userId === member.id && jailCase.releaseAt && !isPausedCase(jailCase)) {
        scheduleJailRelease(client, member.guild.id, jailCase);
      }
    }
    throw error;
  }

  return pausedCount;
}

export async function resumePausedJailCases(member, client) {
  if (!member?.guild || !member.id) return 0;

  const config = await getGuildConfig(client, member.guild.id);
  const jail = config?.jail ?? {};
  const activeCases = Array.isArray(jail.activeCases) ? [...jail.activeCases] : [];
  const pausedCases = activeCases.filter(jailCase =>
    jailCase?.userId === member.id && isPausedCase(jailCase)
  );
  if (!pausedCases.length) return 0;

  const botMember = member.guild.members.me ?? await member.guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    console.error(`Cannot restore jail roles for rejoined member ${member.id}: bot is missing Manage Roles permission.`);
    return 0;
  }

  const now = Date.now();
  const resumedCases = [];
  const failedRoles = [];
  for (const jailCase of pausedCases) {
    const role = await member.guild.roles.fetch(jailCase.roleId).catch(() => null);
    if (!role || role.managed || botMember.roles.highest.comparePositionTo(role) <= 0) {
      failedRoles.push(jailCase.roleId);
      continue;
    }

    try {
      if (!member.roles.cache.has(role.id)) {
        await member.roles.add(role, 'Restore active jail role after member rejoined the server');
      }

      let remainingSeconds = null;
      if (jailCase.remainingSeconds !== null && jailCase.remainingSeconds !== undefined
        && Number.isFinite(Number(jailCase.remainingSeconds))) {
        remainingSeconds = Math.max(0, Number(jailCase.remainingSeconds));
      } else if (jailCase.sentenceSeconds !== null && jailCase.sentenceSeconds !== undefined
        && Number.isFinite(Number(jailCase.sentenceSeconds))) {
        // Compatibility for any paused record created before remainingSeconds was stored.
        remainingSeconds = Math.max(0, Number(jailCase.sentenceSeconds));
      }

      resumedCases.push({
        ...jailCase,
        sentencePaused: false,
        pausedAt: null,
        remainingSeconds: null,
        resumedAt: now,
        rejoinedAt: now,
        releaseAt: remainingSeconds === null ? null : now + remainingSeconds * 1000,
      });
    } catch (error) {
      failedRoles.push(role.id);
      console.error(`Failed to restore jail role ${role.id} for rejoined member ${member.id}:`, error);
    }
  }

  if (!resumedCases.length) {
    if (failedRoles.length) {
      console.error(`Could not restore jail roles for rejoined member ${member.id}: ${failedRoles.join(', ')}`);
    }
    return 0;
  }

  const resumedByRole = new Map(resumedCases.map(jailCase => [jailCase.roleId, jailCase]));
  const updatedCases = activeCases.map(jailCase => {
    if (jailCase?.userId !== member.id) return jailCase;
    return resumedByRole.get(jailCase.roleId) ?? jailCase;
  });

  const history = Array.isArray(jail.history) ? [...jail.history] : [];
  for (const resumedCase of resumedCases) {
    for (let index = history.length - 1; index >= 0; index--) {
      const entry = history[index];
      if (entry?.userId === member.id && entry?.roleId === resumedCase.roleId && !entry.unjailedAt) {
        history[index] = { ...entry, rejoinedAt: now };
        break;
      }
    }
  }

  await updateGuildConfig(client, member.guild.id, {
    jail: { ...jail, activeCases: updatedCases, history },
  });

  for (const jailCase of resumedCases) {
    if (jailCase.releaseAt) {
      scheduleJailRelease(client, member.guild.id, jailCase);
    }
  }

  // Reuse the existing evidence thread. Do not recreate the original jail evidence post.
  const evidenceThreadIds = [...new Set(resumedCases.map(jailCase => jailCase.evidenceThreadId).filter(Boolean))];
  for (const threadId of evidenceThreadIds) {
    const thread = await member.guild.channels.fetch(threadId).catch(() => null);
    if (!thread?.isTextBased?.() || typeof thread.send !== 'function') continue;
    if (thread.archived && typeof thread.setArchived === 'function') {
      await thread.setArchived(false, 'Add member rejoin note to jail evidence').catch(() => null);
    }
    await thread.send({
      content: 'MEMBER REJOINED THE SERVER. JAIL ROLE RESTORED; SENTENCE RESUMED.',
      allowedMentions: { parse: [] },
    }).catch(error => {
      console.error(`Could not post rejoin note in jail evidence thread ${threadId}:`, error);
    });
  }

  if (failedRoles.length) {
    console.error(`Some jail roles could not be restored for rejoined member ${member.id}: ${failedRoles.join(', ')}`);
  }

  return resumedCases.length;
}

export async function reconcilePausedJailCases(client) {
  let restoredCount = 0;
  for (const guild of client.guilds.cache.values()) {
    const config = await getGuildConfig(client, guild.id).catch(error => {
      console.error(`Could not load jail cases for guild ${guild.id} during rejoin recovery:`, error);
      return null;
    });
    const memberIds = [...new Set((config?.jail?.activeCases ?? [])
      .filter(isPausedCase)
      .map(jailCase => jailCase.userId)
      .filter(Boolean))];

    for (const userId of memberIds) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      restoredCount += await resumePausedJailCases(member, client).catch(error => {
        console.error(`Could not resume paused jail case for ${userId} in guild ${guild.id}:`, error);
        return 0;
      });
    }
  }
  return restoredCount;
}
