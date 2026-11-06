const URL_PATTERN = /https?:\/\/[^\s<>]+/gi;
const ESCAPED_SEQUENCE_PATTERN = /\\+(?:[nrtbfv0]|u[0-9a-f]{4}|x[0-9a-f]{2}|\\)/gi;
const DISCORD_TIMESTAMP_PATTERN = /<t:\d+(?::[tTdDfFR])?>/g;
const PRESERVED_MARKER_PATTERN = /\u0000UPPERCASE_KEEP_(\d+)\u0000/g;

function uppercaseText(value) {
  const preserved = [];
  const protect = token => {
    const marker = '\u0000UPPERCASE_KEEP_' + preserved.length + '\u0000';
    preserved.push(token);
    return marker;
  };

  const protectedText = value
    .replace(URL_PATTERN, protect)
    .replace(ESCAPED_SEQUENCE_PATTERN, protect)
    .replace(DISCORD_TIMESTAMP_PATTERN, protect);

  return protectedText.toUpperCase().replace(
    PRESERVED_MARKER_PATTERN,
    (_, index) => preserved[Number(index)],
  );
}

export function uppercaseMessagePayload(payload) {
  if (typeof payload === 'string') return uppercaseText(payload);
  if (!payload || typeof payload !== 'object' || typeof payload.content !== 'string') return payload;
  if (payload.preserveCase === true) {
    const { preserveCase, ...discordPayload } = payload;
    return discordPayload;
  }
  return { ...payload, content: uppercaseText(payload.content) };
}

export function patchInteractionTextResponses(interaction) {
  if (!interaction || interaction.__uppercaseResponsesPatched) return;
  for (const method of ['reply', 'editReply', 'followUp', 'update']) {
    if (typeof interaction[method] !== 'function') continue;
    const original = interaction[method].bind(interaction);
    interaction[method] = payload => original(uppercaseMessagePayload(payload));
  }
  interaction.__uppercaseResponsesPatched = true;
}

export function patchGuildChannelMessages(guild) {
  if (!guild?.channels || guild.__uppercaseChannelMessagesPatched) return;
  const patched = new WeakSet();
  const patchChannel = channel => {
    if (!channel || patched.has(channel) || typeof channel.send !== 'function') return channel;
    const original = channel.send.bind(channel);
    channel.send = payload => original(uppercaseMessagePayload(payload));
    patched.add(channel);
    return channel;
  };
  for (const channel of guild.channels.cache.values()) patchChannel(channel);
  const originalFetch = guild.channels.fetch.bind(guild.channels);
  guild.channels.fetch = async (...args) => {
    const result = await originalFetch(...args);
    if (result?.send) return patchChannel(result);
    if (result?.values) for (const channel of result.values()) patchChannel(channel);
    return result;
  };
  guild.__uppercaseChannelMessagesPatched = true;
}
