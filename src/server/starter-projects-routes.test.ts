import { describe, expect, test } from "bun:test";

import type { AppRecord } from "../apps/app-registry";
import { handleStarterProjectsApi, type StarterProjectsApiContext } from "./starter-projects-routes";

const ownerNpub = "npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy";

function normaliseOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function makeContext(): StarterProjectsApiContext & {
  setupCalls: string[];
  startCalls: string[];
} {
  const setupCalls: string[] = [];
  const startCalls: string[] = [];
  let registeredApp: AppRecord | null = null;

  return {
    setupCalls,
    startCalls,
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
        id: "wapp-starter-sqlite",
        name: "WApp Starter with SQLite DB",
        gitUrl: "https://github.com/humansinstitute/wapp-starter.git",
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
});
