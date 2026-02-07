/**
 * Wingman Action API Handler
 *
 * HTTP handler for /api/mcp/wingman/* routes.
 * Called by the MCP stdio server (running inside agent processes)
 * to manage apps, sessions, logs, and CapRover deployments.
 *
 * Follows the Nip98Api pattern — factory function returning a
 * (request, url, method) => Response handler.
 * Validated by sessionId (no cookie auth).
 */

import type { SessionSnapshot } from "../agents/process-manager";
import type { AgentType } from "../config";
import type { AppRecord, AppLifecycleAction } from "../apps/app-registry";
import type { AppProcessStatus } from "../apps/app-process-manager";
import type { CaproverStore } from "../caprover/caprover-store";
import type { CaproverClient } from "../caprover/caprover-client";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface WingmanMcpApiDependencies {
  getSession: (sessionId: string) => SessionSnapshot | null;
  listSessions: () => SessionSnapshot[];
  createSession: (
    agent: AgentType,
    workingDirectory?: string,
    name?: string,
  ) => Promise<SessionSnapshot>;
  getSessionLogs: (sessionId: string) => Promise<string[] | undefined>;
  listApps: () => Promise<AppRecord[]>;
  getAppStatus: (appId: string) => Promise<AppProcessStatus>;
  runAppAction: (appId: string, action: AppLifecycleAction) => Promise<AppProcessStatus>;
  tailAppLogs: (appId: string, lines?: number) => Promise<string[]>;
  caproverStore: CaproverStore;
  getCaproverClient: () => CaproverClient | null;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonOk(data: unknown): Response {
  return Response.json(data);
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object") {
      throw new Error("Expected JSON object");
    }
    return body as Record<string, unknown>;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function requireSessionId(
  deps: WingmanMcpApiDependencies,
  sessionId: string | undefined | null,
): Response | null {
  if (!sessionId) {
    return jsonError("sessionId is required", 400);
  }
  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }
  return null; // valid
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createWingmanMcpApiHandler(deps: WingmanMcpApiDependencies) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/mcp/wingman")) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    // segments: ["api", "mcp", "wingman", ...]

    try {
      // GET /api/mcp/wingman/apps
      if (segments.length === 4 && segments[3] === "apps" && method === "GET") {
        return await handleListApps(deps, url);
      }

      // POST /api/mcp/wingman/apps/action
      if (segments.length === 5 && segments[3] === "apps" && segments[4] === "action" && method === "POST") {
        return await handleManageApp(deps, request);
      }

      // GET /api/mcp/wingman/logs
      if (segments.length === 4 && segments[3] === "logs" && method === "GET") {
        return await handleReadLogs(deps, url);
      }

      // GET /api/mcp/wingman/sessions
      if (segments.length === 4 && segments[3] === "sessions" && method === "GET") {
        return handleListSessions(deps, url);
      }

      // POST /api/mcp/wingman/sessions
      if (segments.length === 4 && segments[3] === "sessions" && method === "POST") {
        return await handleCreateSession(deps, request);
      }

      // GET /api/mcp/wingman/caprover/apps
      if (segments.length === 5 && segments[3] === "caprover" && segments[4] === "apps" && method === "GET") {
        return handleListCaproverApps(deps, url);
      }

      // POST /api/mcp/wingman/caprover/deploy
      if (segments.length === 5 && segments[3] === "caprover" && segments[4] === "deploy" && method === "POST") {
        return await handleDeployCaproverApp(deps, request);
      }

      return jsonError("Not found", 404);
    } catch (err) {
      console.error("[wingman-mcp-api] Error:", err);
      return jsonError((err as Error).message, 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/mcp/wingman/apps?sessionId=...
 * List registered apps with their process status.
 */
async function handleListApps(
  deps: WingmanMcpApiDependencies,
  url: URL,
): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId");
  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  const apps = await deps.listApps();

  const results = await Promise.all(
    apps.map(async (app) => {
      let status: AppProcessStatus | null = null;
      try {
        status = await deps.getAppStatus(app.id);
      } catch {
        // App may not have a process yet
      }
      return {
        id: app.id,
        label: app.label,
        root: app.root,
        scripts: app.scripts,
        running: status?.running ?? false,
        status: status?.status ?? "unknown",
        pm2Name: app.pm2Name ?? null,
      };
    }),
  );

  return jsonOk({ apps: results });
}

/**
 * POST /api/mcp/wingman/apps/action
 * Body: { sessionId, appId, action }
 */
async function handleManageApp(
  deps: WingmanMcpApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const appId = body.appId as string | undefined;
  const action = body.action as string | undefined;

  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  if (!appId) {
    return jsonError("appId is required", 400);
  }

  const validActions: AppLifecycleAction[] = ["start", "stop", "restart", "build", "setup"];
  if (!action || !validActions.includes(action as AppLifecycleAction)) {
    return jsonError(`action must be one of: ${validActions.join(", ")}`, 400);
  }

  const result = await deps.runAppAction(appId, action as AppLifecycleAction);
  return jsonOk({
    appId,
    action,
    status: result.status,
    running: result.running,
    message: result.message ?? null,
  });
}

/**
 * GET /api/mcp/wingman/logs?sessionId=...&source=session|app&id=...&lines=100
 */
async function handleReadLogs(
  deps: WingmanMcpApiDependencies,
  url: URL,
): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId");
  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  const source = url.searchParams.get("source");
  const targetId = url.searchParams.get("id");
  const lines = Math.min(Number(url.searchParams.get("lines") ?? "100"), 500);

  if (!source || !targetId) {
    return jsonError("source and id are required query parameters", 400);
  }

  if (source === "session") {
    const logs = await deps.getSessionLogs(targetId);
    if (!logs) {
      return jsonError("Session not found or has no logs", 404);
    }
    const tail = logs.slice(-lines);
    return jsonOk({ source, id: targetId, lines: tail.length, logs: tail });
  }

  if (source === "app") {
    const logLines = await deps.tailAppLogs(targetId, lines);
    return jsonOk({ source, id: targetId, lines: logLines.length, logs: logLines });
  }

  return jsonError("source must be 'session' or 'app'", 400);
}

/**
 * GET /api/mcp/wingman/sessions?sessionId=...
 */
function handleListSessions(
  deps: WingmanMcpApiDependencies,
  url: URL,
): Response {
  const sessionId = url.searchParams.get("sessionId");
  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  const sessions = deps.listSessions().map((s) => ({
    id: s.id,
    agent: s.agent,
    name: s.name,
    status: s.status,
    startedAt: s.startedAt,
    workingDirectory: s.workingDirectory,
    port: s.port,
    pid: s.pid ?? null,
  }));

  return jsonOk({ sessions });
}

/**
 * POST /api/mcp/wingman/sessions
 * Body: { sessionId, agent, directory?, name? }
 */
async function handleCreateSession(
  deps: WingmanMcpApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const agent = body.agent as string | undefined;
  const directory = body.directory as string | undefined;
  const name = body.name as string | undefined;

  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  const validAgents: AgentType[] = ["codex", "claude", "goose", "opencode", "gemini"];
  if (!agent || !validAgents.includes(agent as AgentType)) {
    return jsonError(`agent must be one of: ${validAgents.join(", ")}`, 400);
  }

  const session = await deps.createSession(agent as AgentType, directory, name);
  return jsonOk({
    id: session.id,
    agent: session.agent,
    name: session.name,
    status: session.status,
    port: session.port,
    workingDirectory: session.workingDirectory,
    startedAt: session.startedAt,
  });
}

/**
 * GET /api/mcp/wingman/caprover/apps?sessionId=...
 */
function handleListCaproverApps(
  deps: WingmanMcpApiDependencies,
  url: URL,
): Response {
  const sessionId = url.searchParams.get("sessionId");
  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  const apps = deps.caproverStore.listApps().map((app) => ({
    id: app.id,
    caproverName: app.caproverName,
    liveUrl: app.liveUrl ?? null,
    customDomain: app.customDomain ?? null,
    hasSsl: app.hasSsl ?? false,
    deployedVersion: app.deployedVersion ?? null,
    appId: app.appId ?? null,
    projectId: app.projectId ?? null,
  }));

  return jsonOk({ apps });
}

/**
 * POST /api/mcp/wingman/caprover/deploy
 * Body: { sessionId, appId, dockerImage?, gitHash? }
 */
async function handleDeployCaproverApp(
  deps: WingmanMcpApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const appId = body.appId as string | undefined;
  const dockerImage = body.dockerImage as string | undefined;
  const gitHash = body.gitHash as string | undefined;

  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  if (!appId) {
    return jsonError("appId is required (CapRover app tracking ID)", 400);
  }

  const app = deps.caproverStore.getApp(appId);
  if (!app) {
    return jsonError("CapRover app not found", 404);
  }

  const client = deps.getCaproverClient();
  if (!client) {
    return jsonError("CapRover is not configured — set CAPROVER_URL and CAPROVER_PASSWORD", 503);
  }

  if (!dockerImage) {
    return jsonError("dockerImage is required for deployment", 400);
  }

  // Create deployment record
  const deployment = deps.caproverStore.createDeployment({
    caproverAppId: appId,
    deployMethod: "docker_image",
    dockerImage,
    gitHash: gitHash ?? null,
  });

  try {
    await client.deployFromImage(app.caproverName, dockerImage);

    // Get updated version from CapRover
    const remoteApp = await client.getApp(app.caproverName);
    const version = remoteApp?.deployedVersion ?? null;

    deps.caproverStore.updateDeployment(deployment.id, {
      status: "success",
      version,
      completedAt: new Date().toISOString(),
    });

    deps.caproverStore.updateApp(appId, {
      deployedVersion: version,
    });

    return jsonOk({
      success: true,
      appId,
      caproverName: app.caproverName,
      dockerImage,
      deployedVersion: version,
    });
  } catch (err) {
    deps.caproverStore.updateDeployment(deployment.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: (err as Error).message,
    });

    return jsonError(`Deployment failed: ${(err as Error).message}`, 502);
  }
}
