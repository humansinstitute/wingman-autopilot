import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import { AgentDefinitionStore } from './agent-definition-store';
import { ChatInterceptStateStore } from './chat-intercept-state-store';
import { AgentChatRoutingEvaluator } from './routing-evaluator';
import type { WorkspaceSubscriptionRecord } from './types';

function makeTempDb(): string {
  return join(tmpdir(), `agent-chat-routing-${randomUUID()}.sqlite`);
}

function createSubscription(): WorkspaceSubscriptionRecord {
  const now = new Date().toISOString();
  return {
    subscriptionId: 'sub-1',
    workspaceOwnerNpub: 'npub1workspace',
    backendBaseUrl: 'https://tower.example.com',
    botNpub: 'npub1botshared',
    sourceAppNpub: 'npub1sourceapp',
    wsKeyNpub: null,
    wsKeyStatus: 'active',
    groupKeyStatus: 'active',
    sseStatus: 'connected',
    healthStatus: 'healthy',
    triggerConfigRecordId: null,
    lastSseEventId: null,
    lastAuthOkAt: null,
    lastGroupRefreshAt: null,
    lastErrorCode: null,
    lastErrorAt: null,
    createdAt: now,
    updatedAt: now,
    managedByNpub: 'npub1manager',
    wsKeyBlobJson: null,
    wrappedGroupKeysJson: null,
    lastAuthResult: null,
    lastGroupRefreshResult: null,
    lastRecordPullResult: null,
    lastDecryptResult: null,
    lastRoutingResult: null,
    lastSseEvent: null,
    lastSuccessfulStartupReloadAt: null,
  };
}

describe('AgentChatRoutingEvaluator', () => {
  test('creates one intercept per matching agent without trigger linkage', async () => {
    const dbPath = makeTempDb();
    const agentStore = new AgentDefinitionStore(dbPath);
    const interceptStore = new ChatInterceptStateStore(dbPath);
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent_alpha',
      label: 'Alpha',
      botNpub: 'npub1botshared',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group-chat'],
      workingDirectory: '/tmp/alpha',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });
    agentStore.save({
      agentId: 'agent_beta',
      label: 'Beta',
      botNpub: 'npub1botshared',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group-chat'],
      workingDirectory: '/tmp/beta',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });
    agentStore.save({
      agentId: 'agent_gamma',
      label: 'Gamma',
      botNpub: 'npub1botshared',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group-other'],
      workingDirectory: '/tmp/gamma',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });

    const evaluator = new AgentChatRoutingEvaluator({
      agentStore,
      interceptStore,
      resolveRoutingContext: async () => ({
        recordId: 'msg-1',
        channelId: 'chan-1',
        threadId: 'thread-1',
        participantNpubs: ['npub1human'],
      }),
      extractMessageGroupNpubs: () => ['npub1group-chat'],
    });

    const result = await evaluator.evaluate({
      subscription: createSubscription(),
      wsSession: {
        npub: 'npub1workspacekey',
        secret: new Uint8Array([1]),
      },
      groupKeys: {},
      chatRecordId: 'msg-1',
      chatRecord: {},
      chatMessage: {
        record_id: 'msg-1',
        sender_npub: 'npub1human',
      },
    });

    expect(result.assignments).toHaveLength(2);
    expect(result.assignments.map((entry) => entry.agent.agentId)).toEqual(['agent_alpha', 'agent_beta']);
    expect(result.assignments.map((entry) => entry.intercept.routingKey)).toEqual([
      'npub1workspace+npub1sourceapp+chan-1+thread-1+agent_alpha',
      'npub1workspace+npub1sourceapp+chan-1+thread-1+agent_beta',
    ]);
    expect(result.assignments.every((entry) => entry.intercept.lastDecision === 'pending')).toBe(true);
    expect(interceptStore.listBySubscriptionId('sub-1')).toHaveLength(2);
  });

  test('suppresses same-agent duplicates and self-authored bot messages', async () => {
    const dbPath = makeTempDb();
    const agentStore = new AgentDefinitionStore(dbPath);
    const interceptStore = new ChatInterceptStateStore(dbPath);
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent_alpha',
      label: 'Alpha',
      botNpub: 'npub1botshared',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group-chat'],
      workingDirectory: '/tmp/alpha',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });

    const evaluator = new AgentChatRoutingEvaluator({
      agentStore,
      interceptStore,
      resolveRoutingContext: async () => ({
        recordId: 'msg-1',
        channelId: 'chan-1',
        threadId: 'thread-1',
        participantNpubs: ['npub1human'],
      }),
      extractMessageGroupNpubs: () => ['npub1group-chat'],
    });

    const subscription = createSubscription();
    await evaluator.evaluate({
      subscription,
      wsSession: {
        npub: 'npub1workspacekey',
        secret: new Uint8Array([1]),
      },
      groupKeys: {},
      chatRecordId: 'msg-1',
      chatRecord: {},
      chatMessage: {
        record_id: 'msg-1',
        sender_npub: 'npub1human',
      },
    });

    const duplicateResult = await evaluator.evaluate({
      subscription,
      wsSession: {
        npub: 'npub1workspacekey',
        secret: new Uint8Array([1]),
      },
      groupKeys: {},
      chatRecordId: 'msg-1',
      chatRecord: {},
      chatMessage: {
        record_id: 'msg-1',
        sender_npub: 'npub1human',
      },
    });
    expect(duplicateResult.assignments).toHaveLength(0);
    expect(duplicateResult.diagnostic.details?.duplicate_suppressed_agent_ids).toEqual(['agent_alpha']);

    const selfResult = await evaluator.evaluate({
      subscription,
      wsSession: {
        npub: 'npub1workspacekey',
        secret: new Uint8Array([1]),
      },
      groupKeys: {},
      chatRecordId: 'msg-2',
      chatRecord: {},
      chatMessage: {
        record_id: 'msg-2',
        sender_npub: 'npub1botshared',
      },
    });
    expect(selfResult.assignments).toHaveLength(0);
    expect(selfResult.diagnostic.details?.self_suppressed_agent_ids).toEqual(['agent_alpha']);
    expect(interceptStore.listBySubscriptionId('sub-1')).toHaveLength(1);
  });

  test('suppresses chat records whose latest updater matches the bot', async () => {
    const dbPath = makeTempDb();
    const agentStore = new AgentDefinitionStore(dbPath);
    const interceptStore = new ChatInterceptStateStore(dbPath);
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent_alpha',
      label: 'Alpha',
      botNpub: 'npub1botshared',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group-chat'],
      workingDirectory: '/tmp/alpha',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });

    const evaluator = new AgentChatRoutingEvaluator({
      agentStore,
      interceptStore,
      resolveRoutingContext: async () => ({
        recordId: 'msg-3',
        channelId: 'chan-1',
        threadId: 'thread-1',
        participantNpubs: ['npub1human'],
      }),
      extractMessageGroupNpubs: () => ['npub1group-chat'],
    });

    const result = await evaluator.evaluate({
      subscription: createSubscription(),
      wsSession: {
        npub: 'npub1workspacekey',
        secret: new Uint8Array([1]),
      },
      groupKeys: {},
      chatRecordId: 'msg-3',
      chatRecord: {
        signature_npub: 'npub1botshared',
      },
      chatMessage: {
        record_id: 'msg-3',
        sender_npub: 'npub1workspacekey',
      },
    });

    expect(result.assignments).toHaveLength(0);
    expect(result.diagnostic.details?.self_suppressed_agent_ids).toEqual(['agent_alpha']);
    expect(result.diagnostic.details?.updater_npub).toBe('npub1botshared');
  });

  test('suppresses chat records whose latest updater matches the workspace key', async () => {
    const dbPath = makeTempDb();
    const agentStore = new AgentDefinitionStore(dbPath);
    const interceptStore = new ChatInterceptStateStore(dbPath);
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent_alpha',
      label: 'Alpha',
      botNpub: 'npub1botshared',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group-chat'],
      workingDirectory: '/tmp/alpha',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });

    const evaluator = new AgentChatRoutingEvaluator({
      agentStore,
      interceptStore,
      resolveRoutingContext: async () => ({
        recordId: 'msg-4',
        channelId: 'chan-1',
        threadId: 'thread-1',
        participantNpubs: ['npub1human'],
      }),
      extractMessageGroupNpubs: () => ['npub1group-chat'],
    });

    const subscription = createSubscription();
    subscription.wsKeyNpub = 'npub1workspacekey';
    const result = await evaluator.evaluate({
      subscription,
      wsSession: {
        npub: 'npub1workspacekey',
        secret: new Uint8Array([1]),
      },
      groupKeys: {},
      chatRecordId: 'msg-4',
      chatRecord: {
        signature_npub: 'npub1workspacekey',
      },
      chatMessage: {
        record_id: 'msg-4',
        sender_npub: 'npub1workspacekey',
      },
    });

    expect(result.assignments).toHaveLength(0);
    expect(result.diagnostic.details?.self_suppressed_agent_ids).toEqual(['agent_alpha']);
    expect(result.diagnostic.details?.updater_npub).toBe('npub1workspacekey');
  });
});
