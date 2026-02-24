import type { RequestAuthContext } from "../auth/request-context";
import type { AccessAction } from "../auth/access-control";
import type { WorkspaceScope } from "../workspaces/workspace-scope";
import type { AppLifecycleScripts, AppRecord } from "../apps/app-registry";
import type { AppProcessStatus } from "../apps/app-process-manager";
import type { StarterProjectRecord } from "../storage/starter-project-store";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

interface StarterProjectResponse {
  id: string;
  name: string;
  gitUrl: string;
  webApp: boolean;
  scriptAuto: boolean;
  notes: string | null;
  setupCommand: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StarterLaunchResult {
  root: string;
  label: string;
  scripts: Partial<AppLifecycleScripts>;
}

export interface StarterProjectsApiContext {
  adminNpub: string | null;
  workspaceScope: WorkspaceScope;
  viewerNpub: string | null;

  AccessActions: {
    AppsManage: AccessAction;
  };

  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  normaliseOptionalString: (value: unknown) => string | null;
  normaliseNpub: (npub: string | null | undefined) => string | null;
  cloneRepositoryIntoWorkspace: (scope: WorkspaceScope, repoUrl: string, directoryName: string) => Promise<StarterLaunchResult>;
  buildAppResponse: (
    app: AppRecord,
    status: AppProcessStatus,
    options?: { ownerAlias?: string | null; subdomainAlias?: string | null },
  ) => Record<string, unknown>;

  appRegistry: {
    registerApp: (input: {
      label: string;
      root: string;
      scripts?: AppLifecycleScripts;
      notes?: string;
      ownerNpub?: string | null;
      webApp?: boolean;
      webAppPort?: number | null;
    }) => Promise<AppRecord>;
    getApp: (id: string) => Promise<AppRecord | undefined>;
  };

  appProcessManager: {
    getStatus: (id: string) => Promise<AppProcessStatus>;
    setup: (id: string) => Promise<AppProcessStatus>;
  };

  appAliasRegistry: {
    getByAppId: (id: string) => Promise<{ alias: string } | undefined>;
  };

  starterProjectStore: {
    list: () => StarterProjectRecord[];
    getById: (id: string) => StarterProjectRecord | null;
    create: (input: {
      name: string;
      gitUrl: string;
      webApp?: boolean;
      scriptAuto?: boolean;
      notes?: string | null;
      setupCommand?: string | null;
      updatedBy?: string | null;
    }) => StarterProjectRecord;
    update: (
      id: string,
      updates: {
        name?: string;
        gitUrl?: string;
        webApp?: boolean;
        scriptAuto?: boolean;
        notes?: string | null;
        setupCommand?: string | null;
        updatedBy?: string | null;
      },
    ) => StarterProjectRecord;
    remove: (id: string) => boolean;
  };

  npubProjectStore: {
    getByPath: (ownerNpub: string, root: string) => { id: string } | null;
    setAppId: (projectId: string, appId: string) => void;
    createProject: (ownerNpub: string, root: string, label?: string) => { id: string } | null;
  };
}

function toStarterResponse(record: StarterProjectRecord): StarterProjectResponse {
  return {
    id: record.id,
    name: record.name,
    gitUrl: record.gitUrl,
    webApp: Boolean(record.webApp),
    scriptAuto: Boolean(record.scriptAuto),
    notes: record.notes ?? null,
    setupCommand: record.setupCommand ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toBoolean(input: unknown): boolean | undefined {
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return input !== 0;
  if (typeof input === "string") {
    const normalized = input.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  }
  return undefined;
}

function slugifyDirectoryName(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const slug = trimmed
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (!slug) {
    throw new Error("Name must include letters or numbers");
  }
  if (slug === "." || slug === "..") {
    throw new Error("Invalid folder name");
  }
  if (slug.includes("/")) {
    throw new Error("Folder name must be a single path segment");
  }
  return slug;
}

async function registerLaunchedStarterApp(
  ctx: StarterProjectsApiContext,
  ownerNpub: string,
  root: string,
  label: string,
  scripts: Partial<AppLifecycleScripts>,
  starter: StarterProjectRecord,
): Promise<{ app: AppRecord; setupStatus: AppProcessStatus | null }> {
  const scriptPayload: AppLifecycleScripts = {};
  const incoming = scripts ?? {};
  const keys: Array<keyof AppLifecycleScripts> = ["start", "stop", "restart", "setup", "build"];
  keys.forEach((key) => {
    const command = incoming[key];
    if (typeof command === "string" && command.trim().length > 0) {
      scriptPayload[key] = command.trim();
    }
  });
  if (starter.scriptAuto) {
    const setupCommand = ctx.normaliseOptionalString(starter.setupCommand) ?? "bun run setup";
    scriptPayload.setup = setupCommand;
  }

  const app = await ctx.appRegistry.registerApp({
    label,
    root,
    scripts: Object.keys(scriptPayload).length > 0 ? scriptPayload : undefined,
    notes: starter.notes ?? undefined,
    ownerNpub,
    webApp: Boolean(starter.webApp),
  });

  try {
    let project = ctx.npubProjectStore.getByPath(ownerNpub, root);
    if (project) {
      ctx.npubProjectStore.setAppId(project.id, app.id);
    } else {
      project = ctx.npubProjectStore.createProject(ownerNpub, root, app.label || undefined);
      if (project) {
        ctx.npubProjectStore.setAppId(project.id, app.id);
      }
    }
  } catch (linkError) {
    console.warn(`[starter-projects] failed to link app ${app.id} to npub-project: ${(linkError as Error).message}`);
  }

  if (!starter.scriptAuto) {
    return { app, setupStatus: null };
  }

  const setupStatus = await ctx.appProcessManager.setup(app.id);
  return { app, setupStatus };
}

export async function handleStarterProjectsApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: StarterProjectsApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;

  if (pathname === "/api/apps/starter-projects" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) return denied;
    return Response.json({ starterProjects: ctx.starterProjectStore.list().map(toStarterResponse) });
  }

  if (pathname === "/api/apps/starter-projects/launch" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) return denied;

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const body = payload as Record<string, unknown>;
    const starterId = ctx.normaliseOptionalString(body.starterId);
    const appName = ctx.normaliseOptionalString(body.name);
    if (!starterId) return Response.json({ error: "Starter project id is required" }, { status: 400 });
    if (!appName) return Response.json({ error: "Name is required" }, { status: 400 });

    const starter = ctx.starterProjectStore.getById(starterId);
    if (!starter) return Response.json({ error: "Starter project not found" }, { status: 404 });

    const ownerNpub =
      ctx.workspaceScope.isAdmin ? ctx.normaliseNpub(authContext.npub ?? null) ?? ctx.adminNpub : ctx.viewerNpub;
    if (!ownerNpub) {
      return Response.json({ error: "Unable to resolve app owner" }, { status: 403 });
    }

    const directoryName = slugifyDirectoryName(appName);
    try {
      const cloneResult = await ctx.cloneRepositoryIntoWorkspace(ctx.workspaceScope, starter.gitUrl, directoryName);
      const { app, setupStatus } = await registerLaunchedStarterApp(
        ctx,
        ownerNpub,
        cloneResult.root,
        appName,
        cloneResult.scripts,
        starter,
      );
      const status = await ctx.appProcessManager.getStatus(app.id);
      const aliasRecord = await ctx.appAliasRegistry.getByAppId(app.id);
      const appPayload = ctx.buildAppResponse(app, status, { subdomainAlias: aliasRecord?.alias ?? null });
      return Response.json(
        {
          app: appPayload,
          starterProject: toStarterResponse(starter),
          setup: {
            attempted: starter.scriptAuto,
            status: setupStatus ?? null,
          },
        },
        { status: 201 },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/admin/starter-projects" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) return denied;
    if (!ctx.workspaceScope.isAdmin) return Response.json({ error: "admin-only" }, { status: 403 });
    return Response.json({ starterProjects: ctx.starterProjectStore.list().map(toStarterResponse) });
  }

  if (pathname === "/api/admin/starter-projects" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) return denied;
    if (!ctx.workspaceScope.isAdmin) return Response.json({ error: "admin-only" }, { status: 403 });
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    const body = payload as Record<string, unknown>;
    try {
      const created = ctx.starterProjectStore.create({
        name: ctx.normaliseOptionalString(body.name) ?? "",
        gitUrl: ctx.normaliseOptionalString(body.gitUrl) ?? "",
        webApp: toBoolean(body.webApp) ?? false,
        scriptAuto: toBoolean(body.scriptAuto) ?? false,
        notes: ctx.normaliseOptionalString(body.notes) ?? null,
        setupCommand: ctx.normaliseOptionalString(body.setupCommand) ?? null,
        updatedBy: ctx.normaliseNpub(authContext.npub ?? null),
      });
      return Response.json({ starterProject: toStarterResponse(created) }, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname.startsWith("/api/admin/starter-projects/") && method === "PUT") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) return denied;
    if (!ctx.workspaceScope.isAdmin) return Response.json({ error: "admin-only" }, { status: 403 });
    const id = decodeURIComponent(pathname.slice("/api/admin/starter-projects/".length));
    if (!id) return Response.json({ error: "Starter project id is required" }, { status: 400 });

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    const body = payload as Record<string, unknown>;
    try {
      const updated = ctx.starterProjectStore.update(id, {
        name: Object.prototype.hasOwnProperty.call(body, "name") ? ctx.normaliseOptionalString(body.name) ?? "" : undefined,
        gitUrl: Object.prototype.hasOwnProperty.call(body, "gitUrl") ? ctx.normaliseOptionalString(body.gitUrl) ?? "" : undefined,
        webApp: Object.prototype.hasOwnProperty.call(body, "webApp") ? toBoolean(body.webApp) : undefined,
        scriptAuto: Object.prototype.hasOwnProperty.call(body, "scriptAuto") ? toBoolean(body.scriptAuto) : undefined,
        notes: Object.prototype.hasOwnProperty.call(body, "notes") ? ctx.normaliseOptionalString(body.notes) : undefined,
        setupCommand:
          Object.prototype.hasOwnProperty.call(body, "setupCommand") ? ctx.normaliseOptionalString(body.setupCommand) : undefined,
        updatedBy: ctx.normaliseNpub(authContext.npub ?? null),
      });
      return Response.json({ starterProject: toStarterResponse(updated) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.toLowerCase().includes("not found") ? 404 : 400;
      return Response.json({ error: message }, { status });
    }
  }

  if (pathname.startsWith("/api/admin/starter-projects/") && method === "DELETE") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) return denied;
    if (!ctx.workspaceScope.isAdmin) return Response.json({ error: "admin-only" }, { status: 403 });
    const id = decodeURIComponent(pathname.slice("/api/admin/starter-projects/".length));
    if (!id) return Response.json({ error: "Starter project id is required" }, { status: 400 });
    const removed = ctx.starterProjectStore.remove(id);
    if (!removed) return Response.json({ error: "Starter project not found" }, { status: 404 });
    return Response.json({ ok: true });
  }

  return null;
}
