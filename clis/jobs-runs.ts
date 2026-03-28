#!/usr/bin/env bun

/**
 * Wingman job runs CLI.
 *
 * Manages job runs directly via the jobs-db SQLite store.
 *
 * Commands: list, show, stop
 */

import {
  listRuns,
  getRun,
  updateRunStatus,
  type JobRun,
} from "../src/jobs-db";

const USAGE = `Wingman job runs CLI

Usage:
  bun clis/jobs-runs.ts <command> [id] [options]

Commands:
  list                 List all job runs
  show <id>            Show full run details
  stop <id>            Stop worker & manager sessions, mark run as stopped

Options:
  --job <id>           Filter runs by job definition ID (list only)
  --status <status>    Filter runs by status (list only)
  --json               Print raw JSON response
  -h, --help           Show help

Examples:
  bun clis/jobs-runs.ts list
  bun clis/jobs-runs.ts list --job my-job --status running
  bun clis/jobs-runs.ts show abc-123
  bun clis/jobs-runs.ts stop abc-123`;

// ============================================================
// Flag parsing
// ============================================================

interface ParsedFlags {
  positional: string[];
  job?: string;
  status?: string;
  asJson: boolean;
  help: boolean;
}

function parseFlags(argv: string[]): ParsedFlags {
  const parsed: ParsedFlags = { positional: [], asJson: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    switch (token) {
      case '--job': {
        const v = argv[++i];
        if (!v) throw new Error('--job requires a value');
        parsed.job = v;
        break;
      }
      case '--status': {
        const v = argv[++i];
        if (!v) throw new Error('--status requires a value');
        parsed.status = v;
        break;
      }
      case '--json':
        parsed.asJson = true;
        break;
      case '-h':
      case '--help':
        parsed.help = true;
        break;
      default:
        parsed.positional.push(token);
    }
  }

  return parsed;
}

// ============================================================
// Display helpers
// ============================================================

function snippet(text: string | null, maxLen = 40): string {
  if (!text) return '-';
  const oneLine = text.replace(/\n/g, ' ').trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '...' : oneLine;
}

function printRunList(runs: JobRun[]): void {
  if (runs.length === 0) {
    console.log('No job runs found.');
    return;
  }
  console.log('ID\tJOB_ID\tSTATUS\tGOAL\tCREATED');
  for (const r of runs) {
    const id = r.id.slice(0, 8);
    const jobId = r.job_id.slice(0, 12);
    console.log(`${id}\t${jobId}\t${r.status}\t${snippet(r.goal)}\t${r.created_at}`);
  }
}

function printRunDetail(run: JobRun): void {
  console.log(`ID:                 ${run.id}`);
  console.log(`Job ID:             ${run.job_id}`);
  console.log(`Status:             ${run.status}`);
  console.log(`Goal:               ${run.goal ?? '-'}`);
  console.log(`Manager Goal:       ${run.manager_goal ?? '-'}`);
  console.log(`Worker Session:     ${run.worker_session_id ?? '-'}`);
  console.log(`Manager Session:    ${run.manager_session_id ?? '-'}`);
  console.log(`Worker Dir:         ${run.worker_dir ?? '-'}`);
  console.log(`Manager Dir:        ${run.manager_dir ?? '-'}`);
  if (run.refs_json) {
    try {
      const refs = JSON.parse(run.refs_json);
      console.log(`Refs:               ${JSON.stringify(refs)}`);
    } catch {
      console.log(`Refs (raw):         ${run.refs_json}`);
    }
  }
  console.log(`Output Summary:     ${run.output_summary ?? '-'}`);
  console.log(`Created:            ${run.created_at}`);
  console.log(`Updated:            ${run.updated_at}`);
}

// ============================================================
// Session stop helper
// ============================================================

async function stopSession(sessionId: string): Promise<boolean> {
  const sessionsCliPath = new URL('./sessions.ts', import.meta.url).pathname;
  const proc = Bun.spawn(['bun', sessionsCliPath, 'stop', sessionId], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(`  Warning: failed to stop session ${sessionId.slice(0, 8)}: ${stderr.trim()}`);
    return false;
  }
  const stdout = await new Response(proc.stdout).text();
  console.log(`  ${stdout.trim()}`);
  return true;
}

// ============================================================
// Main
// ============================================================

async function run(): Promise<void> {
  const flags = parseFlags(Bun.argv.slice(2));
  const command = flags.positional[0]?.toLowerCase() ?? 'help';
  const positionalId = flags.positional[1];

  if (flags.help || command === 'help') {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case 'list': {
      const runs = listRuns(flags.job, flags.status);
      if (flags.asJson) {
        console.log(JSON.stringify(runs, null, 2));
      } else {
        printRunList(runs);
      }
      break;
    }

    case 'show': {
      const id = positionalId;
      if (!id) throw new Error('show requires <id>');
      const run = getRun(id);
      if (!run) throw new Error(`Run not found: ${id}`);
      if (flags.asJson) {
        console.log(JSON.stringify(run, null, 2));
      } else {
        printRunDetail(run);
      }
      break;
    }

    case 'stop': {
      const id = positionalId;
      if (!id) throw new Error('stop requires <id>');
      const jobRun = getRun(id);
      if (!jobRun) throw new Error(`Run not found: ${id}`);

      if (jobRun.status === 'stopped' || jobRun.status === 'complete' || jobRun.status === 'failed') {
        console.log(`Run ${id.slice(0, 8)} is already ${jobRun.status}.`);
        break;
      }

      console.log(`Stopping run ${id.slice(0, 8)}...`);
      let anyFailed = false;

      if (jobRun.worker_session_id) {
        console.log(`  Stopping worker session ${jobRun.worker_session_id.slice(0, 8)}...`);
        const ok = await stopSession(jobRun.worker_session_id);
        if (!ok) anyFailed = true;
      }

      if (jobRun.manager_session_id) {
        console.log(`  Stopping manager session ${jobRun.manager_session_id.slice(0, 8)}...`);
        const ok = await stopSession(jobRun.manager_session_id);
        if (!ok) anyFailed = true;
      }

      if (anyFailed) {
        throw new Error(`Failed to stop one or more sessions for run ${id.slice(0, 8)}. Run NOT marked as stopped.`);
      }

      updateRunStatus(id, 'stopped');
      console.log(`Run ${id.slice(0, 8)} marked as stopped.`);
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
