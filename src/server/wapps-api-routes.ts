import type { RequestAuthContext } from "../auth/request-context";
import type { AccessAction } from "../auth/access-control";
import type { AppRecord } from "../apps/app-registry";
import type { RuntimeBotIdentity } from "../agent-chat/types";
import { normaliseNpub } from "../identity/npub-utils";
import {
  WappScopeAccessError,
  type WappScopeAccessResolver,
} from "../wapps/scope-access";
import { createWappAppNsec, deriveWappAppNpubFromNsec } from "../wapps/app-key";
import { HttpTowerWappRegistrar, TowerWappRegistrationError, type TowerWappRegistrar } from "../wapps/tower-registration";
import { buildFlightDeckWappRecordPayload, type WappPublisher } from "../wapps/wapp-publisher";
import { createWappTemplate } from "../wapps/wapp-template";
import type { WappAppKeyMode, WappRecord, WappSchedule, WappScheduleWindow, WappStatus, WappTowerBinding } from "../wapps/types";
import type { WappStore } from "../wapps/wapp-store";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface WappsApiContext {
  adminNpub: string | null;
  viewerNpub: string | null;
  sourceWingmanUrl: string;
  flightDeckAppNamespace: string;
  AccessActions: {
    AppsManage: AccessAction;
  };
  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  ensureDirectory: (root: string) => Promise<string>;
  canAccessApp: (app: AppRecord) => boolean;
  appRegistry: {
    getApp: (id: string) => Promise<AppRecord | undefined>;
  };
  appAliasRegistry: {
    getByAppId: (id: string) => Promise<{ alias: string } | undefined>;
  };
  wappStore: WappStore;
  publisher: WappPublisher;
  scopeAccessResolver: WappScopeAccessResolver;
  towerRegistrationIdentity: RuntimeBotIdentity | null;
  towerWappRegistrar?: TowerWappRegistrar;
  buildLaunchUrl: (alias: string | null, app: AppRecord) => string;
}

interface PreparedTowerRegistration {
  binding: WappTowerBinding;
  appNpub: string;
  appNsec: string;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function wappNsecInput(body: Record<string, unknown>): string | null {
  return text(body.wappNsec ?? body.wapp_nsec ?? body.WAPP_NSEC);
}

function status(value: unknown): WappStatus | undefined {
  const normalized = text(value);
  if (normalized === "archived") return "archived";
  if (normalized === "active") return "active";
  return undefined;
}

function appKeyMode(value: unknown): WappAppKeyMode | undefined {
  const normalized = text(value);
  if (normalized === "generate") return "generate";
  if (normalized === "import") return "import";
  return undefined;
}

function isoOrNull(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeTime(value: unknown): string | null {
  const raw = text(value);
  if (!raw || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) return null;
  return raw;
}

function normalizeDays(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const days = Array.from(new Set(value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 6)))
    .sort((left, right) => left - right);
  return days.length > 0 ? days : undefined;
}

function normalizeScheduleWindow(value: unknown): WappScheduleWindow | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const startTime = normalizeTime(input.startTime ?? input.start_time);
  const endTime = normalizeTime(input.endTime ?? input.end_time);
  if (!startTime || !endTime) return null;
  const days = normalizeDays(input.days);
  return days ? { days, startTime, endTime } : { startTime, endTime };
}

function normalizeSchedule(value: unknown): WappSchedule | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const windows = Array.isArray(input.windows)
    ? input.windows.map(normalizeScheduleWindow).filter((window): window is WappScheduleWindow => Boolean(window))
    : [];
  const schedule: WappSchedule = {
    timezone: text(input.timezone),
    startsAt: isoOrNull(input.startsAt ?? input.starts_at),
    endsAt: isoOrNull(input.endsAt ?? input.ends_at),
    windows,
  };
  if (!schedule.timezone && !schedule.startsAt && !schedule.endsAt && windows.length === 0) return null;
  return schedule;
}

function canAccessWapp(ctx: WappsApiContext, wapp: WappRecord): boolean {
  if (ctx.adminNpub && ctx.viewerNpub === ctx.adminNpub) return true;
  return Boolean(ctx.viewerNpub && (wapp.ownerNpub === ctx.viewerNpub || wapp.allowedNpubs.includes(ctx.viewerNpub)));
}

async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? body as Record<string, unknown> : null;
}

function scopeAccessErrorResponse(error: unknown): Response {
  if (error instanceof WappScopeAccessError) {
    const status = error.code === "scope-access-unavailable" ? 503 : 400;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  return Response.json({ error: (error as Error).message }, { status: 400 });
}

function wappInputErrorResponse(error: unknown): Response {
  return Response.json({ error: (error as Error).message }, { status: 400 });
}

function towerRegistrationErrorResponse(error: unknown): Response {
  if (error instanceof TowerWappRegistrationError) {
    return Response.json({
      error: "wapp-tower-registration-failed",
      message: error.message,
      detailCode: error.detailCode,
      details: error.details ?? null,
    }, { status: error.status && error.status >= 400 && error.status < 500 ? 400 : 502 });
  }
  return Response.json({
    error: "wapp-tower-registration-failed",
    message: (error as Error).message,
  }, { status: 502 });
}

function getTowerWappRegistrar(ctx: WappsApiContext): TowerWappRegistrar {
  return ctx.towerWappRegistrar ?? new HttpTowerWappRegistrar();
}

function requireTowerRegistrationIdentity(ctx: WappsApiContext): RuntimeBotIdentity {
  if (!ctx.towerRegistrationIdentity) {
    throw new TowerWappRegistrationError("Tower-backed WApps require a configured Wingman instance identity for Tower registration", {
      status: 503,
      detailCode: "tower_registration_identity_missing",
    });
  }
  return ctx.towerRegistrationIdentity;
}

function prepareTowerRegistration(
  ctx: WappsApiContext,
  input: {
    towerBindingId: string | null | undefined;
    appKeyMode: WappAppKeyMode | undefined;
    appNsec: string | null | undefined;
    existing?: WappRecord | null;
  },
): PreparedTowerRegistration | null {
  const towerBindingId = input.towerBindingId === undefined ? input.existing?.towerBindingId ?? null : input.towerBindingId;
  if (!towerBindingId) return null;
  const binding = ctx.wappStore.getTowerBinding(towerBindingId);
  if (!binding) throw new Error(`Unknown WApp Tower binding: ${towerBindingId}`);
  const existingNsec = input.existing ? ctx.wappStore.getAppNsec(input.existing.id) : null;
  if (existingNsec) {
    if (input.appKeyMode !== undefined || input.appNsec !== undefined) {
      throw new Error("WApp app key replacement is not supported for existing assignments");
    }
    if (!input.existing?.appNpub) {
      throw new Error("Existing Tower-backed WApp assignment is missing the derived app npub");
    }
    return { binding, appNsec: existingNsec, appNpub: input.existing.appNpub };
  }
  if (input.existing?.towerBindingId || input.existing?.appNpub) {
    throw new Error("Existing Tower-backed WApp assignment is missing encrypted WAPP_NSEC");
  }
  const appNsec = createWappAppNsec(input.appKeyMode, input.appNsec);
  return { binding, appNsec, appNpub: deriveWappAppNpubFromNsec(appNsec) };
}

async function registerPreparedTowerWapp(
  ctx: WappsApiContext,
  prepared: PreparedTowerRegistration | null,
  appName: string,
): Promise<void> {
  if (!prepared) return;
  try {
    await getTowerWappRegistrar(ctx).register({
      towerUrl: prepared.binding.towerUrl,
      workspaceOwnerNpub: prepared.binding.workspaceOwnerNpub,
      appNpub: prepared.appNpub,
      appName,
      authority: requireTowerRegistrationIdentity(ctx),
    });
  } catch (error) {
    if (error instanceof TowerWappRegistrationError) throw error;
    throw new TowerWappRegistrationError((error as Error).message);
  }
}

export async function handleWappsApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: WappsApiContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/wapps")) return null;

  const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
  if (denied) return denied;

  if (url.pathname === "/api/wapps" && method === "GET") {
    const wapps = ctx.wappStore.list().filter((wapp) => canAccessWapp(ctx, wapp));
    return Response.json({ wapps });
  }

  if (url.pathname === "/api/wapps/tower-bindings" && method === "GET") {
    return Response.json({
      bindings: ctx.wappStore.listTowerBindings(),
      defaultBinding: ctx.wappStore.getDefaultTowerBinding(),
    });
  }

  if (url.pathname === "/api/wapps/tower-bindings" && method === "POST") {
    const body = await parseBody(request);
    if (!body) return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    const label = text(body.label);
    const towerUrl = text(body.towerUrl ?? body.tower_url);
    const workspaceOwnerNpub = normaliseNpub(text(body.workspaceOwnerNpub ?? body.workspace_owner_npub));
    if (!label) return Response.json({ error: "label is required" }, { status: 400 });
    if (!towerUrl) return Response.json({ error: "towerUrl is required" }, { status: 400 });
    if (!workspaceOwnerNpub) return Response.json({ error: "workspaceOwnerNpub is required" }, { status: 400 });
    try {
      const binding = ctx.wappStore.createTowerBinding({
        id: text(body.id) ?? undefined,
        label,
        towerUrl,
        workspaceOwnerNpub,
        userAlias: text(body.userAlias ?? body.user_alias),
        isDefault: body.isDefault === true || body.is_default === true,
      });
      return Response.json({ binding }, { status: 201 });
    } catch (error) {
      return wappInputErrorResponse(error);
    }
  }

  if (url.pathname === "/api/wapps" && method === "POST") {
    const body = await parseBody(request);
    if (!body) return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    const appId = text(body.appId ?? body.app_id);
    const title = text(body.title);
    const workspaceOwnerNpub = normaliseNpub(text(body.workspaceOwnerNpub ?? body.workspace_owner_npub));
    const scopeId = text(body.scopeId ?? body.scope_id);
    if (!appId) return Response.json({ error: "appId is required" }, { status: 400 });
    if (!title) return Response.json({ error: "title is required" }, { status: 400 });
    if (!workspaceOwnerNpub) return Response.json({ error: "workspaceOwnerNpub is required" }, { status: 400 });
    if (!scopeId) return Response.json({ error: "scopeId is required" }, { status: 400 });
    const app = await ctx.appRegistry.getApp(appId);
    if (!app || !ctx.canAccessApp(app)) return Response.json({ error: "App not found" }, { status: 404 });
    if (!app.webApp) return Response.json({ error: "WApps can only be created from web apps" }, { status: 400 });
    const ownerNpub = normaliseNpub(app.ownerNpub ?? ctx.viewerNpub);
    const createdByNpub = normaliseNpub(ctx.viewerNpub);
    if (!ownerNpub || !createdByNpub) return Response.json({ error: "Unable to resolve WApp owner" }, { status: 403 });
    const alias = (await ctx.appAliasRegistry.getByAppId(app.id))?.alias ?? null;
    const scopeAccess = await ctx.scopeAccessResolver.resolveWappScopeAccess({
      workspaceOwnerNpub,
      scopeId,
      ownerNpub,
      appRoot: app.root,
    }).catch((error) => error);
    if (scopeAccess instanceof Error) return scopeAccessErrorResponse(scopeAccess);
    try {
      const towerRegistration = prepareTowerRegistration(ctx, {
        towerBindingId: text(body.towerBindingId ?? body.tower_binding_id),
        appKeyMode: appKeyMode(body.appKeyMode ?? body.app_key_mode),
        appNsec: wappNsecInput(body),
      });
      await registerPreparedTowerWapp(ctx, towerRegistration, title);
      const wapp = ctx.wappStore.create({
        appId: app.id,
        title,
        description: text(body.description),
        ownerNpub,
        createdByNpub,
        workspaceOwnerNpub,
        scopeId: scopeAccess.scopeId,
        scopeLineage: scopeAccess.scopeLineage,
        allowedNpubs: scopeAccess.allowedNpubs,
        launchUrl: ctx.buildLaunchUrl(alias, app),
        sourceWingmanUrl: ctx.sourceWingmanUrl,
        subdomainAlias: alias,
        towerBindingId: towerRegistration?.binding.id ?? text(body.towerBindingId ?? body.tower_binding_id),
        appKeyMode: towerRegistration ? "import" : appKeyMode(body.appKeyMode ?? body.app_key_mode),
        appNsec: towerRegistration?.appNsec ?? wappNsecInput(body),
        status: status(body.status) ?? "active",
        schedule: normalizeSchedule(body.schedule) ?? null,
      });
      return Response.json({ wapp }, { status: 201 });
    } catch (error) {
      if (error instanceof TowerWappRegistrationError) return towerRegistrationErrorResponse(error);
      return wappInputErrorResponse(error);
    }
  }

  if (url.pathname === "/api/wapps/templates/create" && method === "POST") {
    const body = await parseBody(request);
    if (!body) return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    const root = text(body.root);
    if (!root) return Response.json({ error: "root is required" }, { status: 400 });
    try {
      const resolvedRoot = await ctx.ensureDirectory(root);
      return Response.json({ template: await createWappTemplate(resolvedRoot, { force: body.force === true }) }, { status: 201 });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  const bindingMatch = url.pathname.match(/^\/api\/wapps\/tower-bindings\/([^/]+)$/);
  if (bindingMatch) {
    const bindingId = decodeURIComponent(bindingMatch[1]!);
    if (method !== "PUT" && method !== "PATCH") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    const body = await parseBody(request);
    if (!body) return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    try {
      const binding = ctx.wappStore.updateTowerBinding(bindingId, {
        label: text(body.label) ?? undefined,
        towerUrl: text(body.towerUrl ?? body.tower_url) ?? undefined,
        workspaceOwnerNpub: normaliseNpub(text(body.workspaceOwnerNpub ?? body.workspace_owner_npub)) ?? undefined,
        userAlias: body.userAlias === null || body.user_alias === null ? null : text(body.userAlias ?? body.user_alias) ?? undefined,
        isDefault: body.isDefault === undefined && body.is_default === undefined
          ? undefined
          : body.isDefault === true || body.is_default === true,
      });
      if (!binding) return Response.json({ error: "WApp Tower binding not found" }, { status: 404 });
      return Response.json({ binding });
    } catch (error) {
      return wappInputErrorResponse(error);
    }
  }

  const match = url.pathname.match(/^\/api\/wapps\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return null;
  const id = decodeURIComponent(match[1]!);
  const action = match[2] ?? null;
  const wapp = ctx.wappStore.get(id);
  if (!wapp || !canAccessWapp(ctx, wapp)) return Response.json({ error: "WApp not found" }, { status: 404 });

  if (!action && method === "GET") {
    return Response.json({ wapp });
  }

  if (action === "nsec" && method === "GET") {
    if (!wapp.towerBindingId) {
      return Response.json({ error: "WApp is not Tower-backed" }, { status: 400 });
    }
    const wappNsec = ctx.wappStore.getAppNsec(wapp.id);
    if (!wappNsec) {
      return Response.json({ error: "WAPP_NSEC not found for this WApp" }, { status: 404 });
    }
    return Response.json({
      wappId: wapp.id,
      appId: wapp.appId,
      appNpub: wapp.appNpub,
      keyName: "WAPP_NSEC",
      wappNsec,
    });
  }

  if (!action && (method === "PUT" || method === "PATCH")) {
    const body = await parseBody(request);
    if (!body) return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    const nextScopeId = text(body.scopeId ?? body.scope_id) ?? wapp.scopeId;
    const nextWorkspaceOwnerNpub = normaliseNpub(text(body.workspaceOwnerNpub ?? body.workspace_owner_npub)) ?? wapp.workspaceOwnerNpub;
    const requestedAllowlist = body.allowedNpubs !== undefined || body.allowed_npubs !== undefined;
    const requestedLineage = body.scopeLineage !== undefined || body.scope_lineage !== undefined;
    const shouldRefreshScope = requestedAllowlist || requestedLineage || nextScopeId !== wapp.scopeId || nextWorkspaceOwnerNpub !== wapp.workspaceOwnerNpub;
    const app = shouldRefreshScope ? await ctx.appRegistry.getApp(wapp.appId) : undefined;
    const scopeAccess = shouldRefreshScope
      ? await ctx.scopeAccessResolver.resolveWappScopeAccess({
        workspaceOwnerNpub: nextWorkspaceOwnerNpub,
        scopeId: nextScopeId,
        ownerNpub: wapp.ownerNpub,
        appRoot: app?.root ?? null,
      }).catch((error) => error)
      : null;
    if (scopeAccess instanceof Error) return scopeAccessErrorResponse(scopeAccess);
    try {
      const nextTowerBindingId = body.towerBindingId === null || body.tower_binding_id === null
        ? null
        : text(body.towerBindingId ?? body.tower_binding_id) ?? undefined;
      const towerRegistration = prepareTowerRegistration(ctx, {
        towerBindingId: nextTowerBindingId,
        appKeyMode: appKeyMode(body.appKeyMode ?? body.app_key_mode),
        appNsec: wappNsecInput(body) ?? undefined,
        existing: wapp,
      });
      await registerPreparedTowerWapp(ctx, towerRegistration, text(body.title) ?? wapp.title);
      const updated = ctx.wappStore.update(id, {
        title: text(body.title) ?? undefined,
        description: body.description === null ? null : text(body.description) ?? undefined,
        workspaceOwnerNpub: nextWorkspaceOwnerNpub,
        scopeId: nextScopeId,
        scopeLineage: scopeAccess ? scopeAccess.scopeLineage : undefined,
        allowedNpubs: scopeAccess ? scopeAccess.allowedNpubs : undefined,
        towerBindingId: towerRegistration?.binding.id ?? nextTowerBindingId,
        appKeyMode: towerRegistration && !wapp.towerBindingId ? "import" : appKeyMode(body.appKeyMode ?? body.app_key_mode),
        appNsec: towerRegistration && !wapp.towerBindingId ? towerRegistration.appNsec : wappNsecInput(body) ?? undefined,
        status: status(body.status),
        schedule: normalizeSchedule(body.schedule),
      });
      return Response.json({ wapp: updated });
    } catch (error) {
      if (error instanceof TowerWappRegistrationError) return towerRegistrationErrorResponse(error);
      return wappInputErrorResponse(error);
    }
  }

  if (!action && method === "DELETE") {
    const deletedAt = new Date().toISOString();
    const deletedWapp: WappRecord = {
      ...wapp,
      recordState: "deleted",
      status: "archived",
      updatedAt: deletedAt,
      lastPublishedAt: deletedAt,
    };
    const payload = buildFlightDeckWappRecordPayload(deletedWapp, ctx.flightDeckAppNamespace);
    const result = await ctx.publisher.publish(payload);
    if (!result.published) {
      return Response.json({
        error: result.error ?? "wapp-delete-publish-unavailable",
        published: false,
        reference: result.reference ?? null,
        payload,
      }, { status: result.status ?? 503 });
    }
    const deleted = ctx.wappStore.update(id, { status: "archived", recordState: "deleted", lastPublishedAt: deletedAt });
    return Response.json({ wapp: deleted, published: true, reference: result.reference ?? null, payload });
  }

  if (action === "archive" && method === "POST") {
    const archivedAt = new Date().toISOString();
    const archivedWapp: WappRecord = {
      ...wapp,
      status: "archived",
      recordState: "archived",
      updatedAt: archivedAt,
      lastPublishedAt: archivedAt,
    };
    const payload = buildFlightDeckWappRecordPayload(archivedWapp, ctx.flightDeckAppNamespace);
    const result = await ctx.publisher.publish(payload);
    if (!result.published) {
      return Response.json({
        error: result.error ?? "wapp-archive-publish-unavailable",
        published: false,
        reference: result.reference ?? null,
        payload,
      }, { status: result.status ?? 503 });
    }
    const archived = ctx.wappStore.update(id, { status: "archived", recordState: "archived", lastPublishedAt: archivedAt });
    return Response.json({ wapp: archived, published: true, reference: result.reference ?? null, payload });
  }

  if (action === "refresh-allowlist" && method === "POST") {
    const app = await ctx.appRegistry.getApp(wapp.appId);
    const scopeAccess = await ctx.scopeAccessResolver.resolveWappScopeAccess({
      workspaceOwnerNpub: wapp.workspaceOwnerNpub,
      scopeId: wapp.scopeId,
      ownerNpub: wapp.ownerNpub,
      appRoot: app?.root ?? null,
      scopeLineage: wapp.scopeLineage,
    }).catch((error) => error);
    if (scopeAccess instanceof Error) return scopeAccessErrorResponse(scopeAccess);
    const updated = ctx.wappStore.update(id, {
      scopeLineage: scopeAccess.scopeLineage,
      allowedNpubs: scopeAccess.allowedNpubs,
    });
    return Response.json({ wapp: updated });
  }

  if (action === "publish" && method === "POST") {
    const payload = buildFlightDeckWappRecordPayload(wapp, ctx.flightDeckAppNamespace);
    const result = await ctx.publisher.publish(payload);
    if (!result.published) {
      return Response.json({
        error: result.error ?? "wapp-publish-unavailable",
        published: false,
        reference: result.reference ?? null,
        payload,
      }, { status: result.status ?? 503 });
    }
    const updated = ctx.wappStore.update(id, { lastPublishedAt: new Date().toISOString() });
    return Response.json({ wapp: updated, published: result.published, reference: result.reference ?? null, payload });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
