/**
 * Gitea API Handler
 *
 * HTTP handler for /api/gitea/* routes. Provides programmatic git
 * operations (set-remote, push, pull, commit-and-push) scoped to
 * the Gitea remote. Follows the same factory pattern as ngit-api.ts.
 */

import type { SessionSnapshot } from "../agents/process-manager";
import type { WingmanConfig } from "../config";
import {
  setGiteaRemote,
  pushToGitea,
  pullFromGitea,
  commitAndPushToGitea,
  type GiteaOperationConfig,
} from "./gitea-operations";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface GiteaApiDependencies {
  getSession: (sessionId: string) => SessionSnapshot | undefined;
  config: WingmanConfig;
  dataDir: string;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function jsonOk(data: Record<string, unknown>): Response {
  return Response.json(data);
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

/**
 * Resolve session → working directory, plus build the GiteaOperationConfig.
 */
function resolveSessionContext(
  deps: GiteaApiDependencies,
  sessionId: string,
): { directory: string; opConfig: GiteaOperationConfig } | Response {
  if (!deps.config.giteaUrl || !deps.config.giteaApiToken || !deps.config.giteaOwner) {
    return jsonError("Gitea is not configured (set GITEA_URL, GITEA_API_TOKEN, GITEA_OWNER)", 503);
  }

  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }

  if (!session.workingDirectory) {
    return jsonError("Session has no working directory", 400);
  }

  const opConfig: GiteaOperationConfig = {
    wingmanConfig: deps.config,
    dataDir: deps.dataDir,
  };

  return { directory: session.workingDirectory, opConfig };
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createGiteaApiHandler(deps: GiteaApiDependencies) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/gitea")) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    // segments: ["api", "gitea", ...]

    try {
      // POST /api/gitea/set-remote
      if (segments.length === 3 && segments[2] === "set-remote" && method === "POST") {
        return await handleSetRemote(deps, request);
      }

      // POST /api/gitea/push
      if (segments.length === 3 && segments[2] === "push" && method === "POST") {
        return await handlePush(deps, request);
      }

      // POST /api/gitea/pull
      if (segments.length === 3 && segments[2] === "pull" && method === "POST") {
        return await handlePull(deps, request);
      }

      // POST /api/gitea/commit-and-push
      if (segments.length === 3 && segments[2] === "commit-and-push" && method === "POST") {
        return await handleCommitAndPush(deps, request);
      }

      return jsonError("Not found", 404);
    } catch (err) {
      console.error("[gitea-api] Error:", err);
      return jsonError((err as Error).message, 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/gitea/set-remote
 *
 * Create Gitea repo and add/update the "gitea" remote.
 * Body: { sessionId, projectName? }
 */
async function handleSetRemote(
  deps: GiteaApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const result = await setGiteaRemote({
    directory: ctx.directory,
    opConfig: ctx.opConfig,
    projectName: body.projectName as string | undefined,
  });

  if (!result.success) {
    return jsonError(result.stderr || "Set remote failed", 500);
  }

  console.log(`[gitea-api] Set remote for session ${sessionId}: ${result.cloneUrl}`);

  return jsonOk({
    stdout: result.stdout,
    stderr: result.stderr,
    cloneUrl: result.cloneUrl,
    repoCreated: result.repoCreated,
  });
}

/**
 * POST /api/gitea/push
 *
 * Push to the "gitea" remote.
 * Body: { sessionId, branch? }
 */
async function handlePush(
  deps: GiteaApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const result = await pushToGitea({
    directory: ctx.directory,
    opConfig: ctx.opConfig,
    branch: body.branch as string | undefined,
  });

  if (!result.success) {
    return jsonError(result.stderr || "Push failed", 500);
  }

  console.log(`[gitea-api] Push for session ${sessionId}: ${result.stdout || "ok"}`);

  return jsonOk({ stdout: result.stdout, stderr: result.stderr });
}

/**
 * POST /api/gitea/pull
 *
 * Pull from the "gitea" remote.
 * Body: { sessionId, branch? }
 */
async function handlePull(
  deps: GiteaApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const result = await pullFromGitea({
    directory: ctx.directory,
    opConfig: ctx.opConfig,
    branch: body.branch as string | undefined,
  });

  if (!result.success) {
    return jsonError(result.stderr || "Pull failed", 500);
  }

  console.log(`[gitea-api] Pull for session ${sessionId}: ${result.stdout || "ok"}`);

  return jsonOk({ stdout: result.stdout, stderr: result.stderr });
}

/**
 * POST /api/gitea/commit-and-push
 *
 * Stage all, commit, and push to the "gitea" remote.
 * Body: { sessionId, message? }
 */
async function handleCommitAndPush(
  deps: GiteaApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const result = await commitAndPushToGitea({
    directory: ctx.directory,
    opConfig: ctx.opConfig,
    message: body.message as string | undefined,
  });

  if (!result.success) {
    return jsonError(result.stderr || "Commit and push failed", 500);
  }

  console.log(`[gitea-api] Commit+push for session ${sessionId}: ${result.stdout || "ok"}`);

  return jsonOk({ stdout: result.stdout, stderr: result.stderr });
}
