import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import { AgentDefinitionStore } from './agent-definition-store';
import { WorkspaceSubscriptionManager } from './subscription-runtime';
import { WorkspaceSubscriptionStore } from './workspace-subscription-store';

function makeTempDb(): string {
  return join(tmpdir(), `agent-chat-subscription-runtime-${randomUUID()}.sqlite`);
}

describe('WorkspaceSubscriptionManager', () => {
  test('derives agent groups from refreshed wrapped group keys when none are supplied', () => {
    const dbPath = makeTempDb();
    const store = new WorkspaceSubscriptionStore(dbPath);
    const agentStore = new AgentDefinitionStore(dbPath);
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      botKeyStore: {
        getActiveKeyForUser: () => null,
        getActiveKeyForBotNpub: () => null,
      },
    });

    const now = new Date().toISOString();
    store.save({
      subscriptionId: 'sub-1',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      botNpub: 'npub1botshared',
      sourceAppNpub: 'npub1sourceapp',
      wsKeyNpub: 'npub1wskey',
      wsKeyStatus: 'active',
      groupKeyStatus: 'active',
      sseStatus: 'connected',
      healthStatus: 'healthy',
      triggerConfigRecordId: null,
      lastSseEventId: null,
      lastAuthOkAt: now,
      lastGroupRefreshAt: now,
      lastErrorCode: null,
      lastErrorAt: null,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
      wsKeyBlobJson: null,
      wrappedGroupKeysJson: JSON.stringify([
        { group_npub: 'npub1groupb' },
        { group_npub: 'npub1groupa' },
        { group_npub: 'npub1groupa' },
        {},
      ]),
      lastAuthResult: null,
      lastGroupRefreshResult: null,
      lastRecordPullResult: null,
      lastDecryptResult: null,
      lastRoutingResult: null,
      lastSseEvent: null,
      lastSuccessfulStartupReloadAt: null,
    });

    const record = manager.saveAgentForManager({
      managedByNpub: 'npub1manager',
      agentId: 'agent_auto',
      label: 'Auto Agent',
      botNpub: 'npub1botshared',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: [],
      workingDirectory: '/tmp/agent-auto',
      capabilities: ['chat_intercept'],
      enabled: true,
    });

    expect(record.groupNpubs).toEqual(['npub1groupa', 'npub1groupb']);
  });
});
