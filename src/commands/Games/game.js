import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} from 'discord.js';

const activeSessions = new Map();
const LOBBY_TTL_MS = 3 * 60 * 1000;
const COUNTDOWN_SECONDS = 5;
const ANSWER_WINDOW_MS = 15 * 1000;

function normalizeAnswer(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    // Compare the actual letters and numbers only. Case, spaces, punctuation,
    // hyphens, and apostrophes should not make an otherwise correct name fail.
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeTypeMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('game:type')
      .setPlaceholder('Choose what type of game to play')
      .addOptions([
        { label: 'Guess', value: 'guess', description: 'Guess characters using hints and timed answer rounds' },
      ]),
  );
}

function makeGuessingGameMenu(games) {
  return {
    content: 'Choose a guessing game to host.',
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('game:select')
          .setPlaceholder('Choose a guessing game')
          .addOptions(games.slice(0, 25).map(game => ({
            label: String(game.name).slice(0, 100),
            value: String(game.id),
            description: (game.characters.length + ' characters · ' + game.lives + ' lives · ' + game.tries + ' tries each').slice(0, 100),
          }))),
      ),
    ],
  };
}

function getConfiguredGuessingGames(gamesConfig = {}) {
  if (Array.isArray(gamesConfig.guessingGames)) return gamesConfig.guessingGames;
  return (Array.isArray(gamesConfig.guessingCategories) ? gamesConfig.guessingCategories : [])
    .flatMap(category => (category.games ?? []).map(game => ({ ...game })));
}

const characterWikiImageCache = new Map();

async function getCharacterRevealImage(character) {
  if (character?.imageUrl) return character.imageUrl;
  const wikiUrl = character?.wikiUrl;
  if (!wikiUrl) return null;
  if (characterWikiImageCache.has(wikiUrl)) return characterWikiImageCache.get(wikiUrl);
  let imageUrl = null;
  try {
    const pageUrl = new URL(wikiUrl);
    if (pageUrl.protocol !== 'https:' || !/(?:^|\\.)fandom\\.com$|(?:^|\\.)wikia\\.org$/i.test(pageUrl.hostname)) return null;
    const response = await fetch(pageUrl, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Conradd4/1.0; character image preview)' },
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) return null;
    const finalHost = new URL(response.url).hostname;
    if (!/(?:^|\\.)fandom\\.com$|(?:^|\\.)wikia\\.org$/i.test(finalHost)) return null;
    const html = await response.text();
    const metaTags = html.match(/<meta\\b[^>]*>/gi) ?? [];
    for (const tag of metaTags) {
      if (!/(?:property|name)=["']og:image["']/i.test(tag)) continue;
      const match = tag.match(/content=["']([^"']+)["']/i);
      if (!match) continue;
      const candidate = new URL(match[1].replace(/&amp;/g, '&'), wikiUrl);
      if (candidate.protocol === 'https:' && /^(?:static\\.wikia\\.nocookie\\.net|images\\.fandom\\.com)$/i.test(candidate.hostname)) {
        imageUrl = candidate.toString();
        break;
      }
    }
  } catch {
    imageUrl = null;
  }
  characterWikiImageCache.set(wikiUrl, imageUrl);
  return imageUrl;
}

function lobbyPayload(session) {
  const players = [...session.players.values()];
  const playerList = players.length
    ? players.map(player => '<@' + player.id + '>').join(', ').slice(0, 900)
    : 'No players yet.';
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('Guessing game lobby')
    .setDescription(
      '**Game:** ' + session.game.name +
      '\n**Hosted by:** <@' + session.hostId + '>' +
      '\n\n' + playerList +
      (session.status === 'lobby' ? '\n\nPlayers can join below. The host starts the game when everyone is ready.' :
        session.status === 'playing' ? '\n\nThe game is currently in progress.' : '\n\nThis game has finished.')
    )
    .addFields(
      { name: 'Players', value: String(players.length), inline: true },
      { name: 'Lives per player', value: String(session.game.lives), inline: true },
      { name: 'Tries per character', value: String(session.game.tries), inline: true },
      { name: 'Winning score', value: 'First to ' + session.winningScore, inline: true },
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('game:join:' + session.token)
      .setLabel('Join game')
      .setStyle(ButtonStyle.Success)
      .setDisabled(session.status !== 'lobby'),
    new ButtonBuilder()
      .setCustomId('game:start:' + session.token)
      .setLabel('Start game')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(session.status !== 'lobby' || players.length === 0),
  );
  return { embeds: [embed], components: session.status === 'lobby' ? [row] : [], allowedMentions: { parse: [] } };
}

function hasActiveChannelSession(guildId, channelId) {
  return [...activeSessions.values()].some(session =>
    session.guildId === guildId && session.channelId === channelId && ['lobby', 'playing'].includes(session.status)
  );
}

function getSession(token, guildId) {
  const session = activeSessions.get(token);
  if (!session || session.guildId !== guildId) return null;
  return session;
}

function removeSession(session) {
  if (!session) return;
  activeSessions.delete(session.token);
  if (session.lobbyTimer) clearTimeout(session.lobbyTimer);
}

async function collectAnswers(session, activePlayerIds) {
  const answers = new Map();
  const activeIds = new Set(activePlayerIds);
  await new Promise(resolve => {
    const collector = session.channel.createMessageCollector({
      time: ANSWER_WINDOW_MS,
      filter: message => !message.author.bot && activeIds.has(message.author.id),
    });
    collector.on('collect', message => {
      if (answers.has(message.author.id)) return;
      answers.set(message.author.id, message.content.trim());
      if (answers.size >= activeIds.size) collector.stop('all_answered');
    });
    collector.on('end', resolve);
  });
  return answers;
}

async function runGame(session) {
  const characters = shuffle(session.characters);
  session.status = 'playing';
  if (session.lobbyTimer) clearTimeout(session.lobbyTimer);
  await session.lobbyMessage.edit(lobbyPayload(session)).catch(() => null);

  await session.channel.send({
    content: 'The game is starting! There are ' + session.players.size + ' player(s). Only joined players can submit answers.',
    allowedMentions: { parse: [] },
  });

  for (let characterIndex = 0; characterIndex < characters.length; characterIndex += 1) {
    const character = characters[characterIndex];
    const playerStates = new Map();
    for (const player of session.players.values()) {
      if (player.lives > 0) {
        playerStates.set(player.id, {
          tries: session.game.tries,
          solved: false,
          eliminated: false,
        });
      }
    }

    if (![...playerStates.keys()].length) break;

    let hintIndex = 0;
    let characterFinished = false;
    while (!characterFinished) {
      const activeIds = [...playerStates.entries()]
        .filter(([id, state]) => {
          const player = session.players.get(id);
          return player && player.lives > 0 && !state.solved && !state.eliminated && state.tries > 0;
        })
        .map(([id]) => id);

      if (!activeIds.length) break;

      const countdownMessage = await session.channel.send({
        content:
          '**Character ' + (characterIndex + 1) + '/' + characters.length + '**\n' +
          'Get ready — say your answer in **' + COUNTDOWN_SECONDS + '**. Wait for the "SAY YOUR ANSWER NOW" message.',
        allowedMentions: { parse: [] },
      });
      for (let seconds = COUNTDOWN_SECONDS - 1; seconds >= 1; seconds -= 1) {
        await sleep(1000);
        await countdownMessage.edit({
          content: 'Say your answer in **' + seconds + '**... wait for the "SAY YOUR ANSWER NOW" message.',
        }).catch(() => null);
      }
      await sleep(1000);

      const hints = Array.isArray(character.hints) ? character.hints : [];
      const hint = hints[Math.min(hintIndex, Math.max(0, hints.length - 1))] || 'No hint configured.';
      const promptEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Character ' + (characterIndex + 1) + '/' + characters.length)
        .setDescription(
          '**Hint ' + (hintIndex + 1) + ':** ' + hint + '\n' +
          'Only the first message from each joined player during this answer window counts.'
        );
      await session.channel.send({
        content: '**SAY YOUR ANSWER NOW!** You have **15 seconds** to send one answer in this channel.',
        embeds: [promptEmbed],
        allowedMentions: { parse: [] },
      });

      const answers = await collectAnswers(session, activeIds);
      const correctPlayers = [];
      const missedPlayers = [];
      const failedPlayers = [];

      for (const id of activeIds) {
        const state = playerStates.get(id);
        const player = session.players.get(id);
        if (!state || !player || state.solved || state.eliminated) continue;

        const answer = answers.get(id);
        if (answer && normalizeAnswer(answer) === normalizeAnswer(character.name)) {
          state.solved = true;
          player.score += 1;
          correctPlayers.push(id);
        } else {
          state.tries -= 1;
          if (!answer) missedPlayers.push(id);
          if (state.tries <= 0) {
            state.eliminated = true;
            player.lives = Math.max(0, player.lives - 1);
            failedPlayers.push(id);
          }
        }
      }

      const resultLines = [];
      if (correctPlayers.length) resultLines.push('Correct: ' + correctPlayers.map(id => '<@' + id + '>').join(', '));
      if (missedPlayers.length) resultLines.push('No answer received: ' + missedPlayers.map(id => '<@' + id + '>').join(', '));
      if (failedPlayers.length) {
        resultLines.push('Out of tries — lost one life: ' + failedPlayers.map(id => {
          const player = session.players.get(id);
          return '<@' + id + '> (' + player.lives + ' life/lives left)';
        }).join(', '));
      }
      const stillTrying = [...playerStates.values()].some(state => !state.solved && !state.eliminated && state.tries > 0);
      if (resultLines.length) {
        await session.channel.send({ content: resultLines.join('\n'), allowedMentions: { parse: [] } });
      }
      if (stillTrying) hintIndex += 1;
      else characterFinished = true;
    }

    const revealEmbed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle('The character was ' + character.name + '.');
    const revealImageUrl = await getCharacterRevealImage(character);
    if (revealImageUrl) revealEmbed.setImage(revealImageUrl);
    await session.channel.send({
      embeds: [revealEmbed],
      allowedMentions: { parse: [] },
    });

    const standings = [...session.players.values()].map(player =>
      '<@' + player.id + '>: ' + player.score + ' correct · ' + player.lives + ' lives'
    );
    await session.channel.send({
      content: '**Current standings**\n' + standings.join('\n'),
      allowedMentions: { parse: [] },
    });

    const winners = [...session.players.values()].filter(player => player.score >= session.winningScore);
    if (winners.length) {
      session.winners = winners;
      break;
    }
    if (![...session.players.values()].some(player => player.lives > 0)) break;
  }

  session.status = 'finished';
  const finalStandings = [...session.players.values()]
    .sort((a, b) => b.score - a.score)
    .map((player, index) =>
      (index + 1) + '. <@' + player.id + '> — **' + player.score + '** correct guess(es), ' + player.lives + ' life/lives remaining'
    );
  const embed = new EmbedBuilder()
    .setColor(0x2ECC71)
    .setTitle(session.winners?.length ? 'Winning score reached!' : 'Guessing game finished!')
    .setDescription(
      '**Game:** ' + session.game.name +
      '\n**Winning criteria:** First to ' + session.winningScore + ' correct guesses' +
      (session.winners?.length ? '\n**Winner(s):** ' + session.winners.map(player => '<@' + player.id + '>').join(', ') : '') +
      '\n\n' + (finalStandings.join('\n') || 'No final scores.')
    );
  await session.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  await session.lobbyMessage.edit(lobbyPayload(session)).catch(() => null);
  removeSession(session);
}

export default {
  data: new SlashCommandBuilder()
    .setName('game')
    .setDescription('Choose a game type and host a configured game.'),

  async execute(interaction, guildConfig) {
    if (!interaction.inGuild() || !interaction.guild) {
      return interaction.reply({ content: 'Use this command in a server.', flags: MessageFlags.Ephemeral });
    }
    if (hasActiveChannelSession(interaction.guildId, interaction.channelId)) {
      return interaction.reply({ content: 'A game is already active in this channel. Wait for it to finish before starting another one.', flags: MessageFlags.Ephemeral });
    }
    const guessingGames = getConfiguredGuessingGames(guildConfig?.games ?? {})
      .filter(game => Array.isArray(game.characters) && game.characters.length > 0);

    if (!guessingGames.length) {
      return interaction.reply({
        content: 'No guessing games are configured yet. Ask a server administrator to create some under /config → Games.',
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      content: 'First, choose what type of game you want to play.',
      components: [makeTypeMenu()],
      flags: MessageFlags.Ephemeral,
    });
  },

  async handleComponent(interaction, client) {
    if (!interaction.customId?.startsWith('game:')) return false;

    if (interaction.isStringSelectMenu() && interaction.customId === 'game:type') {
      if (interaction.values[0] !== 'guess') {
        return interaction.update({ content: 'That game type is not available.', components: [], embeds: [] });
      }
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const config = await getGuildConfig(client, interaction.guildId);
      const guessingGames = getConfiguredGuessingGames(config?.games ?? {})
        .filter(game => Array.isArray(game.characters) && game.characters.length);
      if (!guessingGames.length) {
        return interaction.update({ content: 'No playable guessing games are configured yet.', components: [], embeds: [] });
      }
      return interaction.update(makeGuessingGameMenu(guessingGames));
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'game:select') {
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const config = await getGuildConfig(client, interaction.guildId);
      const game = getConfiguredGuessingGames(config?.games ?? {}).find(item => item.id === interaction.values[0]);
      if (!game || !Array.isArray(game.characters) || !game.characters.length) {
        return interaction.update({ content: 'That guessing game is no longer available or has no characters configured. Run /game again.', components: [], embeds: [] });
      }
      if (!interaction.channel?.isTextBased?.() || typeof interaction.channel.send !== 'function') {
        return interaction.update({ content: 'I cannot create a public game lobby in this channel. Try again in a text channel.', components: [], embeds: [] });
      }
      if (hasActiveChannelSession(interaction.guildId, interaction.channelId)) {
        return interaction.update({ content: 'A game is already active in this channel. Wait for it to finish before starting another one.', components: [], embeds: [] });
      }
      const modal = new ModalBuilder()
        .setCustomId('game:host:' + game.id)
        .setTitle('Choose winning criteria');
      const scoreInput = new TextInputBuilder()
        .setCustomId('winning_score')
        .setLabel('First player to how many correct guesses?')
        .setPlaceholder('Example: 10')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(4);
      modal.addComponents(new ActionRowBuilder().addComponents(scoreInput));
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('game:host:')) {
      const rawScore = interaction.fields.getTextInputValue('winning_score').trim();
      if (!/^\d+$/.test(rawScore) || Number(rawScore) < 1 || Number(rawScore) > 1000) {
        return interaction.reply({ content: 'Winning score must be a whole number from 1 to 1,000.', flags: MessageFlags.Ephemeral });
      }
      if (hasActiveChannelSession(interaction.guildId, interaction.channelId)) {
        return interaction.reply({ content: 'A game is already active in this channel. Wait for it to finish before starting another one.', flags: MessageFlags.Ephemeral });
      }
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const config = await getGuildConfig(client, interaction.guildId);
      const gameId = interaction.customId.slice('game:host:'.length);
      const game = getConfiguredGuessingGames(config?.games ?? {}).find(item => item.id === gameId);
      if (!game || !Array.isArray(game.characters) || !game.characters.length) {
        return interaction.reply({ content: 'That guessing game is no longer available or has no characters configured. Run /game again.', flags: MessageFlags.Ephemeral });
      }
      if (!interaction.channel?.isTextBased?.() || typeof interaction.channel.send !== 'function') {
        return interaction.reply({ content: 'I cannot create a public game lobby in this channel. Try again in a text channel.', flags: MessageFlags.Ephemeral });
      }

      const session = {
        token: randomUUID().replace(/-/g, '').slice(0, 12),
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        hostId: interaction.user.id,
        channel: interaction.channel,
        status: 'lobby',
        winningScore: Number(rawScore),
        game: {
          id: game.id,
          name: game.name,
          tries: Math.max(1, Math.min(10, Number(game.tries) || 3)),
          lives: Math.max(1, Math.min(10, Number(game.lives) || 3)),
        },
        characters: game.characters.map(character => ({
          name: String(character.name),
          hints: Array.isArray(character.hints) ? character.hints.map(String) : [],
          imageUrl: typeof character.imageUrl === 'string' ? character.imageUrl : null,
        })),
        players: new Map([[interaction.user.id, {
          id: interaction.user.id,
          score: 0,
          lives: Math.max(1, Math.min(10, Number(game.lives) || 3)),
        }]]),
      };
      // Reserve this channel before awaiting Discord so simultaneous hosts cannot create overlapping lobbies.
      activeSessions.set(session.token, session);
      try {
        const lobbyMessage = await interaction.channel.send(lobbyPayload(session));
        session.lobbyMessage = lobbyMessage;
      } catch (error) {
        removeSession(session);
        throw error;
      }
      session.lobbyTimer = setTimeout(async () => {
        if (session.status !== 'lobby') return;
        session.status = 'expired';
        await session.lobbyMessage.edit({
          content: 'This game lobby expired because it was not started within 3 minutes.',
          embeds: [],
          components: [],
          allowedMentions: { parse: [] },
        }).catch(() => null);
        removeSession(session);
      }, LOBBY_TTL_MS);
      session.lobbyTimer.unref?.();
      return interaction.reply({
        content: 'Your public game lobby is ready: ' + session.lobbyMessage.url,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.isButton() && interaction.customId.startsWith('game:join:')) {
      const token = interaction.customId.slice('game:join:'.length);
      const session = getSession(token, interaction.guildId);
      if (!session || session.status !== 'lobby') {
        return interaction.reply({ content: 'That game lobby is no longer accepting players.', flags: MessageFlags.Ephemeral });
      }
      if (session.players.has(interaction.user.id)) {
        return interaction.reply({ content: 'You have already joined this game.', flags: MessageFlags.Ephemeral });
      }
      session.players.set(interaction.user.id, {
        id: interaction.user.id,
        score: 0,
        lives: session.game.lives,
      });
      return interaction.update(lobbyPayload(session));
    }

    if (interaction.isButton() && interaction.customId.startsWith('game:start:')) {
      const token = interaction.customId.slice('game:start:'.length);
      const session = getSession(token, interaction.guildId);
      if (!session || session.status !== 'lobby') {
        return interaction.reply({ content: 'That game lobby is no longer available.', flags: MessageFlags.Ephemeral });
      }
      if (interaction.user.id !== session.hostId) {
        return interaction.reply({ content: 'Only the person who created this lobby can start the game.', flags: MessageFlags.Ephemeral });
      }
      if (!session.players.size) {
        return interaction.reply({ content: 'At least one player must join before starting.', flags: MessageFlags.Ephemeral });
      }
      await interaction.deferUpdate();
      await runGame(session);
      return true;
    }

    return false;
  },
};
