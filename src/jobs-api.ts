/**
 * Autopilot Jobs API Handler
 *
 * HTTP handler for /api/autopilot-jobs/* routes.
 * Exposes job definition CRUD, run listing, manual dispatch,
 * and stop controls for the Flight Deck UI.
 */

import type { SessionSnapshot } from "./agents/process-manager";
import { AGENT_TYPE_LIST, type AgentType } from "./agent-types";
import { waitForAgentReady } from "./agents/agent-client";
import type { RequestAuthContext } from "./auth/request-context";
import {
  createJob,
  createRun,
  deleteJob,
  getJob,
  getRun,
  listJobs,
  listRuns,
  updateJob,
  updateRun,
  updateRunStatus,
  type CreateJobInput,
  type JobDefinition,
  type JobRun,
  type UpdateJobInput,
} from "./jobs-db";
import { dispatchJobRun } from "./jobs-dispatch";
import { isJobAgentType, resolveJobAgent } from "./jobs/agent-config";
import { deliverSessionAgentMessage } from "./server/session-agent-message";
import type { SessionApiContext } from "./server/session-api-routes";
import { parseNightWatchStartOptions, type NightWatchStartOptions } from "./nightwatch/nightwatch-start-config";
import { getEffectiveOwnerNpub } from "./auth/effective-owner";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface JobsStore {
  listJobs: typeof listJobs;
  getJob: typeof getJob;
  createJob: (input: CreateJobInput) => JobDefinition;
  updateJob: (id: string, input: UpdateJobInput) => JobDefinition | undefined;
  deleteJob: typeof deleteJob;
  listRuns: typeof listRuns;
  getRun: typeof getRun;
  createRun: typeof createRun;
  updateRun: typeof updateRun;
  updateRunStatus: typeof updateRunStatus;
}

interface AutopilotJobsApiContext {
  store?: Partial<JobsStore>;
  sessionApiContext?: SessionApiContext;
  dispatchRun?: (input: {
    authContext: RequestAuthContext;
    wingmanUrl: string;
    job: JobDefinition;
    goal?: string | null;
    workerGoal?: string | null;
    managerGoal?: string | null;
    workerAgent?: AgentType | null;
    managerAgent?: AgentType | null;
    prompt?: string | null;
    refs?: string[];
    workerDir?: string | null;
    managerDir?: string | null;
    nightwatch?: NightWatchStartOptions | null;
  }) => Promise<{
    run: JobRun;
    workerSession?: SessionSnapshot | null;
    managerSession?: SessionSnapshot | null;
  }>;
}

const defaultStore: JobsStore = {
  listJobs,
  getJob,
  createJob,
  updateJob,
  deleteJob,
  listRuns,
  getRun,
  createRun,
  updateRun,
  updateRunStatus,
};

/** Normalize SQLite integer booleans to actual booleans for JSON responses. */
function normalizeJob(job: JobDefinition): Record<string, unknown> {
  return {
    ...job,
    worker_agent: resolveJobAgent(job.worker_agent),
    manager_agent: resolveJobAgent(job.manager_agent),
    enabled: !!job.enabled,
  };
}

function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  return request.json().catch(() => {
    throw new Error("Invalid JSON payload");
  }) as Promise<Record<string, unknown>>;
}

const normalizeText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeAgent = (value: unknown): AgentType | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return isJobAgentType(trimmed) ? trimmed : null;
};

const normalizeRefs = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry, index, array) => entry.length > 0 && array.indexOf(entry) === index);
};

const recordLiveSession = async (
  ctx: SessionApiContext,
  session: SessionSnapshot,
): Promise<void> => {
  ctx.messageStore.recordSession({
    id: session.id,
    agent: session.agent,
    startedAt: session.startedAt,
    name: session.name,
    npub: session.npub,
    port: session.port,
    pid: session.pid,
    workingDirectory: session.workingDirectory,
    command: session.command,
    runtimeStatus: session.agentRuntimeStatus ?? null,
    origin: session.origin ?? null,
    pm2Name: session.pm2Name,
    tmuxSession: session.tmuxSession,
    tmuxWindow: session.tmuxWindow,
    targetFile: session.targetFile,
    metadata: session.metadata,
  });
  await ctx.syncSessionMessages(session.id, true);
};

const createDefaultDispatchRun = (
  store: JobsStore,
  sessionCtx?: SessionApiContext,
) => {
  return async (input: {
    authContext: RequestAuthContext;
    wingmanUrl: string;
    job: JobDefinition;
    goal?: string | null;
    workerGoal?: string | null;
    managerGoal?: string | null;
    workerAgent?: AgentType | null;
    managerAgent?: AgentType | null;
    prompt?: string | null;
    refs?: string[];
    workerDir?: string | null;
    managerDir?: string | null;
    nightwatch?: NightWatchStartOptions | null;
  }) => {
    if (!sessionCtx) {
      throw new Error("Jobs dispatch is not configured");
    }
    const ownerNpub = getEffectiveOwnerNpub(input.authContext);
    if (!ownerNpub) {
      throw new Error("Sign in to launch a job");
    }

    return dispatchJobRun(
      {
        runStore: {
          createRun: store.createRun,
          updateRun: store.updateRun,
          getRun: store.getRun,
        },
        createSession: async (name, directory, agent, nightwatch) => {
          const session = await sessionCtx.manager.createSession(
            agent,
            directory,
            name,
            null,
            undefined,
            ownerNpub ?? undefined,
          );
          if (nightwatch?.enabled) {
            sessionCtx.enableNightWatch(session.id, {
              prompt: nightwatch.prompt,
              intervalMinutes: nightwatch.intervalMinutes,
              maxCycles: nightwatch.maxCycles,
            });
          }
          await recordLiveSession(sessionCtx, session);
          return session;
        },
        waitForSessionReady: async (session) => {
          await waitForAgentReady(sessionCtx.agentHost, session.port, session.agent, {
            timeoutMs: session.agent === "codex" ? 120_000 : 60_000,
            pollIntervalMs: 250,
          });
        },
        seedSession: async (session, content) => {
          const result = await deliverSessionAgentMessage({
            agentHost: sessionCtx.agentHost,
            buildAgentUrl: sessionCtx.buildAgentUrl,
            agent: session.agent,
            port: session.port,
            content,
            type: "user",
            pm2Name: session.pm2Name,
          });
          if (!result.ok) {
            throw new Error(result.message);
          }
          await sessionCtx.syncSessionMessages(session.id, true);
        },
      },
      {
        job: input.job,
        wingmanUrl: input.wingmanUrl,
        goal: input.goal,
        workerGoal: input.workerGoal,
        managerGoal: input.managerGoal,
        workerAgent: input.workerAgent,
        managerAgent: input.managerAgent,
        prompt: input.prompt,
        refs: input.refs,
        workerDir: input.workerDir,
        managerDir: input.managerDir,
        nightwatch: input.nightwatch,
      },
    );
  };
};

// ============================================================
// Main Handler Factory
// ============================================================

export function createAutopilotJobsApiHandler(context: AutopilotJobsApiContext = {}) {
  const store: JobsStore = {
    ...defaultStore,
    ...context.store,
  };
  const dispatchRun =
    context.dispatchRun ?? createDefaultDispatchRun(store, context.sessionApiContext);

  const handleListDefinitions = (): Response => {
    const jobs = store.listJobs().map(normalizeJob);
    return Response.json({ jobs });
  };

  const handleGetDefinition = (id: string): Response => {
    const job = store.getJob(id);
    if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
    return Response.json({ job: normalizeJob(job) });
  };

  const handleCreateDefinition = async (request: Request): Promise<Response> => {
    const body = await parseJsonBody(request);

    const id = typeof body.id === "string" ? body.id.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const worker_prompt = typeof body.worker_prompt === "string" ? body.worker_prompt.trim() : "";
    const manager_prompt = typeof body.manager_prompt === "string" ? body.manager_prompt.trim() : "";
    const manager_goal = typeof body.manager_goal === "string" ? body.manager_goal.trim() : "";
    const worker_agent = normalizeAgent(body.worker_agent);
    const manager_agent = normalizeAgent(body.manager_agent);
    const manager_dir = typeof body.manager_dir === "string" ? body.manager_dir.trim() : "";
    const check_interval = typeof body.check_interval === "number" ? body.check_interval : undefined;
    const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;

    if (!id) return Response.json({ error: "id is required" }, { status: 400 });
    if (!name) return Response.json({ error: "name is required" }, { status: 400 });
    if (!manager_dir) return Response.json({ error: "manager_dir is required" }, { status: 400 });
    if (body.worker_agent !== undefined && !worker_agent) {
      return Response.json({ error: `worker_agent must be one of: ${AGENT_TYPE_LIST}` }, { status: 400 });
    }
    if (body.manager_agent !== undefined && !manager_agent) {
      return Response.json({ error: `manager_agent must be one of: ${AGENT_TYPE_LIST}` }, { status: 400 });
    }

    const existing = store.getJob(id);
    if (existing) return Response.json({ error: `Job already exists: ${id}` }, { status: 409 });

    const job = store.createJob({
      id,
      name,
      worker_prompt,
      manager_prompt,
      manager_goal,
      worker_agent: worker_agent ?? undefined,
      manager_agent: manager_agent ?? undefined,
      manager_dir,
      check_interval,
      enabled,
    });

    return Response.json({ job: normalizeJob(job) }, { status: 201 });
  };

  const handleUpdateDefinition = async (id: string, request: Request): Promise<Response> => {
    const existing = store.getJob(id);
    if (!existing) return Response.json({ error: "Job not found" }, { status: 404 });

    const body = await parseJsonBody(request);
    const updates: Record<string, unknown> = {};

    if (typeof body.name === "string") updates.name = body.name.trim();
    if (typeof body.worker_prompt === "string") updates.worker_prompt = body.worker_prompt.trim();
    if (typeof body.manager_prompt === "string") updates.manager_prompt = body.manager_prompt.trim();
    if (typeof body.manager_goal === "string") updates.manager_goal = body.manager_goal.trim();
    if (body.worker_agent !== undefined) {
      const workerAgent = normalizeAgent(body.worker_agent);
      if (!workerAgent) {
        return Response.json({ error: `worker_agent must be one of: ${AGENT_TYPE_LIST}` }, { status: 400 });
      }
      updates.worker_agent = workerAgent;
    }
    if (body.manager_agent !== undefined) {
      const managerAgent = normalizeAgent(body.manager_agent);
      if (!managerAgent) {
        return Response.json({ error: `manager_agent must be one of: ${AGENT_TYPE_LIST}` }, { status: 400 });
      }
      updates.manager_agent = managerAgent;
    }
    if (typeof body.manager_dir === "string") updates.manager_dir = body.manager_dir.trim();
    if (typeof body.check_interval === "number") updates.check_interval = body.check_interval;
    if (typeof body.enabled === "boolean") updates.enabled = body.enabled;

    if (Object.keys(updates).length === 0) {
      return Response.json({ error: "No fields to update" }, { status: 400 });
    }

    const job = store.updateJob(id, updates);
    if (!job) return Response.json({ error: "Job not found" }, { status: 404 });

    return Response.json({ job: normalizeJob(job) });
  };

  const handleDeleteDefinition = (id: string): Response => {
    const deleted = store.deleteJob(id);
    if (!deleted) return Response.json({ error: "Job not found" }, { status: 404 });
    return new Response(null, { status: 204 });
  };

  const handleListRuns = (url: URL): Response => {
    const jobId = url.searchParams.get("job_id") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const runs = store.listRuns(jobId, status);
    return Response.json({ runs });
  };

  const handleCreateRun = async (
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ): Promise<Response> => {
    const body = await parseJsonBody(request);
    const jobId = normalizeText(body.job_id);
    const workerAgent = normalizeAgent(body.worker_agent);
    const managerAgent = normalizeAgent(body.manager_agent);
    if (!jobId) {
      return Response.json({ error: "job_id is required" }, { status: 400 });
    }
    if (body.worker_agent !== undefined && !workerAgent) {
      return Response.json({ error: `worker_agent must be one of: ${AGENT_TYPE_LIST}` }, { status: 400 });
    }
    if (body.manager_agent !== undefined && !managerAgent) {
      return Response.json({ error: `manager_agent must be one of: ${AGENT_TYPE_LIST}` }, { status: 400 });
    }

    const job = store.getJob(jobId);
    if (!job) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }
    if (!job.enabled) {
      return Response.json({ error: "Job is disabled" }, { status: 400 });
    }

    try {
      let nightwatch: NightWatchStartOptions | null = null;
      try {
        nightwatch = parseNightWatchStartOptions(body.nightwatch ?? null);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      const result = await dispatchRun({
        authContext,
        wingmanUrl: url.origin,
        job,
        goal: normalizeText(body.goal),
        workerGoal: normalizeText(body.worker_goal),
        managerGoal: normalizeText(body.manager_goal),
        workerAgent,
        managerAgent,
        prompt: normalizeText(body.prompt),
        refs: normalizeRefs(body.refs),
        workerDir: normalizeText(body.worker_dir),
        managerDir: normalizeText(body.manager_dir),
        nightwatch,
      });

      const responsePayload: Record<string, unknown> = { run: result.run };
      if (result.workerSession && context.sessionApiContext) {
        responsePayload.worker_session = context.sessionApiContext.serializeSession(result.workerSession);
      }
      if (result.managerSession && context.sessionApiContext) {
        responsePayload.manager_session = context.sessionApiContext.serializeSession(result.managerSession);
      }
      return Response.json(responsePayload, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to launch job";
      const status = /sign in/i.test(message) ? 403 : /balance/i.test(message) ? 402 : 500;
      return Response.json({ error: message }, { status });
    }
  };

  const handleGetRun = (id: string): Response => {
    const run = store.getRun(id);
    if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
    return Response.json({ run });
  };

  const handleStopRun = async (id: string): Promise<Response> => {
    const run = store.getRun(id);
    if (!run) return Response.json({ error: "Run not found" }, { status: 404 });

    if (run.status === "stopped" || run.status === "complete" || run.status === "failed") {
      return Response.json({ message: `Run already ${run.status}` });
    }

    // Stop linked sessions server-side before marking the run as stopped
    const sessionIds = [run.worker_session_id, run.manager_session_id].filter(Boolean) as string[];
    const errors: string[] = [];

    if (context.sessionApiContext?.manager) {
      for (const sessionId of sessionIds) {
        try {
          await context.sessionApiContext.manager.stopSession(sessionId);
        } catch (error) {
          errors.push(`${sessionId.slice(0, 8)}: ${(error as Error).message}`);
        }
      }
    }

    if (errors.length > 0) {
      return Response.json(
        { error: `Failed to stop sessions: ${errors.join("; ")}` },
        { status: 500 },
      );
    }

    store.updateRunStatus(id, "stopped");
    const updated = store.getRun(id);
    return Response.json({ run: updated });
  };

  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
    authContext: RequestAuthContext,
  ): Promise<Response | null> => {
    const segments = url.pathname.split("/").filter(Boolean);

    if (segments.length === 3 && segments[2] === "definitions") {
      if (method === "GET") return handleListDefinitions();
      if (method === "POST") return handleCreateDefinition(request);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    if (segments.length === 4 && segments[2] === "definitions") {
      const id = decodeURIComponent(segments[3]!);
      if (method === "GET") return handleGetDefinition(id);
      if (method === "PATCH") return handleUpdateDefinition(id, request);
      if (method === "DELETE") return handleDeleteDefinition(id);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    if (segments.length === 3 && segments[2] === "runs") {
      if (method === "GET") return handleListRuns(url);
      if (method === "POST") return handleCreateRun(request, url, authContext);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    if (segments.length === 4 && segments[2] === "runs") {
      const id = decodeURIComponent(segments[3]!);
      if (method === "GET") return handleGetRun(id);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    if (segments.length === 5 && segments[2] === "runs" && segments[4] === "stop") {
      const id = decodeURIComponent(segments[3]!);
      if (method === "POST") return handleStopRun(id);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    return null;
  };
}
