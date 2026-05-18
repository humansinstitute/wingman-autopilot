import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { RequestAuthContext } from '../auth/request-context';
import type { AccessAction } from '../auth/access-control';
import type { WorkspaceScope } from '../workspaces/workspace-scope';
import type { TreeNode } from '../apps/app-detector';
import type { AppLifecycleAction, AppLifecycleScripts, AppRecord } from '../apps/app-registry';
import type { AppProcessStatus } from '../apps/app-process-manager';
import { AppActionInProgressError, AppScriptMissingError } from '../apps/app-process-manager';
import type { CaproverStore, CaproverTargetClient } from '../caprover';
import type { WappRecord } from '../wapps/types';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';

const CAPTAIN_DEFINITION_FILES = ['captain-definition', 'captain-definition.json'] as const;

async function readCaptainDefinition(appRoot: string): Promise<{ fileName: string; content: string } | null> {
  for (const fileName of CAPTAIN_DEFINITION_FILES) {
    try {
      return {
        fileName,
        content: await readFile(join(appRoot, fileName), 'utf8'),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return null;
}

function normaliseCaproverTargetName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9-]*$/.test(normalized) ? normalized : null;
}

function resolveCaproverTargets(
  targets: CaproverTargetClient[],
  requestedTarget: unknown,
): CaproverTargetClient[] | { error: string; status: number } {
  if (targets.length === 0) {
    return { error: 'CapRover is not configured. Set CAPROVER_URL and LOGIN_CODE environment variables.', status: 503 };
  }

  const requested = requestedTarget === undefined ? 'all' : normaliseCaproverTargetName(requestedTarget);
  if (!requested) {
    return { error: 'caproverTarget must be "all" or a configured target name', status: 400 };
  }
  if (requested === 'all') {
    return targets;
  }

  const target = targets.find((candidate) => candidate.name === requested);
  if (!target) {
    return { error: `Unknown CapRover target: ${requested}`, status: 400 };
  }

  return [target];
}

export interface AppsApiContext {
  adminNpub: string | null;
  sharedInstanceAccess: boolean;
  workspaceScope: WorkspaceScope;
  viewerNpub: string | null;

  AccessActions: {
    AppsManage: AccessAction;
  };

  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;

  normaliseOptionalString: (value: unknown) => string | null;
  normaliseNpub: (npub: string | null | undefined) => string | null;
  ensureDirectory: (root: string, scope: WorkspaceScope) => Promise<string>;
  ensureWithinAllowedDirectories: (target: string, scope: WorkspaceScope) => void;
  parseAppScripts: (input: unknown) => AppLifecycleScripts;
  parseBooleanInput: (value: unknown) => boolean | undefined;
  parsePortInput: (value: unknown) => number | null;
  parseBooleanFlag: (value: string | null) => boolean;

  appActions: AppLifecycleAction[];

  canAccessApp: (app: AppRecord) => boolean;
  deriveDirectoryNameFromUrl: (url: string) => string;
  cloneRepositoryIntoWorkspace: (
    scope: WorkspaceScope,
    repoUrl: string,
    directoryName: string,
  ) => Promise<{ root: string; label: string; scripts: Partial<AppLifecycleScripts> }>;
  scanDirectoryTree: (root: string, depth: number, registeredPaths: Set<string>) => Promise<TreeNode[]>;
  buildAppOwnerFilters: (
    apps: AppRecord[],
    cache: Map<string, string | null>,
  ) => Array<{ value: string; npub: string | null; alias: string | null; label: string; appCount: number }>;
  defaultAppProcessStatus: (appId: string) => AppProcessStatus;
  resolveOwnerAliasCached: (ownerNpub: string | null | undefined, cache: Map<string, string | null>) => string | null;
  buildAppResponse: (
    app: AppRecord,
    status: AppProcessStatus,
    options?: { ownerAlias?: string | null; subdomainAlias?: string | null },
  ) => Record<string, unknown>;

  appRegistry: {
    listApps: () => Promise<AppRecord[]>;
    getApp: (id: string) => Promise<AppRecord | undefined>;
    discoverScripts: (root: string) => Promise<Partial<AppLifecycleScripts>>;
    registerApp: (input: {
      label: string;
      root: string;
      scripts?: AppLifecycleScripts;
      tmuxSession?: string;
      notes?: string;
      ownerNpub?: string | null;
      webApp?: boolean;
      webAppPort?: number | null;
    }) => Promise<AppRecord>;
    updateApp: (
      id: string,
      input: {
        label?: string;
        root?: string;
        scripts?: AppLifecycleScripts;
        tmuxSession?: string;
        notes?: string | null;
        webApp?: boolean;
        webAppPort?: number | null;
      },
    ) => Promise<AppRecord>;
    removeApp: (id: string) => Promise<boolean>;
  };

  appProcessManager: {
    listStatuses: () => Promise<AppProcessStatus[]>;
    getStatus: (id: string) => Promise<AppProcessStatus>;
    tailLogs: (id: string, lines: number) => Promise<string[]>;
    clearLogs: (id: string) => Promise<void>;
    forget: (id: string) => void;
    kill: (id: string) => Promise<void>;
    start: (id: string) => Promise<AppProcessStatus>;
    stop: (id: string) => Promise<AppProcessStatus>;
    restart: (id: string) => Promise<AppProcessStatus>;
    setup: (id: string) => Promise<AppProcessStatus>;
    build: (id: string) => Promise<AppProcessStatus>;
  };

  appAliasRegistry: {
    getByAppId: (id: string) => Promise<{ alias: string } | undefined>;
  };

  wappStore?: {
    list: () => WappRecord[];
  };

  npubProjectStore: {
    getByPath: (ownerNpub: string, root: string) => { id: string } | null;
    setAppId: (projectId: string, appId: string) => void;
    createProject: (ownerNpub: string, root: string, label?: string) => { id: string } | null;
    clearAppIdByAppId: (appId: string) => void;
  };

  createCaproverTargetClientsFromEnv: () => CaproverTargetClient[];
  createAppTarball: (rootPath: string) => Promise<{ buffer: Uint8Array; fileCount: number }>;
  caproverStore: CaproverStore;
}

interface CaproverDeployTargetResult {
  targetName: string;
  serverUrl: string;
  success: boolean;
  liveUrl: string | null;
  deployedVersion: number | null;
  error: string | null;
}

function withCaproverDeploymentInfo(
  appResponse: Record<string, unknown>,
  appId: string,
  caproverStore: CaproverStore,
): Record<string, unknown> {
  const trackedApp = caproverStore.getAppByLocalAppId(appId);
  return {
    ...appResponse,
    caproverName: trackedApp?.caproverName ?? null,
    caproverLiveUrl: trackedApp?.liveUrl ?? null,
    caproverDeployedVersion: trackedApp?.deployedVersion ?? null,
  };
}

function canAccessWapp(ctx: AppsApiContext, wapp: WappRecord): boolean {
  if (ctx.adminNpub && ctx.viewerNpub === ctx.adminNpub) return true;
  if (ctx.workspaceScope.isAdmin) return true;
  return Boolean(ctx.viewerNpub && (wapp.ownerNpub === ctx.viewerNpub || wapp.allowedNpubs.includes(ctx.viewerNpub)));
}

function buildWappsByAppId(ctx: AppsApiContext): Map<string, WappRecord[]> {
  const rows = ctx.wappStore?.list?.() ?? [];
  const byAppId = new Map<string, WappRecord[]>();
  for (const wapp of rows) {
    if (!wapp || wapp.recordState !== 'active' || !canAccessWapp(ctx, wapp)) continue;
    const existing = byAppId.get(wapp.appId) ?? [];
    existing.push(wapp);
    byAppId.set(wapp.appId, existing);
  }
  for (const entries of byAppId.values()) {
    entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  return byAppId;
}

function withWappAssignments(
  appResponse: Record<string, unknown>,
  appId: string,
  wappsByAppId: Map<string, WappRecord[]>,
): Record<string, unknown> {
  const wapps = wappsByAppId.get(appId) ?? [];
  return {
    ...appResponse,
    wapps: wapps.map((wapp) => ({
      id: wapp.id,
      appId: wapp.appId,
      title: wapp.title,
      workspaceOwnerNpub: wapp.workspaceOwnerNpub,
      scopeId: wapp.scopeId,
      launchUrl: wapp.launchUrl,
      recordState: wapp.recordState,
      lastPublishedAt: wapp.lastPublishedAt,
      updatedAt: wapp.updatedAt,
    })),
  };
}

export async function handleAppsApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: AppsApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;

  if (pathname === '/api/apps/clone' && method === 'POST') {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }
    if (!payload || typeof payload !== 'object') {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }
    const repoUrl = ctx.normaliseOptionalString((payload as Record<string, unknown>).url);
    if (!repoUrl) {
      return Response.json({ error: 'Repository URL is required' }, { status: 400 });
    }
    const directoryInput = ctx.normaliseOptionalString(
      (payload as Record<string, unknown>).directory ?? (payload as Record<string, unknown>).name,
    );
    const fallbackDirectory = ctx.deriveDirectoryNameFromUrl(repoUrl);
    const directoryName = directoryInput ?? fallbackDirectory;
    if (!directoryName) {
      return Response.json({ error: 'Folder name is required' }, { status: 400 });
    }
    try {
      const result = await ctx.cloneRepositoryIntoWorkspace(ctx.workspaceScope, repoUrl, directoryName);
      return Response.json(result, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === '/api/workspace/tree' && method === 'GET') {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) {
      return denied;
    }

    const scanRoot = ctx.workspaceScope.aliasDirectory ?? ctx.workspaceScope.defaultDirectory;

    const depthParam = url.searchParams.get('depth');
    const depth = depthParam ? Math.min(Math.max(parseInt(depthParam, 10) || 4, 1), 6) : 4;

    try {
      const registeredApps = await ctx.appRegistry.listApps();
      const registeredPaths = new Set(
        registeredApps
          .filter((app) => ctx.canAccessApp(app))
          .map((app) => app.root),
      );

      const nodes = await ctx.scanDirectoryTree(scanRoot, depth, registeredPaths);

      return Response.json({
        root: scanRoot,
        depth,
        nodes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 500 });
    }
  }

  if (pathname === '/api/apps' && method === 'GET') {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    const viewerNormalizedNpub = ctx.viewerNpub;
    const tailParam = url.searchParams.get('tail') ?? url.searchParams.get('logs');
    const tail = tailParam ? Number.parseInt(tailParam, 10) : 0;
    const includeLogs = Number.isFinite(tail) && tail > 0;
    const tailCount = includeLogs ? Math.min(Math.max(tail, 1), 2000) : 0;
    const ownerAliasCache = new Map<string, string | null>();
    const normalizeOwnerFilter = (value: string | null): string | null | '__anonymous__' => {
      if (!value || value === 'all') {
        return null;
      }
      if (value === '__anonymous__') {
        return '__anonymous__';
      }
      const normalized = ctx.normaliseNpub(value);
      return normalized ?? null;
    };
    try {
      const [apps, statuses] = await Promise.all([ctx.appRegistry.listApps(), ctx.appProcessManager.listStatuses()]);
      const canSeeAllApps = ctx.sharedInstanceAccess || ctx.workspaceScope.isAdmin;
      const visibleApps = canSeeAllApps ? apps : apps.filter((app) => ctx.canAccessApp(app));
      const ownerFilters = canSeeAllApps ? ctx.buildAppOwnerFilters(visibleApps, ownerAliasCache) : [];
      const hasFilterParam = url.searchParams.has('npub');
      let ownerFilter: string | null | '__anonymous__' =
        canSeeAllApps ? normalizeOwnerFilter(url.searchParams.get('npub')) : viewerNormalizedNpub ?? null;
      if (canSeeAllApps && !hasFilterParam) {
        ownerFilter = null;
      }
      const filteredApps =
        ownerFilter === null
          ? visibleApps
          : visibleApps.filter((app) => {
              const normalizedOwner = ctx.normaliseNpub(app.ownerNpub ?? null);
              if (ownerFilter === '__anonymous__') {
                return normalizedOwner === null;
              }
              return normalizedOwner === ownerFilter;
            });
      const statusMap = new Map(statuses.map((status) => [status.appId, status]));
      const wappsByAppId = buildWappsByAppId(ctx);
      const data = await Promise.all(
        filteredApps.map(async (app) => {
          const status = statusMap.get(app.id) ?? ctx.defaultAppProcessStatus(app.id);
          const ownerAlias = ctx.resolveOwnerAliasCached(app.ownerNpub, ownerAliasCache);
          const aliasRecord = await ctx.appAliasRegistry.getByAppId(app.id);
          const subdomainAlias = aliasRecord?.alias ?? null;
          const record = withWappAssignments(
            withCaproverDeploymentInfo(
              ctx.buildAppResponse(app, status, { ownerAlias, subdomainAlias }),
              app.id,
              ctx.caproverStore,
            ),
            app.id,
            wappsByAppId,
          );
          if (includeLogs) {
            try {
              record.logs = await ctx.appProcessManager.tailLogs(app.id, tailCount);
            } catch {
              record.logs = [];
            }
          }
          return record;
        }),
      );
      return Response.json({
        apps: data,
        filters: {
          npubs: ownerFilters,
          active: ownerFilter ?? null,
        },
      });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  }

  if (pathname === '/api/apps' && method === 'POST') {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    if (!payload || typeof payload !== 'object') {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    const record = payload as Record<string, unknown>;
    const root = ctx.normaliseOptionalString(record.root);
    if (!root) {
      return Response.json({ error: 'App root path is required' }, { status: 400 });
    }

    let resolvedRoot: string;
    try {
      resolvedRoot = await ctx.ensureDirectory(root, ctx.workspaceScope);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }

    const label = ctx.normaliseOptionalString(record.label);
    const tmuxSession = ctx.normaliseOptionalString(record.tmuxSession);
    const notes = ctx.normaliseOptionalString(record.notes);
    const overrides = ctx.parseAppScripts(record.scripts);
    const webAppInput =
      record.webApp !== undefined ? ctx.parseBooleanInput(record.webApp) : ctx.parseBooleanInput((record as Record<string, unknown>).isWebApp);
    const requestedWebApp = webAppInput ?? false;
    const requestedPort = ctx.parsePortInput(record.webAppPort);
    const ownerNpub = ctx.viewerNpub ?? (ctx.workspaceScope.isAdmin ? ctx.adminNpub : null);
    if (!ownerNpub) {
      return Response.json({ error: 'Unable to resolve app owner' }, { status: 403 });
    }
    const discoverOverride =
      typeof record.discover === 'boolean'
        ? (record.discover as boolean)
        : typeof record.discoverScripts === 'boolean'
          ? (record.discoverScripts as boolean)
          : typeof record.autoDiscover === 'boolean'
            ? (record.autoDiscover as boolean)
            : undefined;
    const shouldDiscover = discoverOverride ?? true;

    let scripts: AppLifecycleScripts = overrides;
    if (shouldDiscover) {
      try {
        const discovered = await ctx.appRegistry.discoverScripts(resolvedRoot);
        scripts = { ...discovered, ...overrides };
      } catch (error) {
        return Response.json({ error: `Failed to discover scripts: ${(error as Error).message}` }, { status: 400 });
      }
    }

    try {
      const app = await ctx.appRegistry.registerApp({
        label: label ?? '',
        root: resolvedRoot,
        scripts: Object.keys(scripts).length > 0 ? scripts : undefined,
        tmuxSession: tmuxSession ?? undefined,
        notes: notes ?? undefined,
        ownerNpub,
        webApp: requestedWebApp,
        webAppPort: requestedPort ?? undefined,
      });

      try {
        let project = ctx.npubProjectStore.getByPath(ownerNpub, resolvedRoot);
        if (project) {
          ctx.npubProjectStore.setAppId(project.id, app.id);
        } else {
          project = ctx.npubProjectStore.createProject(ownerNpub, resolvedRoot, app.label || undefined);
          if (project) {
            ctx.npubProjectStore.setAppId(project.id, app.id);
          }
        }
      } catch (linkError) {
        console.warn(`[apps] failed to link app ${app.id} to npub-project: ${(linkError as Error).message}`);
      }

      const status = await ctx.appProcessManager.getStatus(app.id);
      const aliasRecord = await ctx.appAliasRegistry.getByAppId(app.id);
      const subdomainAlias = aliasRecord?.alias ?? null;
      return Response.json(
        {
          app: withCaproverDeploymentInfo(
            ctx.buildAppResponse(app, status, { subdomainAlias }),
            app.id,
            ctx.caproverStore,
          ),
        },
        { status: 201 },
      );
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  if (pathname === '/api/apps/discover' && method === 'GET') {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    const root = ctx.normaliseOptionalString(url.searchParams.get('root'));
    if (!root) {
      return Response.json({ error: 'Root directory is required' }, { status: 400 });
    }
    try {
      const resolvedRoot = await ctx.ensureDirectory(root, ctx.workspaceScope);
      const scripts = await ctx.appRegistry.discoverScripts(resolvedRoot);
      return Response.json({ root: resolvedRoot, scripts });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  if (pathname.startsWith('/api/apps/')) {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    const parts = pathname.split('/');
    const id = parts[3];
    if (!id) {
      return Response.json({ error: 'App id is required' }, { status: 400 });
    }
    if (!ctx.workspaceScope.isAdmin && id === 'wingman-core') {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    if (method === 'GET' && parts.length === 4) {
      const app = await ctx.appRegistry.getApp(id);
      if (!app) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      if (!ctx.canAccessApp(app)) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      const status = await ctx.appProcessManager.getStatus(id);
      const aliasRecord = await ctx.appAliasRegistry.getByAppId(id);
      const subdomainAlias = aliasRecord?.alias ?? null;
      const appResponse = withWappAssignments(
        withCaproverDeploymentInfo(
          ctx.buildAppResponse(app, status, { subdomainAlias }),
          app.id,
          ctx.caproverStore,
        ),
        app.id,
        buildWappsByAppId(ctx),
      );
      return Response.json({
        app: appResponse,
      });
    }

    if (method === 'PUT' && parts.length === 4) {
      const current = await ctx.appRegistry.getApp(id);
      if (!current) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      if (!ctx.canAccessApp(current)) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }

      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
      }

      if (!payload || typeof payload !== 'object') {
        return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
      }

      const record = payload as Record<string, unknown>;
      const label = ctx.normaliseOptionalString(record.label);
      const root = ctx.normaliseOptionalString(record.root);
      const tmuxSession = ctx.normaliseOptionalString(record.tmuxSession);
      const notesValue = record.notes === null ? null : ctx.normaliseOptionalString(record.notes);
      const overrides = ctx.parseAppScripts(record.scripts);
      const webAppRaw = record.webApp ?? (record as Record<string, unknown>).isWebApp;
      const webAppInput = ctx.parseBooleanInput(webAppRaw);
      const webAppPortInput = ctx.parsePortInput(record.webAppPort);
      const shouldDiscover =
        typeof record.discoverScripts === 'boolean'
          ? (record.discoverScripts as boolean)
          : typeof record.discover === 'boolean'
            ? (record.discover as boolean)
            : false;

      let resolvedRoot: string | undefined;
      if (root) {
        try {
          resolvedRoot = await ctx.ensureDirectory(root, ctx.workspaceScope);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: message }, { status: 400 });
        }
      }

      let scripts: AppLifecycleScripts | undefined = undefined;
      if (shouldDiscover || Object.keys(overrides).length > 0) {
        const discoverRoot = resolvedRoot ?? current.root;
        if (!ctx.workspaceScope.isAdmin) {
          try {
            ctx.ensureWithinAllowedDirectories(discoverRoot, ctx.workspaceScope);
          } catch {
            return Response.json({ error: 'App root outside allowed directories' }, { status: 403 });
          }
        }
        if (shouldDiscover) {
          try {
            const discovered = await ctx.appRegistry.discoverScripts(discoverRoot);
            scripts = { ...discovered, ...overrides };
          } catch (error) {
            return Response.json(
              { error: `Failed to discover scripts: ${(error as Error).message}` },
              { status: 400 },
            );
          }
        } else {
          scripts = overrides;
        }
      }

      try {
        const updatePayload: {
          label?: string;
          root?: string;
          tmuxSession?: string;
          notes?: string | null;
          scripts?: AppLifecycleScripts;
          webApp?: boolean;
          webAppPort?: number;
        } = {
          label: label ?? undefined,
          root: resolvedRoot ?? undefined,
          tmuxSession: tmuxSession ?? undefined,
          notes: notesValue,
          scripts,
        };
        if (webAppInput !== undefined) {
          updatePayload.webApp = webAppInput;
        }
        if (webAppPortInput !== null) {
          updatePayload.webAppPort = webAppPortInput;
        }
        const updated = await ctx.appRegistry.updateApp(id, updatePayload);
        ctx.appProcessManager.forget(id);
        const status = await ctx.appProcessManager.getStatus(id);
        const aliasRecord = await ctx.appAliasRegistry.getByAppId(id);
        const subdomainAlias = aliasRecord?.alias ?? null;
        return Response.json({
          app: withWappAssignments(
            withCaproverDeploymentInfo(
              ctx.buildAppResponse(updated, status, { subdomainAlias }),
              updated.id,
              ctx.caproverStore,
            ),
            updated.id,
            buildWappsByAppId(ctx),
          ),
        });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }

    if (method === 'DELETE' && parts.length === 4) {
      const killParam = url.searchParams.get('killSession') ?? url.searchParams.get('killTmux');
      const killSession = ctx.parseBooleanFlag(killParam);
      const current = await ctx.appRegistry.getApp(id);
      if (!current) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      if (!ctx.canAccessApp(current)) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      try {
        if (killSession) {
          await ctx.appProcessManager.kill(id);
        }
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 500 });
      }

      try {
        ctx.npubProjectStore.clearAppIdByAppId(id);
      } catch (clearError) {
        console.warn(`[apps] failed to clear app ${id} from npub-projects: ${(clearError as Error).message}`);
      }

      const removed = await ctx.appRegistry.removeApp(id);
      if (!removed) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      ctx.appProcessManager.forget(id);
      return Response.json({ id, deleted: true, killedSession: killSession });
    }

    if (method === 'GET' && parts[4] === 'logs') {
      const app = await ctx.appRegistry.getApp(id);
      if (!app) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      if (!ctx.canAccessApp(app)) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      const tailParam = url.searchParams.get('tail');
      const tail = tailParam ? Number.parseInt(tailParam, 10) : 100;
      const lines = Number.isNaN(tail) || tail <= 0 ? 100 : Math.min(tail, 2000);
      try {
        const logs = await ctx.appProcessManager.tailLogs(id, lines);
        return Response.json({ id, logs });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }

    if (method === 'POST' && parts[4] === 'actions') {
      const app = await ctx.appRegistry.getApp(id);
      if (!app) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      if (!ctx.canAccessApp(app)) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
      }
      if (!payload || typeof payload !== 'object') {
        return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
      }

      const actionValue = ctx.normaliseOptionalString((payload as Record<string, unknown>).action);
      if (!actionValue) {
        return Response.json({ error: 'Action is required' }, { status: 400 });
      }
      const normalizedAction = actionValue.toLowerCase();
      if (normalizedAction === 'clear-logs') {
        try {
          await ctx.appProcessManager.clearLogs(id);
          const status = await ctx.appProcessManager.getStatus(id);
          const aliasRecord = await ctx.appAliasRegistry.getByAppId(id);
          const subdomainAlias = aliasRecord?.alias ?? null;
          const appResponse = withWappAssignments(
            withCaproverDeploymentInfo(
              ctx.buildAppResponse(app, status, { subdomainAlias }),
              app.id,
              ctx.caproverStore,
            ),
            app.id,
            buildWappsByAppId(ctx),
          );
          return Response.json({
            app: appResponse,
          });
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 500 });
        }
      }

      if (!ctx.appActions.includes(normalizedAction as AppLifecycleAction)) {
        return Response.json({ error: `Unsupported action: ${actionValue}` }, { status: 400 });
      }

      try {
        let status: AppProcessStatus;
        switch (normalizedAction as AppLifecycleAction) {
          case 'start':
            status = await ctx.appProcessManager.start(id);
            break;
          case 'stop':
            status = await ctx.appProcessManager.stop(id);
            break;
          case 'restart':
            status = await ctx.appProcessManager.restart(id);
            break;
          case 'setup':
            status = await ctx.appProcessManager.setup(id);
            break;
          case 'build':
            status = await ctx.appProcessManager.build(id);
            break;
          default:
            return Response.json({ error: `Unsupported action: ${actionValue}` }, { status: 400 });
        }
        const aliasRecord = await ctx.appAliasRegistry.getByAppId(id);
        const subdomainAlias = aliasRecord?.alias ?? null;
        const appResponse = withWappAssignments(
          withCaproverDeploymentInfo(
            ctx.buildAppResponse(app, status, { subdomainAlias }),
            app.id,
            ctx.caproverStore,
          ),
          app.id,
          buildWappsByAppId(ctx),
        );
        return Response.json({
          app: appResponse,
        });
      } catch (error) {
        if (error instanceof AppActionInProgressError) {
          return Response.json({ error: error.message }, { status: 409 });
        }
        if (error instanceof AppScriptMissingError) {
          return Response.json({ error: error.message }, { status: 400 });
        }
        return Response.json({ error: (error as Error).message }, { status: 500 });
      }
    }

    if (method === 'POST' && parts[4] === 'deploy-to-caprover') {
      const app = await ctx.appRegistry.getApp(id);
      if (!app) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      if (!ctx.canAccessApp(app)) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      if (!app.webApp) {
        return Response.json({ error: 'Only web apps can be deployed to CapRover' }, { status: 400 });
      }

      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
      }
      if (!payload || typeof payload !== 'object') {
        return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
      }

      const record = payload as Record<string, unknown>;
      const caproverNameRaw = ctx.normaliseOptionalString(record.caproverName);
      if (!caproverNameRaw) {
        return Response.json({ error: 'caproverName is required' }, { status: 400 });
      }

      const caproverName = caproverNameRaw.toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(caproverName)) {
        return Response.json(
          { error: 'caproverName must be lowercase, start with a letter, and contain only letters, numbers, and hyphens' },
          { status: 400 },
        );
      }
      if (caproverName.length > 50) {
        return Response.json({ error: 'caproverName must be 50 characters or less' }, { status: 400 });
      }

      let captainDefContent: string;
      let captainDefFileName: string;
      try {
        const captainDef = await readCaptainDefinition(app.root);
        if (!captainDef) {
          return Response.json(
            { error: `captain-definition or captain-definition.json not found in ${app.root}` },
            { status: 400 },
          );
        }
        captainDefContent = captainDef.content;
        captainDefFileName = captainDef.fileName;
      } catch {
        return Response.json(
          { error: `Unable to read captain definition in ${app.root}` },
          { status: 400 },
        );
      }

      let captainDef: unknown;
      try {
        captainDef = JSON.parse(captainDefContent);
      } catch {
        return Response.json({ error: `Invalid ${captainDefFileName} format` }, { status: 400 });
      }

      if (!captainDef || typeof captainDef !== 'object') {
        return Response.json({ error: `${captainDefFileName} must be a valid object` }, { status: 400 });
      }
      const defRecord = captainDef as Record<string, unknown>;
      if (defRecord.schemaVersion !== 2) {
        return Response.json({ error: `${captainDefFileName} must have schemaVersion: 2` }, { status: 400 });
      }

      if (!defRecord.imageName && !defRecord.dockerfileLines && !defRecord.templateId) {
        const dockerfilePath = join(app.root, 'Dockerfile');
        try {
          await stat(dockerfilePath);
        } catch {
          return Response.json(
            {
              error:
                `${captainDefFileName} requires imageName, dockerfileLines, or a Dockerfile in the app root. ` +
                'See https://caprover.com/docs/captain-definition-file.html',
            },
            { status: 400 },
          );
        }
      }

      const resolvedTargets = resolveCaproverTargets(
        ctx.createCaproverTargetClientsFromEnv(),
        record.caproverTarget,
      );
      if (!Array.isArray(resolvedTargets)) {
        return Response.json(
          { error: resolvedTargets.error },
          { status: resolvedTargets.status },
        );
      }

      let tracked = ctx.caproverStore.getAppByLocalAppId(id);
      if (!tracked) {
        tracked = ctx.caproverStore.createApp({
          caproverName,
          appId: id,
          liveUrl: null,
        });
      }

      let tarResult;
      try {
        tarResult = await ctx.createAppTarball(app.root);
        console.log(`[caprover] Created tarball with ${tarResult.fileCount} files for ${caproverName}`);
      } catch (tarError) {
        const tarMessage = tarError instanceof Error ? tarError.message : String(tarError);
        return Response.json({ error: `Failed to create tarball: ${tarMessage}` }, { status: 400 });
      }

      const targetResults: CaproverDeployTargetResult[] = [];
      for (const target of resolvedTargets) {
        const deployment = ctx.caproverStore.createDeployment({
          caproverAppId: tracked.id,
          targetName: target.name,
          deployMethod: 'tar_upload',
        });

        try {
          const existingRemote = await target.client.getApp(tracked.caproverName);
          if (!existingRemote) {
            await target.client.createApp(tracked.caproverName, false);
          }

          const liveUrl = await target.client.getAppUrl(tracked.caproverName);
          await target.client.deployFromTarball(tracked.caproverName, Buffer.from(tarResult.buffer));

          const remoteApp = await target.client.getApp(tracked.caproverName);
          const version = remoteApp?.deployedVersion ?? null;

          ctx.caproverStore.updateDeployment(deployment.id, {
            status: 'success',
            version,
            completedAt: new Date().toISOString(),
          });

          tracked = ctx.caproverStore.updateApp(tracked.id, {
            liveUrl: tracked.liveUrl ?? liveUrl,
            deployedVersion: version,
          });

          targetResults.push({
            targetName: target.name,
            serverUrl: target.serverUrl,
            success: true,
            liveUrl,
            deployedVersion: version,
            error: null,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.caproverStore.updateDeployment(deployment.id, {
            status: 'failed',
            completedAt: new Date().toISOString(),
            errorMessage: message,
          });
          targetResults.push({
            targetName: target.name,
            serverUrl: target.serverUrl,
            success: false,
            liveUrl: null,
            deployedVersion: null,
            error: message,
          });
        }
      }

      const successfulTargets = targetResults.filter((result) => result.success);
      const firstSuccess = successfulTargets[0] ?? null;
      if (!firstSuccess) {
        return Response.json(
          {
            success: false,
            caproverName: tracked.caproverName,
            targets: targetResults,
            error: targetResults.map((result) => `${result.targetName}: ${result.error}`).join('; '),
          },
          { status: 502 },
        );
      }

      return Response.json({
        success: true,
        liveUrl: tracked.liveUrl ?? firstSuccess.liveUrl,
        caproverName: tracked.caproverName,
        deployedVersion: firstSuccess.deployedVersion,
        targets: targetResults,
      });
    }
  }

  return null;
}
