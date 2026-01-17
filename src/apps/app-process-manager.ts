import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "../config";
import { sanitizeLogEntry } from "../logging/log-sanitizer";
import { appRegistry } from "./app-registry";
import type { AppLifecycleAction, AppRecord, AppRegistry } from "./app-registry";
import { generateIdentityAlias } from "../identity/identity-alias";
import { normaliseNpub } from "../identity/npub-utils";
import {
  addUserAppToEcosystem,
  generateAppProcessName,
  getEcosystemPath,
  getLogsDirectory,
  removeAppFromEcosystem,
} from "../agents/ecosystem-generator";
import {
  deleteProcess,
  getProcessByName,
  getProcessRuntimeInfo,
  restartProcess,
  startProcessFromConfig,
  stopProcess,
} from "../agents/pm2-wrapper";
import { readCombinedLogs } from "../agents/log-reader";
import { runtimePortRegistry } from "./runtime-port-registry";
import { waitForListeningPort } from "../utils/port-utils";

export type AppRuntimeStatus =
  | "idle"
  | "running"
  | "stopping"
  | "restarting"
  | "setting-up"
  | "building"
  | "failed";

export interface AppProcessStatus {
  appId: string;
  status: AppRuntimeStatus;
  lastAction: AppLifecycleAction | null;
  lastExitCode: number | null;
  message?: string;
  updatedAt: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  running: boolean;
  inProgressAction: AppLifecycleAction | null;
  /** Port the app is running on (from PM2 runtime). */
  runtimePort?: number | null;
  /** Process ID (from PM2 runtime). */
  pid?: number | null;
  /** Memory usage in bytes (from PM2 runtime). */
  memory?: number | null;
}

interface AppRuntimeState {
  status: AppRuntimeStatus;
  lastAction: AppLifecycleAction | null;
  lastExitCode: number | null;
  message?: string;
  updatedAt: string;
  inProgress: AppLifecycleAction | null;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

export class AppActionError extends Error {
  readonly appId: string;
  readonly action: AppLifecycleAction;

  constructor(appId: string, action: AppLifecycleAction, message: string, cause?: unknown) {
    super(message);
    this.name = "AppActionError";
    this.appId = appId;
    this.action = action;
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

export class AppActionInProgressError extends AppActionError {
  constructor(appId: string, action: AppLifecycleAction) {
    super(appId, action, `Another action is already in progress for app ${appId}`);
    this.name = "AppActionInProgressError";
  }
}

export class AppScriptMissingError extends AppActionError {
  constructor(appId: string, action: AppLifecycleAction) {
    super(appId, action, `No script defined for ${action}`);
    this.name = "AppScriptMissingError";
  }
}

const ACTION_STATUS: Record<AppLifecycleAction, AppRuntimeStatus> = {
  start: "running",
  stop: "stopping",
  restart: "restarting",
  setup: "setting-up",
  build: "building",
};

export class AppProcessManager {
  private readonly registry: AppRegistry;
  private readonly states = new Map<string, AppRuntimeState>();
  private readonly config = loadConfig();
  private readonly adminNpub: string | null;

  constructor(registry: AppRegistry = appRegistry, adminNpub?: string | null) {
    this.registry = registry;
    this.adminNpub = adminNpub ?? null;
  }

  async getStatus(appId: string): Promise<AppProcessStatus> {
    const app = await this.registry.getApp(appId);
    if (!app) {
      throw new Error(`Unknown app: ${appId}`);
    }
    const state = await this.resolveState(app);
    return this.toStatus(app, state);
  }

  async start(appId: string): Promise<AppProcessStatus> {
    return this.runAction(appId, "start", async (app) => {
      const script = this.requireScript(app, "start");

      // Resolve user info
      const { userAlias, userRootDir, isAdmin } = this.resolveUserContext(app);

      // Add to ecosystem and start via PM2
      const { ecosystemPath, processName, logsDir } = await addUserAppToEcosystem({
        app,
        userAlias,
        userRootDir,
        isAdmin,
      });

      // Update app record with PM2 info
      await this.registry.updateApp(app.id, { pm2Name: processName, logsDir });

      // Start the process
      await startProcessFromConfig(ecosystemPath, processName);

      // Detect and register runtime port
      await this.detectAndRegisterPort(app.id, processName);

      return {
        finalStatus: "running" as AppRuntimeStatus,
        exitCode: 0,
        message: `Started via PM2 as ${processName}`,
      };
    });
  }

  async stop(appId: string): Promise<AppProcessStatus> {
    return this.runAction(appId, "stop", async (app) => {
      // Clear runtime port first
      runtimePortRegistry.clear(app.id);

      const processName = app.pm2Name;
      if (!processName) {
        return {
          finalStatus: "idle" as AppRuntimeStatus,
          exitCode: 0,
          message: "App was not running (no PM2 process)",
        };
      }

      try {
        await stopProcess(processName);
        await deleteProcess(processName);
      } catch (error) {
        // Process might not exist, which is fine
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("not found") && !message.includes("doesn't exist")) {
          throw error;
        }
      }

      // Remove from ecosystem
      const { userRootDir, isAdmin } = this.resolveUserContext(app);
      await removeAppFromEcosystem(userRootDir, isAdmin, processName);

      return {
        finalStatus: "idle" as AppRuntimeStatus,
        exitCode: 0,
        message: "Stopped and removed from PM2",
      };
    });
  }

  async restart(appId: string): Promise<AppProcessStatus> {
    return this.runAction(appId, "restart", async (app) => {
      const startScript = app.scripts.start;
      if (!startScript) {
        throw new AppScriptMissingError(app.id, "restart");
      }

      // Clear runtime port before restart
      runtimePortRegistry.clear(app.id);

      const processName = app.pm2Name;
      if (processName) {
        // Try PM2 restart first
        try {
          const proc = await getProcessByName(processName);
          if (proc) {
            await restartProcess(processName);

            // Detect and register new runtime port
            await this.detectAndRegisterPort(app.id, processName);

            return {
              finalStatus: "running" as AppRuntimeStatus,
              exitCode: 0,
              message: `Restarted PM2 process ${processName}`,
            };
          }
        } catch {
          // Process doesn't exist, fall through to fresh start
        }
      }

      // Fresh start
      const { userAlias, userRootDir, isAdmin } = this.resolveUserContext(app);
      const { ecosystemPath, processName: newProcessName, logsDir } = await addUserAppToEcosystem({
        app,
        userAlias,
        userRootDir,
        isAdmin,
      });

      await this.registry.updateApp(app.id, { pm2Name: newProcessName, logsDir });
      await startProcessFromConfig(ecosystemPath, newProcessName);

      // Detect and register runtime port
      await this.detectAndRegisterPort(app.id, newProcessName);

      return {
        finalStatus: "running" as AppRuntimeStatus,
        exitCode: 0,
        message: `Started via PM2 as ${newProcessName}`,
      };
    });
  }

  async build(appId: string): Promise<AppProcessStatus> {
    return this.runAction(appId, "build", async (app) => {
      const script = this.requireScript(app, "build");
      const result = await this.runOneShot(app, script, "build");
      return {
        finalStatus: result.exitCode === 0 ? ("idle" as AppRuntimeStatus) : ("failed" as AppRuntimeStatus),
        exitCode: result.exitCode,
        message: result.exitCode === 0 ? "Build completed" : `Build failed with exit code ${result.exitCode}`,
      };
    });
  }

  async setup(appId: string): Promise<AppProcessStatus> {
    return this.runAction(appId, "setup", async (app) => {
      const script = this.requireScript(app, "setup");
      const result = await this.runOneShot(app, script, "setup");
      return {
        finalStatus: result.exitCode === 0 ? ("idle" as AppRuntimeStatus) : ("failed" as AppRuntimeStatus),
        exitCode: result.exitCode,
        message: result.exitCode === 0 ? "Setup completed" : `Setup failed with exit code ${result.exitCode}`,
      };
    });
  }

  async tailLogs(appId: string, lines = 100): Promise<string[]> {
    if (lines <= 0) {
      return [];
    }
    const app = await this.registry.getApp(appId);
    if (!app) {
      throw new Error(`Unknown app: ${appId}`);
    }

    // If we have PM2 info, use that
    if (app.pm2Name && app.logsDir) {
      try {
        return await readCombinedLogs(app.logsDir, app.pm2Name, lines);
      } catch {
        // Fall through to empty
      }
    }

    return [];
  }

  async listStatuses(): Promise<AppProcessStatus[]> {
    const apps = await this.registry.listApps();
    const statuses = await Promise.all(
      apps.map((app) => this.resolveState(app).then((state) => this.toStatus(app, state))),
    );
    return statuses;
  }

  async kill(appId: string): Promise<void> {
    const app = await this.registry.getApp(appId);
    if (!app) {
      throw new Error(`Unknown app: ${appId}`);
    }

    if (app.pm2Name) {
      try {
        await stopProcess(app.pm2Name);
        await deleteProcess(app.pm2Name);
      } catch {
        // Ignore errors - process might not exist
      }
    }

    this.states.delete(appId);
  }

  forget(appId: string) {
    this.states.delete(appId);
  }

  private async runAction(
    appId: string,
    action: AppLifecycleAction,
    handler: (app: AppRecord) => Promise<{ finalStatus: AppRuntimeStatus; exitCode?: number | null; message?: string }>,
  ): Promise<AppProcessStatus> {
    const app = await this.registry.getApp(appId);
    if (!app) {
      throw new Error(`Unknown app: ${appId}`);
    }
    const state = await this.resolveState(app);
    if (state.inProgress) {
      throw new AppActionInProgressError(app.id, state.inProgress);
    }

    state.inProgress = action;
    state.status = ACTION_STATUS[action];
    state.lastAction = action;
    state.updatedAt = new Date().toISOString();
    try {
      const { finalStatus, exitCode, message } = await handler(app);
      state.status = finalStatus;
      state.lastExitCode = exitCode ?? null;
      state.message = message;
      state.updatedAt = new Date().toISOString();
      state.lastSuccessAt = state.updatedAt;
      return this.toStatus(app, state);
    } catch (error) {
      state.status = "failed";
      state.lastExitCode = null;
      state.message = (error as Error).message;
      state.updatedAt = new Date().toISOString();
      state.lastFailureAt = state.updatedAt;
      throw error;
    } finally {
      state.inProgress = null;
    }
  }

  private async resolveState(app: AppRecord): Promise<AppRuntimeState> {
    const existing = this.states.get(app.id);
    if (existing) {
      // Check if PM2 process is actually running
      if (app.pm2Name) {
        const running = await this.isPM2ProcessRunning(app.pm2Name);
        existing.status = running ? "running" : "idle";
        existing.updatedAt = new Date().toISOString();
      }
      return existing;
    }

    // Check if app is running via PM2
    const running = app.pm2Name ? await this.isPM2ProcessRunning(app.pm2Name) : false;
    const status: AppRuntimeState = {
      status: running ? "running" : "idle",
      lastAction: null,
      lastExitCode: null,
      updatedAt: new Date().toISOString(),
      inProgress: null,
    };
    this.states.set(app.id, status);
    return status;
  }

  private async toStatus(app: AppRecord, state: AppRuntimeState): Promise<AppProcessStatus> {
    const status: AppProcessStatus = {
      appId: app.id,
      status: state.status,
      lastAction: state.lastAction,
      lastExitCode: state.lastExitCode,
      message: state.message,
      updatedAt: state.updatedAt,
      lastSuccessAt: state.lastSuccessAt,
      lastFailureAt: state.lastFailureAt,
      running: state.status === "running",
      inProgressAction: state.inProgress,
    };

    // Fetch PM2 runtime info if app has a PM2 process
    if (app.pm2Name && state.status === "running") {
      try {
        const runtimeInfo = await getProcessRuntimeInfo(app.pm2Name);
        if (runtimeInfo) {
          status.runtimePort = runtimeInfo.port;
          status.pid = runtimeInfo.pid;
          status.memory = runtimeInfo.memory;
        }
      } catch {
        // Ignore errors fetching runtime info
      }
    }

    return status;
  }

  private requireScript(app: AppRecord, action: AppLifecycleAction): string {
    const script = app.scripts[action];
    if (!script) {
      throw new AppScriptMissingError(app.id, action);
    }
    return script;
  }

  private resolveUserContext(app: AppRecord): { userAlias: string; userRootDir: string; isAdmin: boolean } {
    const ownerNpub = normaliseNpub(app.ownerNpub);
    const isAdmin = Boolean(this.adminNpub && ownerNpub && ownerNpub === this.adminNpub);

    // Derive alias from owner or use a fallback
    const userAlias = ownerNpub
      ? generateIdentityAlias(ownerNpub)
      : "anonymous";

    // For admin, use admin data dir; for users, use their root
    const userRootDir = isAdmin
      ? this.config.defaultWorkingDirectory
      : app.root;

    return { userAlias, userRootDir, isAdmin };
  }

  private async isPM2ProcessRunning(processName: string): Promise<boolean> {
    try {
      const proc = await getProcessByName(processName);
      return proc?.pm2_env?.status === "online";
    } catch {
      return false;
    }
  }

  /**
   * Detect the runtime port from a PM2 process and register it.
   * Polls for the port since the app may take time to bind after starting.
   */
  private async detectAndRegisterPort(appId: string, processName: string): Promise<void> {
    try {
      const runtimeInfo = await getProcessRuntimeInfo(processName);
      if (!runtimeInfo?.pid) {
        console.warn(`[app-process-manager] No PID found for ${processName}, cannot detect port`);
        return;
      }

      const port = await waitForListeningPort(runtimeInfo.pid, { maxAttempts: 5, delayMs: 500 });
      if (port !== null) {
        runtimePortRegistry.set(appId, port, runtimeInfo.pid);
      } else {
        console.warn(`[app-process-manager] Could not detect listening port for ${processName} (pid ${runtimeInfo.pid})`);
      }
    } catch (error) {
      console.warn(`[app-process-manager] Error detecting port for ${processName}:`, error);
    }
  }

  /**
   * Run a one-shot command (build/setup) via Bun.spawn.
   * Logs output to the app's log directory.
   */
  private async runOneShot(
    app: AppRecord,
    script: string,
    action: string,
  ): Promise<{ exitCode: number; output: string }> {
    const { userRootDir, isAdmin } = this.resolveUserContext(app);
    const logsDir = getLogsDirectory(userRootDir, isAdmin);
    await mkdir(logsDir, { recursive: true });

    // Build command with port if web app
    let command = script;
    if (app.webApp && app.webAppPort) {
      command = `PORT=${app.webAppPort} ${script}`;
    }

    const subprocess = Bun.spawn(["bash", "-c", command], {
      cwd: app.root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...(app.webAppPort ? { PORT: String(app.webAppPort) } : {}),
      },
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);

    // Write to log file
    const logFileName = app.pm2Name ? `${app.pm2Name}-${action}.log` : `${app.id}-${action}.log`;
    const logPath = join(logsDir, logFileName);
    const timestamp = new Date().toISOString();
    const logContent = `\n=== ${action.toUpperCase()} at ${timestamp} ===\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}\n`;
    await appendFile(logPath, logContent, "utf8");

    return {
      exitCode: exitCode ?? 1,
      output: stdout + stderr,
    };
  }
}

export const appProcessManager = new AppProcessManager();
