import { describe, expect, test } from "bun:test";

import type { AppRecord } from "../apps/app-registry";
import { handleStarterProjectsApi, type StarterProjectsApiContext } from "./starter-projects-routes";

const ownerNpub = "npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy";
const towerWorkspaceOwnerNpub = "npub1jvj7txjsge62gmg7ar7kfu23zd95spw32nz5n0663eq4pzzyyjqsnlaz7e";

function normaliseOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function makeContext(options: { starterId?: string } = {}): StarterProjectsApiContext & {
  setupCalls: string[];
  startCalls: string[];
  towerRegistrations: Array<{
    towerUrl: string;
    workspaceOwnerNpub: string;
    appNpub: string;
    appName: string;
  }>;
} {
  const setupCalls: string[] = [];
  const startCalls: string[] = [];
  const towerRegistrations: Array<{
    towerUrl: string;
    workspaceOwnerNpub: string;
    appNpub: string;
    appName: string;
  }> = [];
  let registeredApp: AppRecord | null = null;

  return {
    setupCalls,
    startCalls,
    towerRegistrations,
    adminNpub: ownerNpub,
    viewerNpub: ownerNpub,
    workspaceScope: {
      defaultDirectory: "/tmp/workspace",
      allowedDirectories: ["/tmp/workspace"],
      aliasDirectory: null,
      docsRoot: "/tmp/workspace",
      docsRootBoundary: "/tmp/workspace/",
      isAdmin: true,
    },
    AccessActions: {
      AppsManage: "apps.manage" as any,
    },
    ensureApiAccess: async () => null,
    normaliseOptionalString,
    normaliseNpub: (npub) => normaliseOptionalString(npub),
    wingmanUrl: "http://127.0.0.1:3256",
    towerUrl: "https://tower.example",
    towerWorkspaceOwnerNpub,
    towerRegistrationIdentity: {
      botNpub: "npub1s4658awhcachmhzk5jhsg256gzdl7e4gh5a9zq8skjyt7g3k2axql224qz",
      botPubkeyHex: "8461bd03983292c1e41822f425274a27d35cfed2f6518cbcdac53ad0ad297b87",
      botSecret: new Uint8Array(32).fill(1),
    },
    towerWappRegistrar: {
      register: async (input) => {
        towerRegistrations.push({
          towerUrl: input.towerUrl,
          workspaceOwnerNpub: input.workspaceOwnerNpub,
          appNpub: input.appNpub,
          appName: input.appName,
        });
        return {
          workspaceOwnerNpub: input.workspaceOwnerNpub,
          appNpub: input.appNpub,
          app: null,
        };
      },
    },
    createRepositoryFromStarter: async () => ({
      root: "/tmp/workspace/code/demo-wapp",
      label: "Demo WApp",
      scripts: {
        start: "bun run start",
        setup: "bun install",
      },
      github: {
        owner: "humansinstitute",
        repo: "demo-wapp",
        cloneUrl: "https://github.com/humansinstitute/demo-wapp.git",
        htmlUrl: "https://github.com/humansinstitute/demo-wapp",
        defaultBranch: "main",
        deployedBranchCreated: true,
        protection: {
          requested: true,
          main: "applied",
          deployed: "applied",
          warnings: [],
        },
      },
    }),
    buildAppResponse: (app, status) => ({ id: app.id, label: app.label, status: status.status }),
    appRegistry: {
      registerApp: async (input) => {
        registeredApp = {
          id: "app-1",
          label: input.label,
          root: input.root,
          scripts: input.scripts ?? {},
          tmuxSession: "demo-wapp",
          ownerNpub: input.ownerNpub ?? null,
          env: input.env,
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          webApp: Boolean(input.webApp),
          webAppPort: 41044,
        };
        return registeredApp;
      },
      getApp: async (id) => registeredApp && registeredApp.id === id ? registeredApp : undefined,
    },
    appProcessManager: {
      getStatus: async (id) => ({
        appId: id,
        status: "running",
        lastAction: "start",
        lastExitCode: 0,
        updatedAt: "2026-07-06T00:00:00.000Z",
        running: true,
        inProgressAction: null,
      }),
      setup: async (id) => {
        setupCalls.push(id);
        return {
          appId: id,
          status: "idle",
          lastAction: "setup",
          lastExitCode: 0,
          updatedAt: "2026-07-06T00:00:00.000Z",
          running: false,
          inProgressAction: null,
        };
      },
      start: async (id) => {
        startCalls.push(id);
        return {
          appId: id,
          status: "running",
          lastAction: "start",
          lastExitCode: 0,
          updatedAt: "2026-07-06T00:00:00.000Z",
          running: true,
          inProgressAction: null,
        };
      },
    },
    appAliasRegistry: {
      getByAppId: async () => ({ alias: "demo-wapp" }),
    },
    starterProjectStore: {
      list: () => [],
      getById: () => ({
        id: options.starterId ?? "wapp-starter-sqlite",
        name: options.starterId === "wapp-starter-tower-pg"
          ? "WApp Starter with Tower PG Backend"
          : "WApp Starter with SQLite DB",
        gitUrl: options.starterId === "wapp-starter-tower-pg"
          ? "https://github.com/humansinstitute/wapp-starter-tower.git"
          : "https://github.com/humansinstitute/wapp-starter.git",
        webApp: true,
        scriptAuto: true,
        notes: "Reference WApp starter",
        setupCommand: "bun install",
        createdAt: "2026-07-06T00:00:00.000Z",
        updatedAt: "2026-07-06T00:00:00.000Z",
        updatedBy: null,
      }),
      create: (() => {
        throw new Error("not used");
      }) as any,
      update: (() => {
        throw new Error("not used");
      }) as any,
      remove: () => false,
    },
    npubProjectStore: {
      getByPath: () => null,
      setAppId: () => undefined,
      createProject: () => ({ id: "project-1" }),
    },
  };
}

describe("handleStarterProjectsApi", () => {
  test("runs setup then starts web apps created from starters", async () => {
    const ctx = makeContext();
    const request = new Request("http://localhost/api/apps/starter-projects/launch", {
      method: "POST",
      body: JSON.stringify({
        starterId: "wapp-starter-sqlite",
        name: "Demo WApp",
        githubOwner: "humansinstitute",
        githubRepo: "demo-wapp",
      }),
    });

    const response = await handleStarterProjectsApi(
      request,
      new URL(request.url),
      "POST",
      {} as any,
      ctx,
    );

    expect(response?.status).toBe(201);
    const app = await ctx.appRegistry.getApp("app-1");
    expect(app?.env).toMatchObject({
      WINGMAN_URL: "http://127.0.0.1:3256",
    });
    expect(ctx.setupCalls).toEqual(["app-1"]);
    expect(ctx.startCalls).toEqual(["app-1"]);
    const payload = await response!.json() as {
      setup: { status: { status: string } };
      start: { status: { status: string }; error: string | null };
    };
    expect(payload.setup.status.status).toBe("idle");
    expect(payload.start.status.status).toBe("running");
    expect(payload.start.error).toBeNull();
  });

  test("injects Tower workspace env for Tower-backed WApp starters", async () => {
    const ctx = makeContext({ starterId: "wapp-starter-tower-pg" });
    const request = new Request("http://localhost/api/apps/starter-projects/launch", {
      method: "POST",
      body: JSON.stringify({
        starterId: "wapp-starter-tower-pg",
        name: "Tower WApp",
        githubOwner: "humansinstitute",
        githubRepo: "tower-wapp",
      }),
    });

    const response = await handleStarterProjectsApi(
      request,
      new URL(request.url),
      "POST",
      {} as any,
      ctx,
    );

    expect(response?.status).toBe(201);
    const app = await ctx.appRegistry.getApp("app-1");
    expect(app?.env).toMatchObject({
      TOWER_URL: "https://tower.example",
      WAPP_OWNER_NPUB: ownerNpub,
      WAPP_WORKSPACE_OWNER_NPUB: towerWorkspaceOwnerNpub,
      WORKSPACE_OWNER_NPUB: towerWorkspaceOwnerNpub,
      WAPP_ALLOWED_NPUBS_JSON: JSON.stringify([ownerNpub]),
      WINGMAN_URL: "http://127.0.0.1:3256",
    });
    expect(app?.env?.WAPP_NSEC).toStartWith("nsec1");
    expect(ctx.towerRegistrations).toHaveLength(1);
    expect(ctx.towerRegistrations[0]).toMatchObject({
      towerUrl: "https://tower.example",
      workspaceOwnerNpub: towerWorkspaceOwnerNpub,
      appName: "Tower WApp",
    });
    expect(ctx.towerRegistrations[0]?.appNpub).toStartWith("npub1");
    expect(ctx.setupCalls).toEqual(["app-1"]);
    expect(ctx.startCalls).toEqual(["app-1"]);
  });
});
