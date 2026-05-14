import { randomUUID, timingSafeEqual } from "node:crypto";
import { type Dirent } from "node:fs";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve as resolvePath, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import "./logging/server-logger";

import { AGENT_TYPES as SUPPORTED_AGENT_TYPES, isAgentType, type AgentType } from "./agent-types";
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
  appProcessManager,
  type AppProcessStatus,
} from "./apps/app-process-manager";
import { scanDirectoryTree } from "./apps/app-detector";

/** Tmux session for the Wingman core process (used by warm restart manager). */
const WINGMAN_CORE_TMUX_SESSION = "wingman-apps";
import { messageStore } from "./storage/message-store";
import type { SessionMetadataInput } from "./sessions/session-metadata";
import { scheduleSessionArchive, cancelPendingArchive } from "./storage/session-archiver";
import { sessionArchiveStore } from "./storage/session-archive-store";
import { PromptQueueStore } from "./storage/prompt-queue-store";
import { fileWatcherStore } from "./storage/file-watcher-store";
import {
  featureFlagStore,
  normaliseFeatureFlagKey,
  resolveFeatureFlagEffectiveState,
  type FeatureFlagState,
} from "./storage/feature-flag-store";
import { starterProjectStore } from "./storage/starter-project-store";
import { WorkspaceDelegationStore } from "./storage/workspace-delegation-store";
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
import { CODEX_NATIVE_SDK_FLAG, OPENCODE_NATIVE_SDK_FLAG } from "./agents/agent-adapter";
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
import { loadWingmanInstanceIdentity } from "./identity/wingman-instance-identity";
import { isSharedInstanceAccessEnabled } from "./shared-instance";
import { WorkspaceSubscriptionManager } from './agent-chat/subscription-runtime';
import { DispatchPipelineRuntime } from './agent-chat/dispatch-pipelines/runtime';
import { AgentCommentSessionRuntime } from './agent-chat/comment-session-runtime';
import { AgentChatSessionRuntime } from './agent-chat/session-runtime';
import { AgentWorkSessionRuntime } from './agent-work/session-runtime';
import { AgentWorkSessionIdleRetention } from './agent-work/session-idle-retention';
import { MemoryStore } from "./mcp/memory-store";
import { userSettingsStore } from "./storage/user-settings-store";
import { artifactsStore } from "./storage/artifacts-store";
import { resumeRunningPipelineRuns } from "./pipelines/pipeline-api-routes";
import { type JsonObject, PipelineStore } from "./pipelines/pipeline-store";
import { getPipelineDefinition } from "./pipelines/pipeline-loader";
import { loadPipelineFunctionRegistry } from "./pipelines/function-loader";
import { builtinPipelineFunctions } from "./pipelines/functions";
import { runDeclarativePipeline } from "./pipelines/pipeline-runner";
import {
  buildAgentUrl,
  normaliseHostForUrl,
  parseAllowedHosts,
  pickAgentHost,
} from "./agents/agent-client";
import { AgentRuntimeStatusPoller } from "./agents/agent-status-poller";
import { LiveMessagePersistenceLoop } from "./server/live-message-persistence";
import { syncLiveSessionMessages } from "./server/live-session-messages";
import { getSessionCookieName, mintSessionCookie, SessionCookieError, SESSION_COOKIE_NAME } from "./auth/session-cookie";
import {
  resolveRequestAuthContext,
  runWithRequestContext,
  getRequestContext,
  type RequestAuthContext,
} from "./auth/request-context";
import { getEffectiveOwnerAuthContext, getEffectiveOwnerNpub } from "./auth/effective-owner";
import { resolveNip98AuthContext } from "./auth/nip98-auth";
import { deriveNpubSegment, normaliseNpub } from "./identity/npub-utils";
import { generateIdentityAlias } from "./identity/identity-alias";
import { resolveSessionOwnerNpub, sessionBelongsToViewer as sessionOwnerMatchesViewer } from "./sessions/session-ownership";
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
import {
  MAX_DIRECTORY_RESULTS,
  DIRECTORY_BROWSER_ROOT,
  expandHomeDirectory,
  formatHomeRelativePath,
  formatRootDirectoryName,
  ensureWithinBase,
  createPathUtils,
} from "./server/path-utils";
import { createStaticAssetService, compressResponse } from "./server/static-assets";
import { maybeRefreshSessionCookie } from "./server/session-refresh";
import { handleSubdomainRequest, resolveAliasToPort, proxyRequestToApp, type SubdomainProxyConfig } from "./server/subdomain-proxy";
import { isAgentRuntimeStatus } from "./types/agent-status";
import { scheduleCleanup } from "./uploads/cleanup";
import { createSessionEventsHandler } from "./server/session-events";
import { sessionBroadcaster, createSessionSubscribeResponse } from "./server/session-broadcaster";
import { type ChatApiContext } from "./server/chat-routes";
import { type SessionApiContext } from "./server/session-api-routes";
import { parseNightWatchStartOptions } from "./nightwatch/nightwatch-start-config";
import { type ProviderProxyApiContext } from "./server/provider-proxy-routes";
import { type BillingApiContext } from "./server/billing-routes";
import { type DocsApiContext } from "./server/docs-routes";
import { type AdminUsersApiContext } from "./server/admin-users-routes";
import { type AuthApiContext } from "./server/auth-routes";
import {
  serialiseFeatureFlagsForViewer,
} from "./server/feature-flags-routes";
import {
  resolveTempImage,
  resolveTempAttachment,
  type UploadApiContext,
} from "./server/upload-routes";
import { performSystemCleanup } from "./server/system-cleanup.js";
import { type SystemRoutesContext } from "./server/system-routes";
import { createApiRouteHandler } from "./server/api-routes";
import { ensureAgentApiBinary } from "./server/bootstrap/agentapi";
import { SchedulerStore } from "./scheduler/scheduler-store";
import { SchedulerEngine } from "./scheduler/scheduler-engine";
import { createSchedulerApiHandler } from "./scheduler/scheduler-api";
import { createAutopilotJobsApiHandler } from "./jobs-api";
import { wappStore } from "./wapps/wapp-store";
import { LocalPayloadWappPublisher } from "./wapps/wapp-publisher";
import { createTriggerListener, type TriggerListener } from "./nostr/trigger-listener";
import {
  clearWarmRestartMarker,
  loadWarmRestartMarker,
  rehydrateWarmSessions,
  rehydrateOrphanedSessions,
  warmRestartOutcome,
  warmRestartState,
  writeWarmRestartMarker,
} from "./server/bootstrap/warm-restart";
import type { WarmRestartMarker } from "./server/bootstrap/warm-restart";
import { reconcileAppsWithPM2 } from "./server/bootstrap/pm2-reconcile";
import { cleanupOrphanedAgentProcesses } from "./server/bootstrap/pm2-agent-cleanup";
import { ensureWingmanCoreRegistration } from "./server/bootstrap/wingman-core-registry";
import { connectPM2 } from "./agents/pm2-wrapper";
import { createUploadHelpers } from "./server/uploads/helpers";
import { resolveAndCacheNostrProfile } from "./server/nostr-profile";
import { waitForSessionPromptReadiness } from "./server/session-readiness";
import { getSessionPromptReadiness } from "./server/prompt-readiness";
import { resolveTaskExecutorOwnerNpub } from "./server/task-executor-owner";
import { createPromptDispatchEngine, QueueDispatchError } from "./server/prompt-dispatch";
import { TeamBillingService } from "./billing/team-billing-service";
import {
  validateForkInput,
  getRecentMessages,
  formatMessagesAsContext,
} from "./sessions/fork-to-worktree";
import {
  type CommandResult,
  type GitRepositorySummary,
  type GitWorktreeSummary,
  type GitCommandAction,
  type CreateWorktreeOptions,
  type CreateWorktreeResult,
  runCommand,
  resolveRealPath,
  executeGitCommand,
  describeGitRepository,
  ensureBranchNameValid,
  branchExists,
  ensureStartPointResolvable,
  createGitWorktree,
} from "./server/git-operations";

const config = loadConfig();
const wingmanInstanceIdentity = loadWingmanInstanceIdentity();
const wappPublisher = new LocalPayloadWappPublisher();
if (wingmanInstanceIdentity) {
  console.log(`[identity] Wingman instance identity configured: ${wingmanInstanceIdentity.npub.slice(0, 20)}...`);
} else {
  console.warn("[identity] WINGMAN_PRIV not configured; shared Wingman bot identity is missing");
}
const migratedUserSettingCount = userSettingsStore.migrateSensitiveValues();
if (migratedUserSettingCount > 0) {
  console.log(`[config] migrated ${migratedUserSettingCount} sensitive user setting(s) to encrypted storage`);
}
const adminNpub = normaliseNpub(Bun.env.ADMIN_NPUB ?? null);
const agentHosts = parseAllowedHosts(config.allowedHosts);
const agentHost = normaliseHostForUrl(pickAgentHost(agentHosts));

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
const PROJECTS_FLAG_KEY = "projects_visibility";
const FEATURE_FLAG_DEFAULTS: Array<{
  key: string;
  label: string;
  description: string;
  state: FeatureFlagState;
}> = [
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
  {
    key: CODEX_NATIVE_SDK_FLAG,
    label: "Codex Native SDK",
    description: "Use @openai/codex-sdk directly instead of agentapi for Codex sessions.",
    state: "off",
  },
  {
    key: OPENCODE_NATIVE_SDK_FLAG,
    label: "OpenCode Native SDK",
    description: "Use @opencode-ai/sdk directly instead of agentapi for OpenCode sessions.",
    state: "off",
  },
];

featureFlagStore.ensureDefaults(FEATURE_FLAG_DEFAULTS);
process.env.WINGMAN_PID = process.pid.toString();
const projectStore = new ProjectStore();
const todoStore = new TodoStore();
const promptQueueStore = new PromptQueueStore("data/prompt-queue.db");
const pipelineStore = new PipelineStore();
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
const workspaceDelegationStore = new WorkspaceDelegationStore();
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
  nightWatchStore,
  createSession: (agent, dir, name, origin, targetFile, explicitNpub, metadata) =>
    manager.createSession(agent, dir, name, origin, targetFile, explicitNpub, metadata),
  addPrompt: (sid, content) => promptQueueStore.addPrompt(sid, { content }),
  dispatchPrompt: (session) => {
    void maybeAutoDispatchQueuedPrompt(session);
  },
  awaitSessionReadyForPrompt: async (session, agent) => {
    const timeoutMs = agent === "codex" ? 120000 : 60000;
    await waitForSessionPromptReadiness({
      getSession: (sessionId) => manager.getSession(sessionId) ?? null,
      getAdapter: (sessionId) => manager.getAdapter(sessionId),
      sessionId: session.id,
      host: agentHost,
      timeoutMs,
      pollIntervalMs: 250,
      requiredStablePolls: agent === "codex" ? 3 : 2,
      requestTimeoutMs: 750,
    });
    markPromptStartupReady(session.id);
  },
  runPipeline: async (job, input: JsonObject) => {
    if (!job.pipelineDefinitionId) {
      throw new Error("Pipeline trigger has no pipeline definition selected");
    }
    const ownerAlias = generateIdentityAlias(job.userNpub);
    const definition = await getPipelineDefinition(job.pipelineDefinitionId, ownerAlias);
    if (!definition) {
      throw new Error(`Pipeline definition not found: ${job.pipelineDefinitionId}`);
    }
    const functions = await loadPipelineFunctionRegistry(ownerAlias, builtinPipelineFunctions);
    const run = await runDeclarativePipeline({
      store: pipelineStore,
      sessionApiContext,
      definition,
      registry: functions.registry,
      input,
      ownerNpub: job.userNpub,
      ownerAlias,
      callbackOrigin: `http://127.0.0.1:${config.port}`,
    });
    return run.id;
  },
  onBotKeyUnlocked: onBotKeyUnlockedHook,
  getInstanceIdentity: () => wingmanInstanceIdentity,
});
const schedulerApiHandler = createSchedulerApiHandler({
  store: schedulerStore,
  engine: schedulerEngine,
  getInstanceIdentity: () => wingmanInstanceIdentity,
  getNpub: (request: Request) => {
    const ctx = getRequestContext();
    return ctx?.npub ?? null;
  },
});
const autopilotJobsApiHandler = (
  request: Request,
  url: URL,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  authContext: RequestAuthContext,
) => createAutopilotJobsApiHandler({ sessionApiContext })(request, url, method, authContext);
const nip98GrantsStore = new Nip98GrantStore();
const memoryStore = new MemoryStore();
const nip98ApiHandler = createNip98ApiHandler({
  grantsStore: nip98GrantsStore,
  getSession: (sid: string) => manager.getSession(sid) ?? null,
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
  getStoredSession: (sid: string) => messageStore.getSession(sid),
  onBotKeyUnlocked: onBotKeyUnlockedHook,
  defaultRelays: config.connectRelays,
  getInstanceIdentity: () => loadWingmanInstanceIdentity(),
  isAdminNpub: (npub) => {
    if (!adminNpub) return false;
    return normaliseNpub(npub ?? null) === adminNpub;
  },
});
const botCryptoApiHandler = createBotCryptoApiHandler({
  getSession: (sid: string) => manager.getSession(sid),
  getStoredSession: (sid: string) => messageStore.getSession(sid),
  getInstanceIdentity: () => wingmanInstanceIdentity,
});
const wingmanDataDir = new URL("../data", import.meta.url).pathname;
const giteaApiHandler = createGiteaApiHandler({
  getSession: (sid: string) => manager.getSession(sid),
  config,
  dataDir: wingmanDataDir,
});
const gitWorkflowApiHandler = createGitWorkflowApiHandler({
  getSession: (sid: string) => manager.getSession(sid),
  config,
  dataDir: wingmanDataDir,
  executeGitCommand,
});
const workspaceSubscriptionManager = new WorkspaceSubscriptionManager({
  botKeyStore,
  getInstanceIdentity: () => wingmanInstanceIdentity,
});
let sessionApiContextRef: SessionApiContext | null = null;

const APPROVED_WORK_ROLES = new Set(["approved", "onboard"]);

const isUserApprovedForWork = (npub: string | null | undefined): boolean => {
  const normalized = normaliseNpub(npub ?? null);
  if (!normalized) {
    return false;
  }
  if (adminNpub && normalized === adminNpub) {
    return true;
  }
  const record = identityUserStore.getByNormalized(normalized);
  return Boolean(record?.roles.some((role) => APPROVED_WORK_ROLES.has(role)));
};

const requireApprovedWorkAccess = (): AccessRule => {
  return (context) => {
    const ownerNpub = getEffectiveOwnerNpub(context.auth);
    return isUserApprovedForWork(ownerNpub)
      ? allow()
      : deny("approval-required", 403);
  };
};

registerAccessRule(AccessActions.SessionsManage, requireAuthentication({ allowNip98: true }));
registerAccessRule(AccessActions.SessionsManage, requireApprovedWorkAccess());
registerAccessRule(AccessActions.FilesRead, requireAuthentication({ allowNip98: true }));
registerAccessRule(AccessActions.FilesRead, requireApprovedWorkAccess());
registerAccessRule(AccessActions.FilesWrite, requireAuthentication({ allowNip98: true }));
registerAccessRule(AccessActions.FilesWrite, requireApprovedWorkAccess());
registerAccessRule(AccessActions.AppsManage, requireAuthentication({ allowNip98: true }));
registerAccessRule(AccessActions.AppsManage, requireApprovedWorkAccess());
registerAccessRule(AccessActions.UiRestricted, requireAuthentication());
registerAccessRule(AccessActions.TodosManage, requireAuthentication());
registerAccessRule(AccessActions.TodosManage, requireApprovedWorkAccess());
registerAccessRule(AccessActions.ProjectsManage, requireAuthentication());
registerAccessRule(AccessActions.ProjectsManage, requireApprovedWorkAccess());
registerAccessRule(AccessActions.DeploymentsManage, requireAuthentication());
registerAccessRule(AccessActions.DeploymentsManage, requireApprovedWorkAccess());

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

const {
  ensureWithinAllowedDirectories,
  toAbsoluteDirectory,
  ensureDirectory,
  listRootDirectories,
  resolveDirectoryParent,
  toProjectRelativePath,
} = createPathUtils(resolveWorkspace, projectRoot);
warmRestartState.marker = warmRestartMarker;

// Initialize PM2 connection
try {
  await connectPM2();
  console.log("[pm2] connected to PM2 daemon");
} catch (error) {
  console.warn(`[pm2] failed to connect to PM2: ${(error as Error).message}`);
}

const teamBillingService = new TeamBillingService({
  listIdentityMembers: () =>
    identityUserStore.listUsers().map((user) => ({
      normalizedNpub: user.normalizedNpub,
      npub: user.npub,
    })),
  serverPort: config.port,
  baseUrl: config.baseUrl,
});
teamBillingService.syncTeamMembers();
if (teamBillingService.isCreditsEnabled()) {
  void teamBillingService.primeProviderKeyCache().catch((error) => {
    console.warn(`[billing] failed to prime provider key cache on startup: ${(error as Error).message}`);
  });
}

const manager = new ProcessManager(config, {
  resolveBillingLaunchConfig: (input) => teamBillingService.resolveLaunchConfig(input),
  recordAdapterUsage: async (data) => {
    await teamBillingService.recordProxyUsage({
      sessionId: data.sessionId,
      npub: data.npub,
      agent: data.agent,
      endpoint: data.endpoint,
      method: 'POST',
      statusCode: 200,
      costUsd: data.costUsd ?? null,
    });
  },
});

const sharedInstanceAccessEnabled = isSharedInstanceAccessEnabled();

const wingmanMcpApiHandler = createWingmanMcpApiHandler({
  getSession: (sid: string) => manager.getSession(sid) ?? null,
  listSessions: () => manager.listSessions(),
  createSession: (agent, dir, name, explicitNpub, origin, metadata) =>
    manager.createSession(agent, dir, name, origin, undefined, explicitNpub, metadata),
  enableNightWatch: (sessionId, options) =>
    nightWatchStore.enableSession(sessionId, {
      prompt: options?.prompt,
      intervalMinutes: options?.intervalMinutes,
      maxCycles: options?.maxCycles,
    }),
  stopSession: async (sid) => (await manager.stopSession(sid)) ?? null,
  scheduleArchive: (sid) => scheduleSessionArchive(sid, manager),
  getSessionLogs: (sid) => manager.getLogs(sid),
  getSessionMessages: async (sid) => {
    const msgs = await syncSessionMessages(sid);
    return (msgs ?? []).map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt }));
  },
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
  getWingmanNpub: () => wingmanInstanceIdentity?.npub ?? null,
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
  agentHost,
  messageStore,
  promptQueueStore,
  openRouterApiKey: Bun.env.OPENROUTER_API?.trim() || null,
  openRouterBaseUrl: "https://openrouter.ai/api",
  wingmanBaseUrl: config.baseUrl,
  getSession: (sid: string) => manager.getSession(sid) ?? null,
  updateSessionMetadata: (sid: string, metadata: SessionMetadataInput) =>
    manager.updateSessionMetadata(sid, metadata),
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
  onSessionComplete: (sessionId: string, _report: unknown) => {
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
const taskListenerIdentity = wingmanInstanceIdentity;
if (taskListenerIdentity && config.connectRelays.length > 0 && taskListenerFlag?.state !== "off") {
  const mgBaseUrl = Bun.env.MG_BASE_URL ?? "https://mg.otherstuff.ai";
  const taskExecutorOwnerNpub = resolveTaskExecutorOwnerNpub(adminNpub, taskListenerIdentity.npub);

  const executor = createTaskExecutor({
    signNip98: async (url, method, bodyHash) => {
      const { token } = await signWithWingmanKey(url, method, bodyHash);
      return token;
    },
    createSession: (agent, dir, name, origin, metadata) =>
      manager.createSession(agent, dir, name, origin, undefined, taskExecutorOwnerNpub, metadata),
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
    pubkeyHex: taskListenerIdentity.pubkeyHex,
    relays: config.connectRelays,
    onTaskAssigned: executor,
  });

  console.log(`[task-listener] MG task listener active (relays: ${config.connectRelays.length}, mgBaseUrl: ${mgBaseUrl})`);
} else if (!taskListenerIdentity) {
  console.log("[task-listener] No WINGMAN_PRIV configured, MG task listener disabled");
} else {
  console.log("[task-listener] No CONNECT_RELAYS configured, MG task listener disabled");
}

const wingmenRoot = join(projectRoot, ".wingmen");
await mkdir(wingmenRoot, { recursive: true }).catch(() => undefined);
const warmRestartManagerScriptPath = join(projectRoot, "scripts", "warm-restart-manager.ts");
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
  workspaceSubscriptionManager.shutdown();
});

const serializeSession = (session: SessionSnapshot) => ({
  ...session,
  ownerNpub: resolveSessionOwnerNpub(session.npub ?? null, session.metadata),
  agentRuntimeStatus: session.agentRuntimeStatus ?? null,
  identityAlias: generateIdentityAlias(resolveSessionOwnerNpub(session.npub ?? null, session.metadata)),
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
  const includeAll = sharedInstanceAccessEnabled || Boolean(options?.includeAll);
  if (!includeAll && !viewerNormalizedNpub) {
    return [];
  }

  const storedUsers = identityUserStore.listUsers();
  const portsByNormalized = new Map<string, number[]>(
    storedUsers.map((record) => [record.normalizedNpub, record.ports] as const),
  );
  const activeSessionMap = new Map(activeSessions.map((session) => [session.id, session] as const));
  type Accumulator = {
    npub: string | null;
    normalized: string | null;
    segment: string;
    alias: string;
    ports: number[];
    dataRoot: string;
    logsRoot: string;
    attachmentsRoot: string;
    imagesRoot: string;
    sessionIds: Set<string>;
    activeSessionIds: Set<string>;
    lastSeenMs: number;
  };

  const summaryMap = new Map<string, Accumulator>();

  const registerSession = (
    sessionNpub: string | null,
    metadata: SessionMetadataInput,
    sessionId: string,
    startedAt: string,
    isActive: boolean,
  ) => {
    const ownerNpub = resolveSessionOwnerNpub(sessionNpub, metadata);
    const normalized = normaliseNpub(ownerNpub);
    if (!includeAll) {
      if (!normalized || normalized !== viewerNormalizedNpub) {
        return;
      }
    }
    const key = normalized ?? "__anonymous__";
    let accumulator = summaryMap.get(key);
    if (!accumulator) {
      const segment = deriveNpubSegment(ownerNpub);
      const dataRoot = normalize(join(userIdentityRoot, segment));
      const logsRoot = normalize(join(dataRoot, "logs"));
      const attachmentsRoot = normalize(join(attachmentRoot, segment));
      const imagesRoot = normalize(join(imageRoot, segment));
      accumulator = {
        npub: ownerNpub,
        normalized,
        segment,
        alias: generateIdentityAlias(ownerNpub),
        ports: [],
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
    registerSession(record.npub ?? null, record.metadata, record.id, record.startedAt, activeSessionMap.has(record.id));
  }

  for (const session of activeSessions) {
    registerSession(session.npub ?? null, session.metadata, session.id, session.startedAt, true);
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
    }))
    .sort((a, b) => {
      const left = a.normalizedNpub ?? "";
      const right = b.normalizedNpub ?? "";
      return left.localeCompare(right);
    });
};


const getViewerNormalizedNpub = (authContext: RequestAuthContext): string | null => {
  return getEffectiveOwnerNpub(authContext);
};

const sessionBelongsToViewer = (
  sessionNpub: string | null | undefined,
  sessionMetadata: SessionMetadataInput,
  viewerNormalizedNpub: string | null,
  viewerIsAdmin: boolean,
): boolean => {
  if (sharedInstanceAccessEnabled && viewerNormalizedNpub) {
    return true;
  }
  return sessionOwnerMatchesViewer(sessionNpub, sessionMetadata, viewerNormalizedNpub, viewerIsAdmin);
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

scheduleCleanup({ root: imageRoot, ttlMs: ONE_DAY_MS, intervalMs: ONE_DAY_MS, label: "image" });
scheduleCleanup({ root: attachmentRoot, ttlMs: ONE_DAY_MS, intervalMs: ONE_DAY_MS, label: "attachment" });

manager.on((event) => {
  const sessionOwnerNpub = resolveSessionOwnerNpub(event.session.npub ?? null, event.session.metadata);

  if (event.type === "session-started") {
    ensureUserWorkspace(sessionOwnerNpub);
    if (sessionOwnerNpub) {
      try {
        identityUserStore.touch(sessionOwnerNpub, {
          alias: generateIdentityAlias(sessionOwnerNpub),
          lastSeenAt: new Date().toISOString(),
        });
      } catch (error) {
        console.warn(`[admin] failed to record identity ${sessionOwnerNpub}:`, error);
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
      tmuxSession: event.session.tmuxSession,
      tmuxWindow: event.session.tmuxWindow,
      metadata: event.session.metadata,
    });
    messageStore.replaceMessages(event.session.id, []);
    void maybeAutoDispatchQueuedPrompt(event.session);
    // Broadcast to browser so home page / nav live-refresh
    if (sessionOwnerNpub) {
      sessionBroadcaster.broadcast(sessionOwnerNpub, {
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
    if (sessionOwnerNpub) {
      sessionBroadcaster.broadcast(sessionOwnerNpub, {
        type: "session-deleted",
        sessionId: event.session.id,
        agent: event.session.agent,
        name: event.session.name ?? undefined,
      });
    }
    return;
  }
  if (event.type === "session-updated" || event.type === "session-stopped") {
    ensureUserWorkspace(sessionOwnerNpub);
    if (sessionOwnerNpub) {
      try {
        identityUserStore.touchExisting(sessionOwnerNpub, {
          lastSeenAt: new Date().toISOString(),
        });
      } catch (error) {
        console.warn(`[admin] failed to update identity ${sessionOwnerNpub}:`, error);
      }
      if (event.type === "session-stopped") {
        clearPromptStartupReady(event.session.id);
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
      tmuxSession: event.session.tmuxSession,
      tmuxWindow: event.session.tmuxWindow,
      metadata: event.session.metadata,
    });
    void maybeAutoDispatchQueuedPrompt(event.session);
    // Broadcast to browser so home page / nav live-refresh
    if (sessionOwnerNpub) {
      sessionBroadcaster.broadcast(sessionOwnerNpub, {
        type: event.type as "session-updated" | "session-stopped",
        sessionId: event.session.id,
        agent: event.session.agent,
        name: event.session.name ?? undefined,
        status: event.session.agentRuntimeStatus ?? undefined,
      });
    }
  }
});

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


const createDirectoryEntry = async (
  parentInput: string | null | undefined,
  nameInput: unknown,
  scopeOverride?: WorkspaceScope,
) => {
  const parentDirectory = await ensureDirectory(parentInput, scopeOverride);
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
  workspaceScopeOverride?: WorkspaceScope,
): Promise<string> => {
  const baseDirectory = await ensureDirectory(directoryInput, workspaceScopeOverride);
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
    const sessionNpub = resolveSessionOwnerNpub(session.npub ?? null, session.metadata);
    if (sessionNpub && sessionNpub === normalized) {
      sessionIds.add(session.id);
    }
  }
  const storedSessions = messageStore.listSessions();
  for (const record of storedSessions) {
    const recordNpub = resolveSessionOwnerNpub(record.npub ?? null, record.metadata);
    if (recordNpub && recordNpub === normalized) {
      sessionIds.add(record.id);
    }
  }
  for (const id of sessionIds) {
    await stopAndRemoveSession(id);
  }
};

const WEBHOOK_TOKEN_HEADER = "x-wingman-webhook-token";

const readWebhookBearerToken = (request: Request): string | null => {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : null;
};

const getWebhookTokenFromRequest = (request: Request): string | null => {
  const headerToken = request.headers.get(WEBHOOK_TOKEN_HEADER)?.trim();
  if (headerToken && headerToken.length > 0) {
    return headerToken;
  }
  return readWebhookBearerToken(request);
};

const constantTimeTokenMatch = (expected: string, provided: string): boolean => {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
};

const isValidWebhookToken = (request: Request): boolean => {
  const configured = Bun.env.WEBHOOK_OFF_TOKEN?.trim();
  if (!configured) {
    return false;
  }
  const provided = getWebhookTokenFromRequest(request);
  if (!provided) {
    return false;
  }
  return constantTimeTokenMatch(configured, provided);
};

const handleWebhookRequest = async (
  request: Request,
  url: URL,
  authContext: RequestAuthContext,
): Promise<Response | null> => {
  const pathname = url.pathname;
  if (pathname === "/v1/api/webhook/off" && request.method === "POST") {
    if (!authContext.session && !isValidWebhookToken(request)) {
      return Response.json(
        {
          error: "Authentication required. Provide a valid session cookie or webhook token.",
        },
        { status: 401 },
      );
    }

    if (authContext.session) {
      const denied = await ensureApiAccess(AccessActions.SessionsManage, request, url, authContext);
      if (denied) {
        return denied;
      }
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
const ASSET_VERSION = "30";

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

await rehydrateWarmSessions(
  warmRestartMarker,
  restartMarkerPath,
  agentHost,
  manager,
  ensureUserWorkspace,
  config.defaultWorkingDirectory,
  messageStore,
  [...SUPPORTED_AGENT_TYPES],
);

// Auto-rehydrate orphaned sessions that survived a restart
await rehydrateOrphanedSessions(
  agentHost,
  manager,
  ensureUserWorkspace,
  config.defaultWorkingDirectory,
  messageStore,
  [...SUPPORTED_AGENT_TYPES],
  24, // Look for sessions started in the last 24 hours
);

const agentChatSessionRuntime = new AgentChatSessionRuntime({
  defaultAgent: config.defaultAgent,
  processManager: manager,
  idleRetentionMinutes: 60,
});
workspaceSubscriptionManager.setChatRuntime(agentChatSessionRuntime);
// NOTE: `agentWorkSessionRuntime` construction, `setAgentWorkRuntime`, and
// `workspaceSubscriptionManager.startupReload()` are deferred until after
// `promptDispatchEngine` is created below, because the runtime depends on
// `maybeAutoDispatchQueuedPrompt` which is destructured from the engine.

// Clean up any PM2 agent processes not reclaimed by rehydration
try {
  const agentCleanup = await cleanupOrphanedAgentProcesses(manager);
  if (agentCleanup.cleaned > 0 || agentCleanup.failed > 0) {
    console.log(
      `[pm2] agent cleanup: ${agentCleanup.cleaned} removed, ${agentCleanup.failed} failed (of ${agentCleanup.checked} checked)`,
    );
  }
} catch (error) {
  console.warn(`[pm2] agent cleanup failed: ${(error as Error).message}`);
}

// SSE handler for session events
const handleSessionEvents = createSessionEventsHandler({
  manager,
  agentHost,
  sseKeepaliveIntervalMs: config.sseKeepaliveIntervalMs,
});

const syncSessionMessages = async (sessionId: string, force = false) => {
  return syncLiveSessionMessages({
    sessionId,
    force,
    manager,
    messageStore,
    agentHost,
  });
};

const agentStatusPoller = new AgentRuntimeStatusPoller(manager, {
  host: agentHost,
  intervalMs: config.agentStatusPollIntervalMs,
  maxIntervalMs: config.agentStatusPollMaxIntervalMs,
  timeoutMs: config.agentStatusPollTimeoutMs,
  initialDelayMs: config.agentStatusPollIntervalMs,
});
agentStatusPoller.start();

const liveMessagePersistence = new LiveMessagePersistenceLoop({
  manager,
  syncSessionMessages,
  intervalMs: Math.max(5000, config.agentStatusPollIntervalMs),
  initialDelayMs: 2000,
});
liveMessagePersistence.start();

const promptDispatchEngine = createPromptDispatchEngine({
  manager,
  agentHost,
  messageStore,
  isUserApprovedForWork,
  promptQueueStore,
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

// Deferred from above: AgentWorkSessionRuntime depends on
// maybeAutoDispatchQueuedPrompt, which is only available after the
// promptDispatchEngine destructure.
const agentWorkSessionRuntime = new AgentWorkSessionRuntime({
  defaultAgent: config.defaultAgent,
  getSession: (sessionId: string) => manager.getSession(sessionId) ?? null,
  createSession: async (agent, workingDirectory, name, origin, explicitNpub, metadata) =>
    await manager.createSession(agent, workingDirectory, name, origin, undefined, explicitNpub, metadata),
  updateSessionMetadata: (sessionId, metadata) => manager.updateSessionMetadata(sessionId, metadata),
  addPrompt: (sessionId, content) => promptQueueStore.addPrompt(sessionId, { content }),
  hasQueuedPrompt: (sessionId, content) => promptQueueStore.hasQueuedPrompt(sessionId, content),
  hasQueuedTaskDispatchPrompt: (sessionId, taskId) =>
    promptQueueStore.hasQueuedTaskDispatchPrompt(sessionId, taskId),
  maybeAutoDispatchQueuedPrompt,
  enableNightWatch: (sessionId) => {
    nightWatchStore.enableSession(sessionId);
  },
});
workspaceSubscriptionManager.setAgentWorkRuntime(agentWorkSessionRuntime);

const agentCommentSessionRuntime = new AgentCommentSessionRuntime({
  defaultAgent: config.defaultAgent,
  getSession: (sessionId: string) => manager.getSession(sessionId) ?? null,
  listSessions: () => manager.listSessions(),
  createSession: async (agent, workingDirectory, name, origin, explicitNpub, metadata) =>
    await manager.createSession(agent, workingDirectory, name, origin, undefined, explicitNpub, metadata),
  updateSessionMetadata: (sessionId, metadata) => manager.updateSessionMetadata(sessionId, metadata),
  addPrompt: (sessionId, content) => promptQueueStore.addPrompt(sessionId, { content }),
  hasQueuedPrompt: (sessionId, content) => promptQueueStore.hasQueuedPrompt(sessionId, content),
  maybeAutoDispatchQueuedPrompt,
});
workspaceSubscriptionManager.setAgentCommentRuntime(agentCommentSessionRuntime);

void new AgentWorkSessionIdleRetention({
  processManager: manager,
  idleRetentionMinutes: 60,
});

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

void ensureWingmanCoreRegistration(appRegistry, {
  projectRoot: projectRootPath,
  adminNpub,
});

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
  const normalizePathname = (value: string): string => {
    const normalized = value.replace(/\/+$/, "");
    return normalized || "/";
  };
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
    if (
      eventUrl.origin !== url.origin ||
      normalizePathname(eventUrl.pathname) !== normalizePathname(url.pathname)
    ) return null;

    // Verify the method tag
    const methodTag = event.tags?.find((t: string[]) => t[0] === "method");
    if (!methodTag || methodTag[1] !== request.method) return null;

    // Verify the event is recent (allow clock skew up to 5 minutes)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - event.created_at) > 300) return null;

    // Convert pubkey to npub
    return nip19.npubEncode(event.pubkey);
  } catch {
    return null;
  }
};

const resolveInternalNip98AuthContext = (
  request: Request,
  url: URL,
  authContext: RequestAuthContext,
): RequestAuthContext =>
  resolveNip98AuthContext(request, url, authContext, {
    verifyNip98AuthHeader,
    lookupBotOwnerNpub: (botNpub) => botKeyStore.getActiveKeyForBotNpub(botNpub)?.userNpub ?? null,
  });

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

// serialiseFeatureFlag and serialiseFeatureFlagsForViewer moved to ./server/feature-flags-routes.ts

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
  ensureApiAccess,
  resolveWorkspace,
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
  parseNightWatchStartOptions,
  buildAgentUrl,
  enableNightWatch: (sessionId, options) => {
    nightWatchStore.enableSession(sessionId, {
      prompt: options?.prompt,
      intervalMinutes: options?.intervalMinutes,
      maxCycles: options?.maxCycles,
    });
  },
  queueDispatchInFlight,
  maybeAutoDispatchQueuedPrompt,
  dispatchNextQueuedPromptForSession,
  getPromptReadinessForSession: (session) =>
    getSessionPromptReadiness({
      session,
      adapter: manager.getAdapter(session.id),
      timeoutMs: 750,
    }),
  validateForkInput,
  getRecentMessages,
  formatMessagesAsContext,
  createGitWorktree,
  workspaceDelegationStore,
  AccessActions,
};
sessionApiContextRef = sessionApiContext;
const dispatchPipelineRuntime = new DispatchPipelineRuntime({
  pipelineStore,
  getSessionApiContext: () => sessionApiContextRef,
  getBotIdentityForSubscription: (subscriptionId) =>
    workspaceSubscriptionManager.getRuntimeBotIdentity(subscriptionId),
  callbackOrigin: `http://127.0.0.1:${config.port}`,
  requirePipelineRoutes: true,
  defaultAgent: config.defaultAgent,
});
workspaceSubscriptionManager.setDispatchPipelineRuntime(dispatchPipelineRuntime);

await workspaceSubscriptionManager.startupReload();

void resumeRunningPipelineRuns({
  store: pipelineStore,
  sessionApiContext,
  callbackOrigin: `http://127.0.0.1:${config.port}`,
  loadRegistryForRun: ({ run, definition }) =>
    dispatchPipelineRuntime.loadRegistryForStoredRun({ run, definition, sessionApiContext }),
  ensureApiAccess,
  AccessActions,
}, `http://127.0.0.1:${config.port}`).catch((error) => {
  console.warn("[pipelines] failed to resume running pipeline runs:", error instanceof Error ? error.message : String(error));
});

const docsApiContext: DocsApiContext = {
  resolveWorkspace,
  ensureApiAccess,
  AccessActions,
  ensureDirectory,
  createGitWorktree,
  executeGitCommand,
  describeGitRepository,
};

const providerProxyApiContext: ProviderProxyApiContext = {
  billingService: teamBillingService,
  getSession: (sessionId) => manager.getSession(sessionId) ?? null,
  ensureProviderApiKey: () => teamBillingService.getProviderApiKey(),
};

const billingApiContext: BillingApiContext = {
  billingService: teamBillingService,
  ensureApiAccess,
  AccessActions,
};

// Mutable reference filled in after Bun.serve() returns its server object.
// Used to provide request IP resolution to the API route handler without a
// forward-reference issue (the server const is defined after handleApi).
const serverRef: { current: { requestIP: (req: Request) => { address: string } | null } | null } = { current: null };

const handleApi = createApiRouteHandler({
  getRequestIP: (req) => serverRef.current?.requestIP(req) ?? null,
  config: {
    port: config.port,
    baseUrl: config.baseUrl,
    agentPortStart: config.agentPortStart,
    agentPortMax: config.agentPortMax,
    hostUrlBase: config.hostUrlBase,
    appRoutingMode: config.appRoutingMode,
    subdomainBaseDomain: config.subdomainBaseDomain,
    subdomainProxyEnabled: config.subdomainProxyEnabled,
    connectRelays: config.connectRelays,
    agents: config.agents,
    defaultAgent: config.defaultAgent,
    giteaUrl: config.giteaUrl,
  },
  adminNpub,

  // Pre-instantiated API handlers
  todoApiHandler,
  projectApiHandler,
  npubProjectApiHandler,
  browserLogHandler,
  caproverApiHandler,
  nightWatchApiHandler,
  nip98ApiHandler,
  botCryptoApiHandler,
  botKeyApiHandler,
  giteaApiHandler,
  gitWorkflowApiHandler,
  ngitApiHandler,
  superbasedApiHandler,
  wingmanMcpApiHandler,
  schedulerApiHandler,
  autopilotJobsApiHandler,

  // Pre-built route contexts (request-independent)
  sessionApiContext,
  docsApiContext,
  providerProxyApiContext,
  billingApiContext,
  systemRoutesContext: {
    restartMarkerPath,
    warmRestartManagerScriptPath,
    projectRoot,
    configPort: config.port,
    wingmanCoreTmuxSession: WINGMAN_CORE_TMUX_SESSION,
    manager,
    ensureApiAccess,
    AccessActions,
    setPreserveSessionsOnShutdown: (v) => { preserveSessionsOnShutdown = v; },
    initiateShutdown: (reason: string) => initiateShutdown(reason),
    performSystemCleanup: (deps: Parameters<typeof performSystemCleanup>[0]) => performSystemCleanup(deps),
    messageStore,
    appProcessManager,
    appRegistry,
  },
  authApiContext: {
    config: {
      registrationEnabled: config.registrationEnabled,
      connectRelays: config.connectRelays,
      giteaUrl: config.giteaUrl,
      giteaApiToken: config.giteaApiToken,
      giteaOwner: config.giteaOwner,
    },
    adminNpub,
    identityUserStore,
    mintSessionCookie,
    getSessionCookieName,
    SessionCookieError,
    SESSION_COOKIE_NAME,
    shouldUseSecureCookies,
    generateIdentityAlias,
    handleKeyTeleport,
    handleKeyTeleportRegistration,
    ensureGiteaUser,
    ensureApiAccess,
    AccessActions,
    getViewerNormalizedNpub,
    normaliseOptionalString,
    resolveAndCacheNostrProfile,
    onSessionAuthenticated: (npub: string) => {
      try {
        identityUserStore.touch(npub);
        teamBillingService.syncTeamMembers();
        if (teamBillingService.isCreditsEnabled()) {
          void teamBillingService.primeProviderKeyCache().catch((error) => {
            console.warn(`[billing] failed to prime provider key cache at login: ${(error as Error).message}`);
          });
        }
      } catch (error) {
        console.warn(`[billing] failed to update team members for ${npub}: ${(error as Error).message}`);
      }
    },
  },
  adminUsersApiContext: {
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
  },
  uploadApiContext: {
    imageRoot,
    attachmentRoot,
    isAdminContext,
    isAgentType,
    ensureImageDirectory,
    ensureAttachmentDirectory,
    createImageFilename,
    createAttachmentFilename,
    buildAgentImagePlaceholder,
    buildAgentFilePlaceholder,
    ensureApiAccess,
    AccessActions,
  },
  agentChatApiContext: {
    manager: workspaceSubscriptionManager,
  },
  voiceNoteUploadApiContext: {
    imageRoot,
    attachmentRoot,
    isAdminContext,
    isAgentType,
    ensureImageDirectory,
    ensureAttachmentDirectory,
    createImageFilename,
    createAttachmentFilename,
    buildAgentImagePlaceholder,
    buildAgentFilePlaceholder,
    ensureApiAccess,
    AccessActions,
  },
  delegationRoutesContext: {
    workspaceDelegationStore,
    ensureApiAccess,
    AccessActions,
  },
  pipelineApiContext: {
    store: pipelineStore,
    sessionApiContext,
    callbackOrigin: `http://127.0.0.1:${config.port}`,
    loadRegistryForRun: ({ run, definition }) =>
      dispatchPipelineRuntime.loadRegistryForStoredRun({ run, definition, sessionApiContext }),
    ensureApiAccess,
    AccessActions,
  },
  workspaceDelegationStore,

  // Stores accessed directly
  featureFlagStore,
  userSettingsStore,
  artifactsStore,

  // Constants
  PROJECTS_FLAG_KEY,

  // Core helpers
  resolveWorkspace,
  verifyNip98AuthHeader,
  resolveNip98AuthContext: resolveInternalNip98AuthContext,
  resolveFeatureFlagStateForViewer,
  ensureApiAccess,
  serialiseFeatureFlagsForViewer: (isAdmin: boolean) =>
    serialiseFeatureFlagsForViewer(featureFlagStore, isAdmin),
  listDirectories,
  createDirectoryEntry,
  AccessActions,

  // Per-request context builders
  buildStarterProjectsContext: (workspaceScope, viewerNpub) => ({
    adminNpub,
    workspaceScope,
    viewerNpub,
    AccessActions,
    ensureApiAccess,
    normaliseOptionalString,
    normaliseNpub,
    cloneRepositoryIntoWorkspace,
    buildAppResponse,
    appRegistry,
    appProcessManager,
    appAliasRegistry,
    starterProjectStore,
    npubProjectStore,
  }),
  buildAppsContext: (appsAuthContext, workspaceScopeOverride, canAccessAppOverride) => {
    const effectiveAppsAuthContext = getEffectiveOwnerAuthContext(appsAuthContext);
    const appsWorkspaceScope = workspaceScopeOverride ?? resolveWorkspace(effectiveAppsAuthContext);
    const appsViewerNpub = getEffectiveOwnerNpub(effectiveAppsAuthContext);
    const canAccessAppForRequest = (app: AppRecord): boolean => {
      if (canAccessAppOverride) {
        return canAccessAppOverride(app);
      }
      if (sharedInstanceAccessEnabled && appsViewerNpub) return true;
      if (appsWorkspaceScope.isAdmin) return true;
      if (!appsViewerNpub) return false;
      return app.ownerNpub === appsViewerNpub;
    };
    return {
      adminNpub,
      sharedInstanceAccess: sharedInstanceAccessEnabled,
      workspaceScope: appsWorkspaceScope,
      viewerNpub: appsViewerNpub,
      AccessActions,
      ensureApiAccess,
      normaliseOptionalString,
      normaliseNpub,
      ensureDirectory,
      ensureWithinAllowedDirectories,
      parseAppScripts,
      parseBooleanInput,
      parsePortInput,
      parseBooleanFlag,
      appActions: APP_ACTIONS,
      canAccessApp: canAccessAppForRequest,
      deriveDirectoryNameFromUrl,
      cloneRepositoryIntoWorkspace,
      scanDirectoryTree,
      buildAppOwnerFilters,
      defaultAppProcessStatus,
      resolveOwnerAliasCached,
      buildAppResponse,
      appRegistry,
      appProcessManager,
      appAliasRegistry,
      npubProjectStore,
      createCaproverClientFromEnv,
      createAppTarball,
      caproverStore,
    };
  },
  buildFeatureFlagsContext: (viewerIsAdmin) => ({
    featureFlagStore,
    viewerIsAdmin,
    ensureApiAccess,
    AccessActions,
  }),
  buildChatContext: (npub, isAdmin) => ({
    config,
    npub,
    isAdmin,
    recordUsage: async (data) => {
      await teamBillingService.recordProxyUsage({
        sessionId: data.sessionId,
        npub: npub ?? null,
        agent: 'chat',
        endpoint: '/v1/chat/completions',
        method: 'POST',
        statusCode: 200,
        costUsd: null,
      });
    },
  }),
  buildWappsContext: (wappsAuthContext) => {
    const effectiveAuthContext = getEffectiveOwnerAuthContext(wappsAuthContext);
    const appsWorkspaceScope = resolveWorkspace(effectiveAuthContext);
    const appsViewerNpub = getEffectiveOwnerNpub(effectiveAuthContext);
    const canAccessAppForRequest = (app: AppRecord): boolean => {
      if (sharedInstanceAccessEnabled && appsViewerNpub) return true;
      if (appsWorkspaceScope.isAdmin) return true;
      if (!appsViewerNpub) return false;
      return app.ownerNpub === appsViewerNpub;
    };
    return {
      adminNpub,
      viewerNpub: appsViewerNpub,
      sourceWingmanUrl: config.baseUrl,
      flightDeckAppNamespace: wingmanInstanceIdentity?.npub ?? adminNpub ?? "autopilot",
      AccessActions,
      ensureApiAccess,
      ensureDirectory: (root: string) => ensureDirectory(root, appsWorkspaceScope),
      canAccessApp: canAccessAppForRequest,
      appRegistry,
      appAliasRegistry,
      wappStore,
      publisher: wappPublisher,
      buildLaunchUrl: (alias, app) => {
        const aliasUrl = buildAppHostUrl(alias);
        if (aliasUrl) {
          return aliasUrl.startsWith("http") ? aliasUrl : new URL(aliasUrl, config.baseUrl).toString();
        }
        const fallbackUrl = app.webApp && app.webAppPort ? buildHostedWebAppUrl(app.webAppPort) : null;
        return fallbackUrl ?? config.baseUrl;
      },
    };
  },
});

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

      const webhookResponse = await handleWebhookRequest(request, url, authContext);
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
        pathname.startsWith("/pipelines") ||
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
        pathname.startsWith("/triggers/") ||
        pathname === "/pipelines" ||
        pathname.startsWith("/pipelines/");

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

      const tempAttachment = resolveTempAttachment(pathname, authContext, { attachmentRoot, isAdminContext });
      if (tempAttachment) {
        return tempAttachment;
      }

      const tempImage = resolveTempImage(pathname, authContext, { imageRoot, isAdminContext });
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

    return maybeRefreshSessionCookie(response, authContext, {
      secureCookie: shouldUseSecureCookies(),
    });
  },
  error(error: Error): Response {
    console.error("[server] unhandled request error:", error);
    return Response.json(
      { error: error.message || "Internal Server Error" },
      { status: 500 },
    );
  },
});

// Wire up the request-IP resolver now that the server object exists.
serverRef.current = server;

const stopAllSessions = async () => {
  if (preserveSessionsOnShutdown || config.agentSpawnMode === "pm2" || config.agentSpawnMode === "tmux") {
    const reason = preserveSessionsOnShutdown
      ? "warm restart"
      : `${config.agentSpawnMode} agent spawn mode`;
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
  `Wingman V2 listening on http://localhost:${config.port} (agents ${config.agentPortStart} - ${config.agentPortStart + config.agentPortMax - 1})`,
);

// Start scheduler engine (loads enabled jobs from DB)
schedulerEngine.start();

export { server, manager, config };
