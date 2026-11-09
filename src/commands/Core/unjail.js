import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { memberHasModerationCommandAccess } from '../../utils/permissionGuard.js';
import { getGuildConfig, updateGuildConfig } from '../../services/config/guildConfig.js';
import { cancelJailRelease } from '../../services/jailReleaseService.js';
import { markExpectedJailRoleRemoval, clearExpectedJailRoleRemoval } from '../../services/jailRoleUpdateGuard.js';

function chunkListItems(items, maxLength = 1600, separator = ', ') {
  const chunks = [];
  let current = '';
  for (const item of items ?? []) {
    const rendered = String(item);
    const next = current ? `${current}${separator}${rendered}` : rendered;
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

function renderAnnouncement(template, values) {
  return String(template ?? '').replace(/\{\{(user|server|moderator|roles)\}\}/gi, (_, key) => values[key.toLowerCase()] ?? '');
}

export default {
  data: new SlashCommandBuilder()
    .setName('unjail')
    .setDescription('Remove all configured jail roles from a member.')
    .addUserOption(option => option
      .setName('user')
      .setDescription('Member to release from jail.')
      .setRequired(true)),

  async execute(interaction, guildConfig) {
    if (!interaction.inGuild() || !interaction.guild) {
      return interaction.reply({ content: 'Use this command in a server.', flags: MessageFlags.Ephemeral });
    }
    if (!memberHasModerationCommandAccess(interaction.member, guildConfig, PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ content: 'You need Administrator, Manage Messages, or a configured policeman role to unjail members.', flags: MessageFlags.Ephemeral });
    }

    const targetUser = interaction.options.getUser('user', true);
    const target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!target) {
      return interaction.reply({ content: 'That member is not in this server.', flags: MessageFlags.Ephemeral });
    }

    // If a jail sound is currently playing for this member, unjail cancels
    // that pending jail before roles or evidence have been created.
    try {
      const { cancelActiveJailVoiceSound } = await import('../../services/jailVoiceSoundService.js');
      if (cancelActiveJailVoiceSound(interaction.guild.id, target.id)) {
        return interaction.reply({
          content: `Cancelled the pending jail for <@${target.id}>. The sound stopped and the bot left voice. No jail or unjail evidence or announcements were posted.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }
    } catch (error) {
      console.error('[unjail] Could not check for pending jail voice playback:', error?.message ?? String(error));
    }

    const jail = guildConfig?.jail ?? {};
    const isServerOwner = target.id === interaction.guild.ownerId;
    const activeTargetCases = (Array.isArray(jail.activeCases) ? jail.activeCases : [])
      .filter(entry => entry?.userId === target.id);
    const ownerFallbackCases = activeTargetCases
      .filter(entry => entry.ownerFallback === true && entry.roleAssigned === false);
    const ownerFallbackRoleIds = new Set(ownerFallbackCases.map(entry => entry.roleId).filter(Boolean));
    const configuredRoleIds = (Array.isArray(jail.roles) ? jail.roles : [])
      .map(entry => entry?.roleId)
      .filter(Boolean);
    const activeCaseRoleIds = activeTargetCases
      .map(entry => entry.roleId)
      .filter(Boolean);
    const jailRoleIds = [...new Set([...configuredRoleIds, ...activeCaseRoleIds])]
      .filter(roleId => target.roles.cache.has(roleId) && !ownerFallbackRoleIds.has(roleId));

    if (!jailRoleIds.length && !ownerFallbackCases.length) {
      return interaction.reply({ content: `<@${target.id}> does not currently have any configured jail roles or an active server-owner jail record.`, flags: MessageFlags.Ephemeral });
    }

    const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
    const removed = [];
    const failed = [];
    for (const roleId of jailRoleIds) {
      const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
      if (!role || role.managed || botMember.roles.highest.comparePositionTo(role) <= 0) {
        failed.push(role?.name ?? roleId);
        continue;
      }
      markExpectedJailRoleRemoval(interaction.guild.id, target.id, roleId);
      try {
        await target.roles.remove(role, `Unjailed by ${interaction.user.tag} (${interaction.user.id})`);
        removed.push(roleId);
      } catch {
        clearExpectedJailRoleRemoval(interaction.guild.id, target.id, roleId);
        failed.push(role.name);
      }
    }

    const current = await getGuildConfig(interaction.client, interaction.guild.id);
    const currentJail = current?.jail ?? {};
    const releasedAt = Date.now();
    const clearedCaseRoleIds = new Set([
      ...removed,
      ...ownerFallbackCases.map(entry => entry.roleId).filter(Boolean),
    ]);
    const remainingCases = (currentJail.activeCases ?? []).filter(entry =>
      entry.userId !== target.id || !clearedCaseRoleIds.has(entry.roleId)
    );
    const updatedHistory = (currentJail.history ?? []).map(entry =>
      entry.userId === target.id && clearedCaseRoleIds.has(entry.roleId)
        ? { ...entry, unjailedAt: releasedAt, unjailedBy: interaction.user.id }
        : entry
    );
    await updateGuildConfig(interaction.client, interaction.guild.id, {
      jail: { ...currentJail, activeCases: remainingCases, history: updatedHistory },
    });

    let evidenceLogCount = 0;
    const evidenceThreadIds = [...new Set([
      ...(currentJail.history ?? [])
        .filter(entry => entry.userId === target.id && clearedCaseRoleIds.has(entry.roleId) && entry.evidenceThreadId)
        .map(entry => entry.evidenceThreadId),
      ...(currentJail.activeCases ?? [])
        .filter(entry => entry.userId === target.id && clearedCaseRoleIds.has(entry.roleId) && entry.evidenceThreadId)
        .map(entry => entry.evidenceThreadId),
    ].filter(Boolean))];
    for (const threadId of evidenceThreadIds) {
      const thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
      if (!thread?.isTextBased() || typeof thread.send !== 'function') continue;
      const rolesForThread = [...new Set((currentJail.history ?? [])
        .filter(entry => entry.userId === target.id && removed.includes(entry.roleId) && entry.evidenceThreadId === threadId)
        .map(entry => entry.roleId))];
      const namesForThread = [];
      for (const roleId of rolesForThread) {
        const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
        if (role) namesForThread.push(role.name);
      }
      const roleNameChunks = chunkListItems(namesForThread);
      const hadOwnerFallback = ownerFallbackCases.some(entry => entry.evidenceThreadId === threadId);
      const roleLine = hadOwnerFallback
        ? '**Server-owner jail record cleared:** Discord could not apply the jail role restriction to the server owner.'
        : !namesForThread.length
          ? '**Jail role(s) removed:** Configured jail role'
          : roleNameChunks.length === 1
            ? `**Jail role(s) removed:** ${roleNameChunks[0]}`
            : `**Jail role(s) removed:** ${namesForThread.length} roles. The complete list follows.`;
      const posted = await thread.send({
        content: [
          '🔓 **Member unjailed**',
          `**Member:** <@${target.id}> (${target.id})`,
          `**Released by:** <@${interaction.user.id}>`,
          roleLine,
          `**Released at:** <t:${Math.floor(releasedAt / 1000)}:F>`,
        ].join('\n'),
        allowedMentions: { parse: [] },
      }).then(() => true).catch(() => false);
      if (posted) evidenceLogCount++;
      if (posted && roleNameChunks.length > 1) {
        for (let index = 0; index < roleNameChunks.length; index++) {
          await thread.send({
            content: `**Jail roles removed (${index + 1}/${roleNameChunks.length}):**\n${roleNameChunks[index]}`,
            allowedMentions: { parse: [] },
          }).catch(() => null);
        }
      }
    }

    const removedRoleNames = [];
    for (const roleId of removed) {
      const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
      if (role) removedRoleNames.push(role.name);
    }
    const roleAnnouncementText = removedRoleNames.join(', ');
    const unjailAnnouncement = renderAnnouncement(currentJail.unjailAnnouncement || '{{user}} HAS BEEN UNJAILED', {
      user: `<@${target.id}>`,
      server: interaction.guild.name,
      moderator: `<@${interaction.user.id}>`,
      roles: roleAnnouncementText.length <= 900 ? (roleAnnouncementText || (ownerFallbackCases.length ? 'server owner jail record' : '')) : `${removedRoleNames.length} jail roles`,
    });
    // Post the unjail announcement both where the command was run and
    // in the configured announcements channel. Do not post it in private jail channels.
    const announcementChannelIds = new Set(
      [interaction.channelId, currentJail.actionLogChannelId].filter(Boolean)
    );
    for (const channelId of announcementChannelIds) {
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased?.() && channel.send) await channel.send({ content: unjailAnnouncement, preserveCase: true, allowedMentions: { parse: ['users', 'roles'] } }).catch(() => null);
    }

    if (!remainingCases.some(entry => entry.userId === target.id)) {
      cancelJailRelease(interaction.guild.id, target.id);
    }

    const removedNames = [];
    for (const roleId of removed) {
      const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
      if (role) removedNames.push(role.name);
    }
    const lines = [
      removed.length
        ? `Removed ${removed.length} jail role(s) from <@${target.id}>.`
        : ownerFallbackCases.length
          ? `Cleared the server-owner jail record for <@${target.id}>. Discord had not allowed the jail role(s) to be applied.`
          : `No jail roles could be removed from <@${target.id}>.`,
      removed.length && ownerFallbackCases.length
        ? `Also cleared ${ownerFallbackCases.length} server-owner jail fallback record(s).`
        : '',
      (removed.length || ownerFallbackCases.length) && evidenceLogCount
        ? `Posted the unjail record in ${evidenceLogCount} jail evidence thread(s).`
        : removed.length || ownerFallbackCases.length
          ? 'Could not post to an evidence thread for this release. Older cases may not have a saved evidence-thread link.'
          : '',
      failed.length ? `Could not remove ${failed.length} jail role(s). Check the bot's role hierarchy and permissions.` : '',
    ].filter(Boolean);
    await interaction.reply({
      content: lines.join('\n'),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });

    const removedNameChunks = chunkListItems(removedNames);
    for (let index = 0; index < removedNameChunks.length; index++) {
      await interaction.followUp({
        content: `Removed roles (${index + 1}/${removedNameChunks.length}):\n${removedNameChunks[index]}`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
    const failedNameChunks = chunkListItems(failed);
    for (let index = 0; index < failedNameChunks.length; index++) {
      await interaction.followUp({
        content: `Roles not removed (${index + 1}/${failedNameChunks.length}):\n${failedNameChunks[index]}`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
    return;
  },
};
