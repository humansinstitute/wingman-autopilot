import type { AgentType } from '../config';
import type { SessionOrigin, SessionSnapshot } from '../agents/process-manager';
import type { SessionMetadataInput } from '../sessions/session-metadata';
import type { AgentDefinitionRecord, InboundApprovalRecord, InboundTaskRecord, WorkspaceSubscriptionRecord } from '../agent-chat/types';
import {
  agentWorkSessionBindingStore,
  type AgentWorkBindingType,
  type AgentWorkSessionBindingRecord,
  AgentWorkSessionBindingStore,
} from './session-binding-store';
import {
  buildAgentWorkGoal,
  buildApprovalDispatchPrompt,
  buildTaskDispatchPrompt,
} from './prompts';

type DispatchReason = 'new task' | 'task updated';

export interface AgentWorkRuntimeDependencies {
  defaultAgent: AgentType;
  bindingStore?: AgentWorkSessionBindingStore;
  getSession: (sessionId: string) => SessionSnapshot | null;
  createSession: (
    agent: AgentType,
    workingDirectory: string,
    name: string,
    origin: SessionOrigin,
    explicitNpub?: string,
    metadata?: SessionMetadataInput,
  ) => Promise<SessionSnapshot>;
  updateSessionMetadata: (sessionId: string, metadata: SessionMetadataInput) => SessionSnapshot | null;
  addPrompt: (sessionId: string, content: string) => unknown;
  maybeAutoDispatchQueuedPrompt: (session: SessionSnapshot | null) => void | Promise<void>;
  enableNightWatch: (sessionId: string) => unknown;
}

export interface AgentWorkTaskDispatchInput {
  subscription: WorkspaceSubscriptionRecord;
  agent: AgentDefinitionRecord;
  recordId: string;
  recordState: string | null;
  task: InboundTaskRecord;
}

export interface AgentWorkApprovalDispatchInput {
  subscription: WorkspaceSubscriptionRecord;
  agent: AgentDefinitionRecord;
  recordId: string;
  approval: InboundApprovalRecord;
}

const TERMINAL_TASK_STATES = new Set([
  'done',
  'completed',
  'cancelled',
  'canceled',
  'archived',
  'deleted',
  'rejected',
]);

function compactText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function compactStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => compactText(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function compactBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.trim()))));
}

function buildSessionName(agent: AgentDefinitionRecord, task: InboundTaskRecord): string {
  const title = compactText(task.title) ?? task.taskId;
  return `${agent.label || agent.agentId} Work ${title}`.slice(0, 120);
}

function buildSessionOrigin(agent: AgentDefinitionRecord, task: InboundTaskRecord): SessionOrigin {
  return {
    type: 'agent-work',
    id: task.flowRunId ?? task.taskId,
    label: `${agent.agentId}:${task.taskId}`,
  };
}

function isLiveSession(session: SessionSnapshot | null): session is SessionSnapshot {
  if (!session) {
    return false;
  }
  return session.status === 'running' || session.status === 'starting';
}

function mergeTaskIds(session: SessionSnapshot | null, taskId: string): string[] {
  const existing = Array.isArray(session?.metadata?.taskIds) ? session.metadata.taskIds : [];
  return uniqueStrings([...existing, taskId]);
}

function hasBlockingPredecessors(task: InboundTaskRecord): boolean {
  return task.predecessorTaskIds.length > 0;
}

function isTerminalTask(task: InboundTaskRecord, recordState: string | null): boolean {
  if (recordState === 'deleted' || task.deleted || task.done) {
    return true;
  }
  return Boolean(task.state && TERMINAL_TASK_STATES.has(task.state));
}

function resolveTaskDispatchReason(
  taskBinding: AgentWorkSessionBindingRecord | null,
): DispatchReason {
  return taskBinding ? 'task updated' : 'new task';
}

function buildMetadataPatch(params: {
  session: SessionSnapshot | null;
  task: InboundTaskRecord;
  bindingType: AgentWorkBindingType;
  bindingId: string;
  managedByNpub: string | null;
}): SessionMetadataInput {
  return {
    AGENT: true,
    role: 'agent-work',
    goal: buildAgentWorkGoal(params.task),
    nextAction: 'reflect',
    bindingType: params.bindingType,
    bindingId: params.bindingId,
    flowId: params.task.flowId ?? undefined,
    flowRunId: params.task.flowRunId ?? undefined,
    taskIds: mergeTaskIds(params.session, params.task.taskId),
    createdByNpub: params.session?.metadata?.createdByNpub ?? params.managedByNpub ?? undefined,
    lastManagedByNpub: params.managedByNpub ?? undefined,
    chargeToNpub: params.session?.metadata?.chargeToNpub ?? params.managedByNpub ?? undefined,
  };
}

export function normaliseInboundTaskRecord(payload: Record<string, unknown>): InboundTaskRecord | null {
  const taskId = compactText(payload.task_id) ?? compactText(payload.id);
  if (!taskId) {
    return null;
  }
  return {
    taskId,
    flowId: compactText(payload.flow_id),
    flowRunId: compactText(payload.flow_run_id),
    flowStep: compactText(payload.flow_step),
    title: compactText(payload.title) ?? taskId,
    description: compactText(payload.description),
    state: compactText(payload.state)?.toLowerCase() ?? null,
    assignedTo: compactText(payload.assigned_to),
    deleted: compactBoolean(payload.deleted),
    done: compactBoolean(payload.done),
    predecessorTaskIds: compactStringArray(payload.predecessor_task_ids),
  };
}

export function normaliseInboundApprovalRecord(payload: Record<string, unknown>): InboundApprovalRecord | null {
  const flowRunId = compactText(payload.flow_run_id);
  if (!flowRunId) {
    return null;
  }
  return {
    approvalId: compactText(payload.approval_id) ?? compactText(payload.id),
    flowId: compactText(payload.flow_id),
    flowRunId,
    flowStep: compactText(payload.flow_step),
    state: compactText(payload.state),
  };
}

export class AgentWorkSessionRuntime {
  private readonly defaultAgent: AgentType;
  private readonly bindingStore: AgentWorkSessionBindingStore;
  private readonly getSession: AgentWorkRuntimeDependencies['getSession'];
  private readonly createSession: AgentWorkRuntimeDependencies['createSession'];
  private readonly updateSessionMetadata: AgentWorkRuntimeDependencies['updateSessionMetadata'];
  private readonly addPrompt: AgentWorkRuntimeDependencies['addPrompt'];
  private readonly maybeAutoDispatchQueuedPrompt: AgentWorkRuntimeDependencies['maybeAutoDispatchQueuedPrompt'];
  private readonly enableNightWatch: AgentWorkRuntimeDependencies['enableNightWatch'];

  constructor(deps: AgentWorkRuntimeDependencies) {
    this.defaultAgent = deps.defaultAgent;
    this.bindingStore = deps.bindingStore ?? agentWorkSessionBindingStore;
    this.getSession = deps.getSession;
    this.createSession = deps.createSession;
    this.updateSessionMetadata = deps.updateSessionMetadata;
    this.addPrompt = deps.addPrompt;
    this.maybeAutoDispatchQueuedPrompt = deps.maybeAutoDispatchQueuedPrompt;
    this.enableNightWatch = deps.enableNightWatch;
  }

  async handleTaskDispatch(input: AgentWorkTaskDispatchInput): Promise<SessionSnapshot | null> {
    if (isTerminalTask(input.task, input.recordState)) {
      return null;
    }
    if (!input.task.assignedTo || input.task.assignedTo !== input.agent.botNpub) {
      return null;
    }
    if (hasBlockingPredecessors(input.task)) {
      return null;
    }

    const taskBinding = this.bindingStore.getByBinding(
      input.subscription.subscriptionId,
      input.agent.agentId,
      'task',
      input.task.taskId,
    );
    const taskSession = this.resolveLiveBindingSession(taskBinding);
    const flowBinding = input.task.flowRunId
      ? this.bindingStore.getByBinding(
          input.subscription.subscriptionId,
          input.agent.agentId,
          'flow_run',
          input.task.flowRunId,
        )
      : null;
    const flowSession = this.resolveLiveBindingSession(flowBinding);

    const session = taskSession ?? flowSession ?? await this.createSession(
      this.defaultAgent,
      input.agent.workingDirectory,
      buildSessionName(input.agent, input.task),
      buildSessionOrigin(input.agent, input.task),
      input.subscription.managedByNpub ?? undefined,
      {
        AGENT: true,
        role: 'agent-work',
        goal: buildAgentWorkGoal(input.task),
        nextAction: 'reflect',
        bindingType: input.task.flowRunId ? 'flow_run' : 'task',
        bindingId: input.task.flowRunId ?? input.task.taskId,
        flowId: input.task.flowId ?? undefined,
        flowRunId: input.task.flowRunId ?? undefined,
        taskIds: [input.task.taskId],
        createdByNpub: input.subscription.managedByNpub ?? undefined,
        lastManagedByNpub: input.subscription.managedByNpub ?? undefined,
        chargeToNpub: input.subscription.managedByNpub ?? undefined,
      },
    );

    const canonicalBindingType: AgentWorkBindingType = input.task.flowRunId ? 'flow_run' : 'task';
    const canonicalBindingId = input.task.flowRunId ?? input.task.taskId;
    const liveSession = this.updateSessionMetadata(
      session.id,
      buildMetadataPatch({
        session,
        task: input.task,
        bindingType: canonicalBindingType,
        bindingId: canonicalBindingId,
        managedByNpub: input.subscription.managedByNpub,
      }),
    ) ?? session;

    this.saveBinding({
      subscriptionId: input.subscription.subscriptionId,
      agentId: input.agent.agentId,
      bindingType: 'task',
      bindingId: input.task.taskId,
      sessionId: liveSession.id,
      lastRecordIdSeen: input.recordId,
    });

    if (input.task.flowRunId) {
      this.saveBinding({
        subscriptionId: input.subscription.subscriptionId,
        agentId: input.agent.agentId,
        bindingType: 'flow_run',
        bindingId: input.task.flowRunId,
        sessionId: liveSession.id,
        lastRecordIdSeen: input.recordId,
      });
    }

    this.enableNightWatch(liveSession.id);
    this.addPrompt(
      liveSession.id,
      buildTaskDispatchPrompt({
        task: input.task,
        dispatchReason: resolveTaskDispatchReason(taskBinding),
      }),
    );
    await this.maybeAutoDispatchQueuedPrompt(this.getSession(liveSession.id) ?? liveSession);
    return this.getSession(liveSession.id) ?? liveSession;
  }

  async handleApprovalDispatch(input: AgentWorkApprovalDispatchInput): Promise<SessionSnapshot | null> {
    const flowRunId = input.approval.flowRunId;
    if (!flowRunId) {
      return null;
    }

    const flowBinding = this.bindingStore.getByBinding(
      input.subscription.subscriptionId,
      input.agent.agentId,
      'flow_run',
      flowRunId,
    );
    const flowSession = this.resolveLiveBindingSession(flowBinding);
    if (!flowBinding || !flowSession) {
      return null;
    }
    if (flowBinding.lastRecordIdSeen && flowBinding.lastRecordIdSeen === input.recordId) {
      return flowSession;
    }

    this.saveBinding({
      subscriptionId: input.subscription.subscriptionId,
      agentId: input.agent.agentId,
      bindingType: 'flow_run',
      bindingId: flowRunId,
      sessionId: flowSession.id,
      lastRecordIdSeen: input.recordId,
    });

    this.enableNightWatch(flowSession.id);
    this.addPrompt(flowSession.id, buildApprovalDispatchPrompt(input.approval));
    await this.maybeAutoDispatchQueuedPrompt(this.getSession(flowSession.id) ?? flowSession);
    return this.getSession(flowSession.id) ?? flowSession;
  }

  private resolveLiveBindingSession(
    binding: AgentWorkSessionBindingRecord | null,
  ): SessionSnapshot | null {
    if (!binding || binding.state !== 'active') {
      return null;
    }
    const session = this.getSession(binding.sessionId);
    if (isLiveSession(session)) {
      return session;
    }
    this.bindingStore.markStaleForSession(binding.sessionId);
    return null;
  }

  private saveBinding(input: {
    subscriptionId: string;
    agentId: string;
    bindingType: AgentWorkBindingType;
    bindingId: string;
    sessionId: string;
    lastRecordIdSeen: string | null;
  }): AgentWorkSessionBindingRecord {
    const existing = this.bindingStore.getByBinding(
      input.subscriptionId,
      input.agentId,
      input.bindingType,
      input.bindingId,
    );
    const now = new Date().toISOString();
    return this.bindingStore.save({
      subscriptionId: input.subscriptionId,
      agentId: input.agentId,
      bindingType: input.bindingType,
      bindingId: input.bindingId,
      sessionId: input.sessionId,
      lastRecordIdSeen: input.lastRecordIdSeen,
      state: 'active',
      lastActivityAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }
}
