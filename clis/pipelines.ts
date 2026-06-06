#!/usr/bin/env bun

import { parseCommonFlags, buildConfig, requestJson, requestJsonBotCrypto, resolveBaseUrl } from './lib/auth';

const USAGE = `Wingman pipelines CLI (NIP-98)

Usage:
  bun clis/pipelines.ts <command> [run-id] [options]

Commands:
  runs | list                List pipeline runs
  show <run-id>              Show a pipeline run with payloads
  steps <run-id>             List steps for a pipeline run
  resume <run-id>            Resume an errored run from its failed step

Common options:
  --url <url>                Wingman URL (env: WINGMAN_URL, default: http://localhost:3000)
  --key <nsec|hex>           Nostr private key (env: WINGMAN_NSEC)
  --bot-crypto               Sign via bot-crypto API (for agent sessions)
  --json                     Print raw JSON response
  -h, --help                 Show help

Examples:
  bun clis/pipelines.ts runs --bot-crypto
  bun clis/pipelines.ts show <run-id> --bot-crypto
  bun clis/pipelines.ts resume <run-id> --bot-crypto`;

interface PipelineRun {
  id?: string;
  name?: string;
  status?: string;
  definitionSlug?: string | null;
  definitionId?: string | null;
  cursorIndex?: number;
  startedAt?: string;
  completedAt?: string | null;
  error?: string | null;
  [key: string]: unknown;
}

interface PipelineStep {
  id?: string;
  stepIndex?: number;
  name?: string;
  kind?: string;
  status?: string;
  wingmanSessionId?: string | null;
  error?: string | null;
  [key: string]: unknown;
}

function printRunList(runs: PipelineRun[]): void {
  if (runs.length === 0) {
    console.log('No pipeline runs found.');
    return;
  }
  console.log('ID\tSTATUS\tCURSOR\tSTARTED\tDEFINITION\tNAME\tERROR');
  for (const run of runs) {
    const id = String(run.id ?? '').slice(0, 8);
    const status = String(run.status ?? '-');
    const cursor = String(run.cursorIndex ?? '-');
    const started = String(run.startedAt ?? '-');
    const definition = String(run.definitionSlug ?? run.definitionId ?? '-');
    const name = String(run.name ?? '-');
    const error = String(run.error ?? '-');
    console.log(`${id}\t${status}\t${cursor}\t${started}\t${definition}\t${name}\t${error}`);
  }
}

function printStepList(steps: PipelineStep[]): void {
  if (steps.length === 0) {
    console.log('No pipeline steps found.');
    return;
  }
  console.log('INDEX\tID\tSTATUS\tKIND\tSESSION\tNAME\tERROR');
  for (const step of steps) {
    const index = String(step.stepIndex ?? '-');
    const id = String(step.id ?? '').slice(0, 8);
    const status = String(step.status ?? '-');
    const kind = String(step.kind ?? '-');
    const session = String(step.wingmanSessionId ?? '-').slice(0, 8);
    const name = String(step.name ?? '-');
    const error = String(step.error ?? '-');
    console.log(`${index}\t${id}\t${status}\t${kind}\t${session}\t${name}\t${error}`);
  }
}

async function run(): Promise<void> {
  const { args, urlInput, keyInput, asJson, help, botCrypto } = parseCommonFlags(Bun.argv.slice(2));
  const command = args[0]?.toLowerCase() ?? 'help';
  const id = args[1];

  if (help || command === 'help') {
    console.log(USAGE);
    return;
  }

  const baseUrl = resolveBaseUrl(urlInput);
  const config = botCrypto ? null : buildConfig(urlInput, keyInput);
  const req = <T>(method: string, path: string, body?: unknown): Promise<T> => botCrypto
    ? requestJsonBotCrypto<T>(baseUrl, method, path, body)
    : requestJson<T>(config!.baseUrl, config!.secretKey, method, path, body);

  switch (command) {
    case 'runs':
    case 'list': {
      const payload = await req<{ runs?: PipelineRun[] }>('GET', '/api/pipelines/runs');
      const runs = Array.isArray(payload.runs) ? payload.runs : [];
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printRunList(runs);
      }
      break;
    }

    case 'show': {
      if (!id) throw new Error('show requires <run-id>');
      const payload = await req<Record<string, unknown>>(
        'GET',
        `/api/pipelines/runs/${encodeURIComponent(id)}?includeRunPayload=1&includePayload=1`,
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const run = (payload.run ?? {}) as PipelineRun;
        console.log(`${String(run.id ?? id)}\t${String(run.status ?? '-')}\t${String(run.name ?? '-')}`);
        if (run.error) console.log(`Error: ${run.error}`);
        printStepList(Array.isArray(payload.steps) ? payload.steps as PipelineStep[] : []);
      }
      break;
    }

    case 'steps': {
      if (!id) throw new Error('steps requires <run-id>');
      const payload = await req<{ steps?: PipelineStep[] }>(
        'GET',
        `/api/pipelines/runs/${encodeURIComponent(id)}/steps`,
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printStepList(Array.isArray(payload.steps) ? payload.steps : []);
      }
      break;
    }

    case 'resume': {
      if (!id) throw new Error('resume requires <run-id>');
      const payload = await req<Record<string, unknown>>(
        'POST',
        `/api/pipelines/runs/${encodeURIComponent(id)}/resume-from-failure`,
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const run = (payload.run ?? {}) as PipelineRun;
        console.log(`Resumed pipeline run: ${String(run.id ?? id)} (${String(run.status ?? 'running')})`);
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
