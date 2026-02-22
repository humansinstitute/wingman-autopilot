import { randomUUID } from "node:crypto";
import { type Dirent } from "node:fs";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve as resolvePath, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import "./logging/server-logger";

import type { AgentType } from "./config";
import { getKeyTeleportIdentity } from "./config";
import { z } from "zod";
import { 
  validateInput, 
  NpubSchema, 
  SessionIdSchema, 
  PathSchema, 
  LimitSchema, 
  OffsetSchema, 
  FilterSchema,
  ArchiveListOptionsSchema,
  JsonRequestSchema
} from "./utils/validation";
import { loadConfig } from "./config";
import { ProcessManager } from "./agents/process-manager";
import type { SessionOrigin, SessionSnapshot } from "./agents/process-manager";
import {
  appRegistry,
  type AppLifecycleAction,
  type AppLifecycleScripts,
  type AppRecord,
} from "./apps/app-registry";
import { appAliasRegistry } from "./apps/app-alias-registry";
import {
  AppActionInProgressError,
  AppScriptMissingError,
  appProcessManager,
  type AppProcessStatus,
} from "./apps/app-process-manager";
import { scanDirectoryTree, type TreeNode } from "./apps/app-detector";

/** Tmux session for the Wingman core process (used by warm restart manager). */
const WINGMAN_CORE_TMUX_SESSION = "wingman-apps";
import { messageStore } from "./storage/message-store";
import { scheduleSessionArchive, cancelPendingArchive } from "./storage/session-archiver";
import { sessionArchiveStore } from "./storage/session-archive-store";
import { PromptQueueStore } from "./storage/prompt-queue-store";
import { orchestratorPresetStore } from "./storage/orchestrator-presets";
import type { OrchestratorPresetRecord } from "./storage/orchestrator-presets";
import { fileWatcherStore } from "./storage/file-watcher-store";
import {
  featureFlagStore,
  isFeatureFlagState,
  normaliseFeatureFlagKey,
  resolveFeatureFlagEffectiveState,
  type FeatureFlagRecord,
  type FeatureFlagState,
} from "./storage/feature-flag-store";
import { FileWatcherRunner } from "./watchers/file-watcher-runner";
import { identityUserStore } from "./storage/identity-user-store";
import { TodoStore } from "./todos/todo-store";
import { createTodoApiHandler } from "./todos/todo-api";
import { ProjectStore } from "./projects/project-store";
import { createProjectApiHandler } from "./projects/project-api";
import { createNpubProjectApiHandler } from "./projects/npub-project-api";
import { npubProjectStore } from "./projects/npub-project-store";
import { CaproverStore, createCaproverApiHandler, createCaproverClientFromEnv, createAppTarball } from "./caprover";
import { NightWatchStore } from "./nightwatch/nightwatch-store";
import { maybeTriggerNightWatch, NIGHTWATCH_FEATURE_FLAG_KEY } from "./nightwatch/nightwatch-engine";
import { createNightWatchApiHandler } from "./nightwatch/nightwatch-api";
import { nip19, verifyEvent } from "nostr-tools";
import { startTaskListener } from "./nostr/task-listener";
import { createTaskExecutor } from "./nostr/task-executor";
import { signWithWingmanKey } from "./mcp/wingman-signer";
import { createBrowserLogHandler } from "./logging/browser-log-handler";
import { Nip98GrantStore } from "./mcp/grants-store";
import { createNip98ApiHandler } from "./mcp/nip98-api";
import { createWingmanMcpApiHandler } from "./mcp/wingman-api";
import { createNgitApiHandler } from "./ngit/ngit-api";
import { createGiteaApiHandler } from "./gitea/gitea-api";
import { createGitWorkflowApiHandler } from "./gitea/git-workflow-api";
import { ensureGiteaUser } from "./gitea/gitea-user-manager";
import { createSuperbasedApiHandler } from "./superbased/superbased-api";
import { BotKeyStore } from "./identity/bot-key-store";
import { createBotKeyApiHandler } from "./identity/bot-key-api";
import { createBotCryptoApiHandler } from "./identity/bot-crypto-api";
import { generateBotKey, clearBotKey, isBotKeyUnlocked } from "./identity/bot-key-manager";
import { browserSubscribers } from "./mcp/browser-subscribers";
import { MemoryStore } from "./mcp/memory-store";
import { userSettingsStore } from "./storage/user-settings-store";
import { artifactsStore } from "./storage/artifacts-store";
import {
  buildAgentUrl,
  fetchAgentMessages,
  normaliseHostForUrl,
  parseAllowedHosts,
  pickAgentHost,
  sendAgentMessage,
  waitForAgentReady as waitForAgentReadyCore,
} from "./agents/agent-client";
import { AgentRuntimeStatusPoller } from "./agents/agent-status-poller";
import { mintSessionCookie, SessionCookieError, SESSION_COOKIE_NAME } from "./auth/session-cookie";
import {
  resolveRequestAuthContext,
  runWithRequestContext,
  getRequestContext,
  type RequestAuthContext,
} from "./auth/request-context";
import { deriveNpubSegment, normaliseNpub } from "./identity/npub-utils";
import { generateIdentityAlias } from "./identity/identity-alias";
import { resolveWorkspaceScope, type WorkspaceScope } from "./workspaces/workspace-scope";
import {
  AccessActions,
  allow,
  deny,
  evaluateAccess,
  registerAccessRule,
  requireAuthentication,
  type AccessAction,
  type AccessDecision,
  type AccessRule,
} from "./auth/access-control";
import { handleKeyTeleport, handleKeyTeleportRegistration } from "./auth/keyteleport";
import { secureResolvePath, validatePathSegment, sanitizePath } from "./server/path-security.js";
import { createStaticAssetService, compressResponse } from "./server/static-assets";
import { maybeRefreshSessionCookie } from "./server/session-refresh";
import { handleSubdomainRequest, resolveAliasToPort, proxyRequestToApp, type SubdomainProxyConfig } from "./server/subdomain-proxy";
import { isAgentRuntimeStatus } from "./types/agent-status";
import { scheduleCleanup } from "./uploads/cleanup";
import { createSessionEventsHandler } from "./server/session-events";
import { sessionBroadcaster, createSessionSubscribeResponse } from "./server/session-broadcaster";
import { handleChatApi, type ChatApiContext } from "./server/chat-routes";
import { handleSessionApi, type SessionApiContext } from "./server/session-api-routes";
import { handleDocsApi, type DocsApiContext } from "./server/docs-routes";
import { handleAdminUsersApi, type AdminUsersApiContext } from "./server/admin-users-routes";
import { performSystemCleanup } from "./server/system-cleanup.js";
import { ensureAgentApiBinary } from "./server/bootstrap/agentapi";
import { SchedulerStore } from "./scheduler/scheduler-store";
import { SchedulerEngine } from "./scheduler/scheduler-engine";
import { createSchedulerApiHandler } from "./scheduler/scheduler-api";
import { createTriggerListener, type TriggerListener } from "./nostr/trigger-listener";
import {
  clearWarmRestartMarker,
  loadWarmRestartMarker,
  readStreamToString,
  rehydrateWarmSessions,
  rehydrateOrphanedSessions,
  warmRestartOutcome,
  warmRestartState,
  writeWarmRestartMarker,
} from "./server/bootstrap/warm-restart";
import type { WarmRestartMarker } from "./server/bootstrap/warm-restart";
import { reconcileAppsWithPM2 } from "./server/bootstrap/pm2-reconcile";
import { connectPM2 } from "./agents/pm2-wrapper";
import { createUploadHelpers } from "./server/uploads/helpers";
import { resolveAndCacheNostrProfile } from "./server/nostr-profile";
import { shouldKeepBotKeyForNostrTriggers } from "./server/botkey-lifecycle";
import { waitForSessionPromptReadiness } from "./server/session-readiness";
import { createPromptDispatchEngine, QueueDispatchError } from "./server/prompt-dispatch";
import {
  validateForkInput,
  getRecentMessages,
  formatMessagesAsContext,
} from "./sessions/fork-to-worktree";

const config = loadConfig();
const adminNpub = normaliseNpub(Bun.env.ADMIN_NPUB ?? null);

// Subdomain proxy configuration
const subdomainProxyConfig: SubdomainProxyConfig = {
  baseDomain: config.subdomainBaseDomain,
  enabled: config.subdomainProxyEnabled,
};

if (subdomainProxyConfig.enabled) {
  console.log(`[subdomain-proxy] Enabled for base domain: ${subdomainProxyConfig.baseDomain}`);
}

/**
 * Handle path-based app routing (/host/<alias> and /host/<alias>/*).
 * Extracts alias from path and proxies to the app's local port.
 */
const handlePathBasedAppRequest = async (
  request: Request,
  pathname: string,
): Promise<Response | null> => {
  // Extract alias from path: /host/<alias> or /host/<alias>/...
  const pathParts = pathname.split("/").filter(Boolean);
  if (pathParts.length < 2 || pathParts[0] !== "host") {
    return null;
  }

  const alias = pathParts[1];
  if (!alias) {
    return null;
  }

  // Redirect /host/<alias> to /host/<alias>/ to ensure correct relative path resolution
  // Without trailing slash, browser resolves ./logo.png to /host/logo.png instead of /host/<alias>/logo.png
  if (pathParts.length === 2 && !pathname.endsWith("/") && request.method === "GET") {
    const url = new URL(request.url);
    return Response.redirect(`${url.origin}${pathname}/${url.search}`, 302);
  }

  // Resolve alias to port
  const resolved = await resolveAliasToPort(alias);
  if (!resolved.success) {
    const errorMessages: Record<string, string> = {
      alias_not_found: `No app registered for alias "${alias}".`,
      app_not_found: `App ID ${resolved.appId} not found in registry.`,
      app_not_running: `App is not running (status: ${resolved.status}).`,
      port_not_registered: `App is running but port not detected. Try restarting the app.`,
    };
    console.warn(`[path-proxy] ${alias}: ${resolved.reason}`, resolved);
    return new Response(
      JSON.stringify({
        error: "App not available",
        reason: resolved.reason,
        message: errorMessages[resolved.reason],
        alias,
        appId: resolved.appId,
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Check for WebSocket upgrade
  const upgradeHeader = request.headers.get("upgrade");
  if (upgradeHeader?.toLowerCase() === "websocket") {
    return new Response(
      JSON.stringify({
        error: "WebSocket not supported",
        message: "WebSocket connections through path routing are not yet fully supported.",
      }),
      {
        status: 501,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Rewrite the path to remove /host/<alias> prefix
  const remainingPath = "/" + pathParts.slice(2).join("/");
  const url = new URL(request.url);
  const rewrittenUrl = new URL(remainingPath + url.search, request.url);

  // Create a new request with the rewritten path
  const rewrittenRequest = new Request(rewrittenUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    // @ts-expect-error - Bun supports duplex but types may not reflect it
    duplex: "half",
  });

  return proxyRequestToApp(rewrittenRequest, resolved.port);
};
const ORCHESTRATOR_FLAG_KEY = "orchestrator_visibility";
const PROJECTS_FLAG_KEY = "projects_visibility";
const FEATURE_FLAG_DEFAULTS: Array<{
  key: string;
  label: string;
  description: string;
  state: FeatureFlagState;
}> = [
  {
    key: ORCHESTRATOR_FLAG_KEY,
    label: "Orchestrator visibility",
    description: "Controls whether orchestrator presets are visible in the UI.",
    state: "on_admin",
  },
  {
    key: PROJECTS_FLAG_KEY,
    label: "Projects visibility",
    description: "Controls whether the Projects view is visible in the UI.",
    state: "on_admin",
  },
  {
    key: NIGHTWATCH_FEATURE_FLAG_KEY,
    label: "Night Watchman",
    description: "Autonomous agent review system that continues sessions overnight.",
    state: "off",
  },
  {
    key: "task_listener_enabled",
    label: "MG Task Listener",
    description: "Receives task assignments from MG via Nostr and auto-creates agent sessions.",
    state: "on",
  },
  {
    key: "private_chats_enabled",
    label: "Private Chats",
    description: "Controls whether the Private Chats button is visible on the home screen.",
    state: "on",
  },
];

featureFlagStore.ensureDefaults(FEATURE_FLAG_DEFAULTS);
process.env.WINGMAN_PID = process.pid.toString();
const SUPPORTED_AGENT_TYPES: AgentType[] = ["codex", "claude", "goose", "opencode", "gemini"];
const MESSAGE_COST_SATS = 100;
const projectStore = new ProjectStore();
const todoStore = new TodoStore();
const promptQueueStore = new PromptQueueStore("data/prompt-queue.db");
const todoApiHandler = createTodoApiHandler({ store: todoStore, projectStore });
const projectApiHandler = createProjectApiHandler({
  store: projectStore,
  getAppById: (id) => appRegistry.getApp(id),
});
const npubProjectApiHandler = createNpubProjectApiHandler();
const browserLogHandler = createBrowserLogHandler();
const caproverStore = new CaproverStore();
const caproverApiHandler = createCaproverApiHandler({
  store: caproverStore,
  getClient: createCaproverClientFromEnv,
});
const nightWatchStore = new NightWatchStore();
const nightWatchApiHandler = createNightWatchApiHandler({
  store: nightWatchStore,
  featureFlagStore,
});
const botKeyStore = new BotKeyStore();
const schedulerStore = new SchedulerStore();
const triggerListener: TriggerListener = createTriggerListener({
  schedulerStore,
  relays: config.connectRelays,
  onTriggerMatched: async (job, message) => {
    await schedulerEngine.executeJobWithMessage(job.id, message || undefined);
  },
});
function onBotKeyUnlockedHook(npub: string, secretKey: Uint8Array, botPubkeyHex: string): void {
  triggerListener.subscribe(npub, secretKey, botPubkeyHex);
}
const schedulerEngine = new SchedulerEngine({
  store: schedulerStore,
  botKeyStore,
  nightWatchStore,
  createSession: (agent, dir, name, origin, targetFile, explicitNpub) =>
    manager.createSession(agent, dir, name, origin, targetFile, explicitNpub),
  addPrompt: (sid, content) => promptQueueStore.addPrompt(sid, { content }),
  dispatchPrompt: (session) => {
    void maybeAutoDispatchQueuedPrompt(session);
  },
  awaitSessionReadyForPrompt: async (session, agent) => {
    const timeoutMs = agent === "codex" ? 120000 : 60000;
    await waitForSessionPromptReadiness({
      getSession: (sessionId) => manager.getSession(sessionId) ?? null,
      sessionId: session.id,
      host: agentHost,
      timeoutMs,
      pollIntervalMs: 500,
      requiredStablePolls: agent === "codex" ? 3 : 2,
      requestTimeoutMs: 2500,
    });
    markPromptStartupReady(session.id);
  },
  onBotKeyUnlocked: onBotKeyUnlockedHook,
});
const schedulerApiHandler = createSchedulerApiHandler({
  store: schedulerStore,
  engine: schedulerEngine,
  botKeyStore,
  getNpub: (request: Request) => {
    const ctx = getRequestContext();
    return ctx?.npub ?? null;
  },
});
const nip98GrantsStore = new Nip98GrantStore();
const memoryStore = new MemoryStore();
const nip98ApiHandler = createNip98ApiHandler({
  grantsStore: nip98GrantsStore,
  getSession: (sid: string) => manager.getSession(sid) ?? null,
  onBrowserSubscribe: (npub: string) => {
    // When browser subscribes to SSE, send bot key decrypt request if needed
    try {
      if (!isBotKeyUnlocked(npub)) {
        const botRecord = botKeyStore.getActiveKeyForUser(npub);
        if (botRecord) {
          const rootIdentity = getKeyTeleportIdentity();
          if (rootIdentity) {
            browserSubscribers.send(npub, {
              type: "botkey:decrypt_request",
              encryptedToUser: botRecord.encryptedToUser,
              senderPubkey: rootIdentity.pubkey,
              botPubkeyHex: botRecord.botPubkeyHex,
            });
            console.log(`[bot-key] Sent decrypt request on SSE subscribe for ${npub.slice(0, 20)}…`);
          }
        }
      }
    } catch (error) {
      console.warn(`[bot-key] Failed to send decrypt request on subscribe:`, error);
    }
  },
});
const ngitApiHandler = createNgitApiHandler({
  grantsStore: nip98GrantsStore,
  getSession: (sid: string) => manager.getSession(sid) ?? null,
  defaultRelays: config.connectRelays,
  gitea: {
    url: config.giteaUrl ?? undefined,
    apiToken: config.giteaApiToken ?? undefined,
    owner: config.giteaOwner ?? undefined,
  },
});
const superbasedApiHandler = createSuperbasedApiHandler({
  defaultBaseUrl: config.superbasedUrl,
  getSession: (sid: string) => manager.getSession(sid) ?? null,
});
const botKeyApiHandler = createBotKeyApiHandler({
  store: botKeyStore,
  getSession: (sid: string) => manager.getSession(sid),
  onBotKeyUnlocked: onBotKeyUnlockedHook,
  defaultRelays: config.connectRelays,
});
const botCryptoApiHandler = createBotCryptoApiHandler({
  getSession: (sid: string) => manager.getSession(sid),
});
const giteaApiHandler = createGiteaApiHandler({
  getSession: (sid: string) => manager.getSession(sid),
  config,
  dataDir: new URL("../data", import.meta.url).pathname,
});
const gitWorkflowApiHandler = createGitWorkflowApiHandler({
  getSession: (sid: string) => manager.getSession(sid),
  config,
  dataDir: new URL("../data", import.meta.url).pathname,
});
registerAccessRule(AccessActions.SessionsManage, requireAuthentication());
registerAccessRule(AccessActions.FilesRead, requireAuthentication());
registerAccessRule(AccessActions.FilesWrite, requireAuthentication());
registerAccessRule(AccessActions.AppsManage, requireAuthentication());
registerAccessRule(AccessActions.UiRestricted, requireAuthentication());
registerAccessRule(AccessActions.TodosManage, requireAuthentication());
registerAccessRule(AccessActions.ProjectsManage, requireAuthentication());
registerAccessRule(AccessActions.DeploymentsManage, requireAuthentication());

const projectRootPath = (() => {
  let root = normalize(fileURLToPath(new URL("..", import.meta.url)));
  if (root.endsWith(sep)) {
    root = root.slice(0, -1);
  }
  return root;
})();
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const projectRootDirectory = normalize(join(moduleDirectory, ".."));
const agentApiBinaryPath = normalize(join(projectRootDirectory, "out", "agentapi"));

await ensureAgentApiBinary({ agentApiBinaryPath, projectRootDirectory });

let preserveSessionsOnShutdown = false;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const runCommand = async (command: string, args: string[], options: { cwd?: string } = {}): Promise<CommandResult> => {
  let subprocess: ReturnType<typeof Bun.spawn>;
  try {
    subprocess = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: options.cwd,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 127, stdout: "", stderr: message };
  }

  const [stdout, stderr, exited] = await Promise.all([
    readStreamToString(subprocess.stdout),
    readStreamToString(subprocess.stderr),
    subprocess.exited,
  ]);

  return {
    exitCode: exited ?? 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
};

const resolveGitDirectoryPath = (gitDir: string, cwd: string): string => {
  const normalized = gitDir.trim();
  if (!normalized) {
    return normalize(join(cwd, ".git"));
  }
  return normalize(isAbsolute(normalized) ? normalized : join(cwd, normalized));
};

const resolveRealPath = async (input: string): Promise<string> => {
  const normalized = normalize(input);
  try {
    return normalize(await realpath(normalized));
  } catch {
    return normalized;
  }
};

type GitWorktreeSummary = {
  path: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  primary: boolean;
};

type GitRepositorySummary = {
  isRepository: true;
  repoRoot: string;
  isRepoRoot: boolean;
  hasGitMetadata: boolean;
  gitDir: string | null;
  currentBranch: string | null;
  headRef: string | null;
  worktrees: GitWorktreeSummary[];
  worktreeBase: string;
  worktreeError: string | null;
};

type GitCommandAction = "init" | "addAll" | "commit" | "push" | "pushUpstream" | "pull";

const executeGitCommand = async (options: {
  directory: string;
  action: GitCommandAction;
  message?: string | null;
  remote?: string | null;
  branch?: string | null;
}): Promise<CommandResult> => {
  const directory = options.directory;
  const action = options.action;

  switch (action) {
    case "init":
      return runCommand("git", ["init"], { cwd: directory });
    case "addAll":
      return runCommand("git", ["add", "."], { cwd: directory });
    case "commit": {
      const message = options.message?.trim();
      if (!message) {
        throw new Error("Commit message is required");
      }
      return runCommand("git", ["commit", "-m", message], { cwd: directory });
    }
    case "push": {
      const remote = options.remote?.trim();
      const branch = options.branch?.trim();
      const args = ["push"];
      if (remote) {
        args.push(remote);
        if (branch) {
          args.push(branch);
        }
      }
      return runCommand("git", args, { cwd: directory });
    }
    case "pushUpstream": {
      const remote = options.remote?.trim() || "origin";
      const branch = options.branch?.trim();
      if (!branch) {
        throw new Error("Branch name is required to set upstream");
      }
      return runCommand("git", ["push", "-u", remote, branch], { cwd: directory });
    }
    case "pull": {
      const remote = options.remote?.trim();
      const branch = options.branch?.trim();
      const args = ["pull"];
      if (remote) {
        args.push(remote);
        if (branch) {
          args.push(branch);
        }
      }
      return runCommand("git", args, { cwd: directory });
    }
    default:
      throw new Error("Unsupported git command");
  }
};

const parseGitWorktreeList = (output: string, repoRoot: string): GitWorktreeSummary[] => {
  if (!output || output.trim().length === 0) {
    return [];
  }

  const entries: GitWorktreeSummary[] = [];
  const lines = output.split(/\r?\n/);
  let current: { path: string; branch: string | null; bare: boolean; detached: boolean } | null = null;

  const pushCurrent = () => {
    if (!current) return;
    const resolvedPath = normalize(current.path);
    entries.push({
      path: resolvedPath,
      branch: current.branch,
      bare: current.bare,
      detached: current.detached,
      primary: resolvedPath === normalize(repoRoot),
    });
    current = null;
  };

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("worktree ")) {
      pushCurrent();
      const path = line.slice("worktree ".length).trim();
      current = { path, branch: null, bare: false, detached: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      const branch =
        ref === "" || ref === "HEAD"
          ? null
          : ref.startsWith("refs/heads/")
            ? ref.slice("refs/heads/".length)
            : ref;
      current.branch = branch;
      continue;
    }
    if (line.startsWith("bare")) {
      current.bare = true;
      continue;
    }
    if (line.startsWith("detached")) {
      current.detached = true;
      continue;
    }
  }

  pushCurrent();
  return entries;
};

const describeGitRepository = async (directory: string): Promise<GitRepositorySummary | null> => {
  const topLevel = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: directory });
  if (topLevel.exitCode !== 0 || !topLevel.stdout) {
    return null;
  }

  const repoRoot = normalize(topLevel.stdout);
  const [effectiveRepoRoot, effectiveDirectory] = await Promise.all([
    resolveRealPath(repoRoot),
    resolveRealPath(directory),
  ]);
  const isRepoRoot = effectiveDirectory === effectiveRepoRoot;

  const gitDirResult = await runCommand("git", ["rev-parse", "--git-dir"], { cwd: directory });
  const gitDir =
    gitDirResult.exitCode === 0 && gitDirResult.stdout ? resolveGitDirectoryPath(gitDirResult.stdout, directory) : null;

  let hasGitMetadata = false;
  if (isRepoRoot) {
    try {
      const gitStats = await stat(join(repoRoot, ".git"));
      hasGitMetadata = gitStats.isDirectory() || gitStats.isFile();
    } catch {
      hasGitMetadata = false;
    }
  } else {
    try {
      const gitStats = await stat(join(directory, ".git"));
      hasGitMetadata = gitStats.isDirectory() || gitStats.isFile();
    } catch {
      hasGitMetadata = false;
    }
  }

  const branchResult = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: directory });
  const headRef = branchResult.exitCode === 0 && branchResult.stdout ? branchResult.stdout : null;
  const currentBranch = headRef && headRef !== "HEAD" ? headRef : null;

  const worktreeList = await runCommand("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  const worktrees =
    worktreeList.exitCode === 0 ? parseGitWorktreeList(worktreeList.stdout, repoRoot) : [];
  const worktreeError =
    worktreeList.exitCode === 0 ? null : worktreeList.stderr || worktreeList.stdout || null;

  const worktreeBase = normalize(join(repoRoot, ".worktrees"));

  return {
    isRepository: true,
    repoRoot,
    isRepoRoot,
    hasGitMetadata,
    gitDir,
    currentBranch,
    headRef,
    worktrees,
    worktreeBase,
    worktreeError,
  };
};

type CreateWorktreeOptions = {
  directory: string;
  branch: string;
  startPoint: string | null;
};

type CreateWorktreeResult = {
  branch: string;
  path: string;
  repository: GitRepositorySummary | null;
};

const ensureBranchNameValid = async (repoRoot: string, branch: string) => {
  const trimmed = branch.trim();
  if (!trimmed) {
    throw new Error("Branch name is required");
  }
  const check = await runCommand("git", ["check-ref-format", "--branch", trimmed], { cwd: repoRoot });
  if (check.exitCode !== 0) {
    const message = check.stderr || check.stdout || "Invalid branch name";
    throw new Error(message);
  }
};

const branchExists = async (repoRoot: string, branch: string): Promise<boolean> => {
  const result = await runCommand("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot });
  return result.exitCode === 0;
};

const ensureStartPointResolvable = async (repoRoot: string, reference: string) => {
  const result = await runCommand("git", ["rev-parse", "--verify", "--quiet", reference], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    const message = result.stderr || result.stdout || `Cannot resolve start point '${reference}'`;
    throw new Error(message);
  }
};

const createGitWorktree = async ({ directory, branch, startPoint }: CreateWorktreeOptions): Promise<CreateWorktreeResult> => {
  const repository = await describeGitRepository(directory);
  if (!repository) {
    throw new Error("Git repository not detected in the selected directory");
  }

  if (!repository.isRepoRoot) {
    throw new Error("Worktrees can only be created from the repository root");
  }

  if (!repository.hasGitMetadata) {
    throw new Error("The selected directory does not contain a .git folder");
  }

  const repoRoot = repository.repoRoot;
  const branchName = branch.trim();

  await ensureBranchNameValid(repoRoot, branchName);

  const expectedWorktreePath = normalize(join(repoRoot, ".worktrees", branchName));

  const existingWorktree = repository.worktrees.find(
    (worktree) => worktree.branch === branchName || worktree.path === expectedWorktreePath,
  );
  if (existingWorktree) {
    throw new Error(`Branch '${branchName}' is already in use by a worktree at ${existingWorktree.path}`);
  }

  try {
    const stats = await stat(expectedWorktreePath);
    if (stats.isDirectory() || stats.isFile()) {
      throw new Error(`A path already exists at ${expectedWorktreePath}`);
    }
  } catch {
    // ignore ENOENT
  }

  await mkdir(dirname(expectedWorktreePath), { recursive: true });

  const exists = await branchExists(repoRoot, branchName);
  const baseRef =
    exists && startPoint ? startPoint.trim() : startPoint?.trim() || repository.currentBranch || repository.headRef || "HEAD";

  if (!exists) {
    await ensureStartPointResolvable(repoRoot, baseRef);
  }

  const args = ["worktree", "add"];
  if (!exists) {
    args.push("-b", branchName);
  }
  args.push(expectedWorktreePath);
  if (!exists) {
    args.push(baseRef);
  } else {
    args.push(branchName);
  }

  const result = await runCommand("git", args, { cwd: repoRoot });
  if (result.exitCode !== 0) {
    await rm(expectedWorktreePath, { recursive: true, force: true }).catch(() => undefined);
    const message = result.stderr || result.stdout || "Failed to create worktree";
    throw new Error(message);
  }

  const updated = await describeGitRepository(repoRoot);
  return {
    branch: branchName,
    path: expectedWorktreePath,
    repository: updated,
  };
};

const srcRoot = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const tmpRoot = normalize(join(srcRoot, "../tmp"));
const uploadsRoot = join(tmpRoot, "uploads");
const imageRoot = join(uploadsRoot, "images");
const attachmentRoot = join(uploadsRoot, "attachments");
const determineHomeDirectory = (): string => {
  const fromEnv = Bun.env.HOME?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    return homedir();
  } catch {
    return projectRoot;
  }
};

const rawHomeDirectory = determineHomeDirectory();
const homeDirectory = normalize(await realpath(rawHomeDirectory).catch(() => rawHomeDirectory));
const documentsDirectory = join(homeDirectory, "Documents");
const userDataRoot = join(documentsDirectory, "Wingman");
const userIdentityRoot = join(userDataRoot, "users");
const systemDocsRoot = homeDirectory;
const systemDocsRootBoundary = systemDocsRoot.endsWith(sep) ? systemDocsRoot : `${systemDocsRoot}${sep}`;
const require = createRequire(import.meta.url);
const resolvePackageRoot = (specifier: string) => {
  try {
    const packageJsonPath = require.resolve(`${specifier}/package.json`);
    return normalize(join(packageJsonPath, ".."));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[static] failed to resolve package root for ${specifier}: ${message}`);
    return undefined;
  }
};
const resolvedAceBuildsRoot = resolvePackageRoot("ace-builds");
const aceBuildsRoot = resolvedAceBuildsRoot ?? normalize(join(projectRoot, "node_modules", "ace-builds"));
const aceBuildsRootBoundary = aceBuildsRoot.endsWith(sep) ? aceBuildsRoot : `${aceBuildsRoot}${sep}`;
const vendorPackages: Record<string, { root: string; boundary: string; entry: string }> = {};
const registerVendorPackage = (name: string, relative: string, entry = "index.js") => {
  const root = resolvePackageRoot(name);
  if (!root) return;
  const resolved = normalize(join(root, relative));
  vendorPackages[name] = {
    root: resolved,
    boundary: resolved.endsWith(sep) ? resolved : `${resolved}${sep}`,
    entry,
  };
};
registerVendorPackage("@noble/hashes", "esm");
registerVendorPackage("@noble/ciphers", "esm");
registerVendorPackage("@scure/base", join("lib", "esm"));
registerVendorPackage("@noble/curves", "esm");
registerVendorPackage("nostr-tools", join("lib", "esm"));
registerVendorPackage("dexie", "dist", "dexie.mjs");
registerVendorPackage("alpinejs", "dist", "module.esm.js");
const publicRoot = normalize(join(projectRoot, "public"));
const publicRootBoundary = publicRoot.endsWith(sep) ? publicRoot : `${publicRoot}${sep}`;
await mkdir(documentsDirectory, { recursive: true }).catch(() => undefined);
await mkdir(userDataRoot, { recursive: true }).catch(() => undefined);
await mkdir(userIdentityRoot, { recursive: true }).catch(() => undefined);
await mkdir(uploadsRoot, { recursive: true }).catch(() => undefined);
await mkdir(imageRoot, { recursive: true }).catch(() => undefined);
await mkdir(attachmentRoot, { recursive: true }).catch(() => undefined);
const warmRestartRoot = join(homeDirectory, ".wingmen");
await mkdir(warmRestartRoot, { recursive: true }).catch(() => undefined);
const restartMarkerPath = join(warmRestartRoot, "restart.json");
const warmRestartMarker = await loadWarmRestartMarker(restartMarkerPath);

const resolveWorkspace = (context?: RequestAuthContext): WorkspaceScope => {
  const activeContext = context ?? getRequestContext();
  return resolveWorkspaceScope(config, activeContext, adminNpub, systemDocsRoot, systemDocsRootBoundary);
};


const ensureWithinAllowedDirectories = (candidate: string, scope?: WorkspaceScope) => {
  const activeScope = scope ?? resolveWorkspace();
  if (activeScope.allowedDirectories.length === 0) {
    throw new Error("No allowed directories configured");
  }

  const sanitizedCandidate = sanitizePath(candidate);
  
  if (!isAbsolute(sanitizedCandidate)) {
    throw new Error("Path must be absolute");
  }

  const normalizedCandidate = normalize(sanitizedCandidate);
  
  for (const base of activeScope.allowedDirectories) {
    const normalizedBase = normalize(base);
    if (normalizedCandidate === normalizedBase || 
        normalizedCandidate.startsWith(normalizedBase + sep)) {
      return normalizedCandidate;
    }
  }

  throw new Error(`Directory outside permitted locations: ${normalizedCandidate}`);
};
warmRestartState.marker = warmRestartMarker;

// Initialize PM2 connection
try {
  await connectPM2();
  console.log("[pm2] connected to PM2 daemon");
} catch (error) {
  console.warn(`[pm2] failed to connect to PM2: ${(error as Error).message}`);
}

const manager = new ProcessManager(config);

const wingmanMcpApiHandler = createWingmanMcpApiHandler({
  getSession: (sid: string) => manager.getSession(sid) ?? null,
  listSessions: () => manager.listSessions(),
  createSession: (agent, dir, name, explicitNpub) => manager.createSession(agent, dir, name, undefined, undefined, explicitNpub),
  stopSession: async (sid) => (await manager.stopSession(sid)) ?? null,
  scheduleArchive: (sid) => scheduleSessionArchive(sid, manager),
  getSessionLogs: (sid) => manager.getLogs(sid),
  listApps: () => appRegistry.listApps(),
  getAppStatus: (appId) => appProcessManager.getStatus(appId),
  runAppAction: (appId, action) => appProcessManager[action](appId),
  tailAppLogs: (appId, lines) => appProcessManager.tailLogs(appId, lines),
  caproverStore,
  getCaproverClient: createCaproverClientFromEnv,
  userSkillsRoot: join(homeDirectory, ".wingmen", "skills"),
  defaultSkillsRoot: join(projectRoot, "skills"),
  userSettingsStore,
  artifactsStore,
  openRouterApiKey: Bun.env.OPENROUTER_API?.trim() || null,
  findProjectByDirectory: (dir) => npubProjectStore.findByDirectory(dir),
  memoryStore,
  getWingmanNpub: () => getKeyTeleportIdentity()?.npub ?? null,
  setPinnedFile: (sid, filePath) => manager.setPinnedFile(sid, filePath),
});

// Reconcile PM2 processes with app registry
try {
  const appReconcileResult = await reconcileAppsWithPM2(appRegistry);
  if (appReconcileResult.appsReconciled > 0 || appReconcileResult.appsCleared > 0) {
    console.log(`[pm2] reconciled apps: ${appReconcileResult.appsReconciled} running, ${appReconcileResult.appsCleared} cleared`);
  }
} catch (error) {
  console.warn(`[pm2] app reconciliation failed: ${(error as Error).message}`);
}
const nightWatchDeps = {
  store: nightWatchStore,
  featureFlagStore,
  messageStore,
  promptQueueStore,
  openRouterApiKey: Bun.env.OPENROUTER_API?.trim() || null,
  openRouterBaseUrl: "https://openrouter.ai/api",
  wingmanBaseUrl: config.baseUrl,
  getSession: (sid: string) => manager.getSession(sid) ?? null,
  dispatchPrompt: (session: SessionSnapshot) => {
    void maybeAutoDispatchQueuedPrompt(session);
  },
  sendRawInput: async (session: SessionSnapshot, content: string): Promise<boolean> => {
    try {
      const agentUrl = buildAgentUrl(agentHost, session.port, "/message");
      const resp = await fetch(agentUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "raw", content }),
      });
      return resp.ok;
    } catch (err) {
      console.error(`[nightwatch] sendRawInput failed for session ${session.id}:`, err);
      return false;
    }
  },
  markDispatchCooldown: (sessionId: string) => {
    markQueueDispatchCooldown(sessionId);
  },
  onSessionComplete: (sessionId, report) => {
    // Check if this session is linked to an MG task
    const taskSession = nightWatchStore.getTaskSession(sessionId);
    if (!taskSession) return;

    console.log(`[task-executor] Session ${sessionId} completed, moving task ${taskSession.taskId} to review`);
    nightWatchStore.updateTaskSessionStatus(sessionId, "completed");

    // Move task to review in MG (fire-and-forget)
    void (async () => {
      try {
        const stateUrl = `${taskSession.mgBaseUrl}/t/${taskSession.teamSlug}/api/todos/${taskSession.taskId}/state`;
        const body = JSON.stringify({ state: "review" });
        const bodyHash = new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(body)).digest("hex");
        const { token } = await signWithWingmanKey(stateUrl, "POST", bodyHash);
        const resp = await fetch(stateUrl, {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body,
        });
        if (resp.ok) {
          console.log(`[task-executor] Moved task ${taskSession.taskId} to review`);
        } else {
          console.warn(`[task-executor] Failed to move task to review: ${resp.status}`);
        }
      } catch (err) {
        console.error(`[task-executor] Failed to move task to review:`, err);
      }
    })();
  },
};

// Task assignment listener (receives Nostr kind 9802 events)
const taskListenerFlag = featureFlagStore.getFlag("task_listener_enabled");
const taskListenerIdentity = getKeyTeleportIdentity();
if (taskListenerIdentity && config.connectRelays.length > 0 && taskListenerFlag?.state !== "off") {
  const mgBaseUrl = Bun.env.MG_BASE_URL ?? "https://mg.otherstuff.ai";

  const executor = createTaskExecutor({
    signNip98: async (url, method, bodyHash) => {
      const { token } = await signWithWingmanKey(url, method, bodyHash);
      return token;
    },
    createSession: (agent, dir, name, origin) => manager.createSession(agent, dir, name, origin),
    enableNightwatch: (sid) => nightWatchStore.enableSession(sid),
    addPrompt: (sid, content) => promptQueueStore.addPrompt(sid, { content }),
    dispatchPrompt: (session) => {
      void maybeAutoDispatchQueuedPrompt(session);
    },
    getSession: (sid) => manager.getSession(sid) ?? null,
    trackTaskSession: (params) => nightWatchStore.addTaskSession(params),
    mgBaseUrl,
    workingDirectory: config.defaultWorkingDirectory,
  });

  startTaskListener({
    secretKey: taskListenerIdentity.secretKey,
    pubkeyHex: taskListenerIdentity.pubkey,
    relays: config.connectRelays,
    onTaskAssigned: executor,
  });

  console.log(`[task-listener] MG task listener active (relays: ${config.connectRelays.length}, mgBaseUrl: ${mgBaseUrl})`);
} else if (!taskListenerIdentity) {
  console.log("[task-listener] No KEYTELEPORT_PRIVKEY configured, MG task listener disabled");
} else {
  console.log("[task-listener] No CONNECT_RELAYS configured, MG task listener disabled");
}

const wingmenRoot = join(projectRoot, ".wingmen");
const orchestratorTriggersRoot = join(wingmenRoot, "orchestrator", "triggers");
await mkdir(wingmenRoot, { recursive: true }).catch(() => undefined);
await mkdir(orchestratorTriggersRoot, { recursive: true }).catch(() => undefined);
const orchestratorRoot = join(projectRoot, "orchestrator");
const orchestratorTemplatesRoot = join(orchestratorRoot, "templates");
const orchestratorActiveRootBase = join(userDataRoot, "orchestrator", "active");
const warmRestartManagerScriptPath = join(projectRoot, "scripts", "warm-restart-manager.ts");
const maxImageSizeBytes = 10 * 1024 * 1024; // 10MB
const maxAttachmentSizeBytes = 25 * 1024 * 1024; // 25MB

const {
  ensureUserWorkspace,
  ensureImageDirectory,
  ensureAttachmentDirectory,
  createImageFilename,
  createAttachmentFilename,
  buildEscapedImageMarkdown,
  buildAgentImagePlaceholder,
  buildAgentFilePlaceholder,
} = createUploadHelpers({
  userIdentityRoot,
  attachmentRoot,
  imageRoot,
});

const shouldUseSecureCookies = () => {
  const flag = (Bun.env.IDENTITY_COOKIE_SECURE ?? Bun.env.COOKIE_SECURE ?? "").trim().toLowerCase();
  if (flag === "false" || flag === "0") return false;
  if (flag === "true" || flag === "1") return true;
  return Bun.env.NODE_ENV === "production";
};

const defaultSecurityReviewIntro =
  "Pleaese review the 01_process.md for your instructions.\n\nYou will read the process instructions in: <active_dir>\nThe sessionID you are operating in is: <sessionID>";

const defaultHighlightReportIntro =
  "Pleaese review the 01_process.md for your instructions.\n\nYou will read the process instructions in: <active_dir>\nThe sessionID you are operating in is: <sessionID>";

fileWatcherStore.ensureStopSessionWatcher();
fileWatcherStore.ensureStartSessionWatcher();

const fileWatcherRunner = new FileWatcherRunner({
  root: wingmenRoot,
  manager,
  config,
});
try {
  await fileWatcherRunner.start();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[watchers] failed to start file watcher runner: ${message}`);
}

process.on("beforeExit", () => {
  fileWatcherRunner.stop();
});

orchestratorPresetStore.ensurePreset({
  id: "security-review",
  label: "Security Review",
  agent: "codex",
  templateDir: "orchestrator/templates/0001_Review_Code",
  activeRoot: orchestratorActiveRootBase,
  directoryPrefix: "Security_Review",
  introMessage: defaultSecurityReviewIntro,
  pollTimeoutMs: 30000,
  pollIntervalMs: 250,
  retryAttempts: 10,
  retryDelayMs: 1000,
});

orchestratorPresetStore.ensurePreset({
  id: "highlight-report",
  label: "Highlight Report",
  agent: "codex",
  templateDir: "orchestrator/templates/0002_Highglight_Report",
  activeRoot: orchestratorActiveRootBase,
  directoryPrefix: "Highlight_Report",
  introMessage: defaultHighlightReportIntro,
  pollTimeoutMs: 60000,
  pollIntervalMs: 250,
  retryAttempts: 10,
  retryDelayMs: 1000,
});

const serializeSession = (session: SessionSnapshot) => ({
  ...session,
  agentRuntimeStatus: session.agentRuntimeStatus ?? null,
  identityAlias: generateIdentityAlias(session.npub ?? null),
  origin: session.origin ?? null,
});

const parseSessionOriginInput = (value: unknown): SessionOrigin | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "object") {
    throw new Error("Session origin must be an object");
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.trim() : "";
  const idRaw = record.id;
  const id =
    typeof idRaw === "string"
      ? idRaw.trim()
      : typeof idRaw === "number"
        ? String(idRaw)
        : "";
  if (!type || !id) {
    throw new Error("Session origin requires both type and id");
  }
  const origin: SessionOrigin = { type, id };
  const url = typeof record.url === "string" ? record.url.trim() : "";
  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (url) {
    origin.url = url;
  }
  if (label) {
    origin.label = label;
  }
  return origin;
};

type IdentitySummary = {
  npub: string | null;
  normalizedNpub: string | null;
  segment: string;
  alias: string;
  ports: number[];
  balance: number;
  sessionIds: string[];
  activeSessionIds: string[];
  lastSeenAt: string | null;
  dataRoot: string;
  logsRoot: string;
  attachmentsRoot: string;
  imagesRoot: string;
};

const buildIdentitySummaries = (
  activeSessions: SessionSnapshot[],
  viewerNormalizedNpub: string | null,
  options?: { includeAll?: boolean },
): IdentitySummary[] => {
  const includeAll = Boolean(options?.includeAll);
  if (!includeAll && !viewerNormalizedNpub) {
    return [];
  }

  const storedUsers = identityUserStore.listUsers();
  const portsByNormalized = new Map<string, number[]>(
    storedUsers.map((record) => [record.normalizedNpub, record.ports] as const),
  );
  const balanceByNormalized = new Map<string, number>(
    storedUsers.map((record) => [record.normalizedNpub, record.balance] as const),
  );

  const activeSessionMap = new Map(activeSessions.map((session) => [session.id, session] as const));
  type Accumulator = {
    npub: string | null;
    normalized: string | null;
    segment: string;
    alias: string;
    ports: number[];
    balance: number;
    dataRoot: string;
    logsRoot: string;
    attachmentsRoot: string;
    imagesRoot: string;
    sessionIds: Set<string>;
    activeSessionIds: Set<string>;
    lastSeenMs: number;
  };

  const summaryMap = new Map<string, Accumulator>();

  const registerSession = (npubValue: string | null, sessionId: string, startedAt: string, isActive: boolean) => {
    const normalized = normaliseNpub(npubValue);
    if (!includeAll) {
      if (!normalized || normalized !== viewerNormalizedNpub) {
        return;
      }
    }
    const key = normalized ?? "__anonymous__";
    let accumulator = summaryMap.get(key);
    if (!accumulator) {
      const segment = deriveNpubSegment(npubValue);
      const dataRoot = normalize(join(userIdentityRoot, segment));
      const logsRoot = normalize(join(dataRoot, "logs"));
      const attachmentsRoot = normalize(join(attachmentRoot, segment));
      const imagesRoot = normalize(join(imageRoot, segment));
      accumulator = {
        npub: npubValue,
        normalized,
        segment,
        alias: generateIdentityAlias(npubValue),
        ports: [],
        balance: normalized ? balanceByNormalized.get(normalized) ?? 0 : 0,
        dataRoot,
        logsRoot,
        attachmentsRoot,
        imagesRoot,
        sessionIds: new Set(),
        activeSessionIds: new Set(),
        lastSeenMs: 0,
      };
      summaryMap.set(key, accumulator);
    }
    if (normalized) {
      const storedPorts = portsByNormalized.get(normalized);
      if (storedPorts) {
        accumulator.ports = storedPorts;
      }
      if (balanceByNormalized.has(normalized)) {
        accumulator.balance = balanceByNormalized.get(normalized) ?? accumulator.balance;
      }
    }

    accumulator.sessionIds.add(sessionId);
    if (isActive) {
      accumulator.activeSessionIds.add(sessionId);
    }

    const parsed = Date.parse(startedAt);
    const timestamp = Number.isFinite(parsed) ? parsed : Date.now();
    if (timestamp > accumulator.lastSeenMs) {
      accumulator.lastSeenMs = timestamp;
    }
  };

  const storedSessions = messageStore.listSessions();
  for (const record of storedSessions) {
    const npubValue = record.npub ?? null;
    registerSession(npubValue, record.id, record.startedAt, activeSessionMap.has(record.id));
  }

  for (const session of activeSessions) {
    registerSession(session.npub ?? null, session.id, session.startedAt, true);
  }

  return Array.from(summaryMap.values())
    .map((entry) => ({
      npub: entry.npub,
      normalizedNpub: entry.normalized,
      segment: entry.segment,
      ports: entry.ports,
      sessionIds: Array.from(entry.sessionIds),
      activeSessionIds: Array.from(entry.activeSessionIds),
      lastSeenAt: entry.lastSeenMs > 0 ? new Date(entry.lastSeenMs).toISOString() : null,
      dataRoot: entry.dataRoot,
      logsRoot: entry.logsRoot,
      attachmentsRoot: entry.attachmentsRoot,
      imagesRoot: entry.imagesRoot,
      alias: entry.alias,
      balance: entry.balance,
    }))
    .sort((a, b) => {
      const left = a.normalizedNpub ?? "";
      const right = b.normalizedNpub ?? "";
      return left.localeCompare(right);
    });
};


const getViewerNormalizedNpub = (authContext: RequestAuthContext): string | null => {
  return normaliseNpub(authContext.npub ?? null);
};

type BalanceRequirementOptions = {
  feature: string;
  minimum?: number;
  message?: string;
  signinMessage?: string;
};

const ensureViewerHasBalance = (
  authContext: RequestAuthContext,
  options: BalanceRequirementOptions,
): Response | { balance: number } => {
  const { feature, minimum = 1, message, signinMessage } = options;
  const userNpub = authContext.npub ?? null;
  if (!userNpub) {
    const error = signinMessage ?? `Sign in to ${feature}.`;
    return Response.json(
      {
        error,
        balance: 0,
        required: minimum,
      },
      { status: 403 },
    );
  }

  let balance = 0;
  try {
    const record = identityUserStore.touch(userNpub);
    balance = record.balance ?? 0;
  } catch (error) {
    console.warn("[billing] unable to resolve identity during balance check:", error);
    const errorMessage = signinMessage ?? `Sign in to ${feature}.`;
    return Response.json(
      {
        error: errorMessage,
        balance: 0,
        required: minimum,
      },
      { status: 403 },
    );
  }

  if (balance < minimum) {
    const errorMessage = message ?? `Add sats to your balance to ${feature}.`;
    return Response.json(
      {
        error: errorMessage,
        balance,
        required: minimum,
      },
      { status: 402 },
    );
  }

  return { balance };
};

const sessionBelongsToViewer = (
  sessionNpub: string | null | undefined,
  viewerNormalizedNpub: string | null,
  viewerIsAdmin: boolean,
): boolean => {
  if (viewerIsAdmin) {
    return true;
  }
  if (!viewerNormalizedNpub) {
    return false;
  }
  const normalized = normaliseNpub(sessionNpub ?? null);
  if (!normalized) {
    return false;
  }
  return normalized === viewerNormalizedNpub;
};

const resolveScopedUpload = (pathname: string, authContext: RequestAuthContext, prefix: string, root: string) => {
  if (!pathname.startsWith(prefix)) return undefined;
  const relative = pathname.slice(prefix.length);
  if (!relative) return undefined;
  if (!authContext.session) return undefined;
  
  const parts = relative.split("/").filter((segment) => segment.length > 0);
  if (parts.length < 2) return undefined;

  const [segment, ...rest] = parts;
  
  if (!validatePathSegment(segment)) {
    return undefined;
  }
  
  for (const part of rest) {
    if (!validatePathSegment(part)) {
      return undefined;
    }
  }

  const expectedSegment = deriveNpubSegment(authContext.npub ?? null);
  if (!isAdminContext(authContext) && segment !== expectedSegment) {
    return undefined;
  }

  try {
    const userRoot = secureResolvePath(root, segment);
    const relativePath = rest.join(sep);
    const sanitizedRelative = sanitizePath(relativePath);
    const fullPath = secureResolvePath(userRoot, sanitizedRelative);

    const file = Bun.file(fullPath);
    if (file.size === 0) return undefined;

    return { file, fullPath };
  } catch (error) {
    console.warn("[security] Path traversal attempt in upload:", error);
    return undefined;
  }
};

const resolveTempImage = (pathname: string, authContext: RequestAuthContext) => {
  const resolved = resolveScopedUpload(pathname, authContext, "/uploads/images/", imageRoot);
  if (!resolved) return undefined;
  const { file } = resolved;
  return new Response(file, {
    headers: {
      ...(file.type ? { "content-type": file.type } : {}),
      "cache-control": "no-store",
    },
  });
};

const resolveTempAttachment = (pathname: string, authContext: RequestAuthContext) => {
  const resolved = resolveScopedUpload(pathname, authContext, "/uploads/files/", attachmentRoot);
  if (!resolved) return undefined;
  const { file } = resolved;
  return new Response(file, {
    headers: {
      ...(file.type ? { "content-type": file.type } : {}),
      "cache-control": "no-store",
    },
  });
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

scheduleCleanup({ root: imageRoot, ttlMs: ONE_DAY_MS, intervalMs: ONE_DAY_MS, label: "image" });
scheduleCleanup({ root: attachmentRoot, ttlMs: ONE_DAY_MS, intervalMs: ONE_DAY_MS, label: "attachment" });

manager.on((event) => {
  if (event.type === "session-started") {
    ensureUserWorkspace(event.session.npub ?? null);
    if (event.session.npub) {
      try {
        identityUserStore.touch(event.session.npub, {
          alias: generateIdentityAlias(event.session.npub),
          lastSeenAt: new Date().toISOString(),
        });
      } catch (error) {
        console.warn(`[admin] failed to record identity ${event.session.npub}:`, error);
      }
      // Auto-generate bot key if user doesn't have one yet
      try {
        const existingBotKey = botKeyStore.getActiveKeyForUser(event.session.npub);
        if (!existingBotKey) {
          const decoded = nip19.decode(event.session.npub);
          if (decoded.type === "npub") {
            const userPubkeyHex = decoded.data as string;
            const generated = generateBotKey(userPubkeyHex);
            botKeyStore.createKey({
              userNpub: event.session.npub,
              botPubkeyHex: generated.botPubkeyHex,
              botNpub: generated.botNpub,
              encryptedToUser: generated.encryptedToUser,
              encryptedEscrow: generated.encryptedEscrow,
              escrowUuid: generated.escrowUuid,
            });
            console.log(`[bot-key] Generated bot key for ${event.session.npub.slice(0, 20)}…: ${generated.botNpub.slice(0, 20)}…`);
          }
        }
      } catch (error) {
        console.warn(`[bot-key] Failed to auto-generate bot key for ${event.session.npub}:`, error);
      }
      // Trigger SSE auto-unlock if bot key exists but isn't in memory
      try {
        if (!isBotKeyUnlocked(event.session.npub)) {
          const botRecord = botKeyStore.getActiveKeyForUser(event.session.npub);
          if (botRecord) {
            const rootIdentity = getKeyTeleportIdentity();
            if (rootIdentity && browserSubscribers.hasSubscriber(event.session.npub)) {
              browserSubscribers.send(event.session.npub, {
                type: "botkey:decrypt_request",
                encryptedToUser: botRecord.encryptedToUser,
                senderPubkey: rootIdentity.pubkey,
                botPubkeyHex: botRecord.botPubkeyHex,
              });
              console.log(`[bot-key] Sent decrypt request to browser for ${event.session.npub.slice(0, 20)}…`);
            }
          }
        }
      } catch (error) {
        console.warn(`[bot-key] Failed to send decrypt request:`, error);
      }
    }
    messageStore.recordSession({
      id: event.session.id,
      agent: event.session.agent,
      startedAt: event.session.startedAt,
      name: event.session.name,
      npub: event.session.npub,
      port: event.session.port,
      pid: event.session.pid,
      workingDirectory: event.session.workingDirectory,
      command: event.session.command,
      runtimeStatus: event.session.agentRuntimeStatus ?? null,
      origin: event.session.origin ?? null,
      pm2Name: event.session.pm2Name,
    });
    messageStore.replaceMessages(event.session.id, []);
    void maybeAutoDispatchQueuedPrompt(event.session);
    // Broadcast to browser so home page / nav live-refresh
    if (event.session.npub) {
      sessionBroadcaster.broadcast(event.session.npub, {
        type: "session-started",
        sessionId: event.session.id,
        agent: event.session.agent,
        name: event.session.name ?? undefined,
      });
    }
    return;
  }
  if (event.type === "session-deleted") {
    clearPromptStartupReady(event.session.id);
    // Session archived and removed from memory — notify browsers to refresh
    if (event.session.npub) {
      sessionBroadcaster.broadcast(event.session.npub, {
        type: "session-deleted",
        sessionId: event.session.id,
        agent: event.session.agent,
        name: event.session.name ?? undefined,
      });
    }
    return;
  }
  if (event.type === "session-updated" || event.type === "session-stopped") {
    ensureUserWorkspace(event.session.npub ?? null);
    if (event.session.npub) {
      try {
        identityUserStore.touchExisting(event.session.npub, {
          lastSeenAt: new Date().toISOString(),
        });
      } catch (error) {
        console.warn(`[admin] failed to update identity ${event.session.npub}:`, error);
      }
      // Clear bot key from memory when last session for this user stops
      if (event.type === "session-stopped") {
        clearPromptStartupReady(event.session.id);
        const userNpub = event.session.npub;
        const otherActive = manager.listSessions().some(
          (s) => s.npub === userNpub && s.id !== event.session.id,
        );
        const hasEnabledNostrTrigger = shouldKeepBotKeyForNostrTriggers(schedulerStore, userNpub);
        if (!otherActive && !hasEnabledNostrTrigger) {
          clearBotKey(userNpub);
          triggerListener.unsubscribe(userNpub);
        } else if (!otherActive && hasEnabledNostrTrigger) {
          console.log(`[trigger-listener] Keeping bot key unlocked for ${userNpub.slice(0, 20)}… (enabled nostr trigger)`);
        }
      }
    }
    messageStore.recordSession({
      id: event.session.id,
      agent: event.session.agent,
      startedAt: event.session.startedAt,
      name: event.session.name,
      npub: event.session.npub,
      port: event.session.port,
      pid: event.session.pid,
      workingDirectory: event.session.workingDirectory,
      command: event.session.command,
      runtimeStatus: event.session.agentRuntimeStatus ?? null,
      origin: event.session.origin ?? null,
      pm2Name: event.session.pm2Name,
    });
    void maybeAutoDispatchQueuedPrompt(event.session);
    // Broadcast to browser so home page / nav live-refresh
    if (event.session.npub) {
      sessionBroadcaster.broadcast(event.session.npub, {
        type: event.type as "session-updated" | "session-stopped",
        sessionId: event.session.id,
        agent: event.session.agent,
        name: event.session.name ?? undefined,
        status: event.session.agentRuntimeStatus ?? undefined,
      });
    }
  }
});

const MAX_DIRECTORY_RESULTS = 50;
const DIRECTORY_BROWSER_ROOT = "__root__";

const expandHomeDirectory = (input: string): string => {
  if (!input.startsWith("~")) {
    return input;
  }
  const home = Bun.env.HOME ?? "";
  return home ? input.replace("~", home) : input;
};

const toAbsoluteDirectory = (input: string, scope?: WorkspaceScope): string => {
  const activeScope = scope ?? resolveWorkspace();
  const expanded = expandHomeDirectory(input);
  const candidate = isAbsolute(expanded)
    ? expanded
    : resolvePath(activeScope.defaultDirectory, expanded);
  const normalised = normalize(candidate);
  ensureWithinAllowedDirectories(normalised, activeScope);
  return normalised;
};

const formatHomeRelativePath = (absolute: string): string => {
  try {
    const home = homedir();
    if (!home) {
      return absolute;
    }
    const normalisedHome = normalize(home);
    if (absolute === normalisedHome) {
      return "~";
    }
    const prefix = normalisedHome.endsWith(sep) ? normalisedHome : `${normalisedHome}${sep}`;
    if (absolute.startsWith(prefix)) {
      const suffix = absolute.slice(prefix.length);
      return suffix.length > 0 ? `~${sep}${suffix}` : "~";
    }
  } catch {
    // Ignore homedir resolution errors and fall back to the basename below.
  }
  return absolute;
};

const formatRootDirectoryName = (absolute: string): string => {
  const homeRelative = formatHomeRelativePath(absolute);
  if (homeRelative !== absolute) {
    return homeRelative;
  }
  const name = basename(absolute);
  return name.length > 0 ? name : absolute;
};

const ensureDirectory = async (
  input: string | null | undefined,
  scopeOverride?: WorkspaceScope,
): Promise<string> => {
  const activeScope = scopeOverride ?? resolveWorkspace();
  const source = input?.trim();
  const candidate = source && source.length > 0 ? source : activeScope.defaultDirectory;
  const absolute = toAbsoluteDirectory(candidate, activeScope);
  let resolved = absolute;

  try {
    resolved = await realpath(absolute);
  } catch {
    // realpath fails when the directory does not exist; keep the normalized path.
    resolved = absolute;
  } finally {
    ensureWithinAllowedDirectories(resolved, activeScope);
  }

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(resolved);
  } catch {
    throw new Error(`Directory not found: ${resolved}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }

  return resolved;
};

const listRootDirectories = async (query?: string, scopeOverride?: WorkspaceScope) => {
  const activeScope = scopeOverride ?? resolveWorkspace();
  const term = query?.trim().toLowerCase() ?? "";
  const seen = new Set<string>();
  const entries: Array<{ name: string; path: string }> = [];

  for (const absolute of activeScope.allowedDirectories) {
    if (seen.has(absolute)) {
      continue;
    }
    seen.add(absolute);
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(absolute);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) {
      continue;
    }
    entries.push({
      name: formatRootDirectoryName(absolute),
      path: absolute,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  const filtered = term.length === 0
    ? entries
    : entries.filter((entry) =>
        entry.name.toLowerCase().includes(term) || entry.path.toLowerCase().includes(term),
      );

  const limited = term.length === 0 ? filtered : filtered.slice(0, MAX_DIRECTORY_RESULTS);

  return {
    path: "",
    parent: null as string | null,
    entries: limited,
  };
};

const resolveDirectoryParent = (directory: string, scopeOverride?: WorkspaceScope): string | null => {
  const activeScope = scopeOverride ?? resolveWorkspace();
  for (const allowed of activeScope.allowedDirectories) {
    if (directory === allowed) {
      return DIRECTORY_BROWSER_ROOT;
    }
  }

  const candidate = dirname(directory);
  if (candidate === directory) {
    return null;
  }

  try {
    ensureWithinAllowedDirectories(candidate, activeScope);
    return candidate;
  } catch {
    return DIRECTORY_BROWSER_ROOT;
  }
};

const DIRECTORY_NAME_MAX_LENGTH = 160;

const normaliseDirectoryEntryName = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new Error("Folder name is required");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Folder name is required");
  }
  if (trimmed.length > DIRECTORY_NAME_MAX_LENGTH) {
    throw new Error("Folder name is too long");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error("Folder name is not allowed");
  }
  if (/[\\/]/.test(trimmed)) {
    throw new Error("Folder name cannot contain path separators");
  }
  return trimmed;
};


const createDirectoryEntry = async (parentInput: string | null | undefined, nameInput: unknown) => {
  const parentDirectory = await ensureDirectory(parentInput);
  const name = normaliseDirectoryEntryName(nameInput);
  const target = normalize(join(parentDirectory, name));
  const parentWithSep = parentDirectory.endsWith(sep) ? parentDirectory : `${parentDirectory}${sep}`;
  if (!target.startsWith(parentWithSep)) {
    throw new Error("Invalid directory path");
  }

  try {
    await mkdir(target, { recursive: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      throw new Error("A file or directory with that name already exists");
    }
    throw new Error(`Failed to create directory: ${(error as Error).message ?? "unknown error"}`);
  }

  return {
    path: target,
    name,
  };
};


const directoryExists = async (path: string): Promise<boolean> => {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
};

const formatDateYYMMDD = (date: Date): string => {
  const year = date.getFullYear() % 100;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${year.toString().padStart(2, "0")}${month.toString().padStart(2, "0")}${day
    .toString()
    .padStart(2, "0")}`;
};

const resolveProjectPath = (input: string | null | undefined): string | null => {
  const value = input?.trim();
  if (!value) {
    return null;
  }
  if (isAbsolute(value)) {
    return normalize(value);
  }
  return normalize(join(projectRoot, value));
};

const sanitiseDirectoryPrefix = (value: string | null | undefined): string => {
  const candidate = value?.trim();
  if (!candidate) {
    return "Preset";
  }
  return candidate
    .replace(/[^a-zA-Z0-9/_-]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "") || "Preset";
};

const normaliseOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const SESSION_NAME_MAX_LENGTH = 120;

const normaliseSessionNameInput = (value: unknown): string | null => {
  const text = normaliseOptionalString(value);
  if (!text) {
    return null;
  }
  return text.length > SESSION_NAME_MAX_LENGTH ? text.slice(0, SESSION_NAME_MAX_LENGTH) : text;
};

type SessionWorkspaceRequest =
  | {
      mode: "worktree";
      name: string;
    }
  | null;

const parseSessionWorkspaceRequest = (input: unknown): SessionWorkspaceRequest => {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const mode = normaliseOptionalString(candidate.mode);
  if (!mode) {
    return null;
  }
  if (mode === "worktree") {
    const name = normaliseOptionalString(candidate.name);
    if (!name) {
      throw new Error("Worktree name is required to create a new worktree");
    }
    return { mode: "worktree", name };
  }
  throw new Error(`Unsupported workspace mode: ${mode}`);
};

const resolveSessionWorkingDirectory = async (
  directoryInput: string | undefined,
  workspace: SessionWorkspaceRequest,
): Promise<string> => {
  const baseDirectory = await ensureDirectory(directoryInput);
  if (!workspace) {
    return baseDirectory;
  }

  if (workspace.mode === "worktree") {
    const worktree = await createGitWorktree({
      directory: baseDirectory,
      branch: workspace.name,
      startPoint: null,
    });
    return worktree.path;
  }

  return baseDirectory;
};

const parsePresetInteger = (value: unknown, fallback: number, minimum?: number): number => {
  const numeric =
    typeof value === "number"
      ? Number.isFinite(value)
        ? Math.trunc(value)
        : NaN
      : typeof value === "string" && value.trim().length > 0
        ? Number.parseInt(value, 10)
        : NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  if (typeof minimum === "number" && numeric < minimum) {
    return fallback;
  }
  return numeric;
};

const toProjectRelativePath = (absolute: string): string => {
  const normalized = normalize(absolute);
  if (!normalized.startsWith(projectRoot)) {
    return normalized;
  }
  if (normalized === projectRoot) {
    return ".";
  }
  const offset = projectRoot.endsWith("/") ? projectRoot.length : projectRoot.length + 1;
  return normalized.slice(offset);
};

const ensureWithinBase = (absolute: string, base: string) => {
  const normalized = normalize(absolute);
  const normalizedBase = normalize(base);
  if (!normalized.startsWith(normalizedBase)) {
    throw new Error("Invalid directory path");
  }
  return normalized;
};

const listOrchestratorDirectories = async (target: "templates" | "active", relativeInput: string | null) => {
  const base = target === "templates" ? orchestratorTemplatesRoot : orchestratorActiveRootBase;
  await mkdir(base, { recursive: true });

  let resolved = base;
  if (relativeInput) {
    const candidate = join(projectRoot, relativeInput);
    resolved = ensureWithinBase(candidate, base);
  }

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(resolved);
  } catch (error) {
    throw new Error(`Directory not found: ${toProjectRelativePath(resolved)}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Path is not a directory: ${toProjectRelativePath(resolved)}`);
  }

  const entriesRaw = await readdir(resolved, { withFileTypes: true });
  const entries = entriesRaw
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const absolutePath = join(resolved, entry.name);
      return {
        name: entry.name,
        path: toProjectRelativePath(absolutePath),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = resolved === base ? null : toProjectRelativePath(dirname(resolved));

  return {
    target,
    path: toProjectRelativePath(resolved),
    parent,
    entries,
  };
};

const generatePresetDirectory = async (preset: OrchestratorPresetRecord): Promise<string> => {
  const templateDir = resolveProjectPath(preset.templateDir);
  if (!templateDir) {
    throw new Error(`Template directory not configured for preset ${preset.id}`);
  }

  const templateStats = await stat(templateDir).catch(() => null);
  if (!templateStats || !templateStats.isDirectory()) {
    throw new Error(`Template directory not found for preset ${preset.id}: ${templateDir}`);
  }

  const activeRoot = resolveProjectPath(preset.activeRoot);
  if (!activeRoot) {
    throw new Error(`Active root not configured for preset ${preset.id}`);
  }

  await mkdir(activeRoot, { recursive: true });

  const now = new Date();
  const dateSegment = formatDateYYMMDD(now);
  const prefix = sanitiseDirectoryPrefix(preset.directoryPrefix);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const idSegment = Math.floor(Math.random() * 100_000_000)
      .toString()
      .padStart(8, "0");
    const directoryName = `${dateSegment}_${prefix}_${idSegment}`;
    const target = join(activeRoot, directoryName);
    if (await directoryExists(target)) {
      continue;
    }
    await cp(templateDir, target, { recursive: true, force: false });
    return target;
  }

  throw new Error(`Unable to allocate unique directory for preset ${preset.id}`);
};

const preparePresetWorkingDirectory = async (preset: OrchestratorPresetRecord): Promise<string> => {
  if (preset.templateDir) {
    return generatePresetDirectory(preset);
  }

  const directoryInput = preset.workingDirectory ?? null;
  return ensureDirectory(directoryInput);
};

const waitForAgentReady = async (
  session: SessionSnapshot,
  timeoutMs: number | null | undefined,
  pollIntervalMs: number | null | undefined,
) => {
  await waitForAgentReadyCore(agentHost, session.port, session.agent, {
    timeoutMs,
    pollIntervalMs,
  });
};

const renderPresetMessage = (template: string, session: SessionSnapshot): string => {
  const replacements: Array<{ regex: RegExp; value: string }> = [
    { regex: /<working_dir>/gi, value: session.workingDirectory },
    { regex: /{{\s*working_dir\s*}}/gi, value: session.workingDirectory },
    { regex: /<active_dir>/gi, value: session.workingDirectory },
    { regex: /{{\s*active_dir\s*}}/gi, value: session.workingDirectory },
    { regex: /<session[_]?id>/gi, value: session.id },
    { regex: /{{\s*session[_]?id\s*}}/gi, value: session.id },
  ];

  return replacements.reduce((content, { regex, value }) => content.replace(regex, value), template);
};

const sendPresetIntroMessage = async (
  session: SessionSnapshot,
  message: string | null | undefined,
  retryAttempts: number | null | undefined,
  retryDelayMs: number | null | undefined,
) => {
  const contentTemplate = message?.trim();
  if (!contentTemplate) {
    return false;
  }

  const content = renderPresetMessage(contentTemplate, session);
  const attempts = typeof retryAttempts === "number" && retryAttempts > 0 ? retryAttempts : 10;
  const delay = typeof retryDelayMs === "number" && retryDelayMs >= 0 ? retryDelayMs : 1000;

  try {
    await sendAgentMessage(agentHost, session.port, content, {
      attempts,
      delayMs: delay,
      type: "user",
    });
    await syncSessionMessages(session.id, true);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to deliver introductory message: ${message}`);
  }
};

const initialisePresetSession = async (preset: OrchestratorPresetRecord, session: SessionSnapshot) => {
  try {
    await waitForAgentReady(session, preset.pollTimeoutMs, preset.pollIntervalMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[orchestrator] failed to wait for agent readiness for preset ${preset.id}: ${message}`);
    return;
  }

  try {
    const sent = await sendPresetIntroMessage(
      session,
      preset.introMessage,
      preset.retryAttempts,
      preset.retryDelayMs,
    );
    if (!sent) {
      await syncSessionMessages(session.id, true);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[orchestrator] failed to deliver intro message for preset ${preset.id}: ${message}`);
    await syncSessionMessages(session.id, true).catch(() => undefined);
  }
};

const launchOrchestratorPreset = async (presetId: string) => {
  const preset = orchestratorPresetStore.getPreset(presetId);
  if (!preset) {
    throw new Error(`Preset not found: ${presetId}`);
  }

  if (!isAgentType(preset.agent)) {
    throw new Error(`Invalid agent configured for preset ${preset.id}: ${preset.agent}`);
  }

  const workingDirectory = await preparePresetWorkingDirectory(preset);
  const sessionName = normaliseSessionNameInput(preset.label);
  const session = await manager.createSession(
    preset.agent as AgentType,
    workingDirectory,
    sessionName ?? undefined,
  );
  ensureUserWorkspace(session.npub ?? null);
  messageStore.recordSession({
    id: session.id,
    agent: session.agent,
    startedAt: session.startedAt,
    name: session.name,
    npub: session.npub,
    port: session.port,
    pid: session.pid,
    workingDirectory: session.workingDirectory,
    command: session.command,
    runtimeStatus: session.agentRuntimeStatus ?? null,
    origin: session.origin ?? null,
    pm2Name: session.pm2Name,
  });
  void initialisePresetSession(preset, session);
  return { directory: workingDirectory, session };
};

const stopAndRemoveSession = async (sessionId: string) => {
  const existing = manager.getSession(sessionId);
  if (!existing) {
    messageStore.removeSession(sessionId);
    return false;
  }

  if (existing.status === "starting" || existing.status === "running") {
    try {
      await manager.stopSession(sessionId);
    } catch (error) {
      throw new Error(`Failed to stop session ${sessionId}: ${(error as Error).message}`);
    }
  }

  try {
    manager.deleteSession(sessionId);
  } catch (error) {
    throw new Error(`Failed to delete session ${sessionId}: ${(error as Error).message}`);
  }

  messageStore.removeSession(sessionId);
  return true;
};

const stopSessionsForUser = async (npub: string | null | undefined) => {
  const normalized = normaliseNpub(npub ?? null);
  if (!normalized) {
    return;
  }
  const sessionIds = new Set<string>();
  const activeSessions = manager.listSessions();
  for (const session of activeSessions) {
    const sessionNpub = normaliseNpub(session.npub ?? null);
    if (sessionNpub && sessionNpub === normalized) {
      sessionIds.add(session.id);
    }
  }
  const storedSessions = messageStore.listSessions();
  for (const record of storedSessions) {
    const recordNpub = normaliseNpub(record.npub ?? null);
    if (recordNpub && recordNpub === normalized) {
      sessionIds.add(record.id);
    }
  }
  for (const id of sessionIds) {
    await stopAndRemoveSession(id);
  }
};

const handleWebhookRequest = async (request: Request, url: URL): Promise<Response | null> => {
  const pathname = url.pathname;
  if (pathname === "/v1/api/webhook/off" && request.method === "POST") {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const data = payload as Record<string, unknown>;
    const sessionId =
      normaliseOptionalString(data["session-id"]) ??
      normaliseOptionalString(data.sessionId) ??
      normaliseOptionalString(data.session_id);

    if (!sessionId) {
      return Response.json({ error: "session-id is required" }, { status: 400 });
    }

    const state = normaliseOptionalString(data.state);
    if (state && state.toLowerCase() !== "off") {
      return Response.json({ error: "Unsupported state. Only 'off' is accepted." }, { status: 400 });
    }

    try {
      const removed = await stopAndRemoveSession(sessionId);
      if (!removed) {
        return Response.json({ status: "ignored", reason: "session-not-found" }, { status: 404 });
      }
      return Response.json({ status: "ok", sessionId }, { status: 200 });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  }

  return null;
};

const listDirectories = async (
  input: string | null | undefined,
  query?: string,
  scopeOverride?: WorkspaceScope,
) => {
  const activeScope = scopeOverride ?? resolveWorkspace();
  const trimmed = input?.trim() ?? "";
  if (trimmed.length === 0 || trimmed === DIRECTORY_BROWSER_ROOT) {
    return listRootDirectories(query, activeScope);
  }

  const directory = await ensureDirectory(trimmed, activeScope);
  const entries = await readdir(directory, { withFileTypes: true });
  const term = query?.toLowerCase().trim();

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: normalize(join(directory, entry.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((entry) => {
      if (!term) return true;
      return entry.name.toLowerCase().includes(term);
    });

  const limitedDirectories = term ? directories.slice(0, MAX_DIRECTORY_RESULTS) : directories;

  const parent = resolveDirectoryParent(directory, activeScope);

  return {
    path: directory,
    parent,
    entries: limitedDirectories,
  };
};

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

const assetService = createStaticAssetService({
  publicRoot,
  publicRootBoundary,
  aceRoot: aceBuildsRoot,
  aceRootBoundary: aceBuildsRootBoundary,
  vendorPackages,
});

// Asset version — increment to bust browser caches after deploys.
const ASSET_VERSION = "11";

const serveIndex = async () => {
  const url = new URL("./ui/index.html", import.meta.url);
  let html = await Bun.file(url).text();
  // Append cache-busting version to main asset URLs
  html = html.replace(
    /href="\/styles\.css"/,
    `href="/styles.css?v=${ASSET_VERSION}"`,
  );
  html = html.replace(
    /src="\/app\.js"/,
    `src="/app.js?v=${ASSET_VERSION}"`,
  );
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
};

const isAgentType = (value: string): value is AgentType => {
  return SUPPORTED_AGENT_TYPES.includes(value as AgentType);
};

const agentHosts = parseAllowedHosts(config.allowedHosts);
const agentHost = normaliseHostForUrl(pickAgentHost(agentHosts));

await rehydrateWarmSessions(
  warmRestartMarker,
  restartMarkerPath,
  agentHost,
  manager,
  ensureUserWorkspace,
  config.defaultWorkingDirectory,
  messageStore,
  SUPPORTED_AGENT_TYPES,
);

// Auto-rehydrate orphaned sessions that survived a restart
await rehydrateOrphanedSessions(
  agentHost,
  manager,
  ensureUserWorkspace,
  config.defaultWorkingDirectory,
  messageStore,
  SUPPORTED_AGENT_TYPES,
  24, // Look for sessions started in the last 24 hours
);

// SSE handler for session events
const handleSessionEvents = createSessionEventsHandler({
  manager,
  agentHost,
  sseKeepaliveIntervalMs: config.sseKeepaliveIntervalMs,
});

const syncSessionMessages = async (sessionId: string, force = false) => {
  if (!force && messageStore.hasMessages(sessionId)) {
    return messageStore.listSessionMessages(sessionId);
  }

  const session = manager.getSession(sessionId);
  if (!session) {
    return messageStore.listSessionMessages(sessionId);
  }

  if (session.status !== "running") {
    return messageStore.listSessionMessages(sessionId);
  }

  try {
    const messages = await fetchAgentMessages(agentHost, session.port);
    messageStore.replaceMessages(sessionId, messages);
  } catch (error) {
    console.error(`Failed to synchronise messages for session ${sessionId}:`, error);
  }

  return messageStore.listSessionMessages(sessionId);
};

const agentStatusPoller = new AgentRuntimeStatusPoller(manager, {
  host: agentHost,
  intervalMs: config.agentStatusPollIntervalMs,
  maxIntervalMs: config.agentStatusPollMaxIntervalMs,
  timeoutMs: config.agentStatusPollTimeoutMs,
  initialDelayMs: 3000,
});
agentStatusPoller.start();

const promptDispatchEngine = createPromptDispatchEngine({
  manager,
  agentHost,
  messageStore,
  identityUserStore,
  promptQueueStore,
  MESSAGE_COST_SATS,
  buildAgentUrl,
  waitForSessionPromptReadiness,
  syncSessionMessages,
  maybeTriggerNightWatch,
  nightWatchDeps,
});
const {
  dispatchNextQueuedPromptForSession,
  maybeAutoDispatchQueuedPrompt,
  markPromptStartupReady,
  clearPromptStartupReady,
  markQueueDispatchCooldown,
  queueDispatchInFlight,
  waitForMessageUpdate,
} = promptDispatchEngine;

const APP_ACTIONS: AppLifecycleAction[] = ["start", "stop", "restart", "setup", "build"];

const parseAppScripts = (input: unknown): AppLifecycleScripts => {
  const scripts: AppLifecycleScripts = {};
  if (!input || typeof input !== "object") {
    return scripts;
  }
  for (const action of APP_ACTIONS) {
    const value = normaliseOptionalString((input as Record<string, unknown>)[action]);
    if (value) {
      scripts[action] = value;
    }
  }
  return scripts;
};

const parseBooleanFlag = (value: string | null): boolean => {
  if (!value) return false;
  const flag = value.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes" || flag === "on";
};

const parseBooleanInput = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "1" || trimmed === "true" || trimmed === "yes" || trimmed === "on") {
      return true;
    }
    if (trimmed === "0" || trimmed === "false" || trimmed === "no" || trimmed === "off") {
      return false;
    }
  }
  return undefined;
};

const parsePortInput = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return null;
};

const WEB_APP_PORT_PLACEHOLDER = "<port>";

type BuildAppResponseOptions = {
  ownerAlias?: string | null;
  subdomainAlias?: string | null;
};

const buildHostedWebAppUrl = (port: number | null): string | null => {
  if (typeof port !== "number" || !Number.isFinite(port)) {
    return null;
  }
  const normalizedPort = Math.trunc(port);
  if (normalizedPort <= 0) {
    return null;
  }
  const base = config.hostUrlBase ?? "";
  const trimmed = base.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes(WEB_APP_PORT_PLACEHOLDER)) {
    return trimmed.replaceAll(WEB_APP_PORT_PLACEHOLDER, String(normalizedPort));
  }
  const separator = trimmed.endsWith("/") ? "" : "/";
  return `${trimmed}${separator}${normalizedPort}`;
};

const resolveOwnerAlias = (ownerNpub: string | null | undefined): string | null => {
  if (!ownerNpub) {
    return null;
  }
  const record = identityUserStore.getByNormalized(ownerNpub);
  return record?.alias ?? null;
};

const resolveOwnerAliasCached = (
  ownerNpub: string | null | undefined,
  cache: Map<string, string | null>,
): string | null => {
  if (!ownerNpub) {
    return null;
  }
  if (cache.has(ownerNpub)) {
    return cache.get(ownerNpub) ?? null;
  }
  const alias = resolveOwnerAlias(ownerNpub);
  cache.set(ownerNpub, alias);
  return alias;
};

type AppOwnerFilterOption = {
  value: string;
  label: string;
  npub: string | null;
  alias: string | null;
  appCount: number;
};

const buildAppOwnerFilters = (
  apps: AppRecord[],
  cache: Map<string, string | null>,
): AppOwnerFilterOption[] => {
  const map = new Map<
    string,
    { value: string; npub: string | null; alias: string | null; appCount: number }
  >();
  for (const app of apps) {
    const normalizedOwner = normaliseNpub(app.ownerNpub ?? null);
    const key = normalizedOwner ?? "__anonymous__";
    let entry = map.get(key);
    if (!entry) {
      entry = {
        value: key,
        npub: normalizedOwner,
        alias: resolveOwnerAliasCached(app.ownerNpub ?? null, cache),
        appCount: 0,
      };
      map.set(key, entry);
    }
    entry.appCount += 1;
  }
  return Array.from(map.values()).map((entry) => ({
    value: entry.value,
    npub: entry.npub,
    alias: entry.alias,
    appCount: entry.appCount,
    label: entry.alias ?? (entry.npub ?? "Anonymous"),
  }));
};

const defaultAppProcessStatus = (appId: string): AppProcessStatus => {
  const timestamp = new Date().toISOString();
  return {
    appId,
    status: "idle",
    lastAction: null,
    lastExitCode: null,
    message: undefined,
    updatedAt: timestamp,
    lastSuccessAt: undefined,
    lastFailureAt: undefined,
    running: false,
    inProgressAction: null,
  };
};

const buildSubdomainUrl = (alias: string | null): string | null => {
  if (!alias || !config.subdomainBaseDomain) {
    return null;
  }
  // Build URL like https://bold-gem-boat.apps.example.com
  return `https://${alias}.${config.subdomainBaseDomain}`;
};

/**
 * Build the app host URL based on routing mode.
 * - PATH mode: /host/<alias> (relative, will be resolved against current origin)
 * - SUBDOMAIN mode: https://<alias>.<baseDomain>
 */
const buildAppHostUrl = (alias: string | null): string | null => {
  if (!alias) {
    return null;
  }

  if (config.appRoutingMode === "path") {
    // Path-based routing: /host/<alias>
    return `/host/${alias}`;
  }

  // Subdomain mode - requires baseDomain to be configured
  if (!config.subdomainBaseDomain) {
    return null;
  }
  return `https://${alias}.${config.subdomainBaseDomain}`;
};

const buildAppResponse = (app: AppRecord, status: AppProcessStatus, options: BuildAppResponseOptions = {}) => {
  const hasStartScript = Boolean(app.scripts.start);
  const availableScripts: Record<AppLifecycleAction, boolean> = {
    start: hasStartScript,
    stop: true,
    restart: hasStartScript,
    setup: Boolean(app.scripts.setup),
    build: Boolean(app.scripts.build),
  };
  const webAppPort =
    typeof app.webAppPort === "number" && Number.isFinite(app.webAppPort) ? Math.trunc(app.webAppPort) : null;
  const webAppAlias = options.ownerAlias ?? null;
  const webAppUrl = app.webApp && webAppPort !== null ? buildHostedWebAppUrl(webAppPort) : null;
  const subdomainAlias = options.subdomainAlias ?? null;
  // Use routing-mode-aware URL builder (path or subdomain based on APP_ROUTING)
  const subdomainUrl = app.webApp ? buildAppHostUrl(subdomainAlias) : null;
  return {
    id: app.id,
    label: app.label,
    root: app.root,
    scripts: app.scripts,
    pm2Name: app.pm2Name ?? null,
    logsDir: app.logsDir ?? null,
    notes: app.notes ?? null,
    ownerNpub: app.ownerNpub,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    webApp: app.webApp,
    webAppPort,
    webAppAlias,
    webAppUrl,
    subdomainAlias,
    subdomainUrl,
    status,
    availableScripts,
    logs: undefined as string[] | undefined,
  };
};

const deriveDirectoryNameFromUrl = (url: string): string => {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const sanitized = trimmed.replace(/\\+/g, "/");
  const parts = sanitized.split(/[/:]/).filter(Boolean);
  if (parts.length === 0) {
    return "";
  }
  const last = parts[parts.length - 1];
  return last.replace(/\.git$/i, "");
};

const humaniseAppLabel = (value: string): string => {
  const spaced = value.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!spaced) {
    return value;
  }
  return spaced
    .split(" ")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
};

const collectBunScriptDefaults = async (
  directory: string,
): Promise<Partial<AppLifecycleScripts>> => {
  try {
    const packageJsonPath = join(directory, "package.json");
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const scripts = parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
    const result: Partial<AppLifecycleScripts> = {};
    const scriptNames: Array<"start" | "stop" | "restart" | "setup"> = [
      "start",
      "stop",
      "restart",
      "setup",
    ];
    for (const name of scriptNames) {
      const scriptValue = scripts?.[name];
      if (typeof scriptValue === "string" && scriptValue.trim().length > 0) {
        result[name] = `bun run ${name}`;
      }
    }
    return result;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {};
    }
    console.warn(`[apps] Failed to read package.json while collecting scripts: ${err.message}`);
    return {};
  }
};

const cloneRepositoryIntoWorkspace = async (
  scope: WorkspaceScope,
  repositoryUrl: string,
  directoryName: string,
): Promise<{ root: string; label: string; scripts: Partial<AppLifecycleScripts> }> => {
  const sanitizedDirectory = normaliseDirectoryEntryName(directoryName);
  const targetDirectory = normalize(join(scope.defaultDirectory, sanitizedDirectory));
  ensureWithinAllowedDirectories(targetDirectory, scope);

  try {
    const stats = await stat(targetDirectory);
    if (stats.isDirectory()) {
      throw new Error("Target directory already exists");
    }
    throw new Error("A non-directory entry exists at the target location");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  await mkdir(dirname(targetDirectory), { recursive: true });

  const cloneResult = await runCommand("git", ["clone", "--depth", "1", repositoryUrl, targetDirectory]);
  if (cloneResult.exitCode !== 0) {
    await rm(targetDirectory, { recursive: true, force: true }).catch(() => undefined);
    const message = cloneResult.stderr || cloneResult.stdout || "Failed to clone repository";
    throw new Error(message);
  }

  const scripts = await collectBunScriptDefaults(targetDirectory);
  const label = humaniseAppLabel(sanitizedDirectory) || sanitizedDirectory;
  const resolvedRoot = await realpath(targetDirectory).catch(() => targetDirectory);
  return { root: resolvedRoot, label, scripts };
};

const ensureWingmanCoreRegistration = async () => {
  try {
    const apps = await appRegistry.listApps();
    const expectedRoot = projectRootPath;
    const legacyApps = apps.filter((app) => app.id !== "wingman-core" && normalize(app.root) === expectedRoot);
    for (const legacy of legacyApps) {
      try {
        await appRegistry.removeApp(legacy.id);
        console.log(`[apps] removed legacy Wingman app entry (${legacy.id})`);
      } catch (error) {
        console.warn(`[apps] failed to remove legacy Wingman app ${legacy.id}: ${(error as Error).message}`);
      }
    }

    const existing = await appRegistry.getApp("wingman-core");
    const restartCommand = "bun run scripts/restart-wingman.ts";
    const tmuxWindow = "wingman-core";
    if (existing) {
      const needsUpdate =
        existing.scripts.restart !== restartCommand ||
        existing.tmuxSession !== tmuxWindow ||
        existing.root !== expectedRoot ||
        (!existing.ownerNpub && Boolean(adminNpub));
      if (needsUpdate) {
        await appRegistry.updateApp("wingman-core", {
          root: expectedRoot,
          scripts: { restart: restartCommand },
          tmuxSession: tmuxWindow,
          notes: existing.notes ?? "Controls the Wingman orchestrator process.",
          ownerNpub: adminNpub ?? existing.ownerNpub ?? null,
        });
      }
      return;
    }
    await appRegistry.registerApp({
      id: "wingman-core",
      label: "Wingman Server",
      root: expectedRoot,
      scripts: { restart: restartCommand },
      tmuxSession: tmuxWindow,
      notes: "Controls the Wingman orchestrator process.",
      ownerNpub: adminNpub,
    });
    console.log("[apps] registered Wingman core app entry");
  } catch (error) {
    console.error("[apps] Failed to ensure Wingman core registration:", error);
  }
};

void ensureWingmanCoreRegistration();

const isAdminContext = (authContext: RequestAuthContext): boolean => {
  if (!adminNpub) return false;
  const normalized = normaliseNpub(authContext.npub ?? null);
  return normalized === adminNpub;
};

/**
 * Verify a NIP-98 Authorization header and return the signer's npub if valid.
 * Returns null if no valid NIP-98 header is present.
 */
const verifyNip98AuthHeader = (request: Request, url: URL): string | null => {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Nostr ")) return null;

  try {
    const base64Token = authHeader.slice(6);
    const eventJson = atob(base64Token);
    const event = JSON.parse(eventJson);

    // Verify the event signature
    if (!verifyEvent(event)) return null;

    // Verify kind 27235 (NIP-98)
    if (event.kind !== 27235) return null;

    // Verify the URL tag matches
    const uTag = event.tags?.find((t: string[]) => t[0] === "u");
    if (!uTag) return null;
    const eventUrl = new URL(uTag[1]);
    if (eventUrl.origin !== url.origin || eventUrl.pathname !== url.pathname) return null;

    // Verify the method tag
    const methodTag = event.tags?.find((t: string[]) => t[0] === "method");
    if (!methodTag || methodTag[1] !== request.method) return null;

    // Verify the event is recent (within 60 seconds)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - event.created_at) > 60) return null;

    // Convert pubkey to npub
    return nip19.npubEncode(event.pubkey);
  } catch {
    return null;
  }
};

const requireAdminAccess = (): AccessRule => {
  return (context) => {
    if (!adminNpub) {
      return deny("admin-only", 403);
    }
    return isAdminContext(context.auth) ? allow() : deny("admin-only", 403);
  };
};

registerAccessRule(AccessActions.SystemManage, requireAdminAccess());
registerAccessRule(AccessActions.AdminUsers, requireAdminAccess());
registerAccessRule(AccessActions.FeatureFlagsManage, requireAdminAccess());

const accessDeniedJson = (decision: AccessDecision): Response => {
  const headers = new Headers({
    "cache-control": "no-store",
    ...(decision.headers ?? {}),
  });
  return Response.json({ error: decision.reason ?? "forbidden" }, { status: decision.status ?? 403, headers });
};

const ensureApiAccess = async (
  action: AccessAction,
  request: Request,
  url: URL,
  authContext: RequestAuthContext,
): Promise<Response | null> => {
  const decision = await evaluateAccess(action, { request, url, auth: authContext });
  if (!decision.allowed) {
    return accessDeniedJson(decision);
  }
  return null;
};

const ensurePageAccess = async (
  action: AccessAction,
  request: Request,
  url: URL,
  authContext: RequestAuthContext,
): Promise<Response | null> => {
  const decision = await evaluateAccess(action, { request, url, auth: authContext });
  if (!decision.allowed) {
    const headers = new Headers({
      "cache-control": "no-store",
      ...(decision.headers ?? {}),
    });
    return new Response("Unauthorized", { status: decision.status ?? 403, headers });
  }
  return null;
};

const serialiseFeatureFlag = (flag: FeatureFlagRecord, viewerIsAdmin: boolean) => ({
  key: flag.key,
  label: flag.label,
  description: flag.description,
  state: flag.state,
  effectiveState: resolveFeatureFlagEffectiveState(flag.state, viewerIsAdmin),
  updatedAt: flag.updatedAt,
  updatedBy: flag.updatedBy ?? null,
});

const serialiseFeatureFlagsForViewer = (viewerIsAdmin: boolean) => {
  return featureFlagStore.listFlags().map((flag) => serialiseFeatureFlag(flag, viewerIsAdmin));
};

const resolveFeatureFlagStateForViewer = (
  key: string,
  viewerIsAdmin: boolean,
  fallbackState: FeatureFlagState = "off",
) => {
  const normalizedKey = normaliseFeatureFlagKey(key);
  const flag = normalizedKey ? featureFlagStore.getFlag(normalizedKey) : null;
  const baseState = flag?.state ?? fallbackState;
  const effectiveState = resolveFeatureFlagEffectiveState(baseState, viewerIsAdmin);
  return { flag, state: baseState, effectiveState };
};

const sessionApiContext: SessionApiContext = {
  manager,
  adminNpub,
  agentHost,
  messageStore,
  sessionArchiveStore,
  identityUserStore,
  promptQueueStore,
  artifactsStore,
  userIdentityRoot,
  attachmentRoot,
  imageRoot,
  MESSAGE_COST_SATS,
  ensureApiAccess,
  ensureViewerHasBalance,
  serializeSession,
  sessionBelongsToViewer,
  getViewerNormalizedNpub,
  buildIdentitySummaries,
  createSessionSubscribeResponse,
  handleSessionEvents,
  syncSessionMessages,
  waitForMessageUpdate,
  scheduleSessionArchive,
  cancelPendingArchive,
  isAgentType,
  normaliseSessionNameInput,
  parseSessionWorkspaceRequest,
  resolveSessionWorkingDirectory,
  parseSessionOriginInput,
  buildAgentUrl,
  queueDispatchInFlight,
  maybeAutoDispatchQueuedPrompt,
  dispatchNextQueuedPromptForSession,
  validateForkInput,
  getRecentMessages,
  formatMessagesAsContext,
  createGitWorktree,
  AccessActions,
};

const docsApiContext: DocsApiContext = {
  resolveWorkspace,
  ensureApiAccess,
  AccessActions,
  ensureDirectory,
  createGitWorktree,
  executeGitCommand,
  describeGitRepository,
};

const handleApi = async (
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
): Promise<Response> => {
  const pathname = url.pathname;
  const workspaceScope = resolveWorkspace(authContext);
  const viewerIsAdmin = workspaceScope.isAdmin;
  const orchestratorFlag = resolveFeatureFlagStateForViewer(ORCHESTRATOR_FLAG_KEY, viewerIsAdmin, "on_admin");
  const orchestratorEnabled = orchestratorFlag.effectiveState === "on";
  const projectsFlag = resolveFeatureFlagStateForViewer(PROJECTS_FLAG_KEY, viewerIsAdmin, "on_admin");
  const projectsEnabled = projectsFlag.effectiveState === "on";
  const viewerNpub = normaliseNpub(authContext.npub ?? null);
  const canAccessApp = (app: AppRecord): boolean => {
    if (workspaceScope.isAdmin) {
      return true;
    }
    if (!viewerNpub) {
      return false;
    }
    return app.ownerNpub === viewerNpub;
  };
  const browserLogResponse = await browserLogHandler(request, url, method, authContext);
  if (browserLogResponse) {
    return browserLogResponse;
  }
  if (pathname.startsWith("/api/npub-projects")) {
    let effectiveAuth = authContext;
    let effectiveIsAdmin = workspaceScope.isAdmin;

    // Allow NIP-98 auth as fallback when no session cookie
    if (!authContext.session) {
      const nip98Npub = verifyNip98AuthHeader(request, url);
      if (nip98Npub) {
        effectiveAuth = { npub: nip98Npub, session: null };
        effectiveIsAdmin = true; // NIP-98 server keys treated as admin for project lookups
      } else {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
    }

    const response = await npubProjectApiHandler(
      request,
      url,
      method,
      effectiveAuth,
      effectiveIsAdmin,
    );
    if (response) {
      return response;
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (pathname.startsWith("/api/projects")) {
    const denied = await ensureApiAccess(AccessActions.ProjectsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    if (!projectsEnabled) {
      return Response.json({ error: "projects-disabled" }, { status: 403 });
    }
    const response = await projectApiHandler(request, url, method, authContext, {
      isAdmin: workspaceScope.isAdmin,
    });
    if (response) {
      return response;
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (pathname.startsWith("/api/todos")) {
    const denied = await ensureApiAccess(AccessActions.TodosManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    const response = await todoApiHandler(request, url, method, authContext);
    if (response) {
      return response;
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (pathname.startsWith("/api/nightwatch")) {
    const denied = await ensureApiAccess(AccessActions.SessionsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    const response = await nightWatchApiHandler(request, url, method);
    if (response) {
      return response;
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (pathname.startsWith("/api/scheduler")) {
    const denied = await ensureApiAccess(AccessActions.SessionsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    const response = await schedulerApiHandler(request, url, method);
    if (response) {
      return response;
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // Bot key API — per-user bot identity management.
  // Auth: cookie-based for browser routes, session ID for escrow unlock.
  if (pathname.startsWith("/api/bot-keys")) {
    const response = await botKeyApiHandler(request, url, method);
    if (response) {
      return response;
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // Bot crypto API — NIP-44 encrypt/decrypt using user's bot key.
  // No auth gate: validated by session ID in the handler.
  if (pathname.startsWith("/api/mcp/bot-crypto")) {
    const response = await botCryptoApiHandler(request, url, method);
    if (response) {
      return response;
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // MCP NIP-98 API — called by the MCP stdio server running inside agents.
  // No auth gate: requests are validated by session ID in the handler.
  if (pathname.startsWith("/api/mcp/nip98")) {
    const response = await nip98ApiHandler(request, url, method);
    if (response) {
      return response;
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // Git workflow API — branch, worktree, merge, and status operations.
  // No auth gate: validated by session ID in the handler.
  if (pathname.startsWith("/api/git/")) {
    const response = await gitWorkflowApiHandler(request, url, method);
    if (response) {
      return response;
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // Gitea API — programmatic git operations scoped to the Gitea remote.
  // No auth gate: validated by session ID in the handler.
  if (pathname.startsWith("/api/gitea")) {
    const response = await giteaApiHandler(request, url, method);
    if (response) {
      return response;
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // ngit API — NIP-34 git repository operations (publish, push state, list).
  // No auth gate: requests are validated by session ID and grants in the handler.
  if (pathname.startsWith("/api/ngit")) {
    const response = await ngitApiHandler(request, url, method);
    if (response) {
      return response;
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // SuperBased API — encrypted record CRUD via Flux Adaptor.
  // No auth gate: uses Tier 1 NIP-98 signing internally.
  if (pathname.startsWith("/api/superbased")) {
    const response = await superbasedApiHandler(request, url, method);
    if (response) {
      return response;
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // MCP Wingman Action API — called by the MCP stdio server running inside agents.
  // No auth gate: requests are validated by session ID in the handler.
  if (pathname.startsWith("/api/mcp/wingman")) {
    const response = await wingmanMcpApiHandler(request, url, method);
    if (response) {
      return response;
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (pathname.startsWith("/api/caprover")) {
    const denied = await ensureApiAccess(AccessActions.DeploymentsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    const response = await caproverApiHandler(request, url, method, authContext);
    if (response) {
      return response;
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // Private chat API routes
  if (pathname.startsWith("/api/chats") || pathname === "/api/maple/models") {
    if (!authContext.session) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }
    const chatContext: ChatApiContext = {
      config,
      npub: viewerNpub,
      isAdmin: viewerIsAdmin,
    };
    const response = await handleChatApi(request, url, method, chatContext);
    if (response) {
      return response;
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (pathname === "/api/system/restart/status" && method === "GET") {
    const denied = await ensureApiAccess(AccessActions.SystemManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    return Response.json({
      inProgress: warmRestartState.inProgress,
      marker: warmRestartState.marker,
      outcome: warmRestartOutcome.current,
    });
  }

  if (pathname === "/api/system/restart" && method === "POST") {
    const denied = await ensureApiAccess(AccessActions.SystemManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    if (warmRestartState.inProgress) {
      return Response.json({ error: "Restart already in progress" }, { status: 409 });
    }

    const activeSessions = manager
      .listSessions()
      .filter((session) => session.status === "starting" || session.status === "running");

    const marker: WarmRestartMarker = {
      createdAt: new Date().toISOString(),
      sessionIds: activeSessions.map((session) => session.id),
      reason: "ui-restart",
      version: 1,
    };

    try {
      await writeWarmRestartMarker(restartMarkerPath, marker);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: `Failed to write restart marker: ${message}` }, { status: 500 });
    }

    warmRestartState.inProgress = true;
    warmRestartState.marker = marker;
    warmRestartOutcome.current = null;
    preserveSessionsOnShutdown = true;

    try {
      await stat(warmRestartManagerScriptPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warmRestartState.inProgress = false;
      preserveSessionsOnShutdown = false;
      return Response.json({ error: `Restart script missing: ${message}` }, { status: 500 });
    }

    try {
      Bun.spawn([
        Bun.env.WINGMAN_MANAGER_COMMAND?.trim() || "bun",
        "run",
        warmRestartManagerScriptPath,
        process.pid.toString(),
        projectRoot,
        String(config.port),
        restartMarkerPath,
        WINGMAN_CORE_TMUX_SESSION,
        "wingman-core",
      ], {
        cwd: projectRoot,
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        detached: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warmRestartState.inProgress = false;
      preserveSessionsOnShutdown = false;
      return Response.json({ error: `Failed to launch restart script: ${message}` }, { status: 500 });
    }

    setTimeout(() => {
      void initiateShutdown("warm-restart");
    }, 250).unref?.();

    return Response.json({
      status: "scheduled",
      sessions: marker.sessionIds ?? [],
    }, { status: 202 });
  }

  if (pathname === "/api/system/cleanup" && method === "POST") {
    const denied = await ensureApiAccess(AccessActions.SystemManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    try {
      const result = await performSystemCleanup({ manager, messageStore, appProcessManager, appRegistry });
      return Response.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[system] cleanup failure: ${message}`);
      return Response.json({ error: `System cleanup failed: ${message}` }, { status: 500 });
    }
  }

  if (pathname === "/api/auth/session" && method === "POST") {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const { npub, encryptedNsec } = payload as Record<string, unknown>;
    if (typeof npub !== "string" || npub.trim().length === 0) {
      return Response.json({ error: "npub is required" }, { status: 400 });
    }

    const trimmedNpub = npub.trim();
    if (typeof encryptedNsec !== "undefined" && encryptedNsec !== null && typeof encryptedNsec !== "string") {
      return Response.json({ error: "encryptedNsec must be a string" }, { status: 400 });
    }

    try {
      // Block new registrations when REGISTER=FALSE
      if (!config.registrationEnabled) {
        const normalized = normaliseNpub(trimmedNpub);
        const existingUser = normalized ? identityUserStore.getByNormalized(normalized) : null;
        if (!existingUser) {
          return Response.json({ error: "Registration is currently disabled" }, { status: 403 });
        }
      }

      const existingSession = authContext.session;
      if (existingSession && existingSession.npub !== trimmedNpub) {
        // Allow overwriting with a new npub, but clear stale signed data by minting a new cookie.
      }

      const { cookie, expiresAt, payload } = mintSessionCookie(trimmedNpub);
      authContext.npub = payload.npub;
      authContext.session = payload;
      delete authContext.error;
      const alias = generateIdentityAlias(trimmedNpub);
      try {
        identityUserStore.touch(trimmedNpub, {
          alias,
          lastSeenAt: new Date().toISOString(),
        });
      } catch (error) {
        console.warn(`[admin] failed to record identity ${trimmedNpub}:`, error);
      }

      // Fire-and-forget Gitea user provisioning
      if (config.giteaUrl && config.giteaApiToken && config.giteaOwner) {
        ensureGiteaUser(config, trimmedNpub, alias).catch((err) => {
          console.warn(`[gitea] user provisioning failed for ${trimmedNpub}:`, err);
        });
      }

      const headers = new Headers({
        "cache-control": "no-store",
      });
      headers.append("set-cookie", cookie);
      return Response.json({ expiresAt }, { headers });
    } catch (error) {
      if (error instanceof SessionCookieError) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: `Failed to mint session cookie: ${message}` }, { status: 500 });
    }
  }

  if (pathname === "/api/auth/session" && method === "DELETE") {
    const headers = new Headers({
      "cache-control": "no-store",
    });
    const secureFlag = shouldUseSecureCookies() ? "; Secure" : "";
    headers.append(
      "set-cookie",
      `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secureFlag}`,
    );
    authContext.npub = null;
    authContext.session = null;
    delete authContext.error;
    return new Response(null, { status: 204, headers });
  }

  // Key Teleport: receive encrypted key blob from Welcome
  if (pathname === "/api/auth/keyteleport" && method === "POST") {
    return handleKeyTeleport(request);
  }

  // Key Teleport: get configuration for frontend
  if (pathname === "/api/auth/keyteleport/config" && method === "GET") {
    const { getKeyTeleportIdentity, KEYTELEPORT_WELCOME_URL } = await import("./config");
    const identity = getKeyTeleportIdentity();
    const isConfigured = Boolean(identity);
    return Response.json({
      enabled: isConfigured,
      welcomeUrl: isConfigured ? KEYTELEPORT_WELCOME_URL : null,
      appNpub: identity?.npub ?? null,
    });
  }

  // Key Teleport: get registration blob for Welcome setup
  if (pathname === "/api/auth/keyteleport/registration" && method === "GET") {
    return handleKeyTeleportRegistration(request);
  }

  if (pathname === "/api/identity/profile" && method === "GET") {
    const denied = await ensureApiAccess(AccessActions.UiRestricted, request, url, authContext);
    if (denied) {
      return denied;
    }
    const viewerNormalized = getViewerNormalizedNpub(authContext);
    const viewerIsAdmin = Boolean(adminNpub && viewerNormalized && adminNpub === viewerNormalized);
    const targetInput = normaliseOptionalString(url.searchParams.get("npub")) ?? authContext.npub;
    const refresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("force") === "1";
    if (!targetInput) {
      return Response.json({ error: "npub is required" }, { status: 400 });
    }
    const normalizedTarget = normaliseNpub(targetInput);
    if (!normalizedTarget) {
      return Response.json({ error: "Invalid npub" }, { status: 400 });
    }
    if (!viewerIsAdmin && normalizedTarget !== viewerNormalized) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    try {
      const profile = await resolveAndCacheNostrProfile(targetInput, {
        force: refresh,
        relays: config.connectRelays,
      });
      const record = identityUserStore.getByNormalized(normalizedTarget);
      return Response.json({
        npub: record?.npub ?? targetInput,
        pictureUrl: profile.pictureUrl ?? record?.pictureUrl ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // Admin user routes (delegated to admin-users-routes.ts)
  if (pathname.startsWith("/api/admin/users") || pathname === "/api/admin/ports") {
    const adminUsersApiContext: AdminUsersApiContext = {
      adminNpub,
      config: { connectRelays: config.connectRelays },
      identityUserStore,
      manager,
      ensureApiAccess,
      AccessActions,
      normaliseOptionalString,
      stopSessionsForUser,
      resolveAndCacheNostrProfile,
      buildIdentitySummaries,
    };
    const adminUsersResponse = await handleAdminUsersApi(request, url, method, authContext, adminUsersApiContext);
    if (adminUsersResponse) return adminUsersResponse;
  }

  if (pathname === "/api/apps/clone" && method === "POST") {
    const denied = await ensureApiAccess(AccessActions.AppsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    const repoUrl = normaliseOptionalString((payload as Record<string, unknown>).url);
    if (!repoUrl) {
      return Response.json({ error: "Repository URL is required" }, { status: 400 });
    }
    const directoryInput = normaliseOptionalString(
      (payload as Record<string, unknown>).directory ?? (payload as Record<string, unknown>).name,
    );
    const fallbackDirectory = deriveDirectoryNameFromUrl(repoUrl);
    const directoryName = directoryInput ?? fallbackDirectory;
    if (!directoryName) {
      return Response.json({ error: "Folder name is required" }, { status: 400 });
    }
    try {
      const result = await cloneRepositoryIntoWorkspace(workspaceScope, repoUrl, directoryName);
      return Response.json(result, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // -------------------------------------------------------------------------
  // Workspace Tree - Browse directories and detect importable apps
  // -------------------------------------------------------------------------

  if (pathname === "/api/workspace/tree" && method === "GET") {
    const denied = await ensureApiAccess(AccessActions.AppsManage, request, url, authContext);
    if (denied) {
      return denied;
    }

    // Determine the root directory to scan
    const scanRoot = workspaceScope.aliasDirectory ?? workspaceScope.defaultDirectory;

    // Parse depth parameter (default 4, max 6)
    const depthParam = url.searchParams.get("depth");
    const depth = depthParam ? Math.min(Math.max(parseInt(depthParam, 10) || 4, 1), 6) : 4;

    try {
      // Get registered app paths to mark them in the tree
      const registeredApps = await appRegistry.listApps();
      const registeredPaths = new Set(
        registeredApps
          .filter((app) => canAccessApp(app))
          .map((app) => app.root),
      );

      // Scan the directory tree
      const nodes = await scanDirectoryTree(scanRoot, depth, registeredPaths);

      return Response.json({
        root: scanRoot,
        depth,
        nodes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 500 });
    }
  }

  if (pathname === "/api/apps" && method === "GET") {
    const denied = await ensureApiAccess(AccessActions.AppsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    const viewerNormalizedNpub = normaliseNpub(authContext.npub ?? null);
    const tailParam = url.searchParams.get("tail") ?? url.searchParams.get("logs");
    const tail = tailParam ? Number.parseInt(tailParam, 10) : 0;
    const includeLogs = Number.isFinite(tail) && tail > 0;
    const tailCount = includeLogs ? Math.min(Math.max(tail, 1), 2000) : 0;
    const ownerAliasCache = new Map<string, string | null>();
    const normalizeOwnerFilter = (value: string | null): string | null | "__anonymous__" => {
      if (!value || value === "all") {
        return null;
      }
      if (value === "__anonymous__") {
        return "__anonymous__";
      }
      const normalized = normaliseNpub(value);
      return normalized ?? null;
    };
    try {
      const [apps, statuses] = await Promise.all([appRegistry.listApps(), appProcessManager.listStatuses()]);
      const visibleApps = workspaceScope.isAdmin ? apps : apps.filter((app) => canAccessApp(app));
      const ownerFilters = workspaceScope.isAdmin ? buildAppOwnerFilters(visibleApps, ownerAliasCache) : [];
      const hasFilterParam = workspaceScope.isAdmin ? url.searchParams.has("npub") : Boolean(viewerNormalizedNpub);
      let ownerFilter: string | null | "__anonymous__" =
        workspaceScope.isAdmin ? normalizeOwnerFilter(url.searchParams.get("npub")) : viewerNormalizedNpub ?? null;
      if (workspaceScope.isAdmin && !hasFilterParam && viewerNormalizedNpub) {
        ownerFilter = viewerNormalizedNpub;
      }
      const filteredApps =
        ownerFilter === null
          ? visibleApps
          : visibleApps.filter((app) => {
              const normalizedOwner = normaliseNpub(app.ownerNpub ?? null);
              if (ownerFilter === "__anonymous__") {
                return normalizedOwner === null;
              }
              return normalizedOwner === ownerFilter;
            });
      const statusMap = new Map(statuses.map((status) => [status.appId, status]));
      const data = await Promise.all(
        filteredApps.map(async (app) => {
          const status = statusMap.get(app.id) ?? defaultAppProcessStatus(app.id);
          const ownerAlias = resolveOwnerAliasCached(app.ownerNpub, ownerAliasCache);
          const aliasRecord = await appAliasRegistry.getByAppId(app.id);
          const subdomainAlias = aliasRecord?.alias ?? null;
          const record = buildAppResponse(app, status, { ownerAlias, subdomainAlias });
          if (includeLogs) {
            try {
              record.logs = await appProcessManager.tailLogs(app.id, tailCount);
            } catch {
              record.logs = [];
            }
          }
          return record;
        }),
      );
      return Response.json({
        apps: data,
        filters: {
          npubs: ownerFilters,
          active: ownerFilter ?? null,
        },
      });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  }

  if (pathname === "/api/apps" && method === "POST") {
    const denied = await ensureApiAccess(AccessActions.AppsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const record = payload as Record<string, unknown>;
    const root = normaliseOptionalString(record.root);
    if (!root) {
      return Response.json({ error: "App root path is required" }, { status: 400 });
    }

    let resolvedRoot: string;
    try {
      resolvedRoot = await ensureDirectory(root, workspaceScope);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }

    const label = normaliseOptionalString(record.label);
    const tmuxSession = normaliseOptionalString(record.tmuxSession);
    const notes = normaliseOptionalString(record.notes);
    const overrides = parseAppScripts(record.scripts);
    const webAppInput =
      record.webApp !== undefined ? parseBooleanInput(record.webApp) : parseBooleanInput((record as Record<string, unknown>).isWebApp);
    const requestedWebApp = webAppInput ?? false;
    const requestedPort = parsePortInput(record.webAppPort);
    const ownerNpub =
      workspaceScope.isAdmin ? normaliseNpub(authContext.npub ?? null) ?? adminNpub : viewerNpub;
    if (!ownerNpub) {
      return Response.json({ error: "Unable to resolve app owner" }, { status: 403 });
    }
    const discoverOverride =
      typeof record.discover === "boolean"
        ? (record.discover as boolean)
        : typeof record.discoverScripts === "boolean"
          ? (record.discoverScripts as boolean)
          : typeof record.autoDiscover === "boolean"
            ? (record.autoDiscover as boolean)
            : undefined;
    const shouldDiscover = discoverOverride ?? true;

    let scripts: AppLifecycleScripts = overrides;
    if (shouldDiscover) {
      try {
        const discovered = await appRegistry.discoverScripts(resolvedRoot);
        scripts = { ...discovered, ...overrides };
      } catch (error) {
        return Response.json({ error: `Failed to discover scripts: ${(error as Error).message}` }, { status: 400 });
      }
    }

    try {
      const app = await appRegistry.registerApp({
        label: label ?? "",
        root: resolvedRoot,
        scripts: Object.keys(scripts).length > 0 ? scripts : undefined,
        tmuxSession: tmuxSession ?? undefined,
        notes: notes ?? undefined,
        ownerNpub,
        webApp: requestedWebApp,
        webAppPort: requestedPort ?? undefined,
      });

      // Link app to npub-project (create project if it doesn't exist)
      try {
        let project = npubProjectStore.getByPath(ownerNpub, resolvedRoot);
        if (project) {
          npubProjectStore.setAppId(project.id, app.id);
        } else {
          project = npubProjectStore.createProject(ownerNpub, resolvedRoot, app.label || undefined);
          if (project) {
            npubProjectStore.setAppId(project.id, app.id);
          }
        }
      } catch (linkError) {
        // Log but don't fail app creation if project linking fails
        console.warn(`[apps] failed to link app ${app.id} to npub-project: ${(linkError as Error).message}`);
      }

      const status = await appProcessManager.getStatus(app.id);
      const aliasRecord = await appAliasRegistry.getByAppId(app.id);
      const subdomainAlias = aliasRecord?.alias ?? null;
      return Response.json({ app: buildAppResponse(app, status, { subdomainAlias }) }, { status: 201 });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  if (pathname === "/api/apps/discover" && method === "GET") {
    const denied = await ensureApiAccess(AccessActions.AppsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    const root = normaliseOptionalString(url.searchParams.get("root"));
    if (!root) {
      return Response.json({ error: "Root directory is required" }, { status: 400 });
    }
    try {
      const resolvedRoot = await ensureDirectory(root, workspaceScope);
      const scripts = await appRegistry.discoverScripts(resolvedRoot);
      return Response.json({ root: resolvedRoot, scripts });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  if (pathname.startsWith("/api/apps/")) {
    const denied = await ensureApiAccess(AccessActions.AppsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    const parts = pathname.split("/");
    const id = parts[3];
    if (!id) {
      return Response.json({ error: "App id is required" }, { status: 400 });
    }
    if (!workspaceScope.isAdmin && id === "wingman-core") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (method === "GET" && parts.length === 4) {
      const app = await appRegistry.getApp(id);
      if (!app) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      if (!canAccessApp(app)) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      const status = await appProcessManager.getStatus(id);
      const aliasRecord = await appAliasRegistry.getByAppId(id);
      const subdomainAlias = aliasRecord?.alias ?? null;
      return Response.json({ app: buildAppResponse(app, status, { subdomainAlias }) });
    }

    if (method === "PUT" && parts.length === 4) {
      const current = await appRegistry.getApp(id);
      if (!current) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      if (!canAccessApp(current)) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }

      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }

      if (!payload || typeof payload !== "object") {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }

      const record = payload as Record<string, unknown>;
      const label = normaliseOptionalString(record.label);
      const root = normaliseOptionalString(record.root);
      const tmuxSession = normaliseOptionalString(record.tmuxSession);
      const notesValue = record.notes === null ? null : normaliseOptionalString(record.notes);
      const overrides = parseAppScripts(record.scripts);
      const webAppRaw = record.webApp ?? (record as Record<string, unknown>).isWebApp;
      const webAppInput = parseBooleanInput(webAppRaw);
      const webAppPortInput = parsePortInput(record.webAppPort);
      const shouldDiscover =
        typeof record.discoverScripts === "boolean"
          ? (record.discoverScripts as boolean)
            : typeof record.discover === "boolean"
              ? (record.discover as boolean)
              : false;

      let resolvedRoot: string | undefined;
      if (root) {
        try {
          resolvedRoot = await ensureDirectory(root, workspaceScope);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: message }, { status: 400 });
        }
      }

      let scripts: AppLifecycleScripts | undefined = undefined;
      if (shouldDiscover || Object.keys(overrides).length > 0) {
        const discoverRoot = resolvedRoot ?? current.root;
        if (!workspaceScope.isAdmin) {
          try {
            ensureWithinAllowedDirectories(discoverRoot, workspaceScope);
          } catch {
            return Response.json({ error: "App root outside allowed directories" }, { status: 403 });
          }
        }
        if (shouldDiscover) {
          try {
            const discovered = await appRegistry.discoverScripts(discoverRoot);
            scripts = { ...discovered, ...overrides };
          } catch (error) {
            return Response.json(
              { error: `Failed to discover scripts: ${(error as Error).message}` },
              { status: 400 },
            );
          }
        } else {
          scripts = overrides;
        }
      }

      try {
        const updatePayload = {
          label: label ?? undefined,
          root: resolvedRoot ?? undefined,
          tmuxSession: tmuxSession ?? undefined,
          notes: notesValue,
          scripts,
        };
        if (webAppInput !== undefined) {
          updatePayload.webApp = webAppInput;
        }
        if (webAppPortInput !== null) {
          updatePayload.webAppPort = webAppPortInput;
        }
        const updated = await appRegistry.updateApp(id, updatePayload);
        appProcessManager.forget(id);
        const status = await appProcessManager.getStatus(id);
        const aliasRecord = await appAliasRegistry.getByAppId(id);
        const subdomainAlias = aliasRecord?.alias ?? null;
        return Response.json({ app: buildAppResponse(updated, status, { subdomainAlias }) });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }

    if (method === "DELETE" && parts.length === 4) {
      const killParam = url.searchParams.get("killSession") ?? url.searchParams.get("killTmux");
      const killSession = parseBooleanFlag(killParam);
      const current = await appRegistry.getApp(id);
      if (!current) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      if (!canAccessApp(current)) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      try {
        if (killSession) {
          await appProcessManager.kill(id);
        }
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 500 });
      }

      // Clear app link from any npub-projects before removing the app
      try {
        npubProjectStore.clearAppIdByAppId(id);
      } catch (clearError) {
        console.warn(`[apps] failed to clear app ${id} from npub-projects: ${(clearError as Error).message}`);
      }

      const removed = await appRegistry.removeApp(id);
      if (!removed) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      appProcessManager.forget(id);
      return Response.json({ id, deleted: true, killedSession: killSession });
    }

    if (method === "GET" && parts[4] === "logs") {
      const app = await appRegistry.getApp(id);
      if (!app) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      if (!canAccessApp(app)) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      const tailParam = url.searchParams.get("tail");
      const tail = tailParam ? Number.parseInt(tailParam, 10) : 100;
      const lines = Number.isNaN(tail) || tail <= 0 ? 100 : Math.min(tail, 2000);
      try {
        const logs = await appProcessManager.tailLogs(id, lines);
        return Response.json({ id, logs });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }

    if (method === "POST" && parts[4] === "actions") {
      const app = await appRegistry.getApp(id);
      if (!app) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      if (!canAccessApp(app)) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }
      if (!payload || typeof payload !== "object") {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }

      const actionValue = normaliseOptionalString((payload as Record<string, unknown>).action);
      if (!actionValue) {
        return Response.json({ error: "Action is required" }, { status: 400 });
      }
      const normalizedAction = actionValue.toLowerCase();
      if (!APP_ACTIONS.includes(normalizedAction as AppLifecycleAction)) {
        return Response.json({ error: `Unsupported action: ${actionValue}` }, { status: 400 });
      }

      if (normalizedAction === "start" || normalizedAction === "restart") {
        const balanceCheck = ensureViewerHasBalance(authContext, {
          feature: normalizedAction === "start" ? "start this app" : "restart this app",
          message:
            normalizedAction === "start"
              ? "Add sats to your balance to start this app."
              : "Add sats to your balance to restart this app.",
        });
        if (balanceCheck instanceof Response) {
          return balanceCheck;
        }
      }

      try {
        let status: AppProcessStatus;
        switch (normalizedAction as AppLifecycleAction) {
          case "start":
            status = await appProcessManager.start(id);
            break;
          case "stop":
            status = await appProcessManager.stop(id);
            break;
          case "restart":
            status = await appProcessManager.restart(id);
            break;
          case "setup":
            status = await appProcessManager.setup(id);
            break;
          case "build":
            status = await appProcessManager.build(id);
            break;
          default:
            return Response.json({ error: `Unsupported action: ${actionValue}` }, { status: 400 });
        }
        const aliasRecord = await appAliasRegistry.getByAppId(id);
        const subdomainAlias = aliasRecord?.alias ?? null;
        return Response.json({ app: buildAppResponse(app, status, { subdomainAlias }) });
      } catch (error) {
        if (error instanceof AppActionInProgressError) {
          return Response.json({ error: error.message }, { status: 409 });
        }
        if (error instanceof AppScriptMissingError) {
          return Response.json({ error: error.message }, { status: 400 });
        }
        return Response.json({ error: (error as Error).message }, { status: 500 });
      }
    }

    if (method === "POST" && parts[4] === "deploy-to-caprover") {
      const app = await appRegistry.getApp(id);
      if (!app) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      if (!canAccessApp(app)) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      if (!app.webApp) {
        return Response.json({ error: "Only web apps can be deployed to CapRover" }, { status: 400 });
      }

      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }
      if (!payload || typeof payload !== "object") {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }

      const record = payload as Record<string, unknown>;
      const caproverNameRaw = normaliseOptionalString(record.caproverName);
      if (!caproverNameRaw) {
        return Response.json({ error: "caproverName is required" }, { status: 400 });
      }

      // Validate CapRover name format
      const caproverName = caproverNameRaw.toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(caproverName)) {
        return Response.json(
          { error: "caproverName must be lowercase, start with a letter, and contain only letters, numbers, and hyphens" },
          { status: 400 },
        );
      }
      if (caproverName.length > 50) {
        return Response.json({ error: "caproverName must be 50 characters or less" }, { status: 400 });
      }

      // Read captain-definition.json from app root
      const captainDefPath = join(app.root, "captain-definition.json");
      let captainDefContent: string;
      try {
        captainDefContent = await readFile(captainDefPath, "utf8");
      } catch {
        return Response.json(
          { error: `captain-definition.json not found in ${app.root}` },
          { status: 400 },
        );
      }

      let captainDef: unknown;
      try {
        captainDef = JSON.parse(captainDefContent);
      } catch {
        return Response.json({ error: "Invalid captain-definition.json format" }, { status: 400 });
      }

      // Validate captain-definition structure
      if (!captainDef || typeof captainDef !== "object") {
        return Response.json({ error: "captain-definition.json must be a valid object" }, { status: 400 });
      }
      const defRecord = captainDef as Record<string, unknown>;
      if (defRecord.schemaVersion !== 2) {
        return Response.json({ error: "captain-definition.json must have schemaVersion: 2" }, { status: 400 });
      }

      // Must have imageName, dockerfileLines, or templateId
      if (!defRecord.imageName && !defRecord.dockerfileLines && !defRecord.templateId) {
        // Check if Dockerfile exists (CapRover will look for it if no other method specified)
        const dockerfilePath = join(app.root, "Dockerfile");
        try {
          await stat(dockerfilePath);
        } catch {
          return Response.json(
            {
              error:
                "captain-definition.json requires imageName, dockerfileLines, or a Dockerfile in the app root. " +
                "See https://caprover.com/docs/captain-definition-file.html",
            },
            { status: 400 },
          );
        }
      }

      // Get CapRover client
      const caproverClient = createCaproverClientFromEnv();
      if (!caproverClient) {
        return Response.json(
          { error: "CapRover is not configured. Set CAPROVER_URL and LOGIN_CODE environment variables." },
          { status: 503 },
        );
      }

      try {
        // Check if already tracked in store
        let tracked = caproverStore.getAppByLocalAppId(id);

        if (!tracked) {
          // Check if app exists on CapRover
          const existingRemote = await caproverClient.getApp(caproverName);
          if (!existingRemote) {
            // Create new app on CapRover
            await caproverClient.createApp(caproverName, false);
          }

          // Get the live URL
          const liveUrl = await caproverClient.getAppUrl(caproverName);

          // Track in local store
          tracked = caproverStore.createApp({
            caproverName,
            appId: id,
            liveUrl,
          });
        }

        // Create deployment record
        const deployment = caproverStore.createDeployment({
          caproverAppId: tracked.id,
          deployMethod: "tar_upload",
        });

        // Create tarball from app directory
        let tarResult;
        try {
          tarResult = await createAppTarball(app.root);
          console.log(`[caprover] Created tarball with ${tarResult.fileCount} files for ${caproverName}`);
        } catch (tarError) {
          const tarMessage = tarError instanceof Error ? tarError.message : String(tarError);
          caproverStore.updateDeployment(deployment.id, {
            status: "failed",
            completedAt: new Date().toISOString(),
            errorMessage: `Failed to create tarball: ${tarMessage}`,
          });
          return Response.json({ error: `Failed to create tarball: ${tarMessage}` }, { status: 400 });
        }

        // Deploy using tarball upload
        await caproverClient.deployFromTarball(tracked.caproverName, tarResult.buffer);

        // Get updated app info
        const remoteApp = await caproverClient.getApp(tracked.caproverName);
        const version = remoteApp?.deployedVersion ?? null;

        // Update deployment record as success
        caproverStore.updateDeployment(deployment.id, {
          status: "success",
          version,
          completedAt: new Date().toISOString(),
        });

        // Update tracked app record
        const updatedTracked = caproverStore.updateApp(tracked.id, {
          deployedVersion: version,
        });

        return Response.json({
          success: true,
          liveUrl: updatedTracked.liveUrl,
          caproverName: updatedTracked.caproverName,
          deployedVersion: version,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ error: message }, { status: 502 });
      }
    }
  }

  if (pathname === "/api/config" && method === "GET") {
    return Response.json({
      port: config.port,
      agentPortStart: config.agentPortStart,
      agentPortMax: config.agentPortMax,
      hostUrlBase: config.hostUrlBase,
      defaultDirectory: workspaceScope.defaultDirectory,
      allowedDirectories: workspaceScope.allowedDirectories,
      connectRelays: config.connectRelays,
      adminNpub,
      agents: Object.entries(config.agents).map(([key, definition]) => ({
        id: key,
        label: definition.label,
      })),
      defaultAgent: config.defaultAgent,
      featureFlags: serialiseFeatureFlagsForViewer(workspaceScope.isAdmin),
      giteaUrl: config.giteaUrl ?? null,
    });
  }

  if (pathname === "/api/feature-flags" && method === "GET") {
    const flags = serialiseFeatureFlagsForViewer(viewerIsAdmin);
    return Response.json({ flags });
  }

  if (pathname === "/api/feature-flags" && method === "POST") {
    const denied = await ensureApiAccess(AccessActions.FeatureFlagsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const record = payload as Record<string, unknown>;
    const key = normaliseFeatureFlagKey(typeof record.key === "string" ? record.key : "");
    const label = typeof record.label === "string" ? record.label.trim() : "";
    const description =
      typeof record.description === "string"
        ? record.description.trim()
        : record.description === null
          ? null
          : undefined;
    const stateInput = typeof record.state === "string" ? record.state.trim().toLowerCase() : "";
    const state: FeatureFlagState = isFeatureFlagState(stateInput) ? stateInput : "off";

    if (!key) {
      return Response.json({ error: "Feature flag key is required" }, { status: 400 });
    }
    if (!label) {
      return Response.json({ error: "Feature flag label is required" }, { status: 400 });
    }

    try {
      const created = featureFlagStore.createFlag({
        key,
        label,
        description: description === undefined ? null : description,
        state,
        updatedBy: normaliseNpub(authContext.npub ?? null),
      });
      const flags = serialiseFeatureFlagsForViewer(viewerIsAdmin);
      return Response.json({ flag: serialiseFeatureFlag(created, viewerIsAdmin), flags }, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname.startsWith("/api/feature-flags/") && method === "PATCH") {
    const denied = await ensureApiAccess(AccessActions.FeatureFlagsManage, request, url, authContext);
    if (denied) {
      return denied;
    }

    const parts = pathname.split("/").filter(Boolean);
    if (parts.length !== 3 || !parts[2]) {
      return Response.json({ error: "Feature flag key is required" }, { status: 400 });
    }
    const key = normaliseFeatureFlagKey(parts[2]);
    if (!key) {
      return Response.json({ error: "Invalid feature flag key" }, { status: 400 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const record = payload as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(record, "label")) {
      const label = typeof record.label === "string" ? record.label.trim() : "";
      if (!label) {
        return Response.json({ error: "Feature flag label is required" }, { status: 400 });
      }
      updates.label = label;
    }

    if (Object.prototype.hasOwnProperty.call(record, "description")) {
      const description =
        typeof record.description === "string"
          ? record.description.trim()
          : record.description === null
            ? null
            : undefined;
      updates.description = description;
    }

    if (Object.prototype.hasOwnProperty.call(record, "state")) {
      const stateInput = typeof record.state === "string" ? record.state.trim().toLowerCase() : "";
      if (!isFeatureFlagState(stateInput)) {
        return Response.json({ error: "Invalid feature flag state" }, { status: 400 });
      }
      updates.state = stateInput;
    }

    if (Object.keys(updates).length === 0) {
      return Response.json({ error: "No updates provided" }, { status: 400 });
    }

    try {
      const updated = featureFlagStore.updateFlag(key, {
        label: updates.label as string | undefined,
        description: updates.description as string | null | undefined,
        state: updates.state as FeatureFlagState | undefined,
        updatedBy: normaliseNpub(authContext.npub ?? null),
      });
      const flags = serialiseFeatureFlagsForViewer(viewerIsAdmin);
      return Response.json({ flag: serialiseFeatureFlag(updated, viewerIsAdmin), flags });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/orchestrators" && method === "GET") {
    if (!orchestratorEnabled) {
      return Response.json({ error: "orchestrator-disabled" }, { status: 403 });
    }
    const presets = orchestratorPresetStore.listPresets();
    return Response.json({ presets });
  }

  // Docs/files API routes (delegated to docs-routes.ts)
  if (pathname.startsWith("/api/docs/")) {
    const docsApiResponse = await handleDocsApi(request, url, method, authContext, docsApiContext);
    if (docsApiResponse) return docsApiResponse;
  }

  if (pathname === "/api/orchestrators/directories" && method === "GET") {
    if (!orchestratorEnabled) {
      return Response.json({ error: "orchestrator-disabled" }, { status: 403 });
    }
    const targetParam = url.searchParams.get("target") ?? "";
    const target = targetParam === "templates" ? "templates" : targetParam === "active" ? "active" : null;
    if (!target) {
      return Response.json({ error: "Invalid target" }, { status: 400 });
    }
    const pathParam = url.searchParams.get("path");
    try {
      const data = await listOrchestratorDirectories(target, pathParam);
      return Response.json(data);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  if (pathname === "/api/orchestrators" && method === "POST") {
    if (!orchestratorEnabled) {
      return Response.json({ error: "orchestrator-disabled" }, { status: 403 });
    }
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const label = normaliseOptionalString((payload as Record<string, unknown>).label);
    if (!label) {
      return Response.json({ error: "Preset label is required" }, { status: 400 });
    }

    const agentInput = normaliseOptionalString((payload as Record<string, unknown>).agent);
    const agent = agentInput?.toLowerCase() ?? "";
    if (!isAgentType(agent)) {
      return Response.json({ error: "Invalid agent selection" }, { status: 400 });
    }

    const templateDir = normaliseOptionalString(
      (payload as Record<string, unknown>).templateDir ?? (payload as Record<string, unknown>).template,
    );
    const workingDirectory = normaliseOptionalString(
      (payload as Record<string, unknown>).workingDirectory ?? (payload as Record<string, unknown>).directory,
    );

    if (templateDir && workingDirectory) {
      return Response.json({ error: "Specify either a template directory or a working directory, not both" }, { status: 400 });
    }

    if (!templateDir && !workingDirectory) {
      return Response.json({ error: "Provide either a template directory or a working directory" }, { status: 400 });
    }

    const activeRoot = templateDir
      ? normaliseOptionalString(
          (payload as Record<string, unknown>).activeRoot ?? (payload as Record<string, unknown>).activeDirectory,
        ) ?? "orchestrator/active"
      : null;

    const directoryPrefixInput = normaliseOptionalString(
      (payload as Record<string, unknown>).directoryPrefix ?? (payload as Record<string, unknown>).prefix,
    );
    const directoryPrefix = templateDir
      ? directoryPrefixInput ?? sanitiseDirectoryPrefix(label)
      : directoryPrefixInput ?? null;

    const introMessage = normaliseOptionalString((payload as Record<string, unknown>).introMessage);

    const pollTimeoutMs = parsePresetInteger((payload as Record<string, unknown>).pollTimeoutMs, 30000, 1000);
    const pollIntervalMs = parsePresetInteger((payload as Record<string, unknown>).pollIntervalMs, 250, 50);
    const retryAttempts = parsePresetInteger((payload as Record<string, unknown>).retryAttempts, 10, 1);
    const retryDelayMs = parsePresetInteger((payload as Record<string, unknown>).retryDelayMs, 1000, 0);

    try {
      const preset = orchestratorPresetStore.createPreset({
        label,
        agent,
        templateDir,
        activeRoot,
        directoryPrefix,
        workingDirectory: templateDir ? null : workingDirectory,
        introMessage,
        pollTimeoutMs,
        pollIntervalMs,
        retryAttempts,
        retryDelayMs,
      });
      return Response.json({ preset }, { status: 201 });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  }

  if (pathname === "/api/directories" && method === "GET") {
    const denied = await ensureApiAccess(AccessActions.FilesRead, request, url, authContext);
    if (denied) {
      return denied;
    }
    try {
      const data = await listDirectories(
        url.searchParams.get("path"),
        url.searchParams.get("query") ?? undefined,
        workspaceScope,
      );
      return Response.json(data);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  if (pathname === "/api/directories" && method === "POST") {
    const denied = await ensureApiAccess(AccessActions.FilesWrite, request, url, authContext);
    if (denied) {
      return denied;
    }
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const parentInput = (payload as Record<string, unknown>).parent;
    const nameInput = (payload as Record<string, unknown>).name;

    try {
      const data = await createDirectoryEntry(
        typeof parentInput === "string" ? parentInput : null,
        nameInput,
      );
      return Response.json(data, { status: 201 });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  if (pathname === "/api/uploads/images" && method === "POST") {
    const denied = await ensureApiAccess(AccessActions.FilesWrite, request, url, authContext);
    if (denied) {
      return denied;
    }
    let form: FormData;
    try {
      // Read body as blob first to work around cloudflared streaming issues
      const contentType = request.headers.get("content-type") ?? "";
      const bodyBlob = await request.blob();
      const bufferedRequest = new Request(request.url, {
        method: request.method,
        headers: { "content-type": contentType },
        body: bodyBlob,
      });
      form = await bufferedRequest.formData();
    } catch {
      return Response.json({ error: "Invalid form data" }, { status: 400 });
    }

    const agentInput = form.get("agent");
    const agent = typeof agentInput === "string" ? agentInput.toLowerCase() : "";
    if (!isAgentType(agent)) {
      return Response.json({ error: "Unsupported agent target" }, { status: 400 });
    }

    const fileEntry = form.get("image");
    if (!fileEntry || typeof (fileEntry as Blob).arrayBuffer !== "function") {
      return Response.json({ error: "Image file is required" }, { status: 400 });
    }

    const file = fileEntry as Blob & { name?: string; size: number; type?: string };

    if (file.size === 0) {
      return Response.json({ error: "Empty files are not allowed" }, { status: 400 });
    }

    if (file.size > maxImageSizeBytes) {
      return Response.json({ error: "Image exceeds 10MB limit" }, { status: 413 });
    }

    if (!file.type?.startsWith("image/")) {
      return Response.json({ error: "Only image uploads are supported" }, { status: 400 });
    }

    const userNpub = authContext.npub ?? null;
    const imageSegment = deriveNpubSegment(userNpub);
    let directory: string;
    try {
      directory = await ensureImageDirectory(agent, userNpub);
    } catch (error) {
      console.error("[uploads] failed to ensure directory", error);
      return Response.json({ error: "Failed to prepare image storage" }, { status: 500 });
    }

    const filename = createImageFilename(file.name ?? "upload", file.type ?? "");
    const diskPath = join(directory, filename);
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      await writeFile(diskPath, buffer);
    } catch (error) {
      console.error("[uploads] failed to persist image", error);
      return Response.json({ error: "Failed to store image" }, { status: 500 });
    }

      const relativePath = normalize(join(imageSegment, agent, filename)).replace(/\\/g, "/");
      const publicPath = `/uploads/images/${relativePath}`;
    const placeholder = buildAgentImagePlaceholder(agent, diskPath, `${publicPath}`);

    return Response.json({
      agent,
      name: file.name,
      publicPath,
      relativePath,
      placeholder,
    });
  }

  if (pathname === "/api/uploads/files" && method === "POST") {
    const denied = await ensureApiAccess(AccessActions.FilesWrite, request, url, authContext);
    if (denied) {
      return denied;
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return Response.json({ error: "Invalid form data" }, { status: 400 });
    }

    const agentInput = form.get("agent");
    const agent = typeof agentInput === "string" ? agentInput.toLowerCase() : "";
    if (!isAgentType(agent)) {
      return Response.json({ error: "Unsupported agent target" }, { status: 400 });
    }

    const fileEntries = form.getAll("file").filter((entry) => entry && typeof (entry as Blob).arrayBuffer === "function");
    if (fileEntries.length === 0) {
      return Response.json({ error: "File upload payload is required" }, { status: 400 });
    }

    const userNpub = authContext.npub ?? null;
    const attachmentSegment = deriveNpubSegment(userNpub);
    let directory: string;
    try {
      directory = await ensureAttachmentDirectory(agent, userNpub);
    } catch (error) {
      console.error("[uploads] failed to ensure attachment directory", error);
      return Response.json({ error: "Failed to prepare file storage" }, { status: 500 });
    }

    const results = [];
    for (const entry of fileEntries) {
      const file = entry as Blob & { name?: string; size: number; type?: string };
      if (file.size === 0) {
        return Response.json({ error: "Empty files are not allowed" }, { status: 400 });
      }
      if (file.size > maxAttachmentSizeBytes) {
        return Response.json({ error: "File exceeds 25MB limit" }, { status: 413 });
      }

      const filename = createAttachmentFilename(file.name ?? "upload", file.type ?? "");
      const diskPath = join(directory, filename);
      try {
        const buffer = Buffer.from(await file.arrayBuffer());
        await writeFile(diskPath, buffer);
      } catch (error) {
        console.error("[uploads] failed to persist attachment", error);
        return Response.json({ error: "Failed to store file" }, { status: 500 });
      }

      const relativePath = normalize(join(attachmentSegment, agent, filename)).replace(/\\/g, "/");
      const publicPath = `/uploads/files/${relativePath}`;
      const placeholder = buildAgentFilePlaceholder(agent, diskPath, publicPath, file.name);
      results.push({
        agent,
        name: file.name ?? filename,
        size: file.size,
        mime: file.type ?? null,
        publicPath,
        relativePath,
        absolutePath: diskPath,
        placeholder,
      });
    }

    return Response.json({ files: results }, { status: 201 });
  }

  // Session & archive API routes (delegated to session-api-routes.ts)
  if (pathname.startsWith("/api/archive") || pathname.startsWith("/api/sessions")) {
    const sessionApiResponse = await handleSessionApi(request, url, method, authContext, sessionApiContext);
    if (sessionApiResponse) return sessionApiResponse;
  }

  if (pathname.startsWith("/api/orchestrators/")) {
    if (!orchestratorEnabled) {
      return Response.json({ error: "orchestrator-disabled" }, { status: 403 });
    }
    const parts = pathname.split("/");
    const id = parts[3];
    if (!id) {
      return Response.json({ error: "Preset id required" }, { status: 400 });
    }

    if (method === "GET" && parts.length === 4) {
      const preset = orchestratorPresetStore.getPreset(id);
      if (!preset) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return Response.json({
        preset: {
          id: preset.id,
          label: preset.label,
          agent: preset.agent,
          templateDir: preset.templateDir,
          activeRoot: preset.activeRoot,
          directoryPrefix: preset.directoryPrefix,
          workingDirectory: preset.workingDirectory,
          introMessage: preset.introMessage,
          pollTimeoutMs: preset.pollTimeoutMs,
          pollIntervalMs: preset.pollIntervalMs,
          retryAttempts: preset.retryAttempts,
          retryDelayMs: preset.retryDelayMs,
        },
      });
    }

    if (method === "POST" && parts[4] === "launch") {
      const balanceCheck = ensureViewerHasBalance(authContext, {
        feature: "launch this orchestrator preset",
        message: "Add sats to your balance to launch this orchestrator preset.",
      });
      if (balanceCheck instanceof Response) {
        return balanceCheck;
      }
      try {
        const { directory, session } = await launchOrchestratorPreset(id);
        return Response.json({ directory, session }, { status: 201 });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 500 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // POST /api/sessions is handled by sessionApiContext above

  // GET /api/artifacts/:id/raw — Serve artifact file content
  if (pathname.startsWith("/api/artifacts/") && method === "GET") {
    const artParts = pathname.split("/");
    const artifactId = artParts[3];
    if (artifactId && artParts[4] === "raw") {
      const denied = await ensureApiAccess(AccessActions.SessionsManage, request, url, authContext);
      if (denied) return denied;

      const artifact = artifactsStore.get(artifactId);
      if (!artifact) {
        return Response.json({ error: "Artifact not found" }, { status: 404 });
      }

      try {
        const file = Bun.file(artifact.filePath);
        if (!(await file.exists())) {
          return Response.json({ error: "Artifact file not found on disk" }, { status: 404 });
        }
        return new Response(file, {
          headers: {
            "Content-Type": artifact.mimeType || "application/octet-stream",
            "Cache-Control": "private, max-age=3600",
          },
        });
      } catch {
        return Response.json({ error: "Failed to read artifact file" }, { status: 500 });
      }
    }
  }

  // User settings API
  if (pathname.startsWith("/api/user/settings")) {
    const denied = await ensureApiAccess(AccessActions.SessionsManage, request, url, authContext);
    if (denied) return denied;

    const viewerNpub = authContext.npub;
    if (!viewerNpub) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const settingsParts = pathname.split("/");
    const settingKey = settingsParts[4]; // /api/user/settings/:key

    if (method === "GET" && !settingKey) {
      // GET /api/user/settings — list all settings for user
      const settings = userSettingsStore.getAll(viewerNpub);
      // Mask sensitive keys
      const masked: Record<string, string> = {};
      for (const [k, v] of Object.entries(settings)) {
        masked[k] = k.includes("key") || k.includes("secret")
          ? (v.length > 8 ? `${v.slice(0, 4)}..${v.slice(-4)}` : "****")
          : v;
      }
      return Response.json({ settings: masked });
    }

    if (method === "PUT" && settingKey) {
      // PUT /api/user/settings/:key — set a setting
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
      const record = payload as Record<string, unknown>;
      const value = typeof record.value === "string" ? record.value.trim() : "";
      if (!value) {
        return Response.json({ error: "value is required" }, { status: 400 });
      }
      userSettingsStore.set(viewerNpub, settingKey, value);
      return Response.json({ success: true, key: settingKey });
    }

    if (method === "DELETE" && settingKey) {
      // DELETE /api/user/settings/:key — remove a setting
      userSettingsStore.delete(viewerNpub, settingKey);
      return Response.json({ success: true, key: settingKey, deleted: true });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // /api/sessions/:id/* routes are handled by sessionApiContext above

  return Response.json({ error: "Not found" }, { status: 404 });
};

const server = Bun.serve({
  port: config.port,
  // Disable idle timeout for SSE connections (default is 10 seconds)
  idleTimeout: 255, // Max value in seconds (about 4 minutes)
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method as HttpMethod;
    const authContext = resolveRequestAuthContext(request);

    const response = await runWithRequestContext(authContext, async () => {
      if (authContext.error) {
        console.warn(`[auth] ignoring invalid session cookie: ${authContext.error}`);
      }

      const pathname = url.pathname;

      const webhookResponse = await handleWebhookRequest(request, url);
      if (webhookResponse) {
        return webhookResponse;
      }

      // Handle subdomain-based app routing (e.g., bold-gem-boat.apps.example.com)
      // Check if this is a subdomain request FIRST - app subdomains should proxy all paths
      const host = request.headers.get("host");
      const hostWithoutPort = host?.split(":")[0]?.toLowerCase() ?? "";
      const baseDomain = subdomainProxyConfig.baseDomain?.toLowerCase() ?? "";
      const isAppSubdomain = subdomainProxyConfig.enabled &&
        baseDomain &&
        hostWithoutPort.endsWith(`.${baseDomain}`) &&
        // Exclude numeric port subdomains (e.g., 30500.wmhost.app)
        !hostWithoutPort.match(/^\d+\./);

      if (isAppSubdomain) {
        // For app subdomains, proxy ALL requests regardless of path
        const subdomainResponse = await handleSubdomainRequest(request, subdomainProxyConfig);
        if (subdomainResponse) {
          return subdomainResponse;
        }
      }

      // For non-subdomain requests, skip routing for Wingman's own API and UI paths
      const isWingmanPath = pathname.startsWith("/api/") ||
        pathname.startsWith("/home") ||
        pathname.startsWith("/live") ||
        pathname.startsWith("/settings") ||
        pathname.startsWith("/uploads/") ||
        pathname.startsWith("/projects") ||
        pathname.startsWith("/apps") ||
        pathname.startsWith("/nightwatch") ||
        pathname.startsWith("/scheduler") ||
        pathname.startsWith("/triggers") ||
        pathname.startsWith("/orchestrator") ||
        pathname.startsWith("/auth") ||
        pathname === "/" ||
        pathname === "/favicon.ico";

      if (!isWingmanPath) {
        // Handle any other subdomain patterns (numeric ports, etc.)
        const subdomainResponse = await handleSubdomainRequest(request, subdomainProxyConfig);
        if (subdomainResponse) {
          return subdomainResponse;
        }
      }

      // Handle path-based app routing (/host/<alias> and /host/<alias>/*)
      if (pathname.startsWith("/host/")) {
        const pathHostResponse = await handlePathBasedAppRequest(request, pathname);
        if (pathHostResponse) {
          return pathHostResponse;
        }
      }

      if (pathname === "/" && method === "GET") {
        return Response.redirect(`${url.origin}/home${url.search}`, 302);
      }

      const isSpaRoutePath =
        pathname === "/home" ||
        pathname === "/apps" ||
        pathname.startsWith("/apps/") ||
        pathname === "/projects" ||
        pathname.startsWith("/projects/") ||
        pathname === "/todos" ||
        pathname.startsWith("/todos/") ||
        pathname === "/docs" ||
        pathname.startsWith("/docs/") ||
        pathname === "/files" ||
        pathname.startsWith("/files/") ||
        pathname === "/live" ||
        pathname.startsWith("/live/") ||
        pathname === "/chat" ||
        pathname.startsWith("/chat/") ||
        pathname === "/settings" ||
        pathname.startsWith("/settings/") ||
        pathname === "/privacy" ||
        pathname === "/nightwatch" ||
        pathname.startsWith("/nightwatch/") ||
        pathname === "/scheduler" ||
        pathname.startsWith("/scheduler/") ||
        pathname === "/triggers" ||
        pathname.startsWith("/triggers/");

      if (isSpaRoutePath && !assetService.isUiAssetPath(pathname)) {
        return compressResponse(request, await serveIndex());
      }

      // Serve UI module assets before API routing so paths like
      // /api/admin-users.js resolve to src/ui/api/ instead of the
      // JSON API handler.
      const earlyUiAsset = assetService.resolveUiAsset(pathname);
      if (earlyUiAsset) {
        return compressResponse(request, earlyUiAsset);
      }

      if (pathname.startsWith("/api/")) {
        return handleApi(request, url, method, authContext);
      }

      const tempAttachment = resolveTempAttachment(pathname, authContext);
      if (tempAttachment) {
        return tempAttachment;
      }

      const tempImage = resolveTempImage(pathname, authContext);
      if (tempImage) {
        return tempImage;
      }

      const aceAsset = assetService.serveAceBuildsAsset(pathname);
      if (aceAsset) {
        return compressResponse(request, aceAsset);
      }

      // Vendor modules handle their own gzip caching internally
      const vendorAsset = await assetService.serveVendorModule(pathname);
      if (vendorAsset) {
        return vendorAsset;
      }

      const assetResponse = assetService.resolveUiAsset(pathname);
      if (assetResponse) {
        return compressResponse(request, assetResponse);
      }

      const publicAsset = assetService.servePublicAsset(pathname);
      if (publicAsset) {
        return compressResponse(request, publicAsset);
      }

      return new Response("Not Found", { status: 404 });
    });

    return maybeRefreshSessionCookie(response, authContext);
  },
});

const stopAllSessions = async () => {
  if (preserveSessionsOnShutdown || config.agentSpawnMode === "pm2") {
    const reason = preserveSessionsOnShutdown ? "warm restart" : "pm2 agent spawn mode";
    console.log(`[shutdown] preserving running agent sessions (${reason})`);
    return;
  }

  const sessions = manager.listSessions();
  for (const session of sessions) {
    try {
      await manager.stopSession(session.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[shutdown] failed to stop session ${session.id}: ${message}`);
    }
  }
};

let shuttingDown = false;
const initiateShutdown = async (reason: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] initiated by ${reason}. Shutting down services...`);

  try {
    triggerListener.shutdown();
  } catch (error) {
    console.warn(`[shutdown] failed to stop trigger listener: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    schedulerEngine.stop();
  } catch (error) {
    console.warn(`[shutdown] failed to stop scheduler engine: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    fileWatcherRunner.stop();
  } catch (error) {
    console.warn(`[shutdown] failed to stop file watcher runner: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    server.stop();
  } catch (error) {
    console.warn(`[shutdown] failed to stop server: ${error instanceof Error ? error.message : String(error)}`);
  }

  await stopAllSessions();
  process.exit(0);
};

const registerShutdownHandlers = () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGQUIT"] as const) {
    process.on(signal, () => {
      void initiateShutdown(signal);
    });
  }
};

registerShutdownHandlers();

console.log(
  `Wingman V2 orchestrator listening on http://localhost:${config.port} (agents ${config.agentPortStart} - ${config.agentPortStart + config.agentPortMax - 1})`,
);

// Start scheduler engine (loads enabled jobs from DB)
schedulerEngine.start();

// Ensure admin has balance after all env vars are loaded (important for first-run wizard)
identityUserStore.ensureAdminBalance();

export { server, manager, config };
