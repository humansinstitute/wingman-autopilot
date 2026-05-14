/**
 * API route handlers for /api/* endpoints.
 * Extracted from server.ts to reduce file size.
 */

import { runWithRequestContext, type RequestAuthContext } from "../auth/request-context";
import type { AccessAction } from "../auth/access-control";
import type { WorkspaceScope } from "../workspaces/workspace-scope";
import type { AppRecord } from "../apps/app-registry";
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
import { handleVoiceNoteUploadsApi, type VoiceNoteUploadApiContext } from "./voice-note-routes";
import { handleSystemRoutes, type SystemRoutesContext } from "./system-routes";
import { handleAgentChatApi, type AgentChatApiContext } from './agent-chat-routes';
import { handleDelegationApi, type DelegationRoutesContext } from "./delegation-routes";
import { handleOwnerSpaceApi } from "./owner-space-routes";
import { handleWappsApi, type WappsApiContext } from "./wapps-api-routes";
import { handlePipelineApi, type PipelineApiContext } from "../pipelines/pipeline-api-routes";
import type { WorkspaceDelegationStore } from "../storage/workspace-delegation-store";
import { getEffectiveOwnerNpub } from "../auth/effective-owner";

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
    baseUrl: string;
    agentPortStart: number;
    agentPortMax: number;
    hostUrlBase: string | null;
    appRoutingMode: string;
    subdomainBaseDomain: string | null;
    subdomainProxyEnabled: boolean;
    connectRelays: string[];
    agents: Record<string, { label: string }>;
    defaultAgent: string;
    giteaUrl: string | null;
  };
  adminNpub: string | null;

  // Callback to retrieve the remote IP for a request.
  // Optional — if omitted, localhost checks are skipped (e.g. in tests).
  getRequestIP?: (request: Request) => { address: string } | null;

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
  autopilotJobsApiHandler: SimpleApiHandler;

  // Pre-built route contexts (request-independent)
  sessionApiContext: SessionApiContext;
  docsApiContext: DocsApiContext;
  providerProxyApiContext: ProviderProxyApiContext;
  billingApiContext: BillingApiContext;
  systemRoutesContext: SystemRoutesContext;
  authApiContext: AuthApiContext;
  adminUsersApiContext: AdminUsersApiContext;
  uploadApiContext: UploadApiContext;
  voiceNoteUploadApiContext: VoiceNoteUploadApiContext;
  agentChatApiContext?: AgentChatApiContext;
  delegationRoutesContext: DelegationRoutesContext;
  pipelineApiContext?: PipelineApiContext;
  workspaceDelegationStore: WorkspaceDelegationStore;

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
  resolveNip98AuthContext: (
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ) => RequestAuthContext;
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
    scopeOverride?: WorkspaceScope,
  ) => Promise<unknown>;

  // Access control actions
  AccessActions: {
    ProjectsManage: AccessAction;
    TodosManage: AccessAction;
    SessionsManage: AccessAction;
    DeploymentsManage: AccessAction;
    UiRestricted?: AccessAction;
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
    workspaceScopeOverride?: WorkspaceScope,
    canAccessAppOverride?: (app: AppRecord) => boolean,
  ) => Parameters<typeof handleAppsApi>[4];
  buildFeatureFlagsContext: (
    viewerIsAdmin: boolean,
  ) => FeatureFlagsApiContext;
  buildChatContext: (
    viewerNpub: string | null,
    viewerIsAdmin: boolean,
  ) => ChatApiContext;
  buildWappsContext?: (authContext: RequestAuthContext) => WappsApiContext;
}

// ---------- Factory ----------

// Localhost addresses accepted for internal-only API routes.
const LOCALHOST_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const DEFAULT_AGENT_SETTING_KEY = "default_agent";

function isLocalhostRequest(request: Request, ctx: ApiRoutesContext): boolean {
  if (!ctx.getRequestIP) {
    // No IP resolver provided (e.g. unit tests) — allow by default.
    return true;
  }
  const ip = ctx.getRequestIP(request);
  return ip !== null && LOCALHOST_ADDRESSES.has(ip.address);
}

function resolveViewerDefaultAgent(ctx: ApiRoutesContext, viewerNpub: string | null): string {
  const agents = ctx.config.agents ?? {};
  if (!viewerNpub) {
    return ctx.config.defaultAgent;
  }

  const storedAgent = ctx.userSettingsStore.getAll(viewerNpub)[DEFAULT_AGENT_SETTING_KEY];
  const normalizedAgent = typeof storedAgent === "string" ? storedAgent.trim().toLowerCase() : "";
  if (normalizedAgent && normalizedAgent in agents) {
    return normalizedAgent;
  }
  return ctx.config.defaultAgent;
}

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
    const viewerNpub = getEffectiveOwnerNpub(authContext);

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

    if (pathname.startsWith("/api/pipelines") && ctx.pipelineApiContext) {
      const pipelineAuthContext = ctx.resolveNip98AuthContext(request, url, authContext);
      const pipelineResponse = await runWithRequestContext(
        pipelineAuthContext,
        () => handlePipelineApi(request, url, method, pipelineAuthContext, ctx.pipelineApiContext),
      );
      if (pipelineResponse) return pipelineResponse;
    }

    if (pathname.startsWith("/api/npub-projects")) {
      if (method === "OPTIONS") {
        return withProjectApiCors(new Response(null, { status: 204 }));
      }

      let effectiveAuth = authContext;
      let effectiveIsAdmin = workspaceScope.isAdmin;

      // Allow NIP-98 auth as fallback when no session cookie
      if (!authContext.session) {
        effectiveAuth = ctx.resolveNip98AuthContext(request, url, authContext);
        if (effectiveAuth.npub) {
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
    // Autopilot Jobs API — job definitions and runs management.
    if (pathname.startsWith("/api/autopilot-jobs")) {
      const jobsAuthContext = ctx.resolveNip98AuthContext(request, url, authContext);
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, jobsAuthContext);
      if (denied) {
        return denied;
      }
      const response = await runWithRequestContext(
        jobsAuthContext,
        () => ctx.autopilotJobsApiHandler(request, url, method, jobsAuthContext),
      );
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (pathname.startsWith("/api/wapps")) {
      const wappsAuthContext = ctx.resolveNip98AuthContext(request, url, authContext);
      if (!ctx.buildWappsContext) {
        return Response.json({ error: "wapps-unavailable" }, { status: 503 });
      }
      const wappsApiContext = ctx.buildWappsContext(wappsAuthContext);
      const response = await runWithRequestContext(
        wappsAuthContext,
        () => handleWappsApi(request, url, method, wappsAuthContext, wappsApiContext),
      );
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
    // Restricted to localhost: only MCP stdio servers (running on the same host) call this.
    if (pathname.startsWith("/api/mcp/bot-crypto")) {
      if (!isLocalhostRequest(request, ctx)) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      const response = await ctx.botCryptoApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // MCP NIP-98 API — called by the MCP stdio server running inside agents.
    // Restricted to localhost: only MCP stdio servers (running on the same host) call this.
    if (pathname.startsWith("/api/mcp/nip98")) {
      if (!isLocalhostRequest(request, ctx)) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      const response = await ctx.nip98ApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // Git workflow API — branch, worktree, merge, and status operations.
    // Restricted to localhost: only MCP stdio servers (running on the same host) call this.
    if (pathname.startsWith("/api/git/")) {
      if (!isLocalhostRequest(request, ctx)) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
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
    if (
      pathname.startsWith('/api/agent-chat/subscriptions')
      || pathname.startsWith('/api/agent-chat/agents')
      || pathname.startsWith('/api/agent-chat/backend-connections')
      || pathname.startsWith('/api/agent-chat/agent-connect')
      || pathname.startsWith('/api/agent-chat/dispatch-routes')
    ) {
      const agentChatAuthContext = ctx.resolveNip98AuthContext(request, url, authContext);
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, agentChatAuthContext);
      if (denied) {
        return denied;
      }
      if (!ctx.agentChatApiContext) {
        return Response.json({ error: 'agent-chat-unavailable' }, { status: 503 });
      }
      const response = await handleAgentChatApi(
        request,
        url,
        method === 'GET' || method === 'POST' || method === 'PATCH' || method === 'DELETE' ? method : 'GET',
        agentChatAuthContext,
        ctx.agentChatApiContext,
      );
      if (response) {
        return response;
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
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
      const appsAuthContext = ctx.resolveNip98AuthContext(request, url, authContext);

      const appsCtx = ctx.buildAppsContext(appsAuthContext);
      const appsApiResponse = await runWithRequestContext(
        appsAuthContext,
        () => handleAppsApi(request, url, method, appsAuthContext, appsCtx),
      );
      if (appsApiResponse) return appsApiResponse;
    }

    if (pathname === "/api/config" && method === "GET") {
      const defaultAgent = resolveViewerDefaultAgent(ctx, viewerNpub);
      const agents = Object.entries(ctx.config.agents ?? {}).map(([key, definition]) => ({
        id: key,
        label: definition.label,
      }));
      return Response.json({
        port: ctx.config.port,
        baseUrl: ctx.config.baseUrl,
        agentPortStart: ctx.config.agentPortStart,
        agentPortMax: ctx.config.agentPortMax,
        hostUrlBase: ctx.config.hostUrlBase,
        appRoutingMode: ctx.config.appRoutingMode,
        subdomainBaseDomain: ctx.config.subdomainBaseDomain,
        subdomainProxyEnabled: ctx.config.subdomainProxyEnabled,
        defaultDirectory: workspaceScope.defaultDirectory,
        allowedDirectories: workspaceScope.allowedDirectories,
        connectRelays: ctx.config.connectRelays,
        adminNpub: ctx.adminNpub,
        agents,
        defaultAgent,
        systemDefaultAgent: ctx.config.defaultAgent,
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

    if (
      pathname === "/api/delegations" ||
      pathname.startsWith("/api/delegations/") ||
      pathname.endsWith("/delegations")
    ) {
      const delegationAuthContext = ctx.resolveNip98AuthContext(request, url, authContext);
      const delegationResult = await runWithRequestContext(
        delegationAuthContext,
        () => handleDelegationApi(request, url, method, delegationAuthContext, ctx.delegationRoutesContext),
      );
      if (delegationResult) return delegationResult;
    }

    if (pathname.startsWith("/api/owners/")) {
      const ownerAuthContext = ctx.resolveNip98AuthContext(request, url, authContext);
      const ownerSpaceResult = await runWithRequestContext(
        ownerAuthContext,
        () =>
          handleOwnerSpaceApi(request, url, method, ownerAuthContext, {
            workspaceDelegationStore: ctx.workspaceDelegationStore,
            resolveWorkspace: ctx.resolveWorkspace,
            buildAppsContext: ctx.buildAppsContext,
            docsApiContext: ctx.docsApiContext,
            listDirectories: ctx.listDirectories,
            createDirectoryEntry: ctx.createDirectoryEntry,
          }),
      );
      if (ownerSpaceResult) return ownerSpaceResult;
    }

    // Docs/files API routes (delegated to docs-routes.ts)
    if (pathname.startsWith("/api/docs/")) {
      const docsAuthContext = ctx.resolveNip98AuthContext(request, url, authContext);
      const docsApiResponse = await runWithRequestContext(
        docsAuthContext,
        () => handleDocsApi(request, url, method, docsAuthContext, ctx.docsApiContext),
      );
      if (docsApiResponse) return docsApiResponse;
    }

    if (pathname === "/api/directories" && method === "GET") {
      const directoriesAuthContext = ctx.resolveNip98AuthContext(request, url, authContext);
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesRead, request, url, directoriesAuthContext);
      if (denied) {
        return denied;
      }
      try {
        const data = await ctx.listDirectories(
          url.searchParams.get("path"),
          url.searchParams.get("query") ?? undefined,
          ctx.resolveWorkspace(directoriesAuthContext),
        );
        return Response.json(data);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }

    if (pathname === "/api/directories" && method === "POST") {
      const directoriesAuthContext = ctx.resolveNip98AuthContext(request, url, authContext);
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesWrite, request, url, directoriesAuthContext);
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
          ctx.resolveWorkspace(directoriesAuthContext),
        );
        return Response.json(data, { status: 201 });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }

    // Upload API routes (delegated to upload-routes.ts)
    if (pathname.startsWith("/api/uploads/")) {
      const voiceNoteResult = await handleVoiceNoteUploadsApi(
        request,
        url,
        method,
        authContext,
        ctx.voiceNoteUploadApiContext,
      );
      if (voiceNoteResult) return voiceNoteResult;

      const uploadResult = await handleUploadsApi(request, url, method, authContext, ctx.uploadApiContext);
      if (uploadResult) return uploadResult;
    }

    // Session, delegate-session, and archive API routes (delegated to session-api-routes.ts)
    if (
      pathname.startsWith("/api/archive") ||
      pathname.startsWith("/api/sessions") ||
      pathname.startsWith("/api/delegate-sessions") ||
      (pathname.startsWith("/api/owners/") && pathname.includes("/sessions"))
    ) {
      const sessionAuthContext = ctx.resolveNip98AuthContext(request, url, authContext);
      const sessionApiResponse = await runWithRequestContext(
        sessionAuthContext,
        () => handleSessionApi(request, url, method, sessionAuthContext, ctx.sessionApiContext),
      );
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
        if (settingKey === DEFAULT_AGENT_SETTING_KEY) {
          const normalizedValue = value.toLowerCase();
          if (!(normalizedValue in ctx.config.agents)) {
            const supportedAgents = Object.keys(ctx.config.agents).join(", ");
            return Response.json({ error: `value must be one of: ${supportedAgents}` }, { status: 400 });
          }
          ctx.userSettingsStore.set(viewerNpub, settingKey, normalizedValue);
          return Response.json({ success: true, key: settingKey, value: normalizedValue });
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
