/**
 * Autopilot Jobs API Handler
 *
 * HTTP handler for /api/autopilot-jobs/* routes.
 * Wraps the jobs-db SQLite store for UI consumption.
 * Provides CRUD for job definitions and read/stop for job runs.
 */

import {
  listJobs,
  getJob,
  createJob,
  updateJob,
  deleteJob,
  listRuns,
  getRun,
  updateRunStatus,
  type JobDefinition,
  type JobRun,
} from "./jobs-db";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Normalize SQLite integer booleans to actual booleans for JSON responses. */
function normalizeJob(job: JobDefinition): Record<string, unknown> {
  return { ...job, enabled: !!job.enabled };
}

function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  return request.json().catch(() => {
    throw new Error("Invalid JSON payload");
  }) as Promise<Record<string, unknown>>;
}

// ============================================================
// Job Definition Handlers
// ============================================================

/** GET /api/autopilot-jobs/definitions */
function handleListDefinitions(): Response {
  const jobs = listJobs().map(normalizeJob);
  return Response.json({ jobs });
}

/** GET /api/autopilot-jobs/definitions/:id */
function handleGetDefinition(id: string): Response {
  const job = getJob(id);
  if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
  return Response.json({ job: normalizeJob(job) });
}

/** POST /api/autopilot-jobs/definitions */
async function handleCreateDefinition(request: Request): Promise<Response> {
  const body = await parseJsonBody(request);

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const worker_prompt = typeof body.worker_prompt === "string" ? body.worker_prompt.trim() : "";
  const manager_prompt = typeof body.manager_prompt === "string" ? body.manager_prompt.trim() : "";
  const manager_goal = typeof body.manager_goal === "string" ? body.manager_goal.trim() : "";
  const manager_dir = typeof body.manager_dir === "string" ? body.manager_dir.trim() : "";
  const check_interval = typeof body.check_interval === "number" ? body.check_interval : undefined;
  const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;

  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (!manager_dir) return Response.json({ error: "manager_dir is required" }, { status: 400 });

  const existing = getJob(id);
  if (existing) return Response.json({ error: `Job already exists: ${id}` }, { status: 409 });

  const job = createJob({
    id,
    name,
    worker_prompt,
    manager_prompt,
    manager_goal,
    manager_dir,
    check_interval,
    enabled,
  });

  return Response.json({ job: normalizeJob(job) }, { status: 201 });
}

/** PATCH /api/autopilot-jobs/definitions/:id */
async function handleUpdateDefinition(id: string, request: Request): Promise<Response> {
  const existing = getJob(id);
  if (!existing) return Response.json({ error: "Job not found" }, { status: 404 });

  const body = await parseJsonBody(request);
  const updates: Record<string, unknown> = {};

  if (typeof body.name === "string") updates.name = body.name.trim();
  if (typeof body.worker_prompt === "string") updates.worker_prompt = body.worker_prompt.trim();
  if (typeof body.manager_prompt === "string") updates.manager_prompt = body.manager_prompt.trim();
  if (typeof body.manager_goal === "string") updates.manager_goal = body.manager_goal.trim();
  if (typeof body.manager_dir === "string") updates.manager_dir = body.manager_dir.trim();
  if (typeof body.check_interval === "number") updates.check_interval = body.check_interval;
  if (typeof body.enabled === "boolean") updates.enabled = body.enabled;

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: "No fields to update" }, { status: 400 });
  }

  const job = updateJob(id, updates);
  if (!job) return Response.json({ error: "Job not found" }, { status: 404 });

  return Response.json({ job: normalizeJob(job) });
}

/** DELETE /api/autopilot-jobs/definitions/:id */
function handleDeleteDefinition(id: string): Response {
  const deleted = deleteJob(id);
  if (!deleted) return Response.json({ error: "Job not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}

// ============================================================
// Job Run Handlers
// ============================================================

/** GET /api/autopilot-jobs/runs */
function handleListRuns(url: URL): Response {
  const jobId = url.searchParams.get("job_id") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const runs = listRuns(jobId, status);
  return Response.json({ runs });
}

/** GET /api/autopilot-jobs/runs/:id */
function handleGetRun(id: string): Response {
  const run = getRun(id);
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
  return Response.json({ run });
}

/** POST /api/autopilot-jobs/runs/:id/stop */
function handleStopRun(id: string): Response {
  const run = getRun(id);
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });

  if (run.status === "stopped" || run.status === "complete" || run.status === "failed") {
    return Response.json({ message: `Run already ${run.status}` });
  }

  updateRunStatus(id, "stopped");
  const updated = getRun(id);
  return Response.json({ run: updated });
}

// ============================================================
// Main Handler Factory
// ============================================================

export function createAutopilotJobsApiHandler() {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
  ): Promise<Response | null> => {
    const segments = url.pathname.split("/").filter(Boolean);
    // segments[0] = "api", segments[1] = "autopilot-jobs"

    // /api/autopilot-jobs/definitions
    if (segments.length === 3 && segments[2] === "definitions") {
      if (method === "GET") return handleListDefinitions();
      if (method === "POST") return handleCreateDefinition(request);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/autopilot-jobs/definitions/:id
    if (segments.length === 4 && segments[2] === "definitions") {
      const id = decodeURIComponent(segments[3]!);
      if (method === "GET") return handleGetDefinition(id);
      if (method === "PATCH") return handleUpdateDefinition(id, request);
      if (method === "DELETE") return handleDeleteDefinition(id);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/autopilot-jobs/runs
    if (segments.length === 3 && segments[2] === "runs") {
      if (method === "GET") return handleListRuns(url);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/autopilot-jobs/runs/:id
    if (segments.length === 4 && segments[2] === "runs") {
      const id = decodeURIComponent(segments[3]!);
      if (method === "GET") return handleGetRun(id);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/autopilot-jobs/runs/:id/stop
    if (segments.length === 5 && segments[2] === "runs" && segments[4] === "stop") {
      const id = decodeURIComponent(segments[3]!);
      if (method === "POST") return handleStopRun(id);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    return null;
  };
}
