/**
 * API route handlers for /api/* endpoints.
 * Extracted from server.ts to reduce file size.
 */

import type { RequestAuthContext } from "../auth/request-context";
import type { AccessAction } from "../auth/access-control";
import type { WorkspaceScope } from "../workspaces/workspace-scope";
import type { AppRecord } from "../apps/app-registry";
import { normaliseNpub } from "../identity/npub-utils";
import { handleAppsApi, type AppsApiContext } from "./apps-api-routes";
import { handleStarterProjectsApi, type StarterProjectsApiContext } from "./starter-projects-routes";
import { handleChatApi, type ChatApiContext } from "./chat-routes";
import { handleSessionApi, type SessionApiContext } from "./session-api-routes";
import { handleProviderProxyApi, type ProviderProxyApiContext } from "./provider-proxy-routes";
import { handleBillingApi, type BillingApiContext } from "./billing-routes";
import { handleDocsApi, type DocsApiContext } from "./docs-routes";
import { handleAdminUsersApi, type AdminUsersApiContext } from "./admin-users-routes";
import { handleAuthApi, type AuthApiContext } from "./auth-routes";
import {
  handleFeatureFlagsApi,
  type FeatureFlagsApiContext,
} from "./feature-flags-routes";
import {
  handleUploadsApi,
  type UploadApiContext,
} from "./upload-routes";
import { handleSystemRoutes, type SystemRoutesContext } from "./system-routes";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

// ---------- Handler signatures for pre-instantiated API handlers ----------

/* eslint-disable @typescript-eslint/no-explicit-any */
type SimpleApiHandler = (...args: any[]) => Promise<Response | null>;
type AuthedApiHandler = (...args: any[]) => Promise<Response | null>;
type ProjectApiHandler = (...args: any[]) => Promise<Response | null>;
type NpubProjectApiHandler = (...args: any[]) => Promise<Response | null>;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------- Context supplied by server.ts ----------

export interface ApiRoutesContext {
  // Config subset needed by handleApi
  config: {
    port: number;
    agentPortStart: number;
    agentPortMax: number;
    hostUrlBase: string | null;
    connectRelays: string[];
    agents: Record<string, { label: string }>;
    defaultAgent: string;
    giteaUrl: string | null;
  };
  adminNpub: string | null;

  // Pre-instantiated API handlers
  todoApiHandler: AuthedApiHandler;
  projectApiHandler: ProjectApiHandler;
  npubProjectApiHandler: NpubProjectApiHandler;
  browserLogHandler: AuthedApiHandler;
  caproverApiHandler: AuthedApiHandler;
  nightWatchApiHandler: SimpleApiHandler;
  nip98ApiHandler: SimpleApiHandler;
  botCryptoApiHandler: SimpleApiHandler;
  botKeyApiHandler: SimpleApiHandler;
  giteaApiHandler: SimpleApiHandler;
  gitWorkflowApiHandler: SimpleApiHandler;
  ngitApiHandler: SimpleApiHandler;
  superbasedApiHandler: SimpleApiHandler;
  wingmanMcpApiHandler: SimpleApiHandler;
  schedulerApiHandler: SimpleApiHandler;

  // Pre-built route contexts (request-independent)
  sessionApiContext: SessionApiContext;
  docsApiContext: DocsApiContext;
  providerProxyApiContext: ProviderProxyApiContext;
  billingApiContext: BillingApiContext;
  systemRoutesContext: SystemRoutesContext;
  authApiContext: AuthApiContext;
  adminUsersApiContext: AdminUsersApiContext;
  uploadApiContext: UploadApiContext;

  // Stores accessed directly by handleApi
  featureFlagStore: {
    getFlag: (key: string) => unknown;
  };
  userSettingsStore: {
    getAll: (npub: string) => Record<string, string>;
    set: (npub: string, key: string, value: string) => void;
    delete: (npub: string, key: string) => void;
  };
  artifactsStore: {
    get: (id: string) => { filePath: string; mimeType: string | null } | null;
  };

  // Constants
  PROJECTS_FLAG_KEY: string;

  // Core helper functions
  resolveWorkspace: (context?: RequestAuthContext) => WorkspaceScope;
  verifyNip98AuthHeader: (request: Request, url: URL) => string | null;
  resolveFeatureFlagStateForViewer: (
    key: string,
    isAdmin: boolean,
    defaultState?: "on" | "off" | "on_admin",
  ) => { effectiveState: string };
  ensureApiAccess: (
    action: AccessAction,
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ) => Promise<Response | null>;
  serialiseFeatureFlagsForViewer: (isAdmin: boolean) => unknown;

  // Directory helpers
  listDirectories: (
    path: string | null,
    query: string | undefined,
    scope: WorkspaceScope,
  ) => Promise<unknown>;
  createDirectoryEntry: (
    parentInput: string | null | undefined,
    nameInput: unknown,
  ) => Promise<unknown>;

  // Access control actions
  AccessActions: {
    ProjectsManage: AccessAction;
    TodosManage: AccessAction;
    SessionsManage: AccessAction;
    DeploymentsManage: AccessAction;
    FilesRead: AccessAction;
    FilesWrite: AccessAction;
  };

  // Per-request context builders (take request-scoped values, return typed sub-contexts)
  buildStarterProjectsContext: (
    workspaceScope: WorkspaceScope,
    viewerNpub: string | null,
  ) => Parameters<typeof handleStarterProjectsApi>[4];
  buildAppsContext: (
    appsAuthContext: RequestAuthContext,
  ) => Parameters<typeof handleAppsApi>[4];
  buildFeatureFlagsContext: (
    viewerIsAdmin: boolean,
  ) => FeatureFlagsApiContext;
  buildChatContext: (
    viewerNpub: string | null,
    viewerIsAdmin: boolean,
  ) => ChatApiContext;
}

// ---------- Factory ----------

export function createApiRouteHandler(ctx: ApiRoutesContext) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
    authContext: RequestAuthContext,
  ): Promise<Response> => {
    const withProjectApiCors = (response: Response): Response => {
      const headers = new Headers(response.headers);
      const origin = request.headers.get("origin");
      headers.set("Access-Control-Allow-Origin", origin || "*");
      headers.set("Vary", "Origin");
      headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };

    const pathname = url.pathname;
    const workspaceScope = ctx.resolveWorkspace(authContext);
    const viewerIsAdmin = workspaceScope.isAdmin;
    const projectsFlag = ctx.resolveFeatureFlagStateForViewer(ctx.PROJECTS_FLAG_KEY, viewerIsAdmin, "on_admin");
    const projectsEnabled = projectsFlag.effectiveState === "on";
    const viewerNpub = normaliseNpub(authContext.npub ?? null);

    const browserLogResponse = await ctx.browserLogHandler(request, url, method, authContext);
    if (browserLogResponse) {
      return browserLogResponse;
    }

    const providerProxyResponse = await handleProviderProxyApi(request, url, method, ctx.providerProxyApiContext);
    if (providerProxyResponse) {
      return providerProxyResponse;
    }

    const billingApiResponse = await handleBillingApi(request, url, method, authContext, ctx.billingApiContext);
    if (billingApiResponse) {
      return billingApiResponse;
    }

    if (pathname.startsWith("/api/npub-projects")) {
      if (method === "OPTIONS") {
        return withProjectApiCors(new Response(null, { status: 204 }));
      }

      let effectiveAuth = authContext;
      let effectiveIsAdmin = workspaceScope.isAdmin;

      // Allow NIP-98 auth as fallback when no session cookie
      if (!authContext.session) {
        const nip98Npub = ctx.verifyNip98AuthHeader(request, url);
        if (nip98Npub) {
          effectiveAuth = { npub: nip98Npub, session: null };
          effectiveIsAdmin = true; // NIP-98 server keys treated as admin for project lookups
        } else {
          return withProjectApiCors(Response.json({ error: "Authentication required" }, { status: 401 }));
        }
      }

      const response = await ctx.npubProjectApiHandler(
        request,
        url,
        method,
        effectiveAuth,
        effectiveIsAdmin,
      );
      if (response) {
        return withProjectApiCors(response);
      }
      return withProjectApiCors(Response.json({ error: "Not found" }, { status: 404 }));
    }
    if (pathname.startsWith("/api/projects")) {
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.ProjectsManage, request, url, authContext);
      if (denied) {
        return denied;
      }
      if (!projectsEnabled) {
        return Response.json({ error: "projects-disabled" }, { status: 403 });
      }
      const response = await ctx.projectApiHandler(request, url, method, authContext, {
        isAdmin: workspaceScope.isAdmin,
      });
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (pathname.startsWith("/api/todos")) {
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.TodosManage, request, url, authContext);
      if (denied) {
        return denied;
      }
      const response = await ctx.todoApiHandler(request, url, method, authContext);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (pathname.startsWith("/api/nightwatch")) {
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
      if (denied) {
        return denied;
      }
      const response = await ctx.nightWatchApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (pathname.startsWith("/api/scheduler")) {
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
      if (denied) {
        return denied;
      }
      const response = await ctx.schedulerApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // Bot key API — per-user bot identity management.
    // Auth: cookie-based for browser routes, session ID for escrow unlock.
    if (pathname.startsWith("/api/bot-keys")) {
      const response = await ctx.botKeyApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // Bot crypto API — NIP-44 encrypt/decrypt using user's bot key.
    // No auth gate: validated by session ID in the handler.
    if (pathname.startsWith("/api/mcp/bot-crypto")) {
      const response = await ctx.botCryptoApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // MCP NIP-98 API — called by the MCP stdio server running inside agents.
    // No auth gate: requests are validated by session ID in the handler.
    if (pathname.startsWith("/api/mcp/nip98")) {
      const response = await ctx.nip98ApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // Git workflow API — branch, worktree, merge, and status operations.
    // No auth gate: validated by session ID in the handler.
    if (pathname.startsWith("/api/git/")) {
      const response = await ctx.gitWorkflowApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // Gitea API — programmatic git operations scoped to the Gitea remote.
    // No auth gate: validated by session ID in the handler.
    if (pathname.startsWith("/api/gitea")) {
      const response = await ctx.giteaApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // ngit API — NIP-34 git repository operations (publish, push state, list).
    // No auth gate: requests are validated by session ID and grants in the handler.
    if (pathname.startsWith("/api/ngit")) {
      const response = await ctx.ngitApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // SuperBased API — encrypted record CRUD via Flux Adaptor.
    // No auth gate: uses Tier 1 NIP-98 signing internally.
    if (pathname.startsWith("/api/superbased")) {
      const response = await ctx.superbasedApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // MCP Wingman Action API — called by the MCP stdio server running inside agents.
    // No auth gate: requests are validated by session ID in the handler.
    if (pathname.startsWith("/api/mcp/wingman")) {
      const response = await ctx.wingmanMcpApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (pathname.startsWith("/api/caprover")) {
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.DeploymentsManage, request, url, authContext);
      if (denied) {
        return denied;
      }
      const response = await ctx.caproverApiHandler(request, url, method, authContext);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // Private chat API routes
    if (pathname.startsWith("/api/chats") || pathname === "/api/maple/models") {
      if (!authContext.session) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      const chatContext = ctx.buildChatContext(viewerNpub, viewerIsAdmin);
      const response = await handleChatApi(request, url, method, chatContext);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // System routes (delegated to system-routes.ts)
    if (pathname.startsWith("/api/system/")) {
      const systemResponse = await handleSystemRoutes(request, url, method, authContext, ctx.systemRoutesContext);
      if (systemResponse) {
        return systemResponse;
      }
    }

    // Auth routes (delegated to auth-routes.ts)
    if (pathname.startsWith("/api/auth/") || pathname === "/api/identity/profile") {
      const authResult = await handleAuthApi(request, url, method, authContext, ctx.authApiContext);
      if (authResult) return authResult;
    }

    // Admin user routes (delegated to admin-users-routes.ts)
    if (pathname.startsWith("/api/admin/users") || pathname === "/api/admin/ports") {
      const adminUsersResponse = await handleAdminUsersApi(request, url, method, authContext, ctx.adminUsersApiContext);
      if (adminUsersResponse) return adminUsersResponse;
    }

    if (
      pathname === "/api/apps/starter-projects" ||
      pathname === "/api/apps/starter-projects/launch" ||
      pathname === "/api/admin/starter-projects" ||
      pathname.startsWith("/api/admin/starter-projects/")
    ) {
      const starterProjectsCtx = ctx.buildStarterProjectsContext(workspaceScope, viewerNpub);
      const starterProjectsResponse = await handleStarterProjectsApi(request, url, method, authContext, starterProjectsCtx);
      if (starterProjectsResponse) return starterProjectsResponse;
    }

    if (pathname === "/api/workspace/tree" || pathname === "/api/apps" || pathname.startsWith("/api/apps/")) {
      let appsAuthContext = authContext;
      if (!appsAuthContext.session) {
        const nip98Npub = ctx.verifyNip98AuthHeader(request, url);
        if (nip98Npub) {
          appsAuthContext = { npub: nip98Npub, session: null };
        }
      }

      const appsCtx = ctx.buildAppsContext(appsAuthContext);
      const appsApiResponse = await handleAppsApi(request, url, method, appsAuthContext, appsCtx);
      if (appsApiResponse) return appsApiResponse;
    }

    if (pathname === "/api/config" && method === "GET") {
      return Response.json({
        port: ctx.config.port,
        agentPortStart: ctx.config.agentPortStart,
        agentPortMax: ctx.config.agentPortMax,
        hostUrlBase: ctx.config.hostUrlBase,
        defaultDirectory: workspaceScope.defaultDirectory,
        allowedDirectories: workspaceScope.allowedDirectories,
        connectRelays: ctx.config.connectRelays,
        adminNpub: ctx.adminNpub,
        agents: Object.entries(ctx.config.agents).map(([key, definition]) => ({
          id: key,
          label: definition.label,
        })),
        defaultAgent: ctx.config.defaultAgent,
        featureFlags: ctx.serialiseFeatureFlagsForViewer(workspaceScope.isAdmin),
        giteaUrl: ctx.config.giteaUrl ?? null,
      });
    }

    // Feature flag routes (delegated to feature-flags-routes.ts)
    if (pathname.startsWith("/api/feature-flags")) {
      const featureFlagsCtx = ctx.buildFeatureFlagsContext(workspaceScope.isAdmin);
      const ffResult = await handleFeatureFlagsApi(request, url, method, authContext, featureFlagsCtx);
      if (ffResult) return ffResult;
    }

    // Docs/files API routes (delegated to docs-routes.ts)
    if (pathname.startsWith("/api/docs/")) {
      const docsApiResponse = await handleDocsApi(request, url, method, authContext, ctx.docsApiContext);
      if (docsApiResponse) return docsApiResponse;
    }

    if (pathname === "/api/directories" && method === "GET") {
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesRead, request, url, authContext);
      if (denied) {
        return denied;
      }
      try {
        const data = await ctx.listDirectories(
          url.searchParams.get("path"),
          url.searchParams.get("query") ?? undefined,
          workspaceScope,
        );
        return Response.json(data);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }

    if (pathname === "/api/directories" && method === "POST") {
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesWrite, request, url, authContext);
      if (denied) {
        return denied;
      }
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }

      if (!payload || typeof payload !== "object") {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }

      const parentInput = (payload as Record<string, unknown>).parent;
      const nameInput = (payload as Record<string, unknown>).name;

      try {
        const data = await ctx.createDirectoryEntry(
          typeof parentInput === "string" ? parentInput : null,
          nameInput,
        );
        return Response.json(data, { status: 201 });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }

    // Upload API routes (delegated to upload-routes.ts)
    if (pathname.startsWith("/api/uploads/")) {
      const uploadResult = await handleUploadsApi(request, url, method, authContext, ctx.uploadApiContext);
      if (uploadResult) return uploadResult;
    }

    // Session & archive API routes (delegated to session-api-routes.ts)
    if (pathname.startsWith("/api/archive") || pathname.startsWith("/api/sessions")) {
      const sessionApiResponse = await handleSessionApi(request, url, method, authContext, ctx.sessionApiContext);
      if (sessionApiResponse) return sessionApiResponse;
    }

    // POST /api/sessions is handled by sessionApiContext above

    // GET /api/artifacts/:id/raw — Serve artifact file content
    if (pathname.startsWith("/api/artifacts/") && method === "GET") {
      const artParts = pathname.split("/");
      const artifactId = artParts[3];
      if (artifactId && artParts[4] === "raw") {
        const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
        if (denied) return denied;

        const artifact = ctx.artifactsStore.get(artifactId);
        if (!artifact) {
          return Response.json({ error: "Artifact not found" }, { status: 404 });
        }

        try {
          const file = Bun.file(artifact.filePath);
          if (!(await file.exists())) {
            return Response.json({ error: "Artifact file not found on disk" }, { status: 404 });
          }
          return new Response(file, {
            headers: {
              "Content-Type": artifact.mimeType || "application/octet-stream",
              "Cache-Control": "private, max-age=3600",
            },
          });
        } catch {
          return Response.json({ error: "Failed to read artifact file" }, { status: 500 });
        }
      }
    }

    // User settings API
    if (pathname.startsWith("/api/user/settings")) {
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
      if (denied) return denied;

      const viewerNpub = authContext.npub;
      if (!viewerNpub) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }

      const settingsParts = pathname.split("/");
      const settingKey = settingsParts[4]; // /api/user/settings/:key

      if (method === "GET" && !settingKey) {
        // GET /api/user/settings — list all settings for user
        const settings = ctx.userSettingsStore.getAll(viewerNpub);
        // Mask sensitive keys
        const masked: Record<string, string> = {};
        for (const [k, v] of Object.entries(settings)) {
          const lowerKey = k.toLowerCase();
          const isSensitive =
            lowerKey.includes("key") ||
            lowerKey.includes("secret") ||
            lowerKey.includes("token") ||
            lowerKey.includes("password");
          masked[k] = isSensitive
            ? (v.length > 8 ? `${v.slice(0, 4)}..${v.slice(-4)}` : "****")
            : v;
        }
        return Response.json({ settings: masked });
      }

      if (method === "PUT" && settingKey) {
        // PUT /api/user/settings/:key — set a setting
        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        const record = payload as Record<string, unknown>;
        const value = typeof record.value === "string" ? record.value.trim() : "";
        if (!value) {
          return Response.json({ error: "value is required" }, { status: 400 });
        }
        ctx.userSettingsStore.set(viewerNpub, settingKey, value);
        return Response.json({ success: true, key: settingKey });
      }

      if (method === "DELETE" && settingKey) {
        // DELETE /api/user/settings/:key — remove a setting
        ctx.userSettingsStore.delete(viewerNpub, settingKey);
        return Response.json({ success: true, key: settingKey, deleted: true });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    }

    // /api/sessions/:id/* routes are handled by sessionApiContext above

    return Response.json({ error: "Not found" }, { status: 404 });
  };
}
