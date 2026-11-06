import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { memberHasModerationCommandAccess } from '../../utils/permissionGuard.js';
import { getGuildConfig, updateGuildConfig } from '../../services/config/guildConfig.js';
import { cancelJailRelease } from '../../services/jailReleaseService.js';

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

    const jail = guildConfig?.jail ?? {};
    const configuredRoleIds = (Array.isArray(jail.roles) ? jail.roles : [])
      .map(entry => entry?.roleId)
      .filter(Boolean);
    const activeCaseRoleIds = (Array.isArray(jail.activeCases) ? jail.activeCases : [])
      .filter(entry => entry?.userId === target.id)
      .map(entry => entry.roleId)
      .filter(Boolean);
    const jailRoleIds = [...new Set([...configuredRoleIds, ...activeCaseRoleIds])]
      .filter(roleId => target.roles.cache.has(roleId));

    if (!jailRoleIds.length) {
      return interaction.reply({ content: `<@${target.id}> does not currently have any configured jail roles.`, flags: MessageFlags.Ephemeral });
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
      try {
        await target.roles.remove(role, `Unjailed by ${interaction.user.tag} (${interaction.user.id})`);
        removed.push(roleId);
      } catch {
        failed.push(role.name);
      }
    }

    const current = await getGuildConfig(interaction.client, interaction.guild.id);
    const currentJail = current?.jail ?? {};
    const releasedAt = Date.now();
    const removedHistoryCases = (currentJail.history ?? []).filter(entry =>
      entry.userId === target.id && removed.includes(entry.roleId) && entry.evidenceThreadId
    );
    const remainingCases = (currentJail.activeCases ?? []).filter(entry =>
      entry.userId !== target.id || !removed.includes(entry.roleId)
    );
    const updatedHistory = (currentJail.history ?? []).map(entry =>
      entry.userId === target.id && removed.includes(entry.roleId)
        ? { ...entry, unjailedAt: releasedAt, unjailedBy: interaction.user.id }
        : entry
    );
    await updateGuildConfig(interaction.client, interaction.guild.id, {
      jail: { ...currentJail, activeCases: remainingCases, history: updatedHistory },
    });

    let evidenceLogCount = 0;
    const evidenceThreadIds = [...new Set([
      ...removedHistoryCases.map(entry => entry.evidenceThreadId),
      ...(currentJail.activeCases ?? [])
        .filter(entry => entry.userId === target.id && removed.includes(entry.roleId))
        .map(entry => entry.evidenceThreadId),
    ].filter(Boolean))];
    for (const threadId of evidenceThreadIds) {
      const thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
      if (!thread?.isTextBased() || typeof thread.send !== 'function') continue;
      const rolesForThread = removedHistoryCases
        .filter(entry => entry.evidenceThreadId === threadId)
        .map(entry => entry.roleId);
      const namesForThread = [];
      for (const roleId of rolesForThread) {
        const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
        if (role) namesForThread.push(role.name);
      }
      await thread.send({
        content: [
          '🔓 **Member unjailed**',
          `**Member:** <@${target.id}> (${target.id})`,
          `**Released by:** <@${interaction.user.id}>`,
          `**Jail role(s) removed:** ${namesForThread.length ? namesForThread.join(', ') : 'Configured jail role'}`,
          `**Released at:** <t:${Math.floor(releasedAt / 1000)}:F>`,
        ].join('\n'),
        allowedMentions: { parse: [] },
      }).then(() => { evidenceLogCount++; }).catch(() => null);
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
        ? `Removed ${removed.length} jail role(s) from <@${target.id}>: ${removedNames.join(', ')}.`
        : `No jail roles could be removed from <@${target.id}>.`,
      removed.length && evidenceLogCount
        ? `Posted the unjail record in ${evidenceLogCount} jail evidence thread(s).`
        : removed.length
          ? 'Could not post to an evidence thread for this release. Older cases may not have a saved evidence-thread link.'
          : '',
      failed.length ? `Could not remove: ${failed.join(', ')}. Check the bot's role hierarchy and permissions.` : '',
    ].filter(Boolean);
    return interaction.reply({
      content: lines.join('\n'),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};
