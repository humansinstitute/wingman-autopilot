import { describe, expect, test } from "bun:test";

import { createApiRouteHandler } from "./api-routes";
import type { RequestAuthContext } from "../auth/request-context";

const anonymousAuth: RequestAuthContext = {
  npub: null,
  actorNpub: null,
  session: null,
  delegatedByBot: false,
};

function createHandler(options: {
  authContext?: RequestAuthContext;
  settings?: Record<string, string>;
  onSet?: (npub: string, key: string, value: string) => void;
  config?: Record<string, unknown>;
} = {}) {
  const authContext = options.authContext ?? anonymousAuth;
  const settings = options.settings ?? {};

  return createApiRouteHandler({
    config: {
      port: 3000,
      baseUrl: "http://localhost:3000",
      agentPortStart: 4000,
      agentPortMax: 4999,
      hostUrlBase: null,
      appRoutingMode: "path",
      subdomainBaseDomain: null,
      subdomainProxyEnabled: false,
      connectRelays: [],
      agents: {
        claude: { label: "Claude" },
        codex: { label: "Codex", modelOptions: ["default", "gpt-5.5"] },
        goose: { label: "Goose" },
        opencode: {
          label: "OpenCode",
          modelOptions: [
            "default",
            "opencode/big-pickle",
            "maple/kimi-k2-thinking",
            "maple/qwen3-coder-480b",
            "maple/gpt-oss-120b",
            "maple/llama-3.3-70b",
            "ollama/gemma4:e4b",
          ],
        },
        gemini: { label: "Gemini" },
        pi: { label: "Pi" },
      },
      defaultAgent: "claude",
      giteaUrl: null,
      ...options.config,
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
    sessionApiContext: {} as any,
    docsApiContext: {} as any,
    providerProxyApiContext: {} as any,
    billingApiContext: {} as any,
    systemRoutesContext: {} as any,
    authApiContext: {} as any,
    adminUsersApiContext: {} as any,
    uploadApiContext: {} as any,
    voiceNoteUploadApiContext: {} as any,
    delegationRoutesContext: {} as any,
    userSettingsRoutesContext: {
      agents: {
        claude: { label: "Claude" },
        codex: { label: "Codex" },
        goose: { label: "Goose" },
        opencode: { label: "OpenCode" },
        gemini: { label: "Gemini" },
        pi: { label: "Pi" },
      },
      userSettingsStore: {
        getAll: (npub: string) => (npub === authContext.npub ? settings : {}),
        set: (npub: string, key: string, value: string) => {
          options.onSet?.(npub, key, value);
        },
        delete: () => true,
      },
      ensureApiAccess: async (_action, _request, _url, currentAuth) =>
        currentAuth.npub ? null : Response.json({ error: "Authentication required" }, { status: 401 }),
      AccessActions: {
        SessionsManage: "sessions:manage" as any,
      },
    },
    workspaceDelegationStore: {} as any,
    featureFlagStore: {
      getFlag: () => null,
    },
    userSettingsStore: {
      getAll: (npub: string) => (npub === authContext.npub ? settings : {}),
      set: (npub: string, key: string, value: string) => {
        options.onSet?.(npub, key, value);
      },
      delete: () => true,
    },
    artifactsStore: {
      get: () => null,
    },
    PROJECTS_FLAG_KEY: "projects",
    resolveWorkspace: () => ({
      isAdmin: false,
      defaultDirectory: "/tmp/project",
      allowedDirectories: ["/tmp/project"],
    } as any),
    verifyNip98AuthHeader: () => authContext.npub,
    resolveNip98AuthContext: () => authContext,
    resolveFeatureFlagStateForViewer: () => ({ effectiveState: "on" }),
    ensureApiAccess: async (_action, _request, _url, currentAuth) =>
      currentAuth.npub ? null : Response.json({ error: "Authentication required" }, { status: 401 }),
    serialiseFeatureFlagsForViewer: () => [],
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
}

describe("createApiRouteHandler config defaults", () => {
  test("returns a per-user default agent override from user settings", async () => {
    const authContext: RequestAuthContext = {
      npub: "npub1viewer",
      actorNpub: "npub1viewer",
      session: null,
      delegatedByBot: false,
    };
    const handler = createHandler({
      authContext,
      settings: { default_agent: "pi" },
    });

    const url = new URL("http://localhost:3000/api/config");
    const response = await handler(new Request(url.toString()), url, "GET", authContext);
    const body = await response.json() as { defaultAgent: string; systemDefaultAgent: string };

    expect(response.status).toBe(200);
    expect(body.defaultAgent).toBe("pi");
    expect(body.systemDefaultAgent).toBe("claude");
  });

  test("returns hosted app routing config", async () => {
    const handler = createHandler();
    const url = new URL("http://localhost:3000/api/config");
    const response = await handler(new Request(url.toString()), url, "GET", anonymousAuth);
    const body = await response!.json() as {
      baseUrl: string;
      appRoutingMode: string;
      subdomainBaseDomain: string | null;
      subdomainProxyEnabled: boolean;
    };

    expect(body).toMatchObject({
      baseUrl: "http://localhost:3000",
      appRoutingMode: "path",
      subdomainBaseDomain: null,
      subdomainProxyEnabled: false,
    });
  });

  test("returns agent model options", async () => {
    const handler = createHandler();
    const url = new URL("http://localhost:3000/api/config");
    const response = await handler(new Request(url.toString()), url, "GET", anonymousAuth);
    const body = await response!.json() as {
      agents: Array<{ id: string; label: string; modelOptions: string[] }>;
    };

    expect(response.status).toBe(200);
    expect(body.agents).toContainEqual({
      id: "codex",
      label: "Codex",
      modelOptions: ["default", "gpt-5.5"],
    });
    expect(body.agents).toContainEqual({
      id: "claude",
      label: "Claude",
      modelOptions: ["default"],
    });
    expect(body.agents).toContainEqual({
      id: "opencode",
      label: "OpenCode",
      modelOptions: [
        "default",
        "opencode/big-pickle",
        "maple/kimi-k2-thinking",
        "maple/qwen3-coder-480b",
        "maple/gpt-oss-120b",
        "maple/llama-3.3-70b",
        "ollama/gemma4:e4b",
      ],
    });
  });

  test("returns an empty agent list when agent config is unavailable", async () => {
    const handler = createHandler({ config: { agents: undefined } });
    const url = new URL("http://localhost:3000/api/config");
    const response = await handler(new Request(url.toString()), url, "GET", anonymousAuth);
    const body = await response!.json() as { agents: unknown[]; defaultAgent: string };

    expect(response.status).toBe(200);
    expect(body.agents).toEqual([]);
    expect(body.defaultAgent).toBe("claude");
  });

  test("normalizes and saves a valid default_agent setting", async () => {
    const authContext: RequestAuthContext = {
      npub: "npub1viewer",
      actorNpub: "npub1viewer",
      session: null,
      delegatedByBot: false,
    };
    const saved: Array<{ npub: string; key: string; value: string }> = [];
    const handler = createHandler({
      authContext,
      onSet: (npub, key, value) => {
        saved.push({ npub, key, value });
      },
    });

    const url = new URL("http://localhost:3000/api/user/settings/default_agent");
    const request = new Request(url.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: " Pi " }),
    });
    const response = await handler(request, url, "PUT", authContext);
    const body = await response.json() as { value: string };

    expect(response.status).toBe(200);
    expect(body.value).toBe("pi");
    expect(saved).toEqual([{ npub: "npub1viewer", key: "default_agent", value: "pi" }]);
  });

  test("rejects an unsupported default_agent setting", async () => {
    const authContext: RequestAuthContext = {
      npub: "npub1viewer",
      actorNpub: "npub1viewer",
      session: null,
      delegatedByBot: false,
    };
    const saved: Array<{ npub: string; key: string; value: string }> = [];
    const handler = createHandler({
      authContext,
      onSet: (npub, key, value) => {
        saved.push({ npub, key, value });
      },
    });

    const url = new URL("http://localhost:3000/api/user/settings/default_agent");
    const request = new Request(url.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "unknown-agent" }),
    });
    const response = await handler(request, url, "PUT", authContext);
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("claude");
    expect(body.error).toContain("pi");
    expect(saved).toEqual([]);
  });

  test("saves and masks speech API settings", async () => {
    const authContext: RequestAuthContext = {
      npub: "npub1viewer",
      actorNpub: "npub1viewer",
      session: null,
      delegatedByBot: false,
    };
    const saved: Array<{ npub: string; key: string; value: string }> = [];
    const handler = createHandler({
      authContext,
      settings: {
        speech_provider: "local",
        speech_api_key: "sk-test-1234567890",
        speech_model: "tts-1",
        speech_format: "mp3",
        speech_summary_model: "openai/gpt-4o-mini",
      },
      onSet: (npub, key, value) => {
        saved.push({ npub, key, value });
      },
    });

    const putUrl = new URL("http://localhost:3000/api/user/settings/speech_model");
    const putRequest = new Request(putUrl.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: " gpt-4o-mini-tts " }),
    });
    const putResponse = await handler(putRequest, putUrl, "PUT", authContext);
    expect(putResponse.status).toBe(200);
    expect(saved).toEqual([{ npub: "npub1viewer", key: "speech_model", value: "gpt-4o-mini-tts" }]);

    const getUrl = new URL("http://localhost:3000/api/user/settings");
    const getResponse = await handler(new Request(getUrl.toString()), getUrl, "GET", authContext);
    const body = await getResponse.json() as { settings: Record<string, string> };
    expect(body.settings.speech_api_key).toBe("sk-t..7890");
    expect(body.settings.speech_provider).toBe("local");
    expect(body.settings.speech_model).toBe("tts-1");
    expect(body.settings.speech_format).toBe("mp3");
    expect(body.settings.speech_summary_model).toBe("openai/gpt-4o-mini");
  });
});
