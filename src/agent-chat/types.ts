export type WorkspaceKeyStatus = 'pending' | 'active' | 'refresh_required' | 'revoked' | 'failed';
export type GroupKeyStatus = 'pending' | 'active' | 'refresh_required' | 'revoked' | 'failed';
export type SseStatus = 'disconnected' | 'connecting' | 'connected' | 'backoff' | 'disabled';
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';
export type BackendConnectionSharePolicy = 'private' | 'selected_users' | 'shared_service';
export type BackendConnectionGrantKind = 'manager_npub' | 'shared_service';
export type AgentCapability =
  | 'chat_intercept'
  | 'task_dispatch'
  | 'comment_dispatch'
  | 'flow_dispatch'
  | 'task_review'
  | 'approval_dispatch';
export type AgentInterceptDecision = 'respond' | 'ignore' | 'pending' | 'failed';
export type ChatInterceptStateStatus =
  | 'pending'
  | 'active'
  | 'interrupting'
  | 'interrupt_failed'
  | 'idle'
  | 'archived'
  | 'blocked_auth'
  | 'blocked_decrypt';

export interface AgentChatDiagnostic {
  ok: boolean;
  code: string | null;
  message: string;
  at: string;
  details?: Record<string, unknown> | null;
}

export interface AgentChatSseEventDiagnostic {
  eventId: string | null;
  eventType: string;
  at: string;
  payload: Record<string, unknown> | null;
}

export interface BackendConnectionRecord {
  backendConnectionId: string;
  managedByNpub: string;
  backendBaseUrl: string;
  serviceNpub: string | null;
  relayUrls: string[];
  openapiUrl: string | null;
  docsUrl: string | null;
  healthUrl: string | null;
  supportedVersion: string | null;
  sharePolicy: BackendConnectionSharePolicy;
  healthStatus: HealthStatus;
  lastHealthResult: AgentChatDiagnostic | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackendConnectionGrantRecord {
  backendConnectionId: string;
  grantKind: BackendConnectionGrantKind;
  granteeNpub: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentChatDispatchHistoryEntry {
  at: string;
  kind: 'chat' | 'task' | 'flow' | 'review' | 'approval' | 'comment';
  action: string;
  agentId: string;
  sessionId: string | null;
  recordId: string | null;
  bindingId?: string | null;
  bindingType?: 'chat' | 'task' | 'flow_run' | 'flow_orchestration' | 'thread' | null;
  details?: Record<string, unknown> | null;
}

export interface WorkspaceSubscriptionRecord {
  subscriptionId: string;
  backendConnectionId?: string | null;
  workspaceOwnerNpub: string;
  backendBaseUrl: string;
  botNpub: string;
  sourceAppNpub: string;
  connectionTokenRef?: string | null;
  agentProfileId?: string | null;
  sourceAppSchemaNamespace?: string | null;
  capabilityDefaults?: AgentCapability[];
  dispatchRouteIds?: string[];
  lastSyncCursor?: string | null;
  lastPipelineRunId?: string | null;
  wsKeyNpub: string | null;
  wsKeyStatus: WorkspaceKeyStatus;
  groupKeyStatus: GroupKeyStatus;
  sseStatus: SseStatus;
  healthStatus: HealthStatus;
  // Legacy migration field retained for operator visibility only.
  triggerConfigRecordId: string | null;
  lastSseEventId: string | null;
  lastAuthOkAt: string | null;
  lastGroupRefreshAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
  managedByNpub: string | null;
  wsKeyBlobJson: string | null;
  wrappedGroupKeysJson: string | null;
  lastAuthResult: AgentChatDiagnostic | null;
  lastGroupRefreshResult: AgentChatDiagnostic | null;
  lastRecordPullResult: AgentChatDiagnostic | null;
  lastDecryptResult: AgentChatDiagnostic | null;
  lastRoutingResult: AgentChatDiagnostic | null;
  lastSseEvent: AgentChatSseEventDiagnostic | null;
  recentSseEvents: AgentChatSseEventDiagnostic[];
  recentDispatches: AgentChatDispatchHistoryEntry[];
  lastSuccessfulStartupReloadAt: string | null;
}

export interface AgentDefinitionRecord {
  agentId: string;
  label: string;
  botNpub: string;
  workspaceOwnerNpub: string;
  groupNpubs: string[];
  workingDirectory: string;
  capabilities: AgentCapability[];
  chatPromptTemplate?: string;
  taskPromptTemplate?: string;
  flowDispatchPromptTemplate?: string;
  taskReviewPromptTemplate?: string;
  approvalDispatchPromptTemplate?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  managedByNpub: string | null;
}

export interface ChatInterceptStateRecord {
  routingKey: string;
  subscriptionId: string;
  agentId: string;
  sessionId: string | null;
  sessionClass: 'chat';
  workspaceOwnerNpub: string;
  sourceAppNpub: string;
  channelId: string;
  threadId: string;
  botNpub: string;
  lastMessageIdSeen: string | null;
  pendingMessageCount: number;
  state: ChatInterceptStateStatus;
  lastDecision: AgentInterceptDecision;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceSubscriptionInput {
  managedByNpub: string;
  workspaceOwnerNpub: string;
  backendBaseUrl: string;
  sourceAppNpub: string;
  backendConnectionId?: string | null;
  backendConnectionGrantKind?: BackendConnectionGrantKind | null;
  connectionTokenRef?: string | null;
  agentProfileId?: string | null;
  sourceAppSchemaNamespace?: string | null;
  capabilityDefaults?: AgentCapability[];
  dispatchRouteIds?: string[];
  triggerConfigRecordId?: string | null;
}

export interface UpdateWorkspaceSubscriptionInput extends WorkspaceSubscriptionRecord {}

export interface CreateAgentDefinitionInput {
  managedByNpub: string;
  agentId: string;
  label: string;
  botNpub: string;
  workspaceOwnerNpub: string;
  groupNpubs: string[];
  workingDirectory: string;
  capabilities?: AgentCapability[];
  chatPromptTemplate?: string;
  taskPromptTemplate?: string;
  flowDispatchPromptTemplate?: string;
  taskReviewPromptTemplate?: string;
  approvalDispatchPromptTemplate?: string;
  enabled?: boolean;
}

export interface BotKeyStoreRecord {
  id: string;
  userNpub: string;
  botPubkeyHex: string;
  botNpub: string;
  displayName: string;
  encryptedToUser: string;
  encryptedEscrow: string;
  escrowUuid: string;
  isActive: number;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeBotIdentity {
  botNpub: string;
  botPubkeyHex: string;
  botSecret: Uint8Array;
}

export interface YokeBotHelperError extends Error {
  code?: string;
}

export interface YokeWorkspaceSession {
  npub: string;
  secret: Uint8Array;
  isWorkspaceKey?: boolean;
  botNpub?: string;
}

export interface YokeBotHelpersModule {
  BotHelperError?: new (code: string, message: string, options?: { cause?: unknown }) => YokeBotHelperError;
  createBotWorkspaceKey: (params: {
    botSecret: Uint8Array;
    botNpub: string;
    workspaceOwnerNpub: string;
  }) => { blob: Record<string, unknown>; wsSession: YokeWorkspaceSession };
  signBotRequest: (params: {
    botSecret: Uint8Array;
    botNpub: string;
    url: string;
    method: string;
    body?: unknown;
  }) => string;
  loadBotWorkspaceKey: (params: {
    blob: Record<string, unknown>;
    botSecret: Uint8Array;
    botNpub: string;
  }) => { wsSession: YokeWorkspaceSession };
  signWorkspaceRequest: (params: {
    wsSession: YokeWorkspaceSession;
    url: string;
    method: string;
    body?: unknown;
  }) => string;
  fetchBotGroupKeys: (params: {
    wsSession: YokeWorkspaceSession;
    backendBaseUrl: string;
    fetchImpl?: typeof fetch;
  }) => Promise<unknown[]>;
  loadBotGroupKeys: (params: {
    wsSession: YokeWorkspaceSession;
    botSecret: Uint8Array;
    botNpub: string;
    keyRows: unknown[];
  }) => unknown;
  decryptChatRecord: (params: {
    record: Record<string, unknown>;
    wsSession: YokeWorkspaceSession;
    groupKeys: unknown;
  }) => Record<string, unknown>;
  normalizeThreadId: (chatMessage: Record<string, unknown>, context?: Record<string, unknown>) => string;
  normalizeChannelParticipants: (input: Record<string, unknown>) => string[];
  normalizeChatRoutingContext: (
    input: { chatMessage: Record<string, unknown>; channel: Record<string, unknown> },
    context?: Record<string, unknown>,
  ) => {
    record_id: string;
    channel_id: string;
    parent_message_id: string | null;
    thread_id: string;
    participant_npubs: string[];
  };
}

export interface BrowserSignedNip98TokenRequest {
  npub: string;
  url: string;
  method: string;
  body?: unknown;
}

export interface InboundTaskRecord {
  taskId: string;
  flowId: string | null;
  flowRunId: string | null;
  flowStep: string | null;
  scopeId: string | null;
  scopeL1Id: string | null;
  scopeL2Id: string | null;
  scopeL3Id: string | null;
  scopeL4Id: string | null;
  scopeL5Id: string | null;
  title: string;
  description: string | null;
  state: string | null;
  assignedTo: string | null;
  deleted: boolean;
  done: boolean;
  predecessorTaskIds: string[];
}

export interface InboundApprovalRecord {
  approvalId: string | null;
  flowId: string | null;
  flowRunId: string | null;
  flowStep: string | null;
  state: string | null;
}

export interface InboundCommentRecord {
  commentId: string;
  targetRecordId: string | null;
  targetRecordFamilyHash: string | null;
  parentCommentId: string | null;
  anchorLineNumber: number | null;
  commentStatus: 'open' | 'resolved';
  body: string;
  attachments: unknown[];
  senderNpub: string | null;
  recordState: string | null;
}
