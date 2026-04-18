// Must be set BEFORE any imports that trigger getSessionSecretBytes()
process.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";

import { afterEach, describe, expect, test } from "bun:test";

import { handleSessionApi, type SessionApiContext } from "./session-api-routes";
import type { RequestAuthContext } from "../auth/request-context";
import type { SessionSnapshot } from "../agents/process-manager";
import type { StoredSessionRecord } from "../storage/message-store";
import { sessionBelongsToViewer as sessionOwnerMatchesViewer } from "../sessions/session-ownership";

const makeAuth = (overrides?: Partial<RequestAuthContext>): RequestAuthContext => ({
  npub: "npub1owner",
  actorNpub: "npub1bot",
  signerNpub: "npub1bot",
  subjectNpub: "npub1bot",
  delegatedOwnerNpub: "npub1owner",
  session: null,
  authMethod: "nip98",
  delegatedByBot: true,
  ...overrides,
});

const baseSession: SessionSnapshot = {
  id: "session-1",
  agent: "codex",
  status: "running",
  npub: "npub1owner",
  port: 3700,
  pid: 1234,
  name: "test session",
  startedAt: new Date().toISOString(),
  command: ["codex"],
  workingDirectory: "/tmp/project",
  logs: [],
  agentRuntimeStatus: "running",
  origin: undefined,
  pm2Name: undefined,
  targetFile: undefined,
  metadata: { AGENT: false, billingMode: "subscription" },
};

const buildCtx = (overrides?: Partial<SessionApiContext>): SessionApiContext => ({
  manager: {
    createSession: async (
      agent: string,
      workingDirectory: string,
      name?: string,
      origin?: unknown,
      targetFile?: string,
      npub?: string,
      metadata?: unknown,
    ) => ({
      ...baseSession,
      id: "session-1",
      agent,
      workingDirectory,
      name: name ?? baseSession.name,
      origin: origin ?? null,
      targetFile,
      npub: npub ?? null,
      metadata: metadata ?? baseSession.metadata,
    }),
    getSession: (id: string) => (id === "session-1" ? baseSession : undefined),
    listSessions: () => [baseSession],
    stopSession: async (id: string) => (id === "session-1" ? baseSession : null),
    getAdapter: () => null,
  } as any,
  adminNpub: null,
  agentHost: "127.0.0.1",
  messageStore: {
    recordSession: () => {},
    getSession: () => null,
    listSessions: () => [],
    listSessionMessages: () => [],
  } as any,
  sessionArchiveStore: {} as any,
  identityUserStore: {
    debit: () => 100,
    credit: () => 100,
    ensurePortsFor: () => [],
    getByNormalized: () => null,
  } as any,
  promptQueueStore: {} as any,
  artifactsStore: {} as any,
  userIdentityRoot: "/tmp",
  attachmentRoot: "/tmp",
  imageRoot: "/tmp",
  MESSAGE_COST_SATS: 0,
  ensureApiAccess: async () => null,
  ensureViewerHasBalance: () => ({ balance: 100 }),
  shouldRequireBalanceForAgent: async () => false,
  serializeSession: (session) => ({ id: session.id, npub: session.npub, metadata: session.metadata, origin: session.origin }),
  sessionBelongsToViewer: (sessionNpub, sessionMetadata, viewerNormalizedNpub, viewerIsAdmin) =>
    sessionOwnerMatchesViewer(sessionNpub, sessionMetadata as any, viewerNormalizedNpub, viewerIsAdmin),
  getViewerNormalizedNpub: () => "npub1owner",
  buildIdentitySummaries: () => [],
  createSessionSubscribeResponse: () => new Response(null, { status: 200 }),
  handleSessionEvents: () => new Response(null, { status: 200 }),
  syncSessionMessages: async () => [],
  waitForMessageUpdate: async () => [],
  scheduleSessionArchive: () => {},
  cancelPendingArchive: () => {},
  isAgentType: (value): value is "codex" => value === "codex",
  normaliseSessionNameInput: (value) => (typeof value === "string" ? value : null),
  parseSessionWorkspaceRequest: () => null,
  resolveSessionWorkingDirectory: async () => "/tmp/project",
  resolveWorkspace: (() => ({
    root: "/tmp",
    docsRoot: "/tmp",
    defaultDirectory: "/tmp/project",
    allowedDirectories: ["/tmp/project"],
  })) as any,
  parseSessionOriginInput: () => null,
  parseNightWatchStartOptions: () => null,
  buildAgentUrl: () => "http://localhost:3700",
  enableNightWatch: () => undefined,
  queueDispatchInFlight: new Set<string>(),
  maybeAutoDispatchQueuedPrompt: () => {},
  dispatchNextQueuedPromptForSession: async () => ({}),
  validateForkInput: (() => ({})) as any,
  getRecentMessages: (() => []) as any,
  formatMessagesAsContext: (() => "") as any,
  createGitWorktree: (async () => ({ path: "/tmp/project/.worktrees/test" })) as any,
  workspaceDelegationStore: {
    findActiveDelegation: () => null,
  } as any,
  AccessActions: { SessionsManage: "sessions:manage" as any },
  ...overrides,
});

describe("handleSessionApi", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("POST /api/sessions passes the effective npub into session creation", async () => {
    let explicitNpub: string | undefined;
    const ctx = buildCtx({
      manager: {
        createSession: async (
          agent: string,
          workingDirectory: string,
          name?: string,
          origin?: unknown,
          targetFile?: string,
          npub?: string,
        ) => {
          explicitNpub = npub;
          return {
            ...baseSession,
            agent,
            workingDirectory,
            name: name ?? baseSession.name,
            origin: origin ?? null,
            targetFile,
            npub: npub ?? null,
          };
        },
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "codex",
        name: "test session",
      }),
    });

    const response = await handleSessionApi(request, url, "POST", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(201);
    expect(explicitNpub).toBe("npub1owner");
  });

  test("GET /api/sessions/:id resolves a unique owned prefix", async () => {
    const resolvedSession = {
      ...baseSession,
      id: "26866c4d-835b-4ab8-b477-128fe2e29095",
      name: "tower-sync-progress",
    };
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === resolvedSession.id ? resolvedSession : undefined),
        listSessions: () => [resolvedSession],
      } as any,
      serializeSession: (session) => ({ id: session.id, name: session.name }),
    });

    const url = new URL("http://localhost:3021/api/sessions/26866c4d");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      id: "26866c4d-835b-4ab8-b477-128fe2e29095",
      name: "tower-sync-progress",
    });
  });

  test("GET /api/sessions/:id/messages resolves a unique owned prefix for subresources", async () => {
    const resolvedSession = {
      ...baseSession,
      id: "26866c4d-835b-4ab8-b477-128fe2e29095",
    };
    let requestedSessionId: string | null = null;
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === resolvedSession.id ? resolvedSession : undefined),
        listSessions: () => [resolvedSession],
      } as any,
      messageStore: {
        recordSession: () => {},
        listSessionMessages: (sessionId: string) => {
          requestedSessionId = sessionId;
          return [{ role: "agent", content: "READY" }];
        },
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/26866c4d/messages");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(requestedSessionId as string | null).toBe("26866c4d-835b-4ab8-b477-128fe2e29095");
    await expect(response!.json()).resolves.toEqual({
      id: "26866c4d-835b-4ab8-b477-128fe2e29095",
      messages: [{ role: "agent", content: "READY" }],
    });
  });

  test("GET /api/sessions/:id returns stored session details when live session is missing", async () => {
    const storedSession: StoredSessionRecord = {
      id: "session-1",
      agent: "codex",
      startedAt: baseSession.startedAt,
      name: "stored session",
      npub: "npub1owner",
      port: 3700,
      pid: 1234,
      pm2Name: null,
      logsDir: null,
      workingDirectory: "/tmp/project",
      command: JSON.stringify(["codex"]),
      runtimeStatus: "running",
      origin: null,
      model: null,
      targetFile: null,
      metadata: {
        AGENT: true,
        billingMode: "subscription",
      },
    };
    const ctx = buildCtx({
      manager: {
        getSession: () => undefined,
        listSessions: () => [],
        rehydrateSession: () => null,
      } as any,
      messageStore: {
        recordSession: () => {},
        getSession: (id: string) => (id === "session-1" ? storedSession : null),
        listSessions: () => [storedSession],
        listSessionMessages: () => [],
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      id: "session-1",
      agent: "codex",
      status: "running",
      name: "stored session",
      npub: "npub1owner",
      ownerNpub: "npub1owner",
      identityAlias: expect.any(String),
      port: 3700,
      pid: 1234,
      startedAt: baseSession.startedAt,
      command: ["codex"],
      workingDirectory: "/tmp/project",
      origin: null,
      targetFile: null,
      metadata: {
        AGENT: true,
        billingMode: "subscription",
      },
    });
  });

  test("GET /api/sessions/:id returns stored sessions owned via metadata.ownerNpub", async () => {
    const storedSession: StoredSessionRecord = {
      id: "session-1",
      agent: "codex",
      startedAt: baseSession.startedAt,
      name: "stored delegated session",
      npub: null,
      port: 3700,
      pid: 1234,
      pm2Name: null,
      logsDir: null,
      workingDirectory: "/tmp/project",
      command: JSON.stringify(["codex"]),
      runtimeStatus: "running",
      origin: null,
      model: null,
      targetFile: null,
      metadata: {
        AGENT: true,
        billingMode: "subscription",
        ownerNpub: "npub1owner",
      },
    };
    const ctx = buildCtx({
      manager: {
        getSession: () => undefined,
        listSessions: () => [],
        rehydrateSession: () => null,
      } as any,
      messageStore: {
        recordSession: () => {},
        getSession: (id: string) => (id === "session-1" ? storedSession : null),
        listSessions: () => [storedSession],
        listSessionMessages: () => [],
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      id: "session-1",
      npub: null,
      ownerNpub: "npub1owner",
      metadata: {
        ownerNpub: "npub1owner",
      },
    });
  });

  test("GET /api/sessions/:id/messages returns stored messages when live session is missing", async () => {
    const storedSession: StoredSessionRecord = {
      id: "session-1",
      agent: "codex",
      startedAt: baseSession.startedAt,
      name: "stored session",
      npub: "npub1owner",
      port: 3700,
      pid: 1234,
      pm2Name: null,
      logsDir: null,
      workingDirectory: "/tmp/project",
      command: JSON.stringify(["codex"]),
      runtimeStatus: "running",
      origin: null,
      model: null,
      targetFile: null,
      metadata: {
        AGENT: true,
        billingMode: "subscription",
      },
    };
    const ctx = buildCtx({
      manager: {
        getSession: () => undefined,
        listSessions: () => [],
        rehydrateSession: () => null,
      } as any,
      messageStore: {
        recordSession: () => {},
        getSession: (id: string) => (id === "session-1" ? storedSession : null),
        listSessions: () => [storedSession],
        listSessionMessages: () => [{ role: "agent", content: "stored output" }],
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/messages");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      id: "session-1",
      messages: [{ role: "agent", content: "stored output" }],
    });
  });

  test("PATCH /api/sessions/:id/metadata updates autonomous hook metadata", async () => {
    let updatePayload: Record<string, unknown> | undefined;
    const updatedSession = {
      ...baseSession,
      metadata: {
        AGENT: false,
        billingMode: "subscription" as const,
        goal: "Ship the release",
        nextAction: "reflect" as const,
        nextActionTemplate: "Goal: {{goal}}",
        lastManagedByNpub: "npub1owner",
      },
    };
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? baseSession : undefined),
        listSessions: () => [baseSession],
        updateSessionMetadata: (id: string, metadata: Record<string, unknown>) => {
          if (id !== "session-1") return null;
          updatePayload = metadata;
          return updatedSession;
        },
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/metadata");
    const request = new Request(url.toString(), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Ship the release",
        nextAction: "reflect",
        nextActionTemplate: "Goal: {{goal}}",
      }),
    });

    const response = await handleSessionApi(request, url, "PATCH", makeAuth({ actorNpub: "npub1owner", delegatedByBot: false }), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(updatePayload as Record<string, unknown>).toEqual({
      goal: "Ship the release",
      nextAction: "reflect",
      nextActionTemplate: "Goal: {{goal}}",
      lastManagedByNpub: "npub1bot",
    });
    await expect(response!.json()).resolves.toEqual({
      id: "session-1",
      metadata: updatedSession.metadata,
    });
  });

  test("PATCH /api/sessions/:id/metadata falls back to stored session metadata for delegated bot auth", async () => {
    let persistedRecord: Record<string, unknown> | null = null;
    const storedSession: StoredSessionRecord = {
      id: "session-1",
      agent: "codex",
      startedAt: baseSession.startedAt,
      name: "stored session",
      npub: "npub1owner",
      port: 3700,
      pid: 1234,
      pm2Name: null,
      logsDir: null,
      workingDirectory: "/tmp/project",
      command: JSON.stringify(["codex"]),
      runtimeStatus: "running",
      origin: null,
      model: null,
      targetFile: null,
      metadata: {
        AGENT: true,
        billingMode: "subscription",
        goal: "Ship the release",
      },
    };
    const ctx = buildCtx({
      manager: {
        getSession: () => undefined,
        listSessions: () => [],
        updateSessionMetadata: () => null,
      } as any,
      messageStore: {
        recordSession: (session: Record<string, unknown>) => {
          persistedRecord = session;
        },
        getSession: (id: string) => (id === "session-1" ? storedSession : null),
        listSessions: () => [storedSession],
        listSessionMessages: () => [],
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/metadata");
    const request = new Request(url.toString(), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nextAction: "stop" }),
    });

    const response = await handleSessionApi(
      request,
      url,
      "PATCH",
      makeAuth({
        npub: "npub1bot",
        actorNpub: "npub1bot",
        signerNpub: "npub1bot",
        subjectNpub: "npub1bot",
        delegatedOwnerNpub: "npub1owner",
        delegatedByBot: true,
      }),
      ctx,
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(persistedRecord).toMatchObject({
      id: "session-1",
      npub: "npub1owner",
      metadata: {
        AGENT: true,
        billingMode: "subscription",
        goal: "Ship the release",
        nextAction: "stop",
        lastManagedByNpub: "npub1bot",
      },
    });
    await expect(response!.json()).resolves.toEqual({
      id: "session-1",
      metadata: {
        AGENT: true,
        autoStop: false,
        billingMode: "subscription",
        goal: "Ship the release",
        nextAction: "stop",
        lastManagedByNpub: "npub1bot",
      },
    });
  });

  test("GET /api/sessions/:id/metadata returns live session metadata", async () => {
    const session = {
      ...baseSession,
      metadata: {
        AGENT: false,
        billingMode: "subscription" as const,
        goal: "Ship the release",
        nextAction: "reflect" as const,
      },
    };
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? session : undefined),
        listSessions: () => [session],
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/metadata");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(
      request,
      url,
      "GET",
      makeAuth({ actorNpub: "npub1owner", delegatedByBot: false }),
      ctx,
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      id: "session-1",
      metadata: session.metadata,
    });
  });

  test("GET /api/sessions returns owner sessions for delegated bot auth in self space", async () => {
    const ctx = buildCtx({
      manager: {
        listSessions: () => [{ ...baseSession, npub: "npub1owner" }],
      } as any,
      buildIdentitySummaries: () => [],
    });

    const url = new URL("http://localhost:3021/api/sessions");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(
      request,
      url,
      "GET",
      makeAuth({
        npub: "npub1bot",
        actorNpub: "npub1bot",
        signerNpub: "npub1bot",
        subjectNpub: "npub1bot",
        delegatedOwnerNpub: "npub1owner",
        delegatedByBot: true,
      }),
      ctx,
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      sessions: [{ id: "session-1", npub: "npub1owner" }],
    });
  });

  test("GET /api/sessions includes sessions owned via metadata.ownerNpub", async () => {
    const delegatedSession = {
      ...baseSession,
      id: "session-meta-owner",
      npub: null,
      metadata: {
        AGENT: true,
        billingMode: "subscription" as const,
        ownerNpub: "npub1owner",
      },
    };
    const ctx = buildCtx({
      manager: {
        listSessions: () => [delegatedSession],
      } as any,
      serializeSession: (session) => ({
        id: session.id,
        npub: session.npub,
        ownerNpub: session.metadata?.ownerNpub ?? null,
        metadata: session.metadata,
      }),
      buildIdentitySummaries: () => [],
    });

    const url = new URL("http://localhost:3021/api/sessions");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      sessions: [{ id: "session-meta-owner", ownerNpub: "npub1owner" }],
    });
  });

  test("PATCH /api/owners/:owner/sessions/:id/metadata updates owner-space metadata", async () => {
    let updatePayload: Record<string, unknown> | undefined;
    const updatedSession = {
      ...baseSession,
      metadata: {
        AGENT: false,
        billingMode: "subscription" as const,
        goal: "Review task state",
        nextAction: "stop" as const,
        lastManagedByNpub: "npub1owner",
      },
    };
    const ownerSession = { ...baseSession, npub: "npub1owner" };
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? ownerSession : undefined),
        listSessions: () => [ownerSession],
        updateSessionMetadata: (id: string, metadata: Record<string, unknown>) => {
          if (id !== "session-1") return null;
          updatePayload = metadata;
          return updatedSession;
        },
      } as any,
    });

    const url = new URL("http://localhost:3021/api/owners/npub1owner/sessions/session-1/metadata");
    const request = new Request(url.toString(), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { goal: "Review task state", nextAction: "stop" } }),
    });

    const ownerAuth = makeAuth({
      npub: "npub1owner",
      actorNpub: "npub1owner",
      signerNpub: "npub1owner",
      subjectNpub: "npub1owner",
      delegatedByBot: false,
      delegatedOwnerNpub: "npub1owner",
    });
    const response = await handleSessionApi(request, url, "PATCH", ownerAuth, ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(updatePayload as Record<string, unknown>).toEqual({
      goal: "Review task state",
      nextAction: "stop",
      lastManagedByNpub: "npub1owner",
    });
    await expect(response!.json()).resolves.toEqual({
      id: "session-1",
      ownerNpub: "npub1owner",
      metadata: updatedSession.metadata,
    });
  });

  test("GET /api/owners/:owner/sessions/:id/metadata returns owner-space metadata", async () => {
    const ownerSession = {
      ...baseSession,
      npub: "npub1owner",
      metadata: {
        AGENT: false,
        billingMode: "subscription" as const,
        goal: "Review task state",
        nextAction: "stop" as const,
      },
    };
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? ownerSession : undefined),
        listSessions: () => [ownerSession],
      } as any,
    });

    const url = new URL("http://localhost:3021/api/owners/npub1owner/sessions/session-1/metadata");
    const request = new Request(url.toString(), { method: "GET" });

    const ownerAuth = makeAuth({
      npub: "npub1owner",
      actorNpub: "npub1owner",
      signerNpub: "npub1owner",
      subjectNpub: "npub1owner",
      delegatedByBot: false,
      delegatedOwnerNpub: "npub1owner",
    });
    const response = await handleSessionApi(request, url, "GET", ownerAuth, ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      id: "session-1",
      ownerNpub: "npub1owner",
      metadata: ownerSession.metadata,
    });
  });

  test("GET /api/sessions/:id returns 409 for ambiguous owned prefixes", async () => {
    const sessions = [
      { ...baseSession, id: "26866c4d-835b-4ab8-b477-128fe2e29095", name: "tower-sync-progress" },
      { ...baseSession, id: "26866c4d-1111-4ab8-b477-128fe2e29095", name: "tower-sync-other" },
    ];
    const ctx = buildCtx({
      manager: {
        getSession: () => undefined,
        listSessions: () => sessions,
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/26866c4d");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(409);
    await expect(response!.json()).resolves.toEqual({
      error: "Ambiguous session id",
      matches: [
        { id: "26866c4d-835b-4ab8-b477-128fe2e29095", name: "tower-sync-progress" },
        { id: "26866c4d-1111-4ab8-b477-128fe2e29095", name: "tower-sync-other" },
      ],
    });
  });

  test("POST /api/delegate-sessions creates an AGENT-managed session for the owner linked to the bot", async () => {
    let explicitNpub: string | undefined;
    let explicitMetadata: unknown;
    let explicitOrigin: unknown;

    const ctx = buildCtx({
      manager: {
        createSession: async (
          agent: string,
          workingDirectory: string,
          name?: string,
          origin?: unknown,
          targetFile?: string,
          npub?: string,
          metadata?: unknown,
        ) => {
          explicitNpub = npub;
          explicitMetadata = metadata;
          explicitOrigin = origin;
          return {
            ...baseSession,
            agent,
            workingDirectory,
            name: name ?? baseSession.name,
            origin: origin ?? null,
            targetFile,
            npub: npub ?? null,
            metadata: metadata ?? null,
          };
        },
      } as any,
    });

    const url = new URL("http://localhost:3021/api/delegate-sessions");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "codex", name: "worker" }),
    });

    const response = await handleSessionApi(request, url, "POST", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(201);
    expect(explicitNpub).toBe("npub1owner");
    expect(explicitMetadata).toMatchObject({
      AGENT: true,
      ownerNpub: "npub1owner",
      createdByNpub: "npub1bot",
      lastManagedByNpub: "npub1bot",
      chargeToNpub: "npub1owner",
    });
    expect(explicitOrigin).toEqual({
      type: "delegate-bot",
      id: "npub1bot",
      label: "npub1bot",
    });
  });

  test("POST /api/delegate-sessions accepts owner NIP-98 (non-bot) with cli origin", async () => {
    let explicitOrigin: unknown;

    const ctx = buildCtx({
      manager: {
        createSession: async (
          agent: string,
          workingDirectory: string,
          name?: string,
          origin?: unknown,
          targetFile?: string,
          npub?: string,
          metadata?: unknown,
        ) => {
          explicitOrigin = origin;
          return {
            ...baseSession,
            agent,
            workingDirectory,
            name: name ?? baseSession.name,
            origin: origin ?? null,
            targetFile,
            npub: npub ?? null,
            metadata: metadata ?? null,
          };
        },
      } as any,
    });

    const url = new URL("http://localhost:3021/api/delegate-sessions");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "codex", name: "owner-cli" }),
    });

    const ownerAuth = makeAuth({ actorNpub: "npub1owner", delegatedByBot: false });
    const response = await handleSessionApi(request, url, "POST", ownerAuth, ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(201);
    expect(explicitOrigin).toEqual({
      type: "cli",
      id: "npub1owner",
      label: "npub1owner",
    });
  });

  test("DELETE /api/sessions/:id allows owner NIP-98 to stop non-AGENT sessions", async () => {
    const nonAgentSession = {
      ...baseSession,
      metadata: { AGENT: false, billingMode: "subscription" as const },
    };
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? nonAgentSession : undefined),
        listSessions: () => [nonAgentSession],
        stopSession: async (id: string) => (id === "session-1" ? nonAgentSession : null),
      } as any,
      serializeSession: (session) => ({ id: session.id, metadata: session.metadata }),
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1");
    const request = new Request(url.toString(), { method: "DELETE" });

    const ownerAuth = makeAuth({ actorNpub: "npub1owner", delegatedByBot: false });
    const response = await handleSessionApi(request, url, "DELETE", ownerAuth, ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
  });

  test("POST /api/sessions allows caller to set metadata.AGENT via body", async () => {
    let explicitMetadata: unknown;
    const ctx = buildCtx({
      manager: {
        createSession: async (
          _agent: string,
          _workingDirectory: string,
          _name?: string,
          _origin?: unknown,
          _targetFile?: string,
          _npub?: string,
          metadata?: unknown,
        ) => {
          explicitMetadata = metadata;
          return { ...baseSession, metadata: metadata ?? baseSession.metadata };
        },
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "codex", metadata: { AGENT: true } }),
    });

    const ownerAuth = makeAuth({ actorNpub: "npub1owner", delegatedByBot: false });
    const response = await handleSessionApi(request, url, "POST", ownerAuth, ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(201);
    expect(explicitMetadata).toMatchObject({
      AGENT: true,
      ownerNpub: "npub1owner",
      createdByNpub: "npub1bot",
      lastManagedByNpub: "npub1bot",
      chargeToNpub: "npub1owner",
    });
  });

  test("GET /api/delegate-sessions/:id/messages refreshes live messages", async () => {
    const messages = [{ role: "agent", content: "READY" }];
    const ctx = buildCtx({
      syncSessionMessages: async () => messages,
    });

    const url = new URL("http://localhost:3021/api/delegate-sessions/session-1/messages?refresh=true");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({ id: "session-1", messages });
  });

  test("POST /api/delegate-sessions/:id/messages queues and dispatches for a stable same-owner session", async () => {
    const prompts: Array<Record<string, unknown>> = [];
    const messages = [
      { role: "user", content: "ping" },
      { role: "agent", content: "pong" },
    ];
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? { ...baseSession, agentRuntimeStatus: "stable" } : undefined),
        listSessions: () => [{ ...baseSession, agentRuntimeStatus: "stable" }],
      } as any,
      promptQueueStore: {
        addPrompt: (_id: string, prompt: { content: string }) => {
          prompts.push(prompt);
          return { id: "prompt-1", ...prompt };
        },
      } as any,
      dispatchNextQueuedPromptForSession: async () => ({ id: "session-1", messages, sentPrompt: { content: "ping" }, balance: 100 }),
    });

    const url = new URL("http://localhost:3021/api/delegate-sessions/session-1/messages");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "ping" }),
    });

    const response = await handleSessionApi(request, url, "POST", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(prompts).toEqual([{ content: "ping" }]);
    await expect(response!.json()).resolves.toMatchObject({
      id: "session-1",
      queued: false,
      messages,
    });
  });

  test("POST /api/sessions/:id/messages sends via the pi adapter for pi sessions", async () => {
    let sentContent: string | null = null;
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? { ...baseSession, agent: "pi" } : undefined),
        listSessions: () => [{ ...baseSession, agent: "pi" }],
        getAdapter: () => ({
          waitForReady: async () => undefined,
          sendMessage: async (content: string) => {
            sentContent = content;
          },
        }),
      } as any,
      waitForMessageUpdate: async () => [
        { role: "user", content: "ping" },
        { role: "assistant", content: "pong" },
      ],
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/messages");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "ping" }),
    });

    const response = await handleSessionApi(request, url, "POST", makeAuth({ session: { id: "viewer" } as any }), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(sentContent).toBe("ping");
    await expect(response!.json()).resolves.toMatchObject({
      id: "session-1",
      messages: [
        { role: "user", content: "ping" },
        { role: "assistant", content: "pong" },
      ],
    });
  });

  test("POST /api/sessions/:id/queue/next dispatches the queued prompt", async () => {
    const ctx = buildCtx({
      dispatchNextQueuedPromptForSession: async () => ({ id: "session-1", sentPrompt: { content: "queued" }, messages: [], balance: 100 }),
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/queue/next");
    const request = new Request(url.toString(), { method: "POST" });

    const response = await handleSessionApi(request, url, "POST", makeAuth({ session: { id: "viewer" } as any }), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      id: "session-1",
      sentPrompt: { content: "queued" },
    });
  });

  test("POST /api/sessions/:id/queue/dispatch aliases to the queued prompt dispatcher", async () => {
    const ctx = buildCtx({
      dispatchNextQueuedPromptForSession: async () => ({ id: "session-1", sentPrompt: { content: "queued" }, messages: [], balance: 100 }),
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/queue/dispatch");
    const request = new Request(url.toString(), { method: "POST" });

    const response = await handleSessionApi(request, url, "POST", makeAuth({ session: { id: "viewer" } as any }), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      id: "session-1",
      sentPrompt: { content: "queued" },
    });
  });

  test("DELETE /api/delegate-sessions/:id allows a delegated bot to stop a same-owner session", async () => {
    const stoppedSession = {
      ...baseSession,
      metadata: { AGENT: false, billingMode: "subscription" },
    };
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? stoppedSession : undefined),
        listSessions: () => [stoppedSession],
        stopSession: async (id: string) => (id === "session-1" ? stoppedSession : null),
      } as any,
      serializeSession: (session) => ({ id: session.id, metadata: session.metadata }),
    });

    const url = new URL("http://localhost:3021/api/delegate-sessions/session-1");
    const request = new Request(url.toString(), { method: "DELETE" });

    const response = await handleSessionApi(request, url, "DELETE", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      id: "session-1",
      metadata: { AGENT: false, billingMode: "subscription" },
    });
  });
});
