import type {
  AgentChatDiagnostic,
  BackendConnectionRecord,
  HealthStatus,
  RuntimeBotIdentity,
  YokeWorkspaceSession,
} from './types';
import { loadYokeBotHelpers } from './yoke-bot-helpers';

export interface TowerErrorDetails {
  status: number;
  message: string;
  detailCode: string | null;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FlightDeckPgWorkspaceMeResult {
  identity?: Record<string, unknown>;
  actor?: Record<string, unknown>;
  membership?: Record<string, unknown>;
  permissions?: string[];
  visible?: Record<string, unknown>;
}

export interface FlightDeckPgEvent {
  id?: string;
  event_id?: string;
  cursor?: string | null;
  workspace_id?: string;
  scope_id?: string | null;
  channel_id?: string | null;
  actor_id?: string | null;
  event_type?: string;
  entity_type?: string;
  entity_id?: string | null;
  operation?: string;
  entity_row_version?: number | null;
  row_version?: number;
  timestamp?: string;
  created_at?: string;
  payload?: Record<string, unknown>;
  refetch?: Record<string, unknown>;
}

export interface FlightDeckPgMessage {
  id: string;
  workspace_id?: string;
  scope_id?: string | null;
  channel_id?: string | null;
  thread_id?: string | null;
  thread_source_message_id?: string | null;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
  row_version?: number | null;
  created_by_actor_id?: string | null;
  updated_by_actor_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface FlightDeckPgTask {
  id: string;
  workspace_id?: string;
  scope_id?: string | null;
  channel_id?: string | null;
  thread_id?: string | null;
  title?: string | null;
  description?: string | null;
  state?: string | null;
  priority?: string | null;
  metadata?: Record<string, unknown> | null;
  row_version?: number | null;
  created_by_actor_id?: string | null;
  updated_by_actor_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface FlightDeckPgTaskComment {
  id: string;
  workspace_id?: string;
  scope_id?: string | null;
  channel_id?: string | null;
  task_id?: string | null;
  thread_id?: string | null;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
  row_version?: number | null;
  created_by_actor_id?: string | null;
  updated_by_actor_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface FlightDeckPgEditLease {
  id: string;
  entity_type?: string;
  entity_id?: string;
  field_path?: string | null;
  lease_token?: string;
  holder_actor_npub?: string | null;
  expires_at?: string | null;
}

export interface FlightDeckPgMessagesResult {
  identity?: Record<string, unknown>;
  channel_id?: string;
  thread_id?: string | null;
  messages: FlightDeckPgMessage[];
  next_cursor: string | null;
}

export interface FlightDeckPgWriteResult {
  identity?: Record<string, unknown>;
  message?: FlightDeckPgMessage;
  task?: FlightDeckPgTask;
  comment?: FlightDeckPgTaskComment;
  lease?: FlightDeckPgEditLease;
  reaction?: Record<string, unknown>;
  event?: FlightDeckPgEvent;
  [key: string]: unknown;
}

export interface FlightDeckPgEventsResult {
  identity?: Record<string, unknown>;
  events: FlightDeckPgEvent[];
  next_cursor: string | null;
  cursor_semantics?: Record<string, unknown>;
}

export function normaliseBackendBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const parsed = URL.parse(trimmed);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error('backend_base_url must be an http or https URL');
  }
  return trimmed.replace(/\/+$/, '');
}

export function buildChatMessageFamilyHash(sourceAppNpub: string): string {
  return `${sourceAppNpub}:chat_message`;
}

export function buildRecordFamilyHash(appNpub: string, collectionSpace: string): string {
  return `${appNpub}:${collectionSpace}`;
}

export function stripNostrAuthPrefix(value: string): string {
  return value.replace(/^Nostr\s+/i, '').trim();
}

export function encodeFlightDeckPgEventCursor(rowVersion: number): string {
  return Buffer.from(JSON.stringify({ version: 1, rowVersion }), 'utf8').toString('base64url');
}

function buildFlightDeckPgUrl(
  backendBaseUrl: string,
  path: string,
  params: Record<string, string | number | null | undefined> = {},
): string {
  const url = new URL(path, backendBaseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && String(value).trim().length > 0) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function signFlightDeckPgBotRequest(params: {
  botIdentity: RuntimeBotIdentity;
  url: string;
  method: string;
  body?: unknown;
}): Promise<string> {
  const helpers = await loadYokeBotHelpers();
  return helpers.signBotRequest({
    botSecret: params.botIdentity.botSecret,
    botNpub: params.botIdentity.botNpub,
    url: params.url,
    method: params.method,
    body: params.body ?? null,
  });
}

export async function parseTowerError(response: Response, stage: string): Promise<TowerErrorDetails> {
  const bodyText = await response.text().catch(() => '');
  let message = bodyText || response.statusText || stage;
  try {
    const parsed = JSON.parse(bodyText) as { error?: string };
    if (typeof parsed?.error === 'string' && parsed.error.trim().length > 0) {
      message = parsed.error.trim();
    }
  } catch {
    // Non-JSON response.
  }
  return {
    status: response.status,
    message,
    detailCode: inferDetailCode(stage, response.status, message),
  };
}

export async function buildStreamUrl(
  backendBaseUrl: string,
  workspaceNpub: string,
  wsSession: YokeWorkspaceSession,
  lastEventId?: string | null,
): Promise<string> {
  const helpers = await loadYokeBotHelpers();
  const baseUrl = new URL(`/api/v4/workspaces/${encodeURIComponent(workspaceNpub)}/stream`, backendBaseUrl).toString();
  const signed = helpers.signWorkspaceRequest({
    wsSession,
    url: baseUrl,
    method: 'GET',
  });
  const streamUrl = new URL(baseUrl);
  streamUrl.searchParams.set('token', stripNostrAuthPrefix(signed));
  if (lastEventId) {
    streamUrl.searchParams.set('last_event_id', lastEventId);
  }
  return streamUrl.toString();
}

export async function fetchRecordHistory(
  backendBaseUrl: string,
  workspaceNpub: string,
  recordId: string,
  wsSession: YokeWorkspaceSession,
  options: { signal?: AbortSignal } = {},
): Promise<Record<string, unknown>[]> {
  const helpers = await loadYokeBotHelpers();
  const path = `/api/v4/records/${encodeURIComponent(recordId)}/history?owner_npub=${encodeURIComponent(workspaceNpub)}`;
  const url = new URL(path, backendBaseUrl).toString();
  const authorization = helpers.signWorkspaceRequest({ wsSession, url, method: 'GET' });
  const response = await fetch(url, {
    headers: {
      Authorization: authorization,
    },
    signal: options.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'record_history');
    throw Object.assign(new Error(error.message), error);
  }
  const payload = await response.json() as { versions?: Record<string, unknown>[] };
  return Array.isArray(payload?.versions) ? payload.versions : [];
}

export async function fetchFlightDeckPgWorkspaceMe(params: {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWorkspaceMeResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/me`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'GET',
  });
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_workspace_me');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWorkspaceMeResult;
}

export async function fetchFlightDeckPgEvents(params: {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}): Promise<FlightDeckPgEventsResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/events`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path, {
    cursor: params.cursor ?? encodeFlightDeckPgEventCursor(0),
    limit: params.limit ?? 100,
  });
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'GET',
  });
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_events');
    throw Object.assign(new Error(error.message), error);
  }
  const payload = await response.json() as Partial<FlightDeckPgEventsResult>;
  return {
    ...payload,
    events: Array.isArray(payload.events) ? payload.events : [],
    next_cursor: typeof payload.next_cursor === 'string' ? payload.next_cursor : null,
  };
}

export async function fetchFlightDeckPgChannelMessages(params: {
  backendBaseUrl: string;
  workspaceId: string;
  channelId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  threadId?: string | null;
  limit?: number;
  signal?: AbortSignal;
}): Promise<FlightDeckPgMessagesResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/channels/${encodeURIComponent(params.channelId)}/messages`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path, {
    thread_id: params.threadId ?? null,
    limit: params.limit ?? 200,
  });
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'GET',
  });
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_channel_messages');
    throw Object.assign(new Error(error.message), error);
  }
  const payload = await response.json() as Partial<FlightDeckPgMessagesResult>;
  return {
    ...payload,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    next_cursor: typeof payload.next_cursor === 'string' ? payload.next_cursor : null,
  };
}

export async function createFlightDeckPgChannelMessage(params: {
  backendBaseUrl: string;
  workspaceId: string;
  channelId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  body: string;
  threadId?: string | null;
  createThread?: boolean;
  metadata?: Record<string, unknown> | null;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/channels/${encodeURIComponent(params.channelId)}/messages`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = {
    body: params.body,
    ...(params.threadId ? { thread_id: params.threadId } : {}),
    ...(params.createThread !== undefined ? { create_thread: params.createThread } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_channel_message_create');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function createFlightDeckPgReaction(params: {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  targetType: string;
  targetId: string;
  emoji: string;
  metadata?: Record<string, unknown> | null;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/reactions`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = {
    target_type: params.targetType,
    target_id: params.targetId,
    emoji: params.emoji,
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_reaction_create');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function fetchFlightDeckPgTask(params: {
  backendBaseUrl: string;
  workspaceId: string;
  taskId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/tasks/${encodeURIComponent(params.taskId)}`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'GET',
  });
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_task');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function createFlightDeckPgChannelTask(params: {
  backendBaseUrl: string;
  workspaceId: string;
  channelId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  title: string;
  description?: string | null;
  state?: string;
  priority?: string;
  threadId?: string | null;
  metadata?: Record<string, unknown> | null;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/channels/${encodeURIComponent(params.channelId)}/tasks`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = {
    title: params.title,
    ...(params.description !== undefined ? { description: params.description } : {}),
    state: params.state ?? 'new',
    priority: params.priority ?? 'sand',
    ...(params.threadId ? { thread_id: params.threadId } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_task_create');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function createFlightDeckPgTaskComment(params: {
  backendBaseUrl: string;
  workspaceId: string;
  taskId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  body: string;
  threadId?: string | null;
  metadata?: Record<string, unknown> | null;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/tasks/${encodeURIComponent(params.taskId)}/comments`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = {
    body: params.body,
    ...(params.threadId ? { thread_id: params.threadId } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_task_comment_create');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function acquireFlightDeckPgEditLease(params: {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  entityType: 'task' | 'document';
  entityId: string;
  ttlSeconds?: number;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/edit-leases/acquire`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = {
    entity_type: params.entityType,
    entity_id: params.entityId,
    ttl_seconds: params.ttlSeconds ?? 120,
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_edit_lease_acquire');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function updateFlightDeckPgTaskState(params: {
  backendBaseUrl: string;
  workspaceId: string;
  taskId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  state: string;
  rowVersion: number;
  leaseToken: string;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/tasks/${encodeURIComponent(params.taskId)}/state`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = {
    state: params.state,
    row_version: params.rowVersion,
    lease_token: params.leaseToken,
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_task_state_update');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function fetchGroupsForViewer(
  backendBaseUrl: string,
  viewerNpub: string,
  wsSession: YokeWorkspaceSession,
): Promise<Record<string, unknown>[]> {
  const helpers = await loadYokeBotHelpers();
  const path = `/api/v4/groups?npub=${encodeURIComponent(viewerNpub)}`;
  const url = new URL(path, backendBaseUrl).toString();
  const authorization = helpers.signWorkspaceRequest({ wsSession, url, method: 'GET' });
  const response = await fetch(url, {
    headers: {
      Authorization: authorization,
    },
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'group_list');
    throw Object.assign(new Error(error.message), error);
  }
  const payload = await response.json() as { groups?: Record<string, unknown>[] };
  return Array.isArray(payload?.groups) ? payload.groups : [];
}

export interface WorkspaceKeyMapping {
  workspace_owner_npub: string;
  ws_key_npub: string;
  user_npub: string;
  workspace_service_npub?: string;
  workspace_user_key_npub?: string;
}

export async function fetchWorkspaceKeyMappings(
  backendBaseUrl: string,
  workspaceNpub: string,
  wsSession: YokeWorkspaceSession,
): Promise<WorkspaceKeyMapping[]> {
  const helpers = await loadYokeBotHelpers();
  const path = `/api/v4/user/workspace-key-mappings?workspace_service_npub=${encodeURIComponent(workspaceNpub)}`;
  const url = new URL(path, backendBaseUrl).toString();
  const authorization = helpers.signWorkspaceRequest({ wsSession, url, method: 'GET' });
  const response = await fetch(url, {
    headers: {
      Authorization: authorization,
    },
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'workspace_key_mappings');
    throw Object.assign(new Error(error.message), error);
  }
  const payload = await response.json() as { mappings?: WorkspaceKeyMapping[] };
  return Array.isArray(payload?.mappings) ? payload.mappings : [];
}

export async function registerWorkspaceKeyWithTower(params: {
  backendBaseUrl: string;
  workspaceNpub: string;
  workspaceOwnerNpub?: string | null;
  wsKeyNpub: string;
  authorization: string;
}): Promise<Record<string, unknown>> {
  const url = new URL('/api/v4/user/workspace-keys', params.backendBaseUrl).toString();
  const body = {
    workspace_owner_npub: params.workspaceNpub,
    workspace_service_npub: params.workspaceNpub,
    human_workspace_owner_npub: params.workspaceOwnerNpub ?? null,
    ws_key_npub: params.wsKeyNpub,
    workspace_user_key_npub: params.wsKeyNpub,
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: params.authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'workspace_key_register');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as Record<string, unknown>;
}

export async function checkBackendConnectionHealth(
  record: BackendConnectionRecord,
  fetchImpl: FetchLike = fetch,
): Promise<{ healthStatus: HealthStatus; diagnostic: AgentChatDiagnostic }> {
  const targetUrl = record.healthUrl?.trim() || null;
  if (!targetUrl) {
    return {
      healthStatus: 'degraded',
      diagnostic: buildFailureDiagnostic(
        'backend_health_unavailable',
        'Backend connection has no health URL.',
        'backend_health_url_missing',
        {
          backend_connection_id: record.backendConnectionId,
          backend_base_url: record.backendBaseUrl,
        },
      ),
    };
  }

  const startedAt = Date.now();
  try {
    const response = await fetchImpl(targetUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const elapsedMs = Date.now() - startedAt;
    const details: Record<string, unknown> = {
      backend_connection_id: record.backendConnectionId,
      backend_base_url: record.backendBaseUrl,
      health_url: targetUrl,
      status: response.status,
      elapsed_ms: elapsedMs,
    };
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      details.response = await response.json().catch(() => null);
    }

    if (!response.ok) {
      return {
        healthStatus: 'unhealthy',
        diagnostic: buildFailureDiagnostic(
          'backend_health_failed',
          response.statusText || `Backend health check failed with HTTP ${response.status}.`,
          'backend_health_http_error',
          details,
        ),
      };
    }

    return {
      healthStatus: 'healthy',
      diagnostic: buildSuccessDiagnostic('Backend health check passed.', details),
    };
  } catch (error) {
    return {
      healthStatus: 'unhealthy',
      diagnostic: buildFailureDiagnostic(
        'backend_health_failed',
        error instanceof Error ? error.message : 'Backend health check failed.',
        'backend_health_request_failed',
        {
          backend_connection_id: record.backendConnectionId,
          backend_base_url: record.backendBaseUrl,
          health_url: targetUrl,
        },
      ),
    };
  }
}

export function buildFailureDiagnostic(
  code: string,
  message: string,
  detailCode: string | null,
  details?: Record<string, unknown> | null,
): AgentChatDiagnostic {
  return {
    ok: false,
    code,
    message,
    at: new Date().toISOString(),
    details: {
      ...(details ?? {}),
      detailCode,
    },
  };
}

export function buildSuccessDiagnostic(
  message: string,
  details?: Record<string, unknown> | null,
): AgentChatDiagnostic {
  return {
    ok: true,
    code: null,
    message,
    at: new Date().toISOString(),
    details: details ?? null,
  };
}

function inferDetailCode(stage: string, status: number, message: string): string | null {
  const lowered = message.toLowerCase();
  if (stage === 'workspace_key_register') {
    if (status === 403) return 'workspace_access_denied';
    if (lowered.includes('conflict')) return 'workspace_key_invalid';
  }
  if (stage === 'group_key_fetch') {
    if (status === 403) return 'group_membership_revoked';
    if (lowered.includes('epoch')) return 'group_key_epoch_stale';
    if (lowered.includes('missing wrapped group keys')) return 'group_key_missing';
  }
  if (stage === 'stream_connect') {
    if (status === 403) return 'sse_stream_forbidden';
    if (status === 401) return 'workspace_key_invalid';
  }
  if (stage === 'record_history') {
    if (status === 403) return 'group_membership_revoked';
    if (status === 404) return 'record_pull_not_found';
    if (lowered.includes('epoch')) return 'group_key_epoch_stale';
  }
  if (lowered.includes('workspace key revoked')) return 'workspace_key_revoked';
  if (lowered.includes('workspace key invalid')) return 'workspace_key_invalid';
  if (lowered.includes('epoch')) return 'group_key_epoch_stale';
  if (lowered.includes('group key')) return 'group_key_missing';
  return null;
}
