import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';

import { buildFlightDeckPgMessageInstructionSignature } from './tower-client';

describe('Flight Deck PG Tower client', () => {
  test('builds a signed PG message instruction for bot-authored replies', () => {
    const botSecret = generateSecretKey();
    const botPubkeyHex = getPublicKey(botSecret);
    const botNpub = nip19.npubEncode(botPubkeyHex);
    const body = 'I am here and ready.';
    const signature = buildFlightDeckPgMessageInstructionSignature({
      botIdentity: { botNpub, botPubkeyHex, botSecret },
      body,
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
    });
    const event = signature.nostr_event as Parameters<typeof verifyEvent>[0];
    const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');

    expect(signature).toMatchObject({
      version: 1,
      protocol: 'flightdeck_pg_message_instruction',
      kind: 33358,
      signer_npub: botNpub,
      body_sha256: bodySha256,
    });
    expect(verifyEvent(event)).toBe(true);
    expect(event.content).toBe(body);
    expect(event.tags).toEqual(expect.arrayContaining([
      ['protocol', 'flightdeck_pg_message_instruction'],
      ['body_sha256', bodySha256],
      ['workspace_id', 'workspace-1'],
      ['channel_id', 'channel-1'],
      ['thread_id', 'thread-1'],
    ]));
  });
});
