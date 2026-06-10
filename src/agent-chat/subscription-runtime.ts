import { join } from 'node:path';

import { nip19 } from 'nostr-tools';
import { generateBotKey, unlockViaEscrow } from '../identity/bot-key-manager';
import {
  AgentWorkSessionRuntime,
  evaluateTaskDispatchEligibility,
  normaliseInboundApprovalRecord,
  normaliseInboundTaskRecord,
} from '../agent-work/session-runtime';
import { agentDefinitionStore, type AgentDefinitionStore } from './agent-definition-store';
import { AgentCommentSessionRuntime } from './comment-session-runtime';
import {
  isDocumentCommentTarget,
  isTaskCommentTarget,
  commentMentionsAgent,
  extractCommentGroupNpubs,
  normaliseInboundCommentRecord,
  selectDocumentCommentAgents,
} from './comment-records';
import {
  AgentCommentDispatchRuntime,
  agentCommentDispatchRuntime,
} from './comment-dispatch-runtime';
import {
  buildAgentConnectImportResult,
  validateAgentConnectPackage,
} from './agent-connect-import';
import { backendConnectionStore, type BackendConnectionStore } from './backend-connection-store';
import { AgentChatRoutingEvaluator } from './routing-evaluator';
import {
  type AgentProfileWorkspaceBundle,
  type AgentWorkspaceAppendedContextRecord,
  type AgentWorkspaceContextKind,
  type AgentWorkspaceEventPolicyRecord,
  type AgentWorkspaceEventType,
  type AgentWorkspacePipelineOverrideRecord,
  type AgentWorkspacePipelineOverrideTarget,
  type ResolvedAgentWorkspaceRuntimeSettings,
  type ResolvedAppendedContext,
  agentProfilePolicyStore,
  type AgentProfilePolicyStore,
} from './agent-profile-policy-store';
import { bootstrapAgentWorkspace } from './agent-workspace-bootstrap';
import type { DispatchPipelineRuntime, DispatchPipelineRuntimeResult } from './dispatch-pipelines/runtime';
import type { AgentChatSessionRuntime } from './session-runtime';
import { workspaceSubscriptionStore, type WorkspaceSubscriptionStore } from './workspace-subscription-store';
import type { DecodedAccessGrant, TowerRevocationVerificationResult } from '../access-grants/sbip0009';
import { parseSseEvents } from './sse-events';
import { chatInterceptStateStore } from './chat-intercept-state-store';
import type { WingmanInstanceIdentity } from '../identity/wingman-instance-identity';
import {
  buildChatMessageFamilyHash,
  buildRecordFamilyHash,
  encodeFlightDeckPgEventCursor,
  buildFailureDiagnostic,
  buildStreamUrl,
  buildSuccessDiagnostic,
  checkBackendConnectionHealth,
  fetchFlightDeckPgChannelMessages,
  fetchFlightDeckPgEvents,
  fetchFlightDeckPgWorkspaceMe,
  fetchWorkspaceKeyMappings,
  fetchRecordHistory,
  normaliseBackendBaseUrl,
  parseTowerError,
  registerWorkspaceKeyWithTower,
  type FlightDeckPgEvent,
  type FlightDeckPgMessage,
} from './tower-client';
import { loadYokeBotHelpers } from './yoke-bot-helpers';
import { decryptRecordPayloadWithYoke } from './yoke-record-payload';
import {
  DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE,
  normalisePromptTemplate,
} from './prompt-templates';
import type {
  AgentChatDispatchHistoryEntry,
  AgentChatSseEventDiagnostic,
  AgentCapability,
  AgentDefinitionRecord,
  BackendConnectionRecord,
  BotKeyStoreRecord,
  ChatInterceptStateRecord,
  CreateDispatchRouteInput,
  InboundApprovalRecord,
  CreateAgentDefinitionInput,
  CreateWorkspaceSubscriptionInput,
  DispatchRouteRecord,
  InboundCommentRecord,
  InboundTaskRecord,
  RuntimeBotIdentity,
  WorkspaceSubscriptionRecord,
  YokeWorkspaceSession,
} from './types';

interface RuntimeContext {
  abortController: AbortController | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  botIdentity: RuntimeBotIdentity;
  wsSession: YokeWorkspaceSession | null;
  groupKeys: unknown | null;
  wrappedKeyRows: unknown[];
  flightDeckPgActorId: string | null;
  removed: boolean;
}

type RuntimeFailureState = 'blocked_auth' | 'blocked_decrypt' | null;
const MAX_RECENT_SSE_EVENTS = 100;
const MAX_RECENT_DISPATCHES = 10;
const CHAT_ADVISORY_RECORD_PULL_TIMEOUT_MS = 30_000;
const CHAT_ADVISORY_RECORD_PULL_MAX_ATTEMPTS = 3;
const CHAT_ADVISORY_RECORD_PULL_RETRY_DELAY_MS = 1_000;
const CHAT_ADVISORY_DECRYPT_TIMEOUT_MS = 15_000;
const CHAT_ADVISORY_ROUTING_TIMEOUT_MS = 20_000;
const CHAT_ADVISORY_PIPELINE_TIMEOUT_MS = 60_000;
const WORKSPACE_KEY_MAPPING_CACHE_MS = 30_000;
const FLIGHT_DECK_PG_EVENT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_AUTO_AGENT_WORKSPACE_ROOT = new URL('../../data/agent-chat-workspaces', import.meta.url).pathname;
const DEFAULT_33357_AGENT_CAPABILITIES: AgentCapability[] = [
  'chat_intercept',
  'task_dispatch',
  'comment_dispatch',
];

const DEFAULT_DISPATCH_PIPELINE_ROUTES: Array<{
  triggerKind: CreateDispatchRouteInput['triggerKind'];
  capability: CreateDispatchRouteInput['capability'];
  pipelineDefinitionId: string;
  flightDeckPgPipelineDefinitionId?: string;
}> = [
  {
    triggerKind: 'chat',
    capability: 'chat_intercept',
    pipelineDefinitionId: 'agent-dispatch-chat',
    flightDeckPgPipelineDefinitionId: 'fd-agent-dispatch-chat',
  },
  {
    triggerKind: 'task',
    capability: 'task_dispatch',
    pipelineDefinitionId: 'agent-dispatch-task-response',
    flightDeckPgPipelineDefinitionId: 'fd-agent-dispatch-task-response',
  },
  {
    triggerKind: 'comment',
    capability: 'comment_dispatch',
    pipelineDefinitionId: 'agent-dispatch-comment-response',
    flightDeckPgPipelineDefinitionId: 'fd-agent-dispatch-comment-response',
  },
];

function getDefaultDispatchPipelineDefinitionId(
  subscription: WorkspaceSubscriptionRecord,
  routeConfig: (typeof DEFAULT_DISPATCH_PIPELINE_ROUTES)[number],
): string {
  return isFlightDeckPgSubscription(subscription) && routeConfig.flightDeckPgPipelineDefinitionId
    ? routeConfig.flightDeckPgPipelineDefinitionId
    : routeConfig.pipelineDefinitionId;
}

export class WorkspaceSubscriptionAccessError extends Error {
  readonly statusCode = 403;
  readonly code = 'backend_connection_forbidden';
}

export class BackendConnectionNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'backend_connection_not_found';
}

function trimRecentEntries<T>(entries: T[], max: number): T[] {
  return entries.slice(-max);
}

function getOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getOptionalTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

function defaultActionForEventType(eventType: AgentWorkspaceEventType) {
  if (eventType === 'task_assigned') return 'work';
  if (eventType === 'task_comment' || eventType === 'document_comment_tagged') return 'respond';
  if (eventType === 'approval_assigned') return 'notify';
  if (eventType === 'flow_step_assigned') return 'run_flow_handler';
  if (eventType === 'document_created') return 'index';
  if (eventType === 'chat_observe' || eventType === 'document_comment_observe') return 'observe';
  return eventType === 'direct_message' || eventType === 'chat_mention' ? 'respond' : 'ignore';
}

function profilePolicyAllowsDispatch(decision: AgentProfileRuntimeDecision | null): boolean {
  if (!decision) {
    return true;
  }
  const policy = decision.settings.policy;
  if (policy?.enabled === false || policy?.quietMode === true) {
    return false;
  }
  const action = policy?.defaultAction ?? defaultActionForEventType(decision.eventType);
  return action !== 'ignore' && action !== 'observe' && action !== 'index';
}

function isRevokedWorkspaceSubscription(record: WorkspaceSubscriptionRecord): boolean {
  return record.wsKeyStatus === 'revoked'
    || record.groupKeyStatus === 'revoked'
    || record.lastErrorCode === 'workspace_access_revoked';
}

function isFlightDeckPgSubscription(record: WorkspaceSubscriptionRecord): boolean {
  return record.onboardingSource === 'nostr_33357' && Boolean(record.workspaceId);
}

function findFlightDeckPgDispatchMessage(
  messages: FlightDeckPgMessage[],
  event: FlightDeckPgEvent,
): FlightDeckPgMessage | null {
  const entityId = getOptionalText(event.entity_id);
  if (!entityId) {
    return null;
  }
  if (event.entity_type === 'message') {
    return messages.find((message) => message.id === entityId) ?? null;
  }
  if (event.entity_type === 'thread') {
    const threadMessages = messages.filter((message) => message.thread_id === entityId || message.thread_source_message_id === entityId);
    return threadMessages.at(-1) ?? null;
  }
  return null;
}

function normaliseFlightDeckPgChatPayload(
  message: FlightDeckPgMessage,
  event: FlightDeckPgEvent,
): Record<string, unknown> {
  const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
    ? message.metadata
    : {};
  const eventPayload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {};
  const senderNpub = getOptionalText(metadata.sender_npub)
    ?? getOptionalText(eventPayload.sender_npub)
    ?? getOptionalText(eventPayload.actor_npub);
  return {
    id: message.id,
    record_id: message.id,
    body: message.body ?? '',
    sender_npub: senderNpub,
    sender_actor_id: message.created_by_actor_id ?? event.actor_id ?? null,
    actor_id: event.actor_id ?? message.created_by_actor_id ?? null,
    channel_id: message.channel_id ?? event.channel_id ?? null,
    scope_id: message.scope_id ?? event.scope_id ?? null,
    thread_id: message.thread_id ?? message.thread_source_message_id ?? message.id,
    parent_message_id: message.thread_id ?? null,
    row_version: message.row_version ?? event.entity_row_version ?? event.row_version ?? null,
    version: message.row_version ?? event.entity_row_version ?? event.row_version ?? null,
    created_at: message.created_at ?? event.created_at ?? event.timestamp ?? null,
    updated_at: message.updated_at ?? event.created_at ?? event.timestamp ?? null,
    metadata,
    flightdeck_pg_event: {
      id: event.event_id ?? event.id ?? null,
      event_type: event.event_type ?? null,
      entity_type: event.entity_type ?? null,
      operation: event.operation ?? null,
      cursor: event.cursor ?? null,
    },
  };
}

function profilePolicyAllowsLegacyPrompt(decision: AgentProfileRuntimeDecision | null): boolean {
  if (!profilePolicyAllowsDispatch(decision)) {
    return false;
  }
  const action = decision?.settings.policy?.defaultAction ?? (decision ? defaultActionForEventType(decision.eventType) : 'respond');
  return action === 'respond' || action === 'work' || action === 'process' || action === 'run_flow_handler';
}

function formatResolvedProfileRuntimeContext(contexts: ResolvedAppendedContext[]): string | null {
  const rows = contexts
    .map((context) => {
      const text = getOptionalText(context.contextText);
      if (!text) {
        return null;
      }
      const target = context.targetId ? ` ${context.targetId}` : '';
      const event = context.eventType ? ` ${context.eventType}` : '';
      return `[${context.kind}${target}${event}]\n${text}`;
    })
    .filter((row): row is string => Boolean(row));
  return rows.length > 0 ? rows.join('\n\n') : null;
}

function getTaskScopeId(task: InboundTaskRecord): string | null {
  return task.scopeId ?? task.scopeL5Id ?? task.scopeL4Id ?? task.scopeL3Id ?? task.scopeL2Id ?? task.scopeL1Id;
}

function eventTypeForTaskDispatchMode(mode: TaskDispatchMode): AgentWorkspaceEventType {
  if (mode === 'flow_dispatch') {
    return 'flow_step_assigned';
  }
  return 'task_assigned';
}

function getRecordUpdaterNpub(record: Record<string, unknown>): string | null {
  return getOptionalText(record.signature_npub)
    ?? getOptionalText(record.owner_npub);
}

function isSelfUpdater(subscription: WorkspaceSubscriptionRecord, agent: AgentDefinitionRecord, updaterNpub: string | null): boolean {
  if (!updaterNpub) {
    return false;
  }
  return updaterNpub === agent.botNpub || updaterNpub === subscription.wsKeyNpub;
}

function isSelfCommentEvent(
  subscription: WorkspaceSubscriptionRecord,
  comment: InboundCommentRecord,
  updaterNpub: string | null,
): boolean {
  const selfNpubs = new Set([subscription.botNpub, subscription.wsKeyNpub].filter((value): value is string => Boolean(value)));
  return Boolean(
    (updaterNpub && selfNpubs.has(updaterNpub))
    || (comment.senderNpub && selfNpubs.has(comment.senderNpub)),
  );
}

function isSelfCommentAuthor(
  subscription: WorkspaceSubscriptionRecord,
  agent: AgentDefinitionRecord,
  comment: InboundCommentRecord,
  updaterNpub: string | null,
): boolean {
  if (isSelfUpdater(subscription, agent, updaterNpub) || isSelfCommentEvent(subscription, comment, updaterNpub)) {
    return true;
  }
  return Boolean(comment.senderNpub && comment.senderNpub === agent.botNpub);
}

function isManagerAuthoredComment(
  subscription: WorkspaceSubscriptionRecord,
  comment: InboundCommentRecord,
  updaterNpub: string | null,
): boolean {
  const managerNpub = subscription.managedByNpub;
  if (!managerNpub) {
    return false;
  }
  return updaterNpub === managerNpub || comment.senderNpub === managerNpub;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function getRecordUpdatedAtMs(record: Record<string, unknown> | null | undefined): number | null {
  return parseTimestampMs(record?.updated_at)
    ?? parseTimestampMs(record?.updatedAt);
}

function shouldSkipExistingCommentAdvisory(
  subscription: WorkspaceSubscriptionRecord,
  record: Record<string, unknown> | null | undefined,
): boolean {
  const startupReloadAt = parseTimestampMs(subscription.lastSuccessfulStartupReloadAt);
  const recordUpdatedAt = getRecordUpdatedAtMs(record);
  return startupReloadAt != null && recordUpdatedAt != null && recordUpdatedAt <= startupReloadAt;
}

interface TaskDispatchSnapshot {
  title: string;
  description: string | null;
  assignedTo: string | null;
  flowId: string | null;
  flowRunId: string | null;
  flowStep: string | null;
  scopeId: string | null;
  scopeL1Id: string | null;
  scopeL2Id: string | null;
  scopeL3Id: string | null;
  scopeL4Id: string | null;
  scopeL5Id: string | null;
  predecessorTaskIds: string[];
}

function buildTaskDispatchSnapshot(task: InboundTaskRecord): TaskDispatchSnapshot {
  return {
    title: task.title.trim(),
    description: task.description?.trim() || null,
    assignedTo: task.assignedTo,
    flowId: task.flowId,
    flowRunId: task.flowRunId,
    flowStep: task.flowStep,
    scopeId: task.scopeId,
    scopeL1Id: task.scopeL1Id,
    scopeL2Id: task.scopeL2Id,
    scopeL3Id: task.scopeL3Id,
    scopeL4Id: task.scopeL4Id,
    scopeL5Id: task.scopeL5Id,
    predecessorTaskIds: [...task.predecessorTaskIds].sort(),
  };
}

function diffTaskDispatchSnapshots(
  current: TaskDispatchSnapshot,
  previous: TaskDispatchSnapshot | null,
): string[] {
  if (!previous) {
    return ['new_task'];
  }
  const changed: string[] = [];
  const entries: Array<[keyof TaskDispatchSnapshot, unknown, unknown]> = [
    ['title', current.title, previous.title],
    ['description', current.description, previous.description],
    ['assignedTo', current.assignedTo, previous.assignedTo],
    ['flowId', current.flowId, previous.flowId],
    ['flowRunId', current.flowRunId, previous.flowRunId],
    ['flowStep', current.flowStep, previous.flowStep],
    ['scopeId', current.scopeId, previous.scopeId],
    ['scopeL1Id', current.scopeL1Id, previous.scopeL1Id],
    ['scopeL2Id', current.scopeL2Id, previous.scopeL2Id],
    ['scopeL3Id', current.scopeL3Id, previous.scopeL3Id],
    ['scopeL4Id', current.scopeL4Id, previous.scopeL4Id],
    ['scopeL5Id', current.scopeL5Id, previous.scopeL5Id],
    ['predecessorTaskIds', current.predecessorTaskIds.join('|'), previous.predecessorTaskIds.join('|')],
  ];
  for (const [key, left, right] of entries) {
    if (left !== right) {
      changed.push(String(key));
    }
  }
  return changed;
}

type TaskDispatchMode = 'task_dispatch' | 'flow_dispatch' | 'task_review';
type TaskDispatchEligibility =
  | 'dispatch'
  | 'skip_terminal'
  | 'skip_assignment'
  | 'skip_not_ready'
  | 'skip_not_kickoff'
  | 'skip_not_review';

interface AgentProfileRuntimeDecision {
  profileWorkspaceId: string;
  eventType: AgentWorkspaceEventType;
  settings: ResolvedAgentWorkspaceRuntimeSettings;
  contextText: string | null;
}

const TERMINAL_TASK_STATES = new Set([
  'done',
  'complete',
  'completed',
  'cancelled',
  'canceled',
  'archived',
  'deleted',
]);

function normaliseTaskIdentity(value: string | null): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
}

function decodeNpubToHex(npub: string | null): string | null {
  if (!npub) {
    return null;
  }
  try {
    const decoded = nip19.decode(npub);
    return decoded.type === 'npub' && typeof decoded.data === 'string' ? decoded.data.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isAssignedToAgent(task: InboundTaskRecord, agent: AgentDefinitionRecord): boolean {
  const assignedTo = normaliseTaskIdentity(task.assignedTo);
  if (!assignedTo) {
    return false;
  }
  return assignedTo === normaliseTaskIdentity(agent.botNpub) || assignedTo === decodeNpubToHex(agent.botNpub);
}

function isTerminalTask(task: InboundTaskRecord, recordState: string | null): boolean {
  if (recordState === 'deleted' || task.deleted || task.done) {
    return true;
  }
  return Boolean(task.state && TERMINAL_TASK_STATES.has(task.state));
}

function resolveTaskDispatchMode(task: InboundTaskRecord): TaskDispatchMode {
  if (task.state === 'new' && task.flowId && !task.flowRunId) {
    return 'flow_dispatch';
  }
  if (task.state === 'review') {
    return 'task_review';
  }
  return 'task_dispatch';
}

function dispatchModeToTriggerKind(mode: TaskDispatchMode): CreateDispatchRouteInput['triggerKind'] {
  if (mode === 'flow_dispatch') {
    return 'flow';
  }
  if (mode === 'task_review') {
    return 'task_review';
  }
  return 'task';
}

function dispatchModeToHistoryKind(mode: TaskDispatchMode): AgentChatDispatchHistoryEntry['kind'] {
  if (mode === 'flow_dispatch') {
    return 'flow';
  }
  if (mode === 'task_review') {
    return 'review';
  }
  return 'task';
}

function dispatchModeToBindingId(mode: TaskDispatchMode, task: InboundTaskRecord): string {
  if (mode === 'flow_dispatch') {
    return task.taskId;
  }
  return task.flowRunId ?? task.taskId;
}

function dispatchModeToBindingType(mode: TaskDispatchMode, task: InboundTaskRecord): AgentChatDispatchHistoryEntry['bindingType'] {
  return mode === 'task_dispatch' && task.flowRunId ? 'flow_run' : 'task';
}

function dispatchModeToAction(mode: TaskDispatchMode): AgentChatDispatchHistoryEntry['action'] {
  if (mode === 'flow_dispatch') {
    return 'flow_dispatch';
  }
  if (mode === 'task_review') {
    return 'task_review';
  }
  return 'task_dispatch';
}

function dispatchModeToSelfSkipAction(mode: TaskDispatchMode): AgentChatDispatchHistoryEntry['action'] {
  if (mode === 'flow_dispatch') {
    return 'flow_dispatch_skip_self_update';
  }
  if (mode === 'task_review') {
    return 'task_review_skip_self_update';
  }
  return 'task_skip_self_update';
}

function dispatchModeToNullSkipAction(mode: TaskDispatchMode): AgentChatDispatchHistoryEntry['action'] {
  if (mode === 'flow_dispatch') {
    return 'flow_dispatch_skip_runtime_returned_null';
  }
  if (mode === 'task_review') {
    return 'task_review_skip_runtime_returned_null';
  }
  return 'task_skip_runtime_returned_null';
}

function evaluateTaskPipelineEligibility(input: {
  task: InboundTaskRecord;
  recordState: string | null;
  mode: TaskDispatchMode;
  agent: AgentDefinitionRecord;
}): TaskDispatchEligibility {
  if (isTerminalTask(input.task, input.recordState)) {
    return 'skip_terminal';
  }
  if (!isAssignedToAgent(input.task, input.agent)) {
    return 'skip_assignment';
  }
  if (input.mode === 'flow_dispatch') {
    return input.task.state === 'new' && Boolean(input.task.flowId) && !input.task.flowRunId
      ? 'dispatch'
      : 'skip_not_kickoff';
  }
  if (input.mode === 'task_review') {
    return input.task.state === 'review' ? 'dispatch' : 'skip_not_review';
  }
  return evaluateTaskDispatchEligibility(input);
}

export interface WorkspaceSubscriptionManagerDependencies {
  store?: WorkspaceSubscriptionStore;
  agentStore?: AgentDefinitionStore;
  backendStore?: BackendConnectionStore;
  profilePolicyStore?: AgentProfilePolicyStore;
  routingEvaluator?: AgentChatRoutingEvaluator;
  chatRuntime?: AgentChatSessionRuntime | null;
  agentWorkRuntime?: AgentWorkSessionRuntime | null;
  agentCommentRuntime?: AgentCommentSessionRuntime | null;
  commentDispatchRuntime?: AgentCommentDispatchRuntime | null;
  dispatchPipelineRuntime?: DispatchPipelineRuntime | null;
  fetchRecordHistory?: typeof fetchRecordHistory;
  fetchWorkspaceKeyMappings?: typeof fetchWorkspaceKeyMappings;
  fetchFlightDeckPgWorkspaceMe?: typeof fetchFlightDeckPgWorkspaceMe;
  fetchFlightDeckPgEvents?: typeof fetchFlightDeckPgEvents;
  fetchFlightDeckPgChannelMessages?: typeof fetchFlightDeckPgChannelMessages;
  decryptRecordPayload?: typeof decryptRecordPayloadWithYoke;
  checkBackendHealth?: typeof checkBackendConnectionHealth;
  chatRecordPullTimeoutMs?: number;
  chatRecordPullMaxAttempts?: number;
  chatRecordPullRetryDelayMs?: number;
  autoAgentWorkspaceRoot?: string;
  botKeyStore: {
    getActiveKeyForUser: (npub: string) => BotKeyStoreRecord | null;
    getActiveKeyForBotNpub: (botNpub: string) => BotKeyStoreRecord | null;
    createKey?: (input: {
      userNpub: string;
      botPubkeyHex: string;
      botNpub: string;
      displayName: string;
      encryptedToUser: string;
      encryptedEscrow: string;
      escrowUuid: string;
    }) => BotKeyStoreRecord;
  };
  getInstanceIdentity?: () => WingmanInstanceIdentity | null;
}

function getErrorDetailCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const detailCode = (error as { detailCode?: unknown }).detailCode;
  return typeof detailCode === 'string' && detailCode.trim().length > 0 ? detailCode.trim() : null;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  detailCode: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(Object.assign(new Error(`${detailCode} after ${timeoutMs}ms`), { detailCode }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function mapFailureState(detailCode: string | null): RuntimeFailureState {
  switch (detailCode) {
    case 'workspace_key_register_failed':
    case 'workspace_auth_failed':
    case 'workspace_key_missing':
    case 'workspace_access_denied':
    case 'workspace_key_revoked':
    case 'workspace_key_invalid':
    case 'sse_stream_forbidden':
      return 'blocked_auth';
    case 'record_pull_forbidden':
    case 'group_membership_revoked':
    case 'group_key_epoch_stale':
    case 'group_key_missing':
    case 'record_decrypt_failed':
      return 'blocked_decrypt';
    default:
      return null;
  }
}

function canUseBackendConnection(
  record: BackendConnectionRecord,
  managedByNpub: string,
  backendStore: BackendConnectionStore,
  grantKind: CreateWorkspaceSubscriptionInput['backendConnectionGrantKind'] = null,
): boolean {
  if (record.managedByNpub === managedByNpub) {
    return true;
  }

  if (record.sharePolicy === 'selected_users') {
    return backendStore.hasManagerGrant(record.backendConnectionId, managedByNpub);
  }

  if (record.sharePolicy === 'shared_service') {
    return grantKind === 'shared_service'
      && backendStore.hasSharedServiceGrant(record.backendConnectionId);
  }

  return false;
}

export class WorkspaceSubscriptionManager {
  private readonly store: WorkspaceSubscriptionStore;
  private readonly agentStore: AgentDefinitionStore;
  private readonly backendStore: BackendConnectionStore;
  private readonly profilePolicyStore: AgentProfilePolicyStore;
  private readonly routingEvaluator: AgentChatRoutingEvaluator;
  private readonly botKeyStore: WorkspaceSubscriptionManagerDependencies['botKeyStore'];
  private readonly getInstanceIdentity: () => WingmanInstanceIdentity | null;
  private chatRuntime: AgentChatSessionRuntime | null;
  private agentWorkRuntime: AgentWorkSessionRuntime | null;
  private agentCommentRuntime: AgentCommentSessionRuntime | null;
  private commentDispatchRuntime: AgentCommentDispatchRuntime | null;
  private dispatchPipelineRuntime: DispatchPipelineRuntime | null;
  private readonly fetchRecordHistoryImpl: typeof fetchRecordHistory;
  private readonly fetchWorkspaceKeyMappingsImpl: typeof fetchWorkspaceKeyMappings;
  private readonly fetchFlightDeckPgWorkspaceMeImpl: typeof fetchFlightDeckPgWorkspaceMe;
  private readonly fetchFlightDeckPgEventsImpl: typeof fetchFlightDeckPgEvents;
  private readonly fetchFlightDeckPgChannelMessagesImpl: typeof fetchFlightDeckPgChannelMessages;
  private readonly decryptRecordPayloadImpl: typeof decryptRecordPayloadWithYoke;
  private readonly checkBackendHealthImpl: typeof checkBackendConnectionHealth;
  private readonly chatRecordPullTimeoutMs: number;
  private readonly chatRecordPullMaxAttempts: number;
  private readonly chatRecordPullRetryDelayMs: number;
  private readonly autoAgentWorkspaceRoot: string;
  private readonly runtimes = new Map<string, RuntimeContext>();
  private readonly workspaceKeyOwnerCache = new Map<string, { fetchedAt: number; owners: Map<string, string> }>();

  constructor(deps: WorkspaceSubscriptionManagerDependencies) {
    this.store = deps.store ?? workspaceSubscriptionStore;
    this.agentStore = deps.agentStore ?? agentDefinitionStore;
    this.backendStore = deps.backendStore ?? backendConnectionStore;
    this.profilePolicyStore = deps.profilePolicyStore ?? agentProfilePolicyStore;
    this.routingEvaluator = deps.routingEvaluator ?? new AgentChatRoutingEvaluator({ agentStore: this.agentStore });
    this.botKeyStore = deps.botKeyStore;
    this.getInstanceIdentity = deps.getInstanceIdentity ?? (() => null);
    this.chatRuntime = deps.chatRuntime ?? null;
    this.agentWorkRuntime = deps.agentWorkRuntime ?? null;
    this.agentCommentRuntime = deps.agentCommentRuntime ?? null;
    this.commentDispatchRuntime = deps.commentDispatchRuntime ?? agentCommentDispatchRuntime;
    this.dispatchPipelineRuntime = deps.dispatchPipelineRuntime ?? null;
    this.fetchRecordHistoryImpl = deps.fetchRecordHistory ?? fetchRecordHistory;
    this.fetchWorkspaceKeyMappingsImpl = deps.fetchWorkspaceKeyMappings ?? fetchWorkspaceKeyMappings;
    this.fetchFlightDeckPgWorkspaceMeImpl = deps.fetchFlightDeckPgWorkspaceMe ?? fetchFlightDeckPgWorkspaceMe;
    this.fetchFlightDeckPgEventsImpl = deps.fetchFlightDeckPgEvents ?? fetchFlightDeckPgEvents;
    this.fetchFlightDeckPgChannelMessagesImpl = deps.fetchFlightDeckPgChannelMessages ?? fetchFlightDeckPgChannelMessages;
    this.decryptRecordPayloadImpl = deps.decryptRecordPayload ?? decryptRecordPayloadWithYoke;
    this.checkBackendHealthImpl = deps.checkBackendHealth ?? checkBackendConnectionHealth;
    this.chatRecordPullTimeoutMs = Math.max(1, deps.chatRecordPullTimeoutMs ?? CHAT_ADVISORY_RECORD_PULL_TIMEOUT_MS);
    this.chatRecordPullMaxAttempts = Math.max(1, deps.chatRecordPullMaxAttempts ?? CHAT_ADVISORY_RECORD_PULL_MAX_ATTEMPTS);
    this.chatRecordPullRetryDelayMs = Math.max(0, deps.chatRecordPullRetryDelayMs ?? CHAT_ADVISORY_RECORD_PULL_RETRY_DELAY_MS);
    this.autoAgentWorkspaceRoot = (deps.autoAgentWorkspaceRoot ?? Bun.env.AGENT_CHAT_WORKSPACE_ROOT ?? DEFAULT_AUTO_AGENT_WORKSPACE_ROOT).trim()
      || DEFAULT_AUTO_AGENT_WORKSPACE_ROOT;
  }

  setChatRuntime(chatRuntime: AgentChatSessionRuntime | null): void {
    this.chatRuntime = chatRuntime;
  }

  setAgentWorkRuntime(agentWorkRuntime: AgentWorkSessionRuntime | null): void {
    this.agentWorkRuntime = agentWorkRuntime;
  }

  setAgentCommentRuntime(agentCommentRuntime: AgentCommentSessionRuntime | null): void {
    this.agentCommentRuntime = agentCommentRuntime;
  }

  setDispatchPipelineRuntime(dispatchPipelineRuntime: DispatchPipelineRuntime | null): void {
    this.dispatchPipelineRuntime = dispatchPipelineRuntime;
  }

  getRuntimeBotIdentity(subscriptionId: string): RuntimeBotIdentity | null {
    try {
      return this.getRuntime(subscriptionId).botIdentity;
    } catch {
      return null;
    }
  }

  listForManager(npub: string): WorkspaceSubscriptionRecord[] {
    return this.store.listForManagerNpub(npub);
  }

  getForManager(subscriptionId: string, npub: string): WorkspaceSubscriptionRecord | null {
    const record = this.store.getBySubscriptionId(subscriptionId);
    return record?.managedByNpub === npub ? record : null;
  }

  listAgentsForManager(npub: string): AgentDefinitionRecord[] {
    return this.agentStore.listForManagerNpub(npub);
  }

  listBackendConnectionsForManager(npub: string) {
    this.backfillLegacyBackendConnections();
    return this.backendStore.listAvailableForManagerNpub(npub);
  }

  listBackendConnectionGrantsForManager(backendConnectionId: string, npub: string) {
    const record = this.backendStore.getById(backendConnectionId);
    if (!record || record.managedByNpub !== npub) {
      return [];
    }
    return this.backendStore.listGrants(backendConnectionId);
  }

  updateBackendConnectionAvailabilityForManager(input: {
    backendConnectionId: string;
    managedByNpub: string;
    managerNpubs?: string[];
    sharedService?: boolean;
  }) {
    const record = this.backendStore.getById(input.backendConnectionId);
    if (!record) {
      throw Object.assign(new Error('Backend connection not found'), { statusCode: 404 });
    }
    if (record.managedByNpub !== input.managedByNpub) {
      throw Object.assign(new Error('Only the backend connection owner can manage availability.'), { statusCode: 403 });
    }
    const grants = this.backendStore.replaceAvailabilityGrants({
      backendConnectionId: input.backendConnectionId,
      managerNpubs: input.managerNpubs,
      sharedService: input.sharedService,
    });
    return {
      backendConnection: this.backendStore.getById(input.backendConnectionId) ?? record,
      grants,
    };
  }

  backfillLegacyBackendConnections(): { backfilled: number; linkedSubscriptions: number } {
    let backfilled = 0;
    let linkedSubscriptions = 0;
    for (const subscription of this.store.listLegacyDirectSubscriptions()) {
      const backendConnection = (() => {
        try {
          return this.backendStore.backfillFromLegacySubscription(subscription);
        } catch {
          return null;
        }
      })();
      if (!backendConnection) {
        continue;
      }
      backfilled += 1;
      if (subscription.backendConnectionId !== backendConnection.backendConnectionId) {
        this.store.save({
          ...subscription,
          backendConnectionId: backendConnection.backendConnectionId,
          backendBaseUrl: backendConnection.backendBaseUrl,
          updatedAt: new Date().toISOString(),
        });
        linkedSubscriptions += 1;
      }
    }
    return { backfilled, linkedSubscriptions };
  }

  getAgentForManager(agentId: string, npub: string): AgentDefinitionRecord | null {
    const record = this.agentStore.getByAgentId(agentId);
    return record?.managedByNpub === npub ? record : null;
  }

  listAgentsForWorkspaceBot(workspaceOwnerNpub: string, botNpub: string, npub: string): AgentDefinitionRecord[] {
    return this.agentStore
      .listByWorkspaceAndBot(workspaceOwnerNpub, botNpub)
      .filter((record) => record.managedByNpub === npub);
  }

  getProfileWorkspaceForManager(subscriptionId: string, npub: string): AgentProfileWorkspaceBundle | null {
    const subscription = this.getForManager(subscriptionId, npub);
    if (!subscription || !subscription.managedByNpub) {
      return null;
    }
    const agentProfile = subscription.agentProfileId
      ? this.agentStore.getByAgentId(subscription.agentProfileId)
      : null;
    const backendConnection = subscription.backendConnectionId
      ? this.backendStore.getById(subscription.backendConnectionId)
      : null;
    return this.profilePolicyStore.ensureProfileWorkspaceForSubscription({
      managedByNpub: subscription.managedByNpub,
      agentProfileId: agentProfile?.agentId ?? subscription.agentProfileId ?? subscription.botNpub,
      agentLabel: agentProfile?.label ?? null,
      agentNpub: subscription.botNpub,
      subscription,
      backendConnection,
    });
  }

  saveProfileWorkspaceForManager(input: {
    subscriptionId: string;
    managedByNpub: string;
    profileDefaultPipelineDefinitionId?: string | null;
    profilePromptContext?: string | null;
    workspaceDefaultPipelineDefinitionId?: string | null;
    workspaceContext?: string | null;
    workspaceTitle?: string | null;
    policies?: Array<Partial<AgentWorkspaceEventPolicyRecord> & { eventType: AgentWorkspaceEventType }>;
    pipelineOverrides?: Array<{
      targetKind: AgentWorkspacePipelineOverrideTarget;
      targetId: string;
      pipelineDefinitionId: string;
    }>;
    appendedContexts?: Array<{
      contextKind: AgentWorkspaceContextKind;
      targetId?: string | null;
      eventType?: AgentWorkspaceEventType | null;
      contextText: string;
    }>;
  }): AgentProfileWorkspaceBundle {
    const bundle = this.getProfileWorkspaceForManager(input.subscriptionId, input.managedByNpub);
    if (!bundle) {
      throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });
    }

    const profile = this.profilePolicyStore.updateProfileDefaults({
      profileId: bundle.profile.profileId,
      managedByNpub: input.managedByNpub,
      defaultPipelineDefinitionId: input.profileDefaultPipelineDefinitionId,
      promptContext: input.profilePromptContext,
    });
    const workspace = this.profilePolicyStore.updateWorkspaceDefaults({
      profileWorkspaceId: bundle.workspace.profileWorkspaceId,
      defaultPipelineDefinitionId: input.workspaceDefaultPipelineDefinitionId,
      workspaceContext: input.workspaceContext,
      workspaceTitle: input.workspaceTitle,
    });
    const existingPolicies = new Map(bundle.policies.map((policy) => [policy.eventType, policy]));
    const now = new Date().toISOString();
    const policies = Array.isArray(input.policies)
      ? input.policies.map((policy) => {
          const existing = existingPolicies.get(policy.eventType);
          if (!existing) {
            return null;
          }
          return this.profilePolicyStore.saveEventPolicy({
            ...existing,
            enabled: typeof policy.enabled === 'boolean' ? policy.enabled : existing.enabled,
            defaultAction: policy.defaultAction ?? existing.defaultAction,
            pipelineDefinitionId: policy.pipelineDefinitionId === undefined
              ? existing.pipelineDefinitionId
              : typeof policy.pipelineDefinitionId === 'string' && policy.pipelineDefinitionId.trim()
                ? policy.pipelineDefinitionId.trim()
                : null,
            promptContext: policy.promptContext === undefined
              ? existing.promptContext
              : typeof policy.promptContext === 'string' && policy.promptContext.trim()
                ? policy.promptContext
                : null,
            quietMode: typeof policy.quietMode === 'boolean' ? policy.quietMode : existing.quietMode,
            updatedAt: now,
          });
        }).filter((policy): policy is AgentWorkspaceEventPolicyRecord => Boolean(policy))
      : this.profilePolicyStore.listPolicies(bundle.workspace.profileWorkspaceId);
    const pipelineOverrides: AgentWorkspacePipelineOverrideRecord[] = Array.isArray(input.pipelineOverrides)
      ? this.profilePolicyStore.replacePipelineOverrides(bundle.workspace.profileWorkspaceId, input.pipelineOverrides)
      : this.profilePolicyStore.listPipelineOverrides(bundle.workspace.profileWorkspaceId);
    const appendedContexts: AgentWorkspaceAppendedContextRecord[] = Array.isArray(input.appendedContexts)
      ? this.profilePolicyStore.replaceAppendedContexts(bundle.workspace.profileWorkspaceId, input.appendedContexts)
      : this.profilePolicyStore.listAppendedContexts(bundle.workspace.profileWorkspaceId);

    return {
      profile,
      workspace,
      policies,
      pipelineOverrides,
      appendedContexts,
    };
  }

  private resolveProfileRuntimeDecision(input: {
    subscription: WorkspaceSubscriptionRecord;
    eventType: AgentWorkspaceEventType;
    scopeId?: string | null;
    channelId?: string | null;
    builtInDefaultPipelineId?: string | null;
  }): AgentProfileRuntimeDecision | null {
    const managedByNpub = input.subscription.managedByNpub;
    if (!managedByNpub) {
      return null;
    }
    const bundle = this.getProfileWorkspaceForManager(input.subscription.subscriptionId, managedByNpub);
    if (!bundle) {
      return null;
    }
    const settings = this.profilePolicyStore.resolveRuntimeSettingsForEvent({
      profileId: bundle.profile.profileId,
      managedByNpub,
      profileWorkspaceId: bundle.workspace.profileWorkspaceId,
      eventType: input.eventType,
      scopeId: input.scopeId,
      channelId: input.channelId,
      builtInDefaultPipelineId: input.builtInDefaultPipelineId,
    });
    return {
      profileWorkspaceId: bundle.workspace.profileWorkspaceId,
      eventType: input.eventType,
      settings,
      contextText: formatResolvedProfileRuntimeContext(settings.appendedContext),
    };
  }

  private buildProfileRuntimeContext(decision: AgentProfileRuntimeDecision | null) {
    if (!decision) {
      return null;
    }
    const policy = decision.settings.policy;
    return {
      profileWorkspaceId: decision.profileWorkspaceId,
      eventType: decision.eventType,
      enabled: policy?.enabled ?? true,
      defaultAction: policy?.defaultAction ?? defaultActionForEventType(decision.eventType),
      quietMode: policy?.quietMode ?? false,
      pipeline: decision.settings.pipeline,
      appendedContext: decision.settings.appendedContext,
    };
  }

  private appendProfilePolicySuppression(input: {
    record: WorkspaceSubscriptionRecord;
    decision: AgentProfileRuntimeDecision;
    kind: AgentChatDispatchHistoryEntry['kind'];
    recordId: string | null;
    bindingId: string | null;
    bindingType: AgentChatDispatchHistoryEntry['bindingType'];
    agentId?: string | null;
    details?: Record<string, unknown>;
  }): WorkspaceSubscriptionRecord {
    const policy = input.decision.settings.policy;
    const reason = !policy?.enabled
      ? 'disabled'
      : policy?.quietMode
        ? 'quiet'
        : `action_${policy?.defaultAction ?? defaultActionForEventType(input.decision.eventType)}`;
    return this.appendDispatchHistory(input.record, {
      at: new Date().toISOString(),
      kind: input.kind,
      action: `${input.decision.eventType}_profile_policy_suppressed`,
      agentId: input.agentId ?? 'profile-policy',
      sessionId: null,
      recordId: input.recordId,
      bindingId: input.bindingId,
      bindingType: input.bindingType,
      status: 'suppressed',
      suppressionReason: reason,
      details: {
        profile_workspace_id: input.decision.profileWorkspaceId,
        event_type: input.decision.eventType,
        enabled: policy?.enabled ?? true,
        quiet_mode: policy?.quietMode ?? false,
        default_action: policy?.defaultAction ?? defaultActionForEventType(input.decision.eventType),
        pipeline_definition_id: input.decision.settings.pipeline.pipelineDefinitionId,
        pipeline_source: input.decision.settings.pipeline.source,
        context_count: input.decision.settings.appendedContext.length,
        ...input.details,
      },
    });
  }

  listInterceptsForSubscription(subscriptionId: string, npub: string) {
    const record = this.getForManager(subscriptionId, npub);
    if (!record) {
      return [];
    }
    return this.routingEvaluator.listInterceptsForSubscription(subscriptionId);
  }

  listDispatchRoutesForManager(npub: string): DispatchRouteRecord[] {
    if (!this.dispatchPipelineRuntime) {
      return [];
    }
    return this.dispatchPipelineRuntime
      .listRoutesForManager(npub)
      .filter((route) => this.getForManager(route.subscriptionId, npub));
  }

  listDispatchRoutesForSubscription(subscriptionId: string, npub: string): DispatchRouteRecord[] {
    const record = this.getForManager(subscriptionId, npub);
    if (!record || !this.dispatchPipelineRuntime) {
      return [];
    }
    return this.dispatchPipelineRuntime.listRoutesForSubscription(record.subscriptionId);
  }

  saveDispatchRouteForManager(input: Omit<CreateDispatchRouteInput, 'managedByNpub' | 'workspaceOwnerNpub' | 'botNpub' | 'sourceAppNpub'> & {
    routeId?: string;
    managedByNpub: string;
  }): DispatchRouteRecord {
    const record = this.getForManager(input.subscriptionId, input.managedByNpub);
    if (!record) {
      throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });
    }
    if (!this.dispatchPipelineRuntime) {
      throw Object.assign(new Error('Dispatch pipelines are not available'), { statusCode: 503 });
    }
    return this.dispatchPipelineRuntime.saveRoute({
      ...input,
      managedByNpub: input.managedByNpub,
      workspaceOwnerNpub: this.getEffectiveWorkspaceNpub(record),
      botNpub: record.botNpub,
      sourceAppNpub: record.sourceAppNpub,
    });
  }

  private ensureDefaultDispatchRoutesForSubscription(
    subscription: WorkspaceSubscriptionRecord,
    capabilities: Array<CreateDispatchRouteInput['capability']>,
  ): DispatchRouteRecord[] {
    if (!this.dispatchPipelineRuntime || !subscription.managedByNpub) {
      return [];
    }
    const enabledCapabilities = new Set(capabilities);
    const existingRoutes = this.dispatchPipelineRuntime.listRoutesForSubscription(subscription.subscriptionId);
    const created: DispatchRouteRecord[] = [];
    for (const routeConfig of DEFAULT_DISPATCH_PIPELINE_ROUTES) {
      if (!enabledCapabilities.has(routeConfig.capability)) {
        continue;
      }
      const pipelineDefinitionId = getDefaultDispatchPipelineDefinitionId(subscription, routeConfig);
      const existingRoute = existingRoutes.find((route) => (
        route.triggerKind === routeConfig.triggerKind
        && route.capability === routeConfig.capability
      ));
      if (existingRoute) {
        if (
          existingRoute.pipelineDefinitionId === routeConfig.pipelineDefinitionId
          && pipelineDefinitionId !== routeConfig.pipelineDefinitionId
        ) {
          const updatedRoute = this.dispatchPipelineRuntime.saveRoute({
            routeId: existingRoute.routeId,
            createdAt: existingRoute.createdAt,
            managedByNpub: existingRoute.managedByNpub,
            subscriptionId: existingRoute.subscriptionId,
            workspaceOwnerNpub: existingRoute.workspaceOwnerNpub,
            botNpub: existingRoute.botNpub,
            sourceAppNpub: existingRoute.sourceAppNpub,
            triggerKind: existingRoute.triggerKind,
            capability: existingRoute.capability,
            pipelineDefinitionId,
            enabled: existingRoute.enabled,
            priority: existingRoute.priority,
            matchJson: existingRoute.matchJson,
            inputTemplateJson: existingRoute.inputTemplateJson,
            concurrencyKeyTemplate: existingRoute.concurrencyKeyTemplate,
            activePolicy: existingRoute.activePolicy,
            dedupeWindowSeconds: existingRoute.dedupeWindowSeconds,
          });
          const routeIndex = existingRoutes.findIndex((route) => route.routeId === updatedRoute.routeId);
          if (routeIndex >= 0) {
            existingRoutes[routeIndex] = updatedRoute;
          }
          created.push(updatedRoute);
        }
        continue;
      }
      const route = this.dispatchPipelineRuntime.saveRoute({
        managedByNpub: subscription.managedByNpub,
        subscriptionId: subscription.subscriptionId,
        workspaceOwnerNpub: this.getEffectiveWorkspaceNpub(subscription),
        botNpub: subscription.botNpub,
        sourceAppNpub: subscription.sourceAppNpub,
        triggerKind: routeConfig.triggerKind,
        capability: routeConfig.capability,
        pipelineDefinitionId,
        enabled: true,
        priority: 100,
      });
      existingRoutes.push(route);
      created.push(route);
    }
    return created;
  }

  private ensureDefaultDispatchRoutesForAgent(agent: AgentDefinitionRecord): void {
    if (!agent.managedByNpub) {
      return;
    }
    for (const subscription of this.store.listForManagerNpub(agent.managedByNpub)) {
      if (
        this.getEffectiveWorkspaceNpub(subscription) !== agent.workspaceOwnerNpub
        || subscription.botNpub !== agent.botNpub
      ) {
        continue;
      }
      this.ensureDefaultDispatchRoutesForSubscription(subscription, agent.capabilities);
    }
  }

  deleteDispatchRouteForManager(routeId: string, npub: string): boolean {
    if (!this.dispatchPipelineRuntime) {
      return false;
    }
    return this.dispatchPipelineRuntime.deleteRouteForManager(routeId, npub);
  }

  private normaliseAgentCapabilities(
    capabilities?: string[],
  ): Array<'chat_intercept' | 'task_dispatch' | 'comment_dispatch' | 'flow_dispatch' | 'task_review' | 'approval_dispatch'> {
    const set = new Set<'chat_intercept' | 'task_dispatch' | 'comment_dispatch' | 'flow_dispatch' | 'task_review' | 'approval_dispatch'>();
    for (const capability of capabilities ?? []) {
      if (
        capability === 'chat_intercept'
        || capability === 'task_dispatch'
        || capability === 'comment_dispatch'
        || capability === 'flow_dispatch'
        || capability === 'task_review'
        || capability === 'approval_dispatch'
      ) {
        set.add(capability);
      }
    }
    return set.size > 0 ? [...set] : ['chat_intercept'];
  }

  private getEffectiveWorkspaceNpub(record: Pick<WorkspaceSubscriptionRecord, 'workspaceOwnerNpub' | 'workspaceServiceNpub'>): string {
    return record.workspaceServiceNpub?.trim() || record.workspaceOwnerNpub;
  }

  private normaliseAgentIdPart(value: string | null | undefined): string {
    const normalized = String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
    if (!normalized) {
      return 'workspace';
    }
    return normalized.length <= 24
      ? normalized
      : `${normalized.slice(0, 10)}${normalized.slice(-14)}`;
  }

  private buildOnboardedAgentId(subscription: WorkspaceSubscriptionRecord): string {
    const workspacePart = this.normaliseAgentIdPart(
      subscription.workspaceId ?? this.getEffectiveWorkspaceNpub(subscription),
    );
    const appPart = this.normaliseAgentIdPart(subscription.sourceAppNpub);
    const botPart = this.normaliseAgentIdPart(subscription.botNpub);
    return `fd-${botPart}-${workspacePart}-${appPart}`;
  }

  private buildOnboardedAgentWorkingDirectory(agentId: string): string {
    return join(this.autoAgentWorkspaceRoot, agentId);
  }

  private deriveGroupNpubsFromSubscription(subscription: WorkspaceSubscriptionRecord): string[] {
    if (!subscription.wrappedGroupKeysJson) {
      return [];
    }
    try {
      const rows = JSON.parse(subscription.wrappedGroupKeysJson) as unknown;
      if (!Array.isArray(rows)) {
        return [];
      }
      return [...new Set(rows
        .map((row) => (row && typeof row === 'object' ? (row as { group_npub?: unknown }).group_npub : null))
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim()))].sort();
    } catch {
      return [];
    }
  }

  private onboardedAgentCapabilities(subscription: WorkspaceSubscriptionRecord): AgentCapability[] {
    return this.normaliseAgentCapabilities([
      ...DEFAULT_33357_AGENT_CAPABILITIES,
      ...(subscription.capabilityDefaults ?? []),
    ]);
  }

  private async ensureOnboardedAgentForSubscription(input: {
    subscription: WorkspaceSubscriptionRecord;
    agentProfile: AgentDefinitionRecord | null;
    botIdentity: RuntimeBotIdentity;
  }): Promise<AgentDefinitionRecord | null> {
    const subscription = input.subscription;
    if (subscription.onboardingSource !== 'nostr_33357' || !subscription.managedByNpub) {
      return null;
    }

    const existing = this.agentStore
      .listByWorkspaceAndBot(this.getEffectiveWorkspaceNpub(subscription), subscription.botNpub)
      .find((agent) => agent.managedByNpub === subscription.managedByNpub);
    if (existing) {
      const capabilities = this.onboardedAgentCapabilities(subscription);
      const updated = this.agentStore.save({
        ...existing,
        capabilities: [...new Set([...existing.capabilities, ...capabilities])] as AgentCapability[],
        groupNpubs: existing.groupNpubs.length > 0
          ? existing.groupNpubs
          : this.deriveGroupNpubsFromSubscription(subscription),
        updatedAt: new Date().toISOString(),
      });
      this.ensureDefaultDispatchRoutesForSubscription(subscription, updated.capabilities);
      return updated;
    }

    const groupNpubs = this.deriveGroupNpubsFromSubscription(subscription);
    const isFlightDeckPgWorkspace = Boolean(subscription.workspaceId && subscription.workspaceServiceNpub);
    if (groupNpubs.length === 0 && !isFlightDeckPgWorkspace) {
      return null;
    }

    const agentId = this.buildOnboardedAgentId(subscription);
    const existingById = this.agentStore.getByAgentId(agentId);
    if (existingById && existingById.managedByNpub && existingById.managedByNpub !== subscription.managedByNpub) {
      throw new Error(`Auto Agent Dispatch binding ${agentId} is owned by another manager.`);
    }

    const now = new Date().toISOString();
    const label = input.agentProfile?.label
      || (input.botIdentity.botNpub === subscription.botNpub ? 'Flight Deck Agent' : 'Agent Dispatch');
    const workingDirectory = existingById?.workingDirectory?.trim()
      || this.buildOnboardedAgentWorkingDirectory(agentId);
    const capabilities = this.onboardedAgentCapabilities(subscription);

    await bootstrapAgentWorkspace({
      agentId,
      label,
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: this.getEffectiveWorkspaceNpub(subscription),
      workingDirectory,
      createdAt: existingById?.createdAt ?? now,
    });

    const saved = this.agentStore.save({
      agentId,
      label,
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: this.getEffectiveWorkspaceNpub(subscription),
      groupNpubs,
      workingDirectory,
      capabilities,
      chatPromptTemplate: existingById?.chatPromptTemplate ?? DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE,
      taskPromptTemplate: existingById?.taskPromptTemplate ?? DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE,
      flowDispatchPromptTemplate: existingById?.flowDispatchPromptTemplate ?? DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE,
      taskReviewPromptTemplate: existingById?.taskReviewPromptTemplate ?? DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE,
      approvalDispatchPromptTemplate: existingById?.approvalDispatchPromptTemplate ?? DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE,
      enabled: existingById?.enabled ?? true,
      createdAt: existingById?.createdAt ?? now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });
    this.ensureDefaultDispatchRoutesForSubscription(subscription, saved.capabilities);
    return saved;
  }

  async saveAgentForManager(input: CreateAgentDefinitionInput): Promise<AgentDefinitionRecord> {
    const agentId = input.agentId.trim();
    const label = input.label.trim() || agentId;
    const botNpub = input.botNpub.trim();
    const workspaceOwnerNpub = input.workspaceOwnerNpub.trim();
    const workingDirectory = input.workingDirectory.trim();
    const requestedGroupNpubs = [...new Set(input.groupNpubs.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
    const capabilities = this.normaliseAgentCapabilities(input.capabilities);
    const chatPromptTemplate = normalisePromptTemplate(input.chatPromptTemplate, DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE);
    const taskPromptTemplate = normalisePromptTemplate(input.taskPromptTemplate, DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE);
    const flowDispatchPromptTemplate = normalisePromptTemplate(
      input.flowDispatchPromptTemplate,
      DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE,
    );
    const taskReviewPromptTemplate = normalisePromptTemplate(
      input.taskReviewPromptTemplate,
      DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE,
    );
    const approvalDispatchPromptTemplate = normalisePromptTemplate(
      input.approvalDispatchPromptTemplate,
      DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE,
    );

    if (!agentId || !botNpub || !workspaceOwnerNpub || !workingDirectory) {
      throw new Error('agentId, botNpub, workspaceOwnerNpub, and workingDirectory are required.');
    }

    const groupNpubs = await this.resolveAgentGroupNpubs({
      requestedGroupNpubs,
      workspaceOwnerNpub,
      botNpub,
      managedByNpub: input.managedByNpub,
    });
    if (groupNpubs.length === 0) {
      throw new Error('No readable Flight Deck groups are available for this bot. Add the Wingman bot to at least one workspace group, then try again; Wingman will refresh groups automatically.');
    }

    const existing = this.agentStore.getByAgentId(agentId);
    if (existing && existing.managedByNpub && existing.managedByNpub !== input.managedByNpub) {
      throw new Error(`Agent ${agentId} is owned by another manager.`);
    }
    await bootstrapAgentWorkspace({
      agentId,
      label,
      botNpub,
      workspaceOwnerNpub,
      workingDirectory,
    });

    const now = new Date().toISOString();
    const saved = this.agentStore.save({
      agentId,
      label,
      botNpub,
      workspaceOwnerNpub,
      groupNpubs,
      workingDirectory,
      capabilities,
      chatPromptTemplate,
      taskPromptTemplate,
      flowDispatchPromptTemplate,
      taskReviewPromptTemplate,
      approvalDispatchPromptTemplate,
      enabled: input.enabled !== false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      managedByNpub: input.managedByNpub,
    });
    this.ensureDefaultDispatchRoutesForAgent(saved);
    return saved;
  }

  removeAgentForManager(agentId: string, npub: string): boolean {
    const record = this.getAgentForManager(agentId, npub);
    if (!record) {
      return false;
    }
    return this.agentStore.delete(agentId);
  }

  async importAgentConnectPackage(input: {
    managedByNpub: string;
    packageJson: string | Record<string, unknown>;
    agentProfileId?: string | null;
    allowedManagerNpubs?: string[];
    grantSharedService?: boolean;
    onboardingSource?: CreateWorkspaceSubscriptionInput['onboardingSource'];
  }): Promise<{
    backendConnection: BackendConnectionRecord;
    subscription: WorkspaceSubscriptionRecord;
  }> {
    const agentProfileId = input.agentProfileId?.trim() || null;
    const agentProfile = agentProfileId
      ? this.resolveOwnedAgentProfile(agentProfileId, input.managedByNpub)
      : null;
    const validation = validateAgentConnectPackage({
      managedByNpub: input.managedByNpub,
      packageJson: input.packageJson,
    });
    const botIdentity = this.resolveCreateBotIdentity(input.managedByNpub, agentProfile);
    let backendConnection = await this.createOrReuseBackendConnection({
      managedByNpub: input.managedByNpub,
      backendBaseUrl: validation.service.directHttpsUrl,
      serviceNpub: validation.service.serviceNpub,
      setupWorkspaceOwnerNpub: validation.workspaceOwnerNpub,
      setupSourceAppNpub: validation.sourceAppNpub,
      setupSourceAppSchemaNamespace: validation.sourceAppSchemaNamespace,
      setupConnectionTokenRef: validation.connectionTokenRef,
      setupCapabilityDefaults: validation.capabilityDefaults,
      relayUrls: validation.service.relayUrls,
      openapiUrl: validation.service.openapiUrl,
      docsUrl: validation.service.docsUrl,
      healthUrl: validation.service.healthUrl,
      supportedVersion: validation.supportedVersion,
    });
    if (input.allowedManagerNpubs || input.grantSharedService !== undefined) {
      this.backendStore.replaceAvailabilityGrants({
        backendConnectionId: backendConnection.backendConnectionId,
        managerNpubs: input.allowedManagerNpubs ?? [],
        sharedService: input.grantSharedService === true,
      });
      backendConnection = this.backendStore.getById(backendConnection.backendConnectionId) ?? backendConnection;
    }
    const importResult = buildAgentConnectImportResult(validation, backendConnection);
    const subscription = await this.createOrUpdate({
      ...importResult.subscriptionInput,
      agentProfileId,
      onboardingSource: input.onboardingSource ?? 'agent_connect_import',
    });
    this.profilePolicyStore.ensureProfileWorkspaceForSubscription({
      managedByNpub: input.managedByNpub,
      agentProfileId: agentProfile?.agentId ?? agentProfileId,
      agentLabel: agentProfile?.label ?? null,
      agentNpub: botIdentity.botNpub,
      subscription,
      backendConnection,
      relayOnboardingStatus: subscription.wsKeyStatus === 'active' ? 'ready' : 'verified',
      workspaceTitle: validation.workspaceTitle,
    });
    await this.ensureOnboardedAgentForSubscription({
      subscription,
      agentProfile,
      botIdentity,
    });
    return { backendConnection, subscription };
  }

  async createOrUpdate(input: CreateWorkspaceSubscriptionInput): Promise<WorkspaceSubscriptionRecord> {
    const requestedBackendConnectionId = input.backendConnectionId?.trim() || null;
    const requestedBackendConnection = requestedBackendConnectionId
      ? this.backendStore.getById(requestedBackendConnectionId)
      : null;
    if (requestedBackendConnectionId && !requestedBackendConnection) {
      throw new BackendConnectionNotFoundError(`Backend connection ${requestedBackendConnectionId} was not found.`);
    }
    if (
      requestedBackendConnection
      && !canUseBackendConnection(
        requestedBackendConnection,
        input.managedByNpub,
        this.backendStore,
        input.backendConnectionGrantKind ?? null,
      )
    ) {
      throw new WorkspaceSubscriptionAccessError(
        `Backend connection ${requestedBackendConnection.backendConnectionId} is not available to this manager.`,
      );
    }

    const backendBaseUrl = getOptionalText(input.backendBaseUrl)
      ? normaliseBackendBaseUrl(input.backendBaseUrl)
      : requestedBackendConnection?.backendBaseUrl ?? '';
    const workspaceOwnerNpub = getOptionalText(input.workspaceOwnerNpub)
      ?? requestedBackendConnection?.setupWorkspaceOwnerNpub
      ?? '';
    const sourceAppNpub = getOptionalText(input.sourceAppNpub)
      ?? requestedBackendConnection?.setupSourceAppNpub
      ?? '';
    const towerServiceNpub = getOptionalText(input.towerServiceNpub)
      ?? requestedBackendConnection?.serviceNpub
      ?? null;
    const workspaceId = getOptionalText(input.workspaceId);
    const workspaceServiceNpub = getOptionalText(input.workspaceServiceNpub);
    const sourceAppSchemaNamespace = getOptionalText(input.sourceAppSchemaNamespace)
      ?? requestedBackendConnection?.setupSourceAppSchemaNamespace
      ?? null;
    const connectionTokenRef = getOptionalText(input.connectionTokenRef)
      ?? requestedBackendConnection?.setupConnectionTokenRef
      ?? null;
    const capabilityDefaults = input.capabilityDefaults ?? requestedBackendConnection?.setupCapabilityDefaults ?? [];

    if (!backendBaseUrl || !workspaceOwnerNpub || !sourceAppNpub) {
      throw Object.assign(
        new Error('workspaceOwnerNpub, backendBaseUrl, and sourceAppNpub are required.'),
        { statusCode: 400 },
      );
    }

    const agentProfile = input.agentProfileId
      ? this.resolveOwnedAgentProfile(input.agentProfileId, input.managedByNpub)
      : null;
    const botIdentity = this.resolveCreateBotIdentity(input.managedByNpub, agentProfile);
    if (agentProfile && botIdentity.botNpub !== agentProfile.botNpub) {
      throw new Error(`Agent Profile ${agentProfile.agentId} bot key does not match its botNpub.`);
    }
    const backendConnection = requestedBackendConnection
      ?? await this.createOrReuseBackendConnection({
          managedByNpub: input.managedByNpub,
          backendBaseUrl,
          serviceNpub: towerServiceNpub,
          setupWorkspaceOwnerNpub: workspaceOwnerNpub,
          setupSourceAppNpub: sourceAppNpub,
          setupSourceAppSchemaNamespace: sourceAppSchemaNamespace,
          setupConnectionTokenRef: connectionTokenRef,
          setupCapabilityDefaults: capabilityDefaults,
        });
    const subscriptionBackendBaseUrl = backendConnection?.backendBaseUrl ?? backendBaseUrl;

    const scopedRecord = this.store.getBySubscriptionScope({
      backendConnectionId: backendConnection?.backendConnectionId ?? null,
      managedByNpub: input.managedByNpub,
      workspaceOwnerNpub,
      sourceAppNpub,
      botNpub: botIdentity.botNpub,
      agentProfileId: agentProfile?.agentId ?? input.agentProfileId ?? null,
      towerServiceNpub,
      workspaceId,
      workspaceServiceNpub,
    });
    const legacyRecord = this.store.getByWorkspaceAndBot(workspaceOwnerNpub, botIdentity.botNpub);
    const legacyIdentityCompatible = Boolean(
      legacyRecord
      && (!towerServiceNpub || !legacyRecord.towerServiceNpub || legacyRecord.towerServiceNpub === towerServiceNpub)
      && (!workspaceId || !legacyRecord.workspaceId || legacyRecord.workspaceId === workspaceId)
      && (!workspaceServiceNpub || !legacyRecord.workspaceServiceNpub || legacyRecord.workspaceServiceNpub === workspaceServiceNpub)
    );
    const canReuseLegacyRecord = Boolean(
      legacyRecord
      && legacyIdentityCompatible
      && (!legacyRecord.managedByNpub || legacyRecord.managedByNpub === input.managedByNpub)
      && legacyRecord.sourceAppNpub === sourceAppNpub
      && (
        legacyRecord.backendConnectionId === (backendConnection?.backendConnectionId ?? null)
        || (
          !legacyRecord.backendConnectionId
          && normaliseBackendBaseUrl(legacyRecord.backendBaseUrl) === subscriptionBackendBaseUrl
        )
      ),
    );
    let record = scopedRecord
      ?? (canReuseLegacyRecord ? legacyRecord : null)
      ?? this.store.createDefault({
        managedByNpub: input.managedByNpub,
        workspaceOwnerNpub,
        backendBaseUrl: subscriptionBackendBaseUrl,
        towerServiceNpub,
        workspaceId,
        workspaceServiceNpub,
        botNpub: botIdentity.botNpub,
        sourceAppNpub,
        backendConnectionId: backendConnection?.backendConnectionId ?? null,
        onboardingSource: input.onboardingSource ?? 'manual',
        connectionTokenRef,
        agentProfileId: agentProfile?.agentId ?? input.agentProfileId ?? null,
        sourceAppSchemaNamespace,
        capabilityDefaults,
        dispatchRouteIds: input.dispatchRouteIds ?? [],
        triggerConfigRecordId: input.triggerConfigRecordId ?? null,
      });

    record.backendConnectionId = backendConnection?.backendConnectionId ?? record.backendConnectionId ?? null;
    record.backendBaseUrl = subscriptionBackendBaseUrl;
    record.towerServiceNpub = towerServiceNpub ?? record.towerServiceNpub ?? backendConnection?.serviceNpub ?? null;
    record.workspaceId = workspaceId ?? record.workspaceId ?? null;
    record.workspaceServiceNpub = workspaceServiceNpub ?? record.workspaceServiceNpub ?? null;
    record.workspaceOwnerNpub = workspaceOwnerNpub;
    record.sourceAppNpub = sourceAppNpub;
    record.onboardingSource = input.onboardingSource ?? record.onboardingSource ?? 'manual';
    record.connectionTokenRef = connectionTokenRef ?? record.connectionTokenRef ?? null;
    record.agentProfileId = agentProfile?.agentId ?? input.agentProfileId ?? record.agentProfileId ?? null;
    record.sourceAppSchemaNamespace = sourceAppSchemaNamespace ?? record.sourceAppSchemaNamespace ?? null;
    record.capabilityDefaults = capabilityDefaults.length > 0 ? capabilityDefaults : record.capabilityDefaults ?? [];
    record.dispatchRouteIds = input.dispatchRouteIds ?? record.dispatchRouteIds ?? [];
    record.triggerConfigRecordId = input.triggerConfigRecordId ?? null;
    record.managedByNpub = input.managedByNpub;
    if (isFlightDeckPgSubscription(record)) {
      record = await this.prepareFlightDeckPgSubscription(record, botIdentity);
      record = await this.verifyFlightDeckPgWorkspaceAccess(record, botIdentity);
      await this.ensureConnected(record, botIdentity, false);
      const saved = this.store.getBySubscriptionId(record.subscriptionId) ?? record;
      const subscriptionAgents = this.agentStore
        .listByWorkspaceAndBot(this.getEffectiveWorkspaceNpub(saved), saved.botNpub)
        .filter((agent) => agent.managedByNpub === saved.managedByNpub)
        .filter((agent) => agent.enabled);
      const routeCapabilities = subscriptionAgents.length > 0
        ? [...new Set(subscriptionAgents.flatMap((agent) => agent.capabilities))]
        : saved.capabilityDefaults ?? [];
      this.ensureDefaultDispatchRoutesForSubscription(saved, routeCapabilities);
      await this.ensureOnboardedAgentForSubscription({
        subscription: saved,
        agentProfile,
        botIdentity,
      });
      return saved;
    }
    record = await this.prepareWorkspaceSession(record, botIdentity);

    try {
      record = await this.registerWorkspaceKey(record, botIdentity);
      this.clearRuntimeFailure(record.subscriptionId, 'workspace_key_registered');
    } catch (error) {
      record.wsKeyStatus = 'failed';
      record.sseStatus = 'disconnected';
      record.healthStatus = 'unhealthy';
      record.lastErrorCode = 'workspace_key_register_failed';
      record.lastErrorAt = new Date().toISOString();
      record.lastAuthResult = buildFailureDiagnostic(
        'workspace_key_register_failed',
        error instanceof Error ? error.message : 'Workspace key registration failed.',
        typeof (error as { detailCode?: string })?.detailCode === 'string' ? (error as { detailCode: string }).detailCode : null,
      );
      const saved = this.saveRecord(record);
      this.markRuntimeFailure(
        saved.subscriptionId,
        getErrorDetailCode(error) ?? 'workspace_key_register_failed',
        'workspace_key_register_failed',
      );
      return saved;
    }

    record = await this.refreshGroupKeys(record, botIdentity, true);
    await this.ensureConnected(record, botIdentity, false);
    const saved = this.store.getBySubscriptionId(record.subscriptionId) ?? record;
    const subscriptionAgents = this.agentStore
      .listByWorkspaceAndBot(this.getEffectiveWorkspaceNpub(saved), saved.botNpub)
      .filter((agent) => agent.managedByNpub === saved.managedByNpub)
      .filter((agent) => agent.enabled);
    const routeCapabilities = subscriptionAgents.length > 0
      ? [...new Set(subscriptionAgents.flatMap((agent) => agent.capabilities))]
      : saved.capabilityDefaults ?? [];
    this.ensureDefaultDispatchRoutesForSubscription(saved, routeCapabilities);
    await this.ensureOnboardedAgentForSubscription({
      subscription: saved,
      agentProfile,
      botIdentity,
    });
    return saved;
  }

  async startupReload(): Promise<void> {
    const records = this.store.listStartupCandidates();
    for (const record of records) {
      try {
        const botIdentity = this.resolveStoredBotIdentity(record.botNpub);
        if (!botIdentity) {
          const failed = {
            ...record,
            wsKeyStatus: 'failed' as const,
            healthStatus: 'unhealthy' as const,
            lastErrorCode: 'workspace_key_register_failed',
            lastErrorAt: new Date().toISOString(),
            lastAuthResult: buildFailureDiagnostic(
              'workspace_key_register_failed',
              `Bot key record not found for ${record.botNpub}.`,
              'workspace_key_missing',
            ),
          };
          const saved = this.saveRecord(failed);
          this.markRuntimeFailure(saved.subscriptionId, 'workspace_key_register_failed', 'startup_reload_failed');
          continue;
        }

        const refreshed = isFlightDeckPgSubscription(record)
          ? await this.verifyFlightDeckPgWorkspaceAccess(
            await this.prepareFlightDeckPgSubscription(record, botIdentity),
            botIdentity,
          )
          : await this.refreshGroupKeys(
            await this.prepareWorkspaceSession(record, botIdentity),
            botIdentity,
            false,
          );
        refreshed.lastSuccessfulStartupReloadAt = new Date().toISOString();
        this.saveRecord(refreshed);
        this.clearRuntimeFailure(refreshed.subscriptionId, 'startup_reload_recovered');
        await this.ensureConnected(refreshed, botIdentity, true);
        const subscriptionAgents = this.agentStore
          .listByWorkspaceAndBot(this.getEffectiveWorkspaceNpub(refreshed), refreshed.botNpub)
          .filter((agent) => agent.managedByNpub === refreshed.managedByNpub)
          .filter((agent) => agent.enabled);
        const routeCapabilities = subscriptionAgents.length > 0
          ? [...new Set(subscriptionAgents.flatMap((agent) => agent.capabilities))]
          : refreshed.capabilityDefaults ?? [];
        this.ensureDefaultDispatchRoutesForSubscription(refreshed, routeCapabilities);
        await this.replayPendingIntercepts(refreshed, botIdentity);
      } catch (error) {
        const failed = {
          ...record,
          healthStatus: 'unhealthy' as const,
          lastErrorCode: 'workspace_key_register_failed',
          lastErrorAt: new Date().toISOString(),
          lastAuthResult: buildFailureDiagnostic(
            'workspace_key_register_failed',
            error instanceof Error ? error.message : 'Startup reload failed.',
            'workspace_auth_failed',
          ),
        };
        const saved = this.saveRecord(failed);
        this.markRuntimeFailure(
          saved.subscriptionId,
          getErrorDetailCode(error) ?? 'workspace_auth_failed',
          'startup_reload_failed',
        );
      }
    }
  }

  removeForManager(subscriptionId: string, npub: string): boolean {
    const record = this.getForManager(subscriptionId, npub);
    if (!record) {
      return false;
    }
    this.stopRuntime(subscriptionId, true);
    const removed = this.store.delete(subscriptionId);
    if (removed) {
      this.dispatchPipelineRuntime?.deleteRoutesForSubscriptionForManager(subscriptionId, npub);
    }
    return removed;
  }

  async handleAccessGrantRevocation(input: {
    managedByNpub: string;
    agentProfileId?: string | null;
    grant: DecodedAccessGrant;
    verification: TowerRevocationVerificationResult;
  }): Promise<{
    matchedSubscriptions: number;
    updatedSubscriptions: WorkspaceSubscriptionRecord[];
    selfIndexRefresh: Record<string, unknown> | null;
  }> {
    const expectedBackendUrl = normaliseBackendBaseUrl(input.grant.payload.service.direct_https_url);
    const expectedTowerServiceNpub = input.grant.serviceNpub;
    const expectedWorkspaceId = getOptionalText(input.grant.payload.workspace.workspace_id);
    const expectedWorkspaceServiceNpub = input.grant.workspaceServiceNpub;
    const candidates = this.store.listForManagerNpub(input.managedByNpub).filter((record) => {
      const sameBackend = normaliseBackendBaseUrl(record.backendBaseUrl) === expectedBackendUrl;
      const backendConnection = record.backendConnectionId
        ? this.backendStore.getById(record.backendConnectionId)
        : null;
      const recordTowerServiceNpub = record.towerServiceNpub ?? backendConnection?.serviceNpub ?? null;
      const sameTowerService = expectedTowerServiceNpub
        ? recordTowerServiceNpub === expectedTowerServiceNpub
        : true;
      const sameWorkspaceId = expectedWorkspaceId
        ? record.workspaceId === expectedWorkspaceId
        : true;
      const sameWorkspaceService = record.workspaceServiceNpub === expectedWorkspaceServiceNpub;
      const sameWorkspace = record.workspaceOwnerNpub === input.grant.workspaceOwnerNpub;
      const sameApp = record.sourceAppNpub === input.grant.appNpub;
      const sameProfile = input.agentProfileId ? record.agentProfileId === input.agentProfileId : true;
      return sameBackend
        && sameTowerService
        && sameWorkspaceId
        && sameWorkspaceService
        && sameWorkspace
        && sameApp
        && sameProfile;
    });

    const updatedSubscriptions: WorkspaceSubscriptionRecord[] = [];
    const selfIndexRefresh = input.verification.confirmed
      ? this.buildAccessGrantRevocationSelfIndex(input.grant, input.verification)
      : null;

    for (const record of candidates) {
      if (!input.verification.confirmed) {
        updatedSubscriptions.push(this.saveRecord({
          ...record,
          lastErrorCode: 'workspace_revocation_unconfirmed',
          lastErrorAt: new Date().toISOString(),
          lastAuthResult: buildFailureDiagnostic(
            'workspace_revocation_unconfirmed',
            input.verification.message,
            input.verification.towerResult,
            {
              source_33357_event_id: input.grant.event.id,
              tower_result: input.verification.towerResult,
              workspace_owner_npub: input.grant.workspaceOwnerNpub,
              workspace_service_npub: input.grant.workspaceServiceNpub,
              app_npub: input.grant.appNpub,
            },
          ),
        }));
        continue;
      }

      this.stopRuntime(record.subscriptionId, true);
      const lifecycleStatus = input.verification.towerResult === 'workspace_deleted'
        || input.verification.towerResult === 'workspace_not_found'
        || input.grant.payload.action === 'deleted'
        ? 'deleted'
        : 'revoked';
      const now = new Date().toISOString();
      const revocationEvent = {
        eventId: input.grant.event.id,
        eventType: `workspace-${lifecycleStatus}`,
        at: now,
        payload: {
          tower_result: input.verification.towerResult,
          action: input.grant.payload.action,
          reason: input.grant.payload.revocation?.reason ?? input.grant.payload.grant?.reason ?? null,
        },
      };
      const saved = this.saveRecord(this.recomputeHealth({
        ...record,
        wsKeyStatus: 'revoked',
        groupKeyStatus: 'revoked',
        sseStatus: 'disabled',
        lastErrorCode: 'workspace_access_revoked',
        lastErrorAt: now,
        lastAuthResult: buildFailureDiagnostic(
          'workspace_access_revoked',
          input.verification.message,
          input.verification.towerResult,
          {
            source_33357_event_id: input.grant.event.id,
            tower_result: input.verification.towerResult,
            workspace_owner_npub: input.grant.workspaceOwnerNpub,
            workspace_service_npub: input.grant.workspaceServiceNpub,
            app_npub: input.grant.appNpub,
          },
        ),
        lastRecordPullResult: buildSuccessDiagnostic(
          'Workspace self-index tombstone refreshed after confirmed revocation.',
          selfIndexRefresh,
        ),
        lastSseEvent: revocationEvent,
        recentSseEvents: trimRecentEntries(
          [...(Array.isArray(record.recentSseEvents) ? record.recentSseEvents : []), revocationEvent],
          MAX_RECENT_SSE_EVENTS,
        ),
      }));
      this.markRuntimeFailure(saved.subscriptionId, 'workspace_access_denied', 'access_grant_revoked');
      if (saved.managedByNpub) {
        const backendConnection = saved.backendConnectionId
          ? this.backendStore.getById(saved.backendConnectionId)
          : null;
        this.profilePolicyStore.ensureProfileWorkspaceForSubscription({
          managedByNpub: saved.managedByNpub,
          agentProfileId: saved.agentProfileId ?? saved.botNpub,
          agentLabel: null,
          agentNpub: saved.botNpub,
          subscription: saved,
          backendConnection,
          relayOnboardingStatus: lifecycleStatus,
        });
      }
      updatedSubscriptions.push(saved);
    }

    return {
      matchedSubscriptions: candidates.length,
      updatedSubscriptions,
      selfIndexRefresh,
    };
  }

  async reconnectForManager(subscriptionId: string, npub: string): Promise<WorkspaceSubscriptionRecord | null> {
    const record = this.getForManager(subscriptionId, npub);
    if (!record) {
      return null;
    }
    if (isRevokedWorkspaceSubscription(record)) {
      throw new Error('Subscription access was revoked by Tower verification and cannot be reconnected.');
    }
    if (record.sseStatus === 'disabled') {
      throw new Error('Subscription is disabled. Re-enable it before reconnecting.');
    }
    return await this.repairSubscription(record, {
      refreshWorkspaceKey: false,
      reconnect: true,
      allowRegisterWhenInactive: false,
      reason: 'operator_reconnect',
    });
  }

  async refreshKeysForManager(subscriptionId: string, npub: string): Promise<WorkspaceSubscriptionRecord | null> {
    const record = this.getForManager(subscriptionId, npub);
    if (!record) {
      return null;
    }
    if (isRevokedWorkspaceSubscription(record)) {
      throw new Error('Subscription access was revoked by Tower verification and cannot refresh keys.');
    }
    return await this.repairSubscription(record, {
      refreshWorkspaceKey: true,
      reconnect: record.sseStatus !== 'disabled',
      allowRegisterWhenInactive: true,
      reason: 'operator_refresh_keys',
    });
  }

  async setEnabledForManager(
    subscriptionId: string,
    npub: string,
    enabled: boolean,
  ): Promise<WorkspaceSubscriptionRecord | null> {
    const record = this.getForManager(subscriptionId, npub);
    if (!record) {
      return null;
    }
    if (enabled && isRevokedWorkspaceSubscription(record)) {
      throw new Error('Subscription access was revoked by Tower verification and cannot be re-enabled.');
    }
    if (!enabled) {
      this.stopRuntime(subscriptionId, false);
      const disabled = this.saveRecord(this.recomputeHealth({
        ...record,
        sseStatus: 'disabled',
      }));
      return disabled;
    }

    const reenabled = this.saveRecord(this.recomputeHealth({
      ...record,
      sseStatus: 'disconnected',
    }));
    return await this.repairSubscription(reenabled, {
      refreshWorkspaceKey: false,
      reconnect: true,
      allowRegisterWhenInactive: true,
      reason: 'operator_enable',
    });
  }

  shutdown(): void {
    for (const subscriptionId of this.runtimes.keys()) {
      this.stopRuntime(subscriptionId, true);
    }
  }

  private buildAccessGrantRevocationSelfIndex(
    grant: DecodedAccessGrant,
    verification: TowerRevocationVerificationResult,
  ): Record<string, unknown> {
    const deleted = verification.towerResult === 'workspace_deleted'
      || verification.towerResult === 'workspace_not_found'
      || grant.payload.action === 'deleted';
    const now = new Date().toISOString();
    return {
      type: 'flightdeck_workspace_self_index',
      version: 1,
      updated_at: now,
      user_npub: grant.recipientNpub,
      app: {
        app_npub: grant.appNpub,
        namespace: grant.payload.app.namespace ?? 'flightdeck_pg',
      },
      workspace: {
        tower_base_url: grant.payload.service.direct_https_url,
        tower_service_npub: grant.serviceNpub,
        workspace_id: grant.payload.workspace.workspace_id ?? null,
        workspace_service_npub: grant.workspaceServiceNpub,
        workspace_owner_npub: grant.workspaceOwnerNpub,
        app_npub: grant.appNpub,
      },
      verification: {
        last_checked_at: verification.checkedAt,
        verified_by: 'autopilot',
        tower_result: verification.towerResult,
      },
      state: {
        deleted,
        status: deleted ? 'deleted' : 'revoked',
        deleted_at: deleted ? now : null,
        revoked_at: deleted ? null : now,
        reason: grant.payload.revocation?.reason ?? grant.payload.grant?.reason ?? verification.towerResult,
        source_33357_event_id: grant.event.id,
      },
    };
  }

  private resolveOwnedAgentProfile(agentProfileId: string, managedByNpub: string): AgentDefinitionRecord {
    const agent = this.agentStore.getByAgentId(agentProfileId);
    if (!agent) {
      throw new Error(`Agent Profile ${agentProfileId} was not found.`);
    }
    if (agent.managedByNpub !== managedByNpub) {
      throw new Error(`Agent Profile ${agentProfileId} is owned by another manager.`);
    }
    if (!agent.botNpub) {
      throw new Error(`Agent Profile ${agentProfileId} does not have a bot NPUB.`);
    }
    return agent;
  }

  private getInstanceRuntimeBotIdentity(expectedBotNpub?: string | null): RuntimeBotIdentity | null {
    const identity = this.getInstanceIdentity();
    if (!identity) {
      return null;
    }
    if (expectedBotNpub && identity.npub !== expectedBotNpub) {
      return null;
    }
    return {
      botNpub: identity.npub,
      botPubkeyHex: identity.pubkeyHex,
      botSecret: identity.secretKey,
    };
  }

  private resolveCreateBotIdentity(
    managedByNpub: string,
    agentProfile: AgentDefinitionRecord | null,
  ): RuntimeBotIdentity {
    const instanceIdentity = this.getInstanceRuntimeBotIdentity(agentProfile?.botNpub ?? null);
    if (instanceIdentity) {
      return instanceIdentity;
    }

    let botRecord = agentProfile
      ? this.botKeyStore.getActiveKeyForBotNpub(agentProfile.botNpub)
      : this.botKeyStore.getActiveKeyForUser(managedByNpub);
    if (!botRecord) {
      if (agentProfile) {
        throw new Error(`No active bot key exists for Agent Profile ${agentProfile.agentId}.`);
      }
      if (!this.botKeyStore.createKey) {
        throw new Error('No active bot key exists for this user.');
      }
      const decoded = nip19.decode(managedByNpub);
      if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
        throw new Error('Cannot create agent-chat bot key for invalid manager npub.');
      }
      const generated = generateBotKey(decoded.data);
      botRecord = this.botKeyStore.createKey({
        userNpub: managedByNpub,
        botPubkeyHex: generated.botPubkeyHex,
        botNpub: generated.botNpub,
        displayName: generated.displayName,
        encryptedToUser: generated.encryptedToUser,
        encryptedEscrow: generated.encryptedEscrow,
        escrowUuid: generated.escrowUuid,
      });
    }

    return this.unlockBotIdentity(botRecord);
  }

  private resolveStoredBotIdentity(botNpub: string): RuntimeBotIdentity | null {
    const instanceIdentity = this.getInstanceRuntimeBotIdentity(botNpub);
    if (instanceIdentity) {
      return instanceIdentity;
    }
    const botRecord = this.botKeyStore.getActiveKeyForBotNpub(botNpub);
    return botRecord ? this.unlockBotIdentity(botRecord) : null;
  }

  private async createOrReuseBackendConnection(input: {
    managedByNpub: string;
    backendBaseUrl: string;
    serviceNpub?: string | null;
    setupWorkspaceOwnerNpub?: string | null;
    setupSourceAppNpub?: string | null;
    setupSourceAppSchemaNamespace?: string | null;
    setupConnectionTokenRef?: string | null;
    setupCapabilityDefaults?: BackendConnectionRecord['setupCapabilityDefaults'];
    relayUrls?: string[];
    openapiUrl?: string | null;
    docsUrl?: string | null;
    healthUrl?: string | null;
    supportedVersion?: string | null;
  }): Promise<BackendConnectionRecord> {
    const backendBaseUrl = normaliseBackendBaseUrl(input.backendBaseUrl);
    const existing = this.backendStore.findReusable({
      managedByNpub: input.managedByNpub,
      backendBaseUrl,
      serviceNpub: input.serviceNpub ?? null,
    });
    if (existing) {
      const saved = this.backendStore.save({
        ...existing,
        serviceNpub: input.serviceNpub ?? existing.serviceNpub,
        setupWorkspaceOwnerNpub: input.setupWorkspaceOwnerNpub ?? existing.setupWorkspaceOwnerNpub,
        setupSourceAppNpub: input.setupSourceAppNpub ?? existing.setupSourceAppNpub,
        setupSourceAppSchemaNamespace: input.setupSourceAppSchemaNamespace ?? existing.setupSourceAppSchemaNamespace,
        setupConnectionTokenRef: input.setupConnectionTokenRef ?? existing.setupConnectionTokenRef,
        setupCapabilityDefaults: input.setupCapabilityDefaults ?? existing.setupCapabilityDefaults,
        relayUrls: input.relayUrls ?? existing.relayUrls,
        openapiUrl: input.openapiUrl ?? existing.openapiUrl,
        docsUrl: input.docsUrl ?? existing.docsUrl,
        healthUrl: input.healthUrl ?? existing.healthUrl,
        supportedVersion: input.supportedVersion ?? existing.supportedVersion,
        updatedAt: new Date().toISOString(),
      });
      return await this.checkAndSaveBackendHealth(saved);
    }
    const created = this.backendStore.save(this.backendStore.createDefault({
      managedByNpub: input.managedByNpub,
      backendBaseUrl,
      serviceNpub: input.serviceNpub ?? null,
      setupWorkspaceOwnerNpub: input.setupWorkspaceOwnerNpub ?? null,
      setupSourceAppNpub: input.setupSourceAppNpub ?? null,
      setupSourceAppSchemaNamespace: input.setupSourceAppSchemaNamespace ?? null,
      setupConnectionTokenRef: input.setupConnectionTokenRef ?? null,
      setupCapabilityDefaults: input.setupCapabilityDefaults ?? [],
      relayUrls: input.relayUrls ?? [],
      openapiUrl: input.openapiUrl ?? null,
      docsUrl: input.docsUrl ?? null,
      healthUrl: input.healthUrl ?? null,
      supportedVersion: input.supportedVersion ?? null,
    }));
    return await this.checkAndSaveBackendHealth(created);
  }

  private async checkAndSaveBackendHealth(record: BackendConnectionRecord): Promise<BackendConnectionRecord> {
    const result = await this.checkBackendHealthImpl(record);
    return this.backendStore.save({
      ...record,
      healthStatus: result.healthStatus,
      lastHealthResult: result.diagnostic,
      updatedAt: new Date().toISOString(),
    });
  }

  private async prepareWorkspaceSession(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
    options: { forceNew?: boolean } = {},
  ): Promise<WorkspaceSubscriptionRecord> {
    const helpers = await loadYokeBotHelpers();
    const blob = !options.forceNew && record.wsKeyBlobJson
      ? JSON.parse(record.wsKeyBlobJson) as Record<string, unknown>
      : null;
    const loaded = blob
      ? { blob, ...helpers.loadBotWorkspaceKey({ blob, botSecret: botIdentity.botSecret, botNpub: botIdentity.botNpub }) }
      : helpers.createBotWorkspaceKey({
        botSecret: botIdentity.botSecret,
        botNpub: botIdentity.botNpub,
        workspaceOwnerNpub: this.getEffectiveWorkspaceNpub(record),
      });

    const nextRecord = { ...record };
    nextRecord.wsKeyNpub = loaded.wsSession.npub;
    nextRecord.wsKeyBlobJson = JSON.stringify(loaded.blob);

    const existingRuntime = this.runtimes.get(record.subscriptionId);
    if (existingRuntime?.botIdentity?.botSecret && existingRuntime.botIdentity.botSecret !== botIdentity.botSecret) {
      existingRuntime.botIdentity.botSecret.fill(0);
    }
    this.runtimes.set(record.subscriptionId, {
      abortController: existingRuntime?.abortController ?? null,
      reconnectTimer: existingRuntime?.reconnectTimer ?? null,
      reconnectAttempts: existingRuntime?.reconnectAttempts ?? 0,
      botIdentity,
      wsSession: loaded.wsSession,
      groupKeys: existingRuntime?.groupKeys ?? null,
      wrappedKeyRows: existingRuntime?.wrappedKeyRows ?? (record.wrappedGroupKeysJson ? JSON.parse(record.wrappedGroupKeysJson) as unknown[] : []),
      flightDeckPgActorId: existingRuntime?.flightDeckPgActorId ?? null,
      removed: false,
    });
    return this.saveRecord(nextRecord);
  }

  private async prepareFlightDeckPgSubscription(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
  ): Promise<WorkspaceSubscriptionRecord> {
    const existingRuntime = this.runtimes.get(record.subscriptionId);
    if (existingRuntime?.botIdentity?.botSecret && existingRuntime.botIdentity.botSecret !== botIdentity.botSecret) {
      existingRuntime.botIdentity.botSecret.fill(0);
    }
    this.runtimes.set(record.subscriptionId, {
      abortController: existingRuntime?.abortController ?? null,
      reconnectTimer: existingRuntime?.reconnectTimer ?? null,
      reconnectAttempts: existingRuntime?.reconnectAttempts ?? 0,
      botIdentity,
      wsSession: null,
      groupKeys: null,
      wrappedKeyRows: [],
      flightDeckPgActorId: existingRuntime?.flightDeckPgActorId ?? null,
      removed: false,
    });

    return this.saveRecord({
      ...record,
      wsKeyNpub: botIdentity.botNpub,
      wsKeyBlobJson: null,
      wrappedGroupKeysJson: null,
      wsKeyStatus: 'active',
      groupKeyStatus: 'active',
      lastAuthOkAt: record.lastAuthOkAt ?? new Date().toISOString(),
      lastGroupRefreshAt: record.lastGroupRefreshAt ?? new Date().toISOString(),
      lastAuthResult: record.lastAuthResult ?? buildSuccessDiagnostic('Flight Deck PG bot auth prepared.', {
        workspace_id: record.workspaceId,
        workspace_service_npub: record.workspaceServiceNpub,
        bot_npub: botIdentity.botNpub,
      }),
      lastGroupRefreshResult: record.lastGroupRefreshResult ?? buildSuccessDiagnostic('Flight Deck PG uses Tower permissions instead of wrapped group keys.', {
        workspace_id: record.workspaceId,
      }),
    });
  }

  private async verifyFlightDeckPgWorkspaceAccess(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkspaceSubscriptionRecord> {
    if (!record.workspaceId) {
      throw Object.assign(new Error('Flight Deck PG workspace id is required.'), { detailCode: 'workspace_id_missing' });
    }
    try {
      const result = await this.fetchFlightDeckPgWorkspaceMeImpl({
        backendBaseUrl: record.backendBaseUrl,
        workspaceId: record.workspaceId,
        appNpub: record.sourceAppNpub,
        botIdentity,
        signal: options.signal,
      });
      const actorId = typeof result.actor?.actor_id === 'string' ? result.actor.actor_id : null;
      this.getRuntime(record.subscriptionId).flightDeckPgActorId = actorId;
      record.wsKeyStatus = 'active';
      record.groupKeyStatus = 'active';
      record.lastAuthOkAt = new Date().toISOString();
      record.lastGroupRefreshAt = record.lastAuthOkAt;
      record.lastAuthResult = buildSuccessDiagnostic('Flight Deck PG workspace access verified.', {
        workspace_id: record.workspaceId,
        workspace_service_npub: record.workspaceServiceNpub,
        bot_npub: botIdentity.botNpub,
        actor_id: actorId,
        role: result.membership?.role ?? null,
        permissions: result.permissions ?? [],
      });
      record.lastGroupRefreshResult = buildSuccessDiagnostic('Flight Deck PG permissions loaded from Tower.', {
        workspace_id: record.workspaceId,
        permission_count: Array.isArray(result.permissions) ? result.permissions.length : 0,
      });
      record.lastErrorCode = null;
      record.lastErrorAt = null;
      const saved = this.saveRecord(this.recomputeHealth(record));
      this.clearRuntimeFailure(saved.subscriptionId, 'flightdeck_pg_access_verified');
      return saved;
    } catch (error) {
      record.wsKeyStatus = 'failed';
      record.healthStatus = 'unhealthy';
      record.sseStatus = 'disconnected';
      record.lastErrorCode = 'flightdeck_pg_access_failed';
      record.lastErrorAt = new Date().toISOString();
      record.lastAuthResult = buildFailureDiagnostic(
        'flightdeck_pg_access_failed',
        error instanceof Error ? error.message : 'Flight Deck PG workspace access check failed.',
        getErrorDetailCode(error) ?? 'flightdeck_pg_access_failed',
        {
          workspace_id: record.workspaceId,
          workspace_service_npub: record.workspaceServiceNpub,
          bot_npub: botIdentity.botNpub,
        },
      );
      const saved = this.saveRecord(record);
      this.markRuntimeFailure(saved.subscriptionId, getErrorDetailCode(error) ?? 'flightdeck_pg_access_failed', 'flightdeck_pg_access_failed');
      return saved;
    }
  }

  private async registerWorkspaceKey(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
  ): Promise<WorkspaceSubscriptionRecord> {
    const helpers = await loadYokeBotHelpers();
    const attempt = async (current: WorkspaceSubscriptionRecord) => {
      const effectiveWorkspaceNpub = this.getEffectiveWorkspaceNpub(current);
      const authorization = helpers.signBotRequest({
        botSecret: botIdentity.botSecret,
        botNpub: botIdentity.botNpub,
        url: new URL('/api/v4/user/workspace-keys', current.backendBaseUrl).toString(),
        method: 'POST',
        body: {
          workspace_owner_npub: effectiveWorkspaceNpub,
          workspace_service_npub: effectiveWorkspaceNpub,
          human_workspace_owner_npub: current.workspaceOwnerNpub,
          ws_key_npub: current.wsKeyNpub,
          workspace_user_key_npub: current.wsKeyNpub,
        },
      });
      await registerWorkspaceKeyWithTower({
        backendBaseUrl: current.backendBaseUrl,
        workspaceNpub: effectiveWorkspaceNpub,
        workspaceOwnerNpub: current.workspaceOwnerNpub,
        wsKeyNpub: current.wsKeyNpub!,
        authorization,
      });
      current.wsKeyStatus = 'active';
      current.lastAuthOkAt = new Date().toISOString();
      current.lastAuthResult = buildSuccessDiagnostic('Workspace key registered.', {
        workspace_owner_npub: current.workspaceOwnerNpub,
        workspace_service_npub: effectiveWorkspaceNpub,
        ws_key_npub: current.wsKeyNpub,
      });
      current.lastErrorCode = null;
      current.lastErrorAt = null;
      return current;
    };

    try {
      return await attempt(record);
    } catch (error) {
      const status = typeof (error as { status?: unknown })?.status === 'number'
        ? (error as { status: number }).status
        : null;
      if (status !== 409) {
        throw error;
      }

      const refreshed = await this.prepareWorkspaceSession(record, botIdentity, { forceNew: true });
      const retried = await attempt(refreshed);
      retried.lastAuthResult = buildSuccessDiagnostic('Workspace key registered.', {
        workspace_owner_npub: retried.workspaceOwnerNpub,
        workspace_service_npub: this.getEffectiveWorkspaceNpub(retried),
        ws_key_npub: retried.wsKeyNpub,
        regenerated_after_conflict: true,
      });
      return retried;
    }
  }

  private async refreshGroupKeys(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
    allowFailure: boolean,
  ): Promise<WorkspaceSubscriptionRecord> {
    const runtime = this.getRuntime(record.subscriptionId);
    const helpers = await loadYokeBotHelpers();
    try {
      const keyRows = await helpers.fetchBotGroupKeys({
        wsSession: runtime.wsSession!,
        backendBaseUrl: record.backendBaseUrl,
      });
      runtime.wrappedKeyRows = keyRows;
      runtime.groupKeys = helpers.loadBotGroupKeys({
        wsSession: runtime.wsSession!,
        botSecret: botIdentity.botSecret,
        botNpub: botIdentity.botNpub,
        keyRows,
      });
      record.groupKeyStatus = 'active';
      record.lastGroupRefreshAt = new Date().toISOString();
      record.wrappedGroupKeysJson = JSON.stringify(keyRows);
      record.lastGroupRefreshResult = buildSuccessDiagnostic('Wrapped group keys refreshed.', {
        key_count: keyRows.length,
        bot_npub: botIdentity.botNpub,
      });
      record.lastErrorCode = null;
      record.lastErrorAt = null;
      this.clearRuntimeFailure(record.subscriptionId, 'group_keys_refreshed');
    } catch (error) {
      record.groupKeyStatus = record.wrappedGroupKeysJson ? 'refresh_required' : 'failed';
      record.lastErrorCode = 'group_key_fetch_failed';
      record.lastErrorAt = new Date().toISOString();
      record.lastGroupRefreshResult = buildFailureDiagnostic(
        'group_key_fetch_failed',
        error instanceof Error ? error.message : 'Group key refresh failed.',
        typeof (error as { detailCode?: string })?.detailCode === 'string' ? (error as { detailCode: string }).detailCode : null,
      );
      if (runtime.wrappedKeyRows.length > 0) {
        try {
          runtime.groupKeys = helpers.loadBotGroupKeys({
            wsSession: runtime.wsSession!,
            botSecret: botIdentity.botSecret,
            botNpub: botIdentity.botNpub,
            keyRows: runtime.wrappedKeyRows,
          });
        } catch {
          runtime.groupKeys = null;
        }
      }
      if (!allowFailure) {
        record.healthStatus = 'degraded';
      }
      this.markRuntimeFailure(
        record.subscriptionId,
        getErrorDetailCode(error) ?? 'group_key_fetch_failed',
        'group_key_refresh_required',
      );
    }
    return this.saveRecord(this.recomputeHealth(record));
  }

  private async ensureConnected(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
    isStartupReload: boolean,
  ): Promise<void> {
    if (isRevokedWorkspaceSubscription(record)) {
      this.stopRuntime(record.subscriptionId, true);
      this.saveRecord(this.recomputeHealth({
        ...record,
        sseStatus: 'disabled',
        lastErrorCode: record.lastErrorCode ?? 'workspace_access_revoked',
      }));
      return;
    }
    if (isFlightDeckPgSubscription(record)) {
      await this.ensureFlightDeckPgConnected(record, botIdentity, isStartupReload);
      return;
    }
    const runtime = this.getRuntime(record.subscriptionId);
    runtime.botIdentity = botIdentity;
    runtime.removed = false;
    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
    }
    if (runtime.abortController) {
      runtime.abortController.abort();
    }
    const controller = new AbortController();
    runtime.abortController = controller;
    record.sseStatus = 'connecting';
    this.saveRecord(this.recomputeHealth(record));
    void this.runSseLoop(record.subscriptionId, controller.signal, isStartupReload);
  }

  private async ensureFlightDeckPgConnected(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
    isStartupReload: boolean,
  ): Promise<void> {
    if (record.wsKeyStatus === 'failed') {
      this.saveRecord(this.recomputeHealth({
        ...record,
        sseStatus: 'disconnected',
      }));
      return;
    }
    const runtime = this.getRuntime(record.subscriptionId);
    runtime.botIdentity = botIdentity;
    runtime.removed = false;
    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
    }
    if (runtime.abortController) {
      runtime.abortController.abort();
    }
    const controller = new AbortController();
    runtime.abortController = controller;
    record.sseStatus = 'connecting';
    this.saveRecord(this.recomputeHealth(record));
    void this.runFlightDeckPgEventLoop(record.subscriptionId, controller.signal, isStartupReload);
  }

  private async runFlightDeckPgEventLoop(
    subscriptionId: string,
    signal: AbortSignal,
    isStartupReload: boolean,
  ): Promise<void> {
    const runtime = this.getRuntime(subscriptionId);
    let record = this.store.getBySubscriptionId(subscriptionId);
    if (!record?.workspaceId) {
      return;
    }
    const workspaceId = record.workspaceId;
    try {
      record = await this.verifyFlightDeckPgWorkspaceAccess(record, runtime.botIdentity, { signal });
      if (record.wsKeyStatus === 'failed') {
        return;
      }
      runtime.reconnectAttempts = 0;
      record.sseStatus = 'connected';
      if (isStartupReload) {
        record.lastSuccessfulStartupReloadAt = new Date().toISOString();
      }
      record = this.saveRecord(this.recomputeHealth(record));
      this.clearRuntimeFailure(record.subscriptionId, 'flightdeck_pg_events_connected');

      while (!signal.aborted && !runtime.removed) {
        const cursor = record.lastSyncCursor ?? encodeFlightDeckPgEventCursor(0);
        const result = await this.fetchFlightDeckPgEventsImpl({
          backendBaseUrl: record.backendBaseUrl,
          workspaceId,
          appNpub: record.sourceAppNpub,
          botIdentity: runtime.botIdentity,
          cursor,
          limit: 100,
          signal,
        });
        const events = result.events;
        for (const event of events) {
          if (signal.aborted || runtime.removed) {
            return;
          }
          record = await this.handleFlightDeckPgEvent(record, event);
        }
        const nextCursor = events.at(-1)?.cursor ?? result.next_cursor ?? record.lastSyncCursor;
        if (nextCursor && nextCursor !== record.lastSyncCursor) {
          record.lastSyncCursor = nextCursor;
          record = this.saveRecord(this.recomputeHealth(record));
        }
        await sleepWithAbort(FLIGHT_DECK_PG_EVENT_POLL_INTERVAL_MS, signal);
      }
    } catch (error) {
      if (signal.aborted || runtime.removed) {
        return;
      }
      record = this.store.getBySubscriptionId(subscriptionId);
      if (!record) {
        return;
      }
      record.sseStatus = 'backoff';
      record.lastErrorCode = 'flightdeck_pg_events_failed';
      record.lastErrorAt = new Date().toISOString();
      record.lastSseEvent = {
        eventId: record.lastSseEventId,
        eventType: 'flightdeck_pg.error',
        at: new Date().toISOString(),
        payload: {
          message: error instanceof Error ? error.message : String(error),
          detailCode: getErrorDetailCode(error),
        },
      };
      this.saveRecord(this.recomputeHealth(record));
      this.markRuntimeFailure(subscriptionId, getErrorDetailCode(error), 'flightdeck_pg_events_failed');

      const delay = Math.min(1_000 * Math.pow(2, runtime.reconnectAttempts), 60_000);
      runtime.reconnectAttempts += 1;
      runtime.reconnectTimer = setTimeout(() => {
        runtime.reconnectTimer = null;
        const latest = this.store.getBySubscriptionId(subscriptionId);
        if (!latest || runtime.removed) {
          return;
        }
        void this.ensureFlightDeckPgConnected(latest, runtime.botIdentity, false);
      }, delay);
    }
  }

  private async handleFlightDeckPgEvent(
    record: WorkspaceSubscriptionRecord,
    event: FlightDeckPgEvent,
  ): Promise<WorkspaceSubscriptionRecord> {
    const eventId = typeof event.event_id === 'string' ? event.event_id : typeof event.id === 'string' ? event.id : null;
    const eventType = typeof event.event_type === 'string' ? event.event_type : 'flightdeck_pg.event';
    record.lastSseEventId = eventId ?? record.lastSseEventId;
    record.lastSyncCursor = event.cursor ?? record.lastSyncCursor;
    const payload = event as Record<string, unknown>;
    const nextEvent: AgentChatSseEventDiagnostic = {
      eventId,
      eventType,
      at: new Date().toISOString(),
      payload,
    };
    record.lastSseEvent = nextEvent;
    record.recentSseEvents = trimRecentEntries(
      [...(Array.isArray(record.recentSseEvents) ? record.recentSseEvents : []), nextEvent],
      MAX_RECENT_SSE_EVENTS,
    );
    record.lastRoutingResult = buildSuccessDiagnostic('Flight Deck PG workspace event received.', {
      workspace_id: record.workspaceId,
      event_id: eventId,
      event_type: eventType,
      entity_type: event.entity_type ?? null,
      entity_id: event.entity_id ?? null,
      channel_id: event.channel_id ?? null,
      scope_id: event.scope_id ?? null,
      operation: event.operation ?? null,
    });
    record.lastErrorCode = null;
    record.lastErrorAt = null;
    record = this.saveRecord(this.recomputeHealth(record));

    if (
      (event.entity_type === 'message' || event.entity_type === 'thread')
      && event.operation !== 'deleted'
    ) {
      return await this.handleFlightDeckPgChatEvent(record, event);
    }

    return record;
  }

  private async handleFlightDeckPgChatEvent(
    record: WorkspaceSubscriptionRecord,
    event: FlightDeckPgEvent,
  ): Promise<WorkspaceSubscriptionRecord> {
    const runtime = this.getRuntime(record.subscriptionId);
    const workspaceId = record.workspaceId;
    const channelId = typeof event.channel_id === 'string' ? event.channel_id : null;
    const eventEntityId = typeof event.entity_id === 'string' ? event.entity_id : null;
    if (!workspaceId || !channelId || !eventEntityId) {
      record.lastRoutingResult = buildFailureDiagnostic(
        'flightdeck_pg_chat_event_missing_identity',
        'Flight Deck PG chat event did not include workspace, channel, or entity id.',
        'flightdeck_pg_chat_event_missing_identity',
        {
          workspace_id: workspaceId,
          channel_id: channelId,
          entity_id: eventEntityId,
          entity_type: event.entity_type ?? null,
        },
      );
      return this.saveRecord(this.recomputeHealth(record));
    }

    const eventActorId = typeof event.actor_id === 'string' ? event.actor_id : null;
    if (eventActorId && runtime.flightDeckPgActorId && eventActorId === runtime.flightDeckPgActorId) {
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'chat',
        action: 'chat_pipeline_suppressed',
        agentId: 'dispatch-pipeline',
        sessionId: null,
        recordId: eventEntityId,
        bindingId: eventEntityId,
        bindingType: 'thread',
        details: {
          suppression_reason: 'self_authored',
          event_actor_id: eventActorId,
          bot_actor_id: runtime.flightDeckPgActorId,
          source: 'flightdeck_pg',
        },
      });
    }

    if (!this.dispatchPipelineRuntime) {
      record.lastRoutingResult = buildFailureDiagnostic(
        'flightdeck_pg_chat_pipeline_unavailable',
        'No dispatch pipeline runtime is configured for Flight Deck PG chat events.',
        'flightdeck_pg_chat_pipeline_unavailable',
        { subscription_id: record.subscriptionId, event_id: event.event_id ?? event.id ?? null },
      );
      return this.saveRecord(this.recomputeHealth(record));
    }

    try {
      const messagesResult = await this.fetchFlightDeckPgChannelMessagesImpl({
        backendBaseUrl: record.backendBaseUrl,
        workspaceId,
        channelId,
        appNpub: record.sourceAppNpub,
        botIdentity: runtime.botIdentity,
        threadId: event.entity_type === 'thread' ? eventEntityId : null,
        limit: 200,
      });
      const messages = messagesResult.messages;
      const message = findFlightDeckPgDispatchMessage(messages, event) ?? messages.at(-1) ?? null;
      if (!message) {
        record.lastRoutingResult = buildFailureDiagnostic(
          'flightdeck_pg_chat_message_missing',
          'Flight Deck PG chat event was visible, but no readable message was returned for the channel.',
          'flightdeck_pg_chat_message_missing',
          {
            channel_id: channelId,
            entity_id: eventEntityId,
            entity_type: event.entity_type ?? null,
          },
        );
        return this.saveRecord(this.recomputeHealth(record));
      }

      const recordId = message.id;
      const threadId = message.thread_id ?? message.thread_source_message_id ?? message.id;
      const scopeId = message.scope_id ?? event.scope_id ?? null;
      const payload = normaliseFlightDeckPgChatPayload(message, event);
      const profileDecision = this.resolveProfileRuntimeDecision({
        subscription: record,
        eventType: 'chat_mention',
        scopeId,
        channelId,
        builtInDefaultPipelineId: 'agent-dispatch-chat',
      });
      if (!profilePolicyAllowsDispatch(profileDecision)) {
        return this.appendProfilePolicySuppression({
          record,
          decision: profileDecision!,
          kind: 'chat',
          recordId,
          bindingId: threadId,
          bindingType: 'thread',
          details: {
            channel_id: channelId,
            scope_id: scopeId,
            thread_id: threadId,
            source: 'flightdeck_pg',
          },
        });
      }

      record.lastRoutingResult = buildSuccessDiagnostic('Flight Deck PG chat dispatch pipeline start requested.', {
        subscription_id: record.subscriptionId,
        event_id: event.event_id ?? event.id ?? null,
        record_id: recordId,
        channel_id: channelId,
        scope_id: scopeId,
        thread_id: threadId,
      });
      record = this.saveRecord(this.recomputeHealth(record));
      const pipelineResult = await withTimeout(
        this.dispatchPipelineRuntime.dispatch({
          subscription: record,
          triggerKind: 'chat',
          capability: 'chat_intercept',
          recordId,
          record: {
            id: recordId,
            record_id: recordId,
            record_state: event.operation === 'deleted' ? 'deleted' : 'active',
            version: message.row_version ?? event.entity_row_version ?? event.row_version ?? null,
            row_version: message.row_version ?? event.entity_row_version ?? event.row_version ?? null,
            payload,
            flightdeck_pg_event: event,
          },
          payload,
          recordFamily: 'chat',
          recordState: event.operation === 'deleted' ? 'deleted' : 'active',
          recordVersion: message.row_version ?? event.entity_row_version ?? event.row_version ?? null,
          updaterNpub: null,
          bindingType: 'thread',
          bindingId: threadId,
          scopeId,
          channelId,
          threadId,
          changedFields: [],
          groupNpubs: [],
          botIdentity: runtime.botIdentity,
          profileRuntime: this.buildProfileRuntimeContext(profileDecision),
        }),
        CHAT_ADVISORY_PIPELINE_TIMEOUT_MS,
        'flightdeck_pg_chat_pipeline_dispatch_timeout',
      );
      if (pipelineResult.handled) {
        record.lastRoutingResult = buildSuccessDiagnostic('Flight Deck PG chat dispatch pipeline route evaluated.', {
          subscription_id: record.subscriptionId,
          event_id: event.event_id ?? event.id ?? null,
          record_id: recordId,
          route_ids: pipelineResult.historyEntries.map((entry) => entry.routeId).filter(Boolean),
          pipeline_run_ids: pipelineResult.historyEntries.map((entry) => entry.pipelineRunId).filter(Boolean),
        });
        record.lastErrorCode = null;
        record.lastErrorAt = null;
        this.clearRuntimeFailure(record.subscriptionId, 'flightdeck_pg_chat_pipeline_dispatched');
        return this.applyDispatchPipelineResult(this.saveRecord(this.recomputeHealth(record)), pipelineResult);
      }

      record.lastRoutingResult = buildFailureDiagnostic(
        'flightdeck_pg_chat_pipeline_not_handled',
        'No chat dispatch pipeline route handled this Flight Deck PG event.',
        'flightdeck_pg_chat_pipeline_not_handled',
        {
          subscription_id: record.subscriptionId,
          event_id: event.event_id ?? event.id ?? null,
          record_id: recordId,
          channel_id: channelId,
          thread_id: threadId,
        },
      );
      return this.saveRecord(this.recomputeHealth(record));
    } catch (error) {
      const detailCode = getErrorDetailCode(error) ?? 'flightdeck_pg_chat_dispatch_failed';
      record.lastRoutingResult = buildFailureDiagnostic(
        'flightdeck_pg_chat_dispatch_failed',
        error instanceof Error ? error.message : String(error),
        detailCode,
        {
          subscription_id: record.subscriptionId,
          event_id: event.event_id ?? event.id ?? null,
          channel_id: channelId,
          entity_id: eventEntityId,
        },
      );
      record.lastErrorCode = 'flightdeck_pg_chat_dispatch_failed';
      record.lastErrorAt = new Date().toISOString();
      this.markRuntimeFailure(record.subscriptionId, detailCode, 'flightdeck_pg_chat_dispatch_failed');
      return this.saveRecord(this.recomputeHealth(record));
    }
  }

  private async reconnectForReplay(subscriptionId: string, reason: string): Promise<void> {
    const runtime = this.getRuntime(subscriptionId);
    const latest = this.store.getBySubscriptionId(subscriptionId);
    if (!latest || runtime.removed) {
      return;
    }
    latest.sseStatus = 'backoff';
    latest.lastErrorCode = reason;
    latest.lastErrorAt = new Date().toISOString();
    this.saveRecord(this.recomputeHealth(latest));
    await this.ensureConnected(latest, runtime.botIdentity, false);
  }

  private async fetchRecordHistoryWithRetry(
    record: WorkspaceSubscriptionRecord,
    recordId: string,
    wsSession: YokeWorkspaceSession,
  ): Promise<{ versions: Record<string, unknown>[]; attempts: number }> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.chatRecordPullMaxAttempts; attempt += 1) {
      const controller = new AbortController();
      try {
        const versions = await withTimeout(
          this.fetchRecordHistoryImpl(
            record.backendBaseUrl,
            this.getEffectiveWorkspaceNpub(record),
            recordId,
            wsSession,
            { signal: controller.signal },
          ),
          this.chatRecordPullTimeoutMs,
          'chat_record_pull_timeout',
          () => controller.abort(),
        );
        return { versions, attempts: attempt };
      } catch (error) {
        lastError = error;
        controller.abort();
        if (attempt >= this.chatRecordPullMaxAttempts) {
          break;
        }
        await sleep(this.chatRecordPullRetryDelayMs * attempt);
      }
    }

    const retryError = lastError instanceof Error
      ? lastError
      : new Error('Record pull failed.');
    throw Object.assign(retryError, {
      pullAttempts: this.chatRecordPullMaxAttempts,
      detailCode: getErrorDetailCode(retryError) ?? 'record_pull_failed',
    });
  }

  private async runSseLoop(subscriptionId: string, signal: AbortSignal, isStartupReload: boolean): Promise<void> {
    const runtime = this.getRuntime(subscriptionId);
    let record = this.store.getBySubscriptionId(subscriptionId);
    if (!record) {
      return;
    }
    if (isRevokedWorkspaceSubscription(record)) {
      this.stopRuntime(subscriptionId, true);
      this.saveRecord(this.recomputeHealth({
        ...record,
        sseStatus: 'disabled',
        lastErrorCode: record.lastErrorCode ?? 'workspace_access_revoked',
      }));
      return;
    }
    try {
      const streamUrl = await buildStreamUrl(
        record.backendBaseUrl,
        this.getEffectiveWorkspaceNpub(record),
        runtime.wsSession!,
        record.lastSseEventId,
      );
      const response = await fetch(streamUrl, {
        headers: {
          Accept: 'text/event-stream',
        },
        signal,
      });
      if (!response.ok || !response.body) {
        const error = await parseTowerError(response, 'stream_connect');
        throw Object.assign(new Error(error.message), error);
      }

      runtime.reconnectAttempts = 0;
      record.sseStatus = 'connected';
      if (isStartupReload) {
        record.lastSuccessfulStartupReloadAt = new Date().toISOString();
      }
      record = this.saveRecord(this.recomputeHealth(record));
      this.clearRuntimeFailure(record.subscriptionId, 'sse_connected');

      for await (const event of parseSseEvents(response.body)) {
        if (signal.aborted) {
          return;
        }
        record = await this.handleSseEvent(record, event.id, event.event, event.data);
      }

      throw Object.assign(new Error('SSE stream closed.'), { detailCode: 'sse_stream_lost' });
    } catch (error) {
      if (signal.aborted || runtime.removed) {
        return;
      }
      record = this.store.getBySubscriptionId(subscriptionId);
      if (!record) {
        return;
      }
      record.sseStatus = 'backoff';
      record.lastErrorCode = 'sse_connect_failed';
      record.lastErrorAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : 'SSE connection failed.';
      const detailCode = typeof (error as { detailCode?: string })?.detailCode === 'string'
        ? (error as { detailCode: string }).detailCode
        : null;
      record.lastSseEvent = {
        eventId: record.lastSseEventId,
        eventType: 'error',
        at: new Date().toISOString(),
        payload: { message, detailCode },
      };
      this.saveRecord(this.recomputeHealth(record));
      this.markRuntimeFailure(subscriptionId, detailCode, 'sse_connect_failed');

      const delay = Math.min(1_000 * Math.pow(2, runtime.reconnectAttempts), 60_000);
      runtime.reconnectAttempts += 1;
      runtime.reconnectTimer = setTimeout(() => {
        runtime.reconnectTimer = null;
        const latest = this.store.getBySubscriptionId(subscriptionId);
        if (!latest || runtime.removed) {
          return;
        }
        void this.ensureConnected(latest, runtime.botIdentity, false);
      }, delay);
    }
  }

  private async handleSseEvent(
    record: WorkspaceSubscriptionRecord,
    eventId: string | null,
    eventType: string,
    eventData: string,
  ): Promise<WorkspaceSubscriptionRecord> {
    let payload: Record<string, unknown> | null = null;
    if (isRevokedWorkspaceSubscription(record)) {
      return this.saveRecord(this.recomputeHealth({
        ...record,
        sseStatus: 'disabled',
        lastRoutingResult: buildFailureDiagnostic(
          'workspace_event_suppressed_revoked',
          'SSE event ignored because Tower-confirmed workspace access is revoked.',
          'workspace_access_revoked',
          { event_id: eventId, event_type: eventType },
        ),
      }));
    }
    try {
      payload = eventData ? JSON.parse(eventData) as Record<string, unknown> : null;
    } catch {
      payload = { raw: eventData };
    }
    const previousLastSseEventId = record.lastSseEventId;
    record.lastSseEventId = eventId ?? record.lastSseEventId;
    const nextEvent: AgentChatSseEventDiagnostic = {
      eventId,
      eventType,
      at: new Date().toISOString(),
      payload,
    };
    record.lastSseEvent = nextEvent;
    record.recentSseEvents = trimRecentEntries(
      [...(Array.isArray(record.recentSseEvents) ? record.recentSseEvents : []), nextEvent],
      MAX_RECENT_SSE_EVENTS,
    );
    record = this.saveRecord(record);

    if (eventType === 'connected') {
      record.sseStatus = 'connected';
      const saved = this.saveRecord(this.recomputeHealth(record));
      this.clearRuntimeFailure(saved.subscriptionId, 'sse_connected_event');
      return saved;
    }

    if (eventType === 'record-changed' && payload?.family_hash === buildChatMessageFamilyHash(record.sourceAppNpub)) {
      return await this.handleChatMessageRecordChanged(record, payload, {
        eventId,
        previousLastSseEventId,
      });
    }
    if (eventType === 'record-changed' && payload?.family_hash === buildRecordFamilyHash(record.sourceAppNpub, 'task')) {
      return await this.handleTaskRecordChanged(record, payload);
    }
    if (eventType === 'record-changed' && payload?.family_hash === buildRecordFamilyHash(record.sourceAppNpub, 'approval')) {
      return await this.handleApprovalRecordChanged(record, payload);
    }
    if (eventType === 'record-changed' && payload?.family_hash === buildRecordFamilyHash(record.sourceAppNpub, 'comment')) {
      return await this.handleCommentRecordChanged(record, payload);
    }

    if (eventType === 'record-changed') {
      record.lastRoutingResult = buildFailureDiagnostic(
        'record_family_unhandled',
        'Record-changed advisory did not match a configured dispatch family.',
        'record_family_unhandled',
        {
          subscription_id: record.subscriptionId,
          event_id: eventId,
          event_family_hash: payload?.family_hash ?? null,
          expected_chat_family_hash: buildChatMessageFamilyHash(record.sourceAppNpub),
          expected_task_family_hash: buildRecordFamilyHash(record.sourceAppNpub, 'task'),
          expected_approval_family_hash: buildRecordFamilyHash(record.sourceAppNpub, 'approval'),
          expected_comment_family_hash: buildRecordFamilyHash(record.sourceAppNpub, 'comment'),
        },
      );
      return this.saveRecord(record);
    }

    return record;
  }

  private async handleChatMessageRecordChanged(
    record: WorkspaceSubscriptionRecord,
    payload: Record<string, unknown>,
    eventCursor: { eventId: string | null; previousLastSseEventId: string | null },
  ): Promise<WorkspaceSubscriptionRecord> {
    const recordId = typeof payload.record_id === 'string' ? payload.record_id : '';
    if (!recordId) {
      record.lastRecordPullResult = buildFailureDiagnostic(
        'record_pull_failed',
        'Chat message advisory did not include a record_id.',
        'record_id_missing',
        { subscription_id: record.subscriptionId },
      );
      return this.saveRecord(record);
    }

    const runtime = this.getRuntime(record.subscriptionId);
    try {
      record.lastRecordPullResult = buildSuccessDiagnostic('Chat message advisory pull started.', {
        subscription_id: record.subscriptionId,
        record_id: recordId,
      });
      record = this.saveRecord(record);
      const pullResult = await this.fetchRecordHistoryWithRetry(record, recordId, runtime.wsSession!);
      const versions = pullResult.versions;
      const latest = versions.sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0))[0];
      if (!latest) {
        throw Object.assign(new Error(`Record ${recordId} not found.`), { detailCode: 'record_pull_not_found' });
      }
      record.lastRecordPullResult = buildSuccessDiagnostic('Chat message advisory pulled.', {
        record_id: recordId,
        version: typeof latest.version === 'number' ? latest.version : Number(latest.version ?? 0),
        record_state: typeof latest.record_state === 'string' ? latest.record_state : null,
        pull_attempts: pullResult.attempts,
      });
      record = this.saveRecord(record);
      const helpers = await loadYokeBotHelpers();
      if (!runtime.groupKeys && runtime.wrappedKeyRows.length > 0) {
        runtime.groupKeys = helpers.loadBotGroupKeys({
          wsSession: runtime.wsSession!,
          botSecret: runtime.botIdentity.botSecret,
          botNpub: runtime.botIdentity.botNpub,
          keyRows: runtime.wrappedKeyRows,
        });
      }
      try {
        const decryptChatMessage = () => helpers.decryptChatRecord({
          record: latest,
          wsSession: runtime.wsSession!,
          groupKeys: runtime.groupKeys,
        });
        let chatMessage: Record<string, unknown>;
        record.lastDecryptResult = buildSuccessDiagnostic('Chat message decrypt started.', {
          subscription_id: record.subscriptionId,
          record_id: recordId,
        });
        record = this.saveRecord(record);
        try {
          chatMessage = await withTimeout(
            Promise.resolve().then(decryptChatMessage),
            CHAT_ADVISORY_DECRYPT_TIMEOUT_MS,
            'chat_record_decrypt_timeout',
          );
        } catch (decryptError) {
          const detailCode = getErrorDetailCode(decryptError);
          if (detailCode !== 'group_key_missing') {
            throw decryptError;
          }
          record = await this.refreshGroupKeys(record, runtime.botIdentity, true);
          chatMessage = await withTimeout(
            Promise.resolve().then(decryptChatMessage),
            CHAT_ADVISORY_DECRYPT_TIMEOUT_MS,
            'chat_record_decrypt_timeout',
          );
        }
        record.lastDecryptResult = buildSuccessDiagnostic('Chat message pulled and decrypted.', {
          record_id: recordId,
          channel_id: chatMessage.channel_id ?? null,
        });
        record = this.saveRecord(record);
        if (this.dispatchPipelineRuntime) {
          try {
            record.lastRoutingResult = buildSuccessDiagnostic('Chat dispatch routing context started.', {
              subscription_id: record.subscriptionId,
              record_id: recordId,
            });
            record = this.saveRecord(record);
            const routingContext = await withTimeout(
              this.routingEvaluator.buildDispatchContext({
                subscription: record,
                wsSession: runtime.wsSession!,
                groupKeys: runtime.groupKeys,
                chatRecordId: recordId,
                chatRecord: latest,
                chatMessage,
              }),
              CHAT_ADVISORY_ROUTING_TIMEOUT_MS,
              'chat_routing_context_timeout',
            );
            const profileDecision = this.resolveProfileRuntimeDecision({
              subscription: record,
              eventType: 'chat_mention',
              scopeId: routingContext.scopeId,
              channelId: routingContext.channelId,
              builtInDefaultPipelineId: 'agent-dispatch-chat',
            });
            if (!profilePolicyAllowsDispatch(profileDecision)) {
              return this.appendProfilePolicySuppression({
                record,
                decision: profileDecision!,
                kind: 'chat',
                recordId,
                bindingId: routingContext.threadId,
                bindingType: 'thread',
                details: {
                  channel_id: routingContext.channelId,
                  scope_id: routingContext.scopeId,
                  thread_id: routingContext.threadId,
                },
              });
            }
            record.lastRoutingResult = buildSuccessDiagnostic('Chat dispatch pipeline start requested.', {
              subscription_id: record.subscriptionId,
              record_id: recordId,
              channel_id: routingContext.channelId,
              scope_id: routingContext.scopeId,
              thread_id: routingContext.threadId,
              message_group_npubs: routingContext.messageGroupNpubs,
            });
            record = this.saveRecord(record);
            const pipelineResult = await withTimeout(
              this.dispatchPipelineRuntime.dispatch({
                subscription: record,
                triggerKind: 'chat',
                capability: 'chat_intercept',
                recordId,
                record: latest,
                payload: chatMessage,
                recordFamily: 'chat',
                recordState: typeof latest.record_state === 'string' ? latest.record_state : null,
                recordVersion: typeof latest.version === 'number' ? latest.version : Number(latest.version ?? 0),
                updaterNpub: routingContext.updaterNpub,
                bindingType: 'thread',
                bindingId: routingContext.threadId,
                scopeId: routingContext.scopeId,
                channelId: routingContext.channelId,
                threadId: routingContext.threadId,
                changedFields: [],
                groupNpubs: routingContext.messageGroupNpubs,
                botIdentity: runtime.botIdentity,
                profileRuntime: this.buildProfileRuntimeContext(profileDecision),
              }),
              CHAT_ADVISORY_PIPELINE_TIMEOUT_MS,
              'chat_pipeline_dispatch_timeout',
            );
            if (pipelineResult.handled) {
              record.lastRoutingResult = buildSuccessDiagnostic('Chat dispatch pipeline route evaluated.', {
                subscription_id: record.subscriptionId,
                record_id: recordId,
                route_ids: pipelineResult.historyEntries.map((entry) => entry.routeId).filter(Boolean),
                pipeline_run_ids: pipelineResult.historyEntries.map((entry) => entry.pipelineRunId).filter(Boolean),
              });
              record.lastErrorCode = null;
              record.lastErrorAt = null;
              this.clearRuntimeFailure(record.subscriptionId, 'chat_pipeline_dispatched');
              return this.applyDispatchPipelineResult(record, pipelineResult);
            }
            record.lastRoutingResult = buildFailureDiagnostic(
              'chat_pipeline_not_handled',
              'No chat dispatch pipeline route handled this advisory.',
              'chat_pipeline_not_handled',
              {
                subscription_id: record.subscriptionId,
                record_id: recordId,
                channel_id: routingContext.channelId,
                thread_id: routingContext.threadId,
              },
            );
            record = this.saveRecord(record);
          } catch (pipelineError) {
            const detailCode = getErrorDetailCode(pipelineError) ?? 'chat_pipeline_failed';
            record.lastRoutingResult = buildFailureDiagnostic(
              'chat_pipeline_failed',
              pipelineError instanceof Error ? pipelineError.message : String(pipelineError),
              detailCode,
              {
                subscription_id: record.subscriptionId,
                record_id: recordId,
              },
            );
            this.markRuntimeFailure(record.subscriptionId, detailCode, 'chat_pipeline_failed');
            record = this.appendDispatchHistory(record, {
              at: new Date().toISOString(),
              kind: 'chat',
              action: 'chat_pipeline_failed',
              agentId: 'pipeline',
              sessionId: null,
              recordId,
              bindingId: recordId,
              bindingType: 'thread',
              status: 'failed',
              details: {
                diagnostic_summary: pipelineError instanceof Error ? pipelineError.message : String(pipelineError),
                detail_code: detailCode,
              },
            });
          }
        }
        const routingResult = await withTimeout(
          this.routingEvaluator.evaluate({
            subscription: record,
            wsSession: runtime.wsSession!,
            groupKeys: runtime.groupKeys,
            chatRecordId: recordId,
            chatRecord: latest,
            chatMessage,
          }),
          CHAT_ADVISORY_ROUTING_TIMEOUT_MS,
          'chat_legacy_routing_timeout',
        );
        record.lastRoutingResult = routingResult.diagnostic;
        record.lastErrorCode = null;
        record.lastErrorAt = null;
        this.clearRuntimeFailure(record.subscriptionId, 'chat_record_decrypted');
        const selfSuppressedAgentIds = getOptionalTextArray(routingResult.diagnostic.details?.self_suppressed_agent_ids);
        const senderNpub = getOptionalText(routingResult.diagnostic.details?.sender_npub);
        const updaterNpub = getOptionalText(routingResult.diagnostic.details?.updater_npub);
        for (const agentId of selfSuppressedAgentIds) {
          record = this.appendDispatchHistory(record, {
            at: new Date().toISOString(),
            kind: 'chat',
            action: 'chat_skip_self_update',
            agentId,
            sessionId: null,
            recordId,
            bindingId: recordId,
            bindingType: 'chat',
            details: {
              sender_npub: senderNpub,
              updater_npub: updaterNpub,
            },
          });
        }
        if (routingResult.assignments.length > 0 && this.chatRuntime) {
          for (const assignment of routingResult.assignments) {
            const profileDecision = this.resolveProfileRuntimeDecision({
              subscription: record,
              eventType: 'chat_mention',
              scopeId: assignment.scopeId,
              channelId: assignment.intercept.channelId,
              builtInDefaultPipelineId: 'agent-dispatch-chat',
            });
            if (!profilePolicyAllowsLegacyPrompt(profileDecision)) {
              record = this.appendProfilePolicySuppression({
                record,
                decision: profileDecision!,
                kind: 'chat',
                recordId,
                bindingId: assignment.intercept.threadId,
                bindingType: 'thread',
                agentId: assignment.agent.agentId,
                details: {
                  channel_id: assignment.intercept.channelId,
                  scope_id: assignment.scopeId,
                  thread_id: assignment.intercept.threadId,
                  sender_npub: senderNpub,
                  updater_npub: updaterNpub,
                },
              });
              continue;
            }
            record = this.appendDispatchHistory(record, {
              at: new Date().toISOString(),
              kind: 'chat',
              action: 'chat_dispatch',
              agentId: assignment.agent.agentId,
              sessionId: assignment.intercept.sessionId ?? null,
              recordId,
              bindingId: assignment.intercept.routingKey,
              bindingType: 'chat',
              details: {
                channel_id: assignment.intercept.channelId,
                scope_id: assignment.scopeId,
                thread_id: assignment.intercept.threadId,
                sender_npub: senderNpub,
                updater_npub: updaterNpub,
              },
            });
            void this.chatRuntime.handleRoutedChat({
              agent: assignment.agent,
              subscription: record,
              intercept: assignment.intercept,
              botIdentity: runtime.botIdentity,
              chatMessage,
              runtimeContext: profileDecision?.contextText,
            }).catch((runtimeError) => {
              console.warn(
                `[agent-chat] runtime dispatch failed for ${assignment.intercept.routingKey}: ${
                  runtimeError instanceof Error ? runtimeError.message : String(runtimeError)
                }`,
              );
            });
          }
        }
      } catch (error) {
        const detailCode = typeof (error as { code?: string; detailCode?: string })?.code === 'string'
          ? (error as { code: string }).code
          : typeof (error as { detailCode?: string })?.detailCode === 'string'
            ? (error as { detailCode: string }).detailCode
            : 'record_decrypt_failed';
        record.groupKeyStatus = 'refresh_required';
        record.lastErrorCode = 'decrypt_failed';
        record.lastErrorAt = new Date().toISOString();
        record.lastDecryptResult = buildFailureDiagnostic(
          'decrypt_failed',
          error instanceof Error ? error.message : 'Decrypt failed.',
          detailCode,
          { record_id: recordId },
        );
        record.lastRoutingResult = buildFailureDiagnostic(
          'target_bot_not_decrypt_capable',
          error instanceof Error ? error.message : 'Routing skipped because the chat record could not be decrypted.',
          detailCode,
          {
            record_id: recordId,
            target_bot_npub: record.botNpub,
          },
        );
        this.markRuntimeFailure(record.subscriptionId, detailCode, 'record_decrypt_failed');
      }
    } catch (error) {
      const detailCode = typeof (error as { detailCode?: string })?.detailCode === 'string'
        ? (error as { detailCode: string }).detailCode
        : 'record_pull_failed';
      const pullAttempts = typeof (error as { pullAttempts?: unknown })?.pullAttempts === 'number'
        ? (error as { pullAttempts: number }).pullAttempts
        : this.chatRecordPullMaxAttempts;
      record.lastSseEventId = eventCursor.previousLastSseEventId;
      record.lastErrorCode = 'record_pull_failed';
      record.lastErrorAt = new Date().toISOString();
      record.lastRecordPullResult = buildFailureDiagnostic(
        'record_pull_failed',
        error instanceof Error ? error.message : 'Record pull failed.',
        detailCode,
        {
          record_id: recordId,
          pull_attempts: pullAttempts,
          replay_from_event_id: eventCursor.previousLastSseEventId,
          failed_event_id: eventCursor.eventId,
        },
      );
      record.lastDecryptResult = buildFailureDiagnostic(
        'decrypt_failed',
        'Decrypt skipped because record pull failed.',
        detailCode,
        { record_id: recordId },
      );
      record.lastRoutingResult = buildFailureDiagnostic(
        'target_bot_not_decrypt_capable',
        'Routing skipped because the chat record could not be pulled.',
        detailCode,
        {
          record_id: recordId,
          target_bot_npub: record.botNpub,
        },
      );
      this.markRuntimeFailure(record.subscriptionId, detailCode, 'record_pull_failed');
      record = this.saveRecord(this.recomputeHealth(record));
      void this.reconnectForReplay(record.subscriptionId, detailCode).catch((reconnectError) => {
        console.warn(
          `[agent-chat] failed to reconnect after chat record pull failure for ${record.subscriptionId}: ${
            reconnectError instanceof Error ? reconnectError.message : String(reconnectError)
          }`,
        );
      });
      return record;
    }
    return this.saveRecord(this.recomputeHealth(record));
  }

  private listTaskDispatchAgents(
    subscription: WorkspaceSubscriptionRecord,
    capability: 'task_dispatch' | 'flow_dispatch' | 'task_review' | 'approval_dispatch' = 'task_dispatch',
  ): AgentDefinitionRecord[] {
    return this.agentStore
      .listByWorkspaceAndBot(this.getEffectiveWorkspaceNpub(subscription), subscription.botNpub)
      .filter((agent) => agent.enabled && agent.capabilities.includes(capability))
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
  }

  private listCommentDispatchAgents(subscription: WorkspaceSubscriptionRecord): AgentDefinitionRecord[] {
    return this.agentStore
      .listByWorkspaceAndBot(this.getEffectiveWorkspaceNpub(subscription), subscription.botNpub)
      .filter((agent) => agent.enabled && agent.capabilities.includes('comment_dispatch'))
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
  }

  private listDocumentCommentAgents(
    subscription: WorkspaceSubscriptionRecord,
    commentRecord: Record<string, unknown>,
  ): AgentDefinitionRecord[] {
    return selectDocumentCommentAgents({
      subscription,
      commentRecord,
      agents: this.agentStore.listByWorkspaceAndBot(this.getEffectiveWorkspaceNpub(subscription), subscription.botNpub),
    });
  }

  private async loadAdvisoryRecordVersions(
    subscription: WorkspaceSubscriptionRecord,
    recordId: string,
  ): Promise<Record<string, unknown>[]> {
    const runtime = this.getRuntime(subscription.subscriptionId);
    return await this.fetchRecordHistoryImpl(
      subscription.backendBaseUrl,
      this.getEffectiveWorkspaceNpub(subscription),
      recordId,
      runtime.wsSession!,
    );
  }

  private async decryptAdvisoryPayload(
    subscription: WorkspaceSubscriptionRecord,
    latest: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const runtime = this.getRuntime(subscription.subscriptionId);
    if (!runtime.groupKeys && runtime.wrappedKeyRows.length > 0) {
      const helpers = await loadYokeBotHelpers();
      runtime.groupKeys = helpers.loadBotGroupKeys({
        wsSession: runtime.wsSession!,
        botSecret: runtime.botIdentity.botSecret,
        botNpub: runtime.botIdentity.botNpub,
        keyRows: runtime.wrappedKeyRows,
      });
    }
    return await this.decryptRecordPayloadImpl({
      record: latest,
      wsSession: runtime.wsSession!,
      groupKeys: runtime.groupKeys,
    });
  }

  private async handleTaskRecordChanged(
    record: WorkspaceSubscriptionRecord,
    payload: Record<string, unknown>,
  ): Promise<WorkspaceSubscriptionRecord> {
    const recordId = typeof payload.record_id === 'string' ? payload.record_id : '';
    if (!recordId) {
      return record;
    }

    try {
      const versions = await this.loadAdvisoryRecordVersions(record, recordId);
      const [latest, previous] = versions.sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0));
      if (!latest) {
        return record;
      }
      const decrypted = await this.decryptAdvisoryPayload(record, latest);
      const updaterNpub = getRecordUpdaterNpub(latest);
      const task = normaliseInboundTaskRecord(decrypted);
      if (!task) {
        return this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'task',
          action: 'task_skip_invalid_payload',
          agentId: 'unknown',
          sessionId: null,
          recordId,
          bindingId: recordId,
          bindingType: 'task',
          details: {
            reason: 'normalise_failed',
            updater_npub: updaterNpub,
            payload_keys: Object.keys(decrypted).slice(0, 20),
          },
        });
      }
      let previousTask: InboundTaskRecord | null = null;
      if (previous) {
        try {
          previousTask = normaliseInboundTaskRecord(await this.decryptAdvisoryPayload(record, previous));
        } catch {
          previousTask = null;
        }
      }
      const changedFields = diffTaskDispatchSnapshots(
        buildTaskDispatchSnapshot(task),
        previousTask ? buildTaskDispatchSnapshot(previousTask) : null,
      );

      const dispatchMode = resolveTaskDispatchMode(task);
      const historyKind = dispatchModeToHistoryKind(dispatchMode);
      const bindingId = dispatchModeToBindingId(dispatchMode, task);
      const bindingType = dispatchModeToBindingType(dispatchMode, task);
      const profileDecision = this.resolveProfileRuntimeDecision({
        subscription: record,
        eventType: eventTypeForTaskDispatchMode(dispatchMode),
        scopeId: getTaskScopeId(task),
        builtInDefaultPipelineId: dispatchMode === 'task_dispatch'
          ? 'agent-dispatch-task-response'
          : undefined,
      });
      if (!profilePolicyAllowsDispatch(profileDecision)) {
        return this.appendProfilePolicySuppression({
          record,
          decision: profileDecision!,
          kind: historyKind,
          recordId,
          bindingId,
          bindingType,
          details: {
            task_id: task.taskId,
            dispatch_mode: dispatchMode,
            scope_id: getTaskScopeId(task),
            updater_npub: updaterNpub,
            changed_fields: changedFields,
          },
        });
      }
      if (this.dispatchPipelineRuntime) {
        const routeAgent = {
          agentId: 'dispatch-pipeline',
          label: 'Dispatch Pipeline',
          botNpub: record.botNpub,
          workspaceOwnerNpub: this.getEffectiveWorkspaceNpub(record),
          managedByNpub: record.managedByNpub,
          workingDirectory: '',
          capabilities: [],
          enabled: true,
          groupNpubs: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } satisfies AgentDefinitionRecord;
        const pipelineEligibility = evaluateTaskPipelineEligibility({
          task,
          recordState: typeof latest.record_state === 'string' ? latest.record_state : null,
          mode: dispatchMode,
          agent: routeAgent,
        });
        if (pipelineEligibility !== 'dispatch') {
          return this.appendDispatchHistory(record, {
            at: new Date().toISOString(),
            kind: historyKind,
            action: pipelineEligibility,
            agentId: routeAgent.agentId,
            sessionId: null,
            recordId,
            bindingId,
            bindingType,
            details: {
              task_id: task.taskId,
              updater_npub: updaterNpub,
              changed_fields: changedFields,
              assigned_to: task.assignedTo,
              state: task.state,
              predecessor_task_ids: task.predecessorTaskIds,
            },
          });
        }
        const triggerKind = dispatchModeToTriggerKind(dispatchMode);
        const pipelineResult = await this.dispatchPipelineRuntime.dispatch({
          subscription: record,
          triggerKind,
          capability: dispatchMode,
          recordId,
          record: latest,
          payload: decrypted,
          recordFamily: 'task',
          recordState: typeof latest.record_state === 'string' ? latest.record_state : null,
          recordVersion: typeof latest.version === 'number' ? latest.version : Number(latest.version ?? 0),
          updaterNpub,
          bindingType,
          bindingId,
          scopeId: getTaskScopeId(task),
          changedFields,
          groupNpubs: [],
          botIdentity: this.getRuntime(record.subscriptionId)?.botIdentity ?? null,
          profileRuntime: this.buildProfileRuntimeContext(profileDecision),
        });
        if (pipelineResult.handled) {
          return this.applyDispatchPipelineResult(record, pipelineResult);
        }
      }
      if (!this.agentWorkRuntime || dispatchMode !== 'task_dispatch') {
        return record;
      }
      const taskAgents = this.listTaskDispatchAgents(record, 'task_dispatch');
      if (taskAgents.length === 0) {
        return record;
      }

      for (const agent of taskAgents) {
        if (!profilePolicyAllowsLegacyPrompt(profileDecision)) {
          record = this.appendProfilePolicySuppression({
            record,
            decision: profileDecision!,
            kind: historyKind,
            recordId,
            bindingId,
            bindingType,
            agentId: agent.agentId,
            details: {
              task_id: task.taskId,
              dispatch_mode: dispatchMode,
              updater_npub: updaterNpub,
              changed_fields: changedFields,
            },
          });
          continue;
        }
        const skipSelfAction = dispatchModeToSelfSkipAction(dispatchMode);
        if (isSelfUpdater(record, agent, updaterNpub) && !changedFields.includes('new_task') && changedFields.length === 0) {
          record = this.appendDispatchHistory(record, {
            at: new Date().toISOString(),
            kind: historyKind,
            action: skipSelfAction,
            agentId: agent.agentId,
            sessionId: null,
            recordId,
            bindingId,
            bindingType,
            details: {
              task_id: task.taskId,
              updater_npub: updaterNpub,
              changed_fields: changedFields,
              assigned_to: task.assignedTo,
              state: task.state,
            },
          });
          continue;
        }
        const eligibility = evaluateTaskPipelineEligibility({
          task,
          recordState: typeof latest.record_state === 'string' ? latest.record_state : null,
          mode: dispatchMode,
          agent,
        });
        if (eligibility !== 'dispatch') {
          record = this.appendDispatchHistory(record, {
            at: new Date().toISOString(),
            kind: historyKind,
            action: eligibility,
            agentId: agent.agentId,
            sessionId: null,
            recordId,
            bindingId,
            bindingType,
            details: {
              task_id: task.taskId,
              updater_npub: updaterNpub,
              changed_fields: changedFields,
              assigned_to: task.assignedTo,
              state: task.state,
              predecessor_task_ids: task.predecessorTaskIds,
            },
          });
          continue;
        }
        const session = await this.agentWorkRuntime.handleTaskDispatch({
          subscription: record,
          agent,
          recordId,
          recordState: typeof latest.record_state === 'string' ? latest.record_state : null,
          task,
          runtimeContext: profileDecision?.contextText,
        });
        if (session) {
          record = this.appendDispatchHistory(record, {
            at: new Date().toISOString(),
            kind: historyKind,
            action: dispatchModeToAction(dispatchMode),
            agentId: agent.agentId,
            sessionId: session.id,
            recordId,
            bindingId,
            bindingType,
            details: {
              task_id: task.taskId,
              flow_run_id: task.flowRunId,
              flow_id: task.flowId,
              updater_npub: updaterNpub,
              changed_fields: changedFields,
            },
          });
          continue;
        }
        record = this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: historyKind,
          action: dispatchModeToNullSkipAction(dispatchMode),
          agentId: agent.agentId,
          sessionId: null,
          recordId,
          bindingId,
          bindingType,
          details: {
            task_id: task.taskId,
            updater_npub: updaterNpub,
            changed_fields: changedFields,
          },
        });
      }
    } catch (error) {
      console.warn(
        `[agent-work] task advisory failed for subscription ${record.subscriptionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return record;
  }

  private async handleApprovalRecordChanged(
    record: WorkspaceSubscriptionRecord,
    payload: Record<string, unknown>,
  ): Promise<WorkspaceSubscriptionRecord> {
    const recordId = typeof payload.record_id === 'string' ? payload.record_id : '';
    if (!recordId) {
      return record;
    }

    try {
      const versions = await this.loadAdvisoryRecordVersions(record, recordId);
      const [latest, previous] = versions.sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0));
      if (!latest) {
        return record;
      }
      const decrypted = await this.decryptAdvisoryPayload(record, latest);
      const updaterNpub = getRecordUpdaterNpub(latest);
      const approval = normaliseInboundApprovalRecord(decrypted);
      if (!approval?.flowRunId) {
        return this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'approval',
          action: 'approval_skip_invalid_payload',
          agentId: 'dispatch-pipeline',
          sessionId: null,
          recordId,
          bindingId: recordId,
          bindingType: 'flow_run',
          details: {
            reason: 'missing_flow_run_id',
            updater_npub: updaterNpub,
            payload_keys: Object.keys(decrypted).slice(0, 20),
          },
        });
      }
      const profileDecision = this.resolveProfileRuntimeDecision({
        subscription: record,
        eventType: 'approval_assigned',
      });
      if (!profilePolicyAllowsDispatch(profileDecision)) {
        return this.appendProfilePolicySuppression({
          record,
          decision: profileDecision!,
          kind: 'approval',
          recordId,
          bindingId: approval.flowRunId,
          bindingType: 'flow_run',
          details: {
            approval_id: approval.approvalId,
            flow_run_id: approval.flowRunId,
            flow_id: approval.flowId,
            approval_state: approval.state,
            updater_npub: updaterNpub,
          },
        });
      }
      let previousApproval: InboundApprovalRecord | null = null;
      if (previous) {
        try {
          previousApproval = normaliseInboundApprovalRecord(await this.decryptAdvisoryPayload(record, previous));
        } catch {
          previousApproval = null;
        }
      }
      if (String(approval.state || '').toLowerCase() !== 'approved') {
        return this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'approval',
          action: 'approval_dispatch_skip_not_approved',
          agentId: 'dispatch-pipeline',
          sessionId: null,
          recordId,
          bindingId: approval.flowRunId,
          bindingType: 'flow_run',
          details: {
            approval_id: approval.approvalId,
            flow_run_id: approval.flowRunId,
            flow_id: approval.flowId,
            approval_state: approval.state,
            updater_npub: updaterNpub,
          },
        });
      }
      if (String(previousApproval?.state || '').toLowerCase() === 'approved') {
        return this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'approval',
          action: 'approval_dispatch_skip_already_approved',
          agentId: 'dispatch-pipeline',
          sessionId: null,
          recordId,
          bindingId: approval.flowRunId,
          bindingType: 'flow_run',
          details: {
            approval_id: approval.approvalId,
            flow_run_id: approval.flowRunId,
            flow_id: approval.flowId,
            approval_state: approval.state,
            updater_npub: updaterNpub,
          },
        });
      }
      if (!this.dispatchPipelineRuntime) {
        return record;
      }
      const pipelineResult = await this.dispatchPipelineRuntime.dispatch({
        subscription: record,
        triggerKind: 'approval',
        capability: 'approval_dispatch',
        recordId,
        record: latest,
        payload: decrypted,
        recordFamily: 'approval',
        recordState: typeof latest.record_state === 'string' ? latest.record_state : null,
        recordVersion: typeof latest.version === 'number' ? latest.version : Number(latest.version ?? 0),
        updaterNpub,
        bindingType: 'flow_run',
        bindingId: approval.flowRunId,
        changedFields: [],
        groupNpubs: [],
        botIdentity: this.getRuntime(record.subscriptionId)?.botIdentity ?? null,
        profileRuntime: this.buildProfileRuntimeContext(profileDecision),
      });
      if (pipelineResult.handled) {
        return this.applyDispatchPipelineResult(record, pipelineResult);
      }
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'approval',
        action: 'approval_dispatch_skip_runtime_returned_null',
        agentId: 'dispatch-pipeline',
        sessionId: null,
        recordId,
        bindingId: approval.flowRunId,
        bindingType: 'flow_run',
        details: {
          approval_id: approval.approvalId,
          flow_run_id: approval.flowRunId,
          flow_id: approval.flowId,
          updater_npub: updaterNpub,
        },
      });
    } catch (error) {
      console.warn(
        `[agent-work] approval advisory failed for subscription ${record.subscriptionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return record;
  }

  private async handleCommentRecordChanged(
    record: WorkspaceSubscriptionRecord,
    payload: Record<string, unknown>,
  ): Promise<WorkspaceSubscriptionRecord> {
    const recordId = typeof payload.record_id === 'string' ? payload.record_id : '';
    if (!recordId) {
      return record;
    }
    if (shouldSkipExistingCommentAdvisory(record, payload)) {
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: 'comment_skip_existing_record',
        agentId: 'unknown',
        sessionId: null,
        recordId,
        bindingId: recordId,
        bindingType: null,
        details: {
          record_updated_at: payload.updated_at ?? payload.updatedAt ?? null,
          startup_reload_at: record.lastSuccessfulStartupReloadAt,
        },
      });
    }

    try {
      const versions = await this.loadAdvisoryRecordVersions(record, recordId);
      const latest = versions.sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0))[0] ?? null;
      if (!latest) {
        return record;
      }
      if (shouldSkipExistingCommentAdvisory(record, latest)) {
        return this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'comment',
          action: 'comment_skip_existing_record',
          agentId: 'unknown',
          sessionId: null,
          recordId,
          bindingId: recordId,
          bindingType: null,
          details: {
            record_updated_at: latest.updated_at ?? latest.updatedAt ?? null,
            startup_reload_at: record.lastSuccessfulStartupReloadAt,
          },
        });
      }
      record.lastRecordPullResult = buildSuccessDiagnostic('Comment advisory pulled.', {
        record_id: recordId,
        version: typeof latest.version === 'number' ? latest.version : Number(latest.version ?? 0),
        record_state: typeof latest.record_state === 'string' ? latest.record_state : null,
      });

      const decrypted = await this.decryptAdvisoryPayload(record, latest);
      const comment = normaliseInboundCommentRecord(decrypted, latest);
      if (!comment) {
        record.lastDecryptResult = buildFailureDiagnostic(
          'decrypt_failed',
          'Comment routing skipped because the payload could not be normalized.',
          'normalise_failed',
          { record_id: recordId },
        );
        return this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'comment',
          action: 'comment_skip_invalid_payload',
          agentId: 'unknown',
          sessionId: null,
          recordId,
          bindingId: recordId,
          bindingType: null,
          details: {
            payload_keys: Object.keys(decrypted).slice(0, 20),
          },
        });
      }

      record.lastDecryptResult = buildSuccessDiagnostic('Comment advisory decrypted.', {
        record_id: recordId,
        target_record_id: comment.targetRecordId,
        target_record_family_hash: comment.targetRecordFamilyHash,
      });
      const updaterNpub = getRecordUpdaterNpub(latest);

      if (isTaskCommentTarget(comment)) {
        return await this.handleTaskCommentDispatch(record, recordId, latest, comment, updaterNpub);
      }
      if (isDocumentCommentTarget(comment)) {
        return await this.handleDocumentCommentDispatch(record, recordId, latest, comment, updaterNpub);
      }

      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: 'comment_skip_unsupported_target',
        agentId: 'unknown',
        sessionId: null,
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: null,
        details: {
          target_record_family_hash: comment.targetRecordFamilyHash,
          comment_id: comment.commentId,
        },
      });
    } catch (error) {
      console.warn(
        `[agent-comment] comment advisory failed for subscription ${record.subscriptionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return record;
    }
  }

  private async handleTaskCommentDispatch(
    record: WorkspaceSubscriptionRecord,
    recordId: string,
    latest: Record<string, unknown>,
    comment: InboundCommentRecord,
    updaterNpub: string | null,
  ): Promise<WorkspaceSubscriptionRecord> {
    if (await this.isSelfCommentEvent(record, comment, updaterNpub)) {
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: 'task_comment_skip_self_update',
        agentId: 'pipeline',
        sessionId: null,
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'task',
        details: {
          comment_id: comment.commentId,
          updater_npub: updaterNpub,
          sender_npub: comment.senderNpub,
          target_record_family_hash: comment.targetRecordFamilyHash,
          is_me: true,
        },
      });
    }

    const commentAgents = this.listCommentDispatchAgents(record);
    if (commentAgents.length === 0) {
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: 'task_comment_skip_no_comment_dispatch_agent',
        agentId: 'unknown',
        sessionId: null,
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'task',
        details: {
          comment_id: comment.commentId,
          updater_npub: updaterNpub,
          sender_npub: comment.senderNpub,
          target_record_family_hash: comment.targetRecordFamilyHash,
        },
      });
    }

    const managerAuthored = isManagerAuthoredComment(record, comment, updaterNpub);
    const selectedAgents = managerAuthored
      ? commentAgents
      : commentAgents.filter((agent) => commentMentionsAgent(comment, agent));
    if (selectedAgents.length === 0) {
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: 'task_comment_skip_no_agent_mention',
        agentId: 'unknown',
        sessionId: null,
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'task',
        details: {
          comment_id: comment.commentId,
          updater_npub: updaterNpub,
          sender_npub: comment.senderNpub,
          target_record_family_hash: comment.targetRecordFamilyHash,
          eligible_agent_ids: commentAgents.map((agent) => agent.agentId),
          mention_required: true,
        },
      });
    }

    const profileDecision = this.resolveProfileRuntimeDecision({
      subscription: record,
      eventType: 'task_comment',
      builtInDefaultPipelineId: 'agent-dispatch-comment-response',
    });
    if (!profilePolicyAllowsDispatch(profileDecision)) {
      return this.appendProfilePolicySuppression({
        record,
        decision: profileDecision!,
        kind: 'comment',
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'task',
        details: {
          comment_id: comment.commentId,
          updater_npub: updaterNpub,
          sender_npub: comment.senderNpub,
          target_record_family_hash: comment.targetRecordFamilyHash,
        },
      });
    }

    if (this.dispatchPipelineRuntime) {
      const pipelineResult = await this.dispatchPipelineRuntime.dispatch({
        subscription: record,
        triggerKind: 'comment',
        capability: 'comment_dispatch',
        recordId,
        record: latest,
        payload: { ...comment },
        recordFamily: 'comment',
        recordState: comment.recordState,
        recordVersion: typeof latest.version === 'number' ? latest.version : Number(latest.version ?? 0),
        updaterNpub,
        bindingType: 'task',
        bindingId: comment.targetRecordId,
        changedFields: [],
        groupNpubs: extractCommentGroupNpubs(latest),
        botIdentity: this.getRuntime(record.subscriptionId)?.botIdentity ?? null,
        profileRuntime: this.buildProfileRuntimeContext(profileDecision),
      });
      if (pipelineResult.handled) {
        return this.applyDispatchPipelineResult(record, pipelineResult);
      }
    }

    for (const agent of selectedAgents) {
      if (!profilePolicyAllowsLegacyPrompt(profileDecision)) {
        record = this.appendProfilePolicySuppression({
          record,
          decision: profileDecision!,
          kind: 'comment',
          recordId,
          bindingId: comment.targetRecordId,
          bindingType: 'task',
          agentId: agent.agentId,
          details: {
            comment_id: comment.commentId,
            updater_npub: updaterNpub,
            sender_npub: comment.senderNpub,
            target_record_family_hash: comment.targetRecordFamilyHash,
          },
        });
        continue;
      }
      if (isSelfCommentAuthor(record, agent, comment, updaterNpub)) {
        record = this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'comment',
          action: 'task_comment_skip_self_update',
          agentId: agent.agentId,
          sessionId: null,
          recordId,
          bindingId: comment.targetRecordId,
          bindingType: 'task',
          details: {
            comment_id: comment.commentId,
            updater_npub: updaterNpub,
            sender_npub: comment.senderNpub,
            target_record_family_hash: comment.targetRecordFamilyHash,
          },
        });
        continue;
      }
      const decision = this.commentDispatchRuntime?.handleDisabledDispatch({
        target: 'task',
        agent,
        comment,
        updaterNpub,
      });
      record = this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: decision?.action ?? 'task_comment_dispatch_disabled',
        agentId: agent.agentId,
        sessionId: null,
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'task',
        details: decision?.details ?? {
          comment_id: comment.commentId,
          updater_npub: updaterNpub,
          sender_npub: comment.senderNpub,
          target_record_family_hash: comment.targetRecordFamilyHash,
          disabled_reason: 'comment_dispatch_stubbed',
        },
      });
    }
    return this.saveRecord(this.recomputeHealth(record));
  }

  private async handleDocumentCommentDispatch(
    record: WorkspaceSubscriptionRecord,
    recordId: string,
    latest: Record<string, unknown>,
    comment: InboundCommentRecord,
    updaterNpub: string | null,
  ): Promise<WorkspaceSubscriptionRecord> {
    if (await this.isSelfCommentEvent(record, comment, updaterNpub)) {
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: 'document_comment_skip_self_update',
        agentId: 'pipeline',
        sessionId: null,
        recordId,
        bindingId: comment.parentCommentId ?? comment.commentId,
        bindingType: 'thread',
        details: {
          comment_id: comment.commentId,
          updater_npub: updaterNpub,
          sender_npub: comment.senderNpub,
          target_record_id: comment.targetRecordId,
          target_record_family_hash: comment.targetRecordFamilyHash,
          is_me: true,
        },
      });
    }

    const agents = this.listDocumentCommentAgents(record, latest);
    if (agents.length === 0) {
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: 'document_comment_skip_no_comment_dispatch_agent',
        agentId: 'unknown',
        sessionId: null,
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'document',
        details: {
          comment_id: comment.commentId,
          target_record_id: comment.targetRecordId,
        },
      });
    }

    const managerAuthored = isManagerAuthoredComment(record, comment, updaterNpub);
    const selectedAgents = managerAuthored
      ? agents
      : agents.filter((agent) => commentMentionsAgent(comment, agent));
    if (selectedAgents.length === 0) {
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: 'document_comment_skip_no_agent_mention',
        agentId: 'unknown',
        sessionId: null,
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'document',
        details: {
          comment_id: comment.commentId,
          target_record_id: comment.targetRecordId,
          target_record_family_hash: comment.targetRecordFamilyHash,
          eligible_agent_ids: agents.map((agent) => agent.agentId),
          mention_required: true,
        },
      });
    }

    const profileDecision = this.resolveProfileRuntimeDecision({
      subscription: record,
      eventType: 'document_comment_tagged',
      builtInDefaultPipelineId: 'agent-dispatch-comment-response',
    });
    if (!profilePolicyAllowsDispatch(profileDecision)) {
      return this.appendProfilePolicySuppression({
        record,
        decision: profileDecision!,
        kind: 'comment',
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'document',
        details: {
          comment_id: comment.commentId,
          target_record_id: comment.targetRecordId,
          target_record_family_hash: comment.targetRecordFamilyHash,
          updater_npub: updaterNpub,
        },
      });
    }

    if (this.dispatchPipelineRuntime) {
      const pipelineResult = await this.dispatchPipelineRuntime.dispatch({
        subscription: record,
        triggerKind: 'comment',
        capability: 'comment_dispatch',
        recordId,
        record: latest,
        payload: { ...comment },
        recordFamily: 'comment',
        recordState: comment.recordState,
        recordVersion: typeof latest.version === 'number' ? latest.version : Number(latest.version ?? 0),
        updaterNpub,
        bindingType: 'document',
        bindingId: comment.targetRecordId,
        changedFields: [],
        groupNpubs: extractCommentGroupNpubs(latest),
        botIdentity: this.getRuntime(record.subscriptionId)?.botIdentity ?? null,
        profileRuntime: this.buildProfileRuntimeContext(profileDecision),
      });
      if (pipelineResult.handled) {
        return this.applyDispatchPipelineResult(record, pipelineResult);
      }
    }

    for (const agent of selectedAgents) {
      if (!profilePolicyAllowsLegacyPrompt(profileDecision)) {
        record = this.appendProfilePolicySuppression({
          record,
          decision: profileDecision!,
          kind: 'comment',
          recordId,
          bindingId: comment.targetRecordId,
          bindingType: 'document',
          agentId: agent.agentId,
          details: {
            comment_id: comment.commentId,
            updater_npub: updaterNpub,
            target_record_id: comment.targetRecordId,
            target_record_family_hash: comment.targetRecordFamilyHash,
          },
        });
        continue;
      }
      if (isSelfCommentAuthor(record, agent, comment, updaterNpub)) {
        record = this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'comment',
          action: 'document_comment_skip_self_update',
          agentId: agent.agentId,
          sessionId: null,
          recordId,
          bindingId: comment.targetRecordId,
          bindingType: 'document',
          details: {
            comment_id: comment.commentId,
            updater_npub: updaterNpub,
            target_record_id: comment.targetRecordId,
          },
        });
        continue;
      }
      const decision = this.commentDispatchRuntime?.handleDisabledDispatch({
        target: 'document',
        agent,
        comment,
        updaterNpub,
      });
      record = this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: decision?.action ?? 'document_comment_dispatch_disabled',
        agentId: agent.agentId,
        sessionId: null,
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'document',
        details: decision?.details ?? {
          comment_id: comment.commentId,
          updater_npub: updaterNpub,
          sender_npub: comment.senderNpub,
          target_record_id: comment.targetRecordId,
          target_record_family_hash: comment.targetRecordFamilyHash,
          disabled_reason: 'comment_dispatch_stubbed',
        },
      });
    }
    return this.saveRecord(this.recomputeHealth(record));
  }

  private stopRuntime(subscriptionId: string, removed: boolean): void {
    const runtime = this.runtimes.get(subscriptionId);
    if (!runtime) {
      return;
    }
    runtime.removed = removed;
    runtime.abortController?.abort();
    runtime.abortController = null;
    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
    }
    if (removed) {
      runtime.botIdentity.botSecret.fill(0);
    }
  }

  private async repairSubscription(
    record: WorkspaceSubscriptionRecord,
    options: {
      refreshWorkspaceKey: boolean;
      reconnect: boolean;
      allowRegisterWhenInactive: boolean;
      reason: string;
    },
  ): Promise<WorkspaceSubscriptionRecord> {
    const botIdentity = this.resolveStoredBotIdentity(record.botNpub);
    if (!botIdentity) {
      throw new Error(`Bot key record not found for ${record.botNpub}.`);
    }

    const prepared = await this.prepareWorkspaceSession(record, botIdentity, {
      forceNew: options.refreshWorkspaceKey,
    });

    let next = prepared;
    if (options.refreshWorkspaceKey || (options.allowRegisterWhenInactive && prepared.wsKeyStatus !== 'active')) {
      next = await this.registerWorkspaceKey(prepared, botIdentity);
      this.clearRuntimeFailure(next.subscriptionId, `${options.reason}_workspace_key_registered`);
    }

    next = await this.refreshGroupKeys(next, botIdentity, false);
    if (options.reconnect) {
      await this.ensureConnected(next, botIdentity, false);
    }

    await this.replayPendingIntercepts(next, botIdentity);

    const latest = this.store.getBySubscriptionId(record.subscriptionId) ?? next;
    this.clearRuntimeFailure(latest.subscriptionId, options.reason);
    return latest;
  }

  private async replayPendingIntercepts(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
  ): Promise<void> {
    if (!this.chatRuntime) {
      return;
    }

    const runtime = this.runtimes.get(record.subscriptionId);
    if (!runtime || !runtime.wsSession) {
      return;
    }

    const pendingIntercepts = this.routingEvaluator
      .listInterceptsForSubscription(record.subscriptionId)
      .filter((intercept) => this.shouldReplayPendingIntercept(intercept));

    if (pendingIntercepts.length === 0) {
      return;
    }

    const helpers = await loadYokeBotHelpers();
    if (!runtime.groupKeys && runtime.wrappedKeyRows.length > 0) {
      runtime.groupKeys = helpers.loadBotGroupKeys({
        wsSession: runtime.wsSession!,
        botSecret: botIdentity.botSecret,
        botNpub: botIdentity.botNpub,
        keyRows: runtime.wrappedKeyRows,
      });
    }

    for (const intercept of pendingIntercepts) {
      const agent = this.agentStore.getByAgentId(intercept.agentId);
      if (!agent || !agent.enabled) {
        continue;
      }
      const messageId = intercept.lastMessageIdSeen;
      if (!messageId) {
        continue;
      }

      try {
        const versions = await fetchRecordHistory(
          record.backendBaseUrl,
          this.getEffectiveWorkspaceNpub(record),
          messageId,
          runtime.wsSession!,
        );
        const latest = versions.sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0))[0];
        if (!latest) {
          continue;
        }
        const chatMessage = helpers.decryptChatRecord({
          record: latest,
          wsSession: runtime.wsSession!,
          groupKeys: runtime.groupKeys,
        });
        if (chatMessage?.sender_npub === agent.botNpub) {
          chatInterceptStateStore.save({
            ...intercept,
            state: 'idle',
            lastDecision: 'respond',
            pendingMessageCount: 0,
            lastActivityAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          continue;
        }
        void this.chatRuntime.handleRoutedChat({
          agent,
          subscription: record,
          intercept,
          botIdentity,
          chatMessage,
        }).catch((runtimeError) => {
          console.warn(
            `[agent-chat] pending-turn replay failed for ${intercept.routingKey}: ${
              runtimeError instanceof Error ? runtimeError.message : String(runtimeError)
            }`,
          );
        });
      } catch (error) {
        console.warn(
          `[agent-chat] failed to reload pending turn ${messageId} for ${intercept.routingKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private shouldReplayPendingIntercept(intercept: ChatInterceptStateRecord): boolean {
    if (!intercept.lastMessageIdSeen) {
      return false;
    }
    if (intercept.lastDecision !== 'pending') {
      return false;
    }
    return intercept.state === 'idle'
      || intercept.state === 'pending'
      || intercept.state === 'active'
      || intercept.state === 'interrupting'
      || intercept.state === 'interrupt_failed';
  }

  private async isSelfCommentEvent(
    record: WorkspaceSubscriptionRecord,
    comment: InboundCommentRecord,
    updaterNpub: string | null,
  ): Promise<boolean> {
    if (isSelfCommentEvent(record, comment, updaterNpub)) {
      return true;
    }

    const senderNpub = comment.senderNpub ?? null;
    if (!senderNpub || !updaterNpub || senderNpub !== updaterNpub) {
      return false;
    }

    const resolvedOwner = await this.resolveWorkspaceKeyOwnerNpub(record, senderNpub);
    return resolvedOwner === record.botNpub;
  }

  private async resolveWorkspaceKeyOwnerNpub(
    record: WorkspaceSubscriptionRecord,
    workspaceKeyNpub: string,
  ): Promise<string | null> {
    const cacheKey = `${record.subscriptionId}:${this.getEffectiveWorkspaceNpub(record)}`;
    const now = Date.now();
    const cached = this.workspaceKeyOwnerCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < WORKSPACE_KEY_MAPPING_CACHE_MS) {
      return cached.owners.get(workspaceKeyNpub) ?? null;
    }

    const runtime = this.runtimes.get(record.subscriptionId);
    if (!runtime?.wsSession) {
      return cached?.owners.get(workspaceKeyNpub) ?? null;
    }

    try {
      const mappings = await this.fetchWorkspaceKeyMappingsImpl(
        record.backendBaseUrl,
        this.getEffectiveWorkspaceNpub(record),
        runtime.wsSession!,
      );
      const owners = new Map<string, string>();
      for (const mapping of mappings) {
        if (typeof mapping?.ws_key_npub === 'string' && typeof mapping?.user_npub === 'string') {
          owners.set(mapping.ws_key_npub, mapping.user_npub);
        }
      }
      this.workspaceKeyOwnerCache.set(cacheKey, { fetchedAt: now, owners });
      return owners.get(workspaceKeyNpub) ?? null;
    } catch (error) {
      if (!cached) {
        this.workspaceKeyOwnerCache.set(cacheKey, { fetchedAt: now, owners: new Map() });
      }
      return cached?.owners.get(workspaceKeyNpub) ?? null;
    }
  }

  private getRuntime(subscriptionId: string): RuntimeContext {
    const runtime = this.runtimes.get(subscriptionId);
    if (!runtime) {
      throw new Error(`Missing runtime for subscription ${subscriptionId}`);
    }
    return runtime;
  }

  private unlockBotIdentity(botRecord: BotKeyStoreRecord): RuntimeBotIdentity {
    return {
      botNpub: botRecord.botNpub,
      botPubkeyHex: botRecord.botPubkeyHex,
      botSecret: unlockViaEscrow(botRecord.encryptedEscrow, botRecord.botPubkeyHex, botRecord.escrowUuid),
    };
  }

  private saveRecord(record: WorkspaceSubscriptionRecord): WorkspaceSubscriptionRecord {
    record.updatedAt = new Date().toISOString();
    return this.store.save(record);
  }

  private appendDispatchHistory(
    record: WorkspaceSubscriptionRecord,
    entry: AgentChatDispatchHistoryEntry,
  ): WorkspaceSubscriptionRecord {
    record.recentDispatches = trimRecentEntries(
      [...(Array.isArray(record.recentDispatches) ? record.recentDispatches : []), entry],
      MAX_RECENT_DISPATCHES,
    );
    return this.saveRecord(record);
  }

  private applyDispatchPipelineResult(
    record: WorkspaceSubscriptionRecord,
    result: DispatchPipelineRuntimeResult,
  ): WorkspaceSubscriptionRecord {
    for (const entry of result.historyEntries) {
      record = this.appendDispatchHistory(record, entry);
    }
    if (result.lastPipelineRunId) {
      record.lastPipelineRunId = result.lastPipelineRunId;
      return this.saveRecord(record);
    }
    return record;
  }

  private markRuntimeFailure(subscriptionId: string, detailCode: string | null, reason: string): void {
    const state = mapFailureState(detailCode);
    if (!state || !this.chatRuntime) {
      return;
    }
    this.chatRuntime.markSubscriptionBlocked(subscriptionId, state, reason);
  }

  private clearRuntimeFailure(subscriptionId: string, reason: string): void {
    if (!this.chatRuntime) {
      return;
    }
    this.chatRuntime.clearSubscriptionBlocked(subscriptionId, reason);
  }

  private recomputeHealth(record: WorkspaceSubscriptionRecord): WorkspaceSubscriptionRecord {
    if (record.wsKeyStatus === 'revoked' || record.wsKeyStatus === 'failed') {
      record.healthStatus = 'unhealthy';
      return record;
    }
    if (record.groupKeyStatus === 'failed' || record.sseStatus === 'backoff' || record.groupKeyStatus === 'refresh_required') {
      record.healthStatus = 'degraded';
      return record;
    }
    if (record.sseStatus === 'connected' && record.wsKeyStatus === 'active' && record.groupKeyStatus === 'active') {
      record.healthStatus = 'healthy';
      return record;
    }
    record.healthStatus = 'degraded';
    return record;
  }

  private async resolveAgentGroupNpubs(input: {
    requestedGroupNpubs: string[];
    workspaceOwnerNpub: string;
    botNpub: string;
    managedByNpub: string;
  }): Promise<string[]> {
    if (input.requestedGroupNpubs.length > 0) {
      return input.requestedGroupNpubs;
    }

    const subscription = this.store
      .listForManagerNpub(input.managedByNpub)
      .find((record) => (
        this.getEffectiveWorkspaceNpub(record) === input.workspaceOwnerNpub
        && record.botNpub === input.botNpub
      ));
    const cachedGroupNpubs = subscription ? this.deriveGroupNpubsFromSubscription(subscription) : [];
    if (cachedGroupNpubs.length > 0) {
      return cachedGroupNpubs;
    }

    if (!subscription) {
      return [];
    }

    await this.repairSubscription(subscription, {
      refreshWorkspaceKey: false,
      reconnect: subscription.sseStatus !== 'disabled',
      allowRegisterWhenInactive: true,
      reason: 'agent_create_refresh_groups',
    });
    const refreshed = this.store.getBySubscriptionId(subscription.subscriptionId) ?? subscription;
    return this.deriveGroupNpubsFromSubscription(refreshed);
  }
}
