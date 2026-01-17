import { randomUUID } from "node:crypto";
import { type Dirent } from "node:fs";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve as resolvePath, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import "./logging/server-logger";

import type { AgentType } from "./config";
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
import { identityUserStore, InsufficientBalanceError } from "./storage/identity-user-store";
import { TodoStore } from "./todos/todo-store";
import { createTodoApiHandler } from "./todos/todo-api";
import { ProjectStore } from "./projects/project-store";
import { createProjectApiHandler } from "./projects/project-api";
import { createNpubProjectApiHandler } from "./projects/npub-project-api";
import { npubProjectStore } from "./projects/npub-project-store";
import { createBrowserLogHandler } from "./logging/browser-log-handler";
import { ensureDeepDiveProcess, getDeepDivePort, isDeepDiveProcessRunning } from "./deep-dive-process";
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
import { createStaticAssetService } from "./server/static-assets";
import { maybeRefreshSessionCookie } from "./server/session-refresh";
import { handleSubdomainRequest, type SubdomainProxyConfig } from "./server/subdomain-proxy";
import { isAgentRuntimeStatus } from "./types/agent-status";
import { ensureAgentApiBinary } from "./server/bootstrap/agentapi";
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
];

featureFlagStore.ensureDefaults(FEATURE_FLAG_DEFAULTS);
process.env.WINGMAN_PID = process.pid.toString();
const SUPPORTED_AGENT_TYPES: AgentType[] = ["codex", "claude", "goose", "opencode", "gemini"];
const MESSAGE_COST_SATS = 100;
const projectStore = new ProjectStore();
const todoStore = new TodoStore();
const promptQueueStore = new PromptQueueStore("data/prompt-queue.db");
const QUEUE_DISPATCH_RETRY_MS = 5000;
const queueDispatchInFlight = new Set<string>();
const queueDispatchCooldowns = new Map<string, number>();
const todoApiHandler = createTodoApiHandler({ store: todoStore, projectStore });
const projectApiHandler = createProjectApiHandler({
  store: projectStore,
  getAppById: (id) => appRegistry.getApp(id),
});
const npubProjectApiHandler = createNpubProjectApiHandler();
const browserLogHandler = createBrowserLogHandler();

registerAccessRule(AccessActions.SessionsManage, requireAuthentication());
registerAccessRule(AccessActions.FilesRead, requireAuthentication());
registerAccessRule(AccessActions.FilesWrite, requireAuthentication());
registerAccessRule(AccessActions.DeepDiveAccess, requireAuthentication());
registerAccessRule(AccessActions.AppsManage, requireAuthentication());
registerAccessRule(AccessActions.UiRestricted, requireAuthentication());
registerAccessRule(AccessActions.TodosManage, requireAuthentication());
registerAccessRule(AccessActions.ProjectsManage, requireAuthentication());

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

const isDeepDivePagePath = (pathname: string) =>
  pathname === "/deep-dive" || pathname.startsWith("/deep-dive/");

ensureDeepDiveProcess(config.port);

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

const secureResolvePath = (base: string, target: string): string => {
  if (!isAbsolute(base)) {
    throw new Error("Base path must be absolute");
  }
  
  const normalizedBase = normalize(base);
  const resolvedTarget = resolvePath(normalizedBase, target);
  const normalizedTarget = normalize(resolvedTarget);
  
  if (!normalizedTarget.startsWith(normalizedBase + sep) && normalizedTarget !== normalizedBase) {
    throw new Error(`Path traversal detected: ${target} escapes allowed directory`);
  }
  
  return normalizedTarget;
};

const validatePathSegment = (segment: string): boolean => {
  const dangerousPatterns = [
    /\.\./,
    /[<>:"|?*]/,
    /^[.]/,
    /[.]+$/,
    /\x00/,
  ];
  
  return !dangerousPatterns.some(pattern => pattern.test(segment));
};

const sanitizePath = (path: string): string => {
  const wasAbsolute = isAbsolute(path);
  const sanitized = path
    .split(sep)
    .filter(segment => segment.length > 0 && validatePathSegment(segment))
    .join(sep);
  return wasAbsolute ? sep + sanitized : sanitized;
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

// Reconcile PM2 processes with app registry
try {
  const appReconcileResult = await reconcileAppsWithPM2(appRegistry);
  if (appReconcileResult.appsReconciled > 0 || appReconcileResult.appsCleared > 0) {
    console.log(`[pm2] reconciled apps: ${appReconcileResult.appsReconciled} running, ${appReconcileResult.appsCleared} cleared`);
  }
} catch (error) {
  console.warn(`[pm2] app reconciliation failed: ${(error as Error).message}`);
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
const imageTtlMs = 24 * 60 * 60 * 1000;
const attachmentTtlMs = 24 * 60 * 60 * 1000;
const imageCleanupIntervalMs = 24 * 60 * 60 * 1000;
const attachmentCleanupIntervalMs = 24 * 60 * 60 * 1000;

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

type AdminUserRecord = {
  npub: string;
  normalizedNpub: string;
  alias: string;
  nickname: string | null;
  pictureUrl: string | null;
  onboarded: boolean;
  onboardedAt: string | null;
  roles: string[];
  lastSeenAt: string | null;
  sessionCount: number;
  activeSessionCount: number;
  ports: number[];
  balance: number;
};

const buildAdminUserList = (): AdminUserRecord[] => {
  const activeSessions = manager?.listSessions?.() ?? [];
  const identitySummaries = buildIdentitySummaries(activeSessions, adminNpub, { includeAll: true });
  const storedRecords = identityUserStore.listUsers();
  const storedMap = new Map(storedRecords.map((record) => [record.normalizedNpub, record] as const));
  const summaryMap = new Map<string, ReturnType<typeof buildIdentitySummaries>[number]>();

  for (const summary of identitySummaries) {
    if (!summary.normalizedNpub || !summary.npub) {
      continue;
    }
    summaryMap.set(summary.normalizedNpub, summary);
    const existing = storedMap.get(summary.normalizedNpub);
    if (!existing) {
      continue;
    }
    try {
      identityUserStore.touchExisting(summary.npub, {
        lastSeenAt: summary.lastSeenAt ?? null,
      });
    } catch (error) {
      console.warn(`[admin] failed to sync identity ${summary.npub}:`, error);
    }
  }

  const finalRecords = identityUserStore.listUsers();
  const users: AdminUserRecord[] = finalRecords.map((record) => {
    const summary = summaryMap.get(record.normalizedNpub ?? "");
    const sessionCount = summary?.sessionIds.length ?? 0;
    const activeSessionCount = summary?.activeSessionIds.length ?? 0;
    const lastSeenAt = summary?.lastSeenAt ?? record.lastSeenAt ?? record.updatedAt ?? null;
    return {
      npub: record.npub,
      normalizedNpub: record.normalizedNpub,
      alias: record.alias,
      nickname: record.nickname ?? null,
      pictureUrl: record.pictureUrl ?? null,
      onboarded: record.roles.includes("onboard"),
      onboardedAt: record.onboardedAt,
      roles: [...record.roles],
      lastSeenAt,
      sessionCount,
      activeSessionCount,
      ports: record.ports,
      balance: record.balance,
    };
  });

  users.sort((a, b) => {
    const left = (a.nickname || a.alias || a.npub || "").toLowerCase();
    const right = (b.nickname || b.alias || b.npub || "").toLowerCase();
    if (left === right) {
      return (a.alias || "").localeCompare(b.alias || "");
    }
    return left.localeCompare(right);
  });
  return users;
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

const runImageCleanup = async () => {
  let directories: Dirent[];
  try {
    directories = await readdir(imageRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    console.error("[uploads] failed to list image directory", error);
    return;
  }

  const threshold = Date.now() - imageTtlMs;

  await Promise.all(
    directories
      .filter((entry) => entry.isDirectory())
      .map(async (userDir) => {
        const userPath = join(imageRoot, userDir.name);
        let agentEntries: Dirent[];
        try {
          agentEntries = await readdir(userPath, { withFileTypes: true });
        } catch (error) {
          console.error(`[uploads] failed to list user image directory ${userDir.name}`, error);
          return;
        }

        await Promise.all(
          agentEntries
            .filter((entry) => entry.isDirectory())
            .map(async (agentDir) => {
              const agentPath = join(userPath, agentDir.name);
              let files: Dirent[];
              try {
                files = await readdir(agentPath, { withFileTypes: true });
              } catch (error) {
                console.error(`[uploads] failed to list agent image directory ${agentDir.name}`, error);
                return;
              }

              await Promise.all(
                files
                  .filter((entry) => entry.isFile())
                  .map(async (file) => {
                    const filePath = join(agentPath, file.name);
                    try {
                      const stats = await stat(filePath);
                      if (stats.mtimeMs < threshold) {
                        await rm(filePath, { force: true });
                        console.log(`[uploads] removed expired image ${filePath}`);
                      }
                    } catch (error) {
                      console.error(`[uploads] failed to cleanup ${filePath}`, error);
                    }
                  }),
              );
            }),
        );
      }),
  );
};

const scheduleImageCleanup = () => {
  // Fire-and-forget; best-effort cleanup
  runImageCleanup().catch((error) => console.error("[uploads] initial cleanup failed", error));
  setInterval(() => {
    runImageCleanup().catch((error) => console.error("[uploads] scheduled cleanup failed", error));
  }, imageCleanupIntervalMs).unref?.();
};

scheduleImageCleanup();

const runAttachmentCleanup = async () => {
  let directories: Dirent[];
  try {
    directories = await readdir(attachmentRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    console.error("[uploads] failed to list attachment directory", error);
    return;
  }

  const threshold = Date.now() - attachmentTtlMs;

  await Promise.all(
    directories
      .filter((entry) => entry.isDirectory())
      .map(async (userDir) => {
        const userPath = join(attachmentRoot, userDir.name);
        let agentEntries: Dirent[];
        try {
          agentEntries = await readdir(userPath, { withFileTypes: true });
        } catch (error) {
          console.error(`[uploads] failed to list user attachment directory ${userDir.name}`, error);
          return;
        }

        await Promise.all(
          agentEntries
            .filter((entry) => entry.isDirectory())
            .map(async (agentDir) => {
              const agentPath = join(userPath, agentDir.name);
              let files: Dirent[];
              try {
                files = await readdir(agentPath, { withFileTypes: true });
              } catch (error) {
                console.error(`[uploads] failed to list attachment subdirectory ${agentDir.name}`, error);
                return;
              }

              await Promise.all(
                files
                  .filter((entry) => entry.isFile())
                  .map(async (file) => {
                    const filePath = join(agentPath, file.name);
                    try {
                      const stats = await stat(filePath);
                      if (stats.mtimeMs < threshold) {
                        await rm(filePath, { force: true });
                        console.log(`[uploads] removed expired attachment ${filePath}`);
                      }
                    } catch (error) {
                      console.error(`[uploads] failed to cleanup attachment ${filePath}`, error);
                    }
                  }),
              );
            }),
        );
      }),
  );
};

const scheduleAttachmentCleanup = () => {
  runAttachmentCleanup().catch((error) => console.error("[uploads] initial attachment cleanup failed", error));
  setInterval(() => {
    runAttachmentCleanup().catch((error) => console.error("[uploads] scheduled attachment cleanup failed", error));
  }, attachmentCleanupIntervalMs).unref?.();
};

scheduleAttachmentCleanup();

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
    });
    messageStore.replaceMessages(event.session.id, []);
    void maybeAutoDispatchQueuedPrompt(event.session);
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
    });
    void maybeAutoDispatchQueuedPrompt(event.session);
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

const FILE_NAME_MAX_LENGTH = 200;

const normaliseDocsFileName = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new Error("File name is required");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("File name is required");
  }
  if (trimmed.length > FILE_NAME_MAX_LENGTH) {
    throw new Error("File name is too long");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error("File name is not allowed");
  }
  if (/[\\/]/.test(trimmed)) {
    throw new Error("File name cannot contain path separators");
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

const isWithinDocsRoot = (target: string, scopeOverride?: WorkspaceScope): boolean => {
  if (!target) return false;
  const activeScope = scopeOverride ?? resolveWorkspace();
  const normalized = normalize(target);
  return normalized === activeScope.docsRoot || normalized.startsWith(activeScope.docsRootBoundary);
};

const toDocsRelativePath = (target: string, scopeOverride?: WorkspaceScope): string => {
  if (!target) return "";
  const activeScope = scopeOverride ?? resolveWorkspace();
  if (!isWithinDocsRoot(target, activeScope)) {
    return "";
  }
  const relativePath = relative(activeScope.docsRoot, target);
  return relativePath && relativePath.length > 0 ? relativePath : "";
};

const toDocsDisplayPath = (target: string, scopeOverride?: WorkspaceScope): string => {
  const relativePath = toDocsRelativePath(target, scopeOverride);
  return relativePath ? `~/${relativePath}` : "~";
};

const resolveDocsPath = (
  input: string | null | undefined,
  scopeOverride?: WorkspaceScope,
): string => {
  const activeScope = scopeOverride ?? resolveWorkspace();
  const value = input?.trim();
  const candidate = value && value.length > 0 ? value : activeScope.docsRoot;
  const absolute = isAbsolute(candidate) ? candidate : join(activeScope.docsRoot, candidate);
  const normalized = normalize(absolute);
  if (!isWithinDocsRoot(normalized, activeScope)) {
    throw new Error("Access outside the home directory is not permitted");
  }
  return normalized;
};

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const MAX_DOCS_ENTRIES = 500;
const MAX_DOCS_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const DOCS_NAME_MAX_LENGTH = 160;

interface DocsPreviewType {
  format: "markdown" | "code";
  language: string;
  label: string;
}

const TEXT_PREVIEW_TYPES = new Map<string, DocsPreviewType>([
  [".md", { format: "markdown", language: "markdown", label: "Markdown" }],
  [".markdown", { format: "markdown", language: "markdown", label: "Markdown" }],
  [".mdx", { format: "markdown", language: "markdown", label: "Markdown" }],
  [".txt", { format: "code", language: "plaintext", label: "Text" }],
  [".log", { format: "code", language: "plaintext", label: "Log" }],
  [".json", { format: "code", language: "json", label: "JSON" }],
  [".jsonc", { format: "code", language: "json", label: "JSON" }],
  [".yaml", { format: "code", language: "yaml", label: "YAML" }],
  [".yml", { format: "code", language: "yaml", label: "YAML" }],
  [".js", { format: "code", language: "javascript", label: "JavaScript" }],
  [".mjs", { format: "code", language: "javascript", label: "JavaScript" }],
  [".cjs", { format: "code", language: "javascript", label: "JavaScript" }],
  [".ts", { format: "code", language: "typescript", label: "TypeScript" }],
  [".tsx", { format: "code", language: "typescript", label: "TypeScript" }],
  [".jsx", { format: "code", language: "javascript", label: "JavaScript" }],
  [".go", { format: "code", language: "go", label: "Go" }],
  [".rs", { format: "code", language: "rust", label: "Rust" }],
  [".py", { format: "code", language: "python", label: "Python" }],
  [".sh", { format: "code", language: "shell", label: "Shell" }],
  [".bash", { format: "code", language: "shell", label: "Shell" }],
  [".zsh", { format: "code", language: "shell", label: "Shell" }],
  [".ini", { format: "code", language: "ini", label: "Config" }],
  [".conf", { format: "code", language: "ini", label: "Config" }],
  [".toml", { format: "code", language: "toml", label: "TOML" }],
  [".env", { format: "code", language: "ini", label: "Config" }],
  [".css", { format: "code", language: "css", label: "CSS" }],
  [".html", { format: "code", language: "html", label: "HTML" }],
]);

const TEXT_PREVIEW_TYPES_BY_NAME = new Map<string, DocsPreviewType>([
  [".env", { format: "code", language: "ini", label: "Config" }],
  [".env.example", { format: "code", language: "ini", label: "Config" }],
]);

type ListDocsDirectoryOptions = {
  includeHidden?: boolean;
};

const listDocsDirectory = async (
  input: string | null | undefined,
  options: ListDocsDirectoryOptions = {},
  scopeOverride?: WorkspaceScope,
) => {
  const activeScope = scopeOverride ?? resolveWorkspace();
  const directory = resolveDocsPath(input, activeScope);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(directory);
  } catch {
    throw new Error("Directory not found");
  }

  if (!stats.isDirectory()) {
    throw new Error("Requested path is not a directory");
  }

  const includeHidden = Boolean(options.includeHidden);

  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Failed to read directory: ${(error as Error).message ?? "unknown error"}`);
  }

  const directories: Array<{
    name: string;
    path: string;
    relativePath: string;
    displayPath: string;
    type: "directory";
  }> = [];
  const files: Array<{
    name: string;
    path: string;
    relativePath: string;
    displayPath: string;
    type: "file";
    previewable: boolean;
    previewFormat: DocsPreviewType["format"] | null;
    previewLanguage: string | null;
    previewLabel: string | null;
  }> = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    if (!includeHidden && entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = normalize(join(directory, entry.name));
    if (!isWithinDocsRoot(entryPath, activeScope)) {
      continue;
    }

    if (entry.isDirectory()) {
      const relativePath = toDocsRelativePath(entryPath, activeScope);
      directories.push({
        name: entry.name,
        path: entryPath,
        relativePath,
        displayPath: toDocsDisplayPath(entryPath, activeScope),
        type: "directory",
      });
      continue;
    }

    if (entry.isFile()) {
      const relativePath = toDocsRelativePath(entryPath, activeScope);
      const extension = extname(entry.name).toLowerCase();
      const lowerName = entry.name.toLowerCase();
      const preview = TEXT_PREVIEW_TYPES_BY_NAME.get(lowerName) ?? TEXT_PREVIEW_TYPES.get(extension) ?? null;
      files.push({
        name: entry.name,
        path: entryPath,
        relativePath,
        displayPath: toDocsDisplayPath(entryPath, activeScope),
        type: "file",
        previewable: preview !== null,
        previewFormat: preview?.format ?? null,
        previewLanguage: preview?.language ?? null,
        previewLabel: preview?.label ?? null,
      });
    }

    if (directories.length + files.length >= MAX_DOCS_ENTRIES) {
      break;
    }
  }

  directories.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  const parentPath = (() => {
    if (directory === activeScope.docsRoot) {
      return null;
    }
    const candidate = dirname(directory);
    if (!isWithinDocsRoot(candidate, activeScope)) {
      return null;
    }
    return candidate;
  })();

  let git: GitRepositorySummary | null = null;
  try {
    git = await describeGitRepository(directory);
  } catch {
    git = null;
  }

  return {
    path: directory,
    relativePath: toDocsRelativePath(directory, activeScope),
    displayPath: toDocsDisplayPath(directory, activeScope),
    parent: parentPath
      ? {
          path: parentPath,
          relativePath: toDocsRelativePath(parentPath, activeScope),
          displayPath: toDocsDisplayPath(parentPath, activeScope),
        }
      : null,
    entries: [...directories, ...files],
    git,
  };
};

const resolvePreviewType = (filePath: string): DocsPreviewType => {
  const name = basename(filePath).toLowerCase();
  const extension = extname(name).toLowerCase();
  const preview = TEXT_PREVIEW_TYPES_BY_NAME.get(name) ?? TEXT_PREVIEW_TYPES.get(extension);
  if (!preview) {
    throw new Error("Preview for this file type is not supported");
  }
  return preview;
};

const loadDocsFile = async (input: string | null | undefined) => {
  if (!input) {
    throw new Error("File path is required");
  }

  const filePath = resolveDocsPath(input);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch {
    throw new Error("File not found");
  }

  if (!stats.isFile()) {
    throw new Error("Requested path is not a file");
  }

  if (stats.size > MAX_DOCS_FILE_SIZE) {
    throw new Error("File is too large to preview");
  }

  const preview = resolvePreviewType(filePath);

  if (preview.format === "markdown" && !MARKDOWN_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    throw new Error("Unsupported Markdown extension");
  }

  const extension = extname(filePath).toLowerCase();

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    throw new Error(`Failed to read file: ${(error as Error).message ?? "unknown error"}`);
  }

  return {
    path: filePath,
    relativePath: toDocsRelativePath(filePath),
    displayPath: toDocsDisplayPath(filePath),
    name: basename(filePath),
    content,
    format: preview.format,
    language: preview.language,
    label: preview.label,
  };
};

const loadDocsFileRaw = async (input: string | null | undefined) => {
  if (!input) {
    throw new Error("File path is required");
  }

  const filePath = resolveDocsPath(input);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch {
    throw new Error("File not found");
  }

  if (!stats.isFile()) {
    throw new Error("Requested path is not a file");
  }

  if (stats.size > MAX_DOCS_FILE_SIZE) {
    throw new Error("File is too large to load");
  }

  let data: Uint8Array;
  try {
    data = await readFile(filePath);
  } catch (error) {
    throw new Error(`Failed to read file: ${(error as Error).message ?? "unknown error"}`);
  }

  const base64 = Buffer.from(data).toString("base64");

  return {
    path: filePath,
    relativePath: toDocsRelativePath(filePath),
    displayPath: toDocsDisplayPath(filePath),
    name: basename(filePath),
    base64,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
};

const updateDocsFile = async (pathInput: string | null | undefined, base64Input: string | null | undefined, expectedMtime: number | null | undefined) => {
  if (!pathInput) {
    throw new Error("File path is required");
  }

  const filePath = resolveDocsPath(pathInput);

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch {
    throw new Error("File not found");
  }

  if (!stats.isFile()) {
    throw new Error("Requested path is not a file");
  }

  if (typeof expectedMtime === "number" && Math.abs(stats.mtimeMs - expectedMtime) > 1) {
    throw new Error("File has changed since it was loaded");
  }

  if (base64Input === null || base64Input === undefined) {
    throw new Error("File contents are required");
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64Input, "base64");
  } catch {
    throw new Error("Invalid base64 payload");
  }

  if (bytes.length > MAX_DOCS_FILE_SIZE) {
    throw new Error("File is too large to save");
  }

  try {
    await writeFile(filePath, bytes);
  } catch (error) {
    throw new Error(`Failed to write file: ${(error as Error).message ?? "unknown error"}`);
  }

  const nextStats = await stat(filePath);

  return {
    path: filePath,
    relativePath: toDocsRelativePath(filePath),
    displayPath: toDocsDisplayPath(filePath),
    name: basename(filePath),
    size: nextStats.size,
    mtimeMs: nextStats.mtimeMs,
  };
};

const ensureDocsDirectory = async (input: string | null | undefined): Promise<string> => {
  const directory = resolveDocsPath(input);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(directory);
  } catch {
    throw new Error("Parent directory not found");
  }
  if (!stats.isDirectory()) {
    throw new Error("Parent path is not a directory");
  }
  return directory;
};

const normaliseDocsEntryName = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new Error("Name is required");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Name is required");
  }
  if (trimmed.length > DOCS_NAME_MAX_LENGTH) {
    throw new Error("Name is too long");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error("Name is not allowed");
  }
  if (/[\\/]/.test(trimmed)) {
    throw new Error("Name cannot contain path separators");
  }
  return trimmed;
};

const createDocsDirectory = async (parentInput: string | null | undefined, nameInput: unknown) => {
  const parentDirectory = await ensureDocsDirectory(parentInput);
  const name = normaliseDocsEntryName(nameInput);
  const target = normalize(join(parentDirectory, name));
  if (!isWithinDocsRoot(target)) {
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
    relativePath: toDocsRelativePath(target),
    displayPath: toDocsDisplayPath(target),
    name,
  };
};

interface CreateDocsFilePayload {
  content?: unknown;
  base64?: unknown;
}

const createDocsFile = async (
  parentInput: string | null | undefined,
  nameInput: unknown,
  payloadInput: unknown,
) => {
  const parentDirectory = await ensureDocsDirectory(parentInput);
  const name = normaliseDocsEntryName(nameInput);
  const target = normalize(join(parentDirectory, name));
  if (!isWithinDocsRoot(target)) {
    throw new Error("Invalid file path");
  }

  const payload =
    payloadInput && typeof payloadInput === "object" && !Array.isArray(payloadInput)
      ? (payloadInput as CreateDocsFilePayload)
      : null;

  let buffer: Buffer;
  if (payload && Object.prototype.hasOwnProperty.call(payload, "base64")) {
    const base64Value = payload.base64;
    if (base64Value !== null && base64Value !== undefined) {
      if (typeof base64Value !== "string") {
        throw new Error("Invalid base64 payload");
      }
      try {
        buffer = Buffer.from(base64Value, "base64");
      } catch {
        throw new Error("Invalid base64 payload");
      }
    } else {
      buffer = Buffer.from("", "utf-8");
    }
  } else {
    const contentValue = payload ? payload.content : payloadInput;
    const content =
      typeof contentValue === "string"
        ? contentValue
        : typeof contentValue === "number"
          ? contentValue.toString()
          : "";
    buffer = Buffer.from(content, "utf-8");
  }

  if (buffer.length > MAX_DOCS_FILE_SIZE) {
    throw new Error("File is too large to create");
  }

  try {
    await writeFile(target, buffer, { flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      throw new Error("A file or directory with that name already exists");
    }
    throw new Error(`Failed to create file: ${(error as Error).message ?? "unknown error"}`);
  }

  const extension = extname(name).toLowerCase();
  const preview = TEXT_PREVIEW_TYPES.get(extension) ?? null;

  return {
    path: target,
    relativePath: toDocsRelativePath(target),
    displayPath: toDocsDisplayPath(target),
    name,
    previewable: preview !== null,
    previewFormat: preview?.format ?? null,
    previewLanguage: preview?.language ?? null,
    previewLabel: preview?.label ?? null,
  };
};

const deleteDocsFile = async (pathInput: string | null | undefined) => {
  const candidate = pathInput?.trim();
  if (!candidate) {
    throw new Error("File path is required");
  }
  const filePath = resolveDocsPath(candidate);

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch {
    throw new Error("File not found");
  }

  if (!stats.isFile()) {
    throw new Error("Requested path is not a file");
  }

  try {
    await rm(filePath, { force: false });
  } catch (error) {
    throw new Error(`Failed to delete file: ${(error as Error).message ?? "unknown error"}`);
  }

  return {
    path: filePath,
    relativePath: toDocsRelativePath(filePath),
    displayPath: toDocsDisplayPath(filePath),
    name: basename(filePath),
  };
};

const copyDocsFile = async (
  pathInput: string | null | undefined,
  targetDirectoryInput: string | null | undefined,
  newNameInput?: string | null | undefined,
) => {
  const sourcePath = resolveDocsPath(pathInput);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(sourcePath);
  } catch {
    throw new Error("File not found");
  }

  if (!stats.isFile()) {
    throw new Error("Requested path is not a file");
  }

  const targetDirectory = await ensureDocsDirectory(targetDirectoryInput);
  const destinationName = newNameInput && newNameInput.trim().length > 0
    ? normaliseDocsFileName(newNameInput)
    : basename(sourcePath);
  const destinationPath = normalize(join(targetDirectory, destinationName));

  if (!isWithinDocsRoot(destinationPath)) {
    throw new Error("Invalid destination path");
  }

  if (destinationPath === sourcePath) {
    throw new Error("Destination matches the source file");
  }

  try {
    await cp(sourcePath, destinationPath, { errorOnExist: true, force: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      throw new Error("A file with the same name already exists in the destination");
    }
    throw new Error(`Failed to copy file: ${(error as Error).message ?? "unknown error"}`);
  }

  const destinationStats = await stat(destinationPath);

  return {
    path: destinationPath,
    relativePath: toDocsRelativePath(destinationPath),
    displayPath: toDocsDisplayPath(destinationPath),
    name: basename(destinationPath),
    size: destinationStats.size,
    mtimeMs: destinationStats.mtimeMs,
  };
};

const moveDocsFile = async (
  pathInput: string | null | undefined,
  targetDirectoryInput: string | null | undefined,
  newNameInput?: string | null | undefined,
) => {
  const sourcePath = resolveDocsPath(pathInput);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(sourcePath);
  } catch {
    throw new Error("File not found");
  }

  if (!stats.isFile()) {
    throw new Error("Requested path is not a file");
  }

  const targetDirectory = await ensureDocsDirectory(targetDirectoryInput);
  const destinationName = newNameInput && newNameInput.trim().length > 0
    ? normaliseDocsFileName(newNameInput)
    : basename(sourcePath);
  const destinationPath = normalize(join(targetDirectory, destinationName));

  if (!isWithinDocsRoot(destinationPath)) {
    throw new Error("Invalid destination path");
  }

  if (destinationPath === sourcePath) {
    throw new Error("Destination matches the source file");
  }

  try {
    await rename(sourcePath, destinationPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      throw new Error("A file with the same name already exists in the destination");
    }
    if (code === "EXDEV") {
      try {
        await cp(sourcePath, destinationPath, { errorOnExist: true, force: false });
        await rm(sourcePath, { force: false });
      } catch (copyError) {
        const message = copyError instanceof Error ? copyError.message : "unknown error";
        throw new Error(`Failed to move file: ${message}`);
      }
    } else {
      const message = (error as Error).message ?? "unknown error";
      throw new Error(`Failed to move file: ${message}`);
    }
  }

  const destinationStats = await stat(destinationPath);

  return {
    path: destinationPath,
    relativePath: toDocsRelativePath(destinationPath),
    displayPath: toDocsDisplayPath(destinationPath),
    name: basename(destinationPath),
    size: destinationStats.size,
    mtimeMs: destinationStats.mtimeMs,
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

const serveIndex = () => {
  const url = new URL("./ui/index.html", import.meta.url);
  return new Response(Bun.file(url), {
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const agentStatusPoller = new AgentRuntimeStatusPoller(manager, {
  host: agentHost,
  intervalMs: config.agentStatusPollIntervalMs,
  maxIntervalMs: config.agentStatusPollMaxIntervalMs,
  timeoutMs: config.agentStatusPollTimeoutMs,
});
agentStatusPoller.start();

const waitForMessageUpdate = async (sessionId: string, initialCount: number, timeoutMs = 20000) => {
  let messages = await syncSessionMessages(sessionId, true);
  if (messages.length > initialCount) {
    return messages;
  }

  const deadline = Date.now() + Math.max(timeoutMs, 1000);
  while (Date.now() < deadline) {
    await sleep(750);
    messages = await syncSessionMessages(sessionId, true);
    if (messages.length > initialCount) {
      return messages;
    }
  }
  return messages;
};

class QueueDispatchError extends Error {
  constructor(
    message: string,
    public status: number,
    public payload: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "QueueDispatchError";
  }
}

const getQueueDispatchCooldown = (sessionId: string) => queueDispatchCooldowns.get(sessionId) ?? 0;

const shouldAutoDispatchSession = (session: SessionSnapshot | null): boolean => {
  if (!session) return false;
  if (session.status !== "running") return false;
  return session.agentRuntimeStatus === "stable";
};

const clearQueueDispatchCooldown = (sessionId: string) => {
  queueDispatchCooldowns.delete(sessionId);
};

const markQueueDispatchCooldown = (sessionId: string) => {
  queueDispatchCooldowns.set(sessionId, Date.now() + QUEUE_DISPATCH_RETRY_MS);
};

async function dispatchNextQueuedPromptForSession(session: SessionSnapshot, userNpub: string | null) {
  if (!userNpub) {
    throw new QueueDispatchError("Sign in to send messages", 403, { balance: 0 });
  }

  const nextPrompt = promptQueueStore.getNextQueuedPrompt(session.id);
  if (!nextPrompt) {
    throw new QueueDispatchError("No prompts in queue", 404);
  }

  let currentBalance = 0;
  let debitApplied = false;
  const refundDebit = () => {
    if (!debitApplied) return;
    try {
      currentBalance = identityUserStore.credit(userNpub, MESSAGE_COST_SATS);
    } catch (creditError) {
      console.error("[billing] failed to refund queued prompt debit:", creditError);
    } finally {
      debitApplied = false;
    }
  };

  try {
    currentBalance = identityUserStore.debit(userNpub, MESSAGE_COST_SATS);
    debitApplied = true;
  } catch (error) {
    if (error instanceof InsufficientBalanceError) {
      throw new QueueDispatchError("Insufficient balance", 402, {
        balance: error.currentBalance,
        required: MESSAGE_COST_SATS,
      });
    }
    console.error("[billing] failed to debit message cost:", error);
    throw new QueueDispatchError("Failed to debit balance", 500);
  }

  try {
    const initialCount = messageStore.listSessionMessages(session.id).length;
    const agentUrl = buildAgentUrl(agentHost, session.port, "/message");
    const agentResponse = await fetch(agentUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "user", content: nextPrompt.content }),
    });

    if (!agentResponse.ok) {
      const errorPayload = await agentResponse.json().catch(() => ({}));
      const message = (errorPayload?.error as string) ?? agentResponse.statusText ?? "Agent request failed";
      refundDebit();
      throw new QueueDispatchError(message, agentResponse.status, {
        balance: currentBalance,
        failedPrompt: nextPrompt,
      });
    }

    promptQueueStore.removeNextPrompt(session.id);
    const messages = await waitForMessageUpdate(session.id, initialCount);
    clearQueueDispatchCooldown(session.id);
    return { id: session.id, messages, balance: currentBalance, sentPrompt: nextPrompt };
  } catch (error) {
    if (error instanceof QueueDispatchError) {
      throw error;
    }
    refundDebit();
    throw new QueueDispatchError(`Failed to contact agent: ${(error as Error).message}`, 502, {
      balance: currentBalance,
      failedPrompt: nextPrompt,
    });
  }
}

async function maybeAutoDispatchQueuedPrompt(session: SessionSnapshot | null) {
  if (!session) return;
  if (queueDispatchInFlight.has(session.id)) return;
  if (!shouldAutoDispatchSession(session)) return;
  if (promptQueueStore.getQueueCount(session.id) === 0) return;
  const userNpub = session.npub ?? null;
  if (!userNpub) {
    console.warn(`[queue] cannot auto-dispatch session ${session.id} without owner npub`);
    return;
  }
  const cooldownUntil = getQueueDispatchCooldown(session.id);
  if (cooldownUntil && cooldownUntil > Date.now()) {
    return;
  }

  queueDispatchInFlight.add(session.id);
  try {
    await dispatchNextQueuedPromptForSession(session, userNpub);
  } catch (error) {
    if (error instanceof QueueDispatchError) {
      if (error.status === 404) {
        clearQueueDispatchCooldown(session.id);
      } else {
        markQueueDispatchCooldown(session.id);
        console.warn(`[queue] auto-dispatch failed for session ${session.id}: ${error.message}`);
      }
    } else {
      markQueueDispatchCooldown(session.id);
      console.error(`[queue] auto-dispatch failed for session ${session.id}:`, error);
    }
  } finally {
    queueDispatchInFlight.delete(session.id);
  }
}

const sweepQueuedSessionsForDispatch = () => {
  for (const session of manager.listSessions()) {
    void maybeAutoDispatchQueuedPrompt(session);
  }
};

sweepQueuedSessionsForDispatch();
setInterval(sweepQueuedSessionsForDispatch, 5000).unref?.();
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
  const subdomainUrl = app.webApp ? buildSubdomainUrl(subdomainAlias) : null;
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

type SessionCleanupDetail = {
  id: string;
  agent: AgentType;
  name: string;
  port: number;
  npub: string | null;
  stopped: boolean;
  deleted: boolean;
  stopError?: string;
  deleteError?: string;
};

type AppCleanupDetail = {
  id: string;
  label: string;
  running: boolean;
  killed: boolean;
  removed: boolean;
  killError?: string;
  removeError?: string;
};

type SystemCleanupResult = {
  timestamp: string;
  preservedCoreApp: boolean;
  sessions: {
    total: number;
    stopped: number;
    deleted: number;
    failed: number;
    details: SessionCleanupDetail[];
  };
  apps: {
    total: number;
    killed: number;
    removed: number;
    failed: number;
    skipped: number;
    details: AppCleanupDetail[];
  };
};

async function performSystemCleanup(): Promise<SystemCleanupResult> {
  const snapshotTimestamp = new Date().toISOString();
  const sessionSnapshots = manager.listSessions();
  const sessionDetails: SessionCleanupDetail[] = [];
  let sessionsStopped = 0;
  let sessionsDeleted = 0;
  let sessionFailures = 0;

  for (const snapshot of sessionSnapshots) {
    const detail: SessionCleanupDetail = {
      id: snapshot.id,
      agent: snapshot.agent,
      name: snapshot.name,
      port: snapshot.port,
      npub: snapshot.npub ?? null,
      stopped: false,
      deleted: false,
    };

    try {
      await manager.stopSession(snapshot.id);
      detail.stopped = true;
      sessionsStopped += 1;
    } catch (error) {
      detail.stopError = error instanceof Error ? error.message : String(error);
    }

    const current = manager.getSession(snapshot.id);
    const canDelete =
      !current ||
      current.status === "stopped" ||
      current.status === "error";

    if (canDelete) {
      try {
        const removed = manager.deleteSession(snapshot.id);
        if (removed) {
          detail.deleted = true;
          sessionsDeleted += 1;
          try {
            messageStore.removeSession(snapshot.id);
          } catch (error) {
            detail.deleteError = error instanceof Error ? error.message : String(error);
            detail.deleted = false;
            sessionsDeleted -= 1;
          }
        }
      } catch (error) {
        detail.deleteError = error instanceof Error ? error.message : String(error);
      }
    } else if (!detail.stopError) {
      detail.stopError = "Session still running after stop attempt";
    }

    if (detail.stopError || detail.deleteError) {
      sessionFailures += 1;
    }

    sessionDetails.push(detail);
  }

  const appDetails: AppCleanupDetail[] = [];
  const appStatuses = await appProcessManager.listStatuses().catch(() => []);
  const statusMap = new Map(appStatuses.map((status) => [status.appId, status]));
  const apps = await appRegistry.listApps();
  let appsKilled = 0;
  let appsRemoved = 0;
  let appFailures = 0;
  let appSkipped = 0;
  let preservedCoreApp = false;

  for (const app of apps) {
    if (app.id === "wingman-core") {
      preservedCoreApp = true;
      appSkipped += 1;
      continue;
    }

    const status = statusMap.get(app.id);
    const detail: AppCleanupDetail = {
      id: app.id,
      label: app.label,
      running: Boolean(status?.running),
      killed: false,
      removed: false,
    };

    try {
      await appProcessManager.kill(app.id);
      detail.killed = true;
      appsKilled += 1;
    } catch (error) {
      detail.killError = error instanceof Error ? error.message : String(error);
    }

    try {
      const removed = await appRegistry.removeApp(app.id);
      if (removed) {
        detail.removed = true;
        appsRemoved += 1;
      }
    } catch (error) {
      detail.removeError = error instanceof Error ? error.message : String(error);
    } finally {
      appProcessManager.forget(app.id);
    }

    if (detail.killError || detail.removeError) {
      appFailures += 1;
    }

    appDetails.push(detail);
  }

  return {
    timestamp: snapshotTimestamp,
    preservedCoreApp,
    sessions: {
      total: sessionDetails.length,
      stopped: sessionsStopped,
      deleted: sessionsDeleted,
      failed: sessionFailures,
      details: sessionDetails,
    },
    apps: {
      total: appDetails.length,
      killed: appsKilled,
      removed: appsRemoved,
      failed: appFailures,
      skipped: appSkipped,
      details: appDetails,
    },
  };
}

const requireAdminAccess = (): AccessRule => {
  return (context) => {
    if (!adminNpub) {
      return deny("admin-only", 403);
    }
    return isAdminContext(context.auth) ? allow() : deny("admin-only", 403);
  };
};

registerAccessRule(AccessActions.DeepDiveAccess, requireAdminAccess());
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
    if (!authContext.session) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }
    const response = await npubProjectApiHandler(
      request,
      url,
      method,
      authContext,
      workspaceScope.isAdmin,
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
      const result = await performSystemCleanup();
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
      const existingSession = authContext.session;
      if (existingSession && existingSession.npub !== trimmedNpub) {
        // Allow overwriting with a new npub, but clear stale signed data by minting a new cookie.
      }

      const { cookie, expiresAt, payload } = mintSessionCookie(trimmedNpub);
      authContext.npub = payload.npub;
      authContext.session = payload;
      delete authContext.error;
      try {
        identityUserStore.touch(trimmedNpub, {
          alias: generateIdentityAlias(trimmedNpub),
          lastSeenAt: new Date().toISOString(),
        });
      } catch (error) {
        console.warn(`[admin] failed to record identity ${trimmedNpub}:`, error);
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

  if (pathname === "/api/admin/users" && method === "GET") {
    const denied = await ensureApiAccess(AccessActions.AdminUsers, request, url, authContext);
    if (denied) {
      return denied;
    }
    const users = buildAdminUserList();
    return Response.json({ users });
  }

  if (pathname === "/api/admin/users" && method === "PATCH") {
    const denied = await ensureApiAccess(AccessActions.AdminUsers, request, url, authContext);
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
    const npubInput = normaliseOptionalString((payload as Record<string, unknown>).npub);
    const onboardedValue = (payload as Record<string, unknown>).onboarded;
    if (!npubInput) {
      return Response.json({ error: "npub is required" }, { status: 400 });
    }
    if (typeof onboardedValue !== "boolean") {
      return Response.json({ error: "onboarded flag is required" }, { status: 400 });
    }
    try {
      identityUserStore.setRole(npubInput, "onboard", onboardedValue);
      const users = buildAdminUserList();
      const normalizedNpub = normaliseNpub(npubInput);
      const user = normalizedNpub
        ? users.find((entry) => entry.normalizedNpub === normalizedNpub) ?? null
        : null;
      return Response.json({ user, users });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/admin/users/bulk" && method === "DELETE") {
    const denied = await ensureApiAccess(AccessActions.AdminUsers, request, url, authContext);
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
    const npubsInput = (payload as Record<string, unknown>).npubs;
    if (!Array.isArray(npubsInput) || npubsInput.length === 0) {
      return Response.json({ error: "npubs is required" }, { status: 400 });
    }
    const targets = new Map<string, string>();
    for (const entry of npubsInput) {
      const candidate = normaliseOptionalString(entry);
      if (!candidate) {
        continue;
      }
      const normalized = normaliseNpub(candidate);
      if (!normalized) {
        continue;
      }
      targets.set(normalized, candidate);
    }
    if (targets.size === 0) {
      return Response.json({ error: "At least one valid npub is required" }, { status: 400 });
    }
    const missing: string[] = [];
    const skippedAdmin: string[] = [];
    let deletedCount = 0;
    for (const [normalized, original] of targets) {
      if (adminNpub && normalized === adminNpub) {
        skippedAdmin.push(original);
        continue;
      }
      try {
        await stopSessionsForUser(normalized);
        const deleted = identityUserStore.deleteUser(normalized);
        if (!deleted) {
          missing.push(original);
        } else {
          deletedCount += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ error: `Failed to delete ${original}: ${message}` }, { status: 400 });
      }
    }
    const users = buildAdminUserList();
    return Response.json({
      users,
      summary: {
        requested: targets.size,
        deleted: deletedCount,
        missing,
        skippedAdmin,
      },
    });
  }

  if (pathname === "/api/admin/users" && method === "DELETE") {
    const denied = await ensureApiAccess(AccessActions.AdminUsers, request, url, authContext);
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
    const npubInput = normaliseOptionalString((payload as Record<string, unknown>).npub);
    if (!npubInput) {
      return Response.json({ error: "npub is required" }, { status: 400 });
    }
    try {
      await stopSessionsForUser(npubInput);
      const deleted = identityUserStore.deleteUser(npubInput);
      if (!deleted) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }
      const users = buildAdminUserList();
      return Response.json({ users });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/admin/users/nickname" && method === "POST") {
    const denied = await ensureApiAccess(AccessActions.AdminUsers, request, url, authContext);
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
    const npubInput = normaliseOptionalString(record.npub);
    if (!npubInput) {
      return Response.json({ error: "npub is required" }, { status: 400 });
    }
    const normalized = normaliseNpub(npubInput);
    if (!normalized) {
      return Response.json({ error: "Invalid npub" }, { status: 400 });
    }
    const nicknameValue = record.nickname;
    const nickname =
      nicknameValue === null
        ? null
        : typeof nicknameValue === "string"
          ? nicknameValue
          : typeof nicknameValue === "undefined"
            ? ""
            : String(nicknameValue);

    try {
      const updatedRecord = identityUserStore.setNickname(npubInput, nickname);
      const users = buildAdminUserList();
      const user = users.find((entry) => entry.normalizedNpub === updatedRecord.normalizedNpub) ?? null;
      return Response.json({ user, users }, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/admin/users/profile" && method === "POST") {
    const denied = await ensureApiAccess(AccessActions.AdminUsers, request, url, authContext);
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
    const npubInput = normaliseOptionalString((payload as Record<string, unknown>).npub);
    const force = (payload as Record<string, unknown>).refresh === true;
    if (!npubInput) {
      return Response.json({ error: "npub is required" }, { status: 400 });
    }
    const normalized = normaliseNpub(npubInput);
    if (!normalized) {
      return Response.json({ error: "Invalid npub" }, { status: 400 });
    }
    try {
      await resolveAndCacheNostrProfile(npubInput, { force, relays: config.connectRelays });
      const users = buildAdminUserList();
      const user = users.find((entry) => entry.normalizedNpub === normalized) ?? null;
      return Response.json({ user, users, pictureUrl: user?.pictureUrl ?? null }, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/admin/users/balance" && method === "POST") {
    const denied = await ensureApiAccess(AccessActions.AdminUsers, request, url, authContext);
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
    const npubInput = normaliseOptionalString(record.npub);
    const aliasInput = normaliseOptionalString(record.alias);
    const balanceValue = record.balance;

    if (!npubInput && !aliasInput) {
      return Response.json({ error: "Provide an npub or alias" }, { status: 400 });
    }

    const parsedBalance =
      typeof balanceValue === "number"
        ? balanceValue
        : typeof balanceValue === "string" && balanceValue.trim().length > 0
          ? Number.parseInt(balanceValue, 10)
          : NaN;

    if (!Number.isFinite(parsedBalance) || parsedBalance < 0) {
      return Response.json({ error: "Balance must be a non-negative number" }, { status: 400 });
    }
    const desiredBalance = Math.max(0, Math.trunc(parsedBalance));

    let targetNpub: string | null = null;
    let targetNormalized: string | null = null;

    if (npubInput) {
      const normalized = normaliseNpub(npubInput);
      if (!normalized) {
        return Response.json({ error: "Invalid npub" }, { status: 400 });
      }
      targetNpub = npubInput;
      targetNormalized = normalized;
    } else if (aliasInput) {
      const aliasLookup = aliasInput.toLowerCase();
      const records = identityUserStore.listUsers();
      const found = records.find(
        (entry) => typeof entry.alias === "string" && entry.alias.toLowerCase() === aliasLookup,
      );
      if (!found) {
        return Response.json({ error: `No user found for alias "${aliasInput}"` }, { status: 404 });
      }
      targetNpub = found.npub;
      targetNormalized = found.normalizedNpub;
    }

    if (!targetNpub || !targetNormalized) {
      return Response.json({ error: "Unable to resolve user" }, { status: 400 });
    }

    try {
      const updatedRecord = identityUserStore.setBalance(targetNpub, desiredBalance);
      const users = buildAdminUserList();
      const user =
        users.find((entry) => entry.normalizedNpub === updatedRecord.normalizedNpub) ?? null;
      return Response.json(
        {
          user,
          users,
        },
        { status: 200 },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/admin/ports" && method === "POST") {
    const denied = await ensureApiAccess(AccessActions.AdminUsers, request, url, authContext);
    if (denied) {
      return denied;
    }
    const adminNormalizedNpub = authContext.npub ? normaliseNpub(authContext.npub) : null;
    if (!adminNormalizedNpub) {
      return Response.json({ error: "Admin npub not found" }, { status: 400 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      payload = {};
    }

    const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    const countInput = record.count;
    const count = typeof countInput === "number" && countInput > 0 ? Math.trunc(countInput) : 3;

    try {
      const updatedRecord = identityUserStore.addPortsToUser(adminNormalizedNpub, count);
      const users = buildAdminUserList();
      const user = users.find((entry) => entry.normalizedNpub === updatedRecord.normalizedNpub) ?? null;
      return Response.json({ user, users, newPorts: updatedRecord.ports.slice(-count) }, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/admin/users/ports" && method === "POST") {
    const denied = await ensureApiAccess(AccessActions.AdminUsers, request, url, authContext);
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
    const npubInput = normaliseOptionalString(record.npub);
    const countInput = record.count;

    if (!npubInput) {
      return Response.json({ error: "npub is required" }, { status: 400 });
    }

    const normalized = normaliseNpub(npubInput);
    if (!normalized) {
      return Response.json({ error: "Invalid npub" }, { status: 400 });
    }

    const count = typeof countInput === "number" && countInput > 0 ? Math.trunc(countInput) : 3;

    try {
      const updatedRecord = identityUserStore.addPortsToUser(npubInput, count);
      const users = buildAdminUserList();
      const user = users.find((entry) => entry.normalizedNpub === updatedRecord.normalizedNpub) ?? null;
      return Response.json({ user, users, newPorts: updatedRecord.ports.slice(-count) }, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
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
      featureFlags: serialiseFeatureFlagsForViewer(workspaceScope.isAdmin),
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

  if (pathname === "/api/docs/directory" && method === "POST") {
    const denied = await ensureApiAccess(AccessActions.FilesRead, request, url, authContext);
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

    const parent = normaliseOptionalString((payload as Record<string, unknown>).parent);
    const name = (payload as Record<string, unknown>).name;

    try {
      const data = await createDocsDirectory(parent, name);
      return Response.json(data, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/docs/tree" && method === "GET") {
    const denied = await ensureApiAccess(AccessActions.FilesRead, request, url, authContext);
    if (denied) {
      return denied;
    }
    try {
      const pathParam = url.searchParams.get("path");
      const showHiddenParam = url.searchParams.get("showHidden") ?? "";
      const includeHidden = (() => {
        const value = showHiddenParam.trim().toLowerCase();
        return value === "1" || value === "true" || value === "yes" || value === "on";
      })();
      const data = await listDocsDirectory(pathParam, { includeHidden }, workspaceScope);
      return Response.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/docs/file" && method === "POST") {
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

    try {
      const validatedPayload = validateInput(JsonRequestSchema.extend({
        name: z.string().min(1).max(255).refine(name => !/[<>:"|?*\x00]/.test(name)),
        content: z.string().optional(),
        base64: z.boolean().optional(),
        directory: PathSchema.optional()
      }), payload);

      const data = await createDocsFile(validatedPayload.directory, validatedPayload.name, { 
        content: validatedPayload.content, 
        base64: validatedPayload.base64 
      });
      return Response.json(data, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/docs/file" && method === "GET") {
    const denied = await ensureApiAccess(AccessActions.FilesRead, request, url, authContext);
    if (denied) {
      return denied;
    }
    const pathParam = url.searchParams.get("path");
    if (!pathParam) {
      return Response.json({ error: "File path is required" }, { status: 400 });
    }
    try {
      const data = await loadDocsFile(pathParam);
      return Response.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/docs/file/raw" && method === "GET") {
    const denied = await ensureApiAccess(AccessActions.FilesRead, request, url, authContext);
    if (denied) {
      return denied;
    }
    const pathParam = url.searchParams.get("path");
    if (!pathParam) {
      return Response.json({ error: "File path is required" }, { status: 400 });
    }
    try {
      const data = await loadDocsFileRaw(pathParam);
      return Response.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/docs/file" && method === "PUT") {
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

    const pathValue = (payload as Record<string, unknown>).path;
    const base64Value = (payload as Record<string, unknown>).base64;
    const expectedMtimeValue = (payload as Record<string, unknown>).expectedMtimeMs;

    const pathParam = typeof pathValue === "string" ? pathValue : null;
    const base64Param = typeof base64Value === "string" ? base64Value : null;
    const expectedMtime =
      typeof expectedMtimeValue === "number" && Number.isFinite(expectedMtimeValue) ? expectedMtimeValue : null;

    try {
      const data = await updateDocsFile(pathParam, base64Param, expectedMtime);
      return Response.json(data, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/docs/file" && method === "DELETE") {
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

    const pathValue = (payload as Record<string, unknown>).path;
    const pathParam = typeof pathValue === "string" ? pathValue : null;

    try {
      const data = await deleteDocsFile(pathParam);
      return Response.json(data, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/docs/file/copy" && method === "POST") {
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

    const pathValue = (payload as Record<string, unknown>).path;
    const targetValue =
      (payload as Record<string, unknown>).targetDirectory ?? (payload as Record<string, unknown>).directory;
    const nameValue = (payload as Record<string, unknown>).name;

    const sourcePath = typeof pathValue === "string" ? pathValue : null;
    const destinationPath = typeof targetValue === "string" ? targetValue : null;
    const destinationName = typeof nameValue === "string" ? nameValue : null;

    try {
      const data = await copyDocsFile(sourcePath, destinationPath, destinationName);
      return Response.json(data, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/docs/file/move" && method === "POST") {
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

    const pathValue = (payload as Record<string, unknown>).path;
    const targetValue =
      (payload as Record<string, unknown>).targetDirectory ?? (payload as Record<string, unknown>).directory;
    const nameValue = (payload as Record<string, unknown>).name;

    const sourcePath = typeof pathValue === "string" ? pathValue : null;
    const destinationPath = typeof targetValue === "string" ? targetValue : null;
    const destinationName = typeof nameValue === "string" ? nameValue : null;

    try {
      const data = await moveDocsFile(sourcePath, destinationPath, destinationName);
      return Response.json(data, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/docs/git" && method === "POST") {
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

    const directoryInput =
      normaliseOptionalString((payload as Record<string, unknown>).directory) ??
      normaliseOptionalString((payload as Record<string, unknown>).path);
    const actionInput = normaliseOptionalString((payload as Record<string, unknown>).action);
    const messageInput = normaliseOptionalString((payload as Record<string, unknown>).message);
    const remoteInput = normaliseOptionalString((payload as Record<string, unknown>).remote);
    const branchInput = normaliseOptionalString((payload as Record<string, unknown>).branch);

    if (!directoryInput) {
      return Response.json({ error: "Directory is required" }, { status: 400 });
    }

    if (!actionInput) {
      return Response.json({ error: "Action is required" }, { status: 400 });
    }

    if (!["init", "addAll", "commit", "push", "pushUpstream", "pull"].includes(actionInput)) {
      return Response.json({ error: "Unsupported git action" }, { status: 400 });
    }

    let directory: string;
    try {
      directory = resolveDocsPath(directoryInput);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }

    try {
      const result = await executeGitCommand({
        directory,
        action: actionInput as GitCommandAction,
        message: messageInput,
        remote: remoteInput,
        branch: branchInput,
      });

      if (result.exitCode !== 0) {
        const message = result.stderr || result.stdout || `Git command failed with exit code ${result.exitCode}`;
        return Response.json(
          { error: message, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
          { status: 400 },
        );
      }

      return Response.json({ exitCode: 0, stdout: result.stdout, stderr: result.stderr }, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/docs/worktrees" && method === "POST") {
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

    const directoryInput =
      normaliseOptionalString((payload as Record<string, unknown>).directory) ??
      normaliseOptionalString((payload as Record<string, unknown>).path);
    const branchInput = normaliseOptionalString((payload as Record<string, unknown>).branch);
    const startPointInput =
      normaliseOptionalString((payload as Record<string, unknown>).startPoint) ??
      normaliseOptionalString((payload as Record<string, unknown>).base) ??
      normaliseOptionalString((payload as Record<string, unknown>).from);

    if (!directoryInput) {
      return Response.json({ error: "Directory is required" }, { status: 400 });
    }

    if (!branchInput) {
      return Response.json({ error: "Branch name is required" }, { status: 400 });
    }

    let directory: string;
    try {
      directory = await ensureDirectory(directoryInput);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }

    try {
      const result = await createGitWorktree({
        directory,
        branch: branchInput,
        startPoint: startPointInput,
      });
      return Response.json(result, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
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
    console.log("[uploads] image upload request received", {
      host: request.headers.get("host"),
      contentType: request.headers.get("content-type"),
      contentLength: request.headers.get("content-length"),
    });
    const denied = await ensureApiAccess(AccessActions.FilesWrite, request, url, authContext);
    if (denied) {
      console.log("[uploads] access denied for image upload");
      return denied;
    }
    console.log("[uploads] access granted, parsing form data", {
      bodyUsed: request.bodyUsed,
      hasBody: request.body !== null,
    });
    let form: FormData;
    try {
      // Add timeout to detect hangs - formData() should complete quickly
      const formDataPromise = request.formData();
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("formData() timed out after 30s")), 30000);
      });
      form = await Promise.race([formDataPromise, timeoutPromise]);
    } catch (formError) {
      console.error("[uploads] form data parsing failed", formError);
      return Response.json({ error: `Invalid form data: ${formError instanceof Error ? formError.message : "unknown"}` }, { status: 400 });
    }
    console.log("[uploads] form data parsed successfully");

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

  // Archive API endpoints
  if (pathname === "/api/archive" && method === "GET") {
    const denied = await ensureApiAccess(AccessActions.SessionsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    
    try {
      const validatedOptions = validateInput(ArchiveListOptionsSchema, {
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
        filter: url.searchParams.get("filter")
      });

      const sessions = sessionArchiveStore.listArchivedSessions(validatedOptions);
      const total = sessionArchiveStore.getArchiveCount();
      return Response.json({ sessions, total, limit: validatedOptions.limit, offset: validatedOptions.offset });
    } catch (error) {
      return Response.json({ error: "Invalid request parameters" }, { status: 400 });
    }
  }

  if (pathname.startsWith("/api/archive/") && method === "GET") {
    const denied = await ensureApiAccess(AccessActions.SessionsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    const archiveParts = pathname.split("/").filter(Boolean);
    const sessionId = archiveParts[2];
    if (!sessionId) {
      return Response.json({ error: "Session ID required" }, { status: 400 });
    }

    // GET /api/archive/:id/messages
    if (archiveParts[3] === "messages") {
      const messages = sessionArchiveStore.getArchivedMessages(sessionId);
      return Response.json({ sessionId, messages });
    }

    // GET /api/archive/:id
    const session = sessionArchiveStore.getArchivedSession(sessionId);
    if (!session) {
      return Response.json({ error: "Archived session not found" }, { status: 404 });
    }
    const messages = sessionArchiveStore.getArchivedMessages(sessionId);
    return Response.json({ session, messages });
  }

  if (pathname.startsWith("/api/archive/") && method === "DELETE") {
    const denied = await ensureApiAccess(AccessActions.SessionsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    const archiveParts = pathname.split("/").filter(Boolean);
    const sessionId = archiveParts[2];
    if (!sessionId) {
      return Response.json({ error: "Session ID required" }, { status: 400 });
    }
    const deleted = sessionArchiveStore.deleteArchivedSession(sessionId);
    if (!deleted) {
      return Response.json({ error: "Archived session not found" }, { status: 404 });
    }
    return Response.json({ id: sessionId, deleted: true });
  }

  if (pathname === "/api/sessions" && method === "GET") {
    const denied = await ensureApiAccess(AccessActions.SessionsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    const viewerNormalizedNpub = getViewerNormalizedNpub(authContext);
    const viewerIsAdmin = Boolean(adminNpub && viewerNormalizedNpub && viewerNormalizedNpub === adminNpub);
    const allSessions = manager.listSessions();
    const accessibleSessions = viewerIsAdmin
      ? allSessions
      : viewerNormalizedNpub
        ? allSessions.filter((session) => sessionBelongsToViewer(session.npub ?? null, viewerNormalizedNpub, false))
        : [];
    const filterParam = url.searchParams.get("npub");

    const normalizeFilterValue = (value: string | null): string | null | "__anonymous__" => {
      if (!value || value === "all") return null;
      if (value === "__anonymous__") return "__anonymous__";
      const normalized = normaliseNpub(value);
      return normalized ?? null;
    };

    const filterValue = normalizeFilterValue(filterParam);
    const filteredSessions = accessibleSessions.filter((session) => {
      if (filterValue === null) {
        return true;
      }
      const sessionNormalized = normaliseNpub(session.npub ?? null);
      if (filterValue === "__anonymous__") {
        return sessionNormalized === null;
      }
      return sessionNormalized === filterValue;
    });

    let identitySummaries = viewerIsAdmin
      ? buildIdentitySummaries(allSessions, viewerNormalizedNpub, { includeAll: true })
      : buildIdentitySummaries(accessibleSessions, viewerNormalizedNpub, { includeAll: false });

    if (!viewerIsAdmin && identitySummaries.length === 0 && viewerNormalizedNpub && authContext.npub) {
      const segment = deriveNpubSegment(authContext.npub);
      const dataRoot = normalize(join(userIdentityRoot, segment));
      const logsRoot = normalize(join(dataRoot, "logs"));
      const attachmentsRoot = normalize(join(attachmentRoot, segment));
      const imagesRoot = normalize(join(imageRoot, segment));
      const viewerRecord = identityUserStore.getByNormalized(viewerNormalizedNpub);
      const ports = viewerRecord?.ports ?? identityUserStore.ensurePortsFor(authContext.npub);
      const balance = viewerRecord?.balance ?? 0;
      identitySummaries = [
        {
          npub: authContext.npub,
          normalizedNpub: viewerNormalizedNpub,
          segment,
          alias: generateIdentityAlias(authContext.npub),
          ports,
          balance,
          sessionIds: [],
          activeSessionIds: [],
          lastSeenAt: null,
          dataRoot,
          logsRoot,
          attachmentsRoot,
          imagesRoot,
        },
      ];
    }

    const npubFilters = identitySummaries.map((identity) => ({
      value: identity.normalizedNpub ?? "__anonymous__",
      npub: identity.npub,
      alias: identity.alias,
      label: identity.alias ?? identity.npub ?? "Anonymous",
      sessionCount: identity.sessionIds.length,
      activeCount: identity.activeSessionIds.length,
    }));

    return Response.json({
      sessions: filteredSessions.map(serializeSession),
      identities: identitySummaries,
      filters: {
        npubs: npubFilters,
        active: filterValue,
      },
    });
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

  if (pathname === "/api/sessions" && method === "POST") {
    const denied = await ensureApiAccess(AccessActions.SessionsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    try {
      const payload = await request.json();
      const agent = typeof payload?.agent === "string" ? payload.agent.toLowerCase() : "";
      if (!isAgentType(agent)) {
        return Response.json({ error: "Invalid agent selection" }, { status: 400 });
      }
      const balanceCheck = ensureViewerHasBalance(authContext, {
        feature: "start an agent session",
        message: "Add sats to your balance to start an agent session.",
      });
      if (balanceCheck instanceof Response) {
        return balanceCheck;
      }
      const directoryInput = typeof payload?.directory === "string" ? payload.directory : undefined;
      const rawName =
        payload && typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>).name
          : null;
      let workspace: SessionWorkspaceRequest = null;
      try {
        workspace =
          payload && typeof payload === "object" && payload !== null
            ? parseSessionWorkspaceRequest((payload as Record<string, unknown>).workspace)
            : null;
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      const sessionName = normaliseSessionNameInput(rawName);
      let workingDirectory: string;
      try {
        workingDirectory = await resolveSessionWorkingDirectory(directoryInput, workspace);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      let origin: SessionOrigin | null = null;
      try {
        origin = parseSessionOriginInput(payload?.origin ?? null);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      const session = await manager.createSession(agent, workingDirectory, sessionName ?? undefined, origin);
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
      });
      await syncSessionMessages(session.id, true);
      return Response.json(serializeSession(session), { status: 201 });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  }

  if (pathname.startsWith("/api/sessions/")) {
    const denied = await ensureApiAccess(AccessActions.SessionsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    const parts = pathname.split("/");
    const id = parts[3];
    if (!id) {
      return Response.json({ error: "Session id required" }, { status: 400 });
    }

    const viewerNormalizedNpub = getViewerNormalizedNpub(authContext);
    const viewerIsAdmin = Boolean(adminNpub && viewerNormalizedNpub && viewerNormalizedNpub === adminNpub);
    if (!viewerIsAdmin && !viewerNormalizedNpub) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const liveSession = manager.getSession(id);
    const ownedSession =
      liveSession && sessionBelongsToViewer(liveSession.npub ?? null, viewerNormalizedNpub, viewerIsAdmin)
        ? liveSession
        : null;

    if (method === "GET" && parts.length === 4) {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(serializeSession(ownedSession));
    }

    if (method === "PATCH" && parts.length === 4) {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
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
      const desiredName = typeof record.name === "string" ? record.name : "";
      const trimmedName = desiredName.trim();
      if (!trimmedName) {
        return Response.json({ error: "Session name is required" }, { status: 400 });
      }
      const renamed = manager.renameSession(id, trimmedName);
      if (!renamed) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(serializeSession(renamed));
    }

    if (method === "DELETE" && parts.length === 4) {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
      const session = await manager.stopSession(id);
      if (!session) return Response.json({ error: "Not found" }, { status: 404 });
      // Schedule archive after 5 seconds
      scheduleSessionArchive(id, manager);
      return Response.json(serializeSession(session));
    }

    if (method === "DELETE" && parts[4] === "storage") {
      if (ownedSession && (ownedSession.status === "starting" || ownedSession.status === "running")) {
        return Response.json({ error: "Stop the session before deleting it" }, { status: 409 });
      }

      if (!ownedSession) {
        if (!viewerIsAdmin) {
          const storedRecord = messageStore
            .listSessions()
            .find((record) => record.id === id && sessionBelongsToViewer(record.npub, viewerNormalizedNpub, viewerIsAdmin));
          if (!storedRecord) {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
        } else if (!messageStore.listSessions().some((record) => record.id === id)) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
      }

      // Cancel any pending archive since user wants immediate deletion
      cancelPendingArchive(id);

      try {
        manager.deleteSession(id);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      messageStore.removeSession(id);
      return Response.json({ id, deleted: true });
    }

    if (method === "GET" && parts[4] === "logs") {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
      const logs = await manager.getLogs(id);
      if (!logs) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({ id, logs });
    }

    if (parts[4] === "messages") {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });

      if (method === "GET") {
        const refresh = url.searchParams.get("refresh") === "true";
        const messages = await (refresh ? syncSessionMessages(id, true) : messageStore.listSessionMessages(id));
        return Response.json({ id, messages });
      }

      if (method === "POST") {
        let payload: unknown;
        try {
          payload = await request.json();
        } catch (error) {
          return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
        }

        if (!payload || typeof payload !== "object") {
          return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
        }

        const record = payload as Record<string, unknown>;
        const requestTypeRaw = typeof record.type === "string" ? record.type.trim().toLowerCase() : "user";
        const messageType = requestTypeRaw === "raw" ? "raw" : "user";
        const rawContent = typeof record.content === "string" ? record.content : "";
        const content = messageType === "raw" ? rawContent : rawContent.trim();

        if (!content) {
          return Response.json({ error: "Message content is required" }, { status: 400 });
        }

        const userNpub = authContext.npub ?? null;
        if (!userNpub) {
          return Response.json({ error: "Sign in to send messages", balance: 0 }, { status: 403 });
        }

        if (messageType === "raw") {
          try {
            const agentUrl = buildAgentUrl(agentHost, ownedSession.port, "/message");
            const agentResponse = await fetch(agentUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ type: messageType, content }),
            });
            if (!agentResponse.ok) {
              const errorPayload = await agentResponse.json().catch(() => ({}));
              const message = (errorPayload?.error as string) ?? agentResponse.statusText ?? "Agent request failed";
              return Response.json({ error: message }, { status: agentResponse.status });
            }
            return Response.json({ id, ok: true });
          } catch (error) {
            return Response.json(
              { error: `Failed to contact agent: ${(error as Error).message ?? "unknown error"}` },
              { status: 502 },
            );
          }
        }

        let currentBalance: number;
        try {
          currentBalance = identityUserStore.debit(userNpub, MESSAGE_COST_SATS);
        } catch (error) {
          if (error instanceof InsufficientBalanceError) {
            return Response.json(
              {
                error: "Insufficient balance to send message",
                balance: error.balance,
              },
              { status: 402 },
            );
          }
          console.error("[billing] failed to debit message cost:", error);
          return Response.json({ error: "Failed to debit balance" }, { status: 500 });
        }

        try {
          const initialCount = messageStore.listSessionMessages(id).length;
          const agentUrl = buildAgentUrl(agentHost, ownedSession.port, "/message");
          const agentResponse = await fetch(agentUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: messageType, content }),
          });
          if (!agentResponse.ok) {
            const errorPayload = await agentResponse.json().catch(() => ({}));
            const message = (errorPayload?.error as string) ?? agentResponse.statusText ?? "Agent request failed";
            try {
              currentBalance = identityUserStore.credit(userNpub, MESSAGE_COST_SATS);
            } catch (creditError) {
              console.error("[billing] failed to refund after agent rejection:", creditError);
            }
            return Response.json({ error: message, balance: currentBalance }, { status: agentResponse.status });
          }

          const messages = await waitForMessageUpdate(id, initialCount);
          return Response.json({ id, messages, balance: currentBalance });
        } catch (error) {
          try {
            currentBalance = identityUserStore.credit(userNpub, MESSAGE_COST_SATS);
          } catch (creditError) {
            console.error("[billing] failed to refund after agent error:", creditError);
          }
          return Response.json(
            { error: `Failed to contact agent: ${(error as Error).message}`, balance: currentBalance },
            { status: 502 },
          );
        }
      }
    }

    if (parts[4] === "queue") {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });

      if (method === "GET") {
        const queue = promptQueueStore.getSessionQueue(id);
        return Response.json({ id, queue });
      }

      if (method === "POST") {
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
        const content = typeof record.content === "string" ? record.content.trim() : "";

        if (!content) {
          return Response.json({ error: "Prompt content is required" }, { status: 400 });
        }

        try {
          const prompt = promptQueueStore.addPrompt(id, { content });
          if (!prompt) {
            return Response.json({ error: "Failed to add prompt to queue" }, { status: 400 });
          }
          void maybeAutoDispatchQueuedPrompt(ownedSession);
          return Response.json({ id, prompt });
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 400 });
        }
      }

      if (method === "PUT" && parts.length === 6) {
        const promptId = parts[5];
        if (!promptId) {
          return Response.json({ error: "Prompt ID required" }, { status: 400 });
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
        const content = typeof record.content === "string" ? record.content.trim() : "";

        if (!content) {
          return Response.json({ error: "Prompt content is required" }, { status: 400 });
        }

        const updated = promptQueueStore.updatePromptContent(id, promptId, content);
        if (!updated) {
          return Response.json({ error: "Prompt not found or failed to update" }, { status: 404 });
        }

        return Response.json({ id, promptId, updated: true });
      }

      if (method === "DELETE" && parts.length === 6) {
        const promptId = parts[5];
        if (!promptId) {
          return Response.json({ error: "Prompt ID required" }, { status: 400 });
        }

        const deleted = promptQueueStore.deletePromptById(id, promptId);
        if (!deleted) {
          return Response.json({ error: "Prompt not found" }, { status: 404 });
        }

        return Response.json({ id, promptId, deleted: true });
      }
    }

    if (method === "POST" && parts[4] === "queue" && parts[5] === "next") {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });

      if (queueDispatchInFlight.has(id)) {
        return Response.json({ error: "Prompt dispatch already in progress" }, { status: 409 });
      }

      queueDispatchInFlight.add(id);
      try {
        const result = await dispatchNextQueuedPromptForSession(ownedSession, authContext.npub ?? null);
        return Response.json(result);
      } catch (error) {
        if (error instanceof QueueDispatchError) {
          return Response.json({ error: error.message, ...(error.payload ?? {}) }, { status: error.status });
        }
        console.error("[queue] failed to send queued prompt:", error);
        return Response.json({ error: "Failed to send queued prompt" }, { status: 500 });
      } finally {
        queueDispatchInFlight.delete(id);
      }
    }
  }

  return Response.json({ error: "Not found" }, { status: 404 });
};

const server = Bun.serve({
  port: config.port,
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
      // Skip subdomain routing for Wingman's own API and UI paths
      const isWingmanPath = pathname.startsWith("/api/") ||
        pathname.startsWith("/home") ||
        pathname.startsWith("/live") ||
        pathname.startsWith("/settings") ||
        pathname.startsWith("/uploads/") ||
        pathname.startsWith("/projects") ||
        pathname.startsWith("/apps") ||
        pathname.startsWith("/deep-dive") ||
        pathname.startsWith("/orchestrator") ||
        pathname.startsWith("/auth") ||
        pathname === "/" ||
        pathname === "/favicon.ico";

      if (!isWingmanPath) {
        const subdomainResponse = await handleSubdomainRequest(request, subdomainProxyConfig);
        if (subdomainResponse) {
          return subdomainResponse;
        }
      }

      if (pathname === "/" && method === "GET") {
        return Response.redirect(`${url.origin}/home`, 302);
      }

      if (method === "GET" && pathname === "/deep-dive/config.json") {
        const denied = await ensureApiAccess(AccessActions.DeepDiveAccess, request, url, authContext);
        if (denied) {
          return denied;
        }
        const port = getDeepDivePort();
        const running = isDeepDiveProcessRunning();
        const override = Bun.env.DEEP_DIVE_SOCKET_URL?.trim();
        let socketUrl = override && override.length > 0 ? override : null;

        if (!socketUrl && running && port) {
          const protocol = url.protocol === "https:" ? "wss" : "ws";
          socketUrl = `${protocol}://${url.hostname}:${port}/deep-dive/socket`;
        }

        return Response.json(
          {
            socketUrl,
            running,
            port: socketUrl && port ? port : null,
          },
          {
            headers: {
              "cache-control": "no-cache",
            },
          },
        );
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
        pathname === "/settings" ||
        pathname.startsWith("/settings/");

      if (isSpaRoutePath && !assetService.isUiAssetPath(pathname)) {
        return serveIndex();
      }

      if (method === "GET" && isDeepDivePagePath(pathname)) {
        const denied = await ensurePageAccess(AccessActions.DeepDiveAccess, request, url, authContext);
        if (denied) {
          return denied;
        }
        const deepDivePage = assetService.servePublicAsset("/deep-dive.html");
        if (deepDivePage) {
          return deepDivePage;
        }
        return new Response("Deep Dive page missing", { status: 404 });
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
        return aceAsset;
      }

      const vendorAsset = await assetService.serveVendorModule(pathname);
      if (vendorAsset) {
        return vendorAsset;
      }

      const assetResponse = assetService.resolveUiAsset(pathname);
      if (assetResponse) {
        return assetResponse;
      }

      const publicAsset = assetService.servePublicAsset(pathname);
      if (publicAsset) {
        return publicAsset;
      }

      return new Response("Not Found", { status: 404 });
    });

    return maybeRefreshSessionCookie(response, authContext);
  },
});

const stopAllSessions = async () => {
  if (preserveSessionsOnShutdown) {
    console.log("[shutdown] preserving running agent sessions for warm restart");
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

// Ensure admin has balance after all env vars are loaded (important for first-run wizard)
identityUserStore.ensureAdminBalance();

export { server, manager, config };
