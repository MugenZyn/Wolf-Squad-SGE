import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('lawyer')
    .setDescription('Give a member the configured lawyer role.')
    .addUserOption(option => option
      .setName('user')
      .setDescription('Member who should receive the lawyer role.')
      .setRequired(true)),

  async execute(interaction, guildConfig) {
    if (!interaction.inGuild() || !interaction.guild) {
      return interaction.reply({ content: 'Use this command in a server.', flags: MessageFlags.Ephemeral });
    }

    const policemanRoleIds = Array.isArray(guildConfig?.jail?.policemanRoleIds)
      ? guildConfig.jail.policemanRoleIds
      : [];
    const isPoliceman = policemanRoleIds.some(roleId => interaction.member?.roles?.cache?.has(roleId));

    if (!isPoliceman) {
      return interaction.reply({
        content: 'You need a configured policeman role to give someone the lawyer role.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();

    const lawyerRoleId = guildConfig?.jail?.lawyerRoleId;
    if (!lawyerRoleId) {
      return interaction.editReply('No lawyer role is configured. An administrator must set one in /setup-jail or /config.');
    }

    const targetUser = interaction.options.getUser('user', true);
    const target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!target) return interaction.editReply('That member is not in this server.');

    const lawyerRole = await interaction.guild.roles.fetch(lawyerRoleId).catch(() => null);
    if (!lawyerRole || lawyerRole.id === interaction.guild.id) {
      return interaction.editReply('The configured lawyer role no longer exists. An administrator must update it in /config.');
    }

    const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.editReply('I need Manage Roles permission to give the lawyer role.');
    }
    if (lawyerRole.managed || botMember.roles.highest.comparePositionTo(lawyerRole) <= 0) {
      return interaction.editReply('My highest role must be above the configured lawyer role.');
    }

    if (target.roles.cache.has(lawyerRole.id)) {
      return interaction.editReply(`<@!${target.id}> already has the lawyer role.`);
    }

    await target.roles.add(lawyerRole, `Lawyer role granted by ${interaction.user.tag} (${interaction.user.id})`);
    return interaction.editReply(`<@!${target.id}> has been given the <@&${lawyerRole.id}> role.`);
  },
};
