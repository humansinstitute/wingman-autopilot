// Must be set BEFORE any imports that trigger getSessionSecretBytes()
process.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";

import { describe, expect, test } from "bun:test";

import { handleSessionApi, type SessionApiContext } from "./session-api-routes";
import type { RequestAuthContext } from "../auth/request-context";

const makeAuth = (overrides?: Partial<RequestAuthContext>): RequestAuthContext => ({
  npub: "npub1owner",
  actorNpub: "npub1bot",
  session: null,
  authMethod: "nip98",
  delegatedByBot: true,
  ...overrides,
});

describe("handleSessionApi", () => {
  test("POST /api/sessions passes the effective npub into session creation", async () => {
    let explicitNpub: string | undefined;

    const createdSession = {
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
      origin: null,
      pm2Name: null,
      targetFile: undefined,
      metadata: { AGENT: false },
    };

    const ctx: SessionApiContext = {
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
            ...createdSession,
            agent,
            workingDirectory,
            name: name ?? createdSession.name,
            origin: origin ?? null,
            targetFile,
            npub: npub ?? null,
          };
        },
      } as any,
      adminNpub: null,
      agentHost: "127.0.0.1",
      messageStore: {
        recordSession: () => {},
      } as any,
      sessionArchiveStore: {} as any,
      identityUserStore: {} as any,
      promptQueueStore: {} as any,
      artifactsStore: {} as any,
      userIdentityRoot: "/tmp",
      attachmentRoot: "/tmp",
      imageRoot: "/tmp",
      MESSAGE_COST_SATS: 0,
      ensureApiAccess: async () => null,
      ensureViewerHasBalance: () => ({ balance: 100 }),
      shouldRequireBalanceForAgent: async () => false,
      serializeSession: (session) => ({ id: session.id, npub: session.npub }),
      sessionBelongsToViewer: () => false,
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
      parseSessionOriginInput: () => null,
      buildAgentUrl: () => "http://localhost:3700",
      queueDispatchInFlight: new Set<string>(),
      maybeAutoDispatchQueuedPrompt: () => {},
      dispatchNextQueuedPromptForSession: async () => ({}),
      validateForkInput: (() => ({})) as any,
      getRecentMessages: (() => []) as any,
      formatMessagesAsContext: (() => "") as any,
      createGitWorktree: (async () => ({ path: "/tmp/project/.worktrees/test" })) as any,
      AccessActions: { SessionsManage: "sessions:manage" as any },
    };

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
});
