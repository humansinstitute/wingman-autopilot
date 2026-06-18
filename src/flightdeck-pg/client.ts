import { basename } from 'node:path';

import { getPublicKey, nip19 } from 'nostr-tools';

import { buildAuthHeader } from '../../clis/lib/auth';
import type { RuntimeBotIdentity } from '../agent-chat/types';
import {
  acquireFlightDeckPgEditLease,
  assignFlightDeckPgTask,
  createFlightDeckPgAudioNote,
  createFlightDeckPgChannelDocument,
  createFlightDeckPgChannelMessage,
  createFlightDeckPgChannelTask,
  createFlightDeckPgDocumentComment,
  createFlightDeckPgReaction,
  createFlightDeckPgTaskComment,
  decodeFlightDeckPgDocumentBody,
  fetchFlightDeckPgChannelMessages,
  fetchFlightDeckPgDocument,
  fetchFlightDeckPgDocumentComments,
  fetchFlightDeckPgEvents,
  fetchFlightDeckPgScopeChannels,
  fetchFlightDeckPgTask,
  fetchFlightDeckPgTaskComments,
  fetchFlightDeckPgWorkspaceMe,
  fetchFlightDeckPgWorkspaceMembers,
  normaliseBackendBaseUrl,
  updateFlightDeckPgDocument,
  updateFlightDeckPgTaskState,
  uploadFlightDeckPgStorageObject,
} from '../agent-chat/tower-client';

export interface FlightDeckPgClientConfig {
  towerUrl: string;
  wingmanUrl: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  sessionId?: string | null;
  fetchImpl?: typeof fetch;
}

export interface FlightDeckPgDispatchContext {
  workspaceId?: string | null;
  channelId?: string | null;
  threadId?: string | null;
  taskId?: string | null;
  scopeId?: string | null;
  sourceAppNpub?: string | null;
  backendBaseUrl?: string | null;
  [key: string]: unknown;
}

export class MissingFlightDeckPgRouteError extends Error {
  readonly routeGap: Record<string, unknown>;

  constructor(routeGap: Record<string, unknown>) {
    super(`Missing Flight Deck PG route: ${String(routeGap.method)} ${String(routeGap.path)}`);
    this.routeGap = routeGap;
  }
}

export function createBotIdentityFromSecret(secretKey: Uint8Array): RuntimeBotIdentity {
  const botPubkeyHex = getPublicKey(secretKey);
  return {
    botSecret: secretKey,
    botPubkeyHex,
    botNpub: nip19.npubEncode(botPubkeyHex),
  };
}

export function resolveFlightDeckPgConfig(input: {
  towerUrl?: string | null;
  wingmanUrl?: string | null;
  appNpub?: string | null;
  secretKey: Uint8Array;
  sessionId?: string | null;
  fetchImpl?: typeof fetch;
}): FlightDeckPgClientConfig {
  const towerUrl = normaliseBackendBaseUrl(input.towerUrl || Bun.env.TOWER_URL || Bun.env.FLIGHTDECK_TOWER_URL || 'http://127.0.0.1:3000');
  const wingmanUrl = normaliseBackendBaseUrl(input.wingmanUrl || Bun.env.WINGMAN_URL || 'http://127.0.0.1:3600');
  const appNpub = (input.appNpub || Bun.env.FLIGHTDECK_APP_NPUB || Bun.env.WINGMAN_NPUB || Bun.env.BOT_NPUB || '').trim();
  if (!appNpub) {
    throw new Error('Missing Flight Deck app npub. Set FLIGHTDECK_APP_NPUB, WINGMAN_NPUB, or pass --app-npub.');
  }
  return {
    towerUrl,
    wingmanUrl,
    appNpub,
    botIdentity: createBotIdentityFromSecret(input.secretKey),
    sessionId: input.sessionId ?? Bun.env.SESSION_ID ?? null,
    fetchImpl: input.fetchImpl,
  };
}

export class FlightDeckPgClient {
  private readonly config: FlightDeckPgClientConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: FlightDeckPgClientConfig) {
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async context(): Promise<Record<string, unknown>> {
    if (!this.config.sessionId) {
      return {
        mode: 'flightdeck_pg',
        context_available: false,
        reason: 'SESSION_ID is not set; pass explicit --workspace/--channel/--thread/--task flags.',
        towerUrl: this.config.towerUrl,
        wingmanUrl: this.config.wingmanUrl,
        actor: {
          bot_npub: this.config.botIdentity.botNpub,
          bot_pubkey_hex: this.config.botIdentity.botPubkeyHex,
        },
      };
    }
    return await this.callWingmanHelper('context');
  }

  async status(): Promise<Record<string, unknown>> {
    return {
      ok: true,
      mode: 'flightdeck_pg',
      towerUrl: this.config.towerUrl,
      wingmanUrl: this.config.wingmanUrl,
      appNpub: this.config.appNpub,
      botNpub: this.config.botIdentity.botNpub,
      sessionId: this.config.sessionId ?? null,
    };
  }

  async listWorkspaces() {
    return await this.signedJson('GET', '/api/v4/flightdeck-pg/workspaces');
  }

  async showWorkspace(workspaceId: string) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/descriptor`);
  }

  async workspaceMe(workspaceId: string) {
    return await fetchFlightDeckPgWorkspaceMe(this.base({ workspaceId }));
  }

  async listScopes(workspaceId: string) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/scopes`);
  }

  async showScope(workspaceId: string, scopeId: string) {
    const scopes = await this.listScopes(workspaceId) as { scopes?: Array<Record<string, unknown>> };
    const scope = scopes.scopes?.find((entry) => entry.id === scopeId);
    if (!scope) throw new MissingFlightDeckPgRouteError({
      method: 'GET',
      path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/scopes/{scopeId}',
      auth: 'NIP-98 actor must be a workspace member with scope.read or readable channel grants.',
      request: { path: { workspaceId, scopeId } },
      response: { identity: 'FlightDeckPgIdentity', scope: 'FlightDeckPgScope' },
      note: 'Tower currently exposes scope list but no single scope read endpoint; CLI filters list output when possible.',
    });
    return { scope };
  }

  async listChannels(workspaceId: string, scopeId: string, limit?: number) {
    return await fetchFlightDeckPgScopeChannels({ ...this.base({ workspaceId }), scopeId, limit });
  }

  async showChannel(workspaceId: string, channelId: string) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}`);
  }

  async listThreads(workspaceId: string, channelId: string, limit?: number) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/threads`, { limit });
  }

  async readThread(workspaceId: string, channelId: string, threadId?: string | null, limit?: number) {
    return await fetchFlightDeckPgChannelMessages({ ...this.base({ workspaceId }), channelId, threadId, limit });
  }

  async reply(workspaceId: string, channelId: string, threadId: string | null, body: string) {
    return await createFlightDeckPgChannelMessage({ ...this.base({ workspaceId }), channelId, threadId, body });
  }

  async listTasks(workspaceId: string, input: { channelId?: string | null; scopeId?: string | null; limit?: number }) {
    if (input.channelId) {
      return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(input.channelId)}/tasks`, { limit: input.limit });
    }
    if (input.scopeId) {
      return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/scopes/${encodeURIComponent(input.scopeId)}/tasks`, { limit: input.limit });
    }
    throw new MissingFlightDeckPgRouteError({
      method: 'GET',
      path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks',
      auth: 'NIP-98 actor must be a workspace member; response filters to task.read-visible channels.',
      request: { query: { limit: 'number?' } },
      response: { identity: 'FlightDeckPgIdentity', tasks: ['FlightDeckPgTask'], next_cursor: 'string|null' },
      note: 'Tower currently lists tasks by channel or scope only. Pass --channel or --scope until workspace task rollup exists.',
    });
  }

  async showTask(workspaceId: string, taskId: string) {
    return await fetchFlightDeckPgTask(this.base({ workspaceId, taskId }));
  }

  async createTask(workspaceId: string, channelId: string, input: { title: string; description?: string | null; state?: string; priority?: string; threadId?: string | null }) {
    return await createFlightDeckPgChannelTask({ ...this.base({ workspaceId }), channelId, ...input });
  }

  async patchTask(workspaceId: string, taskId: string, payload: Record<string, unknown>) {
    return await this.signedJson('PATCH', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}`, undefined, payload);
  }

  async updateTaskState(workspaceId: string, taskId: string, state: string) {
    const taskResult = await this.showTask(workspaceId, taskId);
    const task = taskResult.task as { row_version?: number } | undefined;
    const rowVersion = Number(task?.row_version);
    if (!Number.isInteger(rowVersion) || rowVersion < 1) throw new Error('Flight Deck PG task state update requires task.row_version from task show response.');
    const leaseResult = await acquireFlightDeckPgEditLease({ ...this.base({ workspaceId }), entityType: 'task', entityId: taskId });
    const leaseToken = String(leaseResult.lease?.lease_token || '');
    if (!leaseToken) throw new Error('Flight Deck PG edit lease acquire did not return lease_token.');
    return await updateFlightDeckPgTaskState({ ...this.base({ workspaceId, taskId }), state, rowVersion, leaseToken });
  }

  async listTaskComments(workspaceId: string, taskId: string, limit?: number) {
    return await fetchFlightDeckPgTaskComments({ ...this.base({ workspaceId, taskId }), limit });
  }

  async commentTask(workspaceId: string, taskId: string, body: string, threadId?: string | null) {
    return await createFlightDeckPgTaskComment({ ...this.base({ workspaceId, taskId }), body, threadId });
  }

  async assignTask(workspaceId: string, taskId: string, actorId: string) {
    return await assignFlightDeckPgTask({ ...this.base({ workspaceId, taskId }), actorId });
  }

  async listDocs(workspaceId: string, channelId: string, limit?: number) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/docs`, { limit });
  }

  async createDoc(workspaceId: string, channelId: string, title: string, body: string) {
    return await createFlightDeckPgChannelDocument({ ...this.base({ workspaceId }), channelId, title, body });
  }

  async showDoc(workspaceId: string, documentId: string, includeBody: boolean) {
    const result = await fetchFlightDeckPgDocument({ ...this.base({ workspaceId }), documentId, includeBody });
    return includeBody ? { ...result, body_text: decodeFlightDeckPgDocumentBody(result) } : result;
  }

  async updateDoc(workspaceId: string, documentId: string, body: string) {
    const current = await fetchFlightDeckPgDocument({ ...this.base({ workspaceId }), documentId });
    const doc = current.doc as { row_version?: number; title?: string | null } | undefined;
    const rowVersion = Number(doc?.row_version);
    if (!Number.isInteger(rowVersion) || rowVersion < 1) throw new Error('Flight Deck PG doc update requires doc.row_version from doc show response.');
    const leaseResult = await acquireFlightDeckPgEditLease({ ...this.base({ workspaceId }), entityType: 'document', entityId: documentId });
    const leaseToken = String(leaseResult.lease?.lease_token || '');
    if (!leaseToken) throw new Error('Flight Deck PG edit lease acquire did not return lease_token.');
    return await updateFlightDeckPgDocument({ ...this.base({ workspaceId }), documentId, title: doc?.title ?? undefined, body, rowVersion, leaseToken });
  }

  async listDocComments(workspaceId: string, documentId: string, limit?: number) {
    return await fetchFlightDeckPgDocumentComments({ ...this.base({ workspaceId }), documentId, limit });
  }

  async replyDoc(workspaceId: string, documentId: string, body: string, parentCommentId?: string | null) {
    return await createFlightDeckPgDocumentComment({ ...this.base({ workspaceId }), documentId, body, parentCommentId });
  }

  async listFiles(workspaceId: string, channelId: string, limit?: number) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/files`, { limit });
  }

  async uploadFile(workspaceId: string, channelId: string, path: string, contentType?: string | null) {
    const file = Bun.file(path);
    const content = new Uint8Array(await file.arrayBuffer());
    const uploaded = await uploadFlightDeckPgStorageObject({
      ...this.base({ workspaceId }),
      fileName: basename(path),
      contentType: contentType || file.type || 'application/octet-stream',
      content,
    });
    return await this.signedJson('POST', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/files`, undefined, {
      storage_object_id: uploaded.object_id,
      display_name: basename(path),
    });
  }

  async showFile(workspaceId: string, fileId: string, includeObject = false) {
    const suffix = includeObject ? '/object' : '';
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(fileId)}${suffix}`);
  }

  async createAudio(workspaceId: string, channelId: string, path: string, contentType?: string | null) {
    const file = Bun.file(path);
    const content = new Uint8Array(await file.arrayBuffer());
    const mimeType = contentType || file.type || 'application/octet-stream';
    const uploaded = await uploadFlightDeckPgStorageObject({
      ...this.base({ workspaceId }),
      fileName: basename(path),
      contentType: mimeType,
      content,
    });
    return await createFlightDeckPgAudioNote({
      ...this.base({ workspaceId }),
      channelId,
      storageObjectId: uploaded.object_id,
      mimeType,
      title: basename(path),
      sizeBytes: content.byteLength,
    });
  }

  async createReaction(workspaceId: string, target: string, emoji: string) {
    const [targetType, targetId] = target.includes(':') ? target.split(':', 2) : ['', target];
    if (!targetType || !targetId) throw new Error('--target must use <target-type>:<target-id>, for example message:<id>');
    return await createFlightDeckPgReaction({ ...this.base({ workspaceId }), targetType, targetId, emoji: normalizeEmoji(emoji) });
  }

  async pollEvents(workspaceId: string, cursor?: string | null, limit?: number) {
    return await fetchFlightDeckPgEvents({ ...this.base({ workspaceId }), cursor, limit });
  }

  async listMembers(workspaceId: string) {
    return await fetchFlightDeckPgWorkspaceMembers(this.base({ workspaceId }));
  }

  private base(extra: { workspaceId: string; taskId?: string }) {
    return {
      backendBaseUrl: this.config.towerUrl,
      workspaceId: extra.workspaceId,
      taskId: extra.taskId ?? '',
      appNpub: this.config.appNpub,
      botIdentity: this.config.botIdentity,
    };
  }

  private async callWingmanHelper(action: string, params: Record<string, unknown> = {}) {
    const response = await this.fetchImpl(`${this.config.wingmanUrl}/api/mcp/wingman/flightdeck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: this.config.sessionId, action, ...params }),
    });
    return await readJsonResponse(response, 'Autopilot Flight Deck context helper');
  }

  private async signedJson(method: string, path: string, query?: Record<string, string | number | null | undefined>, body?: unknown) {
    const url = new URL(path, this.config.towerUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && String(value).trim()) url.searchParams.set(key, String(value));
    }
    const authorization = buildAuthHeader(url.toString(), method, this.config.botIdentity.botSecret, body);
    const response = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: authorization,
        'x-flightdeck-pg-app-npub': this.config.appNpub,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return await readJsonResponse(response, `${method} ${path}`);
  }
}

async function readJsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  let payload: unknown = {};
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : response.statusText;
    throw new Error(`${label} failed (${response.status}): ${error}`);
  }
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload };
}

function normalizeEmoji(emoji: string): string {
  const map: Record<string, string> = {
    '+1': 'thumbs_up',
    ':thumbs_up:': 'thumbs_up',
    thumbs_up: 'thumbs_up',
    smile: 'smile',
    heart: 'heart',
    eyes: 'eyes',
    party: 'party',
    white_check_mark: 'white_check_mark',
  };
  return map[emoji] ?? emoji;
}
