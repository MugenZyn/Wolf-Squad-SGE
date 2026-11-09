import { randomUUID } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits,
  SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { updateGuildConfig } from '../../services/config/guildConfig.js';
import { lookupTwitchUser, TWITCH_MAX_STREAMERS_PER_GUILD } from '../../services/twitch/twitchStreamService.js';

const SETTINGS = [
  { label: 'Default sentence', value: 'default_seconds', description: 'Seconds, or INFINITE' },
  { label: 'Minimum sentence', value: 'minimum_seconds', description: 'Minimum jail duration in seconds' },
  { label: 'Evidence messages', value: 'evidence_count', description: 'Number of messages to forward (1–10)' },
  { label: 'Default evidence note', value: 'default_message', description: 'Text shown in evidence; CLEAR removes it' },
  { label: 'Jail announcement', value: 'jail_announcement', description: 'Use {{user}}, {{server}}, {{moderator}}, {{role}}, {{reason}}, {{duration}}' },
  { label: 'Unjail announcement', value: 'unjail_announcement', description: 'Use {{user}}, {{server}}, {{moderator}}, {{roles}}, {{reason}}' },
];

const pendingRoleRemovals = new Map();
const pendingRoleSelections = new Map();
const pendingChannelRolePickers = new Map();

const CONFIG_ROLE_PAGE_SIZE = 25;
const CONFIG_CHANNEL_ROLE_PAGE_SIZE = 25;

function formatRoleMentions(ids, maxLength = 900) {
  const mentions = [];
  let used = 0;
  for (const id of ids ?? []) {
    const mention = `<@&${id}>`;
    const addition = mentions.length ? `, ${mention}` : mention;
    if (used + addition.length > maxLength) break;
    mentions.push(mention);
    used += addition.length;
  }
  const remaining = Math.max(0, (ids?.length ?? 0) - mentions.length);
  return `${mentions.join(', ')}${remaining ? ` …and ${remaining} more` : ''}` || 'None';
}

function summarizeRoleIds(ids, label = 'configured') {
  const uniqueIds = [...new Set((ids ?? []).filter(Boolean))];
  if (!uniqueIds.length) return 'None configured';
  const preview = uniqueIds.slice(0, 10).map(id => `<@&${id}>`).join(', ');
  const remaining = uniqueIds.length - Math.min(uniqueIds.length, 10);
  return `${uniqueIds.length} ${label}\n${preview}${remaining ? `\n…and ${remaining} more. Use the paginated role selector to browse all.` : ''}`;
}


function getFilteredRoleChoices(state) {
  const query = String(state?.searchQuery ?? '').trim().toLowerCase();
  return (state?.roles ?? []).filter(role => !query || role.name.toLowerCase().includes(query));
}

function buildPaginatedRoleMenu(customId, placeholder, state) {
  const roles = getFilteredRoleChoices(state);
  const pageCount = Math.max(1, Math.ceil(roles.length / CONFIG_ROLE_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, Number(state?.page) || 0), pageCount - 1);
  const selected = new Set(state?.selectedIds ?? []);
  const options = roles.slice(safePage * CONFIG_ROLE_PAGE_SIZE, (safePage + 1) * CONFIG_ROLE_PAGE_SIZE).map(role => ({
    label: role.name.slice(0, 100), value: role.id,
    description: state?.descriptionForRole?.(role) ?? 'Server role',
    default: selected.has(role.id),
  }));
  if (!options.length) options.push({ label: 'No matching roles found', value: '__no_roles__', description: 'Change or clear the search', disabled: true });
  return {
    menu: new StringSelectMenuBuilder().setCustomId(customId)
      .setPlaceholder(`${placeholder} (page ${safePage + 1}/${pageCount})`)
      .setMinValues(0).setMaxValues(state?.mode === 'single' ? 1 : Math.min(25, Math.max(1, options.length)))
      .addOptions(options),
    page: safePage, pageCount, roles,
  };
}

function updatePagedRoleSelection(state, page, values) {
  const roles = getFilteredRoleChoices(state);
  const currentPageIds = new Set(roles.slice(page * CONFIG_ROLE_PAGE_SIZE, (page + 1) * CONFIG_ROLE_PAGE_SIZE).map(role => role.id));
  const selectedValues = values.filter(value => currentPageIds.has(value));
  if (state.mode === 'single') {
    if (selectedValues.length) state.selectedIds = [selectedValues[0]];
  } else {
    state.selectedIds = [...new Set([
      ...(state.selectedIds ?? []).filter(id => !currentPageIds.has(id)),
      ...selectedValues,
    ])];
  }
  return state;
}

function buildRolePagerControls(prefix, state, options = {}) {
  const roles = getFilteredRoleChoices(state);
  const pageCount = Math.max(1, Math.ceil(roles.length / (options.pageSize ?? CONFIG_ROLE_PAGE_SIZE)));
  const page = Math.min(Math.max(0, state.page ?? 0), pageCount - 1);
  const controls = [
    new ButtonBuilder().setCustomId(`${prefix}:prev`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`${prefix}:search`).setLabel('Search roles').setStyle(ButtonStyle.Primary),
    ...(options.clearSelection ? [new ButtonBuilder().setCustomId(`${prefix}:clear`).setLabel('Clear selection').setStyle(ButtonStyle.Secondary)] : []),
    new ButtonBuilder().setCustomId(`${prefix}:clear_search`).setLabel('Clear search').setStyle(ButtonStyle.Secondary).setDisabled(!state.searchQuery),
    new ButtonBuilder().setCustomId(`${prefix}:next`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount - 1),
  ];
  return new ActionRowBuilder().addComponents(controls);
}
function formatDuration(value) {
  return value == null ? 'Infinite' : `${Number(value).toLocaleString()} seconds`;
}


function getConfiguredGuessingGames(gamesConfig = {}) {
  if (Array.isArray(gamesConfig.guessingGames)) return gamesConfig.guessingGames;
  // One-time compatibility migration for servers that used the old category layout.
  return (Array.isArray(gamesConfig.guessingCategories) ? gamesConfig.guessingCategories : [])
    .flatMap(category => (category.games ?? []).map(game => ({ ...game })));
}

const GUESSING_GAME_CODE_PREFIX = 'C4G1:';

function encodeGuessingGameCode(game) {
  const portableGame = {
    name: String(game.name),
    tries: Number(game.tries),
    lives: Number(game.lives),
    characters: (Array.isArray(game.characters) ? game.characters : []).map(character => ({
      name: String(character.name),
      hints: Array.isArray(character.hints) ? character.hints.map(String) : [],
      ...(typeof character.imageUrl === 'string' && character.imageUrl ? { imageUrl: character.imageUrl } : {}),
      ...(typeof character.wikiUrl === 'string' && character.wikiUrl ? { wikiUrl: character.wikiUrl } : {}),
    })),
  };
  return GUESSING_GAME_CODE_PREFIX + deflateRawSync(Buffer.from(JSON.stringify({ version: 1, game: portableGame }), 'utf8')).toString('base64url');
}

function decodeGuessingGameCode(rawCode) {
  const code = String(rawCode ?? '').trim();
  if (!code.startsWith(GUESSING_GAME_CODE_PREFIX)) throw new Error('That is not a valid Conradd4 game code. It should start with C4G1:.');
  let payload;
  try {
    const compressed = Buffer.from(code.slice(GUESSING_GAME_CODE_PREFIX.length), 'base64url');
    if (!compressed.length || compressed.length > 5 * 1024 * 1024) throw new Error('Invalid code size');
    payload = JSON.parse(inflateRawSync(compressed, { maxOutputLength: 5 * 1024 * 1024 }).toString('utf8'));
  } catch {
    throw new Error('That game code is damaged or incomplete. Copy the entire code and try again.');
  }
  const game = payload?.game;
  if (payload?.version !== 1 || !game || typeof game.name !== 'string' || !game.name.trim() || game.name.length > 80) throw new Error('The game code is missing a valid game name or uses an unsupported version.');
  if (!Number.isInteger(game.tries) || game.tries < 1 || game.tries > 10 || !Number.isInteger(game.lives) || game.lives < 1 || game.lives > 10) throw new Error('The game code has invalid tries or lives settings.');
  if (!Array.isArray(game.characters) || game.characters.length < 1 || game.characters.length > 500) throw new Error('Imported games must contain between 1 and 500 characters.');
  const seen = new Set();
  for (const character of game.characters) {
    if (!character || typeof character.name !== 'string' || !character.name.trim() || character.name.length > 80 || !Array.isArray(character.hints) || !character.hints.length || character.hints.some(hint => typeof hint !== 'string' || !hint.trim() || hint.length > 250)) throw new Error('The game code contains a character with an invalid name or hints.');
    const key = character.name.trim().toLowerCase();
    if (seen.has(key)) throw new Error('The game code contains duplicate character names: ' + character.name);
    seen.add(key);
    if (character.imageUrl != null) {
      if (typeof character.imageUrl !== 'string' || character.imageUrl.length > 1000) throw new Error('The game code contains an invalid character image URL.');
      try { const url = new URL(character.imageUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid protocol'); }
      catch { throw new Error('The game code contains an invalid character image URL.'); }
    }
    if (character.wikiUrl != null) {
      if (typeof character.wikiUrl !== 'string' || character.wikiUrl.length > 1000) throw new Error('The game code contains an invalid character wiki URL.');
      try { const url = new URL(character.wikiUrl); if (!['https:'].includes(url.protocol) || !/(?:^|\.)fandom\.com$|(?:^|\.)wikia\.org$|(?:^|\.)wiki\.gg$/i.test(url.hostname)) throw new Error('Invalid wiki host'); }
      catch { throw new Error('The game code contains an invalid character wiki URL.'); }
    }
  }
  return { name: game.name.trim(), tries: game.tries, lives: game.lives, characters: game.characters.map(character => ({ name: character.name.trim(), hints: character.hints.map(hint => hint.trim()), ...(character.imageUrl ? { imageUrl: character.imageUrl } : {}), ...(character.wikiUrl ? { wikiUrl: character.wikiUrl } : {}) })) };
}
function gamesPanelPayload(config, categoryNav, gameId = null) {
  const gamesConfig = config?.games ?? {};
  const guessingGames = getConfiguredGuessingGames(gamesConfig);
  const game = gameId ? guessingGames.find(item => item.id === gameId) : null;
  const embed = new EmbedBuilder().setColor(0x5865F2);

  if (!game) {
    embed.setTitle('Guessing games')
      .setDescription('Create and manage independent guessing games. Each game has its own tries, lives, characters, and hints.');
    const summary = guessingGames.length
      ? guessingGames.map(item => '**' + String(item.name).slice(0, 80) + '** — ' + (item.characters?.length ?? 0) + ' character(s), ' + (item.tries ?? 3) + ' tries, ' + (item.lives ?? 3) + ' lives').join('\n').slice(0, 1000)
      : 'No guessing games have been created yet.';
    embed.addFields({ name: 'Configured games', value: summary });
    const options = [
      { label: 'Create a guessing game', value: 'create_game', description: 'Set its name, tries, and lives' },
      { label: 'Import a game code', value: 'import_game', description: 'Create a game from a Conradd4 export code' },
    ];
    guessingGames.slice(0, 24).forEach(item => options.push({
      label: String(item.name).slice(0, 100),
      value: 'open:' + item.id,
      description: (String(item.characters?.length ?? 0) + ' character(s) configured').slice(0, 100),
    }));
    const menu = new StringSelectMenuBuilder()
      .setCustomId('jconfig:games_list_action')
      .setPlaceholder('Create or manage a guessing game')
      .addOptions(options);
    return { content: '', embeds: [embed], components: [categoryNav, new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral };
  }

  const characters = Array.isArray(game.characters) ? game.characters : [];
  embed.setTitle('Guessing game — ' + String(game.name).slice(0, 200))
    .setDescription('Each incorrect guess uses one try and reveals the next hint. If the player runs out of tries, the character is revealed and one life is lost.')
    .addFields(
      { name: 'Tries per character', value: String(game.tries ?? 3), inline: true },
      { name: 'Lives', value: String(game.lives ?? 3), inline: true },
      { name: 'Characters', value: String(characters.length), inline: true },
      { name: 'Configured characters', value: characters.length
        ? characters.slice(0, 12).map(item => '**' + String(item.name).slice(0, 80) + '** — ' + (item.hints?.length ?? 0) + ' hint(s)').join('\n').slice(0, 1000) + (characters.length > 12 ? '\n…and ' + (characters.length - 12) + ' more' : '')
        : 'No characters configured. Add characters and hints before players can use this game.', inline: false },
      { name: 'Character format', value: 'Both Add and Replace use five separate entry fields. Each field accepts one or multiple lines: Character name | hint 1, hint 2 | optional image URL. Add appends; Replace overwrites the full character list with the submitted entries.', inline: false },
    );
  const actions = new StringSelectMenuBuilder()
    .setCustomId('jconfig:games_game_action:' + game.id)
    .setPlaceholder('Configure this guessing game')
    .addOptions(
      { label: 'Edit game settings', value: 'edit_settings', description: 'Change the name, tries per character, and lives' },
      { label: 'Add characters (5 entry fields)', value: 'add_characters', description: 'Add up to five batches of characters without removing existing ones' },
      { label: 'Replace characters (5 entry fields)', value: 'replace_characters', description: 'Overwrite the entire list using up to five entry fields' },
      { label: 'Export game code', value: 'export_game', description: 'Create a shareable code for this game' },
      { label: 'Delete guessing game', value: 'delete_game', description: 'Remove this guessing game' },
    );
  const back = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('jconfig:games_back_list').setLabel('Back to guessing games').setStyle(ButtonStyle.Secondary),
  );
  return { content: '', embeds: [embed], components: [categoryNav, new ActionRowBuilder().addComponents(actions), back], flags: MessageFlags.Ephemeral };
}

function panelPayload(config, category = 'jail', page = 'settings', gamesGameId = null) {
  const jail = config?.jail ?? {};
  const logs = config?.logs ?? {};
  const embed = new EmbedBuilder().setColor(0x5865F2);
  const categoryNav = new ActionRowBuilder().addComponents(
    ...[
      ['jail', 'Jail'],
      ['logs', 'Member Logs'],
      ['twitch', 'Twitch'],
      ['games', 'Games'],
    ].map(([value, label]) => new ButtonBuilder()
      .setCustomId(`jconfig:category:${value}`)
      .setLabel(label)
      .setStyle(category === value ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(category === value))
  );

  if (category === 'games') return gamesPanelPayload(config, categoryNav, gamesGameId);

  if (category === 'logs') {
    embed.setTitle('Logs configuration')
      .setDescription('Choose where the bot logs profile pictures, account usernames, display names, and server nicknames.')
      .addFields({
        name: 'Profile picture, name & nickname changes',
        value: logs.avatarChangesChannelId ? `<#${logs.avatarChangesChannelId}>` : 'Disabled — no channel selected',
        inline: false,
      });
    const logMenu = new StringSelectMenuBuilder().setCustomId('jconfig:log_action').setPlaceholder('Configure member change logs')
      .addOptions(
        { label: 'Choose member change log channel', value: 'set_avatar_changes', description: 'Select a text channel for profile picture, username, display name, and nickname logs' },
        { label: 'Disable member change logs', value: 'disable_avatar_changes', description: 'Stop logging profile picture, username, display name, and nickname changes' },
      );
    return { content: '', embeds: [embed], components: [categoryNav, new ActionRowBuilder().addComponents(logMenu)], flags: MessageFlags.Ephemeral };
  }



  if (category === 'twitch') {
    const twitch = config?.twitch ?? {};
    const streamers = Array.isArray(twitch.streamers) ? twitch.streamers : [];
    const messages = Array.isArray(twitch.liveMessages) && twitch.liveMessages.length
      ? twitch.liveMessages
      : ['{{streameruser}} IS NOW LIVE {{streamlink}}'];
    const streamerSummary = streamers.length
      ? streamers.slice(0, 12).map(item => `• **${String(item.displayName || item.login || 'Twitch user').slice(0, 80)}** (${item.login ? `@${item.login}` : 'account'})${item.isLive ? ' — LIVE' : ''}`).join('\n') + (streamers.length > 12 ? `\n…and ${streamers.length - 12} more` : '')
      : 'No Twitch accounts linked yet.';
    embed.setTitle('Twitch live notifications')
      .setDescription('Link Twitch accounts by username (streamers do not need to sign in). When an account goes live, the bot posts one randomly selected message in the update channel. Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to the bot environment to enable Twitch API access.')
      .addFields(
        { name: `Linked accounts (${streamers.length}/${TWITCH_MAX_STREAMERS_PER_GUILD})`, value: streamerSummary.slice(0, 1024), inline: false },
        { name: 'Twitch update channel', value: twitch.announcementChannelId ? `<#${twitch.announcementChannelId}>` : 'Not configured', inline: true },
        { name: `Random live messages (${messages.length})`, value: messages.slice(0, 4).map((message, index) => `${index + 1}. ${String(message).slice(0, 180)}`).join('\n').slice(0, 1024), inline: false },
        { name: 'Available placeholders', value: '`{{streameruser}}` `{{streamlink}}` `{{streamtitle}}` `{{game}}` `{{viewers}}` `{{started}}`', inline: false },
      );
    const twitchMenu = new StringSelectMenuBuilder().setCustomId('jconfig:twitch_action').setPlaceholder('Choose a Twitch setting')
      .addOptions(
        { label: 'Link Twitch account', value: 'link_streamer', description: 'Add a Twitch username to monitor' },
        { label: 'Unlink Twitch account', value: 'unlink_streamer', description: 'Stop monitoring a linked Twitch account' },
        { label: 'Choose update channel', value: 'set_channel', description: 'Select where live notifications are posted' },
        { label: 'Edit random live messages', value: 'edit_messages', description: 'Set up to 10 message templates, one per line' },
        { label: 'Disable update channel', value: 'clear_channel', description: 'Stop posting Twitch live notifications' },
      );
    return { content: '', embeds: [embed], components: [categoryNav, new ActionRowBuilder().addComponents(twitchMenu)], flags: MessageFlags.Ephemeral };
  }

  embed.setTitle('Jail configuration');
  const nav = new ActionRowBuilder().addComponents(
    ...[
      ['settings', 'Settings'],
      ['roles', 'Roles'],
      ['channels', 'Channels'],
      ['logs', 'Logs'],
      ['messages', 'Messages'],
      ['sound', 'Jail Sound'],
    ].map(([value, label]) => new ButtonBuilder()
      .setCustomId(`jconfig:page:${value}`)
      .setLabel(label)
      .setStyle(page === value ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(page === value))
  );
  if (page === 'sound') {
    const configured = Boolean(jail.voiceSoundUrl || (jail.voiceSoundChannelId && jail.voiceSoundMessageId));
    const status = !configured ? 'No sound uploaded' : (jail.voiceSoundEnabled ? 'Enabled' : 'Uploaded, disabled');
    embed.setTitle('Jail voice sound')
      .setDescription('Upload a sound with the optional jail_sound_file attachment on /config. The bot plays it in the member\'s voice channel when they are jailed, then disconnects that member after playback finishes. If the bot is already connected to voice elsewhere, playback is skipped and the member is left connected.')
      .addFields(
        { name: 'Status', value: status, inline: true },
        { name: 'Current file', value: jail.voiceSoundFileName || 'None uploaded', inline: true },
        { name: 'Upload requirements', value: 'MP3, WAV, OGG, OPUS, M4A, AAC, FLAC, or WEBM\nMaximum file size: 15 MB\nMaximum playback length: 60 seconds', inline: false },
        { name: 'Required permissions', value: 'View Channel, Connect, Speak, and Move Members', inline: false },
      );
    const soundActions = new StringSelectMenuBuilder()
      .setCustomId('jconfig:jail_sound_action')
      .setPlaceholder('Configure the voice jail sound')
      .addOptions(
        { label: 'Upload or replace sound', value: 'upload_help', description: 'Run /config and attach the jail_sound_file option' },
        ...(configured ? [{ label: jail.voiceSoundEnabled ? 'Disable voice jail sound' : 'Enable voice jail sound', value: 'toggle', description: 'Turn the uploaded sound on or off' }] : []),
        ...(configured ? [{ label: 'Remove uploaded sound', value: 'clear', description: 'Delete the saved sound file and disable playback' }] : []),
      );
    return { content: '', embeds: [embed], components: [categoryNav, nav, new ActionRowBuilder().addComponents(soundActions)], flags: MessageFlags.Ephemeral };
  }

  let controls = [];
  if (page === 'settings') {
    embed.setDescription('Configure jail durations and evidence defaults.')
      .addFields(
        { name: 'Default sentence', value: formatDuration(jail.defaultSentenceSeconds), inline: true },
        { name: 'Minimum sentence', value: formatDuration(jail.minimumSentenceSeconds ?? 600), inline: true },
        { name: 'Evidence messages', value: String(jail.evidenceMessageCount ?? 5), inline: true },
        { name: 'Default evidence note', value: jail.defaultMessage ? jail.defaultMessage.slice(0, 1000) : 'None', inline: false },
      );
    const editableSettings = SETTINGS.filter(setting => ['default_seconds', 'minimum_seconds', 'evidence_count', 'default_message'].includes(setting.value));
    const settingsMenu = new StringSelectMenuBuilder().setCustomId('jconfig:setting_choice')
      .setPlaceholder('Choose a jail setting to change')
      .addOptions(editableSettings.map(setting => ({
        label: setting.label,
        value: setting.value,
        description: setting.description,
      })));
    controls = [new ActionRowBuilder().addComponents(settingsMenu)];
  } else if (page === 'roles') {
    const jailRoleIds = (Array.isArray(jail.roles) ? jail.roles : []).map(item => item?.roleId).filter(Boolean);
    const policemanRoleIds = Array.isArray(jail.policemanRoleIds) ? jail.policemanRoleIds : [];
    embed.setDescription('Manage which roles are used by the jail system. Role pickers are paginated and searchable.')
      .addFields(
        { name: 'Jail roles', value: summarizeRoleIds(jailRoleIds), inline: false },
        { name: 'Lawyer role', value: jail.lawyerRoleId ? `<@&${jail.lawyerRoleId}>` : 'None configured', inline: true },
        { name: 'Policeman roles', value: summarizeRoleIds(policemanRoleIds), inline: false },
      );
    const roleMenu = new StringSelectMenuBuilder().setCustomId('jconfig:role_action').setPlaceholder('Choose a role action')
      .addOptions(
        { label: 'Add jail roles', value: 'add_jail_roles', description: 'Register existing server roles as jail roles' },
        { label: 'Set lawyer role', value: 'set_lawyer', description: 'Choose the lawyer role' },
        { label: 'Choose policeman roles', value: 'set_policeman', description: 'Select multiple roles; choose none to clear' },
        { label: 'Remove roles', value: 'remove_roles', description: 'Unassign or delete configured roles' },
      );
    controls = [new ActionRowBuilder().addComponents(roleMenu)];
  } else if (page === 'logs') {
    embed.setDescription('Configure where jail-related command activity and configuration changes are recorded.')
      .addFields(
        { name: 'Jail logs channel', value: jail.logsChannelId ? `<#${jail.logsChannelId}>` : 'Not configured', inline: false },
        { name: 'What gets logged', value: 'Jail and unjail command activity, command errors, and jail configuration changes.', inline: false },
      );
    const jailLogsMenu = new StringSelectMenuBuilder().setCustomId('jconfig:jail_logs_action').setPlaceholder('Configure jail logs')
      .addOptions(
        { label: 'Choose jail logs channel', value: 'set', description: 'Select the channel where jail logs are posted' },
        { label: 'Disable jail logs', value: 'disable', description: 'Stop posting jail logs to a channel' },
      );
    controls = [new ActionRowBuilder().addComponents(jailLogsMenu)];
  } else if (page === 'channels') {
    const roleChannelCount = (Array.isArray(jail.roles) ? jail.roles : []).filter(item => item?.roleId && item?.channelId).length;
    embed.setDescription('All jail channel and category settings are managed here, separately from role settings.')
      .addFields(
        { name: 'Default jail channel', value: jail.channelId ? `<#${jail.channelId}>` : 'None configured', inline: true },
        { name: 'Jail category', value: jail.categoryId ? `<#${jail.categoryId}>` : 'None configured', inline: true },
        { name: 'Evidence forum', value: jail.evidenceForumId ? `<#${jail.evidenceForumId}>` : 'None configured', inline: true },
        { name: 'Announcement channel', value: jail.actionLogChannelId ? `<#${jail.actionLogChannelId}>` : 'None configured', inline: true },
        { name: 'Role-specific jail channels', value: roleChannelCount ? `${roleChannelCount} role-specific channel assignment(s). Use the paginated role selector to browse or search all jail roles.` : 'No role-specific jail channels configured', inline: false },
      );
    const channelMenu = new StringSelectMenuBuilder().setCustomId('jconfig:channel_action').setPlaceholder('Choose a channel setting')
      .addOptions(
        { label: 'Default jail channel', value: 'default_jail', description: 'Choose the default channel for jailed members' },
        { label: 'Jail category', value: 'category', description: 'Choose the category for jail channels' },
        { label: 'Evidence forum', value: 'evidence_forum', description: 'Choose where jail evidence is stored' },
        { label: 'Announcement channel', value: 'announcement', description: 'Choose where jail and unjail announcements are posted' },
        { label: 'Role-specific jail channel', value: 'role_channel', description: 'Assign a channel to a specific jail role' },
      );
    controls = [new ActionRowBuilder().addComponents(channelMenu)];
  } else {
    embed.setDescription('Customize the messages sent when members are jailed or released.')
      .addFields(
        { name: 'Jail announcement', value: (jail.jailAnnouncement || '{{user}} HAS BEEN JAILED').slice(0, 1000), inline: false },
        { name: 'Unjail announcement', value: (jail.unjailAnnouncement || '{{user}} HAS BEEN UNJAILED').slice(0, 1000), inline: false },
        { name: 'Announcement channel', value: jail.actionLogChannelId ? `<#${jail.actionLogChannelId}>` : 'Not configured', inline: true },
        { name: 'Placeholders', value: '`{{user}}` `{{server}}` `{{moderator}}` `{{role}}` `{{reason}}` `{{duration}}` `{{roles}}`', inline: false },
      );
    const messageMenu = new StringSelectMenuBuilder().setCustomId('jconfig:message_choice').setPlaceholder('Choose a message to edit')
      .addOptions(
        { label: 'Jail message', value: 'jail_announcement', description: 'Customize the message when a member is jailed' },
        { label: 'Unjail message', value: 'unjail_announcement', description: 'Customize the message when a member is released' },
      );
    controls = [new ActionRowBuilder().addComponents(messageMenu)];
  }
  return { content: '', embeds: [embed], components: [categoryNav, nav, ...controls], flags: MessageFlags.Ephemeral };
}

async function logConfigSave(interaction, jail, title, details) {
  const logsChannelId = jail?.logsChannelId;
  if (!logsChannelId) return;
  const logsChannel = await interaction.guild.channels.fetch(logsChannelId).catch(() => null);
  if (!logsChannel?.isTextBased?.() || !logsChannel.send) return;
  await logsChannel.send({
    embeds: [{
      color: 0x5865F2,
      title: `Configuration saved: ${title}`,
      description: `**Staff:** <@${interaction.user.id}> (${interaction.user.id})\n${details}`,
      timestamp: new Date().toISOString(),
    }],
    allowedMentions: { parse: [] },
  }).catch(() => null);
}


async function getJailChannelOptions(guild, jail = {}) {
  const categoryId = jail.categoryId ?? null;
  const channels = await guild.channels.fetch();
  const configuredIds = new Set([
    jail.channelId,
    ...(jail.roles ?? []).map(item => item?.channelId),
  ].filter(Boolean));
  const jailRoleIds = new Set((jail.roles ?? []).map(item => item?.roleId).filter(Boolean));
  const hasJailRoleOverwrite = channel => {
    const directOverwrite = channel.permissionOverwrites?.cache?.some(overwrite => jailRoleIds.has(overwrite.id));
    const categoryOverwrite = channel.parent?.permissionOverwrites?.cache?.some(overwrite => jailRoleIds.has(overwrite.id));
    return Boolean(directOverwrite || categoryOverwrite);
  };
  return [...channels.values()].filter(channel =>
    channel.type === ChannelType.GuildText && (
      configuredIds.has(channel.id) ||
      (categoryId && channel.parentId === categoryId) ||
      hasJailRoleOverwrite(channel)
    )
  ).sort((a, b) => a.name.localeCompare(b.name));
}

function jailChannelMenu(roleId, page, channels) {
  const pageCount = Math.max(1, Math.ceil(channels.length / CONFIG_CHANNEL_ROLE_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, Number(page) || 0), pageCount - 1);
  const options = channels
    .slice(safePage * CONFIG_CHANNEL_ROLE_PAGE_SIZE, (safePage + 1) * CONFIG_CHANNEL_ROLE_PAGE_SIZE)
    .map(channel => ({
      label: channel.name.slice(0, 100),
      value: channel.id,
      description: channel.parent?.name ? `In ${channel.parent.name}`.slice(0, 100) : 'Jail channel',
    }));
  if (!options.length) options.push({ label: 'No jail channels found', value: '__no_channels__', description: 'Set the jail category or channel permissions', disabled: true });
  return {
    menu: new StringSelectMenuBuilder()
      .setCustomId(`jconfig:channel_pick:${roleId}:${safePage}`)
      .setPlaceholder(`Choose a jail channel (page ${safePage + 1}/${pageCount})`)
      .setMinValues(0)
      .setMaxValues(1)
      .addOptions(options),
    page: safePage,
    pageCount,
  };
}

function jailChannelPickerComponents(roleId, picker) {
  return [
    new ActionRowBuilder().addComponents(picker.menu),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`jconfig:channel_page:${roleId}:${picker.page}:prev`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(picker.page <= 0),
      new ButtonBuilder().setCustomId(`jconfig:channel_page:${roleId}:${picker.page}:next`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(picker.page >= picker.pageCount - 1),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`jconfig:channel_default:${roleId}`).setLabel('Use default jail channel').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

const CHANNEL_PICKER_PAGE_SIZE = 23;

async function getSelectableChannels(guild, type) {
  const channels = await guild.channels.fetch();
  return [...channels.values()]
    .filter(channel => channel.type === type)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildPaginatedChannelPicker(key, page, channels) {
  const pageCount = Math.max(1, Math.ceil(channels.length / CHANNEL_PICKER_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const options = channels
    .slice(safePage * CHANNEL_PICKER_PAGE_SIZE, (safePage + 1) * CHANNEL_PICKER_PAGE_SIZE)
    .map(channel => ({
      label: channel.name.slice(0, 100),
      value: channel.id,
      description: channel.parent?.name
        ? `In ${channel.parent.name}`.slice(0, 100)
        : 'Server channel',
    }));

  if (safePage > 0) {
    options.push({ label: '← Previous page', value: '__previous_page__', description: 'Show the previous set' });
  }
  if (safePage < pageCount - 1) {
    options.push({ label: 'Next page →', value: '__next_page__', description: 'Show more channels' });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`jconfig:pick_channel:${key}:${safePage}`)
    .setPlaceholder(`Choose ${({
      categoryId: 'a category',
      channelId: 'a text channel',
      evidenceForumId: 'an evidence forum',
      actionLogChannelId: 'an announcement channel',
      logsChannelId: 'a jail configuration log channel',
      avatarChangesChannelId: 'a member change log channel',
      twitchAnnouncementChannelId: 'a Twitch update channel',
    })[key] ?? 'a channel'} (page ${safePage + 1}/${pageCount})`)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return {
    menu,
    content: `Choose the ${({
      categoryId: 'jail category',
      channelId: 'default jail channel',
      evidenceForumId: 'jail evidence forum',
      actionLogChannelId: 'announcement channel',
      logsChannelId: 'jail configuration log channel',
      avatarChangesChannelId: 'member change log channel',
      twitchAnnouncementChannelId: 'Twitch update channel',
    })[key] ?? 'channel'} — page ${safePage + 1} of ${pageCount} (${channels.length} available).`,
  };
}

async function saveJailRoleChannel(interaction, client, roleId, channelId) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  const { getGuildConfig } = await import('../../services/config/guildConfig.js');
  const current = await getGuildConfig(client, interaction.guildId);
  const jail = { ...(current?.jail ?? {}) };
  const roles = Array.isArray(jail.roles) ? [...jail.roles] : [];
  const index = roles.findIndex(item => item?.roleId === roleId);
  if (index < 0) return interaction.editReply({ content: 'That role is no longer registered as a jail role. Nothing was changed.', embeds: [], components: [] });
  const previousChannelId = roles[index]?.channelId ?? null;
  if (channelId) {
    const selectedChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    const allowedJailChannels = await getJailChannelOptions(interaction.guild, jail);
    if (!selectedChannel || selectedChannel.type !== ChannelType.GuildText || !allowedJailChannels.some(channel => channel.id === channelId)) return interaction.editReply({ content: 'That channel is not registered as a jail channel. Use a channel in the jail category, the default jail channel, or a channel with jail-role permissions.', embeds: [], components: [] });
    roles[index] = { ...roles[index], roleId, channelId };
  } else {
    roles[index] = { ...roles[index], roleId, channelId: null };
  }
  jail.roles = roles;
  const defaultChannelId = jail.channelId ?? null;
  const channelIds = [...new Set([defaultChannelId, previousChannelId, ...roles.map(item => item?.channelId).filter(Boolean)].filter(Boolean))];
  const roleIds = roles.map(item => item?.roleId).filter(Boolean);
  for (const id of channelIds) {
    const channel = await interaction.guild.channels.fetch(id).catch(() => null);
    if (!channel?.permissionOverwrites || channel.type !== ChannelType.GuildText) continue;
    for (const configuredRoleId of roleIds) {
      const configured = roles.find(item => item?.roleId === configuredRoleId);
      const effectiveChannelId = configured?.channelId || defaultChannelId;
      const canView = effectiveChannelId === channel.id;
      await channel.permissionOverwrites.edit(configuredRoleId, canView
        ? { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, EmbedLinks: false }
        : { ViewChannel: false }, 'Update jail role channel from /config');
    }
  }
  await updateGuildConfig(client, interaction.guildId, { jail });
  await logConfigSave(interaction, jail, 'Jail role channel', `**Role:** <@&${roleId}>\n**Channel:** ${channelId ? `<#${channelId}>` : 'Default jail channel'}`);
  return interaction.editReply({
    content: channelId
      ? `Saved: <@&${roleId}> now uses <#${channelId}>. Other configured jail roles are denied access to that role-specific channel.`
      : `Saved: <@&${roleId}> now falls back to the default jail channel ${defaultChannelId ? `<#${defaultChannelId}>` : '(not configured yet)'}.`,
    embeds: [],
    components: [],
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('View and change server configuration, including jail and games.')
    .addAttachmentOption(option => option
      .setName('jail_sound_file')
      .setDescription('Upload or replace the sound played when someone is jailed in voice chat.')
      .setRequired(false))
    .addAttachmentOption(option => option
      .setName('guessing_game_file')
      .setDescription('Import a .txt or .c4g file exported by Conradd4.')
      .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction, guildConfig, client) {
    if (!interaction.inGuild() || !interaction.guild) {
      return interaction.reply({ content: 'USE THIS COMMAND IN A SERVER.', flags: MessageFlags.Ephemeral });
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'ONLY ADMINISTRATORS CAN CHANGE SERVER CONFIGURATION.', flags: MessageFlags.Ephemeral });
    }

    const gameAttachment = interaction.options.getAttachment('guessing_game_file');
    if (gameAttachment) {
      const fileName = String(gameAttachment.name || 'guessing-game.txt');
      if (!/\.(?:txt|c4g)$/i.test(fileName)) {
        return interaction.reply({ content: 'UPLOAD THE GAME EXPORT AS A .TXT OR .C4G FILE.', flags: MessageFlags.Ephemeral });
      }
      if (Number(gameAttachment.size) > 8 * 1024 * 1024) {
        return interaction.reply({ content: 'THE GAME CODE FILE MUST BE 8 MB OR SMALLER.', flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const sourceUrl = new URL(gameAttachment.url);
        if (sourceUrl.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(sourceUrl.hostname)) {
          return interaction.editReply({ content: 'DISCORD DID NOT PROVIDE A VALID UPLOAD URL.' });
        }
        const response = await fetch(gameAttachment.url, { signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`Discord attachment download returned HTTP ${response.status}.`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length || buffer.length > 8 * 1024 * 1024) {
          return interaction.editReply({ content: 'THE GAME CODE FILE MUST BE NON-EMPTY AND 8 MB OR SMALLER.' });
        }
        let imported = decodeGuessingGameCode(buffer.toString('utf8'));
        const { getGuildConfig } = await import('../../services/config/guildConfig.js');
        const current = await getGuildConfig(client, interaction.guildId);
        const games = { ...(current?.games ?? {}) };
        const guessingGames = getConfiguredGuessingGames(games);
        if (guessingGames.length >= 25) return interaction.editReply({ content: 'This server has reached the limit of 25 guessing games. Delete one before importing another.' });
        if (guessingGames.some(game => String(game.name).toLowerCase() === imported.name.toLowerCase())) {
          return interaction.editReply({ content: 'A guessing game with that name already exists. Rename or delete the existing game before importing this one.' });
        }
        const gameId = randomUUID().replace(/-/g, '').slice(0, 8);
        guessingGames.push({ id: gameId, ...imported });
        games.guessingGames = guessingGames;
        delete games.guessingCategories;
        await updateGuildConfig(client, interaction.guildId, { games });
        await logConfigSave(interaction, current?.jail, 'Guessing game imported', '**Game:** ' + imported.name + '\\n**Characters:** ' + imported.characters.length);
        return interaction.editReply({
          content: 'Imported **' + imported.name + '** with **' + imported.characters.length + ' characters**.',
          embeds: panelPayload({ ...(current ?? {}), games }, 'games', 'settings', gameId).embeds,
          components: panelPayload({ ...(current ?? {}), games }, 'games', 'settings', gameId).components,
        });
      } catch (error) {
        return interaction.editReply({ content: error.message || 'Could not import that game file.' });
      }
    }

    const soundAttachment = interaction.options.getAttachment('jail_sound_file');
    if (!soundAttachment) return interaction.reply(panelPayload(guildConfig ?? {}, 'jail', 'settings'));

    const allowedExtensions = new Set(['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'webm']);
    const fileName = String(soundAttachment.name || 'jail-sound.mp3');
    const extension = fileName.split('.').pop()?.toLowerCase();
    const maxBytes = 15 * 1024 * 1024;
    if (!allowedExtensions.has(extension)) {
      return interaction.reply({ content: 'UPLOAD AN AUDIO FILE SUCH AS MP3, WAV, OGG, OPUS, M4A, AAC, FLAC, OR WEBM.', flags: MessageFlags.Ephemeral });
    }
    if (Number(soundAttachment.size) > maxBytes) {
      return interaction.reply({ content: 'THE JAIL SOUND FILE MUST BE 15 MB OR SMALLER.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let storedMessage = null;
    try {
      const sourceUrl = new URL(soundAttachment.url);
      if (sourceUrl.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(sourceUrl.hostname)) {
        return interaction.editReply({ content: 'DISCORD DID NOT PROVIDE A VALID AUDIO UPLOAD URL.' });
      }
      const response = await fetch(soundAttachment.url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`Discord attachment download returned HTTP ${response.status}.`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > maxBytes) {
        return interaction.editReply({ content: 'THE JAIL SOUND FILE MUST BE NON-EMPTY AND 15 MB OR SMALLER.' });
      }

      const jail = { ...(guildConfig?.jail ?? {}) };
      const preferredChannel = jail.logsChannelId
        ? await interaction.guild.channels.fetch(jail.logsChannelId).catch(() => null)
        : null;
      const storageChannels = [preferredChannel, interaction.channel].filter((channel, index, list) =>
        channel && list.findIndex(item => item?.id === channel.id) === index
      );
      const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 90) || 'jail-sound.mp3';
      for (const channel of storageChannels) {
        if (!channel.isTextBased?.() || typeof channel.send !== 'function') continue;
        try {
          storedMessage = await channel.send({
            content: 'JAIL VOICE SOUND FILE STORED.',
            files: [{ attachment: buffer, name: safeFileName }],
            allowedMentions: { parse: [] },
          });
          if (storedMessage.attachments.first()?.url) break;
          storedMessage = null;
        } catch {
          storedMessage = null;
        }
      }
      const savedAttachment = storedMessage?.attachments.first();
      if (!storedMessage || !savedAttachment?.url) {
        return interaction.editReply({ content: 'I COULD NOT STORE THE AUDIO FILE. GIVE THE BOT VIEW CHANNEL, SEND MESSAGES, AND ATTACH FILES IN THE JAIL CONFIG LOGS CHANNEL OR RUN /CONFIG IN A CHANNEL WHERE IT CAN SEND FILES.' });
      }

      const oldChannelId = jail.voiceSoundChannelId;
      const oldMessageId = jail.voiceSoundMessageId;
      const updatedJail = {
        ...jail,
        voiceSoundEnabled: true,
        voiceSoundUrl: savedAttachment.url,
        voiceSoundFileName: safeFileName,
        voiceSoundChannelId: storedMessage.channelId,
        voiceSoundMessageId: storedMessage.id,
      };
      try {
        await updateGuildConfig(interaction.client, interaction.guildId, { jail: updatedJail });
      } catch (error) {
        await storedMessage.delete().catch(() => null);
        throw error;
      }

      if (oldChannelId && oldMessageId) {
        const oldChannel = await interaction.guild.channels.fetch(oldChannelId).catch(() => null);
        const oldMessage = oldChannel?.messages?.fetch
          ? await oldChannel.messages.fetch(oldMessageId).catch(() => null)
          : null;
        if (oldMessage) await oldMessage.delete().catch(() => null);
      }
      await logConfigSave(interaction, updatedJail, 'Jail voice sound uploaded', `**File:** ${safeFileName}\n**Status:** Enabled`);
      return interaction.editReply({ content: `JAIL VOICE SOUND SAVED: ${safeFileName.toUpperCase()}. IT WILL PLAY WHEN A JAILED MEMBER IS IN A VOICE CHANNEL, THEN DISCONNECT THEM AFTER PLAYBACK FINISHES.` });
    } catch (error) {
      if (storedMessage) await storedMessage.delete().catch(() => null);
      return interaction.editReply({ content: `COULD NOT SAVE THE JAIL SOUND FILE: ${String(error?.message ?? error).slice(0, 500).toUpperCase()}` });
    }
  },

  async handleComponent(interaction, client) {
    const isComponent = interaction.isButton?.() || interaction.isStringSelectMenu?.() || interaction.isRoleSelectMenu?.() || interaction.isChannelSelectMenu?.();
    const opensModal = (interaction.isStringSelectMenu?.() && (
      interaction.customId === 'jconfig:message_choice' ||
      (interaction.customId === 'jconfig:games_list_action' && ['create_game', 'import_game'].includes(interaction.values?.[0])) ||
      (interaction.customId?.startsWith('jconfig:games_game_action:') && ['edit_settings', 'edit_characters', 'add_characters', 'replace_characters', 'export_game'].includes(interaction.values?.[0])) ||
      (interaction.customId === 'jconfig:twitch_action' && ['link_streamer', 'unlink_streamer', 'edit_messages'].includes(interaction.values?.[0])) ||
      (interaction.customId?.startsWith('jconfig:') && SETTINGS.some(setting => setting.value === interaction.values?.[0]))
    )) || (interaction.isButton?.() && (
      interaction.customId?.startsWith('jconfig:role_control:') && interaction.customId.endsWith(':search') ||
      interaction.customId?.startsWith('jconfig:remove_control:') && interaction.customId.endsWith(':search') ||
      interaction.customId?.startsWith('jconfig:channel_role_control:') && interaction.customId.endsWith(':search')
    ));
    if (isComponent && interaction.customId?.startsWith('jconfig:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
        return true;
      }
      // Acknowledge immediately, before database reads, Discord fetches, or permission updates.
      if (!opensModal && !interaction.deferred && !interaction.replied) if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    }
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:category:')) {
      const category = interaction.customId.slice('jconfig:category:'.length);
      if (!['jail', 'sound', 'logs', 'twitch', 'games'].includes(category)) return interaction.editReply({ content: 'Invalid configuration category.', embeds: [], components: [] });
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      return interaction.editReply(panelPayload(current ?? {}, category, 'settings'));
    }
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:page:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const page = interaction.customId.slice('jconfig:page:'.length);
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      return interaction.editReply(panelPayload(current ?? {}, 'jail', page));
    }

    if (interaction.isButton() && interaction.customId === 'jconfig:games_back_list') {
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      return interaction.editReply(panelPayload(current ?? {}, 'games'));
    }
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:games_confirm_delete_game:')) {
      const gameId = interaction.customId.slice('jconfig:games_confirm_delete_game:'.length);
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const games = { ...(current?.games ?? {}) };
      const guessingGames = getConfiguredGuessingGames(games);
      const removed = guessingGames.find(item => item.id === gameId);
      if (!removed) return interaction.editReply({ content: 'That guessing game no longer exists.', embeds: [], components: [] });
      games.guessingGames = guessingGames.filter(item => item.id !== gameId);
      delete games.guessingCategories;
      await updateGuildConfig(client, interaction.guildId, { games });
      await logConfigSave(interaction, current?.jail, 'Guessing game deleted', '**Game:** ' + removed.name);
      return interaction.editReply(panelPayload({ ...(current ?? {}), games }, 'games'));
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'jconfig:games_list_action') {
      const action = interaction.values[0];
      if (action === 'import_game') {
        const modal = new ModalBuilder().setCustomId('jconfigmodal:games_import_game').setTitle('Import guessing game');
        const input = new TextInputBuilder().setCustomId('game_code').setLabel('Paste the complete game code').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000);
        input.setPlaceholder('C4G1:...');
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }
      if (action === 'create_game') {
        const modal = new ModalBuilder().setCustomId('jconfigmodal:games_create_game').setTitle('Create guessing game');
        const name = new TextInputBuilder().setCustomId('game_name').setLabel('Guessing game name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80);
        const tries = new TextInputBuilder().setCustomId('tries').setLabel('Tries per character (1–10)').setStyle(TextInputStyle.Short).setRequired(true).setValue('3').setMaxLength(2);
        const lives = new TextInputBuilder().setCustomId('lives').setLabel('Lives (1–10)').setStyle(TextInputStyle.Short).setRequired(true).setValue('3').setMaxLength(2);
        modal.addComponents(new ActionRowBuilder().addComponents(name), new ActionRowBuilder().addComponents(tries), new ActionRowBuilder().addComponents(lives));
        return interaction.showModal(modal);
      }
      if (action.startsWith('open:')) {
        const gameId = action.slice('open:'.length);
        const { getGuildConfig } = await import('../../services/config/guildConfig.js');
        const current = await getGuildConfig(client, interaction.guildId);
        return interaction.editReply(panelPayload(current ?? {}, 'games', 'settings', gameId));
      }
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('jconfig:games_game_action:')) {
      const gameId = interaction.customId.slice('jconfig:games_game_action:'.length);
      const action = interaction.values[0];
      if (action === 'add_characters' || action === 'replace_characters') {
        const isReplace = action === 'replace_characters';
        const modal = new ModalBuilder()
          .setCustomId('jconfigmodal:games_' + action + ':' + gameId)
          .setTitle(isReplace ? 'Replace character list' : 'Add characters');
        const inputs = Array.from({ length: 5 }, (_, index) => new TextInputBuilder()
          .setCustomId('character_' + (index + 1))
          .setLabel('Character entry ' + (index + 1))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(4000)
          .setPlaceholder('Name | hint 1, hint 2 | optional image URL'));
        modal.addComponents(...inputs.map(input => new ActionRowBuilder().addComponents(input)));
        return interaction.showModal(modal);
      }
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const game = getConfiguredGuessingGames(current?.games ?? {}).find(item => item.id === gameId);
      if (action === 'export_game' && game) {
        const code = encodeGuessingGameCode(game);
        const filename = String(game.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'guessing-game';
        const file = new AttachmentBuilder(Buffer.from(code, 'utf8'), { name: filename + '-game-code.txt' });
        return interaction.reply({ content: '**Game code exported:** ' + game.name + '\nImport this file’s code under /config → Games → Import a game code.', files: [file], flags: MessageFlags.Ephemeral });
      }
      if (!game) return interaction.editReply({ content: 'That guessing game no longer exists.', embeds: [], components: [] });
      if (action === 'edit_settings') {
        const modal = new ModalBuilder().setCustomId('jconfigmodal:games_edit_game:' + gameId).setTitle('Edit guessing game');
        const name = new TextInputBuilder().setCustomId('game_name').setLabel('Guessing game name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(game.name);
        const tries = new TextInputBuilder().setCustomId('tries').setLabel('Tries per character (1–10)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2).setValue(String(game.tries ?? 3));
        const lives = new TextInputBuilder().setCustomId('lives').setLabel('Lives (1–10)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2).setValue(String(game.lives ?? 3));
        modal.addComponents(new ActionRowBuilder().addComponents(name), new ActionRowBuilder().addComponents(tries), new ActionRowBuilder().addComponents(lives));
        return interaction.showModal(modal);
      }
      if (action === 'delete_game') {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('jconfig:games_confirm_delete_game:' + gameId).setLabel('Confirm delete').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('jconfig:games_cancel_delete_game:' + gameId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        );
        return interaction.editReply({ content: 'Delete the guessing game **' + game.name + '** and its character list?', embeds: [], components: [row] });
      }
    }
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:games_cancel_delete_game:')) {
      const gameId = interaction.customId.slice('jconfig:games_cancel_delete_game:'.length);
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      return interaction.editReply(panelPayload(current ?? {}, 'games', 'settings', gameId));
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'jconfig:jail_logs_action') {
      const action = interaction.values[0];
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current?.jail ?? {}) };
      if (action === 'disable') {
        jail.logsChannelId = null;
        await updateGuildConfig(client, interaction.guildId, { jail });
        return interaction.editReply(panelPayload({ ...(current ?? {}), jail }, 'jail', 'logs'));
      }
      if (action !== 'set') return interaction.editReply({ content: 'Invalid jail logs setting.', embeds: [], components: [] });
      const channels = await getSelectableChannels(interaction.guild, ChannelType.GuildText);
      if (!channels.length) return interaction.editReply({ content: 'No text channels were found in this server.', embeds: [], components: [] });
      const picker = buildPaginatedChannelPicker('logsChannelId', 0, channels);
      return interaction.editReply({ content: picker.content, embeds: [], components: [new ActionRowBuilder().addComponents(picker.menu)] });
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'jconfig:log_action') {
      const action = interaction.values[0];
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      if (action === 'disable_avatar_changes') {
        const logs = { ...(current?.logs ?? {}), avatarChangesChannelId: null };
        await updateGuildConfig(client, interaction.guildId, { logs });
        return interaction.editReply({ content: 'Profile picture change logging is disabled.', embeds: [], components: [] });
      }
      if (action !== 'set_avatar_changes') return interaction.editReply({ content: 'Invalid log setting.', embeds: [], components: [] });
      const channels = await getSelectableChannels(interaction.guild, ChannelType.GuildText);
      if (!channels.length) return interaction.editReply({ content: 'No text channels were found in this server.', embeds: [], components: [] });
      const picker = buildPaginatedChannelPicker('avatarChangesChannelId', 0, channels);
      return interaction.editReply({ content: picker.content, embeds: [], components: [new ActionRowBuilder().addComponents(picker.menu)] });
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'jconfig:jail_sound_action') {
      const action = interaction.values[0];
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current?.jail ?? {}) };
      if (action === 'upload_help') {
        return interaction.editReply({ content: 'RUN /CONFIG AND ATTACH YOUR AUDIO FILE IN THE JAIL SOUND FILE OPTION. SUPPORTED FORMATS INCLUDE MP3, WAV, OGG, OPUS, M4A, AAC, FLAC, AND WEBM.', embeds: [], components: [] });
      }
      if (action === 'toggle') {
        if (!jail.voiceSoundUrl) return interaction.editReply({ content: 'UPLOAD A JAIL SOUND FILE FIRST USING /CONFIG JAIL_SOUND_FILE.', embeds: [], components: [] });
        jail.voiceSoundEnabled = !jail.voiceSoundEnabled;
        await updateGuildConfig(client, interaction.guildId, { jail });
        await logConfigSave(interaction, jail, jail.voiceSoundEnabled ? 'Jail voice sound enabled' : 'Jail voice sound disabled', `**File:** ${jail.voiceSoundFileName || 'Configured sound'}`);
        const updated = { ...(current ?? {}), jail };
        return interaction.editReply(panelPayload(updated, 'jail', 'sound'));
      }
      if (action === 'clear') {
        const oldChannelId = jail.voiceSoundChannelId;
        const oldMessageId = jail.voiceSoundMessageId;
        jail.voiceSoundEnabled = false;
        jail.voiceSoundUrl = null;
        jail.voiceSoundFileName = null;
        jail.voiceSoundChannelId = null;
        jail.voiceSoundMessageId = null;
        await updateGuildConfig(client, interaction.guildId, { jail });
        if (oldChannelId && oldMessageId) {
          const oldChannel = await interaction.guild.channels.fetch(oldChannelId).catch(() => null);
          const oldMessage = oldChannel?.messages?.fetch
            ? await oldChannel.messages.fetch(oldMessageId).catch(() => null)
            : null;
          if (oldMessage) await oldMessage.delete().catch(() => null);
        }
        await logConfigSave(interaction, jail, 'Jail voice sound removed', '**File:** Removed');
        return interaction.editReply(panelPayload({ ...(current ?? {}), jail }, 'jail', 'sound'));
      }
      return interaction.editReply({ content: 'INVALID JAIL SOUND SETTING.', embeds: [], components: [] });
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'jconfig:twitch_action') {
      const action = interaction.values[0];
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const twitch = current?.twitch ?? {};
      if (action === 'link_streamer' || action === 'unlink_streamer') {
        const modal = new ModalBuilder()
          .setCustomId(`jconfigmodal:twitch_${action === 'link_streamer' ? 'link' : 'unlink'}`)
          .setTitle(action === 'link_streamer' ? 'Link Twitch account' : 'Unlink Twitch account');
        const input = new TextInputBuilder()
          .setCustomId('twitch_username')
          .setLabel('Twitch username')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(25)
          .setPlaceholder('Enter the Twitch username, without the URL');
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return true;
      }
      if (action === 'edit_messages') {
        const existingMessages = Array.isArray(twitch.liveMessages) && twitch.liveMessages.length
          ? twitch.liveMessages.join('\n')
          : '{{streameruser}} IS NOW LIVE {{streamlink}}';
        const modal = new ModalBuilder().setCustomId('jconfigmodal:twitch_messages').setTitle('Edit Twitch live messages');
        const input = new TextInputBuilder()
          .setCustomId('twitch_messages')
          .setLabel('One message template per line (up to 10)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(4000)
          .setValue(existingMessages.slice(0, 4000))
          .setPlaceholder('{{streameruser}} HAS WENT LIVE {{streamlink}}');
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return true;
      }
      if (action === 'set_channel') {
        const channels = await getSelectableChannels(interaction.guild, ChannelType.GuildText);
        if (!channels.length) return interaction.editReply({ content: 'No text channels were found in this server.', embeds: [], components: [] });
        const picker = buildPaginatedChannelPicker('twitchAnnouncementChannelId', 0, channels);
        return interaction.editReply({ content: picker.content, embeds: [], components: [new ActionRowBuilder().addComponents(picker.menu)] });
      }
      if (action === 'clear_channel') {
        await updateGuildConfig(client, interaction.guildId, { twitch: { ...twitch, announcementChannelId: null } });
        await logConfigSave(interaction, current?.jail, 'Twitch update channel disabled', '**Channel:** Disabled');
        return interaction.editReply({ content: 'Twitch live notifications are disabled because no update channel is selected.', embeds: [], components: [] });
      }
      return interaction.editReply({ content: 'Invalid Twitch setting.', embeds: [], components: [] });
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'jconfig:channel_action') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const action = interaction.values[0];
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      if (action === 'role_channel') {
        const roles = (current?.jail?.roles ?? []).filter(item => item?.roleId);
        if (!roles.length) return interaction.editReply({ content: 'No jail roles are configured yet. Add jail roles on the Roles page first.', embeds: [], components: [] });
        const ids = [...new Set(roles.map(item => item.roleId))];
        const guildRoles = (await Promise.all(ids.map(id => interaction.guild.roles.fetch(id).catch(() => null)))).filter(Boolean);
        const state = { roles: guildRoles, selectedIds: [], page: 0, mode: 'single', searchQuery: '' };
        pendingChannelRolePickers.set(`${interaction.guildId}:${interaction.user.id}`, state);
        const picker = buildPaginatedRoleMenu('jconfig:channel_role_page:0', 'Choose a configured jail role', state);
        return interaction.editReply({ content: `Choose the jail role whose channel you want to change. Page 1 of ${picker.pageCount}.`, embeds: [], components: [
          new ActionRowBuilder().addComponents(picker.menu),
          buildRolePagerControls('jconfig:channel_role_control', state),
        ] });
      }
      const settings = {
        default_jail: { key: 'channelId', label: 'Default jail channel', type: ChannelType.GuildText },
        category: { key: 'categoryId', label: 'Jail category', type: ChannelType.GuildCategory },
        evidence_forum: { key: 'evidenceForumId', label: 'Evidence forum', type: ChannelType.GuildForum },
        announcement: { key: 'actionLogChannelId', label: 'Announcement channel', type: ChannelType.GuildText },
      };
      const setting = settings[action];
      if (!setting) return false;
      if (['default_jail', 'category', 'evidence_forum', 'announcement'].includes(action)) {
        const channels = await getSelectableChannels(interaction.guild, setting.type);
        if (!channels.length) {
          const emptyLabels = {
            default_jail: 'text channels',
            category: 'categories',
            evidence_forum: 'forum channels',
            announcement: 'text channels',
          };
          return interaction.editReply({
            content: `No ${emptyLabels[action]} were found in this server.`,
            embeds: [],
            components: [],
          });
        }
        const picker = buildPaginatedChannelPicker(setting.key, 0, channels);
        return interaction.editReply({ content: picker.content, embeds: [], components: [new ActionRowBuilder().addComponents(picker.menu)] });
      }
      const channels = await getSelectableChannels(interaction.guild, setting.type);
      if (!channels.length) return interaction.editReply({ content: `No ${setting.label.toLowerCase()} options were found in this server.`, embeds: [], components: [] });
      const picker = buildPaginatedChannelPicker(setting.key, 0, channels);
      return interaction.editReply({ content: picker.content, embeds: [], components: [new ActionRowBuilder().addComponents(picker.menu)] });
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('jconfig:pick_channel:')) {
      const [, , key, pageValue] = interaction.customId.split(':');
      const setting = {
        channelId: { label: 'Default jail channel', type: ChannelType.GuildText },
        categoryId: { label: 'Jail category', type: ChannelType.GuildCategory },
        evidenceForumId: { label: 'Evidence forum', type: ChannelType.GuildForum },
        actionLogChannelId: { label: 'Announcement channel', type: ChannelType.GuildText },
        logsChannelId: { label: 'Jail configuration logs channel', type: ChannelType.GuildText },
        avatarChangesChannelId: { label: 'Profile picture log channel', type: ChannelType.GuildText },
        twitchAnnouncementChannelId: { label: 'Twitch update channel', type: ChannelType.GuildText },
      }[key] ?? null;
      if (!setting) return interaction.editReply({ content: 'Invalid channel setting.', embeds: [], components: [] });

      const selected = interaction.values[0];
      const currentPage = Number.parseInt(pageValue, 10) || 0;
      if (selected === '__previous_page__' || selected === '__next_page__') {
        const channels = await getSelectableChannels(interaction.guild, setting.type);
        const nextPage = selected === '__previous_page__' ? currentPage - 1 : currentPage + 1;
        const picker = buildPaginatedChannelPicker(key, nextPage, channels);
        return interaction.editReply({ content: picker.content, embeds: [], components: [new ActionRowBuilder().addComponents(picker.menu)] });
      }

      const selectedChannel = await interaction.guild.channels.fetch(selected).catch(() => null);
      if (!selectedChannel || selectedChannel.type !== setting.type) {
        return interaction.editReply({ content: `That is not a valid ${setting.label.toLowerCase()}.`, embeds: [], components: [] });
      }
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      if (key === 'avatarChangesChannelId') {
        const logs = { ...(current?.logs ?? {}), avatarChangesChannelId: selectedChannel.id };
        await updateGuildConfig(client, interaction.guildId, { logs });
        return interaction.editReply({
          content: `Saved member change log channel: <#${selectedChannel.id}>.`,
          embeds: [],
          components: [],
        });
      }
      if (key === 'twitchAnnouncementChannelId') {
        const twitch = { ...(current?.twitch ?? {}), announcementChannelId: selectedChannel.id };
        await updateGuildConfig(client, interaction.guildId, { twitch });
        await logConfigSave(interaction, current?.jail, 'Twitch update channel', `**Channel:** <#${selectedChannel.id}>`);
        return interaction.editReply({ content: `Saved Twitch update channel: <#${selectedChannel.id}>.`, embeds: [], components: [] });
      }
      const jail = { ...(current?.jail ?? {}), [key]: selectedChannel.id };
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, setting.label, `**Selection:** <#${selectedChannel.id}>`);
      return interaction.editReply({
        content: `Saved ${setting.label.toLowerCase()}: <#${selectedChannel.id}>.`,
        embeds: [],
        components: [],
      });
    }
    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('jconfig:set_channel:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const key = interaction.customId.slice('jconfig:set_channel:'.length);
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current?.jail ?? {}), [key]: interaction.values[0] };
      const labels = { channelId: 'Default jail channel', categoryId: 'Jail category', evidenceForumId: 'Evidence forum', logsChannelId: 'Jail logs channel', actionLogChannelId: 'Announcement channel' };
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, labels[key] || 'Channel setting', `**Channel:** <#${interaction.values[0]}>`);
      return interaction.editReply({ content: `Saved ${labels[key] || 'channel'}: <#${interaction.values[0]}>.`, embeds: [], components: [] });
    }
    if (interaction.isChannelSelectMenu() && interaction.customId === 'jconfig:action_log_channel') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current?.jail ?? {}), actionLogChannelId: interaction.values[0] };
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, 'Jail/unjail announcement channel', `**Channel:** <#${interaction.values[0]}>`);
      return interaction.editReply({ content: `Saved announcement channel: <#${interaction.values[0]}>.`, embeds: [], components: [] });
    }
    if (interaction.customId === 'jconfig:message_choice' && interaction.isStringSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const field = interaction.values[0];
      const setting = SETTINGS.find(item => item.value === field);
      if (!setting || !['jail_announcement', 'unjail_announcement'].includes(field)) return interaction.editReply({ content: 'Invalid message setting.', flags: MessageFlags.Ephemeral });
      const modal = new ModalBuilder().setCustomId(`jconfigmodal:${field}`).setTitle(`Edit ${setting.label}`);
      const input = new TextInputBuilder().setCustomId('setting_value').setLabel('Message template')
        .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
        .setPlaceholder('Leave empty to restore the default message');
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('jconfig:channel_role_page:')) {
      const key = `${interaction.guildId}:${interaction.user.id}`;
      const state = pendingChannelRolePickers.get(key);
      if (!state) return interaction.editReply({ content: 'That role picker expired. Choose the role again from /config.', embeds: [], components: [] });
      const selectedRoleId = interaction.values[0];
      const entry = (await (async () => {
        const { getGuildConfig } = await import('../../services/config/guildConfig.js');
        const current = await getGuildConfig(client, interaction.guildId);
        return (current?.jail?.roles ?? []).find(item => item?.roleId === selectedRoleId);
      })());
      if (!entry) return interaction.editReply({ content: 'That role is not currently registered as a jail role.', embeds: [], components: [] });
      pendingChannelRolePickers.delete(key);
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const channels = await getJailChannelOptions(interaction.guild, current?.jail ?? {});
      if (!channels.length) return interaction.editReply({ content: 'No jail channels found. Set the jail category first, or run /setup-jail to create the jail channels.', embeds: [], components: [] });
      const picker = jailChannelMenu(selectedRoleId, 0, channels);
      return interaction.editReply({
        content: `Choose a jail channel for <@&${selectedRoleId}>. Page ${picker.page + 1} of ${picker.pageCount} (${channels.length} available).`,
        embeds: [],
        components: jailChannelPickerComponents(selectedRoleId, picker),
      });
    }
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:channel_role_control:')) {
      const control = interaction.customId.split(':').at(-1);
      const key = `${interaction.guildId}:${interaction.user.id}`;
      const state = pendingChannelRolePickers.get(key);
      if (!state) return interaction.editReply({ content: 'That role picker expired. Choose the role again from /config.', embeds: [], components: [] });
      if (control === 'search') {
        const modal = new ModalBuilder().setCustomId('jconfigmodal:role_search:channel_role').setTitle('Search jail roles');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('role_query').setLabel('Role name contains').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100).setPlaceholder('Leave empty to show all roles')));
        await interaction.showModal(modal);
        return true;
      }
      if (control === 'clear_search') state.searchQuery = '';
      else if (control === 'prev') state.page = Math.max(0, state.page - 1);
      else if (control === 'next') state.page = Math.min(Math.max(0, Math.ceil(getFilteredRoleChoices(state).length / CONFIG_ROLE_PAGE_SIZE) - 1), state.page + 1);
      pendingChannelRolePickers.set(key, state);
      const picker = buildPaginatedRoleMenu(`jconfig:channel_role_page:${state.page}`, 'Choose a configured jail role', state);
      return interaction.editReply({ content: `Choose the jail role whose channel you want to change. Page ${picker.page + 1} of ${picker.pageCount}.`, embeds: [], components: [
        new ActionRowBuilder().addComponents(picker.menu),
        buildRolePagerControls('jconfig:channel_role_control', state),
      ] });
    }
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:channel_page:')) {
      const [, , roleId, pageValue, control] = interaction.customId.split(':');
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = current?.jail ?? {};
      const registered = (jail.roles ?? []).some(item => item?.roleId === roleId);
      if (!registered) return interaction.editReply({ content: 'That role is no longer registered as a jail role.', embeds: [], components: [] });
      const channels = await getJailChannelOptions(interaction.guild, jail);
      if (!channels.length) return interaction.editReply({ content: 'No jail channels found. Set the jail category first, or run /setup-jail to create the jail channels.', embeds: [], components: [] });
      const currentPage = Number.parseInt(pageValue, 10) || 0;
      const pageCount = Math.max(1, Math.ceil(channels.length / CONFIG_CHANNEL_ROLE_PAGE_SIZE));
      const nextPage = Math.min(Math.max(0, currentPage + (control === 'prev' ? -1 : 1)), pageCount - 1);
      const picker = jailChannelMenu(roleId, nextPage, channels);
      return interaction.editReply({
        content: `Choose a jail channel for <@&${roleId}>. Page ${picker.page + 1} of ${picker.pageCount} (${channels.length} available).`,
        embeds: [],
        components: jailChannelPickerComponents(roleId, picker),
      });
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('jconfig:channel_pick:')) {
      const [, , roleId] = interaction.customId.split(':');
      const selectedChannelId = interaction.values[0];
      if (!selectedChannelId || selectedChannelId === '__no_channels__') {
        return interaction.editReply({ content: 'Select a jail channel from the list.', embeds: [], components: interaction.message.components });
      }
      await saveJailRoleChannel(interaction, client, roleId, selectedChannelId);
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:channel_default:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const roleId = interaction.customId.slice('jconfig:channel_default:'.length);
      await saveJailRoleChannel(interaction, client, roleId, null);
      return true;
    }
    if (interaction.customId === 'jconfig:role_action' && interaction.isStringSelectMenu()) {
      const action = interaction.values[0];
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = current?.jail ?? {};
      if (action === 'set_policeman' || action === 'add_jail_roles' || action === 'set_lawyer') {
        const allRoles = await interaction.guild.roles.fetch();
        const roleChoices = [...allRoles.values()].filter(role => role.id !== interaction.guildId && !role.managed).sort((a, b) => a.name.localeCompare(b.name));
        if (!roleChoices.length) return interaction.editReply({ content: 'No selectable server roles were found.', embeds: [], components: [] });
        const state = { roles: roleChoices, selectedIds: [], page: 0, mode: action === 'set_lawyer' ? 'single' : 'multiple', searchQuery: '' };
        pendingRoleSelections.set(`${interaction.guildId}:${interaction.user.id}:${action}`, state);
        const placeholder = action === 'set_policeman' ? 'Choose policeman roles' : action === 'add_jail_roles' ? 'Choose jail roles to register' : 'Choose the lawyer role';
        const picker = buildPaginatedRoleMenu(`jconfig:role_page:${action}:0`, placeholder, state);
        const instructions = action === 'set_policeman'
          ? 'Select policeman roles across pages. Save with none selected to clear all policeman roles.'
          : action === 'add_jail_roles'
            ? 'Select existing server roles to register as jail roles across pages.'
            : 'Select one existing server role to use as the lawyer role.';
        return interaction.editReply({ content: `${instructions} Page 1 of ${picker.pageCount}.`, embeds: [], components: [
          new ActionRowBuilder().addComponents(picker.menu),
          buildRolePagerControls(`jconfig:role_control:${action}`, state, { clearSelection: true }),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`jconfig:save_roles:${action}`).setLabel('Save').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`jconfig:cancel_roles:${action}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          ),
        ] });
      }
      const configuredIds = [...new Set([
        ...(jail.roles ?? []).map(item => item?.roleId).filter(Boolean),
        jail.lawyerRoleId,
        ...(jail.policemanRoleIds ?? []),
      ].filter(Boolean))];
      const configuredRoles = (await Promise.all(configuredIds.map(id => interaction.guild.roles.fetch(id).catch(() => null)))).filter(Boolean);
      if (!configuredRoles.length) return interaction.editReply({ content: 'There are no configured jail, lawyer, or policeman roles to remove.', embeds: [], components: [] });
      const state = { roles: configuredRoles, selectedIds: [], page: 0, mode: 'multiple', searchQuery: '', descriptionForRole: role => [
        (jail.roles ?? []).some(item => item?.roleId === role.id) ? 'Jail' : '',
        jail.lawyerRoleId === role.id ? 'Lawyer' : '',
        (jail.policemanRoleIds ?? []).includes(role.id) ? 'Policeman' : '',
      ].filter(Boolean).join(' / ') };
      pendingRoleRemovals.set(`${interaction.guildId}:${interaction.user.id}`, state);
      const picker = buildPaginatedRoleMenu('jconfig:remove_page:0', 'Choose configured roles to remove', state);
      return interaction.editReply({ content: `Select configured roles across pages. Selected: 0. Page 1 of ${picker.pageCount}.`, embeds: [], components: [
        new ActionRowBuilder().addComponents(picker.menu),
        buildRolePagerControls('jconfig:remove_control', state, { clearSelection: true }),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('jconfig:remove_keep').setLabel('Remove from configuration only').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('jconfig:remove_delete').setLabel('Remove and delete roles').setStyle(ButtonStyle.Danger),
        ),
      ] });
    }
    const pendingSelectionKey = `${interaction.guildId}:${interaction.user.id}`;
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('jconfig:role_page:')) {
      const [, , action, pageValue] = interaction.customId.split(':');
      const key = `${pendingSelectionKey}:${action}`;
      const state = pendingRoleSelections.get(key);
      if (!state) return interaction.editReply({ content: 'That role selection expired. Open /config and try again.', embeds: [], components: [] });
      state.page = Number.parseInt(pageValue, 10) || 0;
      updatePagedRoleSelection(state, state.page, interaction.values);
      const placeholder = action === 'set_policeman' ? 'Choose policeman roles' : action === 'add_jail_roles' ? 'Choose jail roles to register' : 'Choose the lawyer role';
      const picker = buildPaginatedRoleMenu(`jconfig:role_page:${action}:${state.page}`, placeholder, state);
      return interaction.editReply({ content: `Selected ${state.selectedIds.length} role(s). Page ${picker.page + 1} of ${picker.pageCount}.`, embeds: [], components: [
        new ActionRowBuilder().addComponents(picker.menu),
        buildRolePagerControls(`jconfig:role_control:${action}`, state, { clearSelection: true }),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`jconfig:save_roles:${action}`).setLabel('Save').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`jconfig:cancel_roles:${action}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        ),
      ] });
    }
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:role_control:')) {
      const [, , action, control] = interaction.customId.split(':');
      const key = `${pendingSelectionKey}:${action}`;
      const state = pendingRoleSelections.get(key);
      if (!state) return interaction.editReply({ content: 'That role selection expired. Open /config and try again.', embeds: [], components: [] });
      if (control === 'search') {
        const modal = new ModalBuilder().setCustomId(`jconfigmodal:role_search:${action}`).setTitle('Search server roles');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('role_query').setLabel('Role name contains').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100).setPlaceholder('Leave empty to show all roles')));
        await interaction.showModal(modal);
        return true;
      }
      if (control === 'clear') state.selectedIds = [];
      else if (control === 'clear_search') { state.searchQuery = ''; state.page = 0; }
      else {
        const pageCount = Math.max(1, Math.ceil(getFilteredRoleChoices(state).length / CONFIG_ROLE_PAGE_SIZE));
        state.page = Math.min(Math.max(0, state.page + (control === 'prev' ? -1 : 1)), pageCount - 1);
      }
      const placeholder = action === 'set_policeman' ? 'Choose policeman roles' : action === 'add_jail_roles' ? 'Choose jail roles to register' : 'Choose the lawyer role';
      const picker = buildPaginatedRoleMenu(`jconfig:role_page:${action}:${state.page}`, placeholder, state);
      return interaction.editReply({ content: `Selected ${state.selectedIds.length} role(s). Page ${picker.page + 1} of ${picker.pageCount}.`, embeds: [], components: [
        new ActionRowBuilder().addComponents(picker.menu),
        buildRolePagerControls(`jconfig:role_control:${action}`, state, { clearSelection: true }),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`jconfig:save_roles:${action}`).setLabel('Save').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`jconfig:cancel_roles:${action}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        ),
      ] });
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('jconfig:remove_page:')) {
      const state = pendingRoleRemovals.get(pendingSelectionKey);
      if (!state) return interaction.editReply({ content: 'That role selection expired. Open /config and try again.', embeds: [], components: [] });
      state.page = Number.parseInt(interaction.customId.split(':').at(-1), 10) || 0;
      updatePagedRoleSelection(state, state.page, interaction.values);
      const picker = buildPaginatedRoleMenu(`jconfig:remove_page:${state.page}`, 'Choose configured roles to remove', state);
      return interaction.editReply({ content: `Selected ${state.selectedIds.length} role(s). Page ${picker.page + 1} of ${picker.pageCount}. Choose whether to unassign them only or also delete the Discord roles.`, embeds: [], components: [
        new ActionRowBuilder().addComponents(picker.menu),
        buildRolePagerControls('jconfig:remove_control', state, { clearSelection: true }),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('jconfig:remove_keep').setLabel('Remove from configuration only').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('jconfig:remove_delete').setLabel('Remove and delete roles').setStyle(ButtonStyle.Danger),
        ),
      ] });
    }
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:remove_control:')) {
      const control = interaction.customId.split(':').at(-1);
      const state = pendingRoleRemovals.get(pendingSelectionKey);
      if (!state) return interaction.editReply({ content: 'That role selection expired. Open /config and try again.', embeds: [], components: [] });
      if (control === 'search') {
        const modal = new ModalBuilder().setCustomId('jconfigmodal:role_search:remove').setTitle('Search configured roles');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('role_query').setLabel('Role name contains').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100).setPlaceholder('Leave empty to show all roles')));
        await interaction.showModal(modal);
        return true;
      }
      if (control === 'clear') state.selectedIds = [];
      else if (control === 'clear_search') { state.searchQuery = ''; state.page = 0; }
      else {
        const pageCount = Math.max(1, Math.ceil(getFilteredRoleChoices(state).length / CONFIG_ROLE_PAGE_SIZE));
        state.page = Math.min(Math.max(0, state.page + (control === 'prev' ? -1 : 1)), pageCount - 1);
      }
      const picker = buildPaginatedRoleMenu(`jconfig:remove_page:${state.page}`, 'Choose configured roles to remove', state);
      return interaction.editReply({ content: `Selected ${state.selectedIds.length} role(s). Page ${picker.page + 1} of ${picker.pageCount}.`, embeds: [], components: [
        new ActionRowBuilder().addComponents(picker.menu),
        buildRolePagerControls('jconfig:remove_control', state, { clearSelection: true }),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('jconfig:remove_keep').setLabel('Remove from configuration only').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('jconfig:remove_delete').setLabel('Remove and delete roles').setStyle(ButtonStyle.Danger),
        ),
      ] });
    }
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:cancel_roles:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const action = interaction.customId.slice('jconfig:cancel_roles:'.length);
      pendingRoleSelections.delete(`${pendingSelectionKey}:${action}`);
      return interaction.editReply({ content: 'Role changes cancelled. Nothing was saved.', embeds: [], components: [] });
    }
    let savingRoleAction = null;
    let selectedRoleIds = null;
    if (interaction.isButton() && interaction.customId.startsWith('jconfig:save_roles:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      savingRoleAction = interaction.customId.slice('jconfig:save_roles:'.length);
      const roleSelection = pendingRoleSelections.get(`${pendingSelectionKey}:${savingRoleAction}`);
      selectedRoleIds = Array.isArray(roleSelection) ? roleSelection : roleSelection?.selectedIds;
      if (!selectedRoleIds) return interaction.editReply({ content: 'That role selection expired. Please select the roles again.', embeds: [], components: [] });
      pendingRoleSelections.delete(`${pendingSelectionKey}:${savingRoleAction}`);
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    }
    if ((interaction.customId === 'jconfig:add_jail_roles' && interaction.isRoleSelectMenu()) || savingRoleAction === 'add_jail_roles') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      if (interaction.isRoleSelectMenu()) if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current?.jail ?? {}) };
      const existing = Array.isArray(jail.roles) ? [...jail.roles] : [];
      const selectedIds = selectedRoleIds ?? [...new Set(interaction.values)].filter(id => id !== interaction.guildId);
      if (!selectedIds.length) return interaction.editReply({ content: 'No jail roles selected. Nothing was changed.', embeds: [], components: [] });
      const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.editReply({ content: 'I need Manage Roles permission to configure jail roles.', embeds: [], components: [] });
      const roles = (await Promise.all(selectedIds.map(id => interaction.guild.roles.fetch(id).catch(() => null)))).filter(Boolean);
      if (roles.length !== selectedIds.length || roles.some(role => role.managed || role.permissions.has(PermissionFlagsBits.Administrator) || botMember.roles.highest.comparePositionTo(role) <= 0)) {
        return interaction.editReply({ content: 'One or more selected roles are missing, managed, have Administrator permission, or are above my highest role.', embeds: [], components: [] });
      }
      const channelId = jail.channelId ?? null;
      for (const role of roles) {
        if (!existing.some(item => item?.roleId === role.id)) existing.push({ roleId: role.id, channelId: null });
      }
      jail.roles = existing;
      // Apply jail visibility to existing resources, matching setup behavior without changing unrelated settings.
      const channels = await interaction.guild.channels.fetch();
      for (const category of channels.filter(channel => channel.type === ChannelType.GuildCategory && channel.id !== jail.categoryId).values()) {
        for (const role of roles) await category.permissionOverwrites.edit(role.id, { ViewChannel: false }, 'Register jail role from /config');
      }
      for (const resourceId of [jail.categoryId, channelId].filter(Boolean)) {
        const resource = await interaction.guild.channels.fetch(resourceId).catch(() => null);
        if (!resource?.permissionOverwrites) continue;
        for (const role of roles) {
          await resource.permissionOverwrites.edit(role.id, resourceId === channelId
            ? { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, EmbedLinks: false }
            : { ViewChannel: true, ReadMessageHistory: true }, 'Register jail role from /config');
        }
      }
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, 'Jail roles added', `**Role count:** ${roles.length}\n**Roles:** ${formatRoleMentions(roles.map(role => role.id), 2500)}`);
      return interaction.editReply({ content: `Registered ${roles.length} jail role(s): ${formatRoleMentions(roles.map(role => role.id), 1000)}. They use the default jail channel ${channelId ? `<#${channelId}>` : '(not configured)'} unless assigned a role-specific channel.`, embeds: [], components: [] });
    }
    if ((interaction.customId === 'jconfig:lawyer_role' && interaction.isRoleSelectMenu()) || savingRoleAction === 'set_lawyer') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const roleId = (selectedRoleIds ?? interaction.values)[0];
      if (!roleId) return interaction.editReply({ content: 'No lawyer role was selected. Nothing was changed.', embeds: [], components: [] });
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current?.jail ?? {}) };
      const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.editReply({ content: 'I need Manage Roles permission to configure the lawyer role.', embeds: [], components: [] });
      const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
      if (!role || role.id === interaction.guildId || role.managed || botMember.roles.highest.comparePositionTo(role) <= 0) {
        return interaction.editReply({ content: 'Choose a valid, manageable server role below my highest role.', embeds: [], components: [] });
      }
      if (role.permissions.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'The lawyer role cannot have Administrator permission.', embeds: [], components: [] });
      const previousId = jail.lawyerRoleId ?? null;
      if (previousId && previousId !== role.id) {
        for (const resourceId of [jail.categoryId, jail.channelId, jail.evidenceForumId].filter(Boolean)) {
          const resource = await interaction.guild.channels.fetch(resourceId).catch(() => null);
          if (resource?.permissionOverwrites) await resource.permissionOverwrites.delete(previousId, 'Replace configured lawyer role').catch(() => null);
        }
      }
      jail.lawyerRoleId = role.id;
      for (const resourceId of [jail.categoryId, jail.channelId, jail.evidenceForumId].filter(Boolean)) {
        const resource = await interaction.guild.channels.fetch(resourceId).catch(() => null);
        if (resource?.permissionOverwrites) await resource.permissionOverwrites.edit(role.id, { ViewChannel: true, ReadMessageHistory: true }, 'Configure lawyer role from /config');
      }
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, 'Lawyer role', `**Role:** <@&${role.id}>`);
      return interaction.editReply({ content: `Saved lawyer role: <@&${role.id}>. It can view the configured jail category, jail channel, and evidence forum.`, embeds: [], components: [] });
    }
    if ((interaction.customId === 'jconfig:policeman_roles' && interaction.isRoleSelectMenu()) || savingRoleAction === 'set_policeman') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const roleIds = selectedRoleIds ?? interaction.values;
      const jail = { ...(current.jail ?? {}), policemanRoleIds: roleIds };
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, 'Policeman roles', `**Role count:** ${roleIds.length}\n**Roles:** ${formatRoleMentions(roleIds, 2500)}`);
      return interaction.editReply({ content: `Saved ${roleIds.length} policeman role(s): ${formatRoleMentions(roleIds, 1000)}.`, embeds: [], components: [] });
    }
    if ((interaction.customId === 'jconfig:remove_keep' || interaction.customId === 'jconfig:remove_delete') && interaction.isButton()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const key = `${interaction.guildId}:${interaction.user.id}`;
      const removalState = pendingRoleRemovals.get(key);
      const selected = Array.isArray(removalState) ? removalState : (removalState?.selectedIds ?? []);
      if (!selected.length) return interaction.editReply({ content: 'That role selection expired or no roles were selected. Open /config and try again.', embeds: [], components: [] });
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current.jail ?? {}) };
      const configured = new Set([
        ...(jail.roles ?? []).map(item => item?.roleId).filter(Boolean),
        jail.lawyerRoleId,
        ...(jail.policemanRoleIds ?? []),
      ]);
      const removable = selected.filter(id => configured.has(id));
      if (!removable.length) {
        pendingRoleRemovals.delete(key);
        return interaction.editReply({ content: 'None of the selected roles are currently configured. Nothing was changed.', embeds: [], components: [] });
      }
      jail.roles = (jail.roles ?? []).filter(item => !removable.includes(item?.roleId));
      if (removable.includes(jail.lawyerRoleId)) jail.lawyerRoleId = null;
      jail.policemanRoleIds = (jail.policemanRoleIds ?? []).filter(id => !removable.includes(id));
      let rolesToDelete = [];
      if (interaction.customId === 'jconfig:remove_delete') {
        const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.editReply({ content: 'I need Manage Roles permission to delete Discord roles.', flags: MessageFlags.Ephemeral });
        rolesToDelete = (await Promise.all(removable.map(id => interaction.guild.roles.fetch(id).catch(() => null)))).filter(Boolean);
        const blocked = rolesToDelete.filter(role => role.managed || botMember.roles.highest.comparePositionTo(role) <= 0);
        if (blocked.length) return interaction.editReply({ content: `I cannot delete these roles. Move my highest role above them and check that they are not managed roles: ${blocked.map(role => role.name).join(', ')}.`, flags: MessageFlags.Ephemeral });
      }
      // Remove only the selected roles' old jail-resource overwrites; leave every other role and channel setting intact.
      for (const channelId of [jail.categoryId, jail.channelId, jail.evidenceForumId].filter(Boolean)) {
        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.permissionOverwrites) continue;
        for (const id of removable) await channel.permissionOverwrites.delete(id, 'Role unassigned from jail configuration').catch(() => null);
      }
      for (const role of rolesToDelete) await role.delete('Role removed from jail configuration by an administrator');
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, 'Roles removed', `**Role count:** ${removable.length}\n**Roles:** ${formatRoleMentions(removable, 2500)}\n**Discord roles deleted:** ${interaction.customId === 'jconfig:remove_delete' ? 'Yes, where permitted' : 'No'}`);
      pendingRoleRemovals.delete(key);
      return interaction.editReply({ content: `Removed ${removable.length} role(s) from jail configuration${interaction.customId === 'jconfig:remove_delete' ? ' and deleted the Discord roles where permitted' : ''}.`, embeds: [], components: [] });
    }
    if (interaction.customId.startsWith('jconfig:') && interaction.isStringSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
        return true;
      }
      const field = interaction.values[0];
      const setting = SETTINGS.find(s => s.value === field);
      if (!setting) return false;
      const modal = new ModalBuilder()
        .setCustomId(`jconfigmodal:${field}`)
        .setTitle(`Change ${setting.label}`);
      const input = new TextInputBuilder()
        .setCustomId('setting_value')
        .setLabel(field === 'default_seconds' ? 'Seconds, or INFINITE' : field === 'default_message' ? 'Message text (or CLEAR)' : ['jail_announcement', 'unjail_announcement'].includes(field) ? 'Announcement template' : 'Value')
        .setStyle(['default_message', 'jail_announcement', 'unjail_announcement'].includes(field) ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(!['default_message', 'jail_announcement', 'unjail_announcement'].includes(field))
        .setMaxLength(['default_message', 'jail_announcement', 'unjail_announcement'].includes(field) ? 1000 : 20);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('jconfigmodal:role_search:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
      const kind = interaction.customId.slice('jconfigmodal:role_search:'.length);
      const query = interaction.fields.getTextInputValue('role_query').trim();
      if (kind === 'remove') {
        const state = pendingRoleRemovals.get(pendingSelectionKey);
        if (!state) return interaction.reply({ content: 'That role selection expired. Open /config and try again.', flags: MessageFlags.Ephemeral });
        state.searchQuery = query; state.page = 0;
        const picker = buildPaginatedRoleMenu('jconfig:remove_page:0', 'Choose configured roles to remove', state);
        return interaction.update({ content: `Search: ${query || 'All roles'}. Selected ${state.selectedIds.length} role(s). Page 1 of ${picker.pageCount}.`, embeds: [], components: [
          new ActionRowBuilder().addComponents(picker.menu),
          buildRolePagerControls('jconfig:remove_control', state, { clearSelection: true }),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('jconfig:remove_keep').setLabel('Remove from configuration only').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('jconfig:remove_delete').setLabel('Remove and delete roles').setStyle(ButtonStyle.Danger),
          ),
        ] });
      }
      if (kind === 'channel_role') {
        const state = pendingChannelRolePickers.get(pendingSelectionKey);
        if (!state) return interaction.reply({ content: 'That role picker expired. Choose the role again from /config.', flags: MessageFlags.Ephemeral });
        state.searchQuery = query; state.page = 0;
        const picker = buildPaginatedRoleMenu('jconfig:channel_role_page:0', 'Choose a configured jail role', state);
        return interaction.update({ content: `Search: ${query || 'All roles'}. Choose the jail role whose channel you want to change. Page 1 of ${picker.pageCount}.`, embeds: [], components: [
          new ActionRowBuilder().addComponents(picker.menu),
          buildRolePagerControls('jconfig:channel_role_control', state),
        ] });
      }
      const state = pendingRoleSelections.get(`${pendingSelectionKey}:${kind}`);
      if (!state) return interaction.reply({ content: 'That role selection expired. Open /config and try again.', flags: MessageFlags.Ephemeral });
      state.searchQuery = query; state.page = 0;
      const placeholder = kind === 'set_policeman' ? 'Choose policeman roles' : kind === 'add_jail_roles' ? 'Choose jail roles to register' : 'Choose the lawyer role';
      const picker = buildPaginatedRoleMenu(`jconfig:role_page:${kind}:0`, placeholder, state);
      return interaction.update({ content: `Search: ${query || 'All roles'}. Selected ${state.selectedIds.length} role(s). Page 1 of ${picker.pageCount}.`, embeds: [], components: [
        new ActionRowBuilder().addComponents(picker.menu),
        buildRolePagerControls(`jconfig:role_control:${kind}`, state, { clearSelection: true }),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`jconfig:save_roles:${kind}`).setLabel('Save').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`jconfig:cancel_roles:${kind}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        ),
      ] });
    }

    if (interaction.isModalSubmit() && interaction.customId === 'jconfigmodal:games_import_game') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Only administrators can import game configuration.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const games = { ...(current?.games ?? {}) };
      const guessingGames = getConfiguredGuessingGames(games);
      if (guessingGames.length >= 25) return interaction.editReply({ content: 'This server has reached the limit of 25 guessing games. Delete one before importing another.' });
      let imported;
      try {
        imported = decodeGuessingGameCode(interaction.fields.getTextInputValue('game_code'));
      } catch (error) { return interaction.editReply({ content: error.message || 'Could not import that game code.' }); }
      if (guessingGames.some(game => String(game.name).toLowerCase() === imported.name.toLowerCase())) return interaction.editReply({ content: 'A guessing game with that name already exists. Rename or delete the existing game before importing this one.' });
      const gameId = randomUUID().replace(/-/g, '').slice(0, 8);
      guessingGames.push({ id: gameId, ...imported });
      games.guessingGames = guessingGames;
      delete games.guessingCategories;
      await updateGuildConfig(client, interaction.guildId, { games });
      await logConfigSave(interaction, current?.jail, 'Guessing game imported', '**Game:** ' + imported.name + '\n**Characters:** ' + imported.characters.length);
      return interaction.editReply({ ...panelPayload({ ...(current ?? {}), games }, 'games', 'settings', gameId), content: 'Imported **' + imported.name + '** with ' + imported.characters.length + ' character(s).' });
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('jconfigmodal:games_')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Only administrators can change game configuration.', flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const games = { ...(current?.games ?? {}) };
      const guessingGames = getConfiguredGuessingGames(games);
      const parts = interaction.customId.split(':');
      const action = parts[1].slice('games_'.length);

      if (action === 'create_game' || action === 'edit_game') {
        const gameName = interaction.fields.getTextInputValue('game_name').trim();
        const triesRaw = interaction.fields.getTextInputValue('tries').trim();
        const livesRaw = interaction.fields.getTextInputValue('lives').trim();
        if (!gameName) return interaction.editReply({ content: 'Enter a name for the guessing game.' });
        if (!/^(?:[1-9]|10)$/.test(triesRaw) || !/^(?:[1-9]|10)$/.test(livesRaw)) {
          return interaction.editReply({ content: 'Tries and lives must each be a whole number from 1 to 10.' });
        }
        const gameId = action === 'edit_game' ? parts[2] : null;
        if (guessingGames.some(item => item.id !== gameId && String(item.name).toLowerCase() === gameName.toLowerCase())) {
          return interaction.editReply({ content: 'A guessing game with that name already exists.' });
        }
        let selectedGameId = gameId;
        if (action === 'create_game') {
          if (guessingGames.length >= 25) return interaction.editReply({ content: 'This server has reached the limit of 25 guessing games.' });
          selectedGameId = randomUUID().replace(/-/g, '').slice(0, 8);
          guessingGames.push({ id: selectedGameId, name: gameName, tries: Number(triesRaw), lives: Number(livesRaw), characters: [] });
        } else {
          const game = guessingGames.find(item => item.id === gameId);
          if (!game) return interaction.editReply({ content: 'That guessing game no longer exists.' });
          Object.assign(game, { name: gameName, tries: Number(triesRaw), lives: Number(livesRaw) });
        }
        games.guessingGames = guessingGames;
        delete games.guessingCategories;
        await updateGuildConfig(client, interaction.guildId, { games });
        await logConfigSave(interaction, current?.jail, action === 'create_game' ? 'Guessing game created' : 'Guessing game settings updated', '**Game:** ' + gameName + '\n**Tries:** ' + triesRaw + '\n**Lives:** ' + livesRaw);
        return interaction.editReply(panelPayload({ ...(current ?? {}), games }, 'games', 'settings', selectedGameId));
      }

      const gameId = parts[2];
      const game = guessingGames.find(item => item.id === gameId);
      if (!game) return interaction.editReply({ content: 'That guessing game no longer exists. Open /config → Games and try again.' });
      if (action === 'add_characters' || action === 'replace_characters') {
        const isReplace = action === 'replace_characters';
        const existingCharacters = Array.isArray(game.characters) ? [...game.characters] : [];
        const parsedCharacters = [];
        const seenNames = new Set(isReplace ? [] : existingCharacters
          .map(character => String(character?.name ?? '').trim().toLowerCase())
          .filter(Boolean));

        for (let slot = 1; slot <= 5; slot++) {
          const rawSlot = interaction.fields.getTextInputValue('character_' + slot).trim();
          if (!rawSlot) continue;
          const rows = rawSlot.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
          for (let lineIndex = 0; lineIndex < rows.length; lineIndex++) {
            const values = rows[lineIndex].split('|').map(value => value.trim());
            const characterName = values.shift();
            let imageUrl = '';
            const possibleImageUrl = values.at(-1) ?? '';
            if (/^[a-z][a-z0-9+.-]*:\/\//i.test(possibleImageUrl)) {
              values.pop();
              try {
                const parsedUrl = new URL(possibleImageUrl);
                if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Unsupported image URL protocol');
                imageUrl = parsedUrl.toString();
              } catch {
                return interaction.editReply({ content: `Entry ${slot}, line ${lineIndex + 1}: the image URL must be a valid HTTP or HTTPS URL.` });
              }
            }
            const hints = values.join('|').split(',').map(value => value.trim()).filter(Boolean);
            if (!characterName || characterName.length > 80 || hints.length < 1 || hints.some(hint => hint.length > 250) || imageUrl.length > 1000) {
              return interaction.editReply({ content: `Entry ${slot}, line ${lineIndex + 1}: use Character name | hint 1, hint 2 | optional image URL. Names must be 1–80 characters and each hint must be 250 characters or fewer.` });
            }
            const key = characterName.toLowerCase();
            if (seenNames.has(key)) {
              return interaction.editReply({ content: `The character **${characterName}** already exists${isReplace ? ' more than once in this replacement batch' : ' in this game or more than once in this batch'}.` });
            }
            seenNames.add(key);
            parsedCharacters.push({ name: characterName, hints, ...(imageUrl ? { imageUrl } : {}) });
          }
        }

        if (!parsedCharacters.length) {
          return interaction.editReply({ content: 'Enter at least one character in the five entry fields. Empty fields are ignored; nothing was changed.' });
        }

        const nextCharacters = isReplace ? parsedCharacters : [...existingCharacters, ...parsedCharacters];
        if (nextCharacters.length > 500) {
          return interaction.editReply({ content: 'This game cannot contain more than 500 characters. Remove some characters before saving this batch.' });
        }

        game.characters = nextCharacters;
        games.guessingGames = guessingGames;
        delete games.guessingCategories;
        await updateGuildConfig(client, interaction.guildId, { games });
        await logConfigSave(
          interaction,
          current?.jail,
          isReplace ? 'Guessing game character list replaced' : 'Guessing game characters added',
          '**Game:** ' + game.name + '\n**' + (isReplace ? 'Replaced with' : 'Added') + ':** ' + parsedCharacters.length + '\n**Total:** ' + game.characters.length
        );
        return interaction.editReply({
          ...panelPayload({ ...(current ?? {}), games }, 'games', 'settings', gameId),
          content: isReplace
            ? `Replaced the character list for **${game.name}** with ${parsedCharacters.length} character(s).`
            : `Added ${parsedCharacters.length} character(s) to **${game.name}**. The game now has ${game.characters.length} character(s).`,
        });
      }

      if (action === 'characters') {
        const raw = interaction.fields.getTextInputValue('characters_data').trim();
        if (/^clear$/i.test(raw)) {
          game.characters = [];
        } else {
          const rows = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
          if (!rows.length || rows.length > 25) return interaction.editReply({ content: 'Enter between 1 and 25 characters, one per line. Use CLEAR to remove all characters.' });
          const parsed = [];
          const seen = new Set();
          for (const row of rows) {
            const values = row.split('|').map(value => value.trim());
            const characterName = values.shift();
            let imageUrl = '';
            const possibleImageUrl = values.at(-1) ?? '';
            if (/^[a-z][a-z0-9+.-]*:\/\//i.test(possibleImageUrl)) {
              values.pop();
              try {
                const parsedUrl = new URL(possibleImageUrl);
                if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Unsupported image URL protocol');
                imageUrl = parsedUrl.toString();
              } catch {
                return interaction.editReply({ content: 'The image URL for **' + characterName + '** must be a valid HTTP or HTTPS direct image URL.' });
              }
            }
            const hints = values.join('|').split(',').map(value => value.trim()).filter(Boolean);
            if (!characterName || characterName.length > 80 || hints.length < 1 || hints.some(hint => hint.length > 250) || imageUrl.length > 1000) {
              return interaction.editReply({ content: 'Each line must contain a character name, then |, then comma-separated hints (no fixed hint limit), with an optional image URL after another |. Names must be 1–80 characters and hints must be 250 characters or fewer.' });
            }
            const key = characterName.toLowerCase();
            if (seen.has(key)) return interaction.editReply({ content: 'Character names must be unique within a guessing game. Duplicate found: ' + characterName });
            seen.add(key);
            parsed.push({ name: characterName, hints, ...(imageUrl ? { imageUrl } : {}) });
          }
          game.characters = parsed;
        }
        games.guessingGames = guessingGames;
        delete games.guessingCategories;
        await updateGuildConfig(client, interaction.guildId, { games });
        await logConfigSave(interaction, current?.jail, 'Guessing game characters updated', '**Game:** ' + game.name + '\n**Characters:** ' + game.characters.length);
        return interaction.editReply(panelPayload({ ...(current ?? {}), games }, 'games', 'settings', gameId));
      }
      return interaction.editReply({ content: 'Unknown game configuration action.' });
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('jconfigmodal:twitch_')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Only administrators can change server configuration.', flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const twitch = { ...(current?.twitch ?? {}) };
      const modalType = interaction.customId.slice('jconfigmodal:twitch_'.length);

      if (modalType === 'link' || modalType === 'unlink') {
        const username = interaction.fields.getTextInputValue('twitch_username').trim().replace(/^@/, '').toLowerCase();
        if (!/^[a-z0-9_]{1,25}$/.test(username)) {
          return interaction.editReply({ content: 'Enter a valid Twitch username (letters, numbers, and underscores only).' });
        }

        if (modalType === 'link') {
          try {
            const account = await lookupTwitchUser(username);
            const streamers = Array.isArray(twitch.streamers) ? [...twitch.streamers] : [];
            if (streamers.some(item => item?.userId === account.userId || String(item?.login ?? '').toLowerCase() === account.login.toLowerCase())) {
              return interaction.editReply({ content: `@${account.login} is already linked.` });
            }
            if (streamers.length >= TWITCH_MAX_STREAMERS_PER_GUILD) {
              return interaction.editReply({ content: `This server has reached the limit of ${TWITCH_MAX_STREAMERS_PER_GUILD} linked Twitch accounts.` });
            }
            streamers.push({ ...account, isLive: false, lastStreamId: null });
            await updateGuildConfig(client, interaction.guildId, { twitch: { ...twitch, streamers } });
            await logConfigSave(interaction, current?.jail, 'Twitch account linked', `**Account:** @${account.login}`);
            return interaction.editReply({ content: `Linked Twitch account **@${account.login}**. The bot will announce when the account goes live.` });
          } catch (error) {
            return interaction.editReply({ content: error?.message || 'Could not link that Twitch account. Check the Twitch API credentials and try again.' });
          }
        }

        const streamers = Array.isArray(twitch.streamers) ? twitch.streamers : [];
        const existing = streamers.find(item => String(item?.login ?? '').toLowerCase() === username);
        if (!existing) return interaction.editReply({ content: `@${username} is not currently linked to this server.` });
        twitch.streamers = streamers.filter(item => item?.userId !== existing.userId);
        await updateGuildConfig(client, interaction.guildId, { twitch });
        await logConfigSave(interaction, current?.jail, 'Twitch account unlinked', `**Account:** @${existing.login}`);
        return interaction.editReply({ content: `Unlinked Twitch account **@${existing.login}**. The bot will stop checking that account for this server.` });
      }

      if (modalType === 'messages') {
        const raw = interaction.fields.getTextInputValue('twitch_messages').trim();
        let messages;
        if (!raw || /^default$/i.test(raw) || /^clear$/i.test(raw)) {
          messages = ['{{streameruser}} IS NOW LIVE {{streamlink}}'];
        } else {
          messages = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
          if (!messages.length) messages = ['{{streameruser}} IS NOW LIVE {{streamlink}}'];
          if (messages.length > 10) return interaction.editReply({ content: 'You can configure up to 10 live-message templates. Put one message on each line.' });
          const tooLong = messages.find(message => message.length > 1000);
          if (tooLong) return interaction.editReply({ content: 'Each live-message template must be 1,000 characters or fewer.' });
        }
        await updateGuildConfig(client, interaction.guildId, { twitch: { ...twitch, liveMessages: messages } });
        await logConfigSave(interaction, current?.jail, 'Twitch live messages', `**Template count:** ${messages.length}\n**Templates:** ${messages.join('\n').slice(0, 1800)}`);
        return interaction.editReply({ content: `Saved ${messages.length} Twitch live-message template(s). The bot will choose one at random whenever a linked account goes live.\nUse {{streameruser}} for the streamer name and {{streamlink}} for their Twitch link.` });
      }

      return interaction.editReply({ content: 'Unknown Twitch configuration action.' });
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('jconfigmodal:')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: 'Only administrators can change jail configuration.', flags: MessageFlags.Ephemeral });
        return true;
      }
      const field = interaction.customId.slice('jconfigmodal:'.length);
      const raw = interaction.fields.getTextInputValue('setting_value').trim();
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const current = await getGuildConfig(client, interaction.guildId);
      const jail = { ...(current.jail ?? {}) };
      if (field === 'default_seconds') {
        if (/^infinite$/i.test(raw)) jail.defaultSentenceSeconds = null;
        else if (/^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 2147483647) jail.defaultSentenceSeconds = Number(raw);
        else return interaction.reply({ content: 'Enter a positive number of seconds or INFINITE.', flags: MessageFlags.Ephemeral });
        if (jail.defaultSentenceSeconds !== null && jail.defaultSentenceSeconds < Number(jail.minimumSentenceSeconds ?? 600)) {
          return interaction.reply({ content: `Default sentence cannot be below the minimum of ${jail.minimumSentenceSeconds ?? 600} seconds.`, flags: MessageFlags.Ephemeral });
        }
      } else if (field === 'minimum_seconds') {
        if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 2147483647) return interaction.reply({ content: 'Enter a positive number of seconds.', flags: MessageFlags.Ephemeral });
        const next = Number(raw);
        if (jail.defaultSentenceSeconds != null && jail.defaultSentenceSeconds < next) return interaction.reply({ content: 'Minimum cannot exceed the configured finite default sentence.', flags: MessageFlags.Ephemeral });
        jail.minimumSentenceSeconds = next;
      } else if (field === 'evidence_count') {
        if (!/^(?:[1-9]|10)$/.test(raw)) return interaction.reply({ content: 'Evidence message count must be between 1 and 10.', flags: MessageFlags.Ephemeral });
        jail.evidenceMessageCount = Number(raw);
      } else if (field === 'default_message') {
        jail.defaultMessage = raw.toUpperCase() === 'CLEAR' ? '' : raw;
      } else if (field === 'jail_announcement') {
        jail.jailAnnouncement = raw || '{{user}} HAS BEEN JAILED';
      } else if (field === 'unjail_announcement') {
        jail.unjailAnnouncement = raw || '{{user}} HAS BEEN UNJAILED';
      } else {
        return interaction.reply({ content: 'Unknown setting.', flags: MessageFlags.Ephemeral });
      }
      if (field === 'default_seconds') jail.defaultDuration = undefined;
      await updateGuildConfig(client, interaction.guildId, { jail });
      await logConfigSave(interaction, jail, SETTINGS.find(s => s.value === field).label, `**New value:** ${field === 'default_message' ? (jail.defaultMessage || 'None') : field === 'default_seconds' ? formatDuration(jail.defaultSentenceSeconds) : field === 'minimum_seconds' ? formatDuration(jail.minimumSentenceSeconds) : field === 'jail_announcement' ? jail.jailAnnouncement : field === 'unjail_announcement' ? jail.unjailAnnouncement : jail.evidenceMessageCount}`);
      return interaction.reply({ content: `Saved **${SETTINGS.find(s => s.value === field).label}**.`, flags: MessageFlags.Ephemeral });
    }
    return false;
  },
};
