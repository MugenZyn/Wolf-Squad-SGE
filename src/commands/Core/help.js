import {
  ActionRowBuilder, EmbedBuilder, MessageFlags, SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';

function commandList(client) {
  return [...client.commands.values()]
    .filter(command => command?.data?.name)
    .map(command => ({
      name: command.data.name,
      description: command.data.description || 'No description provided.',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function categoryFor(name) {
  if (/^game$/.test(name)) return 'Games';
  if (/jail|unjail|setup-jail|clear-logs|^log$|config/.test(name)) return 'Jail & Configuration';
  if (/ban|kick|mute|timeout|warn|purge|clear|mod|lock|unlock/.test(name)) return 'Moderation';
  if (/ticket|report|application/.test(name)) return 'Server Management';
  if (/welcome|verify|role|reaction|autorole/.test(name)) return 'Roles & Onboarding';
  if (/music|play|queue|skip|song|track/.test(name)) return 'Music';
  if (/help|ping|about|invite|uptime|info/.test(name)) return 'Bot & Utility';
  return 'Other Commands';
}

function currentBotName(interaction, client) {
  return interaction.guild?.members?.me?.displayName
    || client.user?.globalName
    || client.user?.username
    || 'bot';
}

function buildHelp(client, botName, category = null, commandName = null) {
  const commands = commandList(client);
  const groups = new Map();
  for (const command of commands) {
    const group = categoryFor(command.name);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(command);
  }
  const categories = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const selectedCategory = categories.includes(category) ? category : categories[0];
  const items = groups.get(selectedCategory) ?? [];
  const selectedCommand = items.find(item => item.name === commandName);
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`${botName} • Help`);

  if (selectedCommand) {
    embed.setDescription(`**/${selectedCommand.name}**\n${selectedCommand.description}`)
      .addFields({ name: 'Category', value: selectedCategory });
  } else {
    const commandText = items.length
      ? items.map(item => `**/${item.name}** — ${item.description}`).join('\n')
      : 'No commands in this category.';
    // Embed descriptions allow up to 4,096 characters; field values allow only 1,024.
    embed.setDescription(`**${selectedCategory}**\nChoose a command below to see what it does.\n\n${commandText.slice(0, 3850)}`);
  }
  embed.addFields({
    name: 'Privacy Policy',
    value: '[Read the Conradd4 Privacy Policy](https://conradd4.carrd.co/)',
  });
  embed.setFooter({ text: `${commands.length} commands • Choose a category or command below` });

  const rows = [];
  if (categories.length) {
    const categoryMenu = new StringSelectMenuBuilder()
      .setCustomId('help:category')
      .setPlaceholder('Browse command categories')
      .addOptions(categories.slice(0, 25).map(name => ({
        label: name,
        value: name,
        default: name === selectedCategory,
      })));
    rows.push(new ActionRowBuilder().addComponents(categoryMenu));
  }
  if (items.length) {
    const commandMenu = new StringSelectMenuBuilder()
      .setCustomId(`help:command:${selectedCategory}`)
      .setPlaceholder('Choose a command for details')
      .addOptions(items.slice(0, 25).map(item => ({
        label: `/${item.name}`.slice(0, 100),
        value: item.name,
        description: item.description.slice(0, 100),
        default: item.name === selectedCommand?.name,
      })));
    rows.push(new ActionRowBuilder().addComponents(commandMenu));
  }
  return { embeds: [embed], components: rows };
}

export default {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Browse every available bot command.'),

  async execute(interaction, guildConfig, client) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return interaction.editReply(buildHelp(client, currentBotName(interaction, client)));
  },

  async handleComponent(interaction, client) {
    if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith('help:')) return false;
    const botName = currentBotName(interaction, client);
    if (interaction.customId === 'help:category') {
      return interaction.update(buildHelp(client, botName, interaction.values[0]));
    }
    if (interaction.customId.startsWith('help:command:')) {
      const category = interaction.customId.slice('help:command:'.length);
      return interaction.update(buildHelp(client, botName, category, interaction.values[0]));
    }
    return false;
  },
};
