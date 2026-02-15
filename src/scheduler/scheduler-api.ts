/**
 * Scheduler API Handler
 *
 * HTTP handler for /api/scheduler/* routes.
 * Manages scheduled job CRUD, manual triggering, and run history.
 */

import type { SchedulerStore } from "./scheduler-store";
import type { SchedulerEngine } from "./scheduler-engine";
import { wrapEscrowUuid } from "./key-wrapper";
import type { BotKeyStore } from "../identity/bot-key-store";
import { getSessionSecretBytes } from "../auth/session-secret";

// ============================================================
// Types
// ============================================================

export interface SchedulerApiDependencies {
  store: SchedulerStore;
  engine: SchedulerEngine;
  botKeyStore: BotKeyStore;
  getNpub: (request: Request) => string | null;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ============================================================
// Helpers
// ============================================================

function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  return request.json().catch(() => {
    throw new Error("Invalid JSON payload");
  }) as Promise<Record<string, unknown>>;
}

const VALID_AGENTS = ["codex", "claude", "goose", "opencode", "gemini"];

function validateCronExpression(expr: string): boolean {
  // Basic validation: 5 or 6 space-separated fields
  const parts = expr.trim().split(/\s+/);
  return parts.length >= 5 && parts.length <= 6;
}

// ============================================================
// Route Handlers
// ============================================================

/** GET /api/scheduler/jobs */
function handleListJobs(
  deps: SchedulerApiDependencies,
  userNpub: string,
): Response {
  const jobs = deps.store.listJobs(userNpub);
  return Response.json({ jobs });
}

/** POST /api/scheduler/jobs */
async function handleCreateJob(
  deps: SchedulerApiDependencies,
  userNpub: string,
  request: Request,
): Promise<Response> {
  const body = await parseJsonBody(request);

  // Validate required fields
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const agent = typeof body.agent === "string" ? body.agent.trim() : "";
  const workingDirectory = typeof body.workingDirectory === "string" ? body.workingDirectory.trim() : "";
  const initialPrompt = typeof body.initialPrompt === "string" ? body.initialPrompt.trim() : "";
  const triggerType = body.triggerType === "file_watcher" ? "file_watcher" as const : "cron" as const;
  const cronExpression = typeof body.cronExpression === "string" ? body.cronExpression.trim() : "";
  const timezone = typeof body.timezone === "string" ? body.timezone.trim() : "UTC";
  const watchDirectory = typeof body.watchDirectory === "string" ? body.watchDirectory.trim() : "";
  const filePattern = typeof body.filePattern === "string" ? body.filePattern.trim() : "*";
  const nightwatchmanEnabled = body.nightwatchmanEnabled !== false;

  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (!VALID_AGENTS.includes(agent)) {
    return Response.json({ error: `agent must be one of: ${VALID_AGENTS.join(", ")}` }, { status: 400 });
  }
  if (!workingDirectory) return Response.json({ error: "workingDirectory is required" }, { status: 400 });
  if (!initialPrompt) return Response.json({ error: "initialPrompt is required" }, { status: 400 });

  if (triggerType === "cron") {
    if (!cronExpression) return Response.json({ error: "cronExpression is required for schedule triggers" }, { status: 400 });
    if (!validateCronExpression(cronExpression)) {
      return Response.json({ error: "Invalid cron expression" }, { status: 400 });
    }
  } else {
    if (!watchDirectory) return Response.json({ error: "watchDirectory is required for file watcher triggers" }, { status: 400 });
  }

  // Lookup bot key for wrapping
  const botKey = deps.botKeyStore.getActiveKeyForUser(userNpub);
  if (!botKey) {
    return Response.json(
      { error: "No bot key found. A bot key is required for triggers." },
      { status: 400 },
    );
  }

  // Wrap the escrow UUID with session secret
  const sessionSecretBytes = getSessionSecretBytes();
  const wrapped = wrapEscrowUuid(botKey.escrowUuid, sessionSecretBytes);

  const job = deps.store.createJob({
    name,
    userNpub,
    botNpub: botKey.botNpub,
    wrappedKeyCiphertext: wrapped.ciphertext,
    wrappedKeyNonce: wrapped.nonce,
    agent,
    workingDirectory,
    initialPrompt,
    nightwatchmanEnabled,
    triggerType,
    cronExpression,
    timezone,
    watchDirectory: triggerType === "file_watcher" ? watchDirectory : undefined,
    filePattern: triggerType === "file_watcher" ? filePattern : undefined,
  });

  // Schedule it
  deps.engine.scheduleJob(job);

  return Response.json({ job }, { status: 201 });
}

/** PATCH /api/scheduler/jobs/:id */
async function handleUpdateJob(
  deps: SchedulerApiDependencies,
  userNpub: string,
  jobId: string,
  request: Request,
): Promise<Response> {
  const existing = deps.store.getJob(jobId);
  if (!existing || existing.userNpub !== userNpub) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  const body = await parseJsonBody(request);
  const update: Record<string, unknown> = {};

  if (typeof body.name === "string") update.name = body.name.trim();
  if (typeof body.agent === "string") {
    if (!VALID_AGENTS.includes(body.agent)) {
      return Response.json({ error: `agent must be one of: ${VALID_AGENTS.join(", ")}` }, { status: 400 });
    }
    update.agent = body.agent;
  }
  if (typeof body.workingDirectory === "string") update.workingDirectory = body.workingDirectory.trim();
  if (typeof body.initialPrompt === "string") update.initialPrompt = body.initialPrompt.trim();
  if (typeof body.nightwatchmanEnabled === "boolean") update.nightwatchmanEnabled = body.nightwatchmanEnabled;
  if (body.triggerType === "cron" || body.triggerType === "file_watcher") {
    update.triggerType = body.triggerType;
  }
  if (typeof body.cronExpression === "string") {
    if (!validateCronExpression(body.cronExpression)) {
      return Response.json({ error: "Invalid cron expression" }, { status: 400 });
    }
    update.cronExpression = body.cronExpression.trim();
  }
  if (typeof body.timezone === "string") update.timezone = body.timezone.trim();
  if (typeof body.watchDirectory === "string") update.watchDirectory = body.watchDirectory.trim();
  if (typeof body.filePattern === "string") update.filePattern = body.filePattern.trim();
  if (typeof body.enabled === "boolean") update.enabled = body.enabled;

  const job = deps.store.updateJob(jobId, update);
  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  // Reschedule or unschedule based on enabled state
  if (job.enabled) {
    deps.engine.scheduleJob(job);
  } else {
    deps.engine.unscheduleJob(job.id);
  }

  return Response.json({ job });
}

/** DELETE /api/scheduler/jobs/:id */
function handleDeleteJob(
  deps: SchedulerApiDependencies,
  userNpub: string,
  jobId: string,
): Response {
  const existing = deps.store.getJob(jobId);
  if (!existing || existing.userNpub !== userNpub) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  deps.engine.unscheduleJob(jobId);
  deps.store.deleteJob(jobId);

  return new Response(null, { status: 204 });
}

/** POST /api/scheduler/jobs/:id/trigger */
async function handleTriggerJob(
  deps: SchedulerApiDependencies,
  userNpub: string,
  jobId: string,
): Promise<Response> {
  const existing = deps.store.getJob(jobId);
  if (!existing || existing.userNpub !== userNpub) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  try {
    const sessionId = await deps.engine.executeJob(jobId);
    return Response.json({ sessionId });
  } catch (err) {
    return Response.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

/** GET /api/scheduler/jobs/:id/runs */
function handleListRuns(
  deps: SchedulerApiDependencies,
  userNpub: string,
  jobId: string,
): Response {
  const existing = deps.store.getJob(jobId);
  if (!existing || existing.userNpub !== userNpub) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  const runs = deps.store.getJobRuns(jobId);
  return Response.json({ runs });
}

// ============================================================
// Main Handler Factory
// ============================================================

export function createSchedulerApiHandler(deps: SchedulerApiDependencies) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
  ): Promise<Response> => {
    // Auth: resolve user npub
    const userNpub = deps.getNpub(request);
    if (!userNpub) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const segments = url.pathname.split("/").filter(Boolean);
    // segments[0] = "api", segments[1] = "scheduler"

    // /api/scheduler/jobs
    if (segments.length === 3 && segments[2] === "jobs") {
      if (method === "GET") return handleListJobs(deps, userNpub);
      if (method === "POST") return handleCreateJob(deps, userNpub, request);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/scheduler/jobs/:id
    if (segments.length === 4 && segments[2] === "jobs") {
      const jobId = segments[3]!;
      if (method === "PATCH") return handleUpdateJob(deps, userNpub, jobId, request);
      if (method === "DELETE") return handleDeleteJob(deps, userNpub, jobId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/scheduler/jobs/:id/trigger
    if (segments.length === 5 && segments[2] === "jobs" && segments[4] === "trigger") {
      if (method === "POST") return handleTriggerJob(deps, userNpub, segments[3]!);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/scheduler/jobs/:id/runs
    if (segments.length === 5 && segments[2] === "jobs" && segments[4] === "runs") {
      if (method === "GET") return handleListRuns(deps, userNpub, segments[3]!);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  };
}
