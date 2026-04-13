import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import type { SessionSnapshot } from '../agents/process-manager';
import type { AgentWorkSessionRuntime } from '../agent-work/session-runtime';
import type { AgentCommentSessionRuntime } from './comment-session-runtime';
import type { BotKeyStoreRecord, WorkspaceSubscriptionRecord } from './types';
import { AgentDefinitionStore } from './agent-definition-store';
import { WorkspaceSubscriptionManager } from './subscription-runtime';
import { buildRecordFamilyHash } from './tower-client';
import { WorkspaceSubscriptionStore } from './workspace-subscription-store';

function makeTempDb(name: string): string {
  return join(tmpdir(), `${name}-${randomUUID()}.sqlite`);
}

function makeSubscription(): WorkspaceSubscriptionRecord {
  const now = new Date().toISOString();
  return {
    subscriptionId: 'sub-1',
    workspaceOwnerNpub: 'npub1workspace',
    backendBaseUrl: 'https://tower.example.com',
    botNpub: 'npub1bot',
    sourceAppNpub: 'npub1source',
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
    wrappedGroupKeysJson: JSON.stringify([{ group_npub: 'npub1group' }]),
    lastAuthResult: null,
    lastGroupRefreshResult: null,
    lastRecordPullResult: null,
    lastDecryptResult: null,
    lastRoutingResult: null,
    lastSseEvent: null,
    recentSseEvents: [],
    recentDispatches: [],
    lastSuccessfulStartupReloadAt: null,
  };
}

function makeBotKeyRecord(): BotKeyStoreRecord {
  const now = new Date().toISOString();
  return {
    id: 'bot-key-1',
    userNpub: 'npub1manager',
    botPubkeyHex: 'ab'.repeat(32),
    botNpub: 'npub1bot',
    displayName: 'Bot',
    encryptedToUser: 'encrypted-user',
    encryptedEscrow: 'encrypted-escrow',
    escrowUuid: 'escrow-1',
    isActive: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function makeSession(id: string): SessionSnapshot {
  return {
    id,
    agent: 'codex',
    port: 3700,
    name: id,
    status: 'running',
    agentRuntimeStatus: 'stable',
    startedAt: new Date().toISOString(),
    npub: 'npub1manager',
    pid: 1234,
    command: ['codex'],
    workingDirectory: '/tmp/agent-work',
    logs: [],
    metadata: { AGENT: true, billingMode: 'subscription' },
  };
}

function seedRuntime(manager: WorkspaceSubscriptionManager, subscriptionId: string): void {
  const runtimeMap = (manager as unknown as { runtimes: Map<string, unknown> }).runtimes;
  runtimeMap.set(subscriptionId, {
    abortController: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    botIdentity: {
      botNpub: 'npub1bot',
      botPubkeyHex: 'ab'.repeat(32),
      botSecret: new Uint8Array(32),
    },
    wsSession: {
      npub: 'npub1wskey',
      secret: new Uint8Array(32),
    },
    groupKeys: { loaded: true },
    wrappedKeyRows: [{ group_npub: 'npub1group' }],
    removed: false,
  });
}

describe('WorkspaceSubscriptionManager agent-work routing', () => {
  test('routes task advisories into the agent-work runtime', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const taskDispatches: Array<{ recordId: string; taskId: string; agentId: string }> = [];
    const approvalDispatches: Array<{ recordId: string; flowRunId: string; agentId: string }> = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async (input) => {
          taskDispatches.push({
            recordId: input.recordId,
            taskId: input.task.taskId,
            agentId: input.agent.agentId,
          });
          return null;
        },
        handleApprovalDispatch: async (input) => {
          approvalDispatches.push({
            recordId: input.recordId,
            flowRunId: input.approval.flowRunId ?? '',
            agentId: input.agent.agentId,
          });
          return null;
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-1',
          record_state: 'active',
          version: 2,
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'task-1',
        flow_id: 'flow-1',
        flow_run_id: 'run-1',
        flow_step: 'step-1',
        title: 'Task one',
        description: 'Complete the task',
        state: 'ready',
        assigned_to: 'npub1bot',
        predecessor_task_ids: [],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-1',
      }),
    );

    expect(taskDispatches).toEqual([
      {
        recordId: 'record-task-1',
        taskId: 'task-1',
        agentId: 'agent-task',
      },
    ]);
    expect(approvalDispatches).toEqual([]);
    expect(next.lastSseEventId).toBe('evt-task-1');
  });

  test('routes approval advisories into the agent-work runtime without creating task dispatches', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-approval-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-approval-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const taskDispatches: Array<{ recordId: string; taskId: string; agentId: string }> = [];
    const approvalDispatches: Array<{ recordId: string; flowRunId: string; agentId: string }> = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async (input) => {
          taskDispatches.push({
            recordId: input.recordId,
            taskId: input.task.taskId,
            agentId: input.agent.agentId,
          });
          return null;
        },
        handleApprovalDispatch: async (input) => {
          approvalDispatches.push({
            recordId: input.recordId,
            flowRunId: input.approval.flowRunId ?? '',
            agentId: input.agent.agentId,
          });
          return null;
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-approval-1',
          record_state: 'active',
          version: 1,
        },
      ],
      decryptRecordPayload: async () => ({
        approval_id: 'approval-1',
        flow_id: 'flow-1',
        flow_run_id: 'run-1',
        flow_step: 'step-2',
        state: 'approved',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-approval-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'approval'),
        record_id: 'record-approval-1',
      }),
    );

    expect(taskDispatches).toEqual([]);
    expect(approvalDispatches).toEqual([
      {
        recordId: 'record-approval-1',
        flowRunId: 'run-1',
        agentId: 'agent-task',
      },
    ]);
  });

  test('records task skip reasons when task advisories are not actionable', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-skip-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-skip-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async () => {
          throw new Error('handleTaskDispatch should not run for skipped task');
        },
        handleApprovalDispatch: async () => null,
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-skip-1',
          record_state: 'active',
          version: 1,
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'task-skip-1',
        title: 'Skipped task',
        state: 'open',
        assigned_to: 'npub1someoneelse',
        predecessor_task_ids: [],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-skip-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-skip-1',
      }),
    );

    expect(next.recentDispatches).toHaveLength(1);
    expect(next.recentDispatches[0]?.kind).toBe('task');
    expect(next.recentDispatches[0]?.action).toBe('skip_assignment');
    expect(next.recentDispatches[0]?.details?.assigned_to).toBe('npub1someoneelse');
  });

  test('records skip_not_ready when an assigned task is not ready yet', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-not-ready-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-not-ready-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async () => {
          throw new Error('handleTaskDispatch should not run until the task is ready');
        },
        handleApprovalDispatch: async () => null,
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-not-ready-1',
          record_state: 'active',
          version: 1,
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'task-not-ready-1',
        title: 'Not ready task',
        description: 'Assigned, but still in progress',
        state: 'in_progress',
        assigned_to_npub: 'npub1bot',
        predecessor_task_ids: [],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-not-ready-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-not-ready-1',
      }),
    );

    expect(next.recentDispatches).toHaveLength(1);
    expect(next.recentDispatches[0]?.action).toBe('skip_not_ready');
    expect(next.recentDispatches[0]?.details?.assigned_to).toBe('npub1bot');
    expect(next.recentDispatches[0]?.details?.state).toBe('in_progress');
  });

  test('skips task dispatch when the bot was the latest updater', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-self-update-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-self-update-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async () => {
          throw new Error('handleTaskDispatch should not run for bot-authored task rewrites');
        },
        handleApprovalDispatch: async () => null,
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-self-1',
          record_state: 'active',
          version: 2,
          signature_npub: 'npub1bot',
        },
        {
          record_id: 'record-task-self-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1human',
        },
      ],
      decryptRecordPayload: async (params) => ({
        task_id: 'task-self-1',
        title: 'Self updated task',
        description: 'Same task body',
        state: 'open',
        assigned_to_npub: 'npub1bot',
        predecessor_task_ids: [],
        ...(params.record.version === 1 ? {} : {}),
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-self-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-self-1',
      }),
    );

    expect(next.recentDispatches).toHaveLength(1);
    expect(next.recentDispatches[0]?.action).toBe('task_skip_self_update');
    expect(next.recentDispatches[0]?.details?.task_id).toBe('task-self-1');
    expect(next.recentDispatches[0]?.details?.updater_npub).toBe('npub1bot');
  });

  test('skips task dispatch when the workspace key was the latest updater', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-ws-self-update-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-ws-self-update-agents'));
    const subscription = store.save({
      ...makeSubscription(),
      wsKeyNpub: 'npub1wskey',
    });
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async () => {
          throw new Error('handleTaskDispatch should not run for workspace-key-authored task rewrites');
        },
        handleApprovalDispatch: async () => null,
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-self-2',
          record_state: 'active',
          version: 2,
          signature_npub: 'npub1wskey',
        },
        {
          record_id: 'record-task-self-2',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1human',
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'task-self-2',
        title: 'Workspace self updated task',
        description: 'Same workspace-signed task body',
        state: 'open',
        assigned_to_npub: 'npub1bot',
        predecessor_task_ids: [],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-self-2',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-self-2',
      }),
    );

    expect(next.recentDispatches).toHaveLength(1);
    expect(next.recentDispatches[0]?.action).toBe('task_skip_self_update');
    expect(next.recentDispatches[0]?.details?.task_id).toBe('task-self-2');
    expect(next.recentDispatches[0]?.details?.updater_npub).toBe('npub1wskey');
  });

  test('dispatches a self-authored new task when there is no previous version', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-self-new-task-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-self-new-task-agents'));
    const subscription = store.save({
      ...makeSubscription(),
      wsKeyNpub: 'npub1wskey',
    });
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const taskDispatches: Array<{ recordId: string; taskId: string; agentId: string }> = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async (input) => {
          taskDispatches.push({
            recordId: input.recordId,
            taskId: input.task.taskId,
            agentId: input.agent.agentId,
          });
          return null;
        },
        handleApprovalDispatch: async () => null,
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-self-new-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1wskey',
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'task-self-new-1',
        title: 'New self-created task',
        description: 'Created by the agent for itself',
        state: 'ready',
        assigned_to_npub: 'npub1bot',
        predecessor_task_ids: [],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-self-new-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-self-new-1',
      }),
    );

    expect(taskDispatches).toEqual([
      {
        recordId: 'record-task-self-new-1',
        taskId: 'task-self-new-1',
        agentId: 'agent-task',
      },
    ]);
    expect(next.recentDispatches[0]?.action).toBe('task_skip_runtime_returned_null');
  });

  test('dispatches a self-authored task when meaningful dispatch fields change', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-self-changed-task-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-self-changed-task-agents'));
    const subscription = store.save({
      ...makeSubscription(),
      wsKeyNpub: 'npub1wskey',
    });
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const taskDispatches: Array<{ recordId: string; taskId: string; agentId: string }> = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async (input) => {
          taskDispatches.push({
            recordId: input.recordId,
            taskId: input.task.taskId,
            agentId: input.agent.agentId,
          });
          return null;
        },
        handleApprovalDispatch: async () => null,
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-self-changed-1',
          record_state: 'active',
          version: 2,
          signature_npub: 'npub1wskey',
        },
        {
          record_id: 'record-task-self-changed-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1human',
        },
      ],
      decryptRecordPayload: async (params) => ({
        task_id: 'task-self-changed-1',
        title: 'Self changed task',
        description: params.record.version === 2 ? 'Expanded task description' : 'Short task description',
        state: 'ready',
        assigned_to_npub: 'npub1bot',
        predecessor_task_ids: [],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-self-changed-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-self-changed-1',
      }),
    );

    expect(taskDispatches).toEqual([
      {
        recordId: 'record-task-self-changed-1',
        taskId: 'task-self-changed-1',
        agentId: 'agent-task',
      },
    ]);
  });

  test('routes task comments into the agent-work runtime when the comment targets a task', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-task-comment-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-task-comment-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const taskCommentDispatches: Array<{ recordId: string; taskId: string; commentId: string; agentId: string }> = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async () => null,
        handleApprovalDispatch: async () => null,
        handleTaskCommentDispatch: async (input) => {
          taskCommentDispatches.push({
            recordId: input.recordId,
            taskId: input.comment.targetRecordId ?? '',
            commentId: input.comment.commentId,
            agentId: input.agent.agentId,
          });
          return null;
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-comment-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1reviewer',
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-task-1',
        target_record_id: 'task-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:task`,
        body: 'Please check the task again.',
        comment_status: 'open',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-comment-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-task-comment-1',
      }),
    );

    expect(taskCommentDispatches).toEqual([
      {
        recordId: 'record-task-comment-1',
        taskId: 'task-1',
        commentId: 'comment-task-1',
        agentId: 'agent-task',
      },
    ]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('task_comment_skip_no_live_session');
  });

  test('routes document comments into the agent-comment runtime when the comment targets a document', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-comment-document-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-comment-document-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-comment',
      label: 'Comment Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-comment',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
      chatPromptTemplate: '',
      taskPromptTemplate: '',
    });

    const documentCommentDispatches: Array<{ recordId: string; documentId: string; commentId: string; agentId: string }> = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentCommentRuntime: {
        handleDocumentCommentDispatch: async (input) => {
          documentCommentDispatches.push({
            recordId: input.recordId,
            documentId: input.comment.targetRecordId ?? '',
            commentId: input.comment.commentId,
            agentId: input.agent.agentId,
          });
          return makeSession('doc-comment-session');
        },
      } as unknown as AgentCommentSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-doc-comment-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1reviewer',
          group_npubs: ['npub1group'],
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-doc-1',
        target_record_id: 'doc-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:document`,
        body: 'Please respond in the document thread.',
        comment_status: 'open',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-doc-comment-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-doc-comment-1',
      }),
    );

    expect(documentCommentDispatches).toEqual([
      {
        recordId: 'record-doc-comment-1',
        documentId: 'doc-1',
        commentId: 'comment-doc-1',
        agentId: 'agent-comment',
      },
    ]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('document_comment_dispatch');
    expect(next.recentDispatches[0]?.sessionId).toBe('doc-comment-session');
  });

  test('dispatches tasks even when predecessor links are present', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-predecessor-dispatch-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-predecessor-dispatch-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const taskDispatches: Array<{ recordId: string; taskId: string; agentId: string }> = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async (input) => {
          taskDispatches.push({
            recordId: input.recordId,
            taskId: input.task.taskId,
            agentId: input.agent.agentId,
          });
          return null;
        },
        handleApprovalDispatch: async () => null,
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-pred-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1human',
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'task-pred-1',
        title: 'Task with predecessor',
        description: 'Should still dispatch to the agent',
        state: 'ready',
        assigned_to_npub: 'npub1bot',
        predecessor_task_ids: ['pred-1'],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-pred-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-pred-1',
      }),
    );

    expect(taskDispatches).toEqual([
      {
        recordId: 'record-task-pred-1',
        taskId: 'task-pred-1',
        agentId: 'agent-task',
      },
    ]);
    expect(next.recentDispatches[0]?.action).toBe('task_skip_runtime_returned_null');
  });
});
