import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import type { AgentChatYokeContext } from './yoke-runtime';
import {
  appendReplyToCachedChatContext,
  publishAgentChatReplyDirect,
  reconcileCachedWorkspaceKey,
  shouldReuseCachedChatContext,
} from './yoke-runtime';

function makeContext(): AgentChatYokeContext {
  return {
    channel_id: 'channel-1',
    thread_id: 'thread-1',
    participants: ['npub1user', 'npub1bot'],
    recent_messages: [],
  };
}

describe('shouldReuseCachedChatContext', () => {
  test('reuses a fresh cached context for the same thread and token', () => {
    const now = Date.now();
    const reusable = shouldReuseCachedChatContext({
      state: {
        token: 'token-1',
        lastSyncedAt: new Date(now).toISOString(),
        cachedChatContext: {
          channelId: 'channel-1',
          threadId: 'thread-1',
          fetchedAt: new Date(now - 1_000).toISOString(),
          context: makeContext(),
        },
      },
      token: 'token-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      minSyncIntervalMs: 5_000,
    });

    expect(reusable).toBe(true);
  });

  test('does not reuse cached context when the cache is stale or mismatched', () => {
    const now = Date.now();
    expect(shouldReuseCachedChatContext({
      state: {
        token: 'token-1',
        lastSyncedAt: new Date(now).toISOString(),
        cachedChatContext: {
          channelId: 'channel-1',
          threadId: 'thread-1',
          fetchedAt: new Date(now - 10_000).toISOString(),
          context: makeContext(),
        },
      },
      token: 'token-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      minSyncIntervalMs: 5_000,
    })).toBe(false);

    expect(shouldReuseCachedChatContext({
      state: {
        token: 'token-1',
        lastSyncedAt: new Date(now).toISOString(),
        cachedChatContext: {
          channelId: 'channel-1',
          threadId: 'thread-2',
          fetchedAt: new Date(now - 1_000).toISOString(),
          context: makeContext(),
        },
      },
      token: 'token-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      minSyncIntervalMs: 5_000,
    })).toBe(false);
  });
});

describe('appendReplyToCachedChatContext', () => {
  test('appends the bot reply to a matching cached thread context', () => {
    const next = appendReplyToCachedChatContext({
      state: {
        token: 'token-1',
        lastSyncedAt: '2026-04-23T10:00:00.000Z',
        cachedChatContext: {
          channelId: 'channel-1',
          threadId: 'thread-1',
          fetchedAt: '2026-04-23T10:00:00.000Z',
          context: makeContext(),
        },
      },
      channelId: 'channel-1',
      threadId: 'thread-1',
      messageId: 'bot-reply-1',
      body: 'On it.',
      senderNpub: 'npub1bot',
      at: '2026-04-23T10:00:01.000Z',
    });

    expect(next.cachedChatContext?.fetchedAt).toBe('2026-04-23T10:00:01.000Z');
    expect(next.cachedChatContext?.context?.participants).toContain('npub1bot');
    expect(next.cachedChatContext?.context?.recent_messages.at(-1)).toEqual({
      message_id: 'bot-reply-1',
      parent_message_id: 'thread-1',
      sender_npub: 'npub1bot',
      body: 'On it.',
      attachments: [],
      updated_at: '2026-04-23T10:00:01.000Z',
    });
  });
});

describe('reconcileCachedWorkspaceKey', () => {
  test('replaces stale cached workspace key material with the subscription key', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'agent-chat-yoke-state-'));
    try {
      const db = new Database(join(stateDir, 'flightdeck-cli.db'));
      db.exec(`
        CREATE TABLE workspace_keys (
          workspace_owner_npub TEXT PRIMARY KEY,
          user_npub TEXT NOT NULL,
          ws_key_npub TEXT NOT NULL,
          ws_key_epoch INTEGER NOT NULL DEFAULT 1,
          encrypted_blob TEXT NOT NULL,
          cached_at TEXT NOT NULL
        );
        CREATE TABLE workspace_key_mappings (
          ws_key_npub TEXT PRIMARY KEY,
          user_npub TEXT NOT NULL,
          cached_at TEXT NOT NULL
        );
      `);
      db.query(`
        INSERT INTO workspace_keys (workspace_owner_npub, user_npub, ws_key_npub, ws_key_epoch, encrypted_blob, cached_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        'npub1owner',
        'npub1bot',
        'npub1oldws',
        1,
        JSON.stringify({ workspace_owner_npub: 'npub1owner', ws_key_npub: 'npub1oldws' }),
        '2026-05-17T00:00:00.000Z',
      );
      db.close();

      const changed = reconcileCachedWorkspaceKey(stateDir, {
        workspaceOwnerNpub: 'npub1owner',
        botNpub: 'npub1bot',
        wsKeyNpub: 'npub1newws',
        wsKeyBlobJson: JSON.stringify({
          workspace_owner_npub: 'npub1owner',
          ws_key_npub: 'npub1newws',
          ws_key_epoch: 2,
          encrypted_blob: 'ciphertext',
        }),
      } as never);

      const verifyDb = new Database(join(stateDir, 'flightdeck-cli.db'));
      try {
        expect(changed).toBe(true);
        expect(verifyDb.query('SELECT ws_key_npub, user_npub, ws_key_epoch FROM workspace_keys WHERE workspace_owner_npub = ?')
          .get('npub1owner')).toMatchObject({
            ws_key_npub: 'npub1newws',
            user_npub: 'npub1bot',
            ws_key_epoch: 2,
          });
        expect(verifyDb.query('SELECT user_npub FROM workspace_key_mappings WHERE ws_key_npub = ?')
          .get('npub1newws')).toMatchObject({ user_npub: 'npub1bot' });
      } finally {
        verifyDb.close();
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('publishAgentChatReplyDirect', () => {
  test('publishes directly and reuses prepared key material until the sync fingerprint changes', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wm-agent-chat-publish-'));
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'config.json'), `${JSON.stringify({
      workspaceOwnerNpub: 'npub1workspace',
      appNpub: 'npub1app',
      directHttpsUrl: 'https://tower.example.com',
    }, null, 2)}\n`);

    const db = new Database(join(stateDir, 'yoke.db'));
    db.exec(`
      CREATE TABLE channels (
        record_id TEXT PRIMARY KEY,
        raw_json TEXT NOT NULL
      );
      CREATE TABLE group_keys_cache (
        group_id TEXT,
        group_npub TEXT,
        key_version INTEGER,
        wrapped_by_npub TEXT,
        wrapped_group_nsec TEXT
      );
    `);
    db.query('INSERT INTO channels (record_id, raw_json) VALUES (?, ?)').run(
      'chan-1',
      JSON.stringify({
        record_id: 'chan-1',
        owner_npub: 'npub1bot',
        group_ids: ['grp-1'],
      }),
    );
    db.close();

    const syncCalls: unknown[][] = [];
    let keyMapLoads = 0;
    const modules = {
      SuperbasedClient: class {
        setAuthSecret() {}
        async syncRecords(records: unknown[]) {
          syncCalls.push(records);
          return { ok: true };
        }
        constructor(_: unknown) {}
      } as any,
      loadGroupKeyMap: () => {
        keyMapLoads += 1;
        return {
          resolveGroupId: () => 'grp-1',
          resolveGroupNpub: () => 'npub1grp',
          getCurrent: () => ({ groupId: 'grp-1', groupNpub: 'npub1grp', secret: new Uint8Array([1]) }),
          get: () => ({ groupId: 'grp-1', groupNpub: 'npub1grp', secret: new Uint8Array([1]) }),
        };
      },
      outboundChatMessage: (
        _appNpub: string,
        _session: unknown,
        _groupKeys: unknown,
        _channel: Record<string, unknown>,
        input: { recordId: string; body: string; parentMessageId: string },
      ) => ({
        record_id: input.recordId,
        body: input.body,
        parent_message_id: input.parentMessageId,
      }),
      getCachedWorkspaceKeyBlob: () => null,
      decryptWorkspaceKey: () => {
        throw new Error('not used');
      },
      buildWorkspaceSession: () => {
        throw new Error('not used');
      },
      decodeNsec: () => new Uint8Array(32),
    };
    const input = {
      stateDir,
      botIdentity: {
        botNpub: 'npub1bot',
        botPubkeyHex: 'ab'.repeat(32),
        botSecret: new Uint8Array(32),
      },
      channelId: 'chan-1',
      threadId: 'thread-1',
      body: 'On it.',
    };

    const reply = await publishAgentChatReplyDirect(input, {
      DatabaseCtor: Database,
      modules,
    });
    await publishAgentChatReplyDirect({ ...input, body: 'Second reply.' }, {
      DatabaseCtor: Database,
      modules,
    });

    writeFileSync(join(stateDir, 'runtime-state.json'), `${JSON.stringify({
      token: 'token-1',
      lastSyncedAt: '2026-04-23T10:00:00.000Z',
      cachedChatContext: null,
    })}\n`);
    await publishAgentChatReplyDirect({ ...input, body: 'After sync.' }, {
      DatabaseCtor: Database,
      modules,
    });

    expect(reply.channel_id).toBe('chan-1');
    expect(reply.thread_id).toBe('thread-1');
    expect(reply.status).toBe('sent');
    expect(syncCalls).toHaveLength(3);
    expect(keyMapLoads).toBe(2);
    expect((syncCalls[0] as Array<Record<string, unknown>>)[0]).toMatchObject({
      body: 'On it.',
      parent_message_id: 'thread-1',
    });

    rmSync(stateDir, { recursive: true, force: true });
  });
});
