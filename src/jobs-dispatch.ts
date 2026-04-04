/**
 * Shared job dispatch flow for manual job launches.
 *
 * Creates the run record, starts the worker + manager sessions,
 * seeds each session with its initial prompt, and updates the run.
 */

import type { AgentType } from "./config";
import type { SessionSnapshot } from "./agents/process-manager";
import type { CreateRunInput, JobDefinition, JobRun } from "./jobs-db";
import { buildDefaultJobSessionName, resolveJobAgents } from "./jobs/agent-config";

export interface JobRunStore {
  createRun: (input: CreateRunInput) => JobRun;
  updateRun: (id: string, fields: Partial<Omit<JobRun, "id" | "created_at">>) => boolean;
  getRun: (id: string) => JobRun | undefined;
}

export interface DispatchJobRunInput {
  job: JobDefinition;
  wingmanUrl: string;
  goal?: string | null;
  workerGoal?: string | null;
  managerGoal?: string | null;
  workerAgent?: AgentType | null;
  managerAgent?: AgentType | null;
  prompt?: string | null;
  refs?: string[];
  workerDir?: string | null;
  managerDir?: string | null;
}

export interface DispatchJobRunDeps {
  runStore: JobRunStore;
  createSession: (name: string, directory: string, agent: AgentType) => Promise<SessionSnapshot>;
  waitForSessionReady: (session: SessionSnapshot) => Promise<void>;
  seedSession: (session: SessionSnapshot, content: string) => Promise<void>;
}

export interface DispatchJobRunResult {
  run: JobRun;
  workerSession: SessionSnapshot;
  managerSession: SessionSnapshot;
}

const normalizeText = (value: string | null | undefined): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeRefs = (refs: string[] | null | undefined): string[] => {
  const unique = new Set<string>();
  (Array.isArray(refs) ? refs : []).forEach((ref) => {
    const trimmed = typeof ref === "string" ? ref.trim() : "";
    if (trimmed.length > 0) {
      unique.add(trimmed);
    }
  });
  return Array.from(unique);
};

export function buildWorkerPrompt(
  job: JobDefinition,
  goal?: string | null,
  extraPrompt?: string | null,
): string {
  const parts: string[] = [];
  const workerPrompt = normalizeText(job.worker_prompt);
  const extra = normalizeText(extraPrompt);
  const normalizedGoal = normalizeText(goal);
  if (workerPrompt) parts.push(workerPrompt);
  if (extra) parts.push(extra);
  if (normalizedGoal) parts.push(`## Goal\n${normalizedGoal}`);
  return parts.join("\n\n");
}

export function buildManagerContext(
  job: JobDefinition,
  runId: string,
  wingmanUrl: string,
  goal?: string | null,
  refs: string[] = [],
  workerAgent?: AgentType,
  managerAgent?: AgentType,
  workerSessionId?: string,
): string {
  const parts: string[] = [];
  const normalizedGoal = normalizeText(goal);
  const managerPrompt = normalizeText(job.manager_prompt);
  const managerGoal = normalizeText(job.manager_goal);
  const hasTaskRef = refs.some((ref) => ref.startsWith("task:"));

  if (managerPrompt) parts.push(managerPrompt);
  if (normalizedGoal) parts.push(`## Goal\n${normalizedGoal}`);
  if (managerGoal) parts.push(`## Manager Goal\n${managerGoal}`);
  parts.push(
    [
      "## Run Context",
      `Run ID: ${runId}`,
      `Check Interval: ${job.check_interval}s`,
      `Wingman URL: ${wingmanUrl}`,
      workerAgent ? `Worker Agent: ${workerAgent}` : null,
      managerAgent ? `Manager Agent: ${managerAgent}` : null,
      workerSessionId ? `Worker Session ID: ${workerSessionId}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  if (refs.length > 0) {
    parts.push(`## References\n${refs.map((ref) => `- ${ref}`).join("\n")}`);
  }
  if (!hasTaskRef) {
    parts.push(`## Task Context
No task reference was provided for this run. If your operating instructions require task tracking, create a new task before proceeding and keep that new task updated.`);
  }
  parts.push(`## Operating Contract
You are responsible for actively managing this run until it is complete.

Required behavior:
1. Review the worker output regularly.
2. If you have feedback or revision requests, send them to the worker using the jobs manager CLI.
3. Wait for the configured interval before checking again. Use a bash sleep command for this loop.
4. If this run is attached to a task reference, keep the task updated in the workspace tool available in your environment.
5. When the deliverable is approved, update the task with the result and mark the run complete.

Use these commands:
\`\`\`bash
bun /Users/mini/code/wingmen/clis/jobs-manager.ts read-worker ${runId} --url ${wingmanUrl} --bot-crypto --lines 120
bun /Users/mini/code/wingmen/clis/jobs-manager.ts message ${runId} "<feedback for worker>" --url ${wingmanUrl} --bot-crypto
sleep ${job.check_interval}
bun /Users/mini/code/wingmen/clis/jobs-manager.ts complete ${runId} --summary "<summary>" --url ${wingmanUrl} --bot-crypto
\`\`\`

Do not keep feedback only in your own session history. Send actionable feedback to the worker session.`);

  return parts.join("\n\n");
}

export async function dispatchJobRun(
  deps: DispatchJobRunDeps,
  input: DispatchJobRunInput,
): Promise<DispatchJobRunResult> {
  const goal = normalizeText(input.goal);
  const workerGoal = normalizeText(input.workerGoal) ?? goal;
  const managerGoal = normalizeText(input.managerGoal) ?? goal;
  const managerDir = normalizeText(input.managerDir) ?? normalizeText(input.job.manager_dir);
  const workerDir = normalizeText(input.workerDir) ?? managerDir;
  const refs = normalizeRefs(input.refs);
  const workerPrompt = buildWorkerPrompt(input.job, workerGoal, input.prompt);
  const { workerAgent, managerAgent } = resolveJobAgents(input.job, {
    workerAgent: input.workerAgent,
    managerAgent: input.managerAgent,
  });

  if (!managerDir) {
    throw new Error("Job definition is missing a manager directory");
  }
  if (!workerDir) {
    throw new Error("Worker directory is required");
  }

  const run = deps.runStore.createRun({
    job_id: input.job.id,
    goal: goal ?? undefined,
    manager_goal: managerGoal ?? normalizeText(input.job.manager_goal) ?? undefined,
    worker_agent: workerAgent,
    manager_agent: managerAgent,
    worker_prompt: workerPrompt,
    worker_dir: workerDir,
    manager_dir: managerDir,
    refs_json: refs.length > 0 ? JSON.stringify(refs) : undefined,
    status: "starting",
  });

  const runId = run.id;

  try {
    const workerSession = await deps.createSession(
      buildDefaultJobSessionName(input.job.id, "worker", workerAgent, runId),
      workerDir,
      workerAgent,
    );
    await deps.waitForSessionReady(workerSession);
    await deps.seedSession(workerSession, workerPrompt);

    const managerContext = buildManagerContext(
      input.job,
      runId,
      input.wingmanUrl,
      managerGoal,
      refs,
      workerAgent,
      managerAgent,
      workerSession.id,
    );

    const managerSession = await deps.createSession(
      buildDefaultJobSessionName(input.job.id, "manager", managerAgent, runId),
      managerDir,
      managerAgent,
    );
    await deps.waitForSessionReady(managerSession);
    await deps.seedSession(managerSession, managerContext);

    deps.runStore.updateRun(runId, {
      manager_context: managerContext,
      manager_session_id: managerSession.id,
      worker_session_id: workerSession.id,
      status: "running",
    });

    const updatedRun = deps.runStore.getRun(runId);
    if (!updatedRun) {
      throw new Error("Job run disappeared after dispatch");
    }

    return {
      run: updatedRun,
      workerSession,
      managerSession,
    };
  } catch (error) {
    deps.runStore.updateRun(runId, { status: "failed" });
    throw error;
  }
}
