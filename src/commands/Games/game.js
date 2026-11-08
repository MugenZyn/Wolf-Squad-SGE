import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

const activeSessions = new Map();
const activeUserSessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

function normalizeAnswer(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function makeCategoryMenu(categories) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('game:category')
      .setPlaceholder('Choose a game category')
      .addOptions(categories.slice(0, 25).map(category => ({
        label: String(category.name).slice(0, 100),
        value: String(category.id),
        description: (String((category.games ?? []).length) + ' guessing game(s)').slice(0, 100),
      }))),
  );
}

function makeGuessingGameMenu(category) {
  return {
    content: '**' + category.name + '** — choose a guessing game to play.',
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('game:select:' + category.id)
          .setPlaceholder('Choose a guessing game')
          .addOptions((category.games ?? []).filter(game => Array.isArray(game.characters) && game.characters.length).slice(0, 25).map(game => ({
            label: String(game.name).slice(0, 100),
            value: String(game.id),
            description: (game.characters.length + ' characters · ' + game.lives + ' lives · ' + game.tries + ' tries each').slice(0, 100),
          }))),
      ),
    ],
  };
}

function nextCharacter(session) {
  if (session.livesRemaining <= 0) {
    session.finished = 'lives';
    session.currentCharacter = null;
    return;
  }
  const next = session.remainingCharacters.shift();
  if (!next) {
    session.finished = 'complete';
    session.currentCharacter = null;
    return;
  }
  session.currentCharacter = next;
  session.triesRemaining = session.game.tries;
  session.hintIndex = 0;
}

function buildSessionPayload(session, resultMessage = '') {
  if (session.finished) {
    const completed = session.finished === 'complete';
    const embed = new EmbedBuilder()
      .setColor(completed ? 0x2ECC71 : 0xE74C3C)
      .setTitle(completed ? 'Guessing game completed!' : 'Game over!')
      .setDescription([
        resultMessage,
        completed ? 'You reached the end of the character list.' : 'You ran out of lives.',
        '**Category:** ' + session.category.name,
        '**Game:** ' + session.game.name,
        '**Correct guesses:** ' + session.score + '/' + session.totalCharacters,
      ].filter(Boolean).join('\n\n'));
    return { embeds: [embed], components: [], allowedMentions: { parse: [] } };
  }

  const character = session.currentCharacter;
  const hints = Array.isArray(character.hints) ? character.hints : [];
  const currentHint = hints[Math.min(session.hintIndex, Math.max(0, hints.length - 1))] || 'No hint configured.';
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(session.category.name + ' · ' + session.game.name)
    .setDescription([
      resultMessage,
      '**Lives:** ' + session.livesRemaining + '  ·  **Tries left:** ' + session.triesRemaining,
      '**Correct guesses:** ' + session.score + '/' + session.totalCharacters,
      '',
      '**Hint ' + (session.hintIndex + 1) + ':** ' + currentHint,
      '',
      'Press **Guess** to submit your answer. Each incorrect guess uses one try and reveals the next hint.',
      'If you use all your tries, the character is revealed and you lose one life.',
    ].filter(Boolean).join('\n'));
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('game:guess:' + session.token)
      .setLabel('Guess')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('game:skip:' + session.token)
      .setLabel('Reveal & skip')
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [controls], allowedMentions: { parse: [] } };
}

function getSession(interaction, token) {
  const session = activeSessions.get(token);
  if (!session || session.guildId !== interaction.guildId || session.userId !== interaction.user.id) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    activeSessions.delete(token);
    activeUserSessions.delete(session.userKey);
    return null;
  }
  return session;
}

function finishOrAdvance(session, resultMessage) {
  nextCharacter(session);
  if (session.finished) {
    activeSessions.delete(session.token);
    activeUserSessions.delete(session.userKey);
  }
  return buildSessionPayload(session, resultMessage);
}

export default {
  data: new SlashCommandBuilder()
    .setName('game')
    .setDescription('Choose a configured guessing game to play.'),

  async execute(interaction, guildConfig) {
    if (!interaction.inGuild() || !interaction.guild) {
      return interaction.reply({ content: 'Use this command in a server.', flags: MessageFlags.Ephemeral });
    }

    const categories = (Array.isArray(guildConfig?.games?.guessingCategories)
      ? guildConfig.games.guessingCategories
      : [])
      .filter(category => Array.isArray(category.games) && category.games.some(game =>
        Array.isArray(game.characters) && game.characters.length > 0
      ));

    if (!categories.length) {
      return interaction.reply({
        content: 'No guessing games are configured yet. Ask a server administrator to create some under /config → Games.',
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      content: 'Choose a category to browse its guessing games.',
      components: [makeCategoryMenu(categories)],
      flags: MessageFlags.Ephemeral,
    });
  },

  async handleComponent(interaction, client) {
    if (!interaction.customId?.startsWith('game:')) return false;

    if (interaction.isStringSelectMenu() && interaction.customId === 'game:category') {
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const config = await getGuildConfig(client, interaction.guildId);
      const category = (config?.games?.guessingCategories ?? []).find(item => item.id === interaction.values[0]);
      if (!category) {
        return interaction.update({ content: 'That category is no longer available. Run /game again.', components: [], embeds: [] });
      }
      const games = (category.games ?? []).filter(game => Array.isArray(game.characters) && game.characters.length);
      if (!games.length) {
        return interaction.update({ content: 'There are no playable guessing games in that category yet.', components: [], embeds: [] });
      }
      return interaction.update(makeGuessingGameMenu({ ...category, games }));
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('game:select:')) {
      const categoryId = interaction.customId.slice('game:select:'.length);
      const { getGuildConfig } = await import('../../services/config/guildConfig.js');
      const config = await getGuildConfig(client, interaction.guildId);
      const category = (config?.games?.guessingCategories ?? []).find(item => item.id === categoryId);
      const game = category?.games?.find(item => item.id === interaction.values[0]);
      if (!category || !game || !Array.isArray(game.characters) || !game.characters.length) {
        return interaction.update({ content: 'That guessing game is no longer available or has no characters configured. Run /game again.', components: [], embeds: [] });
      }

      const userKey = interaction.guildId + ':' + interaction.user.id;
      const previousToken = activeUserSessions.get(userKey);
      if (previousToken) activeSessions.delete(previousToken);

      const session = {
        token: randomUUID().replace(/-/g, '').slice(0, 12),
        userKey,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        createdAt: Date.now(),
        category: { id: category.id, name: category.name },
        game: {
          id: game.id,
          name: game.name,
          tries: Math.max(1, Math.min(10, Number(game.tries) || 3)),
          lives: Math.max(1, Math.min(10, Number(game.lives) || 3)),
        },
        remainingCharacters: shuffle(game.characters),
        currentCharacter: null,
        triesRemaining: 0,
        livesRemaining: Math.max(1, Math.min(10, Number(game.lives) || 3)),
        hintIndex: 0,
        score: 0,
        totalCharacters: game.characters.length,
        finished: null,
      };
      nextCharacter(session);
      activeSessions.set(session.token, session);
      activeUserSessions.set(userKey, session.token);
      return interaction.update(buildSessionPayload(session, 'Started! Guess each character before your tries run out.'));
    }

    if (interaction.isButton() && interaction.customId.startsWith('game:guess:')) {
      const token = interaction.customId.slice('game:guess:'.length);
      const session = getSession(interaction, token);
      if (!session) return interaction.reply({ content: 'This game session expired. Run /game to start another one.', flags: MessageFlags.Ephemeral });
      const modal = new ModalBuilder()
        .setCustomId('game:guess_submit:' + token)
        .setTitle('Guess the character');
      const input = new TextInputBuilder()
        .setCustomId('answer')
        .setLabel('Character name')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100)
        .setPlaceholder('Enter your guess');
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    if (interaction.isButton() && interaction.customId.startsWith('game:skip:')) {
      const token = interaction.customId.slice('game:skip:'.length);
      const session = getSession(interaction, token);
      if (!session) return interaction.reply({ content: 'This game session expired. Run /game to start another one.', flags: MessageFlags.Ephemeral });
      const revealed = session.currentCharacter.name;
      session.livesRemaining -= 1;
      return interaction.update(finishOrAdvance(session, 'The character was **' + revealed + '**. You used Reveal & skip and lost one life.'));
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('game:guess_submit:')) {
      const token = interaction.customId.slice('game:guess_submit:'.length);
      const session = getSession(interaction, token);
      if (!session) return interaction.reply({ content: 'This game session expired. Run /game to start another one.', flags: MessageFlags.Ephemeral });
      const answer = interaction.fields.getTextInputValue('answer').trim();
      if (!answer) return interaction.reply({ content: 'Enter a character name before submitting.', flags: MessageFlags.Ephemeral });

      if (normalizeAnswer(answer) === normalizeAnswer(session.currentCharacter.name)) {
        const revealed = session.currentCharacter.name;
        session.score += 1;
        return interaction.update(finishOrAdvance(session, 'Correct! The character was **' + revealed + '**.'));
      }

      session.triesRemaining -= 1;
      if (session.triesRemaining > 0) {
        session.hintIndex = Math.min(session.hintIndex + 1, session.currentCharacter.hints.length - 1);
        return interaction.update(buildSessionPayload(session, 'Not quite. You have ' + session.triesRemaining + ' try/tries left.'));
      }

      const revealed = session.currentCharacter.name;
      session.livesRemaining -= 1;
      return interaction.update(finishOrAdvance(session, 'Out of tries! The character was **' + revealed + '**. You lost one life.'));
    }

    return false;
  },
};
