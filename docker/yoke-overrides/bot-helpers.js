/**
 * Bot-safe Yoke helper surface for Wingmen (Agent Chat phase 1).
 *
 * CONTRACT
 * --------
 * This module is the single import boundary Wingmen is allowed to use from
 * Yoke for bot-first workspace bootstrap, auth, group-key loading, and
 * chat-record decrypt/routing normalization. It is designed so a bot actor
 * can run without invoking the interactive Yoke CLI, without touching the
 * local SQLite mirror, and without depending on any CLI global state.
 *
 * Safe for Wingmen import:
 *   - BotHelperError (typed error with .code)
 *   - createBotWorkspaceKey
 *   - loadBotWorkspaceKey
 *   - signBotRequest
 *   - signWorkspaceRequest
 *   - fetchBotGroupKeys
 *   - loadBotGroupKeys
 *   - decryptChatRecord
 *   - extractChatReadableGroups
 *   - normalizeThreadId
 *   - normalizeChannelParticipants
 *   - normalizeChatRoutingContext
 *   - normalizeChatInterceptContext
 *   - buildAgentInterceptKey
 *
 * Explicitly NOT part of this contract (remain Yoke-only):
 *   - src/cli.js and any interactive command entrypoints
 *   - src/sync.js long-running sync loop
 *   - src/db.js SQLite schema, migrations, and local maintenance
 *   - src/config.js CLI/environment bootstrap
 *   - src/nostr.js ambient nsec loaders (getConfiguredNsec, bitwarden, etc.)
 *
 * Wingmen must not import those modules for runtime chat interception. If a
 * new capability is needed, extend this helper surface rather than reaching
 * into CLI internals.
 *
 * Error codes emitted by this module:
 *   - workspace_auth_failed   : ws key blob cannot be loaded for this bot
 *   - group_key_missing       : no wrapped group key available to decrypt
 *   - thread_unresolved       : chat message thread_id cannot be normalized
 *   - record_decrypt_failed   : wrapped payload decrypt rejected
 *   - intercept_context_invalid : agent-first intercept helper inputs are incomplete
 */

import { getPublicKey, nip19 } from 'nostr-tools';
import {
  createNip98AuthHeader,
  decodeNsec,
} from './nostr.js';
import {
  generateWorkspaceKey,
  decryptWorkspaceKey,
  buildWorkspaceSession,
} from './workspace-keys.js';
import {
  decryptRecordPayload,
  inboundChatMessage,
  inboundChannel,
  loadGroupKeyMap,
} from './translators.js';

/**
 * Typed error for the bot helper surface. `code` is one of the shared error
 * codes in the Agent Chat design doc.
 */
export class BotHelperError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message);
    this.name = 'BotHelperError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function normalizeGroupRef(value) {
  const ref = typeof value === 'string' ? value.trim() : '';
  return ref || null;
}

function dedupeSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort();
}

function resolveSourceAppNpub(record, chatMessage = null) {
  const explicit = typeof chatMessage?.source_app_npub === 'string' ? chatMessage.source_app_npub.trim() : '';
  if (explicit) return explicit;

  const familyHash = typeof record?.record_family_hash === 'string' ? record.record_family_hash.trim() : '';
  if (!familyHash) return null;
  const separator = familyHash.indexOf(':');
  if (separator <= 0) return null;
  const appNpub = familyHash.slice(0, separator).trim();
  return appNpub || null;
}

function requireBotActor({ botSecret, botNpub }) {
  if (!(botSecret instanceof Uint8Array) || botSecret.byteLength !== 32) {
    throw new BotHelperError(
      'workspace_auth_failed',
      'Bot secret must be a 32-byte Uint8Array.',
    );
  }
  if (typeof botNpub !== 'string' || !botNpub.startsWith('npub1')) {
    throw new BotHelperError(
      'workspace_auth_failed',
      'Bot npub must be a bech32 npub string.',
    );
  }
  const derivedNpub = nip19.npubEncode(getPublicKey(botSecret));
  if (derivedNpub !== botNpub) {
    throw new BotHelperError(
      'workspace_auth_failed',
      `Bot npub ${botNpub} does not match secret-derived npub ${derivedNpub}.`,
    );
  }
}

/**
 * Create a fresh workspace session keypair for a bot actor. The bot's
 * runtime secret is used to encrypt the derived ws-key nsec so the bot can
 * reload the same workspace session on the next run without depending on the
 * human root key.
 *
 * @param {object} params
 * @param {Uint8Array} params.botSecret
 * @param {string} params.botNpub
 * @param {string} params.workspaceOwnerNpub
 * @returns {{ blob: object, wsSession: object }}
 */
export function createBotWorkspaceKey({ botSecret, botNpub, workspaceOwnerNpub }) {
  requireBotActor({ botSecret, botNpub });
  if (typeof workspaceOwnerNpub !== 'string' || !workspaceOwnerNpub.startsWith('npub1')) {
    throw new BotHelperError(
      'workspace_auth_failed',
      'workspaceOwnerNpub must be a bech32 npub string.',
    );
  }
  const { blob, wsKeySecret, wsKeyNpub } = generateWorkspaceKey(
    botSecret,
    botNpub,
    workspaceOwnerNpub,
  );
  const wsSession = buildWorkspaceSession(wsKeySecret, wsKeyNpub, blob.ws_key_epoch ?? 1, botNpub);
  return { blob, wsSession };
}

/**
 * Build a NIP-98 Authorization header signed by the bot's real identity.
 * Used for privileged bootstrap operations like ws-key registration.
 *
 * @param {object} params
 * @param {Uint8Array} params.botSecret
 * @param {string} params.botNpub
 * @param {string} params.url
 * @param {string} params.method
 * @param {object|string|null} [params.body]
 * @returns {string}
 */
export function signBotRequest({ botSecret, botNpub, url, method, body = null }) {
  requireBotActor({ botSecret, botNpub });
  if (typeof url !== 'string' || !url) {
    throw new BotHelperError('workspace_auth_failed', 'signBotRequest url is required.');
  }
  if (typeof method !== 'string' || !method) {
    throw new BotHelperError('workspace_auth_failed', 'signBotRequest method is required.');
  }
  return createNip98AuthHeader(url, method, body, botSecret);
}

/**
 * Reload an existing bot workspace session from a persisted blob.
 *
 * @param {object} params
 * @param {object} params.blob - the envelope previously returned by createBotWorkspaceKey
 * @param {Uint8Array} params.botSecret
 * @param {string} params.botNpub
 * @returns {{ wsSession: object }}
 */
export function loadBotWorkspaceKey({ blob, botSecret, botNpub }) {
  requireBotActor({ botSecret, botNpub });
  if (!blob || typeof blob !== 'object') {
    throw new BotHelperError('workspace_auth_failed', 'Missing workspace key blob.');
  }
  try {
    const { wsKeySecret, wsKeyNpub, wsKeyEpoch } = decryptWorkspaceKey(
      blob,
      botSecret,
      botNpub,
    );
    const wsSession = buildWorkspaceSession(wsKeySecret, wsKeyNpub, wsKeyEpoch, botNpub);
    return { wsSession };
  } catch (cause) {
    throw new BotHelperError(
      'workspace_auth_failed',
      `Unable to load workspace key for ${botNpub}: ${cause.message}`,
      { cause },
    );
  }
}

/**
 * Build a NIP-98 Authorization header for a Tower request, signed by the bot's
 * per-workspace ws key. Wingmen uses this when it does its own HTTP calls
 * without the Yoke client class.
 *
 * @param {object} params
 * @param {object} params.wsSession - from createBotWorkspaceKey/loadBotWorkspaceKey
 * @param {string} params.url
 * @param {string} params.method
 * @param {object|string|null} [params.body]
 * @returns {string}
 */
export function signWorkspaceRequest({ wsSession, url, method, body = null }) {
  if (!wsSession?.secret || !wsSession?.isWorkspaceKey) {
    throw new BotHelperError(
      'workspace_auth_failed',
      'signWorkspaceRequest requires a ws session from createBotWorkspaceKey/loadBotWorkspaceKey.',
    );
  }
  if (typeof url !== 'string' || !url) {
    throw new BotHelperError('workspace_auth_failed', 'signWorkspaceRequest url is required.');
  }
  if (typeof method !== 'string' || !method) {
    throw new BotHelperError('workspace_auth_failed', 'signWorkspaceRequest method is required.');
  }
  return createNip98AuthHeader(url, method, body, wsSession.secret);
}

/**
 * Fetch wrapped group key rows from Tower for the bot actor.
 *
 * This helper is intentionally transport-minimal: it takes a `fetchImpl` so
 * Wingmen can inject its own HTTP/SSE-aware fetch wrapper, and a
 * `backendBaseUrl` so it does not depend on Yoke config singletons.
 *
 * @param {object} params
 * @param {object} params.wsSession
 * @param {string} params.backendBaseUrl - e.g. https://tower.example.com
 * @param {typeof fetch} [params.fetchImpl=fetch]
 * @returns {Promise<Array>} raw wrapped group key rows as returned by Tower
 */
export async function fetchBotGroupKeys({ wsSession, backendBaseUrl, fetchImpl = fetch }) {
  if (!wsSession?.secret || !wsSession?.isWorkspaceKey) {
    throw new BotHelperError(
      'workspace_auth_failed',
      'fetchBotGroupKeys requires a bot ws session.',
    );
  }
  if (typeof backendBaseUrl !== 'string' || !backendBaseUrl) {
    throw new BotHelperError(
      'workspace_auth_failed',
      'fetchBotGroupKeys requires backendBaseUrl.',
    );
  }
  const url = new URL(
    `/api/v4/groups/keys?member_npub=${encodeURIComponent(wsSession.npub)}`,
    backendBaseUrl,
  ).toString();
  const authorization = signWorkspaceRequest({ wsSession, url, method: 'GET' });
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: authorization },
    });
  } catch (cause) {
    throw new BotHelperError(
      'workspace_auth_failed',
      `Tower group-key fetch transport error: ${cause.message}`,
      { cause },
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new BotHelperError(
      'workspace_auth_failed',
      `Tower group-key fetch rejected (${response.status}): ${text || response.statusText}`,
    );
  }
  const payload = await response.json();
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.keys)
      ? payload.keys
      : Array.isArray(payload?.group_keys)
        ? payload.group_keys
        : [];
  return rows;
}

/**
 * Load wrapped key rows into an in-memory group key map the decrypt helper
 * can consume. Does not touch SQLite.
 *
 * @param {object} params
 * @param {object} params.wsSession
 * @param {Uint8Array} params.botSecret
 * @param {string} params.botNpub
 * @param {Array} params.keyRows - wrapped key rows from fetchBotGroupKeys
 * @returns {object} group key map (see translators.loadGroupKeyMap)
 */
export function loadBotGroupKeys({ wsSession, botSecret, botNpub, keyRows }) {
  if (!wsSession?.secret) {
    throw new BotHelperError(
      'workspace_auth_failed',
      'loadBotGroupKeys requires a bot ws session.',
    );
  }
  requireBotActor({ botSecret, botNpub });
  if (!Array.isArray(keyRows)) {
    throw new BotHelperError(
      'group_key_missing',
      'loadBotGroupKeys requires an array of wrapped key rows.',
    );
  }
  try {
    return loadGroupKeyMap({ secret: botSecret, npub: botNpub }, keyRows, decodeNsec);
  } catch (cause) {
    throw new BotHelperError(
      'group_key_missing',
      `Unable to unwrap group keys for bot ${botNpub}: ${cause.message}`,
      { cause },
    );
  }
}

/**
 * Decrypt a chat_message record that Tower SSE announced to the bot.
 *
 * Returns the normalized chat-message model (see translators.inboundChatMessage)
 * so the caller can feed it directly into thread normalization and routing.
 *
 * @param {object} params
 * @param {object} params.record
 * @param {object} params.wsSession
 * @param {object} params.groupKeys - from loadBotGroupKeys
 * @returns {object} normalized inbound chat message
 */
export function decryptChatRecord({ record, wsSession, groupKeys }) {
  if (!record || typeof record !== 'object') {
    throw new BotHelperError('record_decrypt_failed', 'decryptChatRecord requires a record.');
  }
  if (!wsSession?.secret) {
    throw new BotHelperError(
      'workspace_auth_failed',
      'decryptChatRecord requires a bot ws session.',
    );
  }
  if (!groupKeys?.get) {
    throw new BotHelperError(
      'group_key_missing',
      'decryptChatRecord requires a group key map from loadBotGroupKeys.',
    );
  }
  let payload;
  try {
    payload = decryptRecordPayload(record, wsSession, groupKeys, wsSession);
  } catch (cause) {
    const isGroupKey = /no matching group key/i.test(cause.message || '');
    throw new BotHelperError(
      isGroupKey ? 'group_key_missing' : 'record_decrypt_failed',
      `Chat record ${record.record_id ?? '<unknown>'} could not be decrypted: ${cause.message}`,
      { cause },
    );
  }
  return inboundChatMessage(record, payload);
}

/**
 * Extract the group identities carried on a chat record and identify which of
 * those groups are locally readable with the currently loaded wrapped-key map.
 *
 * This lets Wingmen do two adjacent agent-first tasks without CLI shell-outs:
 *   - inspect the full message encryption-group set for candidate selection
 *   - inspect the subset currently readable by the local bot for diagnostics
 *
 * @param {object} params
 * @param {object} params.record
 * @param {object} [params.groupKeys]
 * @returns {{
 *   message_group_ids: string[],
 *   message_group_npubs: string[],
 *   readable_group_ids: string[],
 *   readable_group_npubs: string[],
 * }}
 */
export function extractChatReadableGroups({ record, groupKeys = null }) {
  if (!record || typeof record !== 'object') {
    throw new BotHelperError(
      'intercept_context_invalid',
      'extractChatReadableGroups requires a record.',
    );
  }

  const groupPayloads = Array.isArray(record.group_payloads) ? record.group_payloads : [];
  const messageGroupIds = dedupeSorted(groupPayloads.map((payload) => normalizeGroupRef(payload?.group_id)));
  const messageGroupNpubs = dedupeSorted(groupPayloads.map((payload) => normalizeGroupRef(payload?.group_npub)));

  if (!groupKeys?.get) {
    return {
      message_group_ids: messageGroupIds,
      message_group_npubs: messageGroupNpubs,
      readable_group_ids: [],
      readable_group_npubs: [],
    };
  }

  const readableGroupIds = [];
  const readableGroupNpubs = [];
  for (const payload of groupPayloads) {
    const keyVersion = Number.isInteger(payload?.group_epoch) ? payload.group_epoch : undefined;
    const entry = groupKeys.get(payload?.group_id, keyVersion != null ? { keyVersion } : {})
      || groupKeys.get(payload?.group_npub, keyVersion != null ? { keyVersion } : {});
    if (!entry) continue;
    const groupId = normalizeGroupRef(entry.groupId) || normalizeGroupRef(payload?.group_id);
    const groupNpub = normalizeGroupRef(entry.groupNpub) || normalizeGroupRef(payload?.group_npub);
    if (groupId) readableGroupIds.push(groupId);
    if (groupNpub) readableGroupNpubs.push(groupNpub);
  }

  return {
    message_group_ids: messageGroupIds,
    message_group_npubs: messageGroupNpubs,
    readable_group_ids: dedupeSorted(readableGroupIds),
    readable_group_npubs: dedupeSorted(readableGroupNpubs),
  };
}

/**
 * Normalize a chat message to its canonical thread_id for Agent Chat routing.
 *
 * Resolution rules:
 *   - if the decrypted message already exposes an explicit thread_id, trust it
 *   - else if there is no parent_message_id, the message is itself the thread root
 *   - else walk parent_message_id via `lookupMessage` until a root message is
 *     reached; that root's record_id is the thread_id
 *
 * `lookupMessage` is a sync function `(messageId) => chatMessage | null` that
 * returns a prior inbound chat message (or any object with record_id and
 * parent_message_id). If a parent cannot be resolved, throws thread_unresolved.
 *
 * @param {object} chatMessage - a normalized inbound chat message
 * @param {object} [context]
 * @param {(messageId: string) => object|null} [context.lookupMessage]
 * @param {number} [context.maxDepth=256]
 * @returns {string}
 */
export function normalizeThreadId(chatMessage, context = {}) {
  if (!chatMessage || typeof chatMessage !== 'object') {
    throw new BotHelperError('thread_unresolved', 'normalizeThreadId requires a chat message.');
  }
  const explicit = typeof chatMessage.thread_id === 'string' ? chatMessage.thread_id.trim() : '';
  if (explicit) return explicit;

  const selfId = typeof chatMessage.record_id === 'string' ? chatMessage.record_id.trim() : '';
  if (!selfId) {
    throw new BotHelperError(
      'thread_unresolved',
      'Chat message is missing record_id; cannot normalize thread_id.',
    );
  }

  const parentId = typeof chatMessage.parent_message_id === 'string'
    ? chatMessage.parent_message_id.trim()
    : '';
  if (!parentId) return selfId;

  const lookupMessage = context.lookupMessage;
  if (typeof lookupMessage !== 'function') {
    throw new BotHelperError(
      'thread_unresolved',
      `Chat message ${selfId} has parent_message_id ${parentId} but no lookupMessage was provided.`,
    );
  }

  const maxDepth = Number.isFinite(context.maxDepth) ? context.maxDepth : 256;
  const seen = new Set([selfId]);
  let currentId = parentId;
  for (let depth = 0; depth < maxDepth; depth++) {
    if (seen.has(currentId)) {
      throw new BotHelperError(
        'thread_unresolved',
        `Thread walk for ${selfId} hit a cycle at ${currentId}.`,
      );
    }
    seen.add(currentId);
    const parent = lookupMessage(currentId);
    if (!parent || typeof parent.record_id !== 'string') {
      throw new BotHelperError(
        'thread_unresolved',
        `Thread walk for ${selfId} could not resolve parent ${currentId}.`,
      );
    }
    const parentRecordId = parent.record_id.trim();
    if (!parentRecordId) {
      throw new BotHelperError(
        'thread_unresolved',
        `Thread walk for ${selfId} resolved parent ${currentId} without a usable record_id.`,
      );
    }
    const nextParent = typeof parent.parent_message_id === 'string'
      ? parent.parent_message_id.trim()
      : '';
    if (!nextParent) return parentRecordId;
    currentId = nextParent;
  }
  throw new BotHelperError(
    'thread_unresolved',
    `Thread walk for ${selfId} exceeded maxDepth ${maxDepth}.`,
  );
}

/**
 * Normalize the participant npub list for a channel. Accepts either a raw
 * record+payload pair (the shape Tower returns) or an already-normalized
 * inbound channel object.
 *
 * Returns a deduped, sorted array of bech32 npubs. The channel owner is
 * always included.
 *
 * @param {object} input - { record, payload } OR an inboundChannel result
 * @returns {string[]}
 */
export function normalizeChannelParticipants(input) {
  if (!input || typeof input !== 'object') {
    throw new BotHelperError(
      'thread_unresolved',
      'normalizeChannelParticipants requires a channel input.',
    );
  }
  let channel;
  if (Array.isArray(input.participant_npubs) || typeof input.owner_npub === 'string') {
    channel = input;
  } else if (input.record && input.payload) {
    channel = inboundChannel(input.record, input.payload);
  } else {
    throw new BotHelperError(
      'thread_unresolved',
      'normalizeChannelParticipants requires { record, payload } or a normalized channel.',
    );
  }

  const set = new Set();
  if (typeof channel.owner_npub === 'string' && channel.owner_npub.startsWith('npub1')) {
    set.add(channel.owner_npub);
  }
  for (const candidate of (channel.participant_npubs || [])) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed.startsWith('npub1')) set.add(trimmed);
  }
  return [...set].sort();
}

/**
 * Build the stable routing context Wingmen uses for Agent Chat evaluation.
 *
 * This composes the canonical shared helpers rather than reimplementing their
 * logic elsewhere:
 *   - channel_id comes from the decrypted chat message
 *   - thread_id comes from normalizeThreadId()
 *   - participant_npubs comes from normalizeChannelParticipants()
 *
 * @param {object} input
 * @param {object} input.chatMessage - normalized inbound chat message
 * @param {object} input.channel - normalized inbound channel OR { record, payload }
 * @param {object} [context]
 * @param {(messageId: string) => object|null} [context.lookupMessage]
 * @param {number} [context.maxDepth=256]
 * @returns {{ record_id: string, channel_id: string, parent_message_id: string|null, thread_id: string, participant_npubs: string[] }}
 */
export function normalizeChatRoutingContext(input, context = {}) {
  if (!input || typeof input !== 'object') {
    throw new BotHelperError(
      'thread_unresolved',
      'normalizeChatRoutingContext requires { chatMessage, channel }.',
    );
  }
  const chatMessage = input.chatMessage;
  if (!chatMessage || typeof chatMessage !== 'object') {
    throw new BotHelperError(
      'thread_unresolved',
      'normalizeChatRoutingContext requires a normalized chatMessage.',
    );
  }

  const recordId = typeof chatMessage.record_id === 'string' ? chatMessage.record_id.trim() : '';
  if (!recordId) {
    throw new BotHelperError(
      'thread_unresolved',
      'normalizeChatRoutingContext requires chatMessage.record_id.',
    );
  }

  const channelId = typeof chatMessage.channel_id === 'string' ? chatMessage.channel_id.trim() : '';
  if (!channelId) {
    throw new BotHelperError(
      'thread_unresolved',
      `Chat message ${recordId} is missing channel_id; cannot build routing context.`,
    );
  }

  const channelInput = input.channel;
  if (!channelInput || typeof channelInput !== 'object') {
    throw new BotHelperError(
      'thread_unresolved',
      `Chat message ${recordId} requires channel context for participant normalization.`,
    );
  }

  const normalizedChannel = (Array.isArray(channelInput.participant_npubs) || typeof channelInput.owner_npub === 'string')
    ? channelInput
    : channelInput.record && channelInput.payload
      ? inboundChannel(channelInput.record, channelInput.payload)
      : null;
  if (!normalizedChannel) {
    throw new BotHelperError(
      'thread_unresolved',
      'normalizeChatRoutingContext requires channel as a normalized channel or { record, payload }.',
    );
  }

  const normalizedChannelId = typeof normalizedChannel.record_id === 'string'
    ? normalizedChannel.record_id.trim()
    : '';
  if (normalizedChannelId && normalizedChannelId !== channelId) {
    throw new BotHelperError(
      'thread_unresolved',
      `Chat message ${recordId} references channel ${channelId} but channel context resolved to ${normalizedChannelId}.`,
    );
  }

  return {
    record_id: recordId,
    channel_id: channelId,
    parent_message_id: typeof chatMessage.parent_message_id === 'string'
      ? chatMessage.parent_message_id.trim() || null
      : null,
    thread_id: normalizeThreadId(chatMessage, context),
    participant_npubs: normalizeChannelParticipants(normalizedChannel),
  };
}

/**
 * Build the stable agent-first chat intercept context Wingmen needs for local
 * candidate selection and per-agent intercept routing.
 *
 * This composes:
 *   - workspace_owner_npub from the outer record owner
 *   - source_app_npub from the record family hash (or explicit override)
 *   - channel/thread routing from normalizeChatRoutingContext()
 *   - message/readable group identities from extractChatReadableGroups()
 *
 * @param {object} input
 * @param {object} input.record
 * @param {object} input.chatMessage
 * @param {object} input.channel
 * @param {object} [input.groupKeys]
 * @param {object} [context]
 * @param {(messageId: string) => object|null} [context.lookupMessage]
 * @param {number} [context.maxDepth=256]
 * @returns {{
 *   record_id: string,
 *   workspace_owner_npub: string,
 *   source_app_npub: string|null,
 *   channel_id: string,
 *   parent_message_id: string|null,
 *   thread_id: string,
 *   sender_npub: string|null,
 *   participant_npubs: string[],
 *   message_group_ids: string[],
 *   message_group_npubs: string[],
 *   readable_group_ids: string[],
 *   readable_group_npubs: string[],
 * }}
 */
export function normalizeChatInterceptContext(input, context = {}) {
  if (!input || typeof input !== 'object') {
    throw new BotHelperError(
      'intercept_context_invalid',
      'normalizeChatInterceptContext requires { record, chatMessage, channel }.',
    );
  }
  const record = input.record;
  if (!record || typeof record !== 'object') {
    throw new BotHelperError(
      'intercept_context_invalid',
      'normalizeChatInterceptContext requires a record.',
    );
  }

  const workspaceOwnerNpub = typeof record.owner_npub === 'string' ? record.owner_npub.trim() : '';
  if (!workspaceOwnerNpub) {
    throw new BotHelperError(
      'intercept_context_invalid',
      'normalizeChatInterceptContext requires record.owner_npub.',
    );
  }

  const routing = normalizeChatRoutingContext({
    chatMessage: input.chatMessage,
    channel: input.channel,
  }, context);
  const groups = extractChatReadableGroups({
    record,
    groupKeys: input.groupKeys ?? null,
  });

  return {
    record_id: routing.record_id,
    workspace_owner_npub: workspaceOwnerNpub,
    source_app_npub: resolveSourceAppNpub(record, input.chatMessage),
    channel_id: routing.channel_id,
    parent_message_id: routing.parent_message_id,
    thread_id: routing.thread_id,
    sender_npub: typeof input.chatMessage?.sender_npub === 'string'
      ? input.chatMessage.sender_npub.trim() || null
      : null,
    participant_npubs: routing.participant_npubs,
    message_group_ids: groups.message_group_ids,
    message_group_npubs: groups.message_group_npubs,
    readable_group_ids: groups.readable_group_ids,
    readable_group_npubs: groups.readable_group_npubs,
  };
}

/**
 * Build the canonical agent-first intercept key:
 *
 *   workspace_owner_npub + source_app_npub + channel_id + thread_id + agent_id
 *
 * @param {object} input
 * @param {string} input.workspace_owner_npub
 * @param {string|null} input.source_app_npub
 * @param {string} input.channel_id
 * @param {string} input.thread_id
 * @param {string} input.agent_id
 * @returns {string}
 */
export function buildAgentInterceptKey(input) {
  if (!input || typeof input !== 'object') {
    throw new BotHelperError(
      'intercept_context_invalid',
      'buildAgentInterceptKey requires an input object.',
    );
  }

  const workspaceOwnerNpub = typeof input.workspace_owner_npub === 'string'
    ? input.workspace_owner_npub.trim()
    : '';
  const sourceAppNpub = typeof input.source_app_npub === 'string'
    ? input.source_app_npub.trim()
    : '';
  const channelId = typeof input.channel_id === 'string' ? input.channel_id.trim() : '';
  const threadId = typeof input.thread_id === 'string' ? input.thread_id.trim() : '';
  const agentId = typeof input.agent_id === 'string' ? input.agent_id.trim() : '';

  if (!workspaceOwnerNpub || !sourceAppNpub || !channelId || !threadId || !agentId) {
    throw new BotHelperError(
      'intercept_context_invalid',
      'buildAgentInterceptKey requires workspace_owner_npub, source_app_npub, channel_id, thread_id, and agent_id.',
    );
  }

  return [
    workspaceOwnerNpub,
    sourceAppNpub,
    channelId,
    threadId,
    agentId,
  ].join('+');
}
