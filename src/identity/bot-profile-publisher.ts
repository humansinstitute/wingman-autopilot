import { verifyEvent } from 'nostr-tools';

import { publishToRelays, queryRelays, type SignedEvent } from '../ngit/relay-publisher';
import { generateBotWordId } from './bot-word-id';

const RELAY_URL_PATTERN = /^wss?:\/\/.+/i;

interface BotProfileStatusRequest {
  botPubkeyHex: string;
  requestedRelays?: unknown;
  defaultRelays: string[];
}

interface BotProfilePublishRequest extends BotProfileStatusRequest {
  signedEvent: unknown;
}

function parseRelays(requestedRelays: unknown, defaultRelays: string[]): string[] {
  if (!Array.isArray(requestedRelays)) {
    return [...defaultRelays];
  }

  const relays = requestedRelays
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0 && RELAY_URL_PATTERN.test(value));

  if (relays.length === 0) {
    return [...defaultRelays];
  }

  return Array.from(new Set(relays));
}

function isStringArrayArray(value: unknown): value is string[][] {
  if (!Array.isArray(value)) return false;
  return value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'));
}

function validateSignedBotProfileEvent(input: unknown, expectedPubkeyHex: string): SignedEvent {
  if (!input || typeof input !== 'object') {
    throw new Error('signedEvent must be an object');
  }

  const event = input as Partial<SignedEvent>;
  if (event.kind !== 0) {
    throw new Error('signedEvent.kind must be 0');
  }
  if (event.pubkey !== expectedPubkeyHex) {
    throw new Error('signedEvent.pubkey must match the active bot');
  }
  if (typeof event.id !== 'string' || event.id.length === 0) {
    throw new Error('signedEvent.id is required');
  }
  if (typeof event.sig !== 'string' || event.sig.length === 0) {
    throw new Error('signedEvent.sig is required');
  }
  if (!Number.isInteger(event.created_at) || Number(event.created_at) <= 0) {
    throw new Error('signedEvent.created_at must be a positive integer');
  }
  if (typeof event.content !== 'string') {
    throw new Error('signedEvent.content must be a string');
  }
  if (!isStringArrayArray(event.tags)) {
    throw new Error('signedEvent.tags must be an array of string arrays');
  }

  const signedEvent: SignedEvent = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: Number(event.created_at),
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  };

  if (!verifyEvent(signedEvent)) {
    throw new Error('signedEvent signature verification failed');
  }

  return signedEvent;
}

export function buildBotProfileAlias(botPubkeyHex: string): string {
  return `${generateBotWordId(botPubkeyHex)}-bot`;
}

export async function getBotProfileStatus(request: BotProfileStatusRequest) {
  const relays = parseRelays(request.requestedRelays, request.defaultRelays);

  if (relays.length === 0) {
    return {
      exists: false,
      relays,
      latestEventId: null,
      suggestedName: buildBotProfileAlias(request.botPubkeyHex),
    };
  }

  const events = await queryRelays(relays, {
    kinds: [0],
    authors: [request.botPubkeyHex],
    limit: 1,
  });

  return {
    exists: events.length > 0,
    relays,
    latestEventId: events[0]?.id ?? null,
    suggestedName: buildBotProfileAlias(request.botPubkeyHex),
  };
}

export async function publishBotProfileEvent(request: BotProfilePublishRequest) {
  const relays = parseRelays(request.requestedRelays, request.defaultRelays);
  if (relays.length === 0) {
    throw new Error('No relays available for publishing');
  }

  const signedEvent = validateSignedBotProfileEvent(request.signedEvent, request.botPubkeyHex);
  const result = await publishToRelays(signedEvent, relays);

  return {
    eventId: signedEvent.id,
    relays,
    ...result,
  };
}
