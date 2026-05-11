import { Buffer } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from 'bun:sqlite';

import type { RuntimeBotIdentity, WorkspaceSubscriptionRecord } from './types';

function resolveYokePath(envName: string, fallbackRelativePath: string): string {
  const override = Bun.env[envName]?.trim();
  return override || new URL(fallbackRelativePath, import.meta.url).pathname;
}

function resolveYokeUrl(envName: string, fallbackRelativePath: string): string {
  const override = Bun.env[envName]?.trim();
  return override ? pathToFileURL(override).href : new URL(fallbackRelativePath, import.meta.url).href;
}

const YOKE_CLI_PATH = resolveYokePath('AGENT_CHAT_YOKE_CLI_PATH', '../../../wingman-yoke/src/cli.js');
const YOKE_STATE_ROOT = new URL('../../data/agent-chat-yoke', import.meta.url).pathname;
const YOKE_TRANSLATORS_URL = resolveYokeUrl('AGENT_CHAT_YOKE_TRANSLATORS_PATH', '../../../wingman-yoke/src/translators.js');
const YOKE_CLIENT_URL = resolveYokeUrl('AGENT_CHAT_YOKE_CLIENT_PATH', '../../../wingman-yoke/src/client.js');
const YOKE_WORKSPACE_KEYS_URL = resolveYokeUrl('AGENT_CHAT_YOKE_WORKSPACE_KEYS_PATH', '../../../wingman-yoke/src/workspace-keys.js');
const YOKE_NOSTR_URL = resolveYokeUrl('AGENT_CHAT_YOKE_NOSTR_PATH', '../../../wingman-yoke/src/nostr.js');
const YOKE_CONFIG_FILE = 'config.json';
const YOKE_DB_FILE = 'yoke.db';
const YOKE_RUNTIME_STATE_FILE = 'runtime-state.json';
const DEFAULT_LAZY_SYNC_MIN_INTERVAL_MS = 5_000;

interface DirectPublishModules {
  SuperbasedClient: new (params: {
    config: Record<string, unknown>;
    session: { secret: Uint8Array; pubkey: string; npub: string };
    groupKeys: unknown;
  }) => {
    setAuthSecret(secret: Uint8Array): void;
    syncRecords(records: unknown[]): Promise<unknown>;
  };
  loadGroupKeyMap: (
    session: { secret: Uint8Array; pubkey: string; npub: string },
    keyRows: unknown[],
    decodeNsec: (nsec: string) => Uint8Array,
  ) => {
    resolveGroupId(groupRef: string): string | null;
    resolveGroupNpub(groupRef: string): string | null;
    getCurrent(groupRef: string): unknown;
    get(groupRef: string, options?: Record<string, unknown>): unknown;
  };
  outboundChatMessage: (
    appNpub: string,
    session: { secret: Uint8Array; pubkey: string; npub: string },
    groupKeys: unknown,
    channel: Record<string, unknown>,
    input: {
      recordId: string;
      body: string;
      parentMessageId: string;
    },
  ) => Record<string, unknown>;
  getCachedWorkspaceKeyBlob: (db: Database, workspaceOwnerNpub: string) => Record<string, unknown> | null;
  decryptWorkspaceKey: (
    blob: Record<string, unknown>,
    userSecret: Uint8Array,
    userNpub: string,
  ) => { wsKeySecret: Uint8Array; wsKeyNpub: string; wsKeyEpoch: number };
  buildWorkspaceSession: (
    wsKeySecret: Uint8Array,
    wsKeyNpub: string,
    wsKeyEpoch: number,
    userNpub: string,
  ) => { secret: Uint8Array; pubkey: string; npub: string };
  decodeNsec: (nsec: string) => Uint8Array;
}

interface DirectPublishDeps {
  modules?: DirectPublishModules;
  DatabaseCtor?: typeof Database;
}

interface DirectPublishContext {
  fingerprint: string;
  modules: DirectPublishModules;
  client: InstanceType<DirectPublishModules['SuperbasedClient']>;
  session: { secret: Uint8Array; pubkey: string; npub: string };
  groupKeys: unknown;
  config: Record<string, unknown>;
}

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
  didSync: boolean;
}

interface CachedChatContextState {
  channelId: string;
  threadId: string;
  fetchedAt: string | null;
  context: AgentChatYokeContext | null;
}

interface YokeRuntimeState {
  token: string | null;
  lastSyncedAt: string | null;
  cachedChatContext: CachedChatContextState | null;
}

interface PrepareYokeRuntimeOptions {
  syncMode?: 'eager' | 'lazy';
  minSyncIntervalMs?: number;
}

export interface RunYokeCommandInput {
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

let cachedDirectPublishModules: Promise<DirectPublishModules> | null = null;
const directPublishContextCache = new Map<string, DirectPublishContext>();

async function loadDirectPublishModules(): Promise<DirectPublishModules> {
  if (!cachedDirectPublishModules) {
    cachedDirectPublishModules = Promise.all([
      import(YOKE_TRANSLATORS_URL),
      import(YOKE_CLIENT_URL),
      import(YOKE_WORKSPACE_KEYS_URL),
      import(YOKE_NOSTR_URL),
    ])
      .then(([translators, client, workspaceKeys, nostr]) => ({
        SuperbasedClient: client.SuperbasedClient as DirectPublishModules['SuperbasedClient'],
        loadGroupKeyMap: translators.loadGroupKeyMap as DirectPublishModules['loadGroupKeyMap'],
        outboundChatMessage: translators.outboundChatMessage as DirectPublishModules['outboundChatMessage'],
        getCachedWorkspaceKeyBlob: workspaceKeys.getCachedWorkspaceKeyBlob as DirectPublishModules['getCachedWorkspaceKeyBlob'],
        decryptWorkspaceKey: workspaceKeys.decryptWorkspaceKey as DirectPublishModules['decryptWorkspaceKey'],
        buildWorkspaceSession: workspaceKeys.buildWorkspaceSession as DirectPublishModules['buildWorkspaceSession'],
        decodeNsec: nostr.decodeNsec as DirectPublishModules['decodeNsec'],
      }))
      .catch((error) => {
        cachedDirectPublishModules = null;
        throw error;
      });
  }
  return cachedDirectPublishModules;
}

function buildConnectionToken(subscription: WorkspaceSubscriptionRecord): string {
  return Buffer.from(JSON.stringify({
    type: 'superbased_connection',
    direct_https_url: subscription.backendBaseUrl,
    workspace_owner_npub: subscription.workspaceOwnerNpub,
    app_npub: subscription.sourceAppNpub,
  })).toString('base64');
}

function getYokeConfigPath(stateDir: string): string {
  return join(stateDir, YOKE_CONFIG_FILE);
}

function getYokeRuntimeStatePath(stateDir: string): string {
  return join(stateDir, YOKE_RUNTIME_STATE_FILE);
}

function getYokeDbPath(stateDir: string): string {
  return join(stateDir, YOKE_DB_FILE);
}

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseRawRecordRow(row: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!row) {
    return null;
  }
  const rawJson = typeof row.raw_json === 'string' ? row.raw_json : null;
  if (!rawJson) {
    return row;
  }
  try {
    return JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return row;
  }
}

function buildDirectPublishFingerprint(stateDir: string, config: Record<string, unknown>): string {
  const runtimeState = loadYokeRuntimeState(stateDir);
  return JSON.stringify({
    token: runtimeState.token ?? (typeof config.token === 'string' ? config.token : null),
    lastSyncedAt: runtimeState.lastSyncedAt,
  });
}

async function prepareDirectPublishContext(params: {
  stateDir: string;
  botIdentity: RuntimeBotIdentity;
  config: Record<string, unknown>;
  fingerprint: string;
  db: Database;
}, deps?: DirectPublishDeps): Promise<DirectPublishContext> {
  const cached = directPublishContextCache.get(params.stateDir);
  if (cached && cached.fingerprint === params.fingerprint) {
    return cached;
  }

  const modules = deps?.modules ?? await loadDirectPublishModules();
  const botSession = {
    secret: params.botIdentity.botSecret,
    pubkey: params.botIdentity.botPubkeyHex,
    npub: params.botIdentity.botNpub,
  };
  const keyRows = params.db.query('SELECT * FROM group_keys_cache ORDER BY group_id, key_version').all() as unknown[];
  const groupKeys = modules.loadGroupKeyMap(botSession, keyRows, modules.decodeNsec);
  let session = botSession;
  const client = new modules.SuperbasedClient({
    config: params.config,
    session: botSession,
    groupKeys,
  });

  const workspaceOwnerNpub = typeof params.config.workspaceOwnerNpub === 'string' ? params.config.workspaceOwnerNpub : '';
  const cachedBlob = workspaceOwnerNpub
    ? modules.getCachedWorkspaceKeyBlob(params.db, workspaceOwnerNpub)
    : null;
  if (cachedBlob) {
    const { wsKeySecret, wsKeyNpub, wsKeyEpoch } = modules.decryptWorkspaceKey(
      cachedBlob,
      botSession.secret,
      botSession.npub,
    );
    session = modules.buildWorkspaceSession(wsKeySecret, wsKeyNpub, wsKeyEpoch, botSession.npub);
    client.setAuthSecret(session.secret);
  }

  const context: DirectPublishContext = {
    fingerprint: params.fingerprint,
    modules,
    client,
    session,
    groupKeys,
    config: params.config,
  };
  directPublishContextCache.set(params.stateDir, context);
  return context;
}

function prewarmDirectPublishContext(params: {
  stateDir: string;
  botIdentity: RuntimeBotIdentity;
}): void {
  void (async () => {
    const config = readJsonFile(getYokeConfigPath(params.stateDir));
    if (!config) {
      return;
    }
    const dbPath = getYokeDbPath(params.stateDir);
    if (!existsSync(dbPath)) {
      return;
    }
    const db = new Database(dbPath);
    try {
      await prepareDirectPublishContext({
        stateDir: params.stateDir,
        botIdentity: params.botIdentity,
        config,
        fingerprint: buildDirectPublishFingerprint(params.stateDir, config),
        db,
      });
    } finally {
      db.close();
    }
  })().catch(() => undefined);
}

function loadYokeRuntimeState(stateDir: string): YokeRuntimeState {
  const parsed = readJsonFile(getYokeRuntimeStatePath(stateDir));
  return {
    token: typeof parsed?.token === 'string' && parsed.token.trim().length > 0 ? parsed.token : null,
    lastSyncedAt:
      typeof parsed?.lastSyncedAt === 'string' && parsed.lastSyncedAt.trim().length > 0
        ? parsed.lastSyncedAt
        : null,
    cachedChatContext:
      parsed?.cachedChatContext && typeof parsed.cachedChatContext === 'object'
        ? {
            channelId:
              typeof (parsed.cachedChatContext as Record<string, unknown>).channelId === 'string'
                ? String((parsed.cachedChatContext as Record<string, unknown>).channelId)
                : '',
            threadId:
              typeof (parsed.cachedChatContext as Record<string, unknown>).threadId === 'string'
                ? String((parsed.cachedChatContext as Record<string, unknown>).threadId)
                : '',
            fetchedAt:
              typeof (parsed.cachedChatContext as Record<string, unknown>).fetchedAt === 'string'
                ? String((parsed.cachedChatContext as Record<string, unknown>).fetchedAt)
                : null,
            context:
              (parsed.cachedChatContext as Record<string, unknown>).context
              && typeof (parsed.cachedChatContext as Record<string, unknown>).context === 'object'
                ? ((parsed.cachedChatContext as Record<string, unknown>).context as AgentChatYokeContext)
                : null,
          }
        : null,
  };
}

async function saveYokeRuntimeState(stateDir: string, state: YokeRuntimeState): Promise<void> {
  await Bun.write(
    getYokeRuntimeStatePath(stateDir),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

function hasMatchingYokeConfig(stateDir: string, token: string): boolean {
  const parsed = readJsonFile(getYokeConfigPath(stateDir));
  return typeof parsed?.token === 'string' && parsed.token === token;
}

function shouldRunLazySync(stateDir: string, token: string, minSyncIntervalMs: number): boolean {
  const runtimeState = loadYokeRuntimeState(stateDir);
  if (runtimeState.token !== token) {
    return true;
  }
  if (!runtimeState.lastSyncedAt) {
    return true;
  }
  const lastSyncedAt = Date.parse(runtimeState.lastSyncedAt);
  if (!Number.isFinite(lastSyncedAt)) {
    return true;
  }
  return Date.now() - lastSyncedAt >= minSyncIntervalMs;
}

export function shouldReuseCachedChatContext(params: {
  state: YokeRuntimeState;
  token: string;
  channelId: string;
  threadId: string;
  minSyncIntervalMs: number;
}): boolean {
  const cached = params.state.cachedChatContext;
  if (!cached) {
    return false;
  }
  if (params.state.token !== params.token) {
    return false;
  }
  if (cached.channelId !== params.channelId || cached.threadId !== params.threadId) {
    return false;
  }
  if (!cached.context) {
    return false;
  }
  if (!cached.fetchedAt) {
    return false;
  }
  const fetchedAt = Date.parse(cached.fetchedAt);
  if (!Number.isFinite(fetchedAt)) {
    return false;
  }
  return Date.now() - fetchedAt < params.minSyncIntervalMs;
}

export function appendReplyToCachedChatContext(params: {
  state: YokeRuntimeState;
  channelId: string;
  threadId: string;
  messageId: string;
  body: string;
  senderNpub: string;
  at?: string;
  maxMessages?: number;
}): YokeRuntimeState {
  const cached = params.state.cachedChatContext;
  if (
    !cached
    || cached.channelId !== params.channelId
    || cached.threadId !== params.threadId
    || !cached.context
  ) {
    return params.state;
  }

  const at = params.at ?? new Date().toISOString();
  const maxMessages = Math.max(1, params.maxMessages ?? 20);
  const participants = cached.context.participants.includes(params.senderNpub)
    ? cached.context.participants
    : [...cached.context.participants, params.senderNpub];
  const nextMessages = [
    ...cached.context.recent_messages,
    {
      message_id: params.messageId,
      parent_message_id: params.threadId,
      sender_npub: params.senderNpub,
      body: params.body,
      attachments: [],
      updated_at: at,
    },
  ].slice(-maxMessages);

  return {
    ...params.state,
    cachedChatContext: {
      channelId: cached.channelId,
      threadId: cached.threadId,
      fetchedAt: at,
      context: {
        channel_id: cached.context.channel_id,
        thread_id: cached.context.thread_id,
        participants,
        recent_messages: nextMessages,
      },
    },
  };
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
    throw new Error(`flightdeck-cli ${input.args.join(' ')} failed (${exitCode}): ${detail}`);
  }
  return stdout.trim();
}

export async function runAgentWorkspaceYokeCommand(input: RunYokeCommandInput): Promise<string> {
  return await runYokeCommand(input);
}

async function initialiseYokeState(
  workingDirectory: string,
  stateDir: string,
  subscription: WorkspaceSubscriptionRecord,
  botIdentity: RuntimeBotIdentity,
): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const token = buildConnectionToken(subscription);
  if (hasMatchingYokeConfig(stateDir, token)) {
    return;
  }
  await runYokeCommand({
    args: ['init', '--token', token],
    workingDirectory,
    stateDir,
    botIdentity,
  });
  const runtimeState = loadYokeRuntimeState(stateDir);
  await saveYokeRuntimeState(stateDir, {
    token,
    lastSyncedAt: runtimeState.lastSyncedAt,
    cachedChatContext: null,
  });
}

async function syncYokeState(
  workingDirectory: string,
  stateDir: string,
  subscription: WorkspaceSubscriptionRecord,
  botIdentity: RuntimeBotIdentity,
): Promise<void> {
  await runYokeCommand({
    args: ['sync', '--json'],
    workingDirectory,
    stateDir,
    botIdentity,
  });
  await saveYokeRuntimeState(stateDir, {
    token: buildConnectionToken(subscription),
    lastSyncedAt: new Date().toISOString(),
    cachedChatContext: null,
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
  options?: PrepareYokeRuntimeOptions;
}): Promise<AgentWorkspaceYokeRuntime> {
  const stateDir = join(YOKE_STATE_ROOT, params.sessionId);
  await initialiseYokeState(
    params.workingDirectory,
    stateDir,
    params.subscription,
    params.botIdentity,
  );
  const syncMode = params.options?.syncMode ?? 'eager';
  const minSyncIntervalMs = Math.max(0, params.options?.minSyncIntervalMs ?? DEFAULT_LAZY_SYNC_MIN_INTERVAL_MS);
  let didSync = false;
  if (syncMode === 'eager' || shouldRunLazySync(stateDir, buildConnectionToken(params.subscription), minSyncIntervalMs)) {
    await syncYokeState(params.workingDirectory, stateDir, params.subscription, params.botIdentity);
    didSync = true;
  }
  return {
    stateDir,
    commandPrefix: buildCommandPrefix(stateDir),
    didSync,
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
  options?: PrepareYokeRuntimeOptions;
}): Promise<AgentChatYokeRuntime> {
  try {
    const minSyncIntervalMs = Math.max(0, params.options?.minSyncIntervalMs ?? DEFAULT_LAZY_SYNC_MIN_INTERVAL_MS);
    const token = buildConnectionToken(params.subscription);
    const workspace = await prepareAgentWorkspaceYokeRuntime({
      sessionId: params.sessionId,
      workingDirectory: params.workingDirectory,
      subscription: params.subscription,
      botIdentity: params.botIdentity,
      options: params.options,
    });
    prewarmDirectPublishContext({
      stateDir: workspace.stateDir,
      botIdentity: params.botIdentity,
    });
    const runtimeState = loadYokeRuntimeState(workspace.stateDir);
    if (
      params.options?.syncMode === 'lazy'
      && !workspace.didSync
      && shouldReuseCachedChatContext({
        state: runtimeState,
        token,
        channelId: params.channelId,
        threadId: params.threadId,
        minSyncIntervalMs,
      })
    ) {
      return {
        stateDir: workspace.stateDir,
        commandPrefix: workspace.commandPrefix,
        context: runtimeState.cachedChatContext?.context ?? null,
        contextError: null,
      };
    }
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
    const context = parseContextPayload(stdout);
    await saveYokeRuntimeState(workspace.stateDir, {
      ...runtimeState,
      token,
      cachedChatContext: {
        channelId: params.channelId,
        threadId: params.threadId,
        fetchedAt: new Date().toISOString(),
        context,
      },
    });
    return {
      stateDir: workspace.stateDir,
      commandPrefix: workspace.commandPrefix,
      context,
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

export async function publishAgentChatReplyDirect(params: {
  stateDir: string;
  botIdentity: RuntimeBotIdentity;
  channelId: string;
  threadId: string;
  body: string;
}, deps?: DirectPublishDeps): Promise<AgentChatYokeReplyResult> {
  const config = readJsonFile(getYokeConfigPath(params.stateDir));
  if (!config) {
    throw new Error(`Missing Yoke config in ${params.stateDir}`);
  }

  const DatabaseCtor = deps?.DatabaseCtor ?? Database;
  const db = new DatabaseCtor(getYokeDbPath(params.stateDir));

  try {
    const context = await prepareDirectPublishContext({
      stateDir: params.stateDir,
      botIdentity: params.botIdentity,
      config,
      fingerprint: buildDirectPublishFingerprint(params.stateDir, config),
      db,
    }, deps);

    const channelRow = db.query('SELECT * FROM channels WHERE record_id = ?').get(params.channelId) as Record<string, unknown> | null;
    const channel = parseRawRecordRow(channelRow);
    if (!channel) {
      throw new Error(`Channel not found locally: ${params.channelId}`);
    }

    const messageId = crypto.randomUUID();
    const appNpub = typeof context.config.appNpub === 'string' ? context.config.appNpub : '';
    const envelope = context.modules.outboundChatMessage(appNpub, context.session, context.groupKeys, channel, {
      recordId: messageId,
      body: params.body,
      parentMessageId: params.threadId,
    });
    await context.client.syncRecords([envelope]);

    return {
      channel_id: params.channelId,
      thread_id: params.threadId,
      message_id: messageId,
      status: 'sent',
    };
  } finally {
    db.close();
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
  let reply: AgentChatYokeReplyResult;
  try {
    reply = await publishAgentChatReplyDirect({
      stateDir: params.stateDir,
      botIdentity: params.botIdentity,
      channelId: params.channelId,
      threadId: params.threadId,
      body: params.body,
    });
  } catch {
    const stdout = await runYokeCommand({
      args: [
        'chat',
        'reply-current',
        '--body',
        params.body,
        '--skip-refresh',
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
    reply = parseReplyPayload(stdout);
  }
  const runtimeState = loadYokeRuntimeState(params.stateDir);
  await saveYokeRuntimeState(
    params.stateDir,
    appendReplyToCachedChatContext({
      state: runtimeState,
      channelId: params.channelId,
      threadId: params.threadId,
      messageId: reply.message_id,
      body: params.body,
      senderNpub: params.botIdentity.botNpub,
    }),
  );
  return reply;
}
