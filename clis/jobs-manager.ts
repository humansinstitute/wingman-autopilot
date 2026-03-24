#!/usr/bin/env bun

/**
 * Wingman jobs manager CLI.
 *
 * Manages job runs — read goals, monitor worker output, send messages,
 * and mark runs as complete or failed.
 *
 * Commands: goal, manager-goal, read-worker, worker-history, message, complete, fail
 */

import { getRun, updateRunStatus, type JobRun } from "../src/jobs-db";
import { parseCommonFlags, buildConfig, requestJson, requestJsonBotCrypto, resolveBaseUrl } from "./lib/auth";

const USAGE = `Wingman jobs manager CLI

Usage:
  bun clis/jobs-manager.ts <command> [run-id] [options]

Commands:
  goal <run-id>              Print the worker goal for a run
  manager-goal <run-id>      Print the manager goal for a run
  read-worker <run-id>       Read last N lines of worker session output (default: 50)
  worker-history <run-id>    Read full worker session output
  message <run-id> <text>    Send a message to the worker session
  complete <run-id>          Mark run as complete
  fail <run-id>              Mark run as failed

Options:
  --lines <n>                Number of lines for read-worker (default: 50)
  --summary <text>           Output summary for complete command
  --reason <text>            Failure reason for fail command
  --url <url>                Wingman URL (env: WINGMAN_URL, default: http://localhost:3000)
  --key <nsec|hex>           Nostr private key (env: WINGMAN_NSEC)
  --bot-crypto               Sign via bot-crypto API (for agent sessions)
  --json                     Print raw JSON response
  -h, --help                 Show help

Examples:
  bun clis/jobs-manager.ts goal abc123
  bun clis/jobs-manager.ts read-worker abc123 --lines 100
  bun clis/jobs-manager.ts message abc123 "please run the tests"
  bun clis/jobs-manager.ts complete abc123 --summary "All tasks done"
  bun clis/jobs-manager.ts fail abc123 --reason "Build failed"`;

// ============================================================
// Flag parsing
// ============================================================

interface ManagerFlags {
  lines: number;
  summary?: string;
  reason?: string;
}

function parseManagerFlags(args: string[]): { positional: string[]; flags: ManagerFlags } {
  const positional: string[] = [];
  const flags: ManagerFlags = { lines: 50 };

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    switch (token) {
      case "--lines": {
        const v = args[++i];
        if (!v) throw new Error("--lines requires a value");
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n < 1) throw new Error("--lines must be a positive integer");
        flags.lines = n;
        break;
      }
      case "--summary": {
        const v = args[++i];
        if (!v) throw new Error("--summary requires a value");
        flags.summary = v;
        break;
      }
      case "--reason": {
        const v = args[++i];
        if (!v) throw new Error("--reason requires a value");
        flags.reason = v;
        break;
      }
      default:
        positional.push(token);
    }
  }

  return { positional, flags };
}

// ============================================================
// Helpers
// ============================================================

function requireRun(runId: string): JobRun {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  return run;
}

function requireWorkerSession(run: JobRun): string {
  if (!run.worker_session_id) {
    throw new Error(`Run ${run.id} has no worker session assigned`);
  }
  return run.worker_session_id;
}

function printMessages(messages: Array<Record<string, unknown>>): void {
  if (messages.length === 0) {
    console.log("No messages.");
    return;
  }
  for (const msg of messages) {
    const role = String(msg.role ?? msg.type ?? "?");
    const content = String(msg.content ?? msg.message ?? msg.text ?? "");
    const ts = msg.timestamp ?? msg.created_at ?? "";
    console.log(`[${ts}] ${role}: ${content.slice(0, 200)}`);
  }
}

// ============================================================
// Main
// ============================================================

async function run(): Promise<void> {
  const { args, urlInput, keyInput, asJson, help, botCrypto } = parseCommonFlags(Bun.argv.slice(2));
  const { positional, flags } = parseManagerFlags(args);

  const command = positional[0]?.toLowerCase() ?? "help";
  const runId = positional[1];

  if (help || command === "help") {
    console.log(USAGE);
    return;
  }

  const baseUrl = resolveBaseUrl(urlInput);

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (botCrypto) {
      return requestJsonBotCrypto<T>(baseUrl, method, path, body);
    }
    const { secretKey } = buildConfig(urlInput, keyInput);
    return requestJson<T>(baseUrl, secretKey, method, path, body);
  }

  switch (command) {
    case "goal": {
      if (!runId) throw new Error("goal requires <run-id>");
      const jobRun = requireRun(runId);
      if (asJson) {
        console.log(JSON.stringify({ id: jobRun.id, goal: jobRun.goal }, null, 2));
      } else {
        console.log(jobRun.goal ?? "(no goal set)");
      }
      break;
    }

    case "manager-goal": {
      if (!runId) throw new Error("manager-goal requires <run-id>");
      const jobRun = requireRun(runId);
      if (asJson) {
        console.log(JSON.stringify({ id: jobRun.id, manager_goal: jobRun.manager_goal }, null, 2));
      } else {
        console.log(jobRun.manager_goal ?? "(no manager goal set)");
      }
      break;
    }

    case "read-worker": {
      if (!runId) throw new Error("read-worker requires <run-id>");
      const jobRun = requireRun(runId);
      const sessionId = requireWorkerSession(jobRun);

      const payload = await req<{ messages?: Array<Record<string, unknown>> }>(
        "GET",
        `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      );
      const messages = Array.isArray(payload.messages)
        ? payload.messages
        : Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : [];

      const tail = messages.slice(-flags.lines);
      if (asJson) {
        console.log(JSON.stringify(tail, null, 2));
      } else {
        printMessages(tail);
      }
      break;
    }

    case "worker-history": {
      if (!runId) throw new Error("worker-history requires <run-id>");
      const jobRun = requireRun(runId);
      const sessionId = requireWorkerSession(jobRun);

      const payload = await req<{ messages?: Array<Record<string, unknown>> }>(
        "GET",
        `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      );
      const messages = Array.isArray(payload.messages)
        ? payload.messages
        : Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : [];

      if (asJson) {
        console.log(JSON.stringify(messages, null, 2));
      } else {
        printMessages(messages);
      }
      break;
    }

    case "message": {
      if (!runId) throw new Error("message requires <run-id> <text>");
      const text = positional.slice(2).join(" ");
      if (!text) throw new Error("message requires text after the run id");

      const jobRun = requireRun(runId);
      const sessionId = requireWorkerSession(jobRun);

      const payload = await req<Record<string, unknown>>(
        "POST",
        `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        { content: text },
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Sent to worker session ${sessionId.slice(0, 8)}`);
      }
      break;
    }

    case "complete": {
      if (!runId) throw new Error("complete requires <run-id>");
      const jobRun = requireRun(runId);
      const updated = updateRunStatus(jobRun.id, "complete", flags.summary);
      if (!updated) throw new Error(`Failed to update run: ${runId}`);

      if (asJson) {
        const refreshed = getRun(jobRun.id);
        console.log(JSON.stringify(refreshed, null, 2));
      } else {
        console.log(`Run ${runId} marked complete${flags.summary ? `: ${flags.summary}` : ""}`);
      }
      break;
    }

    case "fail": {
      if (!runId) throw new Error("fail requires <run-id>");
      const jobRun = requireRun(runId);
      const updated = updateRunStatus(jobRun.id, "failed", flags.reason);
      if (!updated) throw new Error(`Failed to update run: ${runId}`);

      if (asJson) {
        const refreshed = getRun(jobRun.id);
        console.log(JSON.stringify(refreshed, null, 2));
      } else {
        console.log(`Run ${runId} marked failed${flags.reason ? `: ${flags.reason}` : ""}`);
      }
      break;
    }

    default:
      throw new Error(`Unknown command: ${command}. Run with --help for usage.`);
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
