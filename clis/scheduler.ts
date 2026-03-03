#!/usr/bin/env bun

/**
 * Wingman scheduler trigger CLI (NIP-98 authenticated).
 *
 * Commands: list, create, update, delete, trigger, runs
 */

import { parseCommonFlags, buildConfig, requestJson } from './lib/auth';

type TriggerType = 'cron' | 'file_watcher' | 'nostr';

const USAGE = `Wingman scheduler trigger CLI (NIP-98)

Usage:
  bun clis/scheduler.ts <command> [id] [options]

Commands:
  list                       List triggers/jobs
  create                     Create a trigger/job
  update <id>                Update a trigger/job
  delete <id>                Delete a trigger/job
  trigger <id>               Manually run a trigger/job
  runs <id>                  List run history for a trigger/job

Required create options:
  --name <name>              Trigger name
  --agent <agent>            Agent: codex|claude|goose|opencode|gemini
  --working-directory <path> Working directory
  --prompt <text>            Initial prompt

Trigger options:
  --trigger-type <type>      cron|file_watcher|nostr (default: cron)
  --cron <expr>              Cron expression (required for cron create)
  --timezone <tz>            Timezone (default: UTC)
  --watch-directory <path>   Watch directory (required for file_watcher create)
  --file-pattern <glob>      File pattern for file_watcher (default: *)

Update options:
  --enabled <true|false>     Enable/disable trigger
  --nightwatchman <true|false> Enable/disable Nightwatchman

Common options:
  --url <url>                Wingman URL (env: WINGMAN_URL, default: http://localhost:3000)
  --key <nsec|hex>           Nostr private key (env: WINGMAN_NSEC)
  --json                     Print raw JSON response
  -h, --help                 Show help

Examples:
  bun clis/scheduler.ts list
  bun clis/scheduler.ts create --name "Daily build" --agent codex --working-directory /tmp/app --prompt "check repo" --trigger-type cron --cron "0 * * * *"
  bun clis/scheduler.ts update job_123 --enabled false
  bun clis/scheduler.ts delete job_123
  bun clis/scheduler.ts trigger job_123
  bun clis/scheduler.ts runs job_123`;

interface SchedulerJob {
  id?: string;
  name?: string;
  agent?: string;
  triggerType?: TriggerType;
  enabled?: boolean;
  cronExpression?: string | null;
  watchDirectory?: string | null;
  filePattern?: string | null;
  [key: string]: unknown;
}

interface SchedulerRun {
  id?: string;
  startedAt?: string;
  finishedAt?: string;
  status?: string;
  sessionId?: string;
  error?: string | null;
  [key: string]: unknown;
}

interface ParsedOptions {
  name?: string;
  agent?: string;
  workingDirectory?: string;
  prompt?: string;
  triggerType?: TriggerType;
  cronExpression?: string;
  timezone?: string;
  watchDirectory?: string;
  filePattern?: string;
  enabled?: boolean;
  nightwatchmanEnabled?: boolean;
  positional: string[];
}

function parseBooleanFlag(value: string | undefined, flagName: string): boolean {
  if (value === undefined) {
    throw new Error(`${flagName} requires a value: true or false`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${flagName} must be true or false`);
}

function parseSchedulerOptions(args: string[]): ParsedOptions {
  const parsed: ParsedOptions = { positional: [] };

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    switch (token) {
      case '--name': {
        const value = args[++i];
        if (!value) throw new Error('--name requires a value');
        parsed.name = value;
        break;
      }
      case '--agent': {
        const value = args[++i];
        if (!value) throw new Error('--agent requires a value');
        parsed.agent = value;
        break;
      }
      case '--working-directory':
      case '--directory': {
        const value = args[++i];
        if (!value) throw new Error(`${token} requires a value`);
        parsed.workingDirectory = value;
        break;
      }
      case '--prompt':
      case '--initial-prompt': {
        const value = args[++i];
        if (!value) throw new Error(`${token} requires a value`);
        parsed.prompt = value;
        break;
      }
      case '--trigger-type': {
        const value = args[++i];
        if (!value) throw new Error('--trigger-type requires a value');
        if (value === 'cron' || value === 'file_watcher' || value === 'nostr') {
          parsed.triggerType = value;
        } else {
          throw new Error('--trigger-type must be cron, file_watcher, or nostr');
        }
        break;
      }
      case '--cron':
      case '--cron-expression': {
        const value = args[++i];
        if (!value) throw new Error(`${token} requires a value`);
        parsed.cronExpression = value;
        break;
      }
      case '--timezone': {
        const value = args[++i];
        if (!value) throw new Error('--timezone requires a value');
        parsed.timezone = value;
        break;
      }
      case '--watch-directory': {
        const value = args[++i];
        if (!value) throw new Error('--watch-directory requires a value');
        parsed.watchDirectory = value;
        break;
      }
      case '--file-pattern': {
        const value = args[++i];
        if (!value) throw new Error('--file-pattern requires a value');
        parsed.filePattern = value;
        break;
      }
      case '--enabled': {
        parsed.enabled = parseBooleanFlag(args[++i], '--enabled');
        break;
      }
      case '--nightwatchman': {
        parsed.nightwatchmanEnabled = parseBooleanFlag(args[++i], '--nightwatchman');
        break;
      }
      default:
        parsed.positional.push(token);
    }
  }

  return parsed;
}

function printJobList(jobs: SchedulerJob[]): void {
  if (jobs.length === 0) {
    console.log('No triggers found.');
    return;
  }

  console.log('ID\tNAME\tAGENT\tTYPE\tENABLED\tSCHEDULE');
  for (const job of jobs) {
    const id = String(job.id ?? '').slice(0, 8);
    const name = String(job.name ?? '-');
    const agent = String(job.agent ?? '-');
    const type = String(job.triggerType ?? 'cron');
    const enabled = job.enabled === false ? 'no' : 'yes';

    let schedule = '-';
    if (type === 'cron') schedule = String(job.cronExpression ?? '-');
    if (type === 'file_watcher') {
      const watchDir = String(job.watchDirectory ?? '-');
      const pattern = String(job.filePattern ?? '*');
      schedule = `${watchDir} (${pattern})`;
    }

    console.log(`${id}\t${name}\t${agent}\t${type}\t${enabled}\t${schedule}`);
  }
}

function printRunList(runs: SchedulerRun[]): void {
  if (runs.length === 0) {
    console.log('No runs found.');
    return;
  }

  console.log('ID\tSTATUS\tSTARTED\tFINISHED\tSESSION\tERROR');
  for (const run of runs) {
    const id = String(run.id ?? '').slice(0, 8);
    const status = String(run.status ?? '-');
    const started = String(run.startedAt ?? '-');
    const finished = String(run.finishedAt ?? '-');
    const session = String(run.sessionId ?? '-').slice(0, 8);
    const error = String(run.error ?? '-');
    console.log(`${id}\t${status}\t${started}\t${finished}\t${session}\t${error}`);
  }
}

function buildCreatePayload(options: ParsedOptions): Record<string, unknown> {
  const name = options.name?.trim();
  const agent = options.agent?.trim();
  const workingDirectory = options.workingDirectory?.trim();
  const initialPrompt = options.prompt?.trim();

  if (!name) throw new Error('create requires --name <name>');
  if (!agent) throw new Error('create requires --agent <agent>');
  if (!workingDirectory) throw new Error('create requires --working-directory <path>');
  if (!initialPrompt) throw new Error('create requires --prompt <text>');

  const triggerType = options.triggerType ?? 'cron';
  if (triggerType === 'cron' && !options.cronExpression) {
    throw new Error('create requires --cron <expr> when --trigger-type cron');
  }
  if (triggerType === 'file_watcher' && !options.watchDirectory) {
    throw new Error('create requires --watch-directory <path> when --trigger-type file_watcher');
  }

  const payload: Record<string, unknown> = {
    name,
    agent,
    workingDirectory,
    initialPrompt,
    triggerType,
  };

  if (options.cronExpression) payload.cronExpression = options.cronExpression;
  if (options.timezone) payload.timezone = options.timezone;
  if (options.watchDirectory) payload.watchDirectory = options.watchDirectory;
  if (options.filePattern) payload.filePattern = options.filePattern;
  if (options.enabled !== undefined) payload.enabled = options.enabled;
  if (options.nightwatchmanEnabled !== undefined) {
    payload.nightwatchmanEnabled = options.nightwatchmanEnabled;
  }

  return payload;
}

function buildUpdatePayload(options: ParsedOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if (options.name !== undefined) payload.name = options.name;
  if (options.agent !== undefined) payload.agent = options.agent;
  if (options.workingDirectory !== undefined) payload.workingDirectory = options.workingDirectory;
  if (options.prompt !== undefined) payload.initialPrompt = options.prompt;
  if (options.triggerType !== undefined) payload.triggerType = options.triggerType;
  if (options.cronExpression !== undefined) payload.cronExpression = options.cronExpression;
  if (options.timezone !== undefined) payload.timezone = options.timezone;
  if (options.watchDirectory !== undefined) payload.watchDirectory = options.watchDirectory;
  if (options.filePattern !== undefined) payload.filePattern = options.filePattern;
  if (options.enabled !== undefined) payload.enabled = options.enabled;
  if (options.nightwatchmanEnabled !== undefined) {
    payload.nightwatchmanEnabled = options.nightwatchmanEnabled;
  }

  if (Object.keys(payload).length === 0) {
    throw new Error('update requires at least one field to change');
  }

  return payload;
}

async function run(): Promise<void> {
  const { args, urlInput, keyInput, asJson, help } = parseCommonFlags(Bun.argv.slice(2));
  const options = parseSchedulerOptions(args);

  const command = options.positional[0]?.toLowerCase() ?? 'help';
  const id = options.positional[1];

  if (help || command === 'help') {
    console.log(USAGE);
    return;
  }

  const { baseUrl, secretKey } = buildConfig(urlInput, keyInput);

  switch (command) {
    case 'list': {
      const payload = await requestJson<{ jobs?: SchedulerJob[] }>(
        baseUrl,
        secretKey,
        'GET',
        '/api/scheduler/jobs',
      );
      const jobs = Array.isArray(payload.jobs)
        ? payload.jobs
        : Array.isArray(payload)
          ? (payload as unknown as SchedulerJob[])
          : [];

      if (asJson) {
        console.log(JSON.stringify(jobs, null, 2));
      } else {
        printJobList(jobs);
      }
      break;
    }

    case 'create': {
      const payload = await requestJson<Record<string, unknown>>(
        baseUrl,
        secretKey,
        'POST',
        '/api/scheduler/jobs',
        buildCreatePayload(options),
      );

      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const job = (payload.job ?? payload) as Record<string, unknown>;
        console.log(`Created trigger: ${String(job.id ?? '?')}`);
      }
      break;
    }

    case 'update': {
      if (!id) throw new Error('update requires <id>');

      const payload = await requestJson<Record<string, unknown>>(
        baseUrl,
        secretKey,
        'PATCH',
        `/api/scheduler/jobs/${encodeURIComponent(id)}`,
        buildUpdatePayload(options),
      );

      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const job = (payload.job ?? payload) as Record<string, unknown>;
        console.log(`Updated trigger: ${String(job.id ?? id)}`);
      }
      break;
    }

    case 'delete': {
      if (!id) throw new Error('delete requires <id>');
      await requestJson(baseUrl, secretKey, 'DELETE', `/api/scheduler/jobs/${encodeURIComponent(id)}`);
      console.log(`Deleted trigger: ${id}`);
      break;
    }

    case 'trigger': {
      if (!id) throw new Error('trigger requires <id>');
      const payload = await requestJson<Record<string, unknown>>(
        baseUrl,
        secretKey,
        'POST',
        `/api/scheduler/jobs/${encodeURIComponent(id)}/trigger`,
      );

      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Triggered: ${id} (session ${String(payload.sessionId ?? '?')})`);
      }
      break;
    }

    case 'runs': {
      if (!id) throw new Error('runs requires <id>');
      const payload = await requestJson<{ runs?: SchedulerRun[] }>(
        baseUrl,
        secretKey,
        'GET',
        `/api/scheduler/jobs/${encodeURIComponent(id)}/runs`,
      );

      const runs = Array.isArray(payload.runs)
        ? payload.runs
        : Array.isArray(payload)
          ? (payload as unknown as SchedulerRun[])
          : [];

      if (asJson) {
        console.log(JSON.stringify(runs, null, 2));
      } else {
        printRunList(runs);
      }
      break;
    }

    default:
      throw new Error(`Unknown command: ${command}. Run with --help for usage.`);
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
