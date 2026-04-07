import { describe, expect, test } from "bun:test";

import { createApiRouteHandler } from "./api-routes";
import type { RequestAuthContext } from "../auth/request-context";

const anonymousAuth: RequestAuthContext = {
  npub: null,
  actorNpub: null,
  session: null,
  authMethod: null,
  delegatedByBot: false,
};

describe("createApiRouteHandler autopilot-jobs auth", () => {
  test("resolves NIP-98 auth before SessionsManage access checks for autopilot job dispatch", async () => {
    const resolvedAuth: RequestAuthContext = {
      npub: "npub1resolved",
      actorNpub: "npub1resolved",
      session: null,
      authMethod: "nip98",
      delegatedByBot: false,
    };

    let seenEnsureAccessAuth: RequestAuthContext | null = null;
    let seenHandlerAuth: RequestAuthContext | null = null;

    const handler = createApiRouteHandler({
      config: {
        port: 3000,
        agentPortStart: 4000,
        agentPortMax: 4999,
        hostUrlBase: null,
        connectRelays: [],
        agents: {},
        defaultAgent: "codex",
        giteaUrl: null,
      },
      adminNpub: null,
      todoApiHandler: async () => null,
      projectApiHandler: async () => null,
      npubProjectApiHandler: async () => null,
      browserLogHandler: async () => null,
      caproverApiHandler: async () => null,
      nightWatchApiHandler: async () => null,
      nip98ApiHandler: async () => null,
      botCryptoApiHandler: async () => null,
      botKeyApiHandler: async () => null,
      giteaApiHandler: async () => null,
      gitWorkflowApiHandler: async () => null,
      ngitApiHandler: async () => null,
      superbasedApiHandler: async () => null,
      wingmanMcpApiHandler: async () => null,
      schedulerApiHandler: async () => null,
      autopilotJobsApiHandler: async (_request, _url, _method, auth) => {
        seenHandlerAuth = auth as RequestAuthContext;
        return Response.json({ ok: true }, { status: 201 });
      },
      sessionApiContext: {} as any,
      docsApiContext: {} as any,
      providerProxyApiContext: {} as any,
      billingApiContext: {} as any,
      systemRoutesContext: {} as any,
      authApiContext: {} as any,
      adminUsersApiContext: {} as any,
      uploadApiContext: {} as any,
      voiceNoteUploadApiContext: {} as any,
      featureFlagStore: {
        getFlag: () => null,
      },
      userSettingsStore: {
        getAll: () => ({}),
        set: () => {},
        delete: () => {},
      },
      artifactsStore: {
        get: () => null,
      },
      PROJECTS_FLAG_KEY: "projects",
      resolveWorkspace: () => ({ isAdmin: false } as any),
      verifyNip98AuthHeader: () => "npub1resolved",
      resolveNip98AuthContext: () => resolvedAuth,
      resolveFeatureFlagStateForViewer: () => ({ effectiveState: "on" }),
      ensureApiAccess: async (_action, _request, _url, auth) => {
        seenEnsureAccessAuth = auth;
        return auth.npub ? null : Response.json({ error: "auth-required" }, { status: 401 });
      },
      serialiseFeatureFlagsForViewer: () => ({}),
      listDirectories: async () => [],
      createDirectoryEntry: async () => ({}),
      AccessActions: {
        ProjectsManage: "projects:manage" as any,
        TodosManage: "todos:manage" as any,
        SessionsManage: "sessions:manage" as any,
        DeploymentsManage: "deployments:manage" as any,
        FilesRead: "files:read" as any,
        FilesWrite: "files:write" as any,
      },
      buildStarterProjectsContext: () => ({} as any),
      buildAppsContext: () => ({} as any),
      buildFeatureFlagsContext: () => ({} as any),
      buildChatContext: () => ({} as any),
    });

    const url = new URL("http://localhost:3000/api/autopilot-jobs/runs");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: "software-dev" }),
    });

    const response = await handler(request, url, "POST", anonymousAuth);
    expect(response.status).toBe(201);
    expect(seenEnsureAccessAuth).toEqual(resolvedAuth);
    expect(seenHandlerAuth).toEqual(resolvedAuth);
  });
});
