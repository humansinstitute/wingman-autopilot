import type { RequestAuthContext } from "../auth/request-context";
import type { WorkspaceScope } from "../workspaces/workspace-scope";
import type { AppsApiContext } from "./apps-api-routes";
import { handleAppsApi } from "./apps-api-routes";
import type { DocsApiContext } from "./docs-routes";
import { handleDocsApi } from "./docs-routes";
import type { AppRecord } from "../apps/app-registry";
import type { WorkspaceDelegationStore } from "../storage/workspace-delegation-store";
import {
  buildDelegatedWorkspaceScope,
  createOwnerScopedAuthContext,
  delegationAllowsApp,
  delegationAllowsPath,
  DelegationScopes,
  resolveOwnerAccess,
} from "../auth/delegation-access";
import { normaliseNpub } from "../identity/npub-utils";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

interface OwnerRouteMatch {
  ownerNpub: string;
  subpath: string;
}

export interface OwnerSpaceRoutesContext {
  workspaceDelegationStore: WorkspaceDelegationStore;
  resolveWorkspace: (context?: RequestAuthContext) => WorkspaceScope;
  buildAppsContext: (
    appsAuthContext: RequestAuthContext,
    workspaceScopeOverride?: WorkspaceScope,
    canAccessAppOverride?: (app: AppRecord) => boolean,
  ) => AppsApiContext;
  docsApiContext: DocsApiContext;
  listDirectories: (
    path: string | null,
    query: string | undefined,
    scope: WorkspaceScope,
  ) => Promise<unknown>;
  createDirectoryEntry: (
    parentInput: string | null | undefined,
    nameInput: unknown,
    scopeOverride?: WorkspaceScope,
  ) => Promise<unknown>;
}

function matchOwnerRoute(pathname: string): OwnerRouteMatch | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0] !== "api" || parts[1] !== "owners") {
    return null;
  }
  const ownerNpub = normaliseNpub(parts[2] ?? null);
  if (!ownerNpub) {
    return null;
  }
  const subpath = `/${parts.slice(3).join("/")}`;
  return { ownerNpub, subpath };
}

function cloneUrlWithPath(url: URL, pathname: string): URL {
  const cloned = new URL(url.toString());
  cloned.pathname = pathname;
  return cloned;
}

function createRewrittenRequest(request: Request, url: URL): Request {
  return new Request(url.toString(), request);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const payload = await request.clone().json();
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function collectPotentialPathValues(
  url: URL,
  body: Record<string, unknown> | null,
): string[] {
  const values: string[] = [];
  const queryPath = url.searchParams.get("path");
  if (queryPath) {
    values.push(queryPath);
  }
  const queryDirectory = url.searchParams.get("directory");
  if (queryDirectory) {
    values.push(queryDirectory);
  }
  if (!body) {
    return values;
  }
  const keys = ["path", "directory", "parent", "targetDirectory"];
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim().length > 0) {
      values.push(value);
    }
  }
  return values;
}

function hasWorkspacePathFilters(
  delegation: ReturnType<WorkspaceDelegationStore["findActiveDelegation"]>,
): boolean {
  const filters = delegation?.resourceFilters;
  if (!filters) {
    return true;
  }
  return Boolean(
    filters.pathPrefixes?.length ||
    filters.projectRoots?.length ||
    filters.appRoots?.length,
  );
}

export async function handleOwnerSpaceApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: OwnerSpaceRoutesContext,
): Promise<Response | null> {
  const matched = matchOwnerRoute(url.pathname);
  if (!matched) {
    return null;
  }

  if (
    matched.subpath === "/apps" ||
    matched.subpath.startsWith("/apps/") ||
    matched.subpath === "/workspace/tree"
  ) {
    const requiredScope =
      method === "GET" || method === "HEAD"
        ? DelegationScopes.AppsRead
        : DelegationScopes.AppsManage;
    const access = resolveOwnerAccess(
      authContext,
      matched.ownerNpub,
      ctx.workspaceDelegationStore.findActiveDelegation.bind(ctx.workspaceDelegationStore),
      requiredScope,
    );
    if (!access) {
      return Response.json({ error: "Delegation required" }, { status: 403 });
    }
    const ownerAuthContext = createOwnerScopedAuthContext(authContext, matched.ownerNpub);
    const ownerWorkspace = ctx.resolveWorkspace(ownerAuthContext);
    if (
      !hasWorkspacePathFilters(access.delegation) &&
      (matched.subpath === "/workspace/tree" || matched.subpath === "/apps/clone")
    ) {
      return Response.json({ error: "Delegation does not grant workspace path access" }, { status: 403 });
    }
    const delegatedWorkspace = buildDelegatedWorkspaceScope(ownerWorkspace, access.delegation);
    const rewrittenUrl = cloneUrlWithPath(url, `/api${matched.subpath}`);
    const appsCtx = ctx.buildAppsContext(
      ownerAuthContext,
      delegatedWorkspace,
      (app) =>
        normaliseNpub(app.ownerNpub ?? null) === matched.ownerNpub &&
        delegationAllowsApp(access.delegation, app),
    );
    return handleAppsApi(
      createRewrittenRequest(request, rewrittenUrl),
      rewrittenUrl,
      method,
      ownerAuthContext,
      appsCtx,
    );
  }

  if (matched.subpath.startsWith("/docs/")) {
    const requiredScope =
      method === "GET" || method === "HEAD"
        ? DelegationScopes.FilesRead
        : DelegationScopes.FilesWrite;
    const access = resolveOwnerAccess(
      authContext,
      matched.ownerNpub,
      ctx.workspaceDelegationStore.findActiveDelegation.bind(ctx.workspaceDelegationStore),
      requiredScope,
    );
    if (!access) {
      return Response.json({ error: "Delegation required" }, { status: 403 });
    }
    const ownerAuthContext = createOwnerScopedAuthContext(authContext, matched.ownerNpub);
    const ownerWorkspace = ctx.resolveWorkspace(ownerAuthContext);
    const body = method === "GET" || method === "HEAD" ? null : await readJsonBody(request);
    const requestedPaths = collectPotentialPathValues(url, body);
    const deniedPath = requestedPaths.find((candidate) => !delegationAllowsPath(access.delegation, ownerWorkspace, candidate));
    if (deniedPath) {
      return Response.json({ error: "Path is outside delegated access" }, { status: 403 });
    }
    const rewrittenUrl = cloneUrlWithPath(url, `/api${matched.subpath}`);
    return handleDocsApi(
      createRewrittenRequest(request, rewrittenUrl),
      rewrittenUrl,
      method,
      ownerAuthContext,
      ctx.docsApiContext,
    );
  }

  if (matched.subpath === "/directories") {
    const requiredScope =
      method === "GET" || method === "HEAD"
        ? DelegationScopes.FilesRead
        : DelegationScopes.FilesWrite;
    const access = resolveOwnerAccess(
      authContext,
      matched.ownerNpub,
      ctx.workspaceDelegationStore.findActiveDelegation.bind(ctx.workspaceDelegationStore),
      requiredScope,
    );
    if (!access) {
      return Response.json({ error: "Delegation required" }, { status: 403 });
    }
    const ownerAuthContext = createOwnerScopedAuthContext(authContext, matched.ownerNpub);
    const ownerWorkspace = ctx.resolveWorkspace(ownerAuthContext);
    const delegatedWorkspace = buildDelegatedWorkspaceScope(ownerWorkspace, access.delegation);
    if (method === "GET") {
      const pathParam = url.searchParams.get("path");
      if (!delegationAllowsPath(access.delegation, ownerWorkspace, pathParam)) {
        return Response.json({ error: "Path is outside delegated access" }, { status: 403 });
      }
      try {
        const data = await ctx.listDirectories(
          pathParam,
          url.searchParams.get("query") ?? undefined,
          delegatedWorkspace,
        );
        return Response.json(data);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }

    if (method === "POST") {
      const payload = await readJsonBody(request);
      if (!payload) {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }
      const parentInput = typeof payload.parent === "string" ? payload.parent : null;
      if (!delegationAllowsPath(access.delegation, ownerWorkspace, parentInput)) {
        return Response.json({ error: "Path is outside delegated access" }, { status: 403 });
      }
      try {
        const data = await ctx.createDirectoryEntry(parentInput, payload.name, delegatedWorkspace);
        return Response.json(data, { status: 201 });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }
  }

  return null;
}
