/**
 * API route handlers for session and archive endpoints.
 * Extracted from server.ts to reduce file size.
 */

import { normalize, join, resolve as resolvePath } from "node:path";
import type { AgentType } from "../config";
import type { ProcessManager, SessionOrigin, SessionSnapshot } from "../agents/process-manager";
import type { RequestAuthContext } from "../auth/request-context";
import type { AccessAction } from "../auth/access-control";
import { normaliseNpub, deriveNpubSegment } from "../identity/npub-utils";
import { generateIdentityAlias } from "../identity/identity-alias";
import { validateInput, ArchiveListOptionsSchema } from "../utils/validation";
import { InsufficientBalanceError } from "../storage/identity-user-store";
import type { messageStore as MessageStoreInstance, StoredMessage } from "../storage/message-store";
import type { sessionArchiveStore as SessionArchiveStoreInstance } from "../storage/session-archive-store";
import type { ForkToWorktreeInput } from "../sessions/fork-to-worktree";

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
  resolveSessionWorkingDirectory: (directoryInput: string | undefined, workspace: SessionWorkspaceRequest) => Promise<string>;
  parseSessionOriginInput: (value: unknown) => SessionOrigin | null;
  buildAgentUrl: (host: string, port: number, path: string) => string | URL;

  // Queue helpers
  queueDispatchInFlight: Set<string>;
  maybeAutoDispatchQueuedPrompt: (session: SessionSnapshot | null) => void;
  dispatchNextQueuedPromptForSession: (session: SessionSnapshot, userNpub: string | null) => Promise<Record<string, unknown>>;

  // Fork-to-worktree helpers
  validateForkInput: (payload: unknown) => ForkToWorktreeInput;
  getRecentMessages: (messageStore: typeof MessageStoreInstance, sessionId: string, count?: number) => StoredMessage[];
  formatMessagesAsContext: (messages: StoredMessage[]) => string;
  createGitWorktree: (options: { directory: string; branch: string; startPoint: string | null }) => Promise<{ path: string }>;

  // Access action
  AccessActions: { SessionsManage: AccessAction };
}

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
  //  GET /api/sessions — list sessions with filtering
  // ──────────────────────────────────────────────

  if (pathname === "/api/sessions" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
    if (denied) return denied;

    const viewerNormalizedNpub = ctx.getViewerNormalizedNpub(authContext);
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

    if (!viewerIsAdmin && identitySummaries.length === 0 && viewerNormalizedNpub && authContext.npub) {
      const segment = deriveNpubSegment(authContext.npub);
      const dataRoot = normalize(join(ctx.userIdentityRoot, segment));
      const logsRoot = normalize(join(dataRoot, "logs"));
      const attachmentsRoot = normalize(join(ctx.attachmentRoot, segment));
      const imagesRoot = normalize(join(ctx.imageRoot, segment));
      const viewerRecord = ctx.identityUserStore.getByNormalized(viewerNormalizedNpub);
      const ports = viewerRecord?.ports ?? ctx.identityUserStore.ensurePortsFor(authContext.npub);
      const balance = viewerRecord?.balance ?? 0;
      identitySummaries = [
        {
          npub: authContext.npub,
          normalizedNpub: viewerNormalizedNpub,
          segment,
          alias: generateIdentityAlias(authContext.npub),
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
      const payload = (await request.json()) as Record<string, unknown> | null;
      const agent = typeof payload?.agent === "string" ? payload.agent.toLowerCase() : "";
      if (!ctx.isAgentType(agent)) {
        return Response.json({ error: "Invalid agent selection" }, { status: 400 });
      }
      const balanceCheck = ctx.ensureViewerHasBalance(authContext, {
        feature: "start an agent session",
        message: "Add sats to your balance to start an agent session.",
      });
      if (balanceCheck instanceof Response) return balanceCheck;

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
      // Parse optional target file for writer-mode sessions
      const rawTargetFile = typeof payload?.targetFile === "string" ? payload.targetFile.trim() : "";
      let targetFile: string | undefined;
      if (rawTargetFile.length > 0) {
        targetFile = rawTargetFile.startsWith("/")
          ? rawTargetFile
          : resolvePath(workingDirectory, rawTargetFile);
      }
      const session = await ctx.manager.createSession(agent, workingDirectory, sessionName ?? undefined, origin, targetFile);
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
      });
      await ctx.syncSessionMessages(session.id, true);
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
      const viewerNormalizedNpub = ctx.getViewerNormalizedNpub(authContext);
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

    const viewerNormalizedNpub = ctx.getViewerNormalizedNpub(authContext);
    const viewerIsAdmin = Boolean(ctx.adminNpub && viewerNormalizedNpub && viewerNormalizedNpub === ctx.adminNpub);
    if (!viewerIsAdmin && !viewerNormalizedNpub) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const liveSession = ctx.manager.getSession(id);
    const ownedSession =
      liveSession && ctx.sessionBelongsToViewer(liveSession.npub ?? null, viewerNormalizedNpub, viewerIsAdmin)
        ? liveSession
        : null;

    if (method === "GET" && parts.length === 4) {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(ctx.serializeSession(ownedSession));
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
      const renamed = ctx.manager.renameSession(id, trimmedName);
      if (!renamed) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(ctx.serializeSession(renamed));
    }

    if (method === "DELETE" && parts.length === 4) {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
      const session = await ctx.manager.stopSession(id);
      if (!session) return Response.json({ error: "Not found" }, { status: 404 });
      ctx.scheduleSessionArchive(id, ctx.manager);
      return Response.json(ctx.serializeSession(session));
    }

    if (method === "DELETE" && parts[4] === "storage") {
      if (ownedSession && (ownedSession.status === "starting" || ownedSession.status === "running")) {
        return Response.json({ error: "Stop the session before deleting it" }, { status: 409 });
      }

      if (!ownedSession) {
        if (!viewerIsAdmin) {
          const storedRecord = ctx.messageStore
            .listSessions()
            .find((record) => record.id === id && ctx.sessionBelongsToViewer(record.npub, viewerNormalizedNpub, viewerIsAdmin));
          if (!storedRecord) {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
        } else if (!ctx.messageStore.listSessions().some((record) => record.id === id)) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
      }

      ctx.cancelPendingArchive(id);

      try {
        ctx.manager.deleteSession(id);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      ctx.messageStore.removeSession(id);
      return Response.json({ id, deleted: true });
    }

    if (method === "GET" && parts[4] === "logs") {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
      const logs = await ctx.manager.getLogs(id);
      if (!logs) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({ id, logs });
    }

    // GET /api/sessions/:id/artifacts
    if (method === "GET" && parts[4] === "artifacts") {
      const artifacts = ctx.artifactsStore.listBySession(id);
      return Response.json({ artifacts });
    }

    // Note: SSE endpoint (/events) is handled earlier in the route chain

    if (parts[4] === "messages") {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });

      if (method === "GET") {
        const refresh = url.searchParams.get("refresh") === "true";
        const messages = await (refresh ? ctx.syncSessionMessages(id, true) : ctx.messageStore.listSessionMessages(id));
        return Response.json({ id, messages });
      }

      if (method === "POST") {
        return handlePostMessage(request, id, ownedSession, authContext, ctx);
      }
    }

    // GET /api/sessions/:id/history
    if (method === "GET" && parts[4] === "history") {
      return handleSessionHistory(id, ownedSession, viewerNormalizedNpub, viewerIsAdmin, ctx);
    }

    if (parts[4] === "queue") {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
      return handleQueueRoutes(request, method, parts, id, ownedSession, authContext, ctx);
    }

    if (method === "POST" && parts[4] === "queue" && parts[5] === "next") {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
      return handleQueueNext(id, ownedSession, authContext, ctx);
    }

    // Fork session to a new git worktree
    if (method === "POST" && parts[4] === "fork-to-worktree") {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
      return handleForkToWorktree(request, id, ownedSession, authContext, ctx);
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

  const userNpub = authContext.npub ?? null;
  if (!userNpub) {
    return Response.json({ error: "Sign in to send messages", balance: 0 }, { status: 403 });
  }

  if (messageType === "raw") {
    try {
      const agentUrl = ctx.buildAgentUrl(ctx.agentHost, ownedSession.port, "/message");
      const agentResponse = await fetch(agentUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: messageType, content }),
      });
      if (!agentResponse.ok) {
        const errorPayload = (await agentResponse.json().catch(() => ({}))) as Record<string, unknown>;
        const message = (errorPayload?.error as string) ?? agentResponse.statusText ?? "Agent request failed";
        return Response.json({ error: message }, { status: agentResponse.status });
      }
      return Response.json({ id, ok: true });
    } catch (error) {
      return Response.json(
        { error: `Failed to contact agent: ${(error as Error).message ?? "unknown error"}` },
        { status: 502 },
      );
    }
  }

  let currentBalance: number;
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

  try {
    const initialCount = ctx.messageStore.listSessionMessages(id).length;
    const agentUrl = ctx.buildAgentUrl(ctx.agentHost, ownedSession.port, "/message");
    const agentResponse = await fetch(agentUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: messageType, content }),
    });
    if (!agentResponse.ok) {
      const errorPayload = (await agentResponse.json().catch(() => ({}))) as Record<string, unknown>;
      const message = (errorPayload?.error as string) ?? agentResponse.statusText ?? "Agent request failed";
      try {
        currentBalance = ctx.identityUserStore.credit(userNpub, ctx.MESSAGE_COST_SATS);
      } catch (creditError) {
        console.error("[billing] failed to refund after agent rejection:", creditError);
      }
      return Response.json({ error: message, balance: currentBalance }, { status: agentResponse.status });
    }

    const messages = await ctx.waitForMessageUpdate(id, initialCount);
    return Response.json({ id, messages, balance: currentBalance });
  } catch (error) {
    try {
      currentBalance = ctx.identityUserStore.credit(userNpub, ctx.MESSAGE_COST_SATS);
    } catch (creditError) {
      console.error("[billing] failed to refund after agent error:", creditError);
    }
    return Response.json(
      { error: `Failed to contact agent: ${(error as Error).message}`, balance: currentBalance },
      { status: 502 },
    );
  }
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
  ownedSession: SessionSnapshot,
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
      void ctx.maybeAutoDispatchQueuedPrompt(ownedSession);
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
    const result = await ctx.dispatchNextQueuedPromptForSession(ownedSession, authContext.npub ?? null);
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
  const balanceCheck = ctx.ensureViewerHasBalance(authContext, {
    feature: "start an agent session",
    message: "Add sats to your balance to fork to a worktree.",
  });
  if (balanceCheck instanceof Response) return balanceCheck;

  const sessionName = `${ownedSession.name || "session"} (${forkInput.branch})`;
  let newSession: SessionSnapshot;
  try {
    newSession = await ctx.manager.createSession(
      ownedSession.agent,
      worktreeResult.path,
      sessionName,
      { type: "fork", id: id, label: `Forked from ${ownedSession.name || id}` },
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
