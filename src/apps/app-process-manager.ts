import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReadableStream } from "node:stream/web";

import { loadConfig } from "../config";
import { appRegistry } from "./app-registry";
import type { AppLifecycleAction, AppRecord, AppRegistry } from "./app-registry";

const logDirectoryPath = new URL("../../data/app-logs", import.meta.url).pathname;
export const APPS_TMUX_SESSION = "wingman-apps";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

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
  private readonly logDirReady: Promise<string | undefined>;
  private readonly config = loadConfig();

  constructor(registry: AppRegistry = appRegistry) {
    this.registry = registry;
    this.logDirReady = mkdir(logDirectoryPath, { recursive: true });
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
      const command = this.requireScript(app, "start");
      await this.ensureSession(app);
      await this.attachLogPipe(app);
      const result = await this.sendToSession(app, command);
      if (result.exitCode !== 0) {
        throw new AppActionError(app.id, "start", result.stderr || result.stdout || "Failed to send start command");
      }
      return {
        finalStatus: "running" as AppRuntimeStatus,
        exitCode: result.exitCode,
        message: "Start command dispatched",
      };
    });
  }

  async stop(appId: string): Promise<AppProcessStatus> {
    return this.runAction(appId, "stop", async (app) => {
      const command = this.requireScript(app, "stop");
      await this.ensureSession(app);
      const result = await this.sendToSession(app, command);
      if (result.exitCode !== 0) {
        throw new AppActionError(app.id, "stop", result.stderr || result.stdout || "Failed to send stop command");
      }
      return {
        finalStatus: "idle" as AppRuntimeStatus,
        exitCode: result.exitCode,
        message: "Stop command dispatched",
      };
    });
  }

  async restart(appId: string): Promise<AppProcessStatus> {
    return this.runAction(appId, "restart", async (app) => {
      const stopScript = app.scripts.stop;
      const startScript = app.scripts.start;
      const restartScript = app.scripts.restart;
      await this.ensureSession(app);
      await this.attachLogPipe(app);
      if (restartScript) {
        const restartResult = await this.sendToSession(app, restartScript);
        if (restartResult.exitCode !== 0) {
          throw new AppActionError(
            app.id,
            "restart",
            restartResult.stderr || restartResult.stdout || "Failed to send restart command",
          );
        }
        return {
          finalStatus: "running" as AppRuntimeStatus,
          exitCode: restartResult.exitCode,
          message: "Restart command dispatched",
        };
      }
      if (!stopScript || !startScript) {
        throw new AppScriptMissingError(app.id, "restart");
      }
      const stopResult = await this.sendToSession(app, stopScript);
      if (stopResult.exitCode !== 0) {
        throw new AppActionError(
          app.id,
          "restart",
          stopResult.stderr || stopResult.stdout || "Failed while dispatching stop command",
        );
      }
      const startResult = await this.sendToSession(app, startScript);
      if (startResult.exitCode !== 0) {
        throw new AppActionError(
          app.id,
          "restart",
          startResult.stderr || startResult.stdout || "Failed while dispatching start command",
        );
      }
      return {
        finalStatus: "running" as AppRuntimeStatus,
        exitCode: startResult.exitCode,
        message: "Restart sequence (stop/start) dispatched",
      };
    });
  }

  async build(appId: string): Promise<AppProcessStatus> {
    return this.runAction(appId, "build", async (app) => {
      const command = this.requireScript(app, "build");
      await this.ensureSession(app);
      await this.attachLogPipe(app);
      const result = await this.sendToSession(app, command);
      if (result.exitCode !== 0) {
        throw new AppActionError(app.id, "build", result.stderr || result.stdout || "Failed to send build command");
      }
      return {
        finalStatus: "idle" as AppRuntimeStatus,
        exitCode: result.exitCode,
        message: "Build command dispatched",
      };
    });
  }

  async setup(appId: string): Promise<AppProcessStatus> {
    return this.runAction(appId, "setup", async (app) => {
      const command = this.requireScript(app, "setup");
      await this.ensureSession(app);
      await this.attachLogPipe(app);
      const result = await this.sendToSession(app, command);
      if (result.exitCode !== 0) {
        throw new AppActionError(app.id, "setup", result.stderr || result.stdout || "Failed to send setup command");
      }
      return {
        finalStatus: "idle" as AppRuntimeStatus,
        exitCode: result.exitCode,
        message: "Setup command dispatched",
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
    await this.logDirReady;
    const logPath = this.logPath(appId);
    try {
      const contents = await readFile(logPath, "utf8");
      const allLines = contents.split(/\r?\n/).filter(Boolean);
      return allLines.slice(-lines);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async listStatuses(): Promise<AppProcessStatus[]> {
    const apps = await this.registry.listApps();
    const statuses = await Promise.all(apps.map((app) => this.resolveState(app).then((state) => this.toStatus(app, state))));
    return statuses;
  }

  async kill(appId: string): Promise<void> {
    const app = await this.registry.getApp(appId);
    if (!app) {
      throw new Error(`Unknown app: ${appId}`);
    }
    const target = this.getTmuxTarget(app);
    const result = await this.runTmux(["kill-window", "-t", target]);
    if (result.exitCode !== 0) {
      const output = result.stderr || result.stdout || "";
      if (!/can't find window|no such window|can't find session|no such session/i.test(output)) {
        throw new Error(output || `Failed to kill tmux window ${target}`);
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
      if (app.id === "wingman-core") {
        const runningNow = await this.isWingmanServerRunning();
        existing.status = runningNow ? "running" : "idle";
        existing.updatedAt = new Date().toISOString();
      }
      return existing;
    }
    const running =
      app.id === "wingman-core" ? await this.isWingmanServerRunning() : await this.isSessionRunning(app);
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

  private toStatus(app: AppRecord, state: AppRuntimeState): AppProcessStatus {
    return {
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
  }

  private requireScript(app: AppRecord, action: AppLifecycleAction): string {
    const script = app.scripts[action];
    if (!script) {
      throw new AppScriptMissingError(app.id, action);
    }
    return script;
  }

  private async ensureSession(app: AppRecord) {
    const baseSession = await this.runTmux(["has-session", "-t", APPS_TMUX_SESSION]);
    if (baseSession.exitCode !== 0) {
      const createSession = await this.runTmux(["new-session", "-d", "-s", APPS_TMUX_SESSION, "-c", app.root]);
      if (createSession.exitCode !== 0) {
        throw new Error(
          createSession.stderr || createSession.stdout || `Failed to create tmux session ${APPS_TMUX_SESSION}`,
        );
      }
      const remainSession = await this.runTmux(["set-option", "-t", APPS_TMUX_SESSION, "remain-on-exit", "on"]);
      if (remainSession.exitCode !== 0) {
        throw new Error(
          remainSession.stderr || remainSession.stdout || `Failed to configure tmux session ${APPS_TMUX_SESSION}`,
        );
      }
    }
    const windowName = this.getWindowName(app);
    const windows = await this.runTmux(["list-windows", "-t", APPS_TMUX_SESSION, "-F", "#{window_name}"]);
    if (windows.exitCode !== 0) {
      throw new Error(windows.stderr || windows.stdout || `Failed to list windows for ${APPS_TMUX_SESSION}`);
    }
    const knownWindows = windows.stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (knownWindows.includes(windowName)) {
      return;
    }
    const createWindow = await this.runTmux([
      "new-window",
      "-t",
      APPS_TMUX_SESSION,
      "-n",
      windowName,
      "-c",
      app.root,
    ]);
    if (createWindow.exitCode !== 0) {
      throw new Error(createWindow.stderr || createWindow.stdout || `Failed to create tmux window ${windowName}`);
    }
    const remainWindow = await this.runTmux([
      "set-option",
      "-t",
      `${APPS_TMUX_SESSION}:${windowName}`,
      "remain-on-exit",
      "on",
    ]);
    if (remainWindow.exitCode !== 0) {
      throw new Error(remainWindow.stderr || remainWindow.stdout || `Failed to configure tmux window ${windowName}`);
    }
  }

  private async attachLogPipe(app: AppRecord) {
    await this.logDirReady;
    const path = this.logPath(app.id);
    await appendFile(path, "", "utf8");
    const escaped = path.replace(/"/g, '\\"');
    const pipe = await this.runTmux(["pipe-pane", "-t", this.getTmuxTarget(app), "-o", `cat >> "${escaped}"`]);
    if (pipe.exitCode !== 0) {
      throw new Error(pipe.stderr || pipe.stdout || `Failed to attach log pipe for ${this.getTmuxTarget(app)}`);
    }
  }

  private async sendToSession(app: AppRecord, command: string): Promise<CommandResult> {
    const prompt = command.trim();
    if (!prompt) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return this.runTmux(["send-keys", "-t", this.getTmuxTarget(app), prompt, "Enter"]);
  }

  private async runTmux(args: string[]): Promise<CommandResult> {
    const subprocess = Bun.spawn(["tmux", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(subprocess.stdout),
      readStream(subprocess.stderr),
      subprocess.exited,
    ]);
    return {
      exitCode: exitCode ?? 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  }

  private async isSessionRunning(app: AppRecord): Promise<boolean> {
    const windows = await this.runTmux(["list-windows", "-t", APPS_TMUX_SESSION, "-F", "#{window_name}"]);
    if (windows.exitCode !== 0) {
      return false;
    }
    const windowName = this.getWindowName(app);
    return windows.stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .includes(windowName);
  }

  private logPath(appId: string): string {
    return join(logDirectoryPath, `${appId}.log`);
  }

  private getWindowName(app: AppRecord): string {
    return app.tmuxSession;
  }

  private getTmuxTarget(app: AppRecord): string {
    return `${APPS_TMUX_SESSION}:${this.getWindowName(app)}`;
  }

  private async isWingmanServerRunning(): Promise<boolean> {
    const port = this.config.port;
    try {
      const response = await fetch(`http://localhost:${port}/api/system/restart/status`, {
        method: "GET",
        headers: {
          "cache-control": "no-cache",
        },
        signal: AbortSignal.timeout(1500),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

const readStream = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      output += decoder.decode(value, { stream: true });
    }
  }
  output += decoder.decode();
  return output;
};

export const appProcessManager = new AppProcessManager();
