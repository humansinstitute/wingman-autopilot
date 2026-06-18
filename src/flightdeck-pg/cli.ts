import { readFileSync } from 'node:fs';

import { resolveSecretKey } from '../../clis/lib/auth';
import { FlightDeckPgClient, MissingFlightDeckPgRouteError, resolveFlightDeckPgConfig } from './client';

export interface FlightDeckPgCliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

type FlagMap = Map<string, string | boolean>;

export async function runFlightDeckPgCli(argv: string[], io: {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  fetchImpl?: typeof fetch;
} = {}): Promise<FlightDeckPgCliResult> {
  try {
    const parsed = parseFlags(argv);
    const flags = parsed.flags;
    const client = new FlightDeckPgClient(resolveFlightDeckPgConfig({
      towerUrl: stringFlag(flags, '--tower-url'),
      wingmanUrl: stringFlag(flags, '--url'),
      appNpub: stringFlag(flags, '--app-npub'),
      secretKey: resolveSecretKey(stringFlag(flags, '--key') ?? undefined),
      sessionId: stringFlag(flags, '--session-id') ?? undefined,
      fetchImpl: io.fetchImpl,
    }));
    const result = await dispatch(client, parsed.positionals, flags);
    const text = formatOutput(result, flags.has('--json'));
    io.stdout?.(text);
    return { exitCode: 0, stdout: text };
  } catch (error) {
    const payload = serializeError(error);
    const text = JSON.stringify(payload, null, 2);
    io.stderr?.(text);
    return { exitCode: 1, stderr: text };
  }
}

async function dispatch(client: FlightDeckPgClient, args: string[], flags: FlagMap): Promise<unknown> {
  const [area, action, id] = args;
  if (!area || area === 'help') return usageText();
  const limit = optionalNumber(flags, '--limit');

  if (area === 'context') return await client.context();
  if (area === 'status') return await client.status();
  if (area === 'workspaces' && action === 'list') return await client.listWorkspaces();
  if (area === 'workspace' && action === 'show') return await client.showWorkspace(requiredArg(id, 'workspace id'));
  if (area === 'workspace' && action === 'me') return await client.workspaceMe(requiredArg(id, 'workspace id'));

  const workspaceId = requiredValue(flags, '--workspace', 'workspace id');
  if (area === 'scopes' && action === 'list') return await client.listScopes(workspaceId);
  if (area === 'scope' && action === 'show') return await client.showScope(workspaceId, requiredArg(id, 'scope id'));
  if (area === 'channels' && action === 'list') return await client.listChannels(workspaceId, requiredValue(flags, '--scope', 'scope id'), limit);
  if (area === 'channel' && action === 'show') return await client.showChannel(workspaceId, requiredArg(id, 'channel id'));
  if (area === 'threads' && action === 'list') return await client.listThreads(workspaceId, requiredValue(flags, '--channel', 'channel id'), limit);
  if (area === 'thread' && action === 'read') return await client.readThread(workspaceId, requiredValue(flags, '--channel', 'channel id'), requiredArg(id, 'thread id'), limit);
  if (area === 'chat' && action === 'reply') return await client.reply(workspaceId, requiredValue(flags, '--channel', 'channel id'), requiredValue(flags, '--thread', 'thread id'), requiredValue(flags, '--body', 'body'));
  if (area === 'tasks' && action === 'list') return await client.listTasks(workspaceId, {
    channelId: stringFlag(flags, '--channel'),
    scopeId: stringFlag(flags, '--scope'),
    limit,
  });
  if (area === 'task' && action === 'show') return await client.showTask(workspaceId, requiredArg(id, 'task id'));
  if (area === 'task' && action === 'create') return await client.createTask(workspaceId, requiredValue(flags, '--channel', 'channel id'), {
    title: requiredValue(flags, '--title', 'title'),
    description: stringFlag(flags, '--body') ?? stringFlag(flags, '--description'),
    state: stringFlag(flags, '--state') ?? undefined,
    priority: stringFlag(flags, '--priority') ?? undefined,
    threadId: stringFlag(flags, '--thread'),
  });
  if (area === 'task' && action === 'patch') return await client.patchTask(workspaceId, requiredArg(id, 'task id'), readJsonFile(requiredValue(flags, '--json-file', 'json file')));
  if (area === 'task' && action === 'state') return await client.updateTaskState(workspaceId, requiredArg(id, 'task id'), requiredValue(flags, '--state', 'state'));
  if (area === 'task' && action === 'comments') return await client.listTaskComments(workspaceId, requiredArg(id, 'task id'), limit);
  if (area === 'task' && action === 'comment') return await client.commentTask(workspaceId, requiredArg(id, 'task id'), requiredValue(flags, '--body', 'body'), stringFlag(flags, '--thread'));
  if (area === 'task' && action === 'assign') return await client.assignTask(workspaceId, requiredArg(id, 'task id'), requiredValue(flags, '--agent', 'agent actor id'));
  if (area === 'docs' && action === 'list') return await client.listDocs(workspaceId, requiredValue(flags, '--channel', 'channel id'), limit);
  if (area === 'doc' && action === 'create') return await client.createDoc(workspaceId, requiredValue(flags, '--channel', 'channel id'), requiredValue(flags, '--title', 'title'), readTextFile(requiredValue(flags, '--body-file', 'body file')));
  if (area === 'doc' && action === 'show') return await client.showDoc(workspaceId, requiredArg(id, 'doc id'), flags.has('--body'));
  if (area === 'doc' && action === 'update') return await client.updateDoc(workspaceId, requiredArg(id, 'doc id'), readTextFile(requiredValue(flags, '--body-file', 'body file')));
  if (area === 'doc' && action === 'comments') return await client.listDocComments(workspaceId, requiredArg(id, 'doc id'), limit);
  if (area === 'doc' && action === 'reply') return await client.replyDoc(workspaceId, requiredArg(id, 'doc id'), requiredValue(flags, '--body', 'body'), stringFlag(flags, '--comment'));
  if (area === 'files' && action === 'list') return await client.listFiles(workspaceId, requiredValue(flags, '--channel', 'channel id'), limit);
  if (area === 'file' && action === 'upload') return await client.uploadFile(workspaceId, requiredValue(flags, '--channel', 'channel id'), requiredValue(flags, '--path', 'path'), stringFlag(flags, '--content-type'));
  if (area === 'file' && action === 'show') return await client.showFile(workspaceId, requiredArg(id, 'file id'), flags.has('--object'));
  if (area === 'audio' && action === 'create') return await client.createAudio(workspaceId, requiredValue(flags, '--channel', 'channel id'), requiredValue(flags, '--file', 'file'), stringFlag(flags, '--content-type'));
  if (area === 'reactions' && action === 'create') return await client.createReaction(workspaceId, requiredValue(flags, '--target', 'target'), requiredValue(flags, '--emoji', 'emoji'));
  if (area === 'events' && action === 'poll') return await client.pollEvents(workspaceId, stringFlag(flags, '--since'), limit);
  if (area === 'members' && action === 'list') return await client.listMembers(workspaceId);
  throw new Error(`Unknown flightdeck command: ${[area, action, id].filter(Boolean).join(' ')}`);
}

function parseFlags(argv: string[]): { positionals: string[]; flags: FlagMap } {
  const flags: FlagMap = new Map();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.set(arg, true);
      continue;
    }
    flags.set(arg, next);
    index += 1;
  }
  return { positionals, flags };
}

function stringFlag(flags: FlagMap, name: string): string | null {
  const value = flags.get(name);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requiredValue(flags: FlagMap, name: string, label: string): string {
  const value = stringFlag(flags, name);
  if (!value) throw new Error(`Missing required ${label}. Pass ${name}.`);
  return value;
}

function requiredArg(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing required ${label}.`);
  return value;
}

function optionalNumber(flags: FlagMap, name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function readJsonFile(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readTextFile(path)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} must contain a JSON object.`);
  return parsed as Record<string, unknown>;
}

function readTextFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function formatOutput(result: unknown, json: boolean): string {
  if (json || typeof result !== 'string') return JSON.stringify(result, null, 2);
  return result;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof MissingFlightDeckPgRouteError) {
    return { ok: false, error: error.message, missingRoute: error.routeGap };
  }
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function usageText(): string {
  return `Wingman Flight Deck PG CLI

Usage:
  bun clis/wingman.ts flightdeck context --json
  bun clis/wingman.ts flightdeck status --json
  bun clis/wingman.ts flightdeck workspaces list --json
  bun clis/wingman.ts flightdeck tasks list --workspace <workspace-id> --channel <channel-id> --json
  bun clis/wingman.ts flightdeck task show <task-id> --workspace <workspace-id> --json
  bun clis/wingman.ts flightdeck task comment <task-id> --workspace <workspace-id> --body "..." --json
  bun clis/wingman.ts flightdeck task state <task-id> --workspace <workspace-id> --state in_progress --json
  bun clis/wingman.ts flightdeck thread read <thread-id> --workspace <workspace-id> --channel <channel-id> --json
  bun clis/wingman.ts flightdeck chat reply --workspace <workspace-id> --channel <channel-id> --thread <thread-id> --body "..." --json
  bun clis/wingman.ts flightdeck doc create --workspace <workspace-id> --channel <channel-id> --title "..." --body-file file.md --json
  bun clis/wingman.ts flightdeck file upload --workspace <workspace-id> --channel <channel-id> --path ./artifact.png --json`;
}
