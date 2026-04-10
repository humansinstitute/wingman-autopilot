/**
 * API route handlers for session and archive endpoints.
 * Extracted from server.ts to reduce file size.
 */

import { normalize, join, resolve as resolvePath } from "node:path";
import type { AgentType } from "../config";
import type { ProcessManager, SessionOrigin, SessionSnapshot } from "../agents/process-manager";
import type { RequestAuthContext } from "../auth/request-context";
import type { AccessAction } from "../auth/access-control";
import type { WorkspaceScope } from "../workspaces/workspace-scope";
import { normaliseNpub, deriveNpubSegment } from "../identity/npub-utils";
import { generateIdentityAlias } from "../identity/identity-alias";
import { validateInput, ArchiveListOptionsSchema } from "../utils/validation";
import { InsufficientBalanceError } from "../storage/identity-user-store";
import type { messageStore as MessageStoreInstance, StoredMessage, StoredSessionRecord } from "../storage/message-store";
import type { sessionArchiveStore as SessionArchiveStoreInstance } from "../storage/session-archive-store";
import type { ForkToWorktreeInput } from "../sessions/fork-to-worktree";
import { deliverSessionAgentMessage } from "./session-agent-message";
import {
  isAgentManagedByMetadataOrOrigin,
  isCreditsBillingSession,
  normaliseSessionMetadata,
  resolveSessionChargeNpub,
  type SessionMetadata,
} from "../sessions/session-metadata";
import {
  buildDelegatedWorkspaceScope,
  createOwnerScopedAuthContext,
  DelegationScopes,
  getDelegatedBillingNpub,
  resolveOwnerAccess,
} from "../auth/delegation-access";
import type { WorkspaceDelegationStore } from "../storage/workspace-delegation-store";
import type { NightWatchStartOptions } from "../nightwatch/nightwatch-start-config";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

// ---------- Types shared with server.ts ----------

type BalanceRequirementOptions = {
  feature: string;
  minimum?: number;
  message?: string;
  signinMessage?: string;
};

type SessionWorkspaceRequest =
  | { mode: "worktree"; name: string }
  | null;

export type IdentitySummary = {
  npub: string | null;
  normalizedNpub: string | null;
  segment: string;
  alias: string;
  ports: number[];
  balance: number;
  sessionIds: string[];
  activeSessionIds: string[];
  lastSeenAt: string | null;
  dataRoot: string;
  logsRoot: string;
  attachmentsRoot: string;
  imagesRoot: string;
};

// ---------- Context supplied by server.ts ----------

export interface SessionApiContext {
  manager: ProcessManager;
  adminNpub: string | null;
  agentHost: string;

  // Stores
  messageStore: typeof MessageStoreInstance;
  sessionArchiveStore: typeof SessionArchiveStoreInstance;
  identityUserStore: {
    touch: (npub: string) => { balance?: number };
    debit: (npub: string, amount: number) => number;
    credit: (npub: string, amount: number) => number;
    listUsers: () => Array<{ normalizedNpub: string; ports: number[]; balance: number }>;
    ensurePortsFor: (npub: string) => number[];
    getByNormalized: (normalizedNpub: string) => { ports?: number[]; balance?: number } | null;
  };
  promptQueueStore: {
    getSessionQueue: (id: string) => unknown[];
    addPrompt: (id: string, options: { content: string }) => unknown;
    updatePromptContent: (sessionId: string, promptId: string, content: string) => boolean;
    deletePromptById: (sessionId: string, promptId: string) => boolean;
    getNextQueuedPrompt: (sessionId: string) => { content: string } | null;
    removeNextPrompt: (sessionId: string) => void;
    getQueueCount: (sessionId: string) => number;
  };
  artifactsStore: {
    listBySession: (sessionId: string) => unknown[];
  };

  // Directory paths
  userIdentityRoot: string;
  attachmentRoot: string;
  imageRoot: string;

  // Constants
  MESSAGE_COST_SATS: number;

  // Auth helpers
  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  ensureViewerHasBalance: (authContext: RequestAuthContext, options: BalanceRequirementOptions) => Response | { balance: number };
  shouldRequireBalanceForAgent: (agent: AgentType) => Promise<boolean>;
  resolveWorkspace: (context?: RequestAuthContext) => WorkspaceScope;

  // Session helpers
  serializeSession: (session: SessionSnapshot) => Record<string, unknown>;
  sessionBelongsToViewer: (sessionNpub: string | null | undefined, viewerNormalizedNpub: string | null, viewerIsAdmin: boolean) => boolean;
  getViewerNormalizedNpub: (authContext: RequestAuthContext) => string | null;
  buildIdentitySummaries: (sessions: SessionSnapshot[], viewerNpub: string | null, options?: { includeAll?: boolean }) => IdentitySummary[];
  createSessionSubscribeResponse: (npub: string) => Response;
  handleSessionEvents: (sessionId: string, request: Request) => Response | Promise<Response>;
  syncSessionMessages: (sessionId: string, force?: boolean) => Promise<unknown[]>;
  waitForMessageUpdate: (sessionId: string, initialCount: number, timeoutMs?: number) => Promise<unknown[]>;
  scheduleSessionArchive: (sessionId: string, manager: ProcessManager) => void;
  cancelPendingArchive: (sessionId: string) => void;

  // Agent helpers
  isAgentType: (value: string) => value is AgentType;
  normaliseSessionNameInput: (value: unknown) => string | null;
  parseSessionWorkspaceRequest: (input: unknown) => SessionWorkspaceRequest;
  resolveSessionWorkingDirectory: (
    directoryInput: string | undefined,
    workspace: SessionWorkspaceRequest,
    workspaceScopeOverride?: WorkspaceScope,
  ) => Promise<string>;
  parseSessionOriginInput: (value: unknown) => SessionOrigin | null;
  parseNightWatchStartOptions: (value: unknown) => NightWatchStartOptions | null;
  buildAgentUrl: (host: string, port: number, path: string) => string | URL;
  enableNightWatch: (sessionId: string, options?: Omit<NightWatchStartOptions, "enabled">) => unknown;

  // Queue helpers
  queueDispatchInFlight: Set<string>;
  maybeAutoDispatchQueuedPrompt: (session: SessionSnapshot | null) => void;
  dispatchNextQueuedPromptForSession: (session: SessionSnapshot, userNpub: string | null) => Promise<Record<string, unknown>>;

  // Fork-to-worktree helpers
  validateForkInput: (payload: unknown) => ForkToWorktreeInput;
  getRecentMessages: (messageStore: typeof MessageStoreInstance, sessionId: string, count?: number) => StoredMessage[];
  formatMessagesAsContext: (messages: StoredMessage[]) => string;
  createGitWorktree: (options: { directory: string; branch: string; startPoint: string | null }) => Promise<{ path: string }>;
  workspaceDelegationStore: WorkspaceDelegationStore;

  // Access action
  AccessActions: { SessionsManage: AccessAction };
}

const isDelegatedBotAuth = (authContext: RequestAuthContext): boolean => {
  return Boolean(
    authContext.authMethod === "nip98" &&
    authContext.delegatedByBot &&
    normaliseNpub(authContext.subjectNpub ?? authContext.npub ?? null) &&
    normaliseNpub(authContext.delegatedOwnerNpub ?? null),
  );
};

const isProgrammaticCaller = (authContext: RequestAuthContext): boolean => {
  return authContext.authMethod === "nip98" && !!authContext.npub;
};

const isAuthorizedCaller = (authContext: RequestAuthContext): boolean => {
  if (authContext.session) return true;
  if (isProgrammaticCaller(authContext)) return true;
  return false;
};

const buildProgrammaticOrigin = (authContext: RequestAuthContext): SessionOrigin => {
  if (authContext.delegatedByBot) {
    const actorNpub = normaliseNpub(authContext.actorNpub ?? null) ?? "unknown-bot";
    return { type: "delegate-bot", id: actorNpub, label: actorNpub };
  }
  const callerNpub = normaliseNpub(authContext.npub ?? null) ?? "unknown-cli";
  return { type: "cli", id: callerNpub, label: callerNpub };
};

const resolveSelfSpaceViewerNpub = (
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): string | null => {
  if (isDelegatedBotAuth(authContext)) {
    return normaliseNpub(authContext.delegatedOwnerNpub ?? null);
  }
  return ctx.getViewerNormalizedNpub(authContext);
};

const buildSelfSpaceAuthContext = (
  authContext: RequestAuthContext,
  ownerNpub: string | null,
): RequestAuthContext => {
  if (!ownerNpub || !isDelegatedBotAuth(authContext)) {
    return authContext;
  }
  return createOwnerScopedAuthContext(authContext, ownerNpub);
};

const recordLiveSession = async (
  ctx: SessionApiContext,
  session: SessionSnapshot,
): Promise<void> => {
  ctx.messageStore.recordSession({
    id: session.id,
    agent: session.agent,
    startedAt: session.startedAt,
    name: session.name,
    npub: session.npub,
    port: session.port,
    pid: session.pid,
    workingDirectory: session.workingDirectory,
    command: session.command,
    runtimeStatus: session.agentRuntimeStatus ?? null,
    origin: session.origin ?? null,
    pm2Name: session.pm2Name,
    targetFile: session.targetFile,
    metadata: session.metadata,
  });
  await ctx.syncSessionMessages(session.id, true);
};

const resolveOwnedLiveSession = (
  requestedId: string,
  sessions: SessionSnapshot[],
  viewerNormalizedNpub: string | null,
  viewerIsAdmin: boolean,
  ctx: SessionApiContext,
): { session: SessionSnapshot | null; resolvedId: string; error: Response | null } => {
  const ownedSessions = sessions.filter((session) =>
    ctx.sessionBelongsToViewer(session.npub ?? null, viewerNormalizedNpub, viewerIsAdmin),
  );
  const exactMatch = ownedSessions.find((session) => session.id === requestedId);
  if (exactMatch) {
    return { session: exactMatch, resolvedId: exactMatch.id, error: null };
  }

  const prefixMatches = ownedSessions.filter((session) => session.id.startsWith(requestedId));
  if (prefixMatches.length === 1) {
    const match = prefixMatches[0]!;
    return { session: match, resolvedId: match.id, error: null };
  }

  if (prefixMatches.length > 1) {
    return {
      session: null,
      resolvedId: requestedId,
      error: Response.json(
        {
          error: "Ambiguous session id",
          matches: prefixMatches.map((session) => ({
            id: session.id,
            name: session.name ?? null,
          })),
        },
        { status: 409 },
      ),
    };
  }

  return { session: null, resolvedId: requestedId, error: null };
};

const resolveOwnedStoredSession = (
  requestedId: string,
  viewerNormalizedNpub: string | null,
  viewerIsAdmin: boolean,
  ctx: SessionApiContext,
) => {
  const ownedSessions = ctx.messageStore
    .listSessions()
    .filter((session) => ctx.sessionBelongsToViewer(session.npub ?? null, viewerNormalizedNpub, viewerIsAdmin));
  const exactMatch = ownedSessions.find((session) => session.id === requestedId);
  if (exactMatch) {
    return { session: exactMatch, resolvedId: exactMatch.id, error: null };
  }

  const prefixMatches = ownedSessions.filter((session) => session.id.startsWith(requestedId));
  if (prefixMatches.length === 1) {
    const match = prefixMatches[0]!;
    return { session: match, resolvedId: match.id, error: null };
  }

  if (prefixMatches.length > 1) {
    return {
      session: null,
      resolvedId: requestedId,
      error: Response.json(
        {
          error: "Ambiguous session id",
          matches: prefixMatches.map((session) => ({
            id: session.id,
            name: session.name ?? null,
          })),
        },
        { status: 409 },
      ),
    };
  }

  return { session: null, resolvedId: requestedId, error: null };
};

const parseSessionMetadataUpdateInput = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const candidate =
    record.metadata !== undefined
      ? record.metadata
      : record;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const metadataPatch = candidate as Record<string, unknown>;
  return Object.keys(metadataPatch).length > 0 ? metadataPatch : null;
};

const buildSessionMetadataResponse = (
  sessionId: string,
  metadata: SessionMetadata | null | undefined,
  ownerNpub?: string,
) => {
  const payload: Record<string, unknown> = {
    id: sessionId,
    metadata: metadata ?? null,
  };
  if (ownerNpub) {
    payload.ownerNpub = ownerNpub;
  }
  return payload;
};

const persistStoredSessionMetadata = (
  ctx: SessionApiContext,
  storedSession: StoredSessionRecord,
  metadataPatch: Record<string, unknown>,
): SessionMetadata => {
  const mergedMetadata = normaliseSessionMetadata({
    ...(storedSession.metadata ?? {}),
    ...metadataPatch,
  });
  const parsedCommand = storedSession.command
    ? (() => {
        try {
          const parsed = JSON.parse(storedSession.command);
          return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
            ? parsed as string[]
            : undefined;
        } catch {
          return undefined;
        }
      })()
    : undefined;

  ctx.messageStore.recordSession({
    id: storedSession.id,
    agent: storedSession.agent,
    startedAt: storedSession.startedAt,
    name: storedSession.name ?? undefined,
    npub: storedSession.npub ?? undefined,
    port: storedSession.port ?? undefined,
    pid: storedSession.pid ?? undefined,
    pm2Name: storedSession.pm2Name ?? undefined,
    logsDir: storedSession.logsDir ?? undefined,
    workingDirectory: storedSession.workingDirectory ?? undefined,
    command: parsedCommand,
    runtimeStatus: storedSession.runtimeStatus ?? null,
    origin: storedSession.origin ?? null,
    model: storedSession.model ?? undefined,
    targetFile: storedSession.targetFile ?? undefined,
    metadata: mergedMetadata,
  });

  return mergedMetadata;
};

const parseStoredCommand = (storedCommand: string | null): string[] | undefined => {
  if (!storedCommand) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(storedCommand);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? parsed as string[]
      : undefined;
  } catch {
    return undefined;
  }
};

const serializeStoredSession = (
  storedSession: StoredSessionRecord,
): Record<string, unknown> => ({
  id: storedSession.id,
  agent: storedSession.agent,
  status: storedSession.runtimeStatus ?? "running",
  name: storedSession.name,
  npub: storedSession.npub,
  port: storedSession.port,
  pid: storedSession.pid,
  startedAt: storedSession.startedAt,
  command: parseStoredCommand(storedSession.command) ?? [],
  workingDirectory: storedSession.workingDirectory,
  origin: storedSession.origin,
  targetFile: storedSession.targetFile,
  metadata: storedSession.metadata,
});

const rehydrateStoredSession = (
  ctx: SessionApiContext,
  storedSession: StoredSessionRecord | null,
): SessionSnapshot | null => {
  if (!storedSession) {
    return null;
  }
  if (!storedSession.port || !storedSession.workingDirectory || !ctx.isAgentType(storedSession.agent)) {
    return null;
  }
  if (typeof ctx.manager.rehydrateSession !== "function") {
    return null;
  }

  return ctx.manager.rehydrateSession({
    id: storedSession.id,
    agent: storedSession.agent,
    port: storedSession.port,
    name: storedSession.name ?? storedSession.id,
    startedAt: storedSession.startedAt,
    workingDirectory: storedSession.workingDirectory,
    command: parseStoredCommand(storedSession.command),
    pid: storedSession.pid ?? undefined,
    npub: storedSession.npub ?? undefined,
    agentRuntimeStatus: storedSession.runtimeStatus ?? null,
    origin: storedSession.origin ?? null,
    pm2Name: storedSession.pm2Name ?? undefined,
    targetFile: storedSession.targetFile ?? undefined,
    metadata: storedSession.metadata,
  });
};

type OwnerSessionRouteMatch = {
  ownerNpub: string;
  remainder: string[];
};

type OwnerArchiveRouteMatch = {
  ownerNpub: string;
  remainder: string[];
};

const matchOwnerSessionRoute = (pathname: string): OwnerSessionRouteMatch | null => {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0] !== "api" || parts[1] !== "owners") {
    return null;
  }
  const ownerNpub = normaliseNpub(parts[2] ?? null);
  if (!ownerNpub || parts[3] !== "sessions") {
    return null;
  }
  return {
    ownerNpub,
    remainder: parts.slice(4),
  };
};

const matchOwnerArchiveRoute = (pathname: string): OwnerArchiveRouteMatch | null => {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0] !== "api" || parts[1] !== "owners") {
    return null;
  }
  const ownerNpub = normaliseNpub(parts[2] ?? null);
  if (!ownerNpub || parts[3] !== "archive") {
    return null;
  }
  return {
    ownerNpub,
    remainder: parts.slice(4),
  };
};

const buildManagedSessionMetadata = (
  authContext: RequestAuthContext,
  ownerNpub: string,
  chargeToNpub: string | null,
  delegateRelationshipId?: string | null,
  existingMetadata?: Record<string, unknown> | null,
) => ({
  ...(existingMetadata ?? {}),
  ownerNpub,
  createdByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
  lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
  chargeToNpub: chargeToNpub ?? undefined,
  delegateRelationshipId: delegateRelationshipId ?? undefined,
});

const resolveOwnerSessionAccess = (
  authContext: RequestAuthContext,
  ownerNpub: string,
  scope: string,
  ctx: SessionApiContext,
) =>
  resolveOwnerAccess(
    authContext,
    ownerNpub,
    ctx.workspaceDelegationStore.findActiveDelegation.bind(ctx.workspaceDelegationStore),
    scope,
  );

const resolveOwnerSessionScope = (method: HttpMethod, remainder: string[]): string => {
  if (remainder.length === 0) {
    return method === "POST" ? DelegationScopes.SessionsCreate : DelegationScopes.SessionsRead;
  }
  const subresource = remainder[1];
  if (!subresource) {
    return method === "GET" || method === "HEAD" ? DelegationScopes.SessionsRead : DelegationScopes.SessionsManage;
  }
  if (subresource === "messages") {
    return method === "POST" ? DelegationScopes.SessionsMessage : DelegationScopes.SessionsRead;
  }
  if (subresource === "metadata") {
    return method === "GET" || method === "HEAD" ? DelegationScopes.SessionsRead : DelegationScopes.SessionsManage;
  }
  if (subresource === "history" || subresource === "events") {
    return DelegationScopes.SessionsRead;
  }
  return DelegationScopes.SessionsManage;
};

const archivedSessionBelongsToOwner = (
  archivedSession: { npub: string | null; metadata?: { ownerNpub?: unknown } | null },
  ownerNpub: string,
  ctx: SessionApiContext,
): boolean => {
  const metadataOwnerNpub =
    archivedSession.metadata &&
    typeof archivedSession.metadata === "object" &&
    typeof archivedSession.metadata.ownerNpub === "string"
      ? normaliseNpub(archivedSession.metadata.ownerNpub)
      : null;
  if (metadataOwnerNpub) {
    return metadataOwnerNpub === ownerNpub;
  }
  return ctx.sessionBelongsToViewer(archivedSession.npub, ownerNpub, false);
};

/**
 * Main handler for /api/sessions/* and /api/archive/* routes.
 * Returns null if the route doesn't match, otherwise returns a Response.
 */
export async function handleSessionApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;

  const ownerArchiveRoute = matchOwnerArchiveRoute(pathname);
  if (ownerArchiveRoute) {
    const requiredScope = method === "DELETE" ? DelegationScopes.SessionsManage : DelegationScopes.SessionsRead;
    const ownerArchiveAccess = resolveOwnerSessionAccess(
      authContext,
      ownerArchiveRoute.ownerNpub,
      requiredScope,
      ctx,
    );
    if (!ownerArchiveAccess) {
      return Response.json({ error: "Delegation required" }, { status: 403 });
    }
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
    if (denied) return denied;

    if (ownerArchiveRoute.remainder.length === 0 && method === "GET") {
      try {
        const validatedOptions = validateInput(ArchiveListOptionsSchema, {
          limit: url.searchParams.get("limit"),
          offset: url.searchParams.get("offset"),
          filter: url.searchParams.get("filter"),
        });
        const allArchivedSessions = ctx.sessionArchiveStore.listArchivedSessions({
          limit: ctx.sessionArchiveStore.getArchiveCount(),
          offset: 0,
          filter: typeof validatedOptions.filter === "string" ? validatedOptions.filter : undefined,
        });
        const ownerArchivedSessions = allArchivedSessions.filter((session) =>
          archivedSessionBelongsToOwner(session, ownerArchiveRoute.ownerNpub, ctx),
        );
        const offset = typeof validatedOptions.offset === "number" ? validatedOptions.offset : 0;
        const limit = typeof validatedOptions.limit === "number" ? validatedOptions.limit : 50;
        const archivedSessions = ownerArchivedSessions.slice(offset, offset + limit);
        return Response.json({
          ownerNpub: ownerArchiveRoute.ownerNpub,
          sessions: archivedSessions,
          total: ownerArchivedSessions.length,
          limit,
          offset,
        });
      } catch {
        return Response.json({ error: "Invalid request parameters" }, { status: 400 });
      }
    }

    const archiveId = ownerArchiveRoute.remainder[0];
    if (!archiveId) {
      return Response.json({ error: "Session ID required" }, { status: 400 });
    }
    const archivedSession = ctx.sessionArchiveStore.getArchivedSession(archiveId);
    if (!archivedSession || !archivedSessionBelongsToOwner(archivedSession, ownerArchiveRoute.ownerNpub, ctx)) {
      return Response.json({ error: "Archived session not found" }, { status: 404 });
    }

    if (ownerArchiveRoute.remainder[1] === "messages" && method === "GET") {
      const messages = ctx.sessionArchiveStore.getArchivedMessages(archiveId);
      return Response.json({ ownerNpub: ownerArchiveRoute.ownerNpub, sessionId: archiveId, messages });
    }

    if (ownerArchiveRoute.remainder.length === 1 && method === "GET") {
      const messages = ctx.sessionArchiveStore.getArchivedMessages(archiveId);
      return Response.json({ ownerNpub: ownerArchiveRoute.ownerNpub, session: archivedSession, messages });
    }

    if (ownerArchiveRoute.remainder.length === 1 && method === "DELETE") {
      const deleted = ctx.sessionArchiveStore.deleteArchivedSession(archiveId);
      if (!deleted) {
        return Response.json({ error: "Archived session not found" }, { status: 404 });
      }
      return Response.json({ ownerNpub: ownerArchiveRoute.ownerNpub, id: archiveId, deleted: true });
    }
  }

  // ──────────────────────────────────────────────
  //  Archive API endpoints
  // ──────────────────────────────────────────────

  if (pathname === "/api/archive" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
    if (denied) return denied;

    try {
      const validatedOptions = validateInput(ArchiveListOptionsSchema, {
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
        filter: url.searchParams.get("filter"),
      });

      const sessions = ctx.sessionArchiveStore.listArchivedSessions(validatedOptions as { limit?: number; offset?: number; filter?: string });
      const total = ctx.sessionArchiveStore.getArchiveCount();
      return Response.json({ sessions, total, limit: validatedOptions.limit, offset: validatedOptions.offset });
    } catch (error) {
      return Response.json({ error: "Invalid request parameters" }, { status: 400 });
    }
  }

  if (pathname.startsWith("/api/archive/") && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
    if (denied) return denied;

    const archiveParts = pathname.split("/").filter(Boolean);
    const sessionId = archiveParts[2];
    if (!sessionId) {
      return Response.json({ error: "Session ID required" }, { status: 400 });
    }

    // GET /api/archive/:id/messages
    if (archiveParts[3] === "messages") {
      const messages = ctx.sessionArchiveStore.getArchivedMessages(sessionId);
      return Response.json({ sessionId, messages });
    }

    // GET /api/archive/:id
    const session = ctx.sessionArchiveStore.getArchivedSession(sessionId);
    if (!session) {
      return Response.json({ error: "Archived session not found" }, { status: 404 });
    }
    const messages = ctx.sessionArchiveStore.getArchivedMessages(sessionId);
    return Response.json({ session, messages });
  }

  if (pathname.startsWith("/api/archive/") && method === "DELETE") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
    if (denied) return denied;

    const archiveParts = pathname.split("/").filter(Boolean);
    const sessionId = archiveParts[2];
    if (!sessionId) {
      return Response.json({ error: "Session ID required" }, { status: 400 });
    }
    const deleted = ctx.sessionArchiveStore.deleteArchivedSession(sessionId);
    if (!deleted) {
      return Response.json({ error: "Archived session not found" }, { status: 404 });
    }
    return Response.json({ id: sessionId, deleted: true });
  }

  // ──────────────────────────────────────────────
  //  SSE stream for live session list updates
  // ──────────────────────────────────────────────

  if (pathname === "/api/sessions/subscribe" && method === "GET") {
    const viewerNpub = ctx.getViewerNormalizedNpub(authContext);
    if (!viewerNpub) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }
    return ctx.createSessionSubscribeResponse(viewerNpub);
  }

  // ──────────────────────────────────────────────
  //  Delegate session API for owner-linked bot identities
  // ──────────────────────────────────────────────

  if (pathname === "/api/delegate-sessions" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
    if (denied) return denied;
    if (!isProgrammaticCaller(authContext)) {
      return Response.json({ error: "nip98-auth-required" }, { status: 403 });
    }
    const viewerNormalizedNpub = normaliseNpub(authContext.delegatedOwnerNpub ?? null);
    if (!viewerNormalizedNpub) {
      return Response.json({ error: "legacy-delegate-owner-not-configured" }, { status: 403 });
    }
    const sessions = ctx.manager
      .listSessions()
      .filter((session) => ctx.sessionBelongsToViewer(session.npub ?? null, viewerNormalizedNpub, false))
      .map(ctx.serializeSession);
    return Response.json({ sessions });
  }

  if (pathname === "/api/delegate-sessions" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
    if (denied) return denied;
    if (!isProgrammaticCaller(authContext)) {
      return Response.json({ error: "nip98-auth-required" }, { status: 403 });
    }

    try {
      const payload = (await request.json()) as Record<string, unknown> | null;
      const agent = typeof payload?.agent === "string" ? payload.agent.toLowerCase() : "";
      if (!ctx.isAgentType(agent)) {
        return Response.json({ error: "Invalid agent selection" }, { status: 400 });
      }
      const requiresBalance = await ctx.shouldRequireBalanceForAgent(agent);
      if (requiresBalance) {
        const balanceCheck = ctx.ensureViewerHasBalance(authContext, {
          feature: "start an agent session",
          message: "Add sats to your balance to start an agent session.",
        });
        if (balanceCheck instanceof Response) return balanceCheck;
      }

      const directoryInput = typeof payload?.directory === "string" ? payload.directory : undefined;
      const rawName =
        payload && typeof payload === "object" && payload !== null
          ? payload.name
          : null;
      let workspace: SessionWorkspaceRequest = null;
      try {
        workspace =
          payload && typeof payload === "object" && payload !== null
            ? ctx.parseSessionWorkspaceRequest(payload.workspace)
            : null;
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      const sessionName = ctx.normaliseSessionNameInput(rawName);
      let workingDirectory: string;
      try {
        workingDirectory = await ctx.resolveSessionWorkingDirectory(directoryInput, workspace);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      const rawTargetFile = typeof payload?.targetFile === "string" ? payload.targetFile.trim() : "";
      let targetFile: string | undefined;
      if (rawTargetFile.length > 0) {
        targetFile = rawTargetFile.startsWith("/")
          ? rawTargetFile
          : resolvePath(workingDirectory, rawTargetFile);
      }
      const delegatedMetadata =
        payload?.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
          ? payload.metadata as Record<string, unknown>
          : null;
      const ownerNpub = normaliseNpub(authContext.delegatedOwnerNpub ?? null);
      if (!ownerNpub) {
        return Response.json({ error: "legacy-delegate-owner-not-configured" }, { status: 403 });
      }
      const session = await ctx.manager.createSession(
        agent,
        workingDirectory,
        sessionName ?? undefined,
        buildProgrammaticOrigin(authContext),
        targetFile,
        ownerNpub ?? undefined,
        {
          ...(delegatedMetadata ?? {}),
          AGENT: true,
          ownerNpub,
          createdByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
          lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
          chargeToNpub: ownerNpub,
        },
      );
      await recordLiveSession(ctx, session);
      return Response.json(ctx.serializeSession(session), { status: 201 });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  }

  if (pathname.startsWith("/api/delegate-sessions/")) {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
    if (denied) return denied;
    if (!isProgrammaticCaller(authContext)) {
      return Response.json({ error: "nip98-auth-required" }, { status: 403 });
    }

    const parts = pathname.split("/");
    const id = parts[3];
    if (!id) {
      return Response.json({ error: "Session id required" }, { status: 400 });
    }

    const viewerNormalizedNpub = normaliseNpub(authContext.delegatedOwnerNpub ?? null);
    if (!viewerNormalizedNpub) {
      return Response.json({ error: "legacy-delegate-owner-not-configured" }, { status: 403 });
    }

    const delegatedResolution = resolveOwnedLiveSession(
      id,
      ctx.manager.listSessions(),
      viewerNormalizedNpub,
      false,
      ctx,
    );
    if (delegatedResolution.error) return delegatedResolution.error;
    const ownedSession = delegatedResolution.session;
    const resolvedId = delegatedResolution.resolvedId;

    if (method === "GET" && parts.length === 4) {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(ctx.serializeSession(ownedSession));
    }

    if (method === "DELETE" && parts.length === 4) {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
      const session = await ctx.manager.stopSession(resolvedId);
      if (!session) return Response.json({ error: "Not found" }, { status: 404 });
      ctx.scheduleSessionArchive(resolvedId, ctx.manager);
      return Response.json(ctx.serializeSession(session));
    }

    if (parts[4] === "messages") {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });

      if (method === "GET") {
        const refresh = url.searchParams.get("refresh") === "true";
        const messages = await (
          refresh ? ctx.syncSessionMessages(resolvedId, true) : ctx.messageStore.listSessionMessages(resolvedId)
        );
        return Response.json({ id: resolvedId, messages });
      }

      if (method === "POST") {
        return handleDelegatedQueuedMessage(request, resolvedId, ownedSession, authContext, ctx);
      }
    }
  }

  const ownerRoute = matchOwnerSessionRoute(pathname);
  if (ownerRoute) {
    const ownerSessionsAccess = resolveOwnerSessionAccess(
      authContext,
      ownerRoute.ownerNpub,
      resolveOwnerSessionScope(method, ownerRoute.remainder),
      ctx,
    );
    if (!ownerSessionsAccess) {
      return Response.json({ error: "Delegation required" }, { status: 403 });
    }

    const targetOwnerNpub = ownerSessionsAccess.ownerNpub;
    const chargeToNpub = getDelegatedBillingNpub(authContext, targetOwnerNpub, ownerSessionsAccess.delegation);
    const billingAuthContext =
      chargeToNpub
        ? { ...authContext, npub: chargeToNpub, targetOwnerNpub }
        : authContext;

    if (ownerRoute.remainder.length === 0 && method === "GET") {
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
      if (denied) return denied;
      const sessions = ctx.manager
        .listSessions()
        .filter((session) => ctx.sessionBelongsToViewer(session.npub ?? null, normaliseNpub(targetOwnerNpub), false))
        .map(ctx.serializeSession);
      return Response.json({ ownerNpub: targetOwnerNpub, sessions });
    }

    if (ownerRoute.remainder.length === 0 && method === "POST") {
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
      if (denied) return denied;

      try {
        const payload = (await request.json()) as Record<string, unknown> | null;
        const agent = typeof payload?.agent === "string" ? payload.agent.toLowerCase() : "";
        if (!ctx.isAgentType(agent)) {
          return Response.json({ error: "Invalid agent selection" }, { status: 400 });
        }
        const requiresBalance = await ctx.shouldRequireBalanceForAgent(agent);
        if (requiresBalance) {
          const balanceCheck = ctx.ensureViewerHasBalance(billingAuthContext, {
            feature: "start an agent session",
            message: "Add sats to your balance to start an agent session.",
          });
          if (balanceCheck instanceof Response) return balanceCheck;
        }

        const directoryInput = typeof payload?.directory === "string" ? payload.directory : undefined;
        const rawName = payload && typeof payload === "object" && payload !== null ? payload.name : null;
        let workspace: SessionWorkspaceRequest = null;
        try {
          workspace =
            payload && typeof payload === "object" && payload !== null
              ? ctx.parseSessionWorkspaceRequest(payload.workspace)
              : null;
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 400 });
        }
        const sessionName = ctx.normaliseSessionNameInput(rawName);
        const ownerAuthContext = createOwnerScopedAuthContext(authContext, targetOwnerNpub);
        const delegatedWorkspace = buildDelegatedWorkspaceScope(
          ctx.resolveWorkspace(ownerAuthContext),
          ownerSessionsAccess.delegation,
        );
        let workingDirectory: string;
        try {
          workingDirectory = await ctx.resolveSessionWorkingDirectory(
            directoryInput,
            workspace,
            delegatedWorkspace,
          );
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 400 });
        }
        const rawTargetFile = typeof payload?.targetFile === "string" ? payload.targetFile.trim() : "";
        let targetFile: string | undefined;
        if (rawTargetFile.length > 0) {
          targetFile = rawTargetFile.startsWith("/") ? rawTargetFile : resolvePath(workingDirectory, rawTargetFile);
        }
        const delegatedMetadata =
          payload?.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
            ? payload.metadata as Record<string, unknown>
            : null;
        const session = await ctx.manager.createSession(
          agent,
          workingDirectory,
          sessionName ?? undefined,
          buildProgrammaticOrigin(authContext),
          targetFile,
          targetOwnerNpub,
          {
            ...buildManagedSessionMetadata(
              authContext,
              targetOwnerNpub,
              chargeToNpub,
              ownerSessionsAccess.delegation?.id ?? null,
              delegatedMetadata,
            ),
            AGENT: true,
          },
        );
        await recordLiveSession(ctx, session);
        return Response.json(ctx.serializeSession(session), { status: 201 });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 500 });
      }
    }

    const id = ownerRoute.remainder[0];
    if (!id) {
      return Response.json({ error: "Session id required" }, { status: 400 });
    }
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
    if (denied) return denied;

    const sessionResolution = resolveOwnedLiveSession(
      id,
      ctx.manager.listSessions(),
      normaliseNpub(targetOwnerNpub),
      false,
      ctx,
    );
    if (sessionResolution.error) return sessionResolution.error;
    const ownedSession = sessionResolution.session;
    let resolvedId = sessionResolution.resolvedId;
    const storedSessionResolution =
      !ownedSession
        ? resolveOwnedStoredSession(id, normaliseNpub(targetOwnerNpub), false, ctx)
        : null;
    if (storedSessionResolution?.error) return storedSessionResolution.error;
    const storedOwnedSession = storedSessionResolution?.session ?? null;
    const recoveredSession = !ownedSession ? rehydrateStoredSession(ctx, storedOwnedSession) : null;
    const liveOwnedSession = ownedSession ?? recoveredSession;
    if (!ownedSession && storedOwnedSession) {
      resolvedId = storedSessionResolution?.resolvedId ?? resolvedId;
    }

    if (method === "GET" && ownerRoute.remainder.length === 1) {
      if (liveOwnedSession) {
        return Response.json(ctx.serializeSession(liveOwnedSession));
      }
      if (storedOwnedSession) {
        return Response.json(serializeStoredSession(storedOwnedSession));
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (method === "PATCH" && ownerRoute.remainder.length === 1) {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }
      if (!payload || typeof payload !== "object") {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }
      const desiredNameValue = (payload as Record<string, unknown>).name;
      const desiredName = typeof desiredNameValue === "string" ? desiredNameValue : "";
      const trimmedName = desiredName.trim();
      if (!trimmedName) {
        return Response.json({ error: "Session name is required" }, { status: 400 });
      }
      const renamed = ctx.manager.renameSession(resolvedId, trimmedName);
      if (!renamed) return Response.json({ error: "Not found" }, { status: 404 });
      ctx.manager.updateSessionMetadata(resolvedId, {
        lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
      });
      await recordLiveSession(ctx, ctx.manager.getSession(resolvedId) ?? renamed);
      return Response.json(ctx.serializeSession(ctx.manager.getSession(resolvedId) ?? renamed));
    }

    if (method === "DELETE" && ownerRoute.remainder.length === 1) {
      if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
      ctx.manager.updateSessionMetadata(resolvedId, {
        lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
      });
      const session = await ctx.manager.stopSession(resolvedId);
      if (!session) return Response.json({ error: "Not found" }, { status: 404 });
      ctx.scheduleSessionArchive(resolvedId, ctx.manager);
      return Response.json(ctx.serializeSession(session));
    }

    const subresource = ownerRoute.remainder[1];
    if (subresource === "metadata") {
      if (method === "GET") {
        const metadata = liveOwnedSession?.metadata ?? storedOwnedSession?.metadata;
        if (!metadata) return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json(
          buildSessionMetadataResponse(resolvedId, metadata, targetOwnerNpub),
        );
      }
      if (method === "PATCH") {
        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
        }
        const metadataPatch = parseSessionMetadataUpdateInput(payload);
        if (!metadataPatch) {
          return Response.json({ error: "Invalid metadata payload" }, { status: 400 });
        }
        const persistedPatch = {
          ...metadataPatch,
          lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
        };
        const updated = liveOwnedSession
          ? ctx.manager.updateSessionMetadata(resolvedId, persistedPatch)
          : null;
        if (liveOwnedSession && !updated) return Response.json({ error: "Not found" }, { status: 404 });
        const metadata = updated?.metadata ?? (
          storedOwnedSession
            ? persistStoredSessionMetadata(ctx, storedOwnedSession, persistedPatch)
            : null
        );
        if (!metadata) return Response.json({ error: "Not found" }, { status: 404 });
        if (updated) {
          ctx.messageStore.recordSession({
            id: updated.id,
            agent: updated.agent,
            startedAt: updated.startedAt,
            name: updated.name ?? undefined,
            npub: updated.npub ?? undefined,
            port: updated.port,
            pid: updated.pid ?? undefined,
            pm2Name: updated.pm2Name,
            workingDirectory: updated.workingDirectory ?? undefined,
            command: updated.command,
            runtimeStatus: updated.agentRuntimeStatus ?? null,
            origin: updated.origin ?? null,
            targetFile: updated.targetFile ?? undefined,
            metadata: updated.metadata,
          });
        }
        return Response.json(
          buildSessionMetadataResponse(resolvedId, metadata, targetOwnerNpub),
        );
      }
    }

    if (method === "GET" && subresource === "events") {
      if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
      return ctx.handleSessionEvents(resolvedId, request);
    }

    if (subresource === "messages") {
      if (method === "GET") {
        const refresh = url.searchParams.get("refresh") === "true";
        const messages = await (
          refresh && liveOwnedSession
            ? ctx.syncSessionMessages(resolvedId, true)
            : ctx.messageStore.listSessionMessages(resolvedId)
        );
        return Response.json({ id: resolvedId, messages });
      }
      if (method === "POST") {
        if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
        ctx.manager.updateSessionMetadata(resolvedId, {
          lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
          chargeToNpub: chargeToNpub ?? undefined,
        });
        return handlePostMessage(request, resolvedId, liveOwnedSession, billingAuthContext, ctx);
      }
    }

    if (method === "GET" && subresource === "history") {
      return handleSessionHistory(resolvedId, liveOwnedSession, normaliseNpub(targetOwnerNpub), false, ctx);
    }

    if (method === "POST" && subresource === "queue" && (ownerRoute.remainder[2] === "next" || ownerRoute.remainder[2] === "dispatch")) {
      if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
      ctx.manager.updateSessionMetadata(resolvedId, {
        lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
        chargeToNpub: chargeToNpub ?? undefined,
      });
      return handleQueueNext(resolvedId, liveOwnedSession, billingAuthContext, ctx);
    }

    if (subresource === "queue") {
      return handleQueueRoutes(
        request,
        method,
        ["", "api", "sessions", resolvedId, "queue", ...ownerRoute.remainder.slice(2)],
        resolvedId,
        liveOwnedSession,
        billingAuthContext,
        ctx,
      );
    }
  }

  // ──────────────────────────────────────────────
  //  GET /api/sessions — list sessions with filtering
  // ──────────────────────────────────────────────

  if (pathname === "/api/sessions" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
    if (denied) return denied;

    const viewerNormalizedNpub = resolveSelfSpaceViewerNpub(authContext, ctx);
    const viewerIsAdmin = Boolean(ctx.adminNpub && viewerNormalizedNpub && viewerNormalizedNpub === ctx.adminNpub);
    const allSessions = ctx.manager.listSessions();
    const accessibleSessions = viewerIsAdmin
      ? allSessions
      : viewerNormalizedNpub
        ? allSessions.filter((session) => ctx.sessionBelongsToViewer(session.npub ?? null, viewerNormalizedNpub, false))
        : [];
    const filterParam = url.searchParams.get("npub");

    const normalizeFilterValue = (value: string | null): string | null | "__anonymous__" => {
      if (!value || value === "all") return null;
      if (value === "__anonymous__") return "__anonymous__";
      const normalized = normaliseNpub(value);
      return normalized ?? null;
    };

    const filterValue = normalizeFilterValue(filterParam);
    const filteredSessions = accessibleSessions.filter((session) => {
      if (filterValue === null) return true;
      const sessionNormalized = normaliseNpub(session.npub ?? null);
      if (filterValue === "__anonymous__") return sessionNormalized === null;
      return sessionNormalized === filterValue;
    });

    let identitySummaries = viewerIsAdmin
      ? ctx.buildIdentitySummaries(allSessions, viewerNormalizedNpub, { includeAll: true })
      : ctx.buildIdentitySummaries(accessibleSessions, viewerNormalizedNpub, { includeAll: false });

    const identityNpub = isDelegatedBotAuth(authContext)
      ? normaliseNpub(authContext.delegatedOwnerNpub ?? null)
      : normaliseNpub(authContext.npub ?? null);
    if (!viewerIsAdmin && identitySummaries.length === 0 && viewerNormalizedNpub && identityNpub) {
      const segment = deriveNpubSegment(identityNpub);
      const dataRoot = normalize(join(ctx.userIdentityRoot, segment));
      const logsRoot = normalize(join(dataRoot, "logs"));
      const attachmentsRoot = normalize(join(ctx.attachmentRoot, segment));
      const imagesRoot = normalize(join(ctx.imageRoot, segment));
      const viewerRecord = ctx.identityUserStore.getByNormalized(viewerNormalizedNpub);
      const ports = viewerRecord?.ports ?? ctx.identityUserStore.ensurePortsFor(identityNpub);
      const balance = viewerRecord?.balance ?? 0;
      identitySummaries = [
        {
          npub: identityNpub,
          normalizedNpub: viewerNormalizedNpub,
          segment,
          alias: generateIdentityAlias(identityNpub),
          ports,
          balance,
          sessionIds: [],
          activeSessionIds: [],
          lastSeenAt: null,
          dataRoot,
          logsRoot,
          attachmentsRoot,
          imagesRoot,
        },
      ];
    }

    const npubFilters = identitySummaries.map((identity) => ({
      value: identity.normalizedNpub ?? "__anonymous__",
      npub: identity.npub,
      alias: identity.alias,
      label: identity.alias ?? identity.npub ?? "Anonymous",
      sessionCount: identity.sessionIds.length,
      activeCount: identity.activeSessionIds.length,
    }));

    return Response.json({
      sessions: filteredSessions.map(ctx.serializeSession),
      identities: identitySummaries,
      filters: {
        npubs: npubFilters,
        active: filterValue,
      },
    });
  }

  // ──────────────────────────────────────────────
  //  POST /api/sessions — create session
  // ──────────────────────────────────────────────

  if (pathname === "/api/sessions" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
    if (denied) return denied;

    try {
      const sessionOwnerNpub = resolveSelfSpaceViewerNpub(authContext, ctx);
      const selfSpaceAuthContext = buildSelfSpaceAuthContext(authContext, sessionOwnerNpub);
      const payload = (await request.json()) as Record<string, unknown> | null;
      const agent = typeof payload?.agent === "string" ? payload.agent.toLowerCase() : "";
      if (!ctx.isAgentType(agent)) {
        return Response.json({ error: "Invalid agent selection" }, { status: 400 });
      }
      const requiresBalance = await ctx.shouldRequireBalanceForAgent(agent);
      if (requiresBalance) {
        const balanceCheck = ctx.ensureViewerHasBalance(selfSpaceAuthContext, {
          feature: "start an agent session",
          message: "Add sats to your balance to start an agent session.",
        });
        if (balanceCheck instanceof Response) return balanceCheck;
      }

      const directoryInput = typeof payload?.directory === "string" ? payload.directory : undefined;
      const rawName =
        payload && typeof payload === "object" && payload !== null
          ? payload.name
          : null;
      let workspace: SessionWorkspaceRequest = null;
      try {
        workspace =
          payload && typeof payload === "object" && payload !== null
            ? ctx.parseSessionWorkspaceRequest(payload.workspace)
            : null;
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      const sessionName = ctx.normaliseSessionNameInput(rawName);
      let workingDirectory: string;
      try {
        workingDirectory = await ctx.resolveSessionWorkingDirectory(directoryInput, workspace);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      let origin: SessionOrigin | null = null;
      try {
        origin = ctx.parseSessionOriginInput(payload?.origin ?? null);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      let nightWatch: NightWatchStartOptions | null = null;
      try {
        nightWatch = ctx.parseNightWatchStartOptions(payload?.nightwatch ?? null);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      // Parse optional target file for writer-mode sessions
      const rawTargetFile = typeof payload?.targetFile === "string" ? payload.targetFile.trim() : "";
      let targetFile: string | undefined;
      if (rawTargetFile.length > 0) {
        targetFile = rawTargetFile.startsWith("/")
          ? rawTargetFile
          : resolvePath(workingDirectory, rawTargetFile);
      }
      const rawMetadata =
        payload?.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
          ? payload.metadata as Record<string, unknown>
          : null;
      const callerRequestedAgent = rawMetadata?.AGENT === true;
      const session = await ctx.manager.createSession(
        agent,
        workingDirectory,
        sessionName ?? undefined,
        origin,
        targetFile,
        sessionOwnerNpub ?? undefined,
        {
          ...(rawMetadata ?? {}),
          AGENT: callerRequestedAgent || isDelegatedBotAuth(authContext),
          ownerNpub: sessionOwnerNpub ?? undefined,
          createdByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
          lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
          chargeToNpub: sessionOwnerNpub ?? undefined,
        },
      );
      if (nightWatch?.enabled) {
        ctx.enableNightWatch(session.id, {
          prompt: nightWatch.prompt,
          intervalMinutes: nightWatch.intervalMinutes,
          maxCycles: nightWatch.maxCycles,
        });
      }
      await recordLiveSession(ctx, session);
      return Response.json(ctx.serializeSession(session), { status: 201 });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  }

  // ──────────────────────────────────────────────
  //  /api/sessions/:id/* — session CRUD + sub-resources
  // ──────────────────────────────────────────────

  if (pathname.startsWith("/api/sessions/")) {
    const parts = pathname.split("/");
    const id = parts[3];

    // SSE endpoint - check auth and handle specially
    if (method === "GET" && parts[4] === "events" && id) {
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
      if (denied) return denied;

      const liveSession = ctx.manager.getSession(id);
      const viewerNormalizedNpub = resolveSelfSpaceViewerNpub(authContext, ctx);
      const viewerIsAdmin = Boolean(ctx.adminNpub && viewerNormalizedNpub && viewerNormalizedNpub === ctx.adminNpub);
      const ownedSession =
        liveSession && ctx.sessionBelongsToViewer(liveSession.npub ?? null, viewerNormalizedNpub, viewerIsAdmin)
          ? liveSession
          : null;
      if (!ownedSession) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return ctx.handleSessionEvents(id, request);
    }

    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
    if (denied) return denied;

    if (!id) {
      return Response.json({ error: "Session id required" }, { status: 400 });
    }

    const viewerNormalizedNpub = resolveSelfSpaceViewerNpub(authContext, ctx);
    const viewerIsAdmin = Boolean(ctx.adminNpub && viewerNormalizedNpub && viewerNormalizedNpub === ctx.adminNpub);
    if (!viewerIsAdmin && !viewerNormalizedNpub) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const sessionResolution = resolveOwnedLiveSession(
      id,
      ctx.manager.listSessions(),
      viewerNormalizedNpub,
      viewerIsAdmin,
      ctx,
    );
    if (sessionResolution.error) return sessionResolution.error;
    const ownedSession = sessionResolution.session;
    let resolvedId = sessionResolution.resolvedId;
    const storedSessionResolution =
      !ownedSession
        ? resolveOwnedStoredSession(id, viewerNormalizedNpub, viewerIsAdmin, ctx)
        : null;
    if (storedSessionResolution?.error) return storedSessionResolution.error;
    const storedOwnedSession = storedSessionResolution?.session ?? null;
    const recoveredSession = !ownedSession ? rehydrateStoredSession(ctx, storedOwnedSession) : null;
    const liveOwnedSession = ownedSession ?? recoveredSession;
    if (!ownedSession && storedOwnedSession) {
      resolvedId = storedSessionResolution?.resolvedId ?? resolvedId;
    }

    if (method === "GET" && parts.length === 4) {
      if (liveOwnedSession) {
        return Response.json(ctx.serializeSession(liveOwnedSession));
      }
      if (storedOwnedSession) {
        return Response.json(serializeStoredSession(storedOwnedSession));
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (method === "PATCH" && parts.length === 4) {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }
      if (!payload || typeof payload !== "object") {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }
      const record = payload as Record<string, unknown>;
      const desiredName = typeof record.name === "string" ? record.name : "";
      const trimmedName = desiredName.trim();
      if (!trimmedName) {
        return Response.json({ error: "Session name is required" }, { status: 400 });
      }
      const renamed = ctx.manager.renameSession(resolvedId, trimmedName);
      if (!renamed) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(ctx.serializeSession(renamed));
    }

    if (method === "DELETE" && parts.length === 4) {
      if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
      if (!isAuthorizedCaller(authContext) && !isAgentManagedByMetadataOrOrigin(liveOwnedSession.metadata, liveOwnedSession.origin)) {
        return Response.json({ error: "Agents can only stop sessions with metadata.AGENT=true" }, { status: 403 });
      }
      const session = await ctx.manager.stopSession(resolvedId);
      if (!session) return Response.json({ error: "Not found" }, { status: 404 });
      ctx.scheduleSessionArchive(resolvedId, ctx.manager);
      return Response.json(ctx.serializeSession(session));
    }

    if (method === "DELETE" && parts[4] === "storage") {
      if (liveOwnedSession && (liveOwnedSession.status === "starting" || liveOwnedSession.status === "running")) {
        return Response.json({ error: "Stop the session before deleting it" }, { status: 409 });
      }

      if (!ownedSession) {
        if (!viewerIsAdmin) {
          const storedRecord = ctx.messageStore
            .listSessions()
            .find((record) => record.id === resolvedId && ctx.sessionBelongsToViewer(record.npub, viewerNormalizedNpub, viewerIsAdmin));
          if (!storedRecord) {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
        } else if (!ctx.messageStore.listSessions().some((record) => record.id === resolvedId)) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
      }

      ctx.cancelPendingArchive(resolvedId);

      try {
        ctx.manager.deleteSession(resolvedId);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      ctx.messageStore.removeSession(resolvedId);
      return Response.json({ id: resolvedId, deleted: true });
    }

    if (parts[4] === "metadata") {
      if (method === "GET") {
        const metadata = liveOwnedSession?.metadata ?? storedOwnedSession?.metadata;
        if (!metadata) return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json(buildSessionMetadataResponse(resolvedId, metadata));
      }
      if (method === "PATCH") {
        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
        }
        const metadataPatch = parseSessionMetadataUpdateInput(payload);
        if (!metadataPatch) {
          return Response.json({ error: "Invalid metadata payload" }, { status: 400 });
        }
        const persistedPatch = {
          ...metadataPatch,
          lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
        };
        const updated = liveOwnedSession
          ? ctx.manager.updateSessionMetadata(resolvedId, persistedPatch)
          : null;
        if (liveOwnedSession && !updated) return Response.json({ error: "Not found" }, { status: 404 });
        const metadata = updated?.metadata ?? (
          storedOwnedSession
            ? persistStoredSessionMetadata(ctx, storedOwnedSession, persistedPatch)
            : null
        );
        if (!metadata) return Response.json({ error: "Not found" }, { status: 404 });
        if (updated) {
          ctx.messageStore.recordSession({
            id: updated.id,
            agent: updated.agent,
            startedAt: updated.startedAt,
            name: updated.name ?? undefined,
            npub: updated.npub ?? undefined,
            port: updated.port,
            pid: updated.pid ?? undefined,
            pm2Name: updated.pm2Name,
            workingDirectory: updated.workingDirectory ?? undefined,
            command: updated.command,
            runtimeStatus: updated.agentRuntimeStatus ?? null,
            origin: updated.origin ?? null,
            targetFile: updated.targetFile ?? undefined,
            metadata: updated.metadata,
          });
        }
        return Response.json(buildSessionMetadataResponse(resolvedId, metadata));
      }
    }

    if (method === "GET" && parts[4] === "logs") {
      if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
      const logs = await ctx.manager.getLogs(resolvedId);
      if (!logs) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({ id: resolvedId, logs });
    }

    // GET /api/sessions/:id/artifacts
    if (method === "GET" && parts[4] === "artifacts") {
      const artifacts = ctx.artifactsStore.listBySession(resolvedId);
      return Response.json({ artifacts });
    }

    // Note: SSE endpoint (/events) is handled earlier in the route chain

    if (parts[4] === "messages") {
      if (method === "GET") {
        const refresh = url.searchParams.get("refresh") === "true";
        const messages = await (
          refresh && liveOwnedSession
            ? ctx.syncSessionMessages(resolvedId, true)
            : ctx.messageStore.listSessionMessages(resolvedId)
        );
        return Response.json({ id: resolvedId, messages });
      }

      if (method === "POST") {
        if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
        return handlePostMessage(request, resolvedId, liveOwnedSession, authContext, ctx);
      }
    }

    // GET /api/sessions/:id/history
    if (method === "GET" && parts[4] === "history") {
      return handleSessionHistory(resolvedId, liveOwnedSession, viewerNormalizedNpub, viewerIsAdmin, ctx);
    }

    if (method === "POST" && parts[4] === "queue" && (parts[5] === "next" || parts[5] === "dispatch")) {
      if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
      return handleQueueNext(resolvedId, liveOwnedSession, authContext, ctx);
    }

    if (parts[4] === "queue") {
      return handleQueueRoutes(request, method, parts, resolvedId, liveOwnedSession, authContext, ctx);
    }

    // Fork session to a new git worktree
    if (method === "POST" && parts[4] === "fork-to-worktree") {
      if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
      return handleForkToWorktree(request, resolvedId, liveOwnedSession, authContext, ctx);
    }
  }

  return null;
}

// ---------- Private handler helpers ----------

async function handlePostMessage(
  request: Request,
  id: string,
  ownedSession: SessionSnapshot,
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!payload || typeof payload !== "object") {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const record = payload as Record<string, unknown>;
  const requestTypeRaw = typeof record.type === "string" ? record.type.trim().toLowerCase() : "user";
  const messageType = requestTypeRaw === "raw" ? "raw" : "user";
  const rawContent = typeof record.content === "string" ? record.content : "";
  const content = messageType === "raw" ? rawContent : rawContent.trim();

  if (!content) {
    return Response.json({ error: "Message content is required" }, { status: 400 });
  }

  const userNpub = resolveSessionChargeNpub(ownedSession.metadata, authContext.npub ?? null);
  if (!userNpub) {
    return Response.json({ error: "Sign in to send messages", balance: 0 }, { status: 403 });
  }

  if (messageType === "raw") {
    const result = await deliverSessionAgentMessage({
      agentHost: ctx.agentHost,
      buildAgentUrl: ctx.buildAgentUrl,
      agent: ownedSession.agent,
      port: ownedSession.port,
      content,
      type: messageType,
      pm2Name: ownedSession.pm2Name,
    });
    if (!result.ok) {
      return Response.json({ error: result.message }, { status: result.status });
    }
    return Response.json({ id, ok: true });
  }

  const isCreditsBilling = isCreditsBillingSession(ownedSession.metadata);
  let currentBalance: number | null = null;
  if (!isCreditsBilling) {
    try {
      currentBalance = ctx.identityUserStore.debit(userNpub, ctx.MESSAGE_COST_SATS);
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        return Response.json(
          {
            error: "Insufficient balance to send message",
            balance: error.balance,
          },
          { status: 402 },
        );
      }
      console.error("[billing] failed to debit message cost:", error);
      return Response.json({ error: "Failed to debit balance" }, { status: 500 });
    }
  }

  try {
    const initialCount = ctx.messageStore.listSessionMessages(id).length;
    const result = await deliverSessionAgentMessage({
      agentHost: ctx.agentHost,
      buildAgentUrl: ctx.buildAgentUrl,
      agent: ownedSession.agent,
      port: ownedSession.port,
      content,
      type: messageType,
      pm2Name: ownedSession.pm2Name,
    });
    if (!result.ok) {
      if (!isCreditsBilling) {
        try {
          currentBalance = ctx.identityUserStore.credit(userNpub, ctx.MESSAGE_COST_SATS);
        } catch (creditError) {
          console.error("[billing] failed to refund after agent rejection:", creditError);
        }
      }
      return Response.json({ error: result.message, balance: currentBalance }, { status: result.status });
    }

    const messages = await ctx.waitForMessageUpdate(id, initialCount);
    return Response.json({ id, messages, balance: currentBalance });
  } catch (error) {
    if (!isCreditsBilling) {
      try {
        currentBalance = ctx.identityUserStore.credit(userNpub, ctx.MESSAGE_COST_SATS);
      } catch (creditError) {
        console.error("[billing] failed to refund after agent error:", creditError);
      }
    }
    return Response.json(
      { error: `Failed to contact agent: ${(error as Error).message}`, balance: currentBalance },
      { status: 502 },
    );
  }
}

async function handleDelegatedQueuedMessage(
  request: Request,
  id: string,
  ownedSession: SessionSnapshot,
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!payload || typeof payload !== "object") {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const record = payload as Record<string, unknown>;
  const requestTypeRaw = typeof record.type === "string" ? record.type.trim().toLowerCase() : "user";
  const messageType = requestTypeRaw === "raw" ? "raw" : "user";
  if (messageType === "raw") {
    return handlePostMessage(request, id, ownedSession, authContext, ctx);
  }

  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (!content) {
    return Response.json({ error: "Message content is required" }, { status: 400 });
  }

  const userNpub = resolveSessionChargeNpub(ownedSession.metadata, authContext.npub ?? null);
  if (!userNpub) {
    return Response.json({ error: "Sign in to send messages", balance: 0 }, { status: 403 });
  }

  let prompt: unknown;
  try {
    prompt = ctx.promptQueueStore.addPrompt(id, { content });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }

  const liveSession = ctx.manager.getSession(id) ?? ownedSession;
  if (liveSession.status === "running" && liveSession.agentRuntimeStatus === "stable") {
    try {
      const result = await ctx.dispatchNextQueuedPromptForSession(liveSession, userNpub);
      return Response.json({ id, queued: false, prompt, ...result });
    } catch (error) {
      const queueError = error as Error & { name?: string; status?: number; payload?: Record<string, unknown> };
      if (queueError.name === "QueueDispatchError") {
        void ctx.maybeAutoDispatchQueuedPrompt(liveSession);
        if (queueError.status === 402 || queueError.status === 403) {
          return Response.json({ error: queueError.message, ...(queueError.payload ?? {}) }, { status: queueError.status });
        }
      }
    }
  } else {
    void ctx.maybeAutoDispatchQueuedPrompt(liveSession);
  }

  return Response.json({ id, queued: true, prompt }, { status: 202 });
}

async function handleSessionHistory(
  id: string,
  ownedSession: SessionSnapshot | null,
  viewerNormalizedNpub: string | null,
  viewerIsAdmin: boolean,
  ctx: SessionApiContext,
): Promise<Response> {
  // Check if session is running first
  if (ownedSession) {
    const messages = await ctx.syncSessionMessages(id, true);
    return Response.json({
      id,
      status: "live",
      session: ctx.serializeSession(ownedSession),
      messages,
    });
  }

  // Check wingman.db for abandoned session (server restart, etc.)
  const storedSession = ctx.messageStore.getSession(id);
  if (storedSession) {
    const isOwned = ctx.sessionBelongsToViewer(storedSession.npub, viewerNormalizedNpub, viewerIsAdmin);
    if (isOwned) {
      const messages = ctx.messageStore.listSessionMessages(id);
      return Response.json({
        id,
        status: "abandoned",
        session: {
          id: storedSession.id,
          agent: storedSession.agent,
          name: storedSession.name,
          npub: storedSession.npub,
          workingDirectory: storedSession.workingDirectory,
          startedAt: storedSession.startedAt,
          origin: storedSession.origin,
          metadata: storedSession.metadata,
        },
        messages,
      });
    }
  }

  // Check archive store
  const archivedSession = ctx.sessionArchiveStore.getArchivedSession(id);
  if (archivedSession) {
    const isOwned = ctx.sessionBelongsToViewer(archivedSession.npub, viewerNormalizedNpub, viewerIsAdmin);
    if (isOwned) {
      const messages = ctx.sessionArchiveStore.getArchivedMessages(id);
      return Response.json({
        id,
        status: "archived",
        session: {
          id: archivedSession.id,
          agent: archivedSession.agent,
          name: archivedSession.name,
          npub: archivedSession.npub,
          workingDirectory: archivedSession.workingDirectory,
          startedAt: archivedSession.startedAt,
          archivedAt: archivedSession.archivedAt,
          origin: archivedSession.origin,
          metadata: archivedSession.metadata,
        },
        messages,
      });
    }
  }

  return Response.json({ error: "Session not found" }, { status: 404 });
}

async function handleQueueRoutes(
  request: Request,
  method: HttpMethod,
  parts: string[],
  id: string,
  ownedSession: SessionSnapshot | null,
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): Promise<Response> {
  if (method === "GET") {
    const prompts = ctx.promptQueueStore.getSessionQueue(id);
    return Response.json({ id, queue: { prompts, maxSize: 21 } });
  }

  if (method === "POST") {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const record = payload as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";

    if (!content) {
      return Response.json({ error: "Prompt content is required" }, { status: 400 });
    }

    try {
      const prompt = ctx.promptQueueStore.addPrompt(id, { content });
      if (!prompt) {
        return Response.json({ error: "Failed to add prompt to queue" }, { status: 400 });
      }
      if (ownedSession) {
        void ctx.maybeAutoDispatchQueuedPrompt(ownedSession);
      }
      return Response.json({ id, prompt });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  if (method === "PUT" && parts.length === 6) {
    const promptId = parts[5];
    if (!promptId) {
      return Response.json({ error: "Prompt ID required" }, { status: 400 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const record = payload as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";

    if (!content) {
      return Response.json({ error: "Prompt content is required" }, { status: 400 });
    }

    const updated = ctx.promptQueueStore.updatePromptContent(id, promptId, content);
    if (!updated) {
      return Response.json({ error: "Prompt not found or failed to update" }, { status: 404 });
    }

    return Response.json({ id, promptId, updated: true });
  }

  if (method === "DELETE" && parts.length === 6) {
    const promptId = parts[5];
    if (!promptId) {
      return Response.json({ error: "Prompt ID required" }, { status: 400 });
    }

    const deleted = ctx.promptQueueStore.deletePromptById(id, promptId);
    if (!deleted) {
      return Response.json({ error: "Prompt not found" }, { status: 404 });
    }

    return Response.json({ id, promptId, deleted: true });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

async function handleQueueNext(
  id: string,
  ownedSession: SessionSnapshot,
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): Promise<Response> {
  if (ctx.queueDispatchInFlight.has(id)) {
    return Response.json({ error: "Prompt dispatch already in progress" }, { status: 409 });
  }

  ctx.queueDispatchInFlight.add(id);
  try {
    const result = await ctx.dispatchNextQueuedPromptForSession(
      ownedSession,
      resolveSessionChargeNpub(ownedSession.metadata, authContext.npub ?? null),
    );
    return Response.json(result);
  } catch (error) {
    const queueError = error as Error & { name?: string; status?: number; payload?: Record<string, unknown> };
    if (queueError.name === "QueueDispatchError" && typeof queueError.status === "number") {
      return Response.json({ error: queueError.message, ...(queueError.payload ?? {}) }, { status: queueError.status });
    }
    console.error("[queue] failed to send queued prompt:", error);
    return Response.json({ error: "Failed to send queued prompt" }, { status: 500 });
  } finally {
    ctx.queueDispatchInFlight.delete(id);
  }
}

async function handleForkToWorktree(
  request: Request,
  id: string,
  ownedSession: SessionSnapshot,
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): Promise<Response> {
  const sourceDirectory = ownedSession.workingDirectory;
  if (!sourceDirectory) {
    return Response.json({ error: "Source session has no working directory" }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  let forkInput: ReturnType<typeof ctx.validateForkInput>;
  try {
    forkInput = ctx.validateForkInput(payload);
    forkInput.sourceSessionId = id;
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }

  // Get recent messages from source session
  const contextMessages = ctx.getRecentMessages(ctx.messageStore, id, forkInput.messageCount ?? 5);

  // Create worktree
  let worktreeResult: Awaited<ReturnType<typeof ctx.createGitWorktree>>;
  try {
    worktreeResult = await ctx.createGitWorktree({
      directory: sourceDirectory,
      branch: forkInput.branch,
      startPoint: null,
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }

  // Create new session in the worktree with the same agent
  const requiresBalance = await ctx.shouldRequireBalanceForAgent(ownedSession.agent);
  if (requiresBalance) {
    const balanceCheck = ctx.ensureViewerHasBalance(authContext, {
      feature: "start an agent session",
      message: "Add sats to your balance to fork to a worktree.",
    });
    if (balanceCheck instanceof Response) return balanceCheck;
  }

  const sessionName = `${ownedSession.name || "session"} (${forkInput.branch})`;
  let newSession: SessionSnapshot;
  try {
    newSession = await ctx.manager.createSession(
      ownedSession.agent,
      worktreeResult.path,
      sessionName,
      { type: "fork", id: id, label: `Forked from ${ownedSession.name || id}` },
      undefined,
      authContext.npub ?? undefined,
      { AGENT: false },
    );
    ctx.messageStore.recordSession({
      id: newSession.id,
      agent: newSession.agent,
      startedAt: newSession.startedAt,
      name: newSession.name,
      npub: newSession.npub,
      port: newSession.port,
      pid: newSession.pid,
      workingDirectory: newSession.workingDirectory,
      command: newSession.command,
      runtimeStatus: newSession.agentRuntimeStatus ?? null,
      origin: newSession.origin ?? null,
      pm2Name: newSession.pm2Name,
      metadata: newSession.metadata,
    });
    await ctx.syncSessionMessages(newSession.id, true);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }

  // Format context for injection
  const initialPrompt = ctx.formatMessagesAsContext(contextMessages);

  return Response.json({
    session: ctx.serializeSession(newSession),
    contextMessages,
    worktreePath: worktreeResult.path,
    sourceSessionId: id,
    initialPrompt,
  }, { status: 201 });
}
