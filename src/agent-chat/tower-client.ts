import type { AgentChatDiagnostic, BackendConnectionRecord, HealthStatus, YokeWorkspaceSession } from './types';
import { loadYokeBotHelpers } from './yoke-bot-helpers';

export interface TowerErrorDetails {
  status: number;
  message: string;
  detailCode: string | null;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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
