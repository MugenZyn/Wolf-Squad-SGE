const URL_PATTERN = /https?:\/\/[^\s<>]+/gi;

function uppercaseText(value) {
  const urls = [];
  const protectedText = value.replace(URL_PATTERN, url => {
    const marker = `\u0000URL${urls.length}\u0000`;
    urls.push(url);
    return marker;
  });
  return protectedText.toUpperCase().replace(/\u0000URL(\d+)\u0000/g, (_, index) => urls[Number(index)]);
}

export function uppercaseMessagePayload(payload) {
  if (typeof payload === 'string') return uppercaseText(payload);
  if (!payload || typeof payload !== 'object' || typeof payload.content !== 'string') return payload;
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
