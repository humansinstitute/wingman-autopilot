import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';

import {
  buildFlightDeckPgMessageInstructionSignature,
  createFlightDeckPgChannelDocument,
  decodeFlightDeckPgDocumentBody,
} from './tower-client';

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

  test('creates PG channel documents with Flight Deck document content storage', async () => {
    const botSecret = generateSecretKey();
    const botPubkeyHex = getPublicKey(botSecret);
    const botNpub = nip19.npubEncode(botPubkeyHex);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ url, init });
      if (url.endsWith('/storage/prepare')) {
        return new Response(JSON.stringify({
          object_id: 'object-1',
          upload_url: 'http://tower.test/upload/object-1',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/v4/storage/object-1') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ object_id: 'object-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/v4/storage/object-1/complete')) {
        return new Response(JSON.stringify({ object_id: 'object-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/channels/channel-1/docs')) {
        return new Response(JSON.stringify({
          doc: {
            id: 'doc-1',
            storage_object_id: 'object-1',
            title: 'Plan',
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    try {
      await createFlightDeckPgChannelDocument({
        backendBaseUrl: 'http://tower.test',
        workspaceId: 'workspace-1',
        channelId: 'channel-1',
        appNpub: 'npub_app',
        botIdentity: { botNpub, botPubkeyHex, botSecret },
        title: 'Plan',
        body: '# Updated\n\nBody',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const prepare = requests.find((request) => request.url.endsWith('/storage/prepare'));
    expect(JSON.parse(String(prepare?.init?.body))).toMatchObject({
      content_type: 'application/vnd.wingman.flightdeck.document-content+json',
    });

    const upload = requests.find((request) => request.url.endsWith('/api/v4/storage/object-1') && request.init?.method === 'PUT');
    expect(upload?.init?.headers).toMatchObject({
      'Content-Type': 'application/json',
    });
    const uploadBody = JSON.parse(String(upload?.init?.body));
    const uploadedBody = JSON.parse(Buffer.from(uploadBody.base64_data, 'base64').toString('utf8'));
    expect(uploadedBody).toMatchObject({
      format: 'document_content_v1',
      content_model: {
        content: '# Updated\n\nBody',
        content_blocks: [],
      },
    });
  });

  test('decodes Flight Deck document content storage bodies', () => {
    const base64_data = Buffer.from(JSON.stringify({
      format: 'document_content_v1',
      content_model: {
        content: '# Existing\n\nBody',
        content_format: null,
        content_blocks: [],
      },
    })).toString('base64');

    expect(decodeFlightDeckPgDocumentBody({ body: { encoding: 'base64', base64_data } })).toBe('# Existing\n\nBody');
  });
});
