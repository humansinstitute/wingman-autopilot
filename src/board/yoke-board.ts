import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

import {
  continueFlowAfterApproval,
  continueFlowAfterTaskReview,
  instantiateFlowRun,
  normaliseFlowRecord,
  type BoardApprovalRecord,
  type BoardFlowRecord,
  type BoardTaskCreateInput,
  type BoardTaskRecord,
  type FlowBoard,
} from './flow-orchestration';

const YOKE_CLI_PATH = new URL('../../../wingmanbefree/wingman-yoke/src/cli.js', import.meta.url).pathname;
const EXPORT_BOT_KEY_CLI = new URL('../../clis/export-bot-key.ts', import.meta.url).pathname;
const DEFAULT_CONFIG_RELATIVE_PATH = join('.wingmen', 'board.json');

export interface RepoBoardConfig {
  backendBaseUrl: string;
  workspaceOwnerNpub: string;
  sourceAppNpub: string;
  stateDir?: string | null;
}

export interface RepoBoardConfigWithPaths extends RepoBoardConfig {
  repoRoot: string;
  configPath: string;
  stateDir: string;
}

function compactText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function compactStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => compactText(entry)).filter(Boolean)
    : [];
}

function compactStringArrayMaybeJson(value: unknown): string[] {
  if (Array.isArray(value)) {
    return compactStringArray(value);
  }
  const text = compactText(value);
  if (!text) {
    return [];
  }
  if (text.startsWith('[')) {
    try {
      return compactStringArray(JSON.parse(text));
    } catch {
      return [];
    }
  }
  return text.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function compactReferenceArrayMaybeJson(value: unknown): Array<{ type: string; id: string }> {
  const parsed = (() => {
    if (Array.isArray(value)) {
      return value;
    }
    const text = compactText(value);
    if (!text.startsWith('[')) {
      return [];
    }
    try {
      const decoded = JSON.parse(text);
      return Array.isArray(decoded) ? decoded : [];
    } catch {
      return [];
    }
  })();
  const seen = new Set<string>();
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const type = compactText((entry as Record<string, unknown>).type);
    const id = compactText((entry as Record<string, unknown>).id);
    if (!type || !id) {
      return [];
    }
    const key = `${type}:${id}`;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ type, id }];
  });
}

function normaliseStateDir(repoRoot: string, config: RepoBoardConfig): string {
  const configured = compactText(config.stateDir);
  return configured
    ? resolve(repoRoot, configured)
    : join(repoRoot, '.wingmen', 'board-state');
}

function parseJsonOutput<T>(output: string): T {
  return JSON.parse(output) as T;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveNodeBinary(): string {
  return Bun.which('node') ?? process.execPath;
}

export function resolveBoardConfigPath(startDir = process.cwd()): string | null {
  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, DEFAULT_CONFIG_RELATIVE_PATH);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function loadRepoBoardConfig(startDir = process.cwd()): RepoBoardConfigWithPaths {
  const configPath = resolveBoardConfigPath(startDir);
  if (!configPath) {
    throw new Error('Board config not found. Run `bun clis/wingman.ts init ...` in the repo first.');
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as RepoBoardConfig;
  const repoRoot = dirname(dirname(configPath));
  return {
    backendBaseUrl: compactText(raw.backendBaseUrl),
    workspaceOwnerNpub: compactText(raw.workspaceOwnerNpub),
    sourceAppNpub: compactText(raw.sourceAppNpub),
    stateDir: normaliseStateDir(repoRoot, raw),
    repoRoot,
    configPath,
  };
}

export function saveRepoBoardConfig(repoRoot: string, input: RepoBoardConfig): RepoBoardConfigWithPaths {
  const configPath = join(repoRoot, DEFAULT_CONFIG_RELATIVE_PATH);
  mkdirSync(dirname(configPath), { recursive: true });
  const next = {
    backendBaseUrl: compactText(input.backendBaseUrl),
    workspaceOwnerNpub: compactText(input.workspaceOwnerNpub),
    sourceAppNpub: compactText(input.sourceAppNpub),
    stateDir: compactText(input.stateDir),
  };
  writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
  return {
    ...next,
    repoRoot,
    configPath,
    stateDir: normaliseStateDir(repoRoot, next),
  };
}

export function resolveAgentSigningKey(): string {
  const existing = compactText(process.env.WINGMAN_YOKE_NSEC)
    || compactText(process.env.WINGMAN_NSEC)
    || compactText(process.env.NOSTR_NSEC);
  if (existing) {
    return existing;
  }
  if (!compactText(process.env.SESSION_ID)) {
    throw new Error('Missing signing key. Set WINGMAN_NSEC or run inside an active Wingman session.');
  }
  const result = Bun.spawnSync(['bun', EXPORT_BOT_KEY_CLI, '--hex'], {
    cwd: dirname(dirname(EXPORT_BOT_KEY_CLI)),
    stdout: 'pipe',
    stderr: 'pipe',
    env: Bun.env,
  });
  if (result.exitCode !== 0) {
    const detail = Buffer.from(result.stderr).toString('utf8').trim() || 'Key export failed.';
    throw new Error(detail);
  }
  const output = Buffer.from(result.stdout).toString('utf8').trim();
  if (!output) {
    throw new Error('Key export returned an empty signing key.');
  }
  return output;
}

function buildConnectionToken(config: RepoBoardConfigWithPaths): string {
  return Buffer.from(JSON.stringify({
    type: 'superbased_connection',
    direct_https_url: config.backendBaseUrl,
    workspace_owner_npub: config.workspaceOwnerNpub,
    app_npub: config.sourceAppNpub,
  })).toString('base64');
}

function parseTaskRecord(raw: Record<string, unknown>): BoardTaskRecord {
  return {
    taskId: compactText(raw.record_id),
    title: compactText(raw.title),
    description: compactText(raw.description),
    state: compactText(raw.state) || null,
    assignedTo: compactText(raw.assigned_to_npub) || null,
    parentTaskId: compactText(raw.parent_task_id) || null,
    flowId: compactText(raw.flow_id) || null,
    flowRunId: compactText(raw.flow_run_id) || null,
    flowStep: Number.isFinite(Number(raw.flow_step)) ? Number(raw.flow_step) : null,
    predecessorTaskIds: compactStringArray(raw.predecessor_task_ids),
    scopeId: compactText(raw.scope_id) || null,
    scopeLineage: [
      compactText(raw.scope_l1_id) || null,
      compactText(raw.scope_l2_id) || null,
      compactText(raw.scope_l3_id) || null,
      compactText(raw.scope_l4_id) || null,
      compactText(raw.scope_l5_id) || null,
    ],
    references: compactReferenceArrayMaybeJson(raw.references ?? raw.references_json),
    tags: compactText(raw.tags)
      ? compactText(raw.tags).split(',').map((entry) => entry.trim()).filter(Boolean)
      : [],
  };
}

function parseApprovalRecord(raw: Record<string, unknown>): BoardApprovalRecord {
  return {
    approvalId: compactText(raw.record_id),
    title: compactText(raw.title),
    flowId: compactText(raw.flow_id) || null,
    flowRunId: compactText(raw.flow_run_id) || null,
    flowStep: Number.isFinite(Number(raw.flow_step)) ? Number(raw.flow_step) : null,
    status: compactText(raw.status) || null,
    approvalMode: compactText(raw.approval_mode) === 'agent' ? 'agent' : 'manual',
    taskIds: compactStringArrayMaybeJson(raw.task_ids ?? raw.task_ids_json),
    brief: compactText(raw.brief),
    approverWhitelist: compactStringArrayMaybeJson(raw.approver_whitelist ?? raw.approver_whitelist_json),
  };
}

function encodeTaskPatchFlags(patch: Partial<BoardTaskRecord> & { predecessorTaskIds?: string[]; tags?: string[] }): string[] {
  const args: string[] = [];
  if (patch.title !== undefined) args.push('--title', patch.title);
  if (patch.description !== undefined) args.push('--description', patch.description);
  if (patch.state !== undefined && patch.state !== null) args.push('--state', patch.state);
  if (patch.assignedTo !== undefined) {
    if (patch.assignedTo) {
      args.push('--assign', patch.assignedTo);
    } else {
      args.push('--clear-assignee');
    }
  }
  if (patch.tags !== undefined) {
    args.push('--tags', patch.tags.join(','));
  }
  if (patch.scopeId !== undefined) {
    if (patch.scopeId) {
      args.push('--scope', patch.scopeId);
    } else {
      args.push('--clear-scope');
    }
  }
  if (patch.predecessorTaskIds !== undefined) {
    args.push('--predecessor', ...patch.predecessorTaskIds);
  }
  if (patch.flowId !== undefined && patch.flowId !== null) args.push('--flow-id', patch.flowId);
  if (patch.flowRunId !== undefined && patch.flowRunId !== null) args.push('--flow-run-id', patch.flowRunId);
  if (patch.flowStep !== undefined && patch.flowStep !== null) args.push('--flow-step', String(patch.flowStep));
  return args;
}

export class YokeBoardClient implements FlowBoard {
  readonly config: RepoBoardConfigWithPaths;

  constructor(config: RepoBoardConfigWithPaths) {
    this.config = config;
  }

  async initialise(): Promise<void> {
    mkdirSync(this.config.stateDir, { recursive: true });
    await this.runYoke(['init', '--token', buildConnectionToken(this.config)]);
    await this.sync();
  }

  async sync(): Promise<unknown> {
    return await this.runYokeJson(['sync', '--json']);
  }

  async status(): Promise<unknown> {
    return await this.runYokeJson(['status', '--json']);
  }

  async getFlow(flowId: string): Promise<BoardFlowRecord> {
    const flow = await this.runYokeJson<Record<string, unknown>>(['flows', 'get', flowId, '--json']);
    return normaliseFlowRecord(flow);
  }

  async getTask(taskId: string): Promise<BoardTaskRecord> {
    const task = await this.runYokeJson<Record<string, unknown>>(['tasks', 'show', taskId, '--json']);
    return parseTaskRecord(task);
  }

  async updateTask(taskId: string, patch: Partial<BoardTaskRecord> & { predecessorTaskIds?: string[]; tags?: string[] }): Promise<BoardTaskRecord> {
    await this.runYoke(['tasks', 'update', taskId, ...encodeTaskPatchFlags(patch), '--json']);
    return await this.getTask(taskId);
  }

  async commentTask(taskId: string, body: string): Promise<void> {
    await this.runYoke(['tasks', 'comment', taskId, '--body', body, '--json']);
  }

  async createTask(input: BoardTaskCreateInput): Promise<BoardTaskRecord> {
    const args = ['tasks', 'create', '--title', input.title];
    if (input.description) args.push('--description', input.description);
    if (input.state) args.push('--state', input.state);
    if (input.assignedTo) args.push('--assign', input.assignedTo);
    if (input.parentTaskId) args.push('--parent', input.parentTaskId);
    if (input.predecessorTaskIds && input.predecessorTaskIds.length > 0) {
      args.push('--predecessor', ...input.predecessorTaskIds);
    }
    if (input.flowId) args.push('--flow-id', input.flowId);
    if (input.flowRunId) args.push('--flow-run-id', input.flowRunId);
    if (input.flowStep != null) args.push('--flow-step', String(input.flowStep));
    if (input.scopeId) args.push('--scope', input.scopeId);
    if (input.tags && input.tags.length > 0) args.push('--tags', input.tags.join(','));
    args.push('--json');
    const result = await this.runYokeJson<Record<string, unknown>>(args);
    const created = Array.isArray((result as { records?: unknown[] }).records)
      ? ((result as { records: Array<Record<string, unknown>> }).records[0] ?? null)
      : null;
    if (created?.record_id) {
      return await this.getTask(compactText(created.record_id));
    }
    await this.sync();
    const rows = await this.listFlowRunTasks(compactText(input.flowRunId));
    const match = rows.find((task) => task.title === input.title && task.parentTaskId === (input.parentTaskId ?? null));
    if (!match) {
      throw new Error(`Unable to locate created task "${input.title}".`);
    }
    return match;
  }

  async createApproval(input: {
    title: string;
    flowId?: string | null;
    flowRunId?: string | null;
    flowStep?: number | null;
    taskIds?: string[];
    approvalMode?: 'manual' | 'agent';
    brief?: string;
    approverWhitelist?: string[];
  }): Promise<BoardApprovalRecord> {
    const args = ['approvals', 'create', '--title', input.title];
    if (input.flowId) args.push('--flow-id', input.flowId);
    if (input.flowRunId) args.push('--flow-run-id', input.flowRunId);
    if (input.flowStep != null) args.push('--flow-step', String(input.flowStep));
    if (input.taskIds && input.taskIds.length > 0) args.push('--task-ids', ...input.taskIds);
    if (input.brief) args.push('--brief', input.brief);
    if (input.approvalMode) args.push('--approval-mode', input.approvalMode);
    if (input.approverWhitelist && input.approverWhitelist.length > 0) {
      args.push('--approver-whitelist', ...input.approverWhitelist);
    }
    args.push('--json');
    const result = await this.runYokeJson<Record<string, unknown>>(args);
    const created = Array.isArray((result as { records?: unknown[] }).records)
      ? ((result as { records: Array<Record<string, unknown>> }).records[0] ?? null)
      : null;
    if (created?.record_id) {
      return await this.getApproval(compactText(created.record_id));
    }
    await this.sync();
    const db = this.openDb();
    const row = db.prepare(
      `SELECT * FROM approvals WHERE flow_run_id = ? ORDER BY updated_at DESC LIMIT 1`,
    ).get(input.flowRunId ?? null) as Record<string, unknown> | null;
    if (!row) {
      throw new Error(`Unable to locate created approval "${input.title}".`);
    }
    return parseApprovalRecord(row);
  }

  async getApproval(approvalId: string): Promise<BoardApprovalRecord> {
    const approval = await this.runYokeJson<Record<string, unknown>>(['approvals', 'get', approvalId, '--json']);
    return parseApprovalRecord(approval);
  }

  async getDocument(documentId: string): Promise<Record<string, unknown>> {
    return await this.runYokeJson<Record<string, unknown>>(['docs', 'show', documentId, '--json']);
  }

  async listScopes(): Promise<Record<string, unknown>[]> {
    return await this.runYokeJson<Record<string, unknown>[]>(['scopes', 'list', '--json']);
  }

  async getScope(scopeId: string): Promise<Record<string, unknown>> {
    return await this.runYokeJson<Record<string, unknown>>(['scopes', 'show', scopeId, '--json']);
  }

  async getChatContext(input: { channelId?: string; threadId?: string; messageId?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    const args = ['chat', 'context'];
    if (input.channelId) args.push('--channel', input.channelId);
    if (input.threadId) args.push('--thread', input.threadId);
    if (input.messageId) args.push('--message', input.messageId);
    if (input.limit != null) args.push('--limit', String(input.limit));
    args.push('--format', 'json');
    return await this.runYokeJson<Record<string, unknown>>(args);
  }

  async listFlowRunTasks(flowRunId: string): Promise<BoardTaskRecord[]> {
    const db = this.openDb();
    const rows = db.prepare(
      `SELECT * FROM tasks WHERE record_state != 'deleted' AND flow_run_id = ? ORDER BY flow_step ASC, updated_at ASC`,
    ).all(flowRunId) as Array<Record<string, unknown>>;
    return rows.map((row) => parseTaskRecord(parseJsonOutput<Record<string, unknown>>(String(row.raw_json ?? '{}'))));
  }

  async listFlowRunApprovals(flowRunId: string): Promise<BoardApprovalRecord[]> {
    const db = this.openDb();
    const rows = db.prepare(
      `SELECT * FROM approvals WHERE record_state != 'deleted' AND flow_run_id = ? ORDER BY flow_step ASC, updated_at ASC`,
    ).all(flowRunId) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const rawJson = compactText(row.raw_json);
      return parseApprovalRecord(rawJson ? parseJsonOutput<Record<string, unknown>>(rawJson) : row);
    });
  }

  async approve(approvalId: string, note = ''): Promise<BoardApprovalRecord> {
    const args = ['approvals', 'approve', approvalId];
    if (note) args.push('--note', note);
    args.push('--json');
    await this.runYoke(args);
    return await this.getApproval(approvalId);
  }

  async runFlowDispatch(kickoffTaskId: string) {
    return await instantiateFlowRun(this, kickoffTaskId);
  }

  async runTaskReview(taskId: string) {
    return await continueFlowAfterTaskReview(this, taskId);
  }

  async runApprovalDispatch(approvalId: string) {
    const approval = await this.getApproval(approvalId);
    return await continueFlowAfterApproval(this, approval);
  }

  async runYoke(args: string[]): Promise<string> {
    mkdirSync(this.config.stateDir, { recursive: true });
    const proc = Bun.spawn(
      [resolveNodeBinary(), YOKE_CLI_PATH, ...args],
      {
        cwd: this.config.repoRoot,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...Bun.env,
          WINGMAN_YOKE_STATE_DIR: this.config.stateDir,
          WINGMAN_YOKE_NSEC: resolveAgentSigningKey(),
        },
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || 'Unknown error';
      throw new Error(`wingman-yoke ${args.join(' ')} failed (${exitCode}): ${detail}`);
    }
    return stdout.trim();
  }

  async runYokeJson<T>(args: string[]): Promise<T> {
    return parseJsonOutput<T>(await this.runYoke(args));
  }

  openDb(): Database {
    const db = new Database(join(this.config.stateDir, 'yoke.db'));
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  }
}

export function createBoardClient(startDir = process.cwd()): YokeBoardClient {
  return new YokeBoardClient(loadRepoBoardConfig(startDir));
}

export function describeBoardContract(config: RepoBoardConfigWithPaths): string {
  return [
    `Board config: ${config.configPath}`,
    `Workspace owner: ${config.workspaceOwnerNpub}`,
    `Backend: ${config.backendBaseUrl}`,
    `Source app: ${config.sourceAppNpub}`,
    `State dir: ${config.stateDir}`,
    'Available commands:',
    `- bun clis/wingman.ts board task show <task-id>`,
    `- bun clis/wingman.ts board task patch <task-id> --state <state>`,
    `- bun clis/wingman.ts board task comment <task-id> --body "<text>"`,
    `- bun clis/wingman.ts board task create --title "<title>"`,
    `- bun clis/wingman.ts board approval create --title "<title>"`,
    `- bun clis/wingman.ts board scope list`,
    `- bun clis/wingman.ts board doc show <doc-id>`,
    `- bun clis/wingman.ts board chat context --channel <channel-id> --thread <message-id>`,
  ].join('\n');
}

export function buildInitSummary(config: RepoBoardConfigWithPaths): string {
  return [
    `Initialised board wrapper for ${config.repoRoot}`,
    describeBoardContract(config),
  ].join('\n\n');
}

export function buildWrappedCommand(config: RepoBoardConfigWithPaths, args: string[]): string {
  return `WINGMAN_YOKE_STATE_DIR=${shellQuote(config.stateDir)} WINGMAN_YOKE_NSEC=${shellQuote(resolveAgentSigningKey())} ${shellQuote(resolveNodeBinary())} ${shellQuote(YOKE_CLI_PATH)} ${args.map(shellQuote).join(' ')}`;
}
