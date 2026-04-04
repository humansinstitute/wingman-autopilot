#!/usr/bin/env bun

/**
 * Wingman job definition CLI.
 *
 * Manages job definitions directly via the jobs-db SQLite store.
 *
 * Commands: list, show, create, update, delete
 */

import {
  listJobs,
  getJob,
  createJob,
  updateJob,
  deleteJob,
  type JobDefinition,
} from "../src/jobs-db";
import { isJobAgentType } from "../src/jobs/agent-config";

const USAGE = `Wingman job definition CLI

Usage:
  bun clis/jobs.ts <command> [id] [options]

Commands:
  list                 List all job definitions
  show <id>            Show full job definition
  create               Create a new job definition
  update <id>          Update fields on a job definition
  delete <id>          Delete a job definition

Create options (all required unless noted):
  --id <id>                    Job identifier
  --name <name>                Human-readable name
  --worker-prompt <prompt>     Worker agent prompt
  --manager-prompt <prompt>    Manager agent prompt
  --manager-goal <goal>        Manager goal description
  --worker-agent <agent>       Worker agent: codex|claude|goose|opencode|gemini
  --manager-agent <agent>      Manager agent: codex|claude|goose|opencode|gemini
  --manager-dir <dir>          Manager working directory
  --check-interval <secs>     Check interval in seconds (default: 300)
  --enabled <true|false>       Enable/disable (default: true)

Update options (provide one or more):
  --name <name>
  --worker-prompt <prompt>
  --manager-prompt <prompt>
  --manager-goal <goal>
  --worker-agent <agent>
  --manager-agent <agent>
  --manager-dir <dir>
  --check-interval <secs>
  --enabled <true|false>

Common options:
  --json                       Print raw JSON response
  -h, --help                   Show help

Examples:
  bun clis/jobs.ts list
  bun clis/jobs.ts show my-job
  bun clis/jobs.ts create --id my-job --name "My Job" --worker-prompt "do work" --manager-prompt "manage" --manager-goal "ship it" --manager-dir /tmp/project
  bun clis/jobs.ts update my-job --name "Renamed Job" --check-interval 600
  bun clis/jobs.ts delete my-job`;

// ============================================================
// Flag parsing
// ============================================================

interface ParsedFlags {
  positional: string[];
  id?: string;
  name?: string;
  workerPrompt?: string;
  managerPrompt?: string;
  managerGoal?: string;
  workerAgent?: string;
  managerAgent?: string;
  managerDir?: string;
  checkInterval?: number;
  enabled?: boolean;
  asJson: boolean;
  help: boolean;
}

function parseFlags(argv: string[]): ParsedFlags {
  const parsed: ParsedFlags = { positional: [], asJson: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    switch (token) {
      case '--id': {
        const v = argv[++i];
        if (!v) throw new Error('--id requires a value');
        parsed.id = v;
        break;
      }
      case '--name': {
        const v = argv[++i];
        if (!v) throw new Error('--name requires a value');
        parsed.name = v;
        break;
      }
      case '--worker-prompt': {
        const v = argv[++i];
        if (!v) throw new Error('--worker-prompt requires a value');
        parsed.workerPrompt = v;
        break;
      }
      case '--manager-prompt': {
        const v = argv[++i];
        if (!v) throw new Error('--manager-prompt requires a value');
        parsed.managerPrompt = v;
        break;
      }
      case '--manager-goal': {
        const v = argv[++i];
        if (!v) throw new Error('--manager-goal requires a value');
        parsed.managerGoal = v;
        break;
      }
      case '--worker-agent': {
        const v = argv[++i];
        if (!v) throw new Error('--worker-agent requires a value');
        if (!isJobAgentType(v.trim().toLowerCase())) {
          throw new Error('--worker-agent must be one of: codex, claude, goose, opencode, gemini');
        }
        parsed.workerAgent = v.trim().toLowerCase();
        break;
      }
      case '--manager-agent': {
        const v = argv[++i];
        if (!v) throw new Error('--manager-agent requires a value');
        if (!isJobAgentType(v.trim().toLowerCase())) {
          throw new Error('--manager-agent must be one of: codex, claude, goose, opencode, gemini');
        }
        parsed.managerAgent = v.trim().toLowerCase();
        break;
      }
      case '--manager-dir': {
        const v = argv[++i];
        if (!v) throw new Error('--manager-dir requires a value');
        parsed.managerDir = v;
        break;
      }
      case '--check-interval': {
        const v = argv[++i];
        if (!v) throw new Error('--check-interval requires a value');
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n < 0) throw new Error('--check-interval must be a non-negative integer');
        parsed.checkInterval = n;
        break;
      }
      case '--enabled': {
        const v = argv[++i]?.toLowerCase();
        if (v === 'true') parsed.enabled = true;
        else if (v === 'false') parsed.enabled = false;
        else throw new Error('--enabled must be true or false');
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

function printJobList(jobs: JobDefinition[]): void {
  if (jobs.length === 0) {
    console.log('No job definitions found.');
    return;
  }
  console.log('ID\tNAME\tWORKER\tMANAGER\tINTERVAL\tENABLED\tDIRECTORY');
  for (const job of jobs) {
    const enabled = job.enabled ? 'yes' : 'no';
    console.log(`${job.id}\t${job.name}\t${job.worker_agent}\t${job.manager_agent}\t${job.check_interval}s\t${enabled}\t${job.manager_dir}`);
  }
}

function printJobDetail(job: JobDefinition): void {
  console.log(`ID:              ${job.id}`);
  console.log(`Name:            ${job.name}`);
  console.log(`Enabled:         ${job.enabled ? 'yes' : 'no'}`);
  console.log(`Check Interval:  ${job.check_interval}s`);
  console.log(`Worker Agent:    ${job.worker_agent}`);
  console.log(`Manager Agent:   ${job.manager_agent}`);
  console.log(`Manager Dir:     ${job.manager_dir}`);
  console.log(`Manager Goal:    ${job.manager_goal}`);
  console.log(`Manager Prompt:  ${job.manager_prompt}`);
  console.log(`Worker Prompt:   ${job.worker_prompt}`);
  console.log(`Created:         ${job.created_at}`);
  console.log(`Updated:         ${job.updated_at}`);
}

// ============================================================
// Main
// ============================================================

function run(): void {
  const flags = parseFlags(Bun.argv.slice(2));
  const command = flags.positional[0]?.toLowerCase() ?? 'help';
  const positionalId = flags.positional[1];

  if (flags.help || command === 'help') {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case 'list': {
      const jobs = listJobs();
      if (flags.asJson) {
        console.log(JSON.stringify(jobs, null, 2));
      } else {
        printJobList(jobs);
      }
      break;
    }

    case 'show': {
      const id = positionalId;
      if (!id) throw new Error('show requires <id>');
      const job = getJob(id);
      if (!job) throw new Error(`Job not found: ${id}`);
      if (flags.asJson) {
        console.log(JSON.stringify(job, null, 2));
      } else {
        printJobDetail(job);
      }
      break;
    }

    case 'create': {
      const id = flags.id ?? positionalId;
      if (!id) throw new Error('create requires --id <id>');
      if (!flags.name) throw new Error('create requires --name <name>');
      if (flags.workerPrompt === undefined) throw new Error('create requires --worker-prompt <prompt>');
      if (flags.managerPrompt === undefined) throw new Error('create requires --manager-prompt <prompt>');
      if (flags.managerGoal === undefined) throw new Error('create requires --manager-goal <goal>');
      if (flags.managerDir === undefined) throw new Error('create requires --manager-dir <dir>');

      const existing = getJob(id);
      if (existing) throw new Error(`Job already exists: ${id}`);

      const job = createJob({
        id,
        name: flags.name,
        worker_prompt: flags.workerPrompt,
        manager_prompt: flags.managerPrompt,
        manager_goal: flags.managerGoal,
        worker_agent: flags.workerAgent as JobDefinition['worker_agent'] | undefined,
        manager_agent: flags.managerAgent as JobDefinition['manager_agent'] | undefined,
        manager_dir: flags.managerDir,
        check_interval: flags.checkInterval,
        enabled: flags.enabled,
      });

      if (flags.asJson) {
        console.log(JSON.stringify(job, null, 2));
      } else {
        console.log(`Created job: ${job.id}`);
      }
      break;
    }

    case 'update': {
      const id = positionalId;
      if (!id) throw new Error('update requires <id>');

      const updates: Record<string, unknown> = {};
      if (flags.name !== undefined) updates.name = flags.name;
      if (flags.workerPrompt !== undefined) updates.worker_prompt = flags.workerPrompt;
      if (flags.managerPrompt !== undefined) updates.manager_prompt = flags.managerPrompt;
      if (flags.managerGoal !== undefined) updates.manager_goal = flags.managerGoal;
      if (flags.workerAgent !== undefined) updates.worker_agent = flags.workerAgent as JobDefinition['worker_agent'];
      if (flags.managerAgent !== undefined) updates.manager_agent = flags.managerAgent as JobDefinition['manager_agent'];
      if (flags.managerDir !== undefined) updates.manager_dir = flags.managerDir;
      if (flags.checkInterval !== undefined) updates.check_interval = flags.checkInterval;
      if (flags.enabled !== undefined) updates.enabled = flags.enabled;

      if (Object.keys(updates).length === 0) {
        throw new Error('update requires at least one field to change');
      }

      const job = updateJob(id, updates);
      if (!job) throw new Error(`Job not found: ${id}`);

      if (flags.asJson) {
        console.log(JSON.stringify(job, null, 2));
      } else {
        console.log(`Updated job: ${job.id}`);
      }
      break;
    }

    case 'delete': {
      const id = positionalId;
      if (!id) throw new Error('delete requires <id>');
      const deleted = deleteJob(id);
      if (!deleted) throw new Error(`Job not found: ${id}`);
      console.log(`Deleted job: ${id}`);
      break;
    }

    default:
      throw new Error(`Unknown command: ${command}. Run with --help for usage.`);
  }
}

run();
