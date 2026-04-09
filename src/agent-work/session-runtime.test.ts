import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';
import { nip19 } from 'nostr-tools';

import type { SessionSnapshot } from '../agents/process-manager';
import type { AgentDefinitionRecord, WorkspaceSubscriptionRecord } from '../agent-chat/types';
import { AgentWorkSessionBindingStore } from './session-binding-store';
import { AgentWorkSessionRuntime, normaliseInboundTaskRecord } from './session-runtime';

function makeTempDb(): string {
  return join(tmpdir(), `agent-work-runtime-${randomUUID()}.sqlite`);
}

function makeSession(id: string, metadata: SessionSnapshot['metadata'] = { AGENT: true, billingMode: 'subscription' }): SessionSnapshot {
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
    workingDirectory: '/tmp/work',
    logs: [],
    metadata,
  };
}

function makeAgent(): AgentDefinitionRecord {
  const now = new Date().toISOString();
  const botNpub = nip19.npubEncode('ab'.repeat(32));
  return {
    agentId: 'agent-work',
    label: 'Worker',
    botNpub,
    workspaceOwnerNpub: 'npub1workspace',
    groupNpubs: ['npub1group'],
    workingDirectory: '/tmp/work',
    capabilities: ['task_dispatch'],
    enabled: true,
    createdAt: now,
    updatedAt: now,
    managedByNpub: 'npub1manager',
  };
}

function botPubkeyHex(agent: AgentDefinitionRecord): string {
  const decoded = nip19.decode(agent.botNpub);
  if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
    throw new Error('Expected bot npub');
  }
  return decoded.data;
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
    wrappedGroupKeysJson: null,
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

describe('AgentWorkSessionRuntime', () => {
  test('chooses task binding first, then flow binding, then creates a session', async () => {
    const bindingStore = new AgentWorkSessionBindingStore(makeTempDb());
    const sessions = new Map<string, SessionSnapshot>();
    sessions.set('task-session', makeSession('task-session'));
    sessions.set('flow-session', makeSession('flow-session'));
    let createCount = 0;

    const runtime = new AgentWorkSessionRuntime({
      defaultAgent: 'codex',
      bindingStore,
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      createSession: async () => {
        createCount += 1;
        const session = makeSession(`created-${createCount}`);
        sessions.set(session.id, session);
        return session;
      },
      updateSessionMetadata: (sessionId, metadata) => {
        const existing = sessions.get(sessionId)!;
        const next = { ...existing, metadata: { ...existing.metadata, ...(metadata ?? {}) } };
        sessions.set(sessionId, next);
        return next;
      },
      addPrompt: () => undefined,
      maybeAutoDispatchQueuedPrompt: () => undefined,
      enableNightWatch: () => undefined,
    });

    const subscription = makeSubscription();
    const agent = makeAgent();
    const now = new Date().toISOString();
    bindingStore.save({
      subscriptionId: subscription.subscriptionId,
      agentId: agent.agentId,
      bindingType: 'task',
      bindingId: 'task-1',
      sessionId: 'task-session',
      lastRecordIdSeen: 'record-1',
      state: 'active',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    bindingStore.save({
      subscriptionId: subscription.subscriptionId,
      agentId: agent.agentId,
      bindingType: 'flow_run',
      bindingId: 'flow-1',
      sessionId: 'flow-session',
      lastRecordIdSeen: 'record-2',
      state: 'active',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const taskFirst = await runtime.handleTaskDispatch({
      subscription,
      agent,
      recordId: 'record-3',
      recordState: null,
      task: {
        taskId: 'task-1',
        flowId: 'flow-a',
        flowRunId: 'flow-1',
        flowStep: 'step-1',
        title: 'Task one',
        description: 'Do the thing',
        state: 'open',
        assignedTo: agent.botNpub,
        deleted: false,
        done: false,
        predecessorTaskIds: [],
      },
    });
    expect(taskFirst?.id).toBe('task-session');

    const flowFallback = await runtime.handleTaskDispatch({
      subscription,
      agent,
      recordId: 'record-4',
      recordState: null,
      task: {
        taskId: 'task-2',
        flowId: 'flow-a',
        flowRunId: 'flow-1',
        flowStep: 'step-2',
        title: 'Task two',
        description: 'Do the next thing',
        state: 'open',
        assignedTo: agent.botNpub,
        deleted: false,
        done: false,
        predecessorTaskIds: [],
      },
    });
    expect(flowFallback?.id).toBe('task-session');

    const created = await runtime.handleTaskDispatch({
      subscription,
      agent,
      recordId: 'record-5',
      recordState: null,
      task: {
        taskId: 'task-3',
        flowId: null,
        flowRunId: null,
        flowStep: null,
        title: 'Task three',
        description: 'Create a new session',
        state: 'open',
        assignedTo: agent.botNpub,
        deleted: false,
        done: false,
        predecessorTaskIds: [],
      },
    });
    expect(created?.id).toBe('created-1');
    expect(createCount).toBe(1);
  });

  test('creates bindings, reuses same flow session, and requeues approvals', async () => {
    const bindingStore = new AgentWorkSessionBindingStore(makeTempDb());
    const sessions = new Map<string, SessionSnapshot>();
    const prompts: Array<{ sessionId: string; content: string }> = [];
    const dispatches: string[] = [];
    const nightWatch: string[] = [];
    let createCount = 0;

    const runtime = new AgentWorkSessionRuntime({
      defaultAgent: 'codex',
      bindingStore,
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      createSession: async (_agent, workingDirectory, name, _origin, explicitNpub, metadata) => {
        createCount += 1;
        const session = makeSession(`session-${createCount}`, {
          AGENT: true,
          billingMode: 'subscription',
          ...metadata,
        });
        session.name = name;
        session.workingDirectory = workingDirectory;
        session.npub = explicitNpub;
        sessions.set(session.id, session);
        return session;
      },
      updateSessionMetadata: (sessionId, metadata) => {
        const existing = sessions.get(sessionId)!;
        const next = { ...existing, metadata: { ...existing.metadata, ...(metadata ?? {}) } };
        sessions.set(sessionId, next);
        return next;
      },
      addPrompt: (sessionId, content) => {
        prompts.push({ sessionId, content });
        return null;
      },
      maybeAutoDispatchQueuedPrompt: (session) => {
        if (session) dispatches.push(session.id);
      },
      enableNightWatch: (sessionId) => {
        nightWatch.push(sessionId);
      },
    });

    const subscription = makeSubscription();
    const agent = makeAgent();

    const first = await runtime.handleTaskDispatch({
      subscription,
      agent,
      recordId: 'record-task-1',
      recordState: null,
      task: {
        taskId: 'task-1',
        flowId: 'flow-a',
        flowRunId: 'run-1',
        flowStep: 'step-1',
        title: 'First task',
        description: 'Initial task',
        state: 'open',
        assignedTo: agent.botNpub,
        deleted: false,
        done: false,
        predecessorTaskIds: [],
      },
    });

    expect(first?.id).toBe('session-1');
    expect(createCount).toBe(1);
    expect(bindingStore.getByBinding(subscription.subscriptionId, agent.agentId, 'flow_run', 'run-1')?.sessionId).toBe('session-1');
    expect(bindingStore.getByBinding(subscription.subscriptionId, agent.agentId, 'task', 'task-1')?.sessionId).toBe('session-1');
    expect(prompts[0]?.content).toContain('Dispatch reason: new task.');
    expect(prompts[0]?.content).toContain('Task id: task-1');

    const second = await runtime.handleTaskDispatch({
      subscription,
      agent,
      recordId: 'record-task-2',
      recordState: null,
      task: {
        taskId: 'task-2',
        flowId: 'flow-a',
        flowRunId: 'run-1',
        flowStep: 'step-2',
        title: 'Second task',
        description: 'Follow-up task',
        state: 'open',
        assignedTo: agent.botNpub,
        deleted: false,
        done: false,
        predecessorTaskIds: [],
      },
    });

    expect(second?.id).toBe('session-1');
    expect(createCount).toBe(1);
    expect(bindingStore.getByBinding(subscription.subscriptionId, agent.agentId, 'task', 'task-2')?.sessionId).toBe('session-1');

    const approval = await runtime.handleApprovalDispatch({
      subscription,
      agent,
      recordId: 'record-approval-1',
      approval: {
        approvalId: 'approval-1',
        flowId: 'flow-a',
        flowRunId: 'run-1',
        flowStep: 'step-2',
        state: 'approved',
      },
    });

    expect(approval?.id).toBe('session-1');
    expect(createCount).toBe(1);
    expect(prompts).toHaveLength(3);
    expect(prompts[2]?.content).toContain('Dispatch reason: approval updated.');
    expect(dispatches).toEqual(['session-1', 'session-1', 'session-1']);
    expect(nightWatch).toEqual(['session-1', 'session-1', 'session-1']);
  });

  test('accepts hex pubkey assignments as well as npub assignments', async () => {
    const bindingStore = new AgentWorkSessionBindingStore(makeTempDb());
    const sessions = new Map<string, SessionSnapshot>();
    let createCount = 0;

    const runtime = new AgentWorkSessionRuntime({
      defaultAgent: 'codex',
      bindingStore,
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      createSession: async () => {
        createCount += 1;
        const session = makeSession(`hex-session-${createCount}`);
        sessions.set(session.id, session);
        return session;
      },
      updateSessionMetadata: (sessionId, metadata) => {
        const existing = sessions.get(sessionId)!;
        const next = { ...existing, metadata: { ...existing.metadata, ...(metadata ?? {}) } };
        sessions.set(sessionId, next);
        return next;
      },
      addPrompt: () => undefined,
      maybeAutoDispatchQueuedPrompt: () => undefined,
      enableNightWatch: () => undefined,
    });

    const subscription = makeSubscription();
    const agent = makeAgent();

    const created = await runtime.handleTaskDispatch({
      subscription,
      agent,
      recordId: 'record-hex-1',
      recordState: null,
      task: {
        taskId: 'task-hex-1',
        flowId: null,
        flowRunId: null,
        flowStep: null,
        title: 'Hex assignment task',
        description: 'Assigned using bot pubkey hex',
        state: 'open',
        assignedTo: botPubkeyHex(agent),
        deleted: false,
        done: false,
        predecessorTaskIds: [],
      },
    });

    expect(created?.id).toBe('hex-session-1');
    expect(createCount).toBe(1);
  });

  test('normalises camelCase wrapped task payloads', () => {
    const task = normaliseInboundTaskRecord({
      payload: {
        taskId: 'task-camel-1',
        flowId: 'flow-1',
        flowRunId: 'run-1',
        flowStep: 'step-1',
        name: 'Camel task',
        details: 'Wrapped payload task',
        status: 'OPEN',
        assignedTo: 'npub1bot',
        predecessorTaskIds: [{ taskId: 'pred-1' }, { id: 'pred-2' }],
      },
    });

    expect(task).not.toBeNull();
    expect(task?.taskId).toBe('task-camel-1');
    expect(task?.flowRunId).toBe('run-1');
    expect(task?.title).toBe('Camel task');
    expect(task?.description).toBe('Wrapped payload task');
    expect(task?.state).toBe('open');
    expect(task?.assignedTo).toBe('npub1bot');
    expect(task?.predecessorTaskIds).toEqual(['pred-1', 'pred-2']);
  });
});
