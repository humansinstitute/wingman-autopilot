import type { AgentType } from '../config';
import type { SessionOrigin, SessionSnapshot } from '../agents/process-manager';
import type { SessionMetadataInput } from '../sessions/session-metadata';
import type { AgentDefinitionRecord, InboundApprovalRecord, InboundTaskRecord, WorkspaceSubscriptionRecord } from '../agent-chat/types';
import { nip19 } from 'nostr-tools';
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
export type AgentWorkTaskDispatchDecisionCode =
  | 'dispatch'
  | 'skip_terminal'
  | 'skip_assignment'
  | 'skip_predecessors';

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
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
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

function compactRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compactStringArrayFromMixed(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === 'string') {
        return compactText(entry);
      }
      const record = compactRecord(entry);
      if (!record) {
        return null;
      }
      return compactText(record.task_id)
        ?? compactText(record.taskId)
        ?? compactText(record.id);
    })
    .filter((entry): entry is string => Boolean(entry));
}

function compactBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function pickFirstText(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = compactText(payload[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function pickFirstBoolean(payload: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    if (compactBoolean(payload[key])) {
      return true;
    }
  }
  return false;
}

function pickFirstStringArray(payload: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const values = compactStringArrayFromMixed(payload[key]);
    if (values.length > 0) {
      return values;
    }
  }
  return [];
}

function candidatePayloads(payload: Record<string, unknown>): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];
  const directData = compactRecord(payload.data);
  if (directData) {
    candidates.push({ ...payload, ...directData });
    candidates.push(directData);
  }
  candidates.push(payload);
  for (const key of ['task', 'approval', 'payload', 'record', 'content']) {
    const nested = compactRecord(payload[key]);
    if (nested) {
      const nestedData = compactRecord(nested.data);
      if (nestedData) {
        candidates.push({ ...nested, ...nestedData });
        candidates.push(nestedData);
      }
      candidates.push(nested);
    }
  }
  return candidates;
}

function normaliseIdentityValue(value: string | null): string | null {
  const compact = compactText(value);
  return compact ? compact.toLowerCase() : null;
}

function decodeNpubToHex(npub: string | null): string | null {
  const compact = compactText(npub);
  if (!compact || !compact.startsWith('npub1')) {
    return null;
  }
  try {
    const decoded = nip19.decode(compact);
    return decoded.type === 'npub' && typeof decoded.data === 'string'
      ? decoded.data.toLowerCase()
      : null;
  } catch {
    return null;
  }
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

function isAssignedToAgent(task: InboundTaskRecord, agent: AgentDefinitionRecord): boolean {
  const assignedTo = normaliseIdentityValue(task.assignedTo);
  if (!assignedTo) {
    return false;
  }
  const botNpub = normaliseIdentityValue(agent.botNpub);
  const botPubkeyHex = decodeNpubToHex(agent.botNpub);
  return assignedTo === botNpub || assignedTo === botPubkeyHex;
}

function isTerminalTask(task: InboundTaskRecord, recordState: string | null): boolean {
  if (recordState === 'deleted' || task.deleted || task.done) {
    return true;
  }
  return Boolean(task.state && TERMINAL_TASK_STATES.has(task.state));
}

export function evaluateTaskDispatchEligibility(params: {
  task: InboundTaskRecord;
  recordState: string | null;
  agent: AgentDefinitionRecord;
}): AgentWorkTaskDispatchDecisionCode {
  if (isTerminalTask(params.task, params.recordState)) {
    return 'skip_terminal';
  }
  if (!isAssignedToAgent(params.task, params.agent)) {
    return 'skip_assignment';
  }
  if (hasBlockingPredecessors(params.task)) {
    return 'skip_predecessors';
  }
  return 'dispatch';
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
  for (const candidate of candidatePayloads(payload)) {
    const taskId = pickFirstText(candidate, ['task_id', 'taskId', 'record_id', 'id']);
    if (!taskId) {
      continue;
    }
    return {
      taskId,
      flowId: pickFirstText(candidate, ['flow_id', 'flowId']),
      flowRunId: pickFirstText(candidate, ['flow_run_id', 'flowRunId']),
      flowStep: pickFirstText(candidate, ['flow_step', 'flowStep']),
      scopeId: pickFirstText(candidate, ['scope_id', 'scopeId']),
      scopeL1Id: pickFirstText(candidate, ['scope_l1_id', 'scopeL1Id']),
      scopeL2Id: pickFirstText(candidate, ['scope_l2_id', 'scopeL2Id']),
      scopeL3Id: pickFirstText(candidate, ['scope_l3_id', 'scopeL3Id']),
      scopeL4Id: pickFirstText(candidate, ['scope_l4_id', 'scopeL4Id']),
      scopeL5Id: pickFirstText(candidate, ['scope_l5_id', 'scopeL5Id']),
      title: pickFirstText(candidate, ['title', 'name']) ?? taskId,
      description: pickFirstText(candidate, ['description', 'details', 'body']),
      state: pickFirstText(candidate, ['state', 'status'])?.toLowerCase() ?? null,
      // Mirror the Yoke inboundTask translator field names first.
      assignedTo: pickFirstText(candidate, ['assigned_to_npub', 'assigned_to', 'assignedTo', 'assignee', 'assignee_npub']),
      deleted: pickFirstBoolean(candidate, ['deleted', 'is_deleted', 'isDeleted']),
      done: pickFirstBoolean(candidate, ['done', 'is_done', 'isDone', 'completed', 'complete']),
      predecessorTaskIds: pickFirstStringArray(candidate, [
        'predecessor_task_ids',
        'predecessorTaskIds',
        'depends_on_task_ids',
        'dependsOnTaskIds',
        'predecessors',
      ]),
    };
  }
  return null;
}

export function normaliseInboundApprovalRecord(payload: Record<string, unknown>): InboundApprovalRecord | null {
  for (const candidate of candidatePayloads(payload)) {
    const flowRunId = pickFirstText(candidate, ['flow_run_id', 'flowRunId']);
    if (!flowRunId) {
      continue;
    }
    return {
      approvalId: pickFirstText(candidate, ['approval_id', 'approvalId', 'record_id', 'id']),
      flowId: pickFirstText(candidate, ['flow_id', 'flowId']),
      flowRunId,
      flowStep: pickFirstText(candidate, ['flow_step', 'flowStep']),
      // Yoke inboundApproval exposes status rather than state.
      state: pickFirstText(candidate, ['status', 'state']),
    };
  }
  return null;
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
    if (evaluateTaskDispatchEligibility(input) !== 'dispatch') {
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
        agent: input.agent,
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
