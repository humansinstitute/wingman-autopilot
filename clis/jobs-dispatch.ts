#!/usr/bin/env bun

/**
 * Wingman job dispatch CLI.
 *
 * Dispatches a job run by creating worker + manager sessions
 * and tracking them via the jobs-db SQLite store.
 *
 * Commands: start
 */

import { parseCommonFlags, buildConfig, requestJson, resolveBaseUrl } from "./lib/auth";
import {
  getJob,
  getRun,
  createRun,
  updateRun,
  type JobDefinition,
  type JobRun,
} from "../src/jobs-db";

const USAGE = `Wingman job dispatch CLI

Usage:
  bun clis/jobs-dispatch.ts start <job-id> [options]

Commands:
  start <job-id>       Start a new job run

Options:
  --goal <text>        Goal for this run (passed to worker + manager)
  --prompt <text>      Additional worker prompt (appended to job default)
  --ref <ref>          Attach a reference ID (repeatable)
  --dir <path>         Worker directory override (default: job definition default)
  --url <url>          Wingman URL (env: WINGMAN_URL, default: http://localhost:3000)
  --key <nsec|hex>     Nostr private key (env: WINGMAN_NSEC)
  --json               Print raw JSON response
  -h, --help           Show help

Examples:
  bun clis/jobs-dispatch.ts start my-job --goal "Ship the feature" --prompt "Focus on tests"
  bun clis/jobs-dispatch.ts start my-job --goal "Fix bug" --ref task-abc --ref pr-123 --dir /tmp/project
  bun clis/jobs-dispatch.ts start my-job --goal "Deploy" --json`;

// ============================================================
// Flag parsing
// ============================================================

interface DispatchFlags {
  positional: string[];
  goal?: string;
  prompt?: string;
  refs: string[];
  dir?: string;
  urlInput?: string;
  keyInput?: string;
  asJson: boolean;
  help: boolean;
}

function parseDispatchFlags(argv: string[]): DispatchFlags {
  const { args, urlInput, keyInput, asJson, help } = parseCommonFlags(argv);

  const parsed: DispatchFlags = {
    positional: [],
    refs: [],
    urlInput,
    keyInput,
    asJson,
    help,
  };

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    switch (token) {
      case "--goal": {
        const v = args[++i];
        if (!v) throw new Error("--goal requires a value");
        parsed.goal = v;
        break;
      }
      case "--prompt": {
        const v = args[++i];
        if (!v) throw new Error("--prompt requires a value");
        parsed.prompt = v;
        break;
      }
      case "--ref": {
        const v = args[++i];
        if (!v) throw new Error("--ref requires a value");
        parsed.refs.push(v);
        break;
      }
      case "--dir": {
        const v = args[++i];
        if (!v) throw new Error("--dir requires a value");
        parsed.dir = v;
        break;
      }
      default:
        parsed.positional.push(token);
    }
  }

  return parsed;
}

// ============================================================
// Prompt assembly
// ============================================================

function buildWorkerPrompt(job: JobDefinition, goal?: string, extraPrompt?: string): string {
  const parts: string[] = [];
  if (job.worker_prompt) parts.push(job.worker_prompt);
  if (extraPrompt) parts.push(extraPrompt);
  if (goal) parts.push(`\n## Goal\n${goal}`);
  return parts.join("\n\n");
}

function buildManagerContext(
  job: JobDefinition,
  goal?: string,
  refs: string[] = [],
  workerSessionId?: string,
): string {
  const parts: string[] = [];
  if (job.manager_prompt) parts.push(job.manager_prompt);
  if (goal) parts.push(`## Goal\n${goal}`);
  if (job.manager_goal) parts.push(`## Manager Goal\n${job.manager_goal}`);
  if (refs.length > 0) parts.push(`## References\n${refs.map((r) => `- ${r}`).join("\n")}`);
  if (workerSessionId) parts.push(`## Worker Session\nSession ID: ${workerSessionId}`);
  return parts.join("\n\n");
}

// ============================================================
// Session creation via Wingman API
// ============================================================

interface SessionResponse {
  id?: string;
  sessionId?: string;
  [key: string]: unknown;
}

async function createSession(
  baseUrl: string,
  secretKey: Uint8Array,
  name: string,
  directory: string,
  prompt: string,
): Promise<string> {
  const body = {
    agent: "claude-code",
    name,
    directory,
    prompt,
  };
  const payload = await requestJson<SessionResponse>(
    baseUrl,
    secretKey,
    "POST",
    "/api/sessions",
    body,
  );
  const sessionId = String(payload.id ?? payload.sessionId ?? "");
  if (!sessionId) {
    throw new Error("Session creation returned no ID");
  }
  return sessionId;
}

// ============================================================
// start command
// ============================================================

async function handleStart(flags: DispatchFlags): Promise<void> {
  const jobId = flags.positional[1];
  if (!jobId) throw new Error("start requires <job-id>");

  const job = getJob(jobId);
  if (!job) throw new Error(`Job definition not found: ${jobId}`);

  const { secretKey } = buildConfig(flags.urlInput, flags.keyInput);
  const baseUrl = resolveBaseUrl(flags.urlInput);

  const workerDir = flags.dir ?? job.manager_dir;
  const managerDir = job.manager_dir;

  // 1. Create the job_run row
  const workerPrompt = buildWorkerPrompt(job, flags.goal, flags.prompt);
  const refsJson = flags.refs.length > 0 ? JSON.stringify(flags.refs) : null;

  const jobRun = createRun({
    job_id: jobId,
    goal: flags.goal ?? null,
    manager_goal: job.manager_goal ?? null,
    worker_prompt: workerPrompt,
    worker_dir: workerDir,
    manager_dir: managerDir,
    refs_json: refsJson,
    status: "starting",
  });

  const runId = jobRun.id;
  console.error(`Created run ${runId.slice(0, 8)} for job ${jobId}`);

  try {
    // 2. Start worker session
    console.error(`Starting worker session in ${workerDir}...`);
    const workerSessionId = await createSession(
      baseUrl,
      secretKey,
      `job:${jobId}:worker:${runId.slice(0, 8)}`,
      workerDir,
      workerPrompt,
    );
    console.error(`Worker session: ${workerSessionId}`);

    // 3. Build manager context with worker session ID
    const managerContext = buildManagerContext(job, flags.goal, flags.refs, workerSessionId);

    // 4. Start manager session
    console.error(`Starting manager session in ${managerDir}...`);
    const managerSessionId = await createSession(
      baseUrl,
      secretKey,
      `job:${jobId}:manager:${runId.slice(0, 8)}`,
      managerDir,
      managerContext,
    );
    console.error(`Manager session: ${managerSessionId}`);

    // 5. Update run with session IDs and status
    updateRun(runId, {
      worker_session_id: workerSessionId,
      manager_session_id: managerSessionId,
      manager_context: managerContext,
      status: "running",
    });

    // 6. Output
    const result = getRun(runId)!;
    if (flags.asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Run ID:           ${result.id}`);
      console.log(`Job ID:           ${result.job_id}`);
      console.log(`Status:           ${result.status}`);
      console.log(`Worker Session:   ${result.worker_session_id}`);
      console.log(`Manager Session:  ${result.manager_session_id}`);
      console.log(`Worker Dir:       ${result.worker_dir}`);
      console.log(`Manager Dir:      ${result.manager_dir}`);
      if (flags.refs.length > 0) {
        console.log(`Refs:             ${flags.refs.join(", ")}`);
      }
    }
  } catch (err) {
    // Mark run as failed if session creation fails
    updateRun(runId, { status: "failed" });
    throw err;
  }
}

// ============================================================
// Main
// ============================================================

async function run(): Promise<void> {
  const flags = parseDispatchFlags(Bun.argv.slice(2));
  const command = flags.positional[0]?.toLowerCase() ?? "help";

  if (flags.help || command === "help") {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case "start":
      await handleStart(flags);
      break;

    default:
      throw new Error(`Unknown command: ${command}. Run with --help for usage.`);
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
