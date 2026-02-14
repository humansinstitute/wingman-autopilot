/**
 * Git Workflow API Handler
 *
 * HTTP handler for /api/git/* routes. Provides branch management,
 * worktree operations, merging, and status with workflow context.
 * Follows the same factory pattern as gitea-api.ts.
 */

import type { SessionSnapshot } from "../agents/process-manager";
import type { WingmanConfig } from "../config";
import type { GiteaOperationConfig } from "./gitea-operations";
import { resolveGiteaCredentials } from "./gitea-user-manager";
import {
  getGitStatus,
  listBranches,
  createBranch,
  switchBranch,
  listWorktrees,
  addWorktree,
  removeWorktree,
  mergeBranch,
  getMergeReport,
} from "./git-workflow-ops";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface GitWorkflowApiDependencies {
  getSession: (sessionId: string) => SessionSnapshot | undefined;
  config: WingmanConfig;
  dataDir: string;
  getFeatureFlag: (key: string) => boolean;
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

function resolveSessionContext(
  deps: GitWorkflowApiDependencies,
  sessionId: string,
): { directory: string; opConfig: GiteaOperationConfig } | Response {
  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }

  if (!session.workingDirectory) {
    return jsonError("Session has no working directory", 400);
  }

  const giteaOverride = resolveGiteaCredentials(session.npub, deps.config) ?? undefined;

  const opConfig: GiteaOperationConfig = {
    wingmanConfig: deps.config,
    dataDir: deps.dataDir,
    giteaOverride,
  };

  return { directory: session.workingDirectory, opConfig };
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createGitWorkflowApiHandler(deps: GitWorkflowApiDependencies) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/git")) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    // segments: ["api", "git", ...]

    try {
      if (method !== "POST") return jsonError("Method not allowed", 405);

      // POST /api/git/status
      if (segments.length === 3 && segments[2] === "status") {
        return await handleStatus(deps, request);
      }

      // POST /api/git/branches
      if (segments.length === 3 && segments[2] === "branches") {
        return await handleBranches(deps, request);
      }

      // POST /api/git/branch/create
      if (segments.length === 4 && segments[2] === "branch" && segments[3] === "create") {
        return await handleBranchCreate(deps, request);
      }

      // POST /api/git/branch/switch
      if (segments.length === 4 && segments[2] === "branch" && segments[3] === "switch") {
        return await handleBranchSwitch(deps, request);
      }

      // POST /api/git/worktrees
      if (segments.length === 3 && segments[2] === "worktrees") {
        return await handleWorktrees(deps, request);
      }

      // POST /api/git/worktree/add
      if (segments.length === 4 && segments[2] === "worktree" && segments[3] === "add") {
        return await handleWorktreeAdd(deps, request);
      }

      // POST /api/git/worktree/remove
      if (segments.length === 4 && segments[2] === "worktree" && segments[3] === "remove") {
        return await handleWorktreeRemove(deps, request);
      }

      // POST /api/git/merge
      if (segments.length === 3 && segments[2] === "merge") {
        return await handleMerge(deps, request);
      }

      return jsonError("Not found", 404);
    } catch (err) {
      console.error("[git-workflow-api] Error:", err);
      return jsonError((err as Error).message, 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleStatus(
  deps: GitWorkflowApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const status = await getGitStatus(ctx.directory, ctx.opConfig);
  return jsonOk(status as unknown as Record<string, unknown>);
}

async function handleBranches(
  deps: GitWorkflowApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const branches = await listBranches(ctx.directory, ctx.opConfig);
  return jsonOk({ branches });
}

async function handleBranchCreate(
  deps: GitWorkflowApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const name = body.name as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);
  if (!name) return jsonError("name is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const result = await createBranch(
    ctx.directory,
    ctx.opConfig,
    name,
    body.baseBranch as string | undefined,
  );

  if (!result.success) {
    return jsonError(result.error || "Failed to create branch", 500);
  }

  return jsonOk({ branch: result.branch });
}

async function handleBranchSwitch(
  deps: GitWorkflowApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const branch = body.branch as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);
  if (!branch) return jsonError("branch is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const result = await switchBranch(ctx.directory, ctx.opConfig, branch);

  if (!result.success) {
    return jsonError(result.error || "Failed to switch branch", 500);
  }

  return jsonOk({ branch: result.branch, warning: result.warning });
}

async function handleWorktrees(
  deps: GitWorkflowApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const worktrees = await listWorktrees(ctx.directory, ctx.opConfig);
  return jsonOk({ worktrees });
}

async function handleWorktreeAdd(
  deps: GitWorkflowApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const name = body.name as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);
  if (!name) return jsonError("name is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const result = await addWorktree(ctx.directory, ctx.opConfig, name);

  if (!result.success) {
    return jsonError(result.error || "Failed to add worktree", 500);
  }

  return jsonOk({ path: result.path, branch: result.branch });
}

async function handleWorktreeRemove(
  deps: GitWorkflowApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const name = body.name as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);
  if (!name) return jsonError("name is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const result = await removeWorktree(ctx.directory, ctx.opConfig, name);

  if (!result.success) {
    return jsonError(result.error || "Failed to remove worktree", 500);
  }

  return jsonOk({ removed: true, branchMerged: result.branchMerged });
}

async function handleMerge(
  deps: GitWorkflowApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const source = body.source as string | undefined;
  const target = (body.target as string | undefined) || "staging";
  const generateReport = body.report !== false;

  if (!sessionId) return jsonError("sessionId is required", 400);
  if (!source) return jsonError("source branch is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  // Warn/block main merges without feature flag
  if (target === "main" && !deps.getFeatureFlag("allow_main_push")) {
    return jsonError(
      "Merging to main is blocked. Enable the allow_main_push feature flag to override.",
      403,
    );
  }

  // Generate pre-merge report if requested
  let report: string | undefined;
  if (generateReport) {
    report = await getMergeReport(ctx.directory, ctx.opConfig, source, target);
  }

  // Perform merge
  const result = await mergeBranch(ctx.directory, ctx.opConfig, source, target);

  if (!result.success) {
    return jsonError(result.error || "Merge failed", 500);
  }

  return jsonOk({
    success: true,
    summary: result.summary,
    report: report || result.report,
  });
}
