import { unlockViaEscrow } from '../identity/bot-key-manager';
import { AgentWorkSessionRuntime, normaliseInboundApprovalRecord, normaliseInboundTaskRecord } from '../agent-work/session-runtime';
import { agentDefinitionStore, type AgentDefinitionStore } from './agent-definition-store';
import { AgentCommentSessionRuntime } from './comment-session-runtime';
import {
  isDocumentCommentTarget,
  isTaskCommentTarget,
  normaliseInboundCommentRecord,
  selectDocumentCommentAgents,
} from './comment-records';
import { AgentChatRoutingEvaluator } from './routing-evaluator';
import type { AgentChatSessionRuntime } from './session-runtime';
import { workspaceSubscriptionStore, type WorkspaceSubscriptionStore } from './workspace-subscription-store';
import { parseSseEvents } from './sse-events';
import { chatInterceptStateStore } from './chat-intercept-state-store';
import {
  buildChatMessageFamilyHash,
  buildRecordFamilyHash,
  buildFailureDiagnostic,
  buildStreamUrl,
  buildSuccessDiagnostic,
  fetchRecordHistory,
  normaliseBackendBaseUrl,
  parseTowerError,
  registerWorkspaceKeyWithTower,
} from './tower-client';
import { loadYokeBotHelpers } from './yoke-bot-helpers';
import { decryptRecordPayloadWithYoke } from './yoke-record-payload';
import {
  DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE,
  normalisePromptTemplate,
} from './prompt-templates';
import type {
  AgentChatDispatchHistoryEntry,
  AgentChatSseEventDiagnostic,
  AgentDefinitionRecord,
  BotKeyStoreRecord,
  ChatInterceptStateRecord,
  CreateAgentDefinitionInput,
  CreateWorkspaceSubscriptionInput,
  InboundCommentRecord,
  InboundTaskRecord,
  RuntimeBotIdentity,
  WorkspaceSubscriptionRecord,
  YokeWorkspaceSession,
} from './types';
import { evaluateTaskDispatchEligibility } from '../agent-work/session-runtime';

interface RuntimeContext {
  abortController: AbortController | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  botIdentity: RuntimeBotIdentity;
  wsSession: YokeWorkspaceSession;
  groupKeys: unknown | null;
  wrappedKeyRows: unknown[];
  removed: boolean;
}

type RuntimeFailureState = 'blocked_auth' | 'blocked_decrypt' | null;
const MAX_RECENT_SSE_EVENTS = 100;
const MAX_RECENT_DISPATCHES = 10;

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

export interface WorkspaceSubscriptionManagerDependencies {
  store?: WorkspaceSubscriptionStore;
  agentStore?: AgentDefinitionStore;
  routingEvaluator?: AgentChatRoutingEvaluator;
  chatRuntime?: AgentChatSessionRuntime | null;
  agentWorkRuntime?: AgentWorkSessionRuntime | null;
  agentCommentRuntime?: AgentCommentSessionRuntime | null;
  fetchRecordHistory?: typeof fetchRecordHistory;
  decryptRecordPayload?: typeof decryptRecordPayloadWithYoke;
  botKeyStore: {
    getActiveKeyForUser: (npub: string) => BotKeyStoreRecord | null;
    getActiveKeyForBotNpub: (botNpub: string) => BotKeyStoreRecord | null;
  };
}

function getErrorDetailCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const detailCode = (error as { detailCode?: unknown }).detailCode;
  return typeof detailCode === 'string' && detailCode.trim().length > 0 ? detailCode.trim() : null;
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

export class WorkspaceSubscriptionManager {
  private readonly store: WorkspaceSubscriptionStore;
  private readonly agentStore: AgentDefinitionStore;
  private readonly routingEvaluator: AgentChatRoutingEvaluator;
  private readonly botKeyStore: WorkspaceSubscriptionManagerDependencies['botKeyStore'];
  private chatRuntime: AgentChatSessionRuntime | null;
  private agentWorkRuntime: AgentWorkSessionRuntime | null;
  private agentCommentRuntime: AgentCommentSessionRuntime | null;
  private readonly fetchRecordHistoryImpl: typeof fetchRecordHistory;
  private readonly decryptRecordPayloadImpl: typeof decryptRecordPayloadWithYoke;
  private readonly runtimes = new Map<string, RuntimeContext>();

  constructor(deps: WorkspaceSubscriptionManagerDependencies) {
    this.store = deps.store ?? workspaceSubscriptionStore;
    this.agentStore = deps.agentStore ?? agentDefinitionStore;
    this.routingEvaluator = deps.routingEvaluator ?? new AgentChatRoutingEvaluator({ agentStore: this.agentStore });
    this.botKeyStore = deps.botKeyStore;
    this.chatRuntime = deps.chatRuntime ?? null;
    this.agentWorkRuntime = deps.agentWorkRuntime ?? null;
    this.agentCommentRuntime = deps.agentCommentRuntime ?? null;
    this.fetchRecordHistoryImpl = deps.fetchRecordHistory ?? fetchRecordHistory;
    this.decryptRecordPayloadImpl = deps.decryptRecordPayload ?? decryptRecordPayloadWithYoke;
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

  getAgentForManager(agentId: string, npub: string): AgentDefinitionRecord | null {
    const record = this.agentStore.getByAgentId(agentId);
    return record?.managedByNpub === npub ? record : null;
  }

  listAgentsForWorkspaceBot(workspaceOwnerNpub: string, botNpub: string, npub: string): AgentDefinitionRecord[] {
    return this.agentStore
      .listByWorkspaceAndBot(workspaceOwnerNpub, botNpub)
      .filter((record) => record.managedByNpub === npub);
  }

  listInterceptsForSubscription(subscriptionId: string, npub: string) {
    const record = this.getForManager(subscriptionId, npub);
    if (!record) {
      return [];
    }
    return this.routingEvaluator.listInterceptsForSubscription(subscriptionId);
  }

  private normaliseAgentCapabilities(capabilities?: string[]): Array<'chat_intercept' | 'task_dispatch'> {
    const set = new Set<'chat_intercept' | 'task_dispatch'>();
    for (const capability of capabilities ?? []) {
      if (capability === 'chat_intercept' || capability === 'task_dispatch') {
        set.add(capability);
      }
    }
    return set.size > 0 ? [...set] : ['chat_intercept'];
  }

  saveAgentForManager(input: CreateAgentDefinitionInput): AgentDefinitionRecord {
    const agentId = input.agentId.trim();
    const label = input.label.trim() || agentId;
    const botNpub = input.botNpub.trim();
    const workspaceOwnerNpub = input.workspaceOwnerNpub.trim();
    const workingDirectory = input.workingDirectory.trim();
    const requestedGroupNpubs = [...new Set(input.groupNpubs.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
    const groupNpubs = requestedGroupNpubs.length > 0
      ? requestedGroupNpubs
      : this.deriveAgentGroupNpubs(workspaceOwnerNpub, botNpub);
    const capabilities = this.normaliseAgentCapabilities(input.capabilities);
    const chatPromptTemplate = normalisePromptTemplate(input.chatPromptTemplate, DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE);
    const taskPromptTemplate = normalisePromptTemplate(input.taskPromptTemplate, DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE);

    if (!agentId || !botNpub || !workspaceOwnerNpub || !workingDirectory) {
      throw new Error('agentId, botNpub, workspaceOwnerNpub, and workingDirectory are required.');
    }
    if (groupNpubs.length === 0) {
      throw new Error('At least one group npub is required, or a healthy subscription must already have refreshed readable bot group keys.');
    }

    const existing = this.agentStore.getByAgentId(agentId);
    if (existing && existing.managedByNpub && existing.managedByNpub !== input.managedByNpub) {
      throw new Error(`Agent ${agentId} is owned by another manager.`);
    }

    const now = new Date().toISOString();
    return this.agentStore.save({
      agentId,
      label,
      botNpub,
      workspaceOwnerNpub,
      groupNpubs,
      workingDirectory,
      capabilities,
      chatPromptTemplate,
      taskPromptTemplate,
      enabled: input.enabled !== false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      managedByNpub: input.managedByNpub,
    });
  }

  removeAgentForManager(agentId: string, npub: string): boolean {
    const record = this.getAgentForManager(agentId, npub);
    if (!record) {
      return false;
    }
    return this.agentStore.delete(agentId);
  }

  async createOrUpdate(input: CreateWorkspaceSubscriptionInput): Promise<WorkspaceSubscriptionRecord> {
    const backendBaseUrl = normaliseBackendBaseUrl(input.backendBaseUrl);
    const botRecord = this.botKeyStore.getActiveKeyForUser(input.managedByNpub);
    if (!botRecord) {
      throw new Error('No active bot key exists for this user.');
    }

    const botIdentity = this.unlockBotIdentity(botRecord);
    let record = this.store.getByWorkspaceAndBot(input.workspaceOwnerNpub, botIdentity.botNpub)
      ?? this.store.createDefault({
        managedByNpub: input.managedByNpub,
        workspaceOwnerNpub: input.workspaceOwnerNpub,
        backendBaseUrl,
        botNpub: botIdentity.botNpub,
        sourceAppNpub: input.sourceAppNpub,
        triggerConfigRecordId: input.triggerConfigRecordId ?? null,
      });

    record.backendBaseUrl = backendBaseUrl;
    record.sourceAppNpub = input.sourceAppNpub;
    record.triggerConfigRecordId = input.triggerConfigRecordId ?? null;
    record.managedByNpub = input.managedByNpub;
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
    return this.store.getBySubscriptionId(record.subscriptionId) ?? record;
  }

  async startupReload(): Promise<void> {
    const records = this.store.listStartupCandidates();
    for (const record of records) {
      try {
        const botRecord = this.botKeyStore.getActiveKeyForBotNpub(record.botNpub);
        if (!botRecord) {
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

        const botIdentity = this.unlockBotIdentity(botRecord);
        const prepared = await this.prepareWorkspaceSession(record, botIdentity);
        const refreshed = await this.refreshGroupKeys(prepared, botIdentity, false);
        refreshed.lastSuccessfulStartupReloadAt = new Date().toISOString();
        this.saveRecord(refreshed);
        this.clearRuntimeFailure(refreshed.subscriptionId, 'startup_reload_recovered');
        await this.ensureConnected(refreshed, botIdentity, true);
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
    return this.store.delete(subscriptionId);
  }

  async reconnectForManager(subscriptionId: string, npub: string): Promise<WorkspaceSubscriptionRecord | null> {
    const record = this.getForManager(subscriptionId, npub);
    if (!record) {
      return null;
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
        workspaceOwnerNpub: record.workspaceOwnerNpub,
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
      removed: false,
    });
    return this.saveRecord(nextRecord);
  }

  private async registerWorkspaceKey(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
  ): Promise<WorkspaceSubscriptionRecord> {
    const helpers = await loadYokeBotHelpers();
    const attempt = async (current: WorkspaceSubscriptionRecord) => {
      const authorization = helpers.signBotRequest({
        botSecret: botIdentity.botSecret,
        botNpub: botIdentity.botNpub,
        url: new URL('/api/v4/user/workspace-keys', current.backendBaseUrl).toString(),
        method: 'POST',
        body: {
          workspace_owner_npub: current.workspaceOwnerNpub,
          ws_key_npub: current.wsKeyNpub,
        },
      });
      await registerWorkspaceKeyWithTower({
        backendBaseUrl: current.backendBaseUrl,
        workspaceOwnerNpub: current.workspaceOwnerNpub,
        wsKeyNpub: current.wsKeyNpub!,
        authorization,
      });
      current.wsKeyStatus = 'active';
      current.lastAuthOkAt = new Date().toISOString();
      current.lastAuthResult = buildSuccessDiagnostic('Workspace key registered.', {
        workspace_owner_npub: current.workspaceOwnerNpub,
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
        wsSession: runtime.wsSession,
        backendBaseUrl: record.backendBaseUrl,
      });
      runtime.wrappedKeyRows = keyRows;
      runtime.groupKeys = helpers.loadBotGroupKeys({
        wsSession: runtime.wsSession,
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
            wsSession: runtime.wsSession,
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

  private async runSseLoop(subscriptionId: string, signal: AbortSignal, isStartupReload: boolean): Promise<void> {
    const runtime = this.getRuntime(subscriptionId);
    let record = this.store.getBySubscriptionId(subscriptionId);
    if (!record) {
      return;
    }
    try {
      const streamUrl = await buildStreamUrl(
        record.backendBaseUrl,
        record.workspaceOwnerNpub,
        runtime.wsSession,
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
    try {
      payload = eventData ? JSON.parse(eventData) as Record<string, unknown> : null;
    } catch {
      payload = { raw: eventData };
    }
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
      return await this.handleChatMessageRecordChanged(record, payload);
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

    return record;
  }

  private async handleChatMessageRecordChanged(
    record: WorkspaceSubscriptionRecord,
    payload: Record<string, unknown>,
  ): Promise<WorkspaceSubscriptionRecord> {
    const recordId = typeof payload.record_id === 'string' ? payload.record_id : '';
    if (!recordId) {
      return record;
    }

    const runtime = this.getRuntime(record.subscriptionId);
    try {
      const versions = await fetchRecordHistory(
        record.backendBaseUrl,
        record.workspaceOwnerNpub,
        recordId,
        runtime.wsSession,
      );
      const latest = versions.sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0))[0];
      if (!latest) {
        throw Object.assign(new Error(`Record ${recordId} not found.`), { detailCode: 'record_pull_not_found' });
      }
      record.lastRecordPullResult = buildSuccessDiagnostic('Chat message advisory pulled.', {
        record_id: recordId,
        version: typeof latest.version === 'number' ? latest.version : Number(latest.version ?? 0),
        record_state: typeof latest.record_state === 'string' ? latest.record_state : null,
      });
      const helpers = await loadYokeBotHelpers();
      if (!runtime.groupKeys && runtime.wrappedKeyRows.length > 0) {
        runtime.groupKeys = helpers.loadBotGroupKeys({
          wsSession: runtime.wsSession,
          botSecret: runtime.botIdentity.botSecret,
          botNpub: runtime.botIdentity.botNpub,
          keyRows: runtime.wrappedKeyRows,
        });
      }
      try {
        const chatMessage = helpers.decryptChatRecord({
          record: latest,
          wsSession: runtime.wsSession,
          groupKeys: runtime.groupKeys,
        });
        record.lastDecryptResult = buildSuccessDiagnostic('Chat message pulled and decrypted.', {
          record_id: recordId,
          channel_id: chatMessage.channel_id ?? null,
        });
        const routingResult = await this.routingEvaluator.evaluate({
          subscription: record,
          wsSession: runtime.wsSession,
          groupKeys: runtime.groupKeys,
          chatRecordId: recordId,
          chatRecord: latest,
          chatMessage,
        });
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
      record.groupKeyStatus = 'refresh_required';
      record.lastErrorCode = 'decrypt_failed';
      record.lastErrorAt = new Date().toISOString();
      record.lastRecordPullResult = buildFailureDiagnostic(
        'record_pull_failed',
        error instanceof Error ? error.message : 'Record pull failed.',
        detailCode,
        { record_id: recordId },
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
    }
    return this.saveRecord(this.recomputeHealth(record));
  }

  private listTaskDispatchAgents(subscription: WorkspaceSubscriptionRecord): AgentDefinitionRecord[] {
    return this.agentStore
      .listByWorkspaceAndBot(subscription.workspaceOwnerNpub, subscription.botNpub)
      .filter((agent) => agent.enabled && agent.capabilities.includes('task_dispatch'))
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
  }

  private listDocumentCommentAgents(
    subscription: WorkspaceSubscriptionRecord,
    commentRecord: Record<string, unknown>,
  ): AgentDefinitionRecord[] {
    return selectDocumentCommentAgents({
      subscription,
      commentRecord,
      agents: this.agentStore.listByWorkspaceAndBot(subscription.workspaceOwnerNpub, subscription.botNpub),
    });
  }

  private async loadAdvisoryRecordVersions(
    subscription: WorkspaceSubscriptionRecord,
    recordId: string,
  ): Promise<Record<string, unknown>[]> {
    const runtime = this.getRuntime(subscription.subscriptionId);
    return await this.fetchRecordHistoryImpl(
      subscription.backendBaseUrl,
      subscription.workspaceOwnerNpub,
      recordId,
      runtime.wsSession,
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
        wsSession: runtime.wsSession,
        botSecret: runtime.botIdentity.botSecret,
        botNpub: runtime.botIdentity.botNpub,
        keyRows: runtime.wrappedKeyRows,
      });
    }
    return await this.decryptRecordPayloadImpl({
      record: latest,
      wsSession: runtime.wsSession,
      groupKeys: runtime.groupKeys,
    });
  }

  private async handleTaskRecordChanged(
    record: WorkspaceSubscriptionRecord,
    payload: Record<string, unknown>,
  ): Promise<WorkspaceSubscriptionRecord> {
    if (!this.agentWorkRuntime) {
      return record;
    }
    const taskAgents = this.listTaskDispatchAgents(record);
    if (taskAgents.length === 0) {
      return record;
    }

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
          agentId: taskAgents[0]?.agentId ?? 'unknown',
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
      for (const agent of taskAgents) {
        if (isSelfUpdater(record, agent, updaterNpub) && !changedFields.includes('new_task') && changedFields.length === 0) {
          record = this.appendDispatchHistory(record, {
            at: new Date().toISOString(),
            kind: 'task',
            action: 'task_skip_self_update',
            agentId: agent.agentId,
            sessionId: null,
            recordId,
            bindingId: task.flowRunId ?? task.taskId,
            bindingType: task.flowRunId ? 'flow_run' : 'task',
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
        const eligibility = evaluateTaskDispatchEligibility({
          task,
          recordState: typeof latest.record_state === 'string' ? latest.record_state : null,
          agent,
        });
        if (eligibility !== 'dispatch') {
          record = this.appendDispatchHistory(record, {
            at: new Date().toISOString(),
            kind: 'task',
            action: eligibility,
            agentId: agent.agentId,
            sessionId: null,
            recordId,
            bindingId: task.flowRunId ?? task.taskId,
            bindingType: task.flowRunId ? 'flow_run' : 'task',
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
        });
        if (session) {
          record = this.appendDispatchHistory(record, {
            at: new Date().toISOString(),
            kind: 'task',
            action: 'task_dispatch',
            agentId: agent.agentId,
            sessionId: session.id,
            recordId,
            bindingId: task.flowRunId ?? task.taskId,
            bindingType: task.flowRunId ? 'flow_run' : 'task',
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
          kind: 'task',
          action: 'task_skip_runtime_returned_null',
          agentId: agent.agentId,
          sessionId: null,
          recordId,
          bindingId: task.flowRunId ?? task.taskId,
          bindingType: task.flowRunId ? 'flow_run' : 'task',
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
    if (!this.agentWorkRuntime) {
      return record;
    }
    const taskAgents = this.listTaskDispatchAgents(record);
    if (taskAgents.length === 0) {
      return record;
    }

    const recordId = typeof payload.record_id === 'string' ? payload.record_id : '';
    if (!recordId) {
      return record;
    }

    try {
      const versions = await this.loadAdvisoryRecordVersions(record, recordId);
      const latest = versions.sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0))[0] ?? null;
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
          agentId: taskAgents[0]?.agentId ?? 'unknown',
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
      for (const agent of taskAgents) {
        if (isSelfUpdater(record, agent, updaterNpub)) {
          record = this.appendDispatchHistory(record, {
            at: new Date().toISOString(),
            kind: 'approval',
            action: 'approval_skip_self_update',
            agentId: agent.agentId,
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
          continue;
        }
        const session = await this.agentWorkRuntime.handleApprovalDispatch({
          subscription: record,
          agent,
          recordId,
          approval,
        });
        if (session) {
          record = this.appendDispatchHistory(record, {
            at: new Date().toISOString(),
            kind: 'approval',
            action: 'approval_requeue',
            agentId: agent.agentId,
            sessionId: session.id,
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
          continue;
        }
        record = this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'approval',
          action: 'approval_skip_no_live_flow_session',
          agentId: agent.agentId,
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
      }
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

    try {
      const versions = await this.loadAdvisoryRecordVersions(record, recordId);
      const latest = versions.sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0))[0] ?? null;
      if (!latest) {
        return record;
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
    _latest: Record<string, unknown>,
    comment: InboundCommentRecord,
    updaterNpub: string | null,
  ): Promise<WorkspaceSubscriptionRecord> {
    if (!this.agentWorkRuntime) {
      return record;
    }

    const taskAgents = this.listTaskDispatchAgents(record);
    if (taskAgents.length === 0) {
      return record;
    }

    const runtime = this.getRuntime(record.subscriptionId);
    for (const agent of taskAgents) {
      if (isSelfUpdater(record, agent, updaterNpub)) {
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
            target_record_family_hash: comment.targetRecordFamilyHash,
          },
        });
        continue;
      }
      const session = await this.agentWorkRuntime.handleTaskCommentDispatch({
        subscription: record,
        agent,
        recordId,
        comment,
        botIdentity: runtime.botIdentity,
      });
      record = this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: session ? 'task_comment_dispatch' : 'task_comment_skip_no_live_session',
        agentId: agent.agentId,
        sessionId: session?.id ?? null,
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'task',
        details: {
          comment_id: comment.commentId,
          updater_npub: updaterNpub,
          target_record_family_hash: comment.targetRecordFamilyHash,
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
    if (!this.agentCommentRuntime) {
      return record;
    }

    const agents = this.listDocumentCommentAgents(record, latest);
    if (agents.length === 0) {
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: 'document_comment_skip_no_matching_agent',
        agentId: 'unknown',
        sessionId: null,
        recordId,
        bindingId: comment.parentCommentId ?? comment.commentId,
        bindingType: 'thread',
        details: {
          comment_id: comment.commentId,
          target_record_id: comment.targetRecordId,
        },
      });
    }

    const runtime = this.getRuntime(record.subscriptionId);
    for (const agent of agents) {
      if (isSelfUpdater(record, agent, updaterNpub)) {
        record = this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'comment',
          action: 'document_comment_skip_self_update',
          agentId: agent.agentId,
          sessionId: null,
          recordId,
          bindingId: comment.parentCommentId ?? comment.commentId,
          bindingType: 'thread',
          details: {
            comment_id: comment.commentId,
            updater_npub: updaterNpub,
            target_record_id: comment.targetRecordId,
          },
        });
        continue;
      }
      const session = await this.agentCommentRuntime.handleDocumentCommentDispatch({
        subscription: record,
        agent,
        recordId,
        comment,
        botIdentity: runtime.botIdentity,
      });
      record = this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: session ? 'document_comment_dispatch' : 'document_comment_skip_runtime_returned_null',
        agentId: agent.agentId,
        sessionId: session?.id ?? null,
        recordId,
        bindingId: comment.parentCommentId ?? comment.commentId,
        bindingType: 'thread',
        details: {
          comment_id: comment.commentId,
          updater_npub: updaterNpub,
          target_record_id: comment.targetRecordId,
          target_record_family_hash: comment.targetRecordFamilyHash,
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
    const botRecord = this.botKeyStore.getActiveKeyForBotNpub(record.botNpub);
    if (!botRecord) {
      throw new Error(`Bot key record not found for ${record.botNpub}.`);
    }

    const botIdentity = this.unlockBotIdentity(botRecord);
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
        wsSession: runtime.wsSession,
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
          record.workspaceOwnerNpub,
          messageId,
          runtime.wsSession,
        );
        const latest = versions.sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0))[0];
        if (!latest) {
          continue;
        }
        const chatMessage = helpers.decryptChatRecord({
          record: latest,
          wsSession: runtime.wsSession,
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

  private deriveAgentGroupNpubs(workspaceOwnerNpub: string, botNpub: string): string[] {
    const subscription = this.store.getByWorkspaceAndBot(workspaceOwnerNpub, botNpub);
    if (!subscription?.wrappedGroupKeysJson) {
      return [];
    }

    try {
      const rows = JSON.parse(subscription.wrappedGroupKeysJson) as unknown;
      if (!Array.isArray(rows)) {
        return [];
      }
      const groupNpubs = rows
        .map((row) => (row && typeof row === 'object' ? (row as { group_npub?: unknown }).group_npub : null))
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim());
      return [...new Set(groupNpubs)].sort();
    } catch {
      return [];
    }
  }
}
