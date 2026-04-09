#!/usr/bin/env bun

/**
 * Wingman job dispatch CLI.
 *
 * Launches a saved job definition through the Wingman jobs API.
 * The server handles run creation, session startup, prompt seeding,
 * and default naming so the CLI stays thin.
 *
 * Commands: start
 */

import {
  parseCommonFlags,
  buildConfig,
  requestJson,
  requestJsonBotCrypto,
  resolveBaseUrl,
} from "./lib/auth";
import { isJobAgentType } from "../src/jobs/agent-config";

const USAGE = `Wingman job dispatch CLI

Usage:
  bun clis/jobs-dispatch.ts start <job-id> [options]

Commands:
  start <job-id>             Start a new job run

Options:
  --goal <text>              Shared goal for this run (used when no role-specific goal is set)
  --worker-goal <text>       Goal passed only to the worker
  --manager-goal <text>      Goal passed only to the manager
  --worker-agent <agent>     Worker agent override: codex|claude|goose|opencode|gemini
  --manager-agent <agent>    Manager agent override: codex|claude|goose|opencode|gemini
  --prompt <text>            Additional worker prompt (appended to job default)
  --ref <ref>                Attach a reference ID (repeatable)
  --dir <path>               Worker directory override (alias for --worker-dir)
  --worker-dir <path>        Worker directory override
  --manager-dir <path>       Manager directory override
  --nightwatch <true|false>  Enable/disable Night Watch for launched job sessions
  --nightwatchman <true|false> Alias for --nightwatch
  --nightwatch-prompt <text> Prompt used by Night Watch check-ins
  --nightwatch-interval <n>  Minutes between Night Watch check-ins
  --nightwatch-max-cycles <n> Maximum number of Night Watch check-ins
  --url <url>                Wingman URL (env: WINGMAN_URL, default: http://localhost:3000)
  --key <nsec|hex>           Nostr private key (env: WINGMAN_NSEC)
  --bot-crypto               Sign via bot-crypto API (for agent sessions)
  --json                     Print raw JSON response
  -h, --help                 Show help

Examples:
  bun clis/jobs-dispatch.ts start movie-research --goal "Find 1990s neo-noir films"
  bun clis/jobs-dispatch.ts start my-job --worker-agent codex --manager-agent claude --worker-dir /tmp/project --manager-dir /tmp/review
  bun clis/jobs-dispatch.ts start my-job --worker-goal "Write the design doc" --manager-goal "Review and update the task" --ref task-abc
  bun clis/jobs-dispatch.ts start my-job --nightwatch true --nightwatch-interval 10`;

interface DispatchFlags {
  positional: string[];
  goal?: string;
  workerGoal?: string;
  managerGoal?: string;
  workerAgent?: string;
  managerAgent?: string;
  prompt?: string;
  refs: string[];
  workerDir?: string;
  managerDir?: string;
  nightwatchEnabled?: boolean;
  nightwatchPrompt?: string;
  nightwatchInterval?: number;
  nightwatchMaxCycles?: number;
  urlInput?: string;
  keyInput?: string;
  asJson: boolean;
  help: boolean;
  botCrypto: boolean;
}

interface JobRunResponse {
  run?: Record<string, unknown>;
  worker_session?: Record<string, unknown>;
  manager_session?: Record<string, unknown>;
}

function parseBooleanFlag(value: string | undefined, flagName: string): boolean {
  if (value === undefined) {
    throw new Error(`${flagName} requires a value: true or false`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${flagName} must be true or false`);
}

function parsePositiveIntegerFlag(value: string | undefined, flagName: string): number {
  if (value === undefined) {
    throw new Error(`${flagName} requires a numeric value`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return parsed;
}

function parseAgentFlag(value: string | undefined, flagName: string): string {
  if (!value) throw new Error(`${flagName} requires a value`);
  const normalized = value.trim().toLowerCase();
  if (!isJobAgentType(normalized)) {
    throw new Error(`${flagName} must be one of: codex, claude, goose, opencode, gemini`);
  }
  return normalized;
}

function parseDispatchFlags(argv: string[]): DispatchFlags {
  const { args, urlInput, keyInput, asJson, help, botCrypto } = parseCommonFlags(argv);

  const parsed: DispatchFlags = {
    positional: [],
    refs: [],
    urlInput,
    keyInput,
    asJson,
    help,
    botCrypto,
  };

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    switch (token) {
      case "--goal": {
        const value = args[++i];
        if (!value) throw new Error("--goal requires a value");
        parsed.goal = value;
        break;
      }
      case "--worker-goal": {
        const value = args[++i];
        if (!value) throw new Error("--worker-goal requires a value");
        parsed.workerGoal = value;
        break;
      }
      case "--manager-goal": {
        const value = args[++i];
        if (!value) throw new Error("--manager-goal requires a value");
        parsed.managerGoal = value;
        break;
      }
      case "--worker-agent": {
        parsed.workerAgent = parseAgentFlag(args[++i], "--worker-agent");
        break;
      }
      case "--manager-agent": {
        parsed.managerAgent = parseAgentFlag(args[++i], "--manager-agent");
        break;
      }
      case "--prompt": {
        const value = args[++i];
        if (!value) throw new Error("--prompt requires a value");
        parsed.prompt = value;
        break;
      }
      case "--ref": {
        const value = args[++i];
        if (!value) throw new Error("--ref requires a value");
        parsed.refs.push(value);
        break;
      }
      case "--dir":
      case "--worker-dir": {
        const value = args[++i];
        if (!value) throw new Error(`${token} requires a value`);
        parsed.workerDir = value;
        break;
      }
      case "--manager-dir": {
        const value = args[++i];
        if (!value) throw new Error("--manager-dir requires a value");
        parsed.managerDir = value;
        break;
      }
      case "--nightwatch":
      case "--nightwatchman": {
        parsed.nightwatchEnabled = parseBooleanFlag(args[++i], token);
        break;
      }
      case "--nightwatch-prompt": {
        const value = args[++i];
        if (!value) throw new Error("--nightwatch-prompt requires a value");
        parsed.nightwatchPrompt = value;
        break;
      }
      case "--nightwatch-interval": {
        parsed.nightwatchInterval = parsePositiveIntegerFlag(args[++i], "--nightwatch-interval");
        break;
      }
      case "--nightwatch-max-cycles": {
        parsed.nightwatchMaxCycles = parsePositiveIntegerFlag(args[++i], "--nightwatch-max-cycles");
        break;
      }
      default:
        parsed.positional.push(token);
    }
  }

  return parsed;
}

function printResult(result: JobRunResponse): void {
  const run = result.run ?? {};
  console.log(`Run ID:           ${String(run.id ?? "-")}`);
  console.log(`Job ID:           ${String(run.job_id ?? "-")}`);
  console.log(`Status:           ${String(run.status ?? "-")}`);
  console.log(`Worker Agent:     ${String(run.worker_agent ?? "-")}`);
  console.log(`Manager Agent:    ${String(run.manager_agent ?? "-")}`);
  console.log(`Worker Session:   ${String(run.worker_session_id ?? "-")}`);
  console.log(`Manager Session:  ${String(run.manager_session_id ?? "-")}`);
  console.log(`Worker Dir:       ${String(run.worker_dir ?? "-")}`);
  console.log(`Manager Dir:      ${String(run.manager_dir ?? "-")}`);
}

function buildNightWatchPayload(flags: DispatchFlags): false | Record<string, unknown> | undefined {
  const hasNightWatchFields =
    flags.nightwatchEnabled !== undefined ||
    flags.nightwatchPrompt !== undefined ||
    flags.nightwatchInterval !== undefined ||
    flags.nightwatchMaxCycles !== undefined;
  if (!hasNightWatchFields) {
    return undefined;
  }
  if (
    flags.nightwatchEnabled === false &&
    flags.nightwatchPrompt === undefined &&
    flags.nightwatchInterval === undefined &&
    flags.nightwatchMaxCycles === undefined
  ) {
    return false;
  }

  const payload: Record<string, unknown> = {};
  if (flags.nightwatchEnabled !== undefined) payload.enabled = flags.nightwatchEnabled;
  if (flags.nightwatchPrompt !== undefined) payload.prompt = flags.nightwatchPrompt;
  if (flags.nightwatchInterval !== undefined) payload.intervalMinutes = flags.nightwatchInterval;
  if (flags.nightwatchMaxCycles !== undefined) payload.maxCycles = flags.nightwatchMaxCycles;
  return payload;
}

async function handleStart(flags: DispatchFlags): Promise<void> {
  const jobId = flags.positional[1];
  if (!jobId) throw new Error("start requires <job-id>");

  const baseUrl = resolveBaseUrl(flags.urlInput);
  const body: Record<string, unknown> = {
    job_id: jobId,
  };

  if (flags.goal) body.goal = flags.goal;
  if (flags.workerGoal) body.worker_goal = flags.workerGoal;
  if (flags.managerGoal) body.manager_goal = flags.managerGoal;
  if (flags.workerAgent) body.worker_agent = flags.workerAgent;
  if (flags.managerAgent) body.manager_agent = flags.managerAgent;
  if (flags.prompt) body.prompt = flags.prompt;
  if (flags.refs.length > 0) body.refs = flags.refs;
  if (flags.workerDir) body.worker_dir = flags.workerDir;
  if (flags.managerDir) body.manager_dir = flags.managerDir;
  const nightWatchBody = buildNightWatchPayload(flags);
  if (nightWatchBody !== undefined) body.nightwatch = nightWatchBody;

  const result = flags.botCrypto
    ? await requestJsonBotCrypto<JobRunResponse>(baseUrl, "POST", "/api/autopilot-jobs/runs", body)
    : await requestJson<JobRunResponse>(
        baseUrl,
        buildConfig(flags.urlInput, flags.keyInput).secretKey,
        "POST",
        "/api/autopilot-jobs/runs",
        body,
      );

  if (flags.asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printResult(result);
}

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
