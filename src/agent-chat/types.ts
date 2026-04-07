export type WorkspaceKeyStatus = 'pending' | 'active' | 'refresh_required' | 'revoked' | 'failed';
export type GroupKeyStatus = 'pending' | 'active' | 'refresh_required' | 'revoked' | 'failed';
export type SseStatus = 'disconnected' | 'connecting' | 'connected' | 'backoff' | 'disabled';
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

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

export interface WorkspaceSubscriptionRecord {
  subscriptionId: string;
  workspaceOwnerNpub: string;
  backendBaseUrl: string;
  botNpub: string;
  sourceAppNpub: string;
  wsKeyNpub: string | null;
  wsKeyStatus: WorkspaceKeyStatus;
  groupKeyStatus: GroupKeyStatus;
  sseStatus: SseStatus;
  healthStatus: HealthStatus;
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
  lastSseEvent: AgentChatSseEventDiagnostic | null;
  lastSuccessfulStartupReloadAt: string | null;
}

export interface CreateWorkspaceSubscriptionInput {
  managedByNpub: string;
  workspaceOwnerNpub: string;
  backendBaseUrl: string;
  sourceAppNpub: string;
  triggerConfigRecordId?: string | null;
}

export interface UpdateWorkspaceSubscriptionInput extends WorkspaceSubscriptionRecord {}

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
    keyRows: unknown[];
  }) => unknown;
  decryptChatRecord: (params: {
    record: Record<string, unknown>;
    wsSession: YokeWorkspaceSession;
    groupKeys: unknown;
  }) => Record<string, unknown>;
  normalizeThreadId?: (chatMessage: Record<string, unknown>, context?: Record<string, unknown>) => string;
}

export interface BrowserSignedNip98TokenRequest {
  npub: string;
  url: string;
  method: string;
  body?: unknown;
}
