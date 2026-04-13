import { Buffer } from 'node:buffer';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { RuntimeBotIdentity, WorkspaceSubscriptionRecord } from './types';

const YOKE_CLI_PATH = new URL('../../../wingmanbefree/wingman-yoke/src/cli.js', import.meta.url).pathname;
const YOKE_STATE_ROOT = new URL('../../data/agent-chat-yoke', import.meta.url).pathname;

export interface AgentChatYokeMessage {
  message_id: string;
  parent_message_id: string | null;
  sender_npub: string | null;
  body: string;
  attachments: unknown[];
  updated_at: string;
}

export interface AgentChatYokeContext {
  channel_id: string;
  thread_id: string;
  participants: string[];
  recent_messages: AgentChatYokeMessage[];
}

export interface AgentChatYokeReplyResult {
  channel_id: string;
  thread_id: string;
  message_id: string;
  status: string;
}

export interface AgentChatYokeRuntime {
  stateDir: string;
  commandPrefix: string;
  context: AgentChatYokeContext | null;
  contextError: string | null;
}

export interface AgentWorkspaceYokeRuntime {
  stateDir: string;
  commandPrefix: string;
}

interface RunYokeCommandInput {
  args: string[];
  workingDirectory: string;
  stateDir: string;
  botIdentity: RuntimeBotIdentity;
}

function encodeSecretHex(secret: Uint8Array): string {
  return Buffer.from(secret).toString('hex');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveNodeBinary(): string {
  return Bun.which('node') ?? process.execPath;
}

function buildConnectionToken(subscription: WorkspaceSubscriptionRecord): string {
  return Buffer.from(JSON.stringify({
    type: 'superbased_connection',
    direct_https_url: subscription.backendBaseUrl,
    workspace_owner_npub: subscription.workspaceOwnerNpub,
    app_npub: subscription.sourceAppNpub,
  })).toString('base64');
}

function parseContextPayload(stdout: string): AgentChatYokeContext {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  return {
    channel_id: String(parsed.channel_id ?? ''),
    thread_id: String(parsed.thread_id ?? ''),
    participants: Array.isArray(parsed.participants)
      ? parsed.participants.map((value) => String(value ?? '')).filter((value) => value.length > 0)
      : [],
    recent_messages: Array.isArray(parsed.recent_messages)
      ? parsed.recent_messages.map((entry) => {
          const value = entry as Record<string, unknown>;
          return {
            message_id: String(value.message_id ?? ''),
            parent_message_id: typeof value.parent_message_id === 'string' ? value.parent_message_id : null,
            sender_npub: typeof value.sender_npub === 'string' ? value.sender_npub : null,
            body: String(value.body ?? ''),
            attachments: Array.isArray(value.attachments) ? value.attachments : [],
            updated_at: String(value.updated_at ?? ''),
          };
        })
      : [],
  };
}

function parseReplyPayload(stdout: string): AgentChatYokeReplyResult {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  return {
    channel_id: String(parsed.channel_id ?? ''),
    thread_id: String(parsed.thread_id ?? ''),
    message_id: String(parsed.message_id ?? ''),
    status: String(parsed.status ?? ''),
  };
}

async function readSpawnedText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return '';
  }
  return await new Response(stream).text();
}

async function runYokeCommand(input: RunYokeCommandInput): Promise<string> {
  const proc = Bun.spawn([resolveNodeBinary(), YOKE_CLI_PATH, ...input.args], {
    cwd: input.workingDirectory,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...Bun.env,
      WINGMAN_YOKE_STATE_DIR: input.stateDir,
      WINGMAN_YOKE_NSEC: encodeSecretHex(input.botIdentity.botSecret),
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readSpawnedText(proc.stdout),
    readSpawnedText(proc.stderr),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || 'Unknown error';
    throw new Error(`wingman-yoke ${input.args.join(' ')} failed (${exitCode}): ${detail}`);
  }
  return stdout.trim();
}

async function initialiseYokeState(
  workingDirectory: string,
  stateDir: string,
  subscription: WorkspaceSubscriptionRecord,
  botIdentity: RuntimeBotIdentity,
): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await runYokeCommand({
    args: ['init', '--token', buildConnectionToken(subscription)],
    workingDirectory,
    stateDir,
    botIdentity,
  });
}

async function syncYokeState(
  workingDirectory: string,
  stateDir: string,
  botIdentity: RuntimeBotIdentity,
): Promise<void> {
  await runYokeCommand({
    args: ['sync', '--json'],
    workingDirectory,
    stateDir,
    botIdentity,
  });
}

function buildCommandPrefix(stateDir: string): string {
  return `WINGMAN_YOKE_STATE_DIR=${shellQuote(stateDir)} ${shellQuote(resolveNodeBinary())} ${shellQuote(YOKE_CLI_PATH)}`;
}

export async function prepareAgentWorkspaceYokeRuntime(params: {
  sessionId: string;
  workingDirectory: string;
  subscription: WorkspaceSubscriptionRecord;
  botIdentity: RuntimeBotIdentity;
}): Promise<AgentWorkspaceYokeRuntime> {
  const stateDir = join(YOKE_STATE_ROOT, params.sessionId);
  await initialiseYokeState(
    params.workingDirectory,
    stateDir,
    params.subscription,
    params.botIdentity,
  );
  await syncYokeState(params.workingDirectory, stateDir, params.botIdentity);
  return {
    stateDir,
    commandPrefix: buildCommandPrefix(stateDir),
  };
}

export function buildAgentChatYokeCommands(stateDir: string, channelId: string, threadId: string) {
  const prefix = buildCommandPrefix(stateDir);
  return {
    context: `${prefix} chat context --channel ${shellQuote(channelId)} --thread ${shellQuote(threadId)} --format json`,
    history: `${prefix} chat history --format json`,
    search: `${prefix} chat search --query ${shellQuote('<term>')} --format json`,
    related: `${prefix} chat related --format json`,
    replyCurrent: `${prefix} chat reply-current --body ${shellQuote('<reply>')} --format json`,
  };
}

export function buildAgentTaskCommentYokeCommands(stateDir: string, taskId: string, commentId: string) {
  const prefix = buildCommandPrefix(stateDir);
  return {
    sync: `${prefix} sync --json`,
    show: `${prefix} tasks show ${shellQuote(taskId)} --json`,
    reply: `${prefix} tasks reply ${shellQuote(commentId)} --body ${shellQuote('<reply>')} --json`,
  };
}

export function buildAgentDocumentCommentYokeCommands(stateDir: string, documentId: string, commentId: string) {
  const prefix = buildCommandPrefix(stateDir);
  return {
    sync: `${prefix} sync --json`,
    show: `${prefix} docs show ${shellQuote(documentId)} --json`,
    reply: `${prefix} docs reply ${shellQuote(commentId)} --body ${shellQuote('<reply>')} --json`,
  };
}

export async function prepareAgentChatYokeRuntime(params: {
  sessionId: string;
  workingDirectory: string;
  subscription: WorkspaceSubscriptionRecord;
  botIdentity: RuntimeBotIdentity;
  channelId: string;
  threadId: string;
}): Promise<AgentChatYokeRuntime> {
  try {
    const workspace = await prepareAgentWorkspaceYokeRuntime({
      sessionId: params.sessionId,
      workingDirectory: params.workingDirectory,
      subscription: params.subscription,
      botIdentity: params.botIdentity,
    });
    const stdout = await runYokeCommand({
      args: [
        'chat',
        'context',
        '--channel',
        params.channelId,
        '--thread',
        params.threadId,
        '--format',
        'json',
      ],
      workingDirectory: params.workingDirectory,
      stateDir: workspace.stateDir,
      botIdentity: params.botIdentity,
    });
    return {
      stateDir: workspace.stateDir,
      commandPrefix: workspace.commandPrefix,
      context: parseContextPayload(stdout),
      contextError: null,
    };
  } catch (error) {
    const stateDir = join(YOKE_STATE_ROOT, params.sessionId);
    return {
      stateDir,
      commandPrefix: buildCommandPrefix(stateDir),
      context: null,
      contextError: error instanceof Error ? error.message : 'Failed to prepare chat context.',
    };
  }
}

export async function handoffAgentChatReply(params: {
  workingDirectory: string;
  stateDir: string;
  botIdentity: RuntimeBotIdentity;
  channelId: string;
  threadId: string;
  body: string;
}): Promise<AgentChatYokeReplyResult> {
  const stdout = await runYokeCommand({
    args: [
      'chat',
      'reply-current',
      '--body',
      params.body,
      '--channel',
      params.channelId,
      '--thread',
      params.threadId,
      '--format',
      'json',
    ],
    workingDirectory: params.workingDirectory,
    stateDir: params.stateDir,
    botIdentity: params.botIdentity,
  });
  return parseReplyPayload(stdout);
}
