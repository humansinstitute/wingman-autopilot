const DEFAULT_CONNECT_RELAYS = [
  'wss://relay.nsec.app',
  'wss://nos.lol',
  'wss://relay.getalby.com/v1',
  'wss://nostr.mineracks.com',
];

function parseRelayList(input) {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value) => value.length > 0),
    ),
  );
}

function resolvePublishRelays(config) {
  const configured = parseRelayList(config?.connectRelays);
  if (configured.length > 0) return configured;
  return [...DEFAULT_CONNECT_RELAYS];
}

function ensureNip07SigningAvailable() {
  if (!window.nostr || typeof window.nostr.signEvent !== 'function') {
    throw new Error('NIP-07 signing is required to publish delegate discovery');
  }
}

function ensureNip44DecryptAvailable() {
  if (!window.nostr?.nip44 || typeof window.nostr.nip44.decrypt !== 'function') {
    throw new Error('NIP-07 NIP-44 decryption support is required to publish missing bot kind 0');
  }
}

async function fetchDelegateRegistryTemplate() {
  const response = await fetch('/api/bot-keys/delegate-registry', { credentials: 'include' });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = payload && typeof payload.error === 'string'
      ? payload.error
      : `Failed to fetch delegate registry template (${response.status})`;
    throw new Error(message);
  }

  if (!payload || typeof payload !== 'object' || !payload.eventTemplate) {
    throw new Error('Delegate registry template missing from server response');
  }

  return payload.eventTemplate;
}

async function publishSignedDelegateRegistry(signedEvent, relays) {
  const response = await fetch('/api/bot-keys/delegate-registry/publish', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signedEvent, relays }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload.error === 'string'
      ? payload.error
      : `Failed to publish delegate registry (${response.status})`;
    throw new Error(message);
  }

  return payload;
}

async function fetchBotProfileStatus(relays) {
  const relayParam = encodeURIComponent(relays.join(','));
  const response = await fetch(`/api/bot-keys/bot-profile/status?relays=${relayParam}`, {
    credentials: 'include',
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload.error === 'string'
      ? payload.error
      : `Failed to fetch bot profile status (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

async function fetchEncryptedBotKey() {
  const response = await fetch('/api/bot-keys/encrypted', { credentials: 'include' });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload.error === 'string'
      ? payload.error
      : `Failed to fetch encrypted bot key (${response.status})`;
    throw new Error(message);
  }
  if (!payload?.encryptedToUser || !payload?.senderPubkey) {
    throw new Error('Missing encrypted bot key payload');
  }
  return payload;
}

function hexToSecretBytes(hex) {
  const clean = typeof hex === 'string' ? hex.trim() : '';
  const normalized = /^[0-9a-fA-F]{63}$/.test(clean) ? `0${clean}` : clean;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error('Bot key decryption returned invalid nsec hex');
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 64; i += 2) {
    bytes[i / 2] = parseInt(normalized.substring(i, i + 2), 16);
  }
  return bytes;
}

async function signMissingBotProfileEvent(suggestedName) {
  ensureNip44DecryptAvailable();
  const encrypted = await fetchEncryptedBotKey();
  const nsecHex = await window.nostr.nip44.decrypt(encrypted.senderPubkey, encrypted.encryptedToUser);
  const secretBytes = hexToSecretBytes(nsecHex);
  try {
    const nostrTools = await import('/vendor/nostr-tools/index.js');
    if (typeof nostrTools.finalizeEvent !== 'function') {
      throw new Error('nostr-tools finalizeEvent unavailable in browser bundle');
    }
    const eventTemplate = {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify({
        name: suggestedName,
        about: 'Wingman agent',
        bot: true,
      }),
    };
    return nostrTools.finalizeEvent(eventTemplate, secretBytes);
  } finally {
    secretBytes.fill(0);
  }
}

async function publishSignedBotProfile(signedEvent, relays) {
  const response = await fetch('/api/bot-keys/bot-profile/publish', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signedEvent, relays }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload.error === 'string'
      ? payload.error
      : `Failed to publish bot kind 0 (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

export async function publishDelegateRegistryForCurrentUser(config) {
  ensureNip07SigningAvailable();
  const relays = resolvePublishRelays(config);
  const botProfileStatus = await fetchBotProfileStatus(relays);
  let botProfilePublishResult = null;
  let botProfileSignedEvent = null;
  if (!botProfileStatus?.exists) {
    botProfileSignedEvent = await signMissingBotProfileEvent(botProfileStatus?.suggestedName || 'wingman-bot');
    botProfilePublishResult = await publishSignedBotProfile(botProfileSignedEvent, relays);
  }
  const eventTemplate = await fetchDelegateRegistryTemplate();
  const signedEvent = await window.nostr.signEvent(eventTemplate);
  const publishResult = await publishSignedDelegateRegistry(signedEvent, relays);
  return {
    ...publishResult,
    signedEvent,
    eventTemplate,
    botProfileStatus,
    botProfilePublishResult,
    botProfileSignedEvent,
  };
}
