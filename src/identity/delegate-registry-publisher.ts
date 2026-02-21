import { nip19, verifyEvent } from 'nostr-tools';

import { publishToRelays, type SignedEvent } from '../ngit/relay-publisher';

const RELAY_URL_PATTERN = /^wss?:\/\/.+/i;

interface DelegateRegistryPublishRequest {
  ownerNpub: string;
  signedEvent: unknown;
  requestedRelays?: unknown;
  defaultRelays: string[];
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

function decodeNpubToPubkeyHex(npub: string): string {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub') {
    throw new Error('Session identity is not an npub');
  }
  if (typeof decoded.data !== 'string' || !/^[0-9a-fA-F]{64}$/.test(decoded.data)) {
    throw new Error('Invalid npub payload for session identity');
  }
  return decoded.data;
}

function isStringArrayArray(value: unknown): value is string[][] {
  if (!Array.isArray(value)) return false;
  return value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'));
}

function validateSignedDelegateRegistryEvent(input: unknown, ownerPubkeyHex: string): SignedEvent {
  if (!input || typeof input !== 'object') {
    throw new Error('signedEvent must be an object');
  }

  const event = input as Partial<SignedEvent>;
  if (event.kind !== 30078) {
    throw new Error('signedEvent.kind must be 30078');
  }
  if (event.pubkey !== ownerPubkeyHex) {
    throw new Error('signedEvent.pubkey must match the authenticated owner');
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

  const hasDelegatesDTag = event.tags.some((tag) => tag[0] === 'd' && tag[1] === 'wingman-delegates');
  if (!hasDelegatesDTag) {
    throw new Error('signedEvent must include d-tag wingman-delegates');
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

export async function publishDelegateRegistryEvent(request: DelegateRegistryPublishRequest) {
  const ownerPubkeyHex = decodeNpubToPubkeyHex(request.ownerNpub);
  const signedEvent = validateSignedDelegateRegistryEvent(request.signedEvent, ownerPubkeyHex);
  const relays = parseRelays(request.requestedRelays, request.defaultRelays);

  if (relays.length === 0) {
    throw new Error('No relays available for publishing');
  }

  const result = await publishToRelays(signedEvent, relays);

  return {
    eventId: signedEvent.id,
    relays,
    ...result,
  };
}
