import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import type { SessionSnapshot } from '../agents/process-manager';
import type { AgentWorkSessionRuntime } from '../agent-work/session-runtime';
import type { AgentCommentSessionRuntime } from './comment-session-runtime';
import type { BotKeyStoreRecord, WorkspaceSubscriptionRecord } from './types';
import { DispatchPipelineRuntime } from './dispatch-pipelines/runtime';
import { DispatchRouteStore } from './dispatch-pipelines/route-store';
import { AgentDefinitionStore } from './agent-definition-store';
import { WorkspaceSubscriptionManager } from './subscription-runtime';
import { buildRecordFamilyHash } from './tower-client';
import { WorkspaceSubscriptionStore } from './workspace-subscription-store';
import { PipelineStore, type PipelineRunRecord } from '../pipelines/pipeline-store';

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

function makePipelineRun(id: string, input: Record<string, unknown>): PipelineRunRecord {
  const now = new Date().toISOString();
  return {
    id,
    definitionId: 'task-pipeline',
    definitionPath: '/tmp/task-pipeline.json',
    name: 'Task Pipeline',
    status: 'ok',
    ownerNpub: 'npub1manager',
    ownerAlias: 'manager',
    scope: 'user',
    input,
    current: input,
    cursorIndex: 0,
    activeStepId: null,
    result: input,
    error: null,
    startedAt: now,
    completedAt: now,
  };
}

describe('WorkspaceSubscriptionManager agent-work routing', () => {
  test('suppresses legacy dispatch when pipeline routes are required but missing', async () => {
    const runtime = new DispatchPipelineRuntime({
      routeStore: new DispatchRouteStore(makeTempDb('agent-pipeline-required-routes')),
      pipelineStore: new PipelineStore(makeTempDb('agent-pipeline-required-runs')),
      getSessionApiContext: () => null as any,
      callbackOrigin: 'http://localhost:3600',
      requirePipelineRoutes: true,
    });

    const result = await runtime.dispatch({
      subscription: makeSubscription(),
      triggerKind: 'task',
      capability: 'task_dispatch',
      recordId: 'task-without-route',
      record: {},
      payload: { task_id: 'task-without-route' },
      recordFamily: 'task',
      recordState: 'ready',
      recordVersion: 1,
      updaterNpub: 'npub1user',
      bindingType: 'task',
      bindingId: 'task-without-route',
      groupNpubs: ['npub1group'],
    });

    expect(result.handled).toBe(true);
    expect(result.historyEntries[0]?.action).toBe('task_pipeline_route_missing');
    expect(result.historyEntries[0]?.suppressionReason).toBe('pipeline_route_required');
  });

  test('includes chat message convenience fields in chat pipeline input', async () => {
    const routeStore = new DispatchRouteStore(makeTempDb('agent-chat-pipeline-routes'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-chat-pipeline-agents'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-chat-pipeline-runs'));
    const subscription = makeSubscription();
    const now = new Date().toISOString();
    agentStore.save({
      agentId: 'agent-chat',
      label: 'Chat Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-chat',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });
    routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      pipelineDefinitionId: 'chat-pipeline',
    });
    const runInputs: Record<string, unknown>[] = [];
    const runtime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      defaultAgent: 'codex',
      loadDefinition: async () => ({
        id: 'chat-pipeline',
        slug: 'chat-pipeline',
        name: 'Chat Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/chat-pipeline.json',
        spec: { name: 'Chat Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('chat-run-1', input.input);
      },
    });

    const result = await runtime.dispatch({
      subscription,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      recordId: 'chat-record-1',
      record: {},
      payload: {
        body: 'Can you see this message?',
        sender_npub: 'npub1sender',
        channel_id: 'channel-1',
        parent_message_id: null,
        attachments: [],
      },
      recordFamily: 'chat',
      recordState: 'active',
      recordVersion: 1,
      updaterNpub: 'npub1sender',
      bindingType: 'thread',
      bindingId: 'thread-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      groupNpubs: ['npub1group'],
    });

    expect(result.handled).toBe(true);
    expect(runInputs).toHaveLength(1);
    expect((runInputs[0]?.record as any)?.payload?.body).toBe('Can you see this message?');
    expect((runInputs[0]?.chat as any)?.messageText).toBe('Can you see this message?');
    expect((runInputs[0]?.chat as any)?.channelId).toBe('channel-1');
    expect((runInputs[0]?.chat as any)?.threadId).toBe('thread-1');
    expect((runInputs[0]?.agent as any)?.defaultAgent).toBe('codex');
  });

  test('starts configured task dispatch pipeline and records run history', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-pipeline-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-pipeline-agents'));
    const routeStore = new DispatchRouteStore(makeTempDb('agent-work-pipeline-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-work-pipeline-runs'));
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

    const route = routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'task',
      capability: 'task_dispatch',
      pipelineDefinitionId: 'task-pipeline',
      matchJson: { assignedTo: 'bot' },
    });
    const runInputs: Record<string, unknown>[] = [];
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => ({
        id: 'task-pipeline',
        slug: 'task-pipeline',
        name: 'Task Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/task-pipeline.json',
        spec: { name: 'Task Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('pipeline-run-1', input.input);
      },
    });

    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      dispatchPipelineRuntime,
      agentWorkRuntime: {
        handleTaskDispatch: async () => {
          throw new Error('legacy task dispatch should not run when a pipeline route matches');
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-pipeline-1',
          record_state: 'active',
          version: 3,
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'task-pipeline-1',
        title: 'Pipeline task',
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
      'evt-task-pipeline-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-pipeline-1',
      }),
    );

    expect(runInputs).toHaveLength(1);
    expect((runInputs[0]?.dispatch as any)?.routeId).toBe(route.routeId);
    expect((runInputs[0]?.record as any)?.recordId).toBe('record-task-pipeline-1');
    expect(next.lastPipelineRunId).toBe('pipeline-run-1');
    expect(next.recentDispatches[0]?.routeId).toBe(route.routeId);
    expect(next.recentDispatches[0]?.pipelineRunId).toBe('pipeline-run-1');
    expect(next.recentDispatches[0]?.action).toBe('task_pipeline_dispatch');
  });

  test('suppresses legacy dispatch when a configured task route is disabled', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-disabled-pipeline-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-disabled-pipeline-agents'));
    const routeStore = new DispatchRouteStore(makeTempDb('agent-work-disabled-pipeline-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-work-disabled-pipeline-runs'));
    const subscription = store.save(makeSubscription());

    const route = routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'task',
      capability: 'task_dispatch',
      pipelineDefinitionId: 'task-pipeline',
      enabled: false,
    });
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      runPipeline: async () => {
        throw new Error('disabled route should not start a pipeline');
      },
    });
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      dispatchPipelineRuntime,
      agentWorkRuntime: {
        handleTaskDispatch: async () => {
          throw new Error('legacy task dispatch should not run when a route is disabled');
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [{ record_id: 'record-task-disabled-1', record_state: 'active', version: 1 }],
      decryptRecordPayload: async () => ({
        task_id: 'task-disabled-1',
        title: 'Disabled task',
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
      'evt-task-disabled-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-disabled-1',
      }),
    );

    expect(next.recentDispatches[0]?.routeId).toBe(route.routeId);
    expect(next.recentDispatches[0]?.status).toBe('suppressed');
    expect(next.recentDispatches[0]?.suppressionReason).toBe('route_disabled');
  });

  test('starts configured comment dispatch pipeline before the disabled comment stub', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-comment-pipeline-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-comment-pipeline-agents'));
    const routeStore = new DispatchRouteStore(makeTempDb('agent-comment-pipeline-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-comment-pipeline-runs'));
    const subscription = store.save(makeSubscription());

    const route = routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'comment',
      capability: 'comment_dispatch',
      pipelineDefinitionId: 'comment-pipeline',
    });
    const runInputs: Record<string, unknown>[] = [];
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => ({
        id: 'comment-pipeline',
        slug: 'comment-pipeline',
        name: 'Comment Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/comment-pipeline.json',
        spec: { name: 'Comment Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('comment-pipeline-run-1', input.input);
      },
    });
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      dispatchPipelineRuntime,
      commentDispatchRuntime: {
        handleDisabledDispatch: () => {
          throw new Error('disabled comment stub should not run when a pipeline route matches');
        },
      } as never,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-comment-pipeline-1',
          record_state: 'active',
          version: 2,
          group_npubs: ['npub1group'],
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-pipeline-1',
        target_record_id: 'task-pipeline-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:task`,
        sender_npub: 'npub1reviewer',
        body: 'Can you clarify the current blocker?',
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
      'evt-comment-pipeline-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-comment-pipeline-1',
      }),
    );

    expect(runInputs).toHaveLength(1);
    expect((runInputs[0]?.dispatch as any)?.routeId).toBe(route.routeId);
    expect((runInputs[0]?.record as any)?.recordId).toBe('record-comment-pipeline-1');
    expect((runInputs[0]?.record as any)?.payload?.commentId).toBe('comment-pipeline-1');
    expect(next.lastPipelineRunId).toBe('comment-pipeline-run-1');
    expect(next.recentDispatches[0]?.routeId).toBe(route.routeId);
    expect(next.recentDispatches[0]?.action).toBe('comment_pipeline_dispatch');
  });

  test('skips workspace-key-authored comments before configured comment pipelines', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-comment-pipeline-self-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-comment-pipeline-self-agents'));
    const routeStore = new DispatchRouteStore(makeTempDb('agent-comment-pipeline-self-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-comment-pipeline-self-runs'));
    const subscription = store.save(makeSubscription());

    routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'comment',
      capability: 'comment_dispatch',
      pipelineDefinitionId: 'comment-pipeline',
    });
    const runInputs: Record<string, unknown>[] = [];
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => ({
        id: 'comment-pipeline',
        slug: 'comment-pipeline',
        name: 'Comment Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/comment-pipeline.json',
        spec: { name: 'Comment Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('comment-pipeline-run-1', input.input);
      },
    });
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      dispatchPipelineRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-comment-pipeline-self-1',
          record_state: 'active',
          version: 1,
          signature_npub: subscription.wsKeyNpub,
          group_npubs: ['npub1group'],
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-pipeline-self-1',
        target_record_id: 'task-pipeline-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:task`,
        sender_npub: 'npub1reviewer',
        body: 'Agent-created task comment.',
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
      'evt-comment-pipeline-self-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-comment-pipeline-self-1',
      }),
    );

    expect(runInputs).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('task_comment_skip_self_update');
    expect(next.recentDispatches[0]?.details?.is_me).toBe(true);
  });

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
        handleTaskDispatch: async (input: any) => {
          taskDispatches.push({
            recordId: input.recordId,
            taskId: input.task.taskId,
            agentId: input.agent.agentId,
          });
          return null;
        },
        handleApprovalDispatch: async (input: any) => {
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
      capabilities: ['approval_dispatch'],
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
        handleTaskDispatch: async (input: any) => {
          taskDispatches.push({
            recordId: input.recordId,
            taskId: input.task.taskId,
            agentId: input.agent.agentId,
          });
          return null;
        },
        handleApprovalDispatch: async (input: any) => {
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

  test('routes kickoff tasks into flow dispatch instead of ordinary task dispatch', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-flow-dispatch-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-flow-dispatch-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-flow',
      label: 'Flow Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['flow_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const flowDispatches: Array<{ recordId: string; taskId: string; agentId: string }> = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async () => {
          throw new Error('handleTaskDispatch should not run for kickoff tasks');
        },
        handleFlowDispatch: async (input: any) => {
          flowDispatches.push({
            recordId: input.recordId,
            taskId: input.task.taskId,
            agentId: input.agent.agentId,
          });
          return makeSession('flow-session-1');
        },
        handleApprovalDispatch: async () => null,
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-kickoff-1',
          record_state: 'active',
          version: 1,
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'kickoff-1',
        flow_id: 'flow-1',
        flow_run_id: null,
        flow_step: null,
        title: 'Kickoff',
        description: 'Start the flow',
        state: 'new',
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
      'evt-kickoff-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-kickoff-1',
      }),
    );

    expect(flowDispatches).toEqual([
      {
        recordId: 'record-kickoff-1',
        taskId: 'kickoff-1',
        agentId: 'agent-flow',
      },
    ]);
    expect(next.recentDispatches[0]?.kind).toBe('flow');
    expect(next.recentDispatches[0]?.action).toBe('flow_dispatch');
  });

  test('routes review tasks into task review instead of delivery dispatch', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-review-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-review-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-review',
      label: 'Review Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_review'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const reviewDispatches: Array<{ recordId: string; taskId: string; agentId: string }> = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async () => {
          throw new Error('handleTaskDispatch should not run for review tasks');
        },
        handleTaskReview: async (input: any) => {
          reviewDispatches.push({
            recordId: input.recordId,
            taskId: input.task.taskId,
            agentId: input.agent.agentId,
          });
          return makeSession('review-session-1');
        },
        handleApprovalDispatch: async () => null,
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-review-1',
          record_state: 'active',
          version: 1,
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'review-1',
        flow_id: 'flow-1',
        flow_run_id: 'run-1',
        flow_step: 3,
        title: 'Review work',
        description: 'Continue orchestration',
        state: 'review',
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
      'evt-review-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-review-1',
      }),
    );

    expect(reviewDispatches).toEqual([
      {
        recordId: 'record-review-1',
        taskId: 'review-1',
        agentId: 'agent-review',
      },
    ]);
    expect(next.recentDispatches[0]?.kind).toBe('review');
    expect(next.recentDispatches[0]?.action).toBe('task_review');
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
        handleTaskDispatch: async (input: any) => {
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
        handleTaskDispatch: async (input: any) => {
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

  test('keeps task comments off the task-dispatch runtime when only task dispatch is enabled', async () => {
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
        handleTaskCommentDispatch: async (input: any) => {
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
        sender_npub: 'npub1reviewer',
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

    expect(taskCommentDispatches).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('task_comment_skip_no_comment_dispatch_agent');
  });

  test('skips self-authored task comments instead of routing them back into the agent-work runtime', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-task-comment-self-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-task-comment-self-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['comment_dispatch'],
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
        handleTaskCommentDispatch: async (input: any) => {
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
          record_id: 'record-task-comment-self-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1servicewriter',
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-task-self-1',
        target_record_id: 'task-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:task`,
        body: 'No change to the required next action.',
        comment_status: 'open',
        sender_npub: subscription.botNpub,
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
      'evt-task-comment-self-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-task-comment-self-1',
      }),
    );

    expect(taskCommentDispatches).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('task_comment_skip_self_update');
  });

  test('records task comment dispatch as disabled when comment dispatch is enabled', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-task-comment-disabled-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-task-comment-disabled-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-comment',
      label: 'Comment Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-comment',
      capabilities: ['comment_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const taskCommentDispatches: string[] = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async () => null,
        handleApprovalDispatch: async () => null,
        handleTaskCommentDispatch: async (input: any) => {
          taskCommentDispatches.push(input.recordId);
          return null;
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-comment-disabled-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1reviewer',
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-task-disabled-1',
        target_record_id: 'task-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:task`,
        body: 'Please check the task again.',
        comment_status: 'open',
        sender_npub: 'npub1reviewer',
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
      'evt-task-comment-disabled-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-task-comment-disabled-1',
      }),
    );

    expect(taskCommentDispatches).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('task_comment_dispatch_disabled');
    expect(next.recentDispatches[0]?.sessionId).toBeNull();
    expect(next.recentDispatches[0]?.details?.disabled_reason).toBe('comment_dispatch_stubbed');
  });

  test('records document comment dispatch as disabled when comment dispatch is enabled', async () => {
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
      capabilities: ['comment_dispatch'],
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
        handleDocumentCommentDispatch: async (input: any) => {
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

    expect(documentCommentDispatches).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('document_comment_dispatch_disabled');
    expect(next.recentDispatches[0]?.sessionId).toBeNull();
  });

  test('skips existing comment advisories from startup or reconnect replay', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-comment-existing-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-comment-existing-agents'));
    const subscription = store.save({
      ...makeSubscription(),
      lastSuccessfulStartupReloadAt: '2026-04-24T08:00:00.000Z',
    });
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-comment',
      label: 'Comment Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-comment',
      capabilities: ['comment_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
      chatPromptTemplate: '',
      taskPromptTemplate: '',
    });

    const documentCommentDispatches: string[] = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentCommentRuntime: {
        handleDocumentCommentDispatch: async (input: any) => {
          documentCommentDispatches.push(input.recordId);
          return makeSession('doc-comment-session');
        },
      } as unknown as AgentCommentSessionRuntime,
      fetchRecordHistory: async () => {
        throw new Error('existing comment advisories should be skipped before record fetch');
      },
      decryptRecordPayload: async () => {
        throw new Error('existing comment advisories should be skipped before decrypt');
      },
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
      'evt-existing-comment-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-existing-comment-1',
        updated_at: '2026-04-24T07:27:59.631Z',
      }),
    );

    expect(documentCommentDispatches).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('comment_skip_existing_record');
    expect(next.recentDispatches[0]?.sessionId).toBeNull();
  });

  test('skips self-authored document comments instead of routing them back into the agent-comment runtime', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-comment-document-self-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-comment-document-self-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-comment',
      label: 'Comment Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-comment',
      capabilities: ['comment_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
      chatPromptTemplate: '',
      taskPromptTemplate: '',
    });

    const documentCommentDispatches: string[] = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentCommentRuntime: {
        handleDocumentCommentDispatch: async (input: any) => {
          documentCommentDispatches.push(input.recordId);
          return makeSession('doc-comment-session');
        },
      } as unknown as AgentCommentSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-doc-comment-self-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1reviewer',
          group_npubs: ['npub1group'],
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-doc-self-1',
        target_record_id: 'doc-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:document`,
        sender_npub: subscription.botNpub,
        body: 'Self-authored reply.',
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
      'evt-doc-comment-self-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-doc-comment-self-1',
      }),
    );

    expect(documentCommentDispatches).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('document_comment_skip_self_update');
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
        handleTaskDispatch: async (input: any) => {
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
