import { mkdir } from "node:fs/promises";
import { join, normalize } from "node:path";

import type { AgentDefinition, AgentType, WingmanConfig } from "../config";
import { getAuthenticatedNpub } from "../auth/request-context";
import { generateIdentityAlias } from "../identity/identity-alias";
import { normaliseNpub } from "../identity/npub-utils";
import { sanitizeLogEntry } from "../logging/log-sanitizer";
import type { AgentRuntimeStatus } from "../types/agent-status";
import { isPortAvailable } from "../utils/port-utils";

import {
  connectPM2,
  deleteProcess,
  getProcessByName,
  listProcesses,
  startProcessFromConfig,
  stopProcess,
  waitForStatus,
} from "./pm2-wrapper";
import {
  addAppToEcosystem,
  generateProcessName,
  getLogsDirectory,
  removeAppFromEcosystem,
  type SessionConfig,
} from "./ecosystem-generator";
import { readCombinedLogs } from "./log-reader";

const MAX_LOG_LINES = 500;

export type SessionStatus = "starting" | "running" | "stopped" | "error";

export interface SessionOrigin {
  type: string;
  id: string;
  url?: string;
  label?: string;
}

export interface SessionSnapshot {
  id: string;
  agent: AgentType;
  port: number;
  name: string;
  status: SessionStatus;
  agentRuntimeStatus?: AgentRuntimeStatus;
  startedAt: string;
  npub?: string;
  pid?: number;
  command: string[];
  workingDirectory: string;
  pm2Name?: string;
  logsDir?: string;
  exitCode?: number;
  logs: string[];
  origin?: SessionOrigin;
}

type SessionEvent =
  | { type: "session-started"; session: SessionSnapshot }
  | { type: "session-updated"; session: SessionSnapshot }
  | { type: "session-stopped"; session: SessionSnapshot };

export interface RehydrateSessionInput {
  id: string;
  agent: AgentType;
  port: number;
  name: string;
  startedAt: string;
  workingDirectory: string;
  command?: string[];
  pm2Name?: string;
  logsDir?: string;
  pid?: number;
  logs?: string[];
  npub?: string;
  agentRuntimeStatus?: AgentRuntimeStatus | null;
  origin?: SessionOrigin | null;
}

interface AgentSession {
  id: string;
  agent: AgentType;
  port: number;
  name: string;
  status: SessionStatus;
  startedAt: Date;
  definition: AgentDefinition;
  workingDirectory: string;
  command: string[];
  logs: string[];
  exitCode?: number;
  pm2Name?: string;
  logsDir?: string;
  pm2Pid?: number;
  npub?: string;
  agentRuntimeStatus?: AgentRuntimeStatus;
  origin?: SessionOrigin;
  userAlias?: string;
  isAdmin?: boolean;
}

export class ProcessManager {
  private readonly config: WingmanConfig;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly allocatedPorts = new Set<number>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly adminNpub = normaliseNpub(Bun.env.ADMIN_NPUB ?? null);
  private pm2Connected = false;

  constructor(config: WingmanConfig) {
    this.config = config;
  }

  /**
   * Initialize PM2 connection. Call once at server startup.
   */
  async initialize(): Promise<void> {
    if (this.pm2Connected) {
      return;
    }
    await connectPM2();
    this.pm2Connected = true;
    console.log("[manager] PM2 connection established");
  }

  on(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listSessions(): SessionSnapshot[] {
    return Array.from(this.sessions.values()).map((session) => this.toSnapshot(session));
  }

  getSession(id: string): SessionSnapshot | undefined {
    const session = this.sessions.get(id);
    return session ? this.toSnapshot(session) : undefined;
  }

  renameSession(id: string, name: string): SessionSnapshot | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.name = this.normaliseSessionName(name, session.agent, session.port);
    const snapshot = this.toSnapshot(session);
    this.emit({ type: "session-updated", session: snapshot });
    return snapshot;
  }

  async getLogs(id: string): Promise<string[] | undefined> {
    const session = this.sessions.get(id);
    if (!session) {
      return undefined;
    }

    // If we have a PM2 process, read from log files
    if (session.pm2Name && session.logsDir) {
      try {
        const logs = await readCombinedLogs(session.logsDir, session.pm2Name, MAX_LOG_LINES);
        session.logs = logs;
        return logs;
      } catch (error) {
        console.warn(`[manager] failed to read logs for ${session.pm2Name}: ${(error as Error).message}`);
      }
    }

    // Fallback to in-memory logs
    return session.logs.slice();
  }

  async createSession(
    agent: AgentType,
    workingDirectory?: string,
    name?: string,
    origin?: SessionOrigin | null,
  ): Promise<SessionSnapshot> {
    const definition = this.config.agents[agent];
    if (!definition) {
      throw new Error(`Unknown agent: ${agent}`);
    }

    // Ensure PM2 is connected
    await this.initialize();

    const port = this.allocatePort();
    const id = crypto.randomUUID();
    const sessionName = this.normaliseSessionName(name, agent, port);
    const command = definition.command({ port, agent, config: this.config });

    // Resolve user info
    const npub = getAuthenticatedNpub() ?? undefined;
    const isAdmin = this.isAdminUser(npub);
    const userAlias = this.resolveUserAlias(npub);

    // Resolve working directory
    const sessionWorkingDirectory =
      typeof workingDirectory === "string" && workingDirectory.length > 0
        ? workingDirectory
        : await this.resolveDefaultWorkingDirectory();

    console.log(`[manager] creating session for ${definition.label} with command: ${command.join(" ")}`);

    const session: AgentSession = {
      id,
      agent,
      port,
      name: sessionName,
      status: "starting",
      startedAt: new Date(),
      definition,
      workingDirectory: sessionWorkingDirectory,
      command,
      logs: [],
      pm2Name: undefined,
      logsDir: undefined,
      pm2Pid: undefined,
      npub,
      agentRuntimeStatus: undefined,
      origin: origin ?? undefined,
      userAlias,
      isAdmin,
    };

    this.sessions.set(id, session);
    this.emit({ type: "session-started", session: this.toSnapshot(session) });

    try {
      await this.startPM2Process(session);
      session.status = "running";
      this.emit({ type: "session-updated", session: this.toSnapshot(session) });
    } catch (error) {
      session.status = "error";
      session.logs.push(`[manager] failed to launch session: ${(error as Error).message}`);
      this.releasePort(session.port);
      this.emit({ type: "session-updated", session: this.toSnapshot(session) });
      throw error;
    }

    return this.toSnapshot(session);
  }

  rehydrateSession(input: RehydrateSessionInput): SessionSnapshot | null {
    const definition = this.config.agents[input.agent];
    if (!definition) {
      return null;
    }

    if (this.sessions.has(input.id)) {
      return this.toSnapshot(this.sessions.get(input.id)!);
    }

    if (this.allocatedPorts.has(input.port)) {
      return null;
    }

    const command =
      Array.isArray(input.command) && input.command.length > 0
        ? input.command
        : definition.command({ port: input.port, agent: input.agent, config: this.config });

    const sanitizedLogs = Array.isArray(input.logs)
      ? input.logs.map((entry) => sanitizeLogEntry(entry)).filter((entry) => entry.length > 0)
      : [];

    // Derive user alias from npub if not provided via pm2Name
    const npub = input.npub ?? undefined;
    const isAdmin = this.isAdminUser(npub);
    const userAlias = this.resolveUserAlias(npub);

    const session: AgentSession = {
      id: input.id,
      agent: input.agent,
      port: input.port,
      name: input.name,
      status: "running",
      startedAt: new Date(input.startedAt),
      definition,
      workingDirectory: input.workingDirectory,
      command,
      logs: sanitizedLogs,
      pm2Name: input.pm2Name,
      logsDir: input.logsDir,
      pm2Pid: typeof input.pid === "number" ? input.pid : undefined,
      npub,
      agentRuntimeStatus: input.agentRuntimeStatus ?? undefined,
      origin: input.origin ?? undefined,
      userAlias,
      isAdmin,
    };

    this.sessions.set(session.id, session);
    this.allocatedPorts.add(session.port);
    return this.toSnapshot(session);
  }

  async stopSession(id: string): Promise<SessionSnapshot | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;

    // Stop and remove from PM2
    if (session.pm2Name) {
      try {
        await stopProcess(session.pm2Name);
        // Wait briefly for stop to complete
        await waitForStatus(session.pm2Name, "stopped", 5000);
        // Delete from PM2 list
        await deleteProcess(session.pm2Name);
      } catch (error) {
        console.warn(`[manager] PM2 stop/delete failed for ${session.pm2Name}: ${(error as Error).message}`);
      }

      // Remove from ecosystem config
      try {
        await removeAppFromEcosystem(
          session.workingDirectory,
          session.isAdmin ?? false,
          session.pm2Name,
        );
      } catch (error) {
        console.warn(`[manager] failed to remove from ecosystem: ${(error as Error).message}`);
      }
    }

    session.status = "stopped";
    session.pm2Pid = undefined;
    this.releasePort(session.port);
    this.emit({ type: "session-stopped", session: this.toSnapshot(session) });
    return this.toSnapshot(session);
  }

  deleteSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }

    if (session.status === "starting" || session.status === "running") {
      throw new Error("Cannot delete a running session");
    }

    this.releasePort(session.port);
    this.sessions.delete(id);
    return true;
  }

  setAgentRuntimeStatus(id: string, status: AgentRuntimeStatus | null): SessionSnapshot | null {
    const session = this.sessions.get(id);
    if (!session) {
      return null;
    }
    const nextStatus = status ?? undefined;
    if (session.agentRuntimeStatus === nextStatus) {
      return this.toSnapshot(session);
    }
    session.agentRuntimeStatus = nextStatus;
    const snapshot = this.toSnapshot(session);
    this.emit({ type: "session-updated", session: snapshot });
    return snapshot;
  }

  /**
   * Sync session status with PM2 reality.
   * Call periodically or after operations to ensure consistency.
   */
  async syncWithPM2(): Promise<void> {
    if (!this.pm2Connected) {
      return;
    }

    const pm2Processes = await listProcesses();
    const pm2ByName = new Map(pm2Processes.map((p) => [p.name, p]));

    for (const session of this.sessions.values()) {
      if (!session.pm2Name) {
        continue;
      }

      const pm2Process = pm2ByName.get(session.pm2Name);
      if (!pm2Process) {
        // Process no longer exists in PM2
        if (session.status === "running" || session.status === "starting") {
          session.status = "stopped";
          session.pm2Pid = undefined;
          this.releasePort(session.port);
          this.emit({ type: "session-stopped", session: this.toSnapshot(session) });
        }
        continue;
      }

      // Update PID from PM2
      if (pm2Process.pid) {
        session.pm2Pid = pm2Process.pid;
      }

      // Sync status
      const pm2Status = pm2Process.pm2_env?.status;
      if (pm2Status === "online" && session.status !== "running") {
        session.status = "running";
        this.emit({ type: "session-updated", session: this.toSnapshot(session) });
      } else if ((pm2Status === "stopped" || pm2Status === "errored") && session.status === "running") {
        session.status = pm2Status === "errored" ? "error" : "stopped";
        this.releasePort(session.port);
        this.emit({ type: "session-stopped", session: this.toSnapshot(session) });
      }
    }
  }

  private async startPM2Process(session: AgentSession): Promise<void> {
    const userAlias = session.userAlias ?? "anonymous";
    const isAdmin = session.isAdmin ?? false;

    // Build session config for ecosystem
    const sessionConfig: SessionConfig = {
      sessionId: session.id,
      sessionName: session.name,
      agent: session.agent,
      port: session.port,
      workingDirectory: session.workingDirectory,
      userAlias,
      isAdmin,
      config: this.config,
    };

    // Add to ecosystem config and get paths
    const { ecosystemPath, processName, logsDir } = await addAppToEcosystem(sessionConfig);

    session.pm2Name = processName;
    session.logsDir = logsDir;

    console.log(`[manager] starting PM2 process ${processName} from ${ecosystemPath}`);

    // Start via PM2
    await startProcessFromConfig(ecosystemPath, processName);

    // Wait for process to come online
    const proc = await waitForStatus(processName, "online", 10000);
    if (!proc) {
      throw new Error(`PM2 process ${processName} failed to start within timeout`);
    }

    session.pm2Pid = proc.pid;
    console.log(`[manager] PM2 process ${processName} started with PID ${proc.pid}`);
  }

  private async resolveDefaultWorkingDirectory(): Promise<string> {
    const npub = normaliseNpub(getAuthenticatedNpub());
    if (!npub) {
      return this.config.defaultWorkingDirectory;
    }
    if (this.adminNpub && npub === this.adminNpub) {
      return this.config.defaultWorkingDirectory;
    }
    const alias = generateIdentityAlias(npub);
    const aliasDirectory = normalize(join(this.config.defaultWorkingDirectory, alias));
    try {
      await mkdir(aliasDirectory, { recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[manager] failed to ensure alias directory ${aliasDirectory}: ${message}`);
    }
    return aliasDirectory;
  }

  private isAdminUser(npub: string | undefined): boolean {
    if (!npub || !this.adminNpub) {
      return false;
    }
    return normaliseNpub(npub) === this.adminNpub;
  }

  private resolveUserAlias(npub: string | undefined): string {
    if (!npub) {
      return "anonymous";
    }
    if (this.isAdminUser(npub)) {
      return "admin";
    }
    return generateIdentityAlias(npub);
  }

  private allocatePort(): number {
    const { agentPortStart, agentPortMax } = this.config;
    for (let offset = 0; offset < agentPortMax; offset += 1) {
      const candidate = agentPortStart + offset;
      if (this.allocatedPorts.has(candidate)) {
        continue;
      }
      if (!isPortAvailable(candidate)) {
        console.warn(`[manager] skipping port ${candidate} because it is already in use`);
        continue;
      }
      this.allocatedPorts.add(candidate);
      return candidate;
    }
    throw new Error("No available agent ports. Increase AGENT_MAX or free sessions.");
  }

  private releasePort(port: number) {
    this.allocatedPorts.delete(port);
  }

  private toSnapshot(session: AgentSession): SessionSnapshot {
    return {
      id: session.id,
      agent: session.agent,
      port: session.port,
      name: session.name,
      status: session.status,
      agentRuntimeStatus: session.agentRuntimeStatus,
      startedAt: session.startedAt.toISOString(),
      npub: session.npub,
      pid: session.pm2Pid,
      command: session.command,
      workingDirectory: session.workingDirectory,
      pm2Name: session.pm2Name,
      logsDir: session.logsDir,
      exitCode: session.exitCode,
      logs: session.logs.slice(-50),
      origin: session.origin,
    };
  }

  private normaliseSessionName(name: string | undefined, agent: AgentType, port: number): string {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (trimmed.length > 0) {
      return trimmed;
    }
    return `${agent} :${port}`;
  }

  private emit(event: SessionEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
