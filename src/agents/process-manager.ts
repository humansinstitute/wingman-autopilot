import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";

import type { AgentDefinition, AgentType, WingmanConfig } from "../config";
import { getAuthenticatedNpub } from "../auth/request-context";
import { generateIdentityAlias } from "../identity/identity-alias";
import { normaliseNpub } from "../identity/npub-utils";
import { isPortAvailable } from "../utils/port-utils.js";
import { sanitizeLogEntry } from "../logging/log-sanitizer";
import { trackProjectForSession } from "../projects/npub-project-tracker";
import type { AgentRuntimeStatus } from "../types/agent-status";
import type { AgentAdapter } from "./agent-adapter";
import { resolveAdapterFactory } from "./agent-adapter";
import {
  type SessionMetadata,
  type SessionMetadataInput,
  normaliseSessionMetadata,
} from "../sessions/session-metadata";
import {
  addAppToEcosystem,
  removeAppFromEcosystem,
  type SessionConfig,
} from "./ecosystem-generator";
import {
  startProcessFromConfig,
  stopProcess,
  deleteProcess,
  getProcessByName,
  waitForStatus,
} from "./pm2-wrapper";
import { injectMcpConfig, cleanupMcpConfig } from "./mcp-injector";
import { parseAllowedHosts, pickAgentHost, normaliseHostForUrl } from "./agent-client";
import { BotKeyStore } from "../identity/bot-key-store";
import { ensureCredentialHelper, getGiteaGitEnv } from "../gitea/credential-helper";
import { resolveGiteaCredentials } from "../gitea/gitea-user-manager";

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
  exitCode?: number;
  logs: string[];
  origin?: SessionOrigin;
  userAlias?: string;
  isAdmin?: boolean;
  /** PM2 process name if spawned via PM2 */
  pm2Name?: string;
  /** Target file for writer-mode sessions */
  targetFile?: string;
  /** File pinned as artifact in the UI right-hand panel */
  pinnedFile?: string;
  metadata?: SessionMetadata;
}

type SessionEvent =
  | { type: "session-started"; session: SessionSnapshot }
  | { type: "session-updated"; session: SessionSnapshot }
  | { type: "session-stopped"; session: SessionSnapshot }
  | { type: "session-deleted"; session: SessionSnapshot };

export interface RehydrateSessionInput {
  id: string;
  agent: AgentType;
  port: number;
  name: string;
  startedAt: string;
  workingDirectory: string;
  command?: string[];
  pid?: number;
  logs?: string[];
  npub?: string;
  agentRuntimeStatus?: AgentRuntimeStatus | null;
  origin?: SessionOrigin | null;
  /** PM2 process name if this was a PM2-managed session */
  pm2Name?: string;
  /** Target file for writer-mode sessions */
  targetFile?: string;
  /** File pinned as artifact in the UI right-hand panel */
  pinnedFile?: string;
  metadata?: SessionMetadataInput;
}

interface AgentSession {
  id: string;
  agent: AgentType;
  port: number;
  name: string;
  status: SessionStatus;
  startedAt: Date;
  process: Bun.Subprocess | null;
  definition: AgentDefinition;
  workingDirectory: string;
  command: string[];
  logs: string[];
  exitCode?: number;
  detachedPid?: number;
  npub?: string;
  agentRuntimeStatus?: AgentRuntimeStatus;
  origin?: SessionOrigin;
  userAlias?: string;
  isAdmin?: boolean;
  /** PM2 process name when spawned via PM2 */
  pm2Name?: string;
  /** Target file for writer-mode sessions */
  targetFile?: string;
  /** File pinned as artifact in the UI right-hand panel */
  pinnedFile?: string;
  metadata: SessionMetadata;
  /** Files created by MCP config injection to clean up on session stop. */
  mcpCleanupFiles?: string[];
  /** Protocol adapter for communicating with this agent */
  adapter?: AgentAdapter;
}

export class ProcessManager {
  private readonly config: WingmanConfig;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly allocatedPorts = new Set<number>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly adminNpub = normaliseNpub(Bun.env.ADMIN_NPUB ?? null);
  private botKeyStore: BotKeyStore | null | undefined;
  /** Debounce timers for log-driven session-updated events */
  private readonly logUpdateDebounce = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: WingmanConfig) {
    this.config = config;
  }

  private getBotKeyStore(): BotKeyStore | null {
    if (this.botKeyStore !== undefined) {
      return this.botKeyStore;
    }
    try {
      this.botKeyStore = new BotKeyStore();
    } catch (error) {
      this.botKeyStore = null;
      console.warn(`[manager] bot key store init failed (non-fatal): ${(error as Error).message}`);
    }
    return this.botKeyStore;
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
    return session.logs.slice();
  }

  async createSession(
    agent: AgentType,
    workingDirectory?: string,
    name?: string,
    origin?: SessionOrigin | null,
    targetFile?: string,
    explicitNpub?: string,
    metadata?: SessionMetadataInput,
  ): Promise<SessionSnapshot> {
    const launchStartedAt = Date.now();
    const requestNpub = explicitNpub ?? getAuthenticatedNpub() ?? undefined;
    const definition = this.config.agents[agent];
    if (!definition) {
      throw new Error(`Unknown agent: ${agent}`);
    }

    const port = this.allocatePort();
    const id = crypto.randomUUID();
    const sessionName = this.normaliseSessionName(name, agent, port);
    const command = definition.command({ port, agent, config: this.config });
    const sessionMetadata = normaliseSessionMetadata(metadata);
    const rawWorkingDirectory =
      typeof workingDirectory === "string" && workingDirectory.length > 0
        ? workingDirectory
        : await this.resolveDefaultWorkingDirectory(requestNpub);
    // Expand ~ to user home so Bun.spawn gets an absolute path
    const sessionWorkingDirectory = rawWorkingDirectory.startsWith("~/")
      ? resolve(homedir(), rawWorkingDirectory.slice(2))
      : rawWorkingDirectory;

    // Resolve user info
    const npub = requestNpub;
    const isAdmin = this.isAdminUser(npub);
    const userAlias = this.resolveUserAlias(npub);

    console.log(`[manager] launching ${definition.label} with command: ${command.join(" ")}`);
    const session: AgentSession = {
      id,
      agent,
      port,
      name: sessionName,
      status: "starting",
      startedAt: new Date(),
      process: null,
      definition,
      workingDirectory: sessionWorkingDirectory,
      command,
      logs: [],
      detachedPid: undefined,
      npub,
      agentRuntimeStatus: undefined,
      origin: origin ?? undefined,
      userAlias,
      isAdmin,
      targetFile: targetFile ?? undefined,
      metadata: sessionMetadata,
    };

    this.sessions.set(id, session);
    this.emit({ type: "session-started", session: this.toSnapshot(session) });

    let botKeyLookupMs = 0;
    let mcpInjectMs = 0;
    let giteaInjectMs = 0;
    let spawnMs = 0;

    // Inject MCP config so the agent discovers the Wingman MCP server
    try {
      const botKeyLookupStartedAt = Date.now();
      // Look up bot identity for this user's session
      let botPubkeyHex: string | undefined;
      let botNpub: string | undefined;
      if (npub) {
        try {
          const botKeyStore = this.getBotKeyStore();
          const botKey = botKeyStore?.getActiveKeyForUser(npub) ?? null;
          if (botKey) {
            botPubkeyHex = botKey.botPubkeyHex;
            botNpub = botKey.botNpub;
          }
        } catch {
          // Non-fatal: bot key lookup may fail if DB not initialized
        }
      }
      botKeyLookupMs = Date.now() - botKeyLookupStartedAt;
      const mcpInjectStartedAt = Date.now();
      const mcpResult = await injectMcpConfig({
        sessionId: id,
        agent,
        workingDirectory: sessionWorkingDirectory,
        config: this.config,
        botPubkeyHex,
        botNpub,
        userNpub: npub,
      });
      session.mcpCleanupFiles = mcpResult.cleanupFiles;
      // Merge MCP env vars into the agent definition for spawning
      session.definition = {
        ...session.definition,
        env: { ...session.definition.env, ...mcpResult.env },
      };
      if (Array.isArray(mcpResult.commandArgs) && mcpResult.commandArgs.length > 0) {
        session.command = [...session.command, ...mcpResult.commandArgs];
      }
      this.appendLog(
        session,
        `[manager] post-injection command: ${session.command.join(" ")}`,
      );
      const injectedEnvKeys = Object.keys(mcpResult.env ?? {}).sort();
      if (injectedEnvKeys.length > 0) {
        const envPreview = injectedEnvKeys
          .map((key) => {
            const value = mcpResult.env[key];
            if (typeof value !== "string") return key;
            if (key === "SESSION_ID") return `${key}=<redacted>`;
            return `${key}=${value}`;
          })
          .join(" ");
        this.appendLog(session, `[manager] post-injection env: ${envPreview}`);
      }
      mcpInjectMs = Date.now() - mcpInjectStartedAt;
    } catch (mcpError) {
      this.appendLog(session, `[manager] MCP config injection failed (non-fatal): ${(mcpError as Error).message}`);
    }

    // Inject Gitea git credentials so agents can push to the Gitea server
    // Uses per-user credentials when available, falls back to admin (wm21)
    if (this.config.giteaUrl && this.config.giteaApiToken && this.config.giteaOwner) {
      try {
        const giteaInjectStartedAt = Date.now();
        const giteaCreds = resolveGiteaCredentials(npub, this.config);
        if (giteaCreds) {
          const dataDir = new URL("../../data", import.meta.url).pathname;
          const helperPath = ensureCredentialHelper(dataDir);
          if (helperPath) {
            const giteaEnv = getGiteaGitEnv(giteaCreds, helperPath);
            // Also inject git identity so agent commits use the correct owner name
            // (doesn't touch user's .gitconfig — scoped to this subprocess)
            const gitIdentityEnv: Record<string, string> = {
              GIT_AUTHOR_NAME: giteaCreds.owner,
              GIT_AUTHOR_EMAIL: `${giteaCreds.owner}@wingman-os.ai`,
              GIT_COMMITTER_NAME: giteaCreds.owner,
              GIT_COMMITTER_EMAIL: `${giteaCreds.owner}@wingman-os.ai`,
            };
            session.definition = {
              ...session.definition,
              env: { ...session.definition.env, ...giteaEnv, ...gitIdentityEnv },
            };
            this.appendLog(session, `[manager] Gitea credentials configured for ${giteaCreds.owner}@${this.config.giteaUrl}`);
          }
        }
        giteaInjectMs = Date.now() - giteaInjectStartedAt;
      } catch (giteaError) {
        this.appendLog(session, `[manager] Gitea credential setup failed (non-fatal): ${(giteaError as Error).message}`);
      }
    }

    try {
      const spawnStartedAt = Date.now();
      if (this.config.agentSpawnMode === "pm2") {
        await this.spawnAgentProcessViaPM2(session);
      } else {
        session.process = this.spawnAgentProcess(session);
        await this.monitorSession(session);
      }
      spawnMs = Date.now() - spawnStartedAt;
      session.status = "running";

      // Create protocol adapter for agent communication
      const adapterFactory = resolveAdapterFactory(agent);
      session.adapter = adapterFactory({
        id: session.id,
        port: session.port,
        agent: session.agent,
        host: normaliseHostForUrl(pickAgentHost(parseAllowedHosts(this.config.allowedHosts))),
        pm2Name: session.pm2Name,
      });

      this.emit({ type: "session-updated", session: this.toSnapshot(session) });
      const totalLaunchMs = Date.now() - launchStartedAt;
      console.log(
        `[manager] session ${id} (${agent}:${port}) launch timings total=${totalLaunchMs}ms ` +
          `botKey=${botKeyLookupMs}ms mcp=${mcpInjectMs}ms gitea=${giteaInjectMs}ms spawn=${spawnMs}ms`,
      );
    } catch (error) {
      session.status = "error";
      this.appendLog(session, `[manager] failed to launch session: ${(error as Error).message}`);
      this.releasePort(session.port);
      this.emit({ type: "session-updated", session: this.toSnapshot(session) });
      throw error;
    }

    // Track project for authenticated users (fire and forget)
    trackProjectForSession(npub, sessionWorkingDirectory).catch(() => {});

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

    // Derive user alias from npub
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
      process: null,
      definition,
      workingDirectory: input.workingDirectory,
      command,
      logs: sanitizedLogs,
      detachedPid: typeof input.pid === "number" ? input.pid : undefined,
      npub,
      agentRuntimeStatus: input.agentRuntimeStatus ?? undefined,
      origin: input.origin ?? undefined,
      userAlias,
      isAdmin,
      pm2Name: input.pm2Name,
      targetFile: input.targetFile,
      pinnedFile: input.pinnedFile,
      metadata: normaliseSessionMetadata(input.metadata),
    };

    // Create protocol adapter for rehydrated session
    const adapterFactory = resolveAdapterFactory(input.agent);
    session.adapter = adapterFactory({
      id: session.id,
      port: session.port,
      agent: session.agent,
      host: normaliseHostForUrl(pickAgentHost(parseAllowedHosts(this.config.allowedHosts))),
      pm2Name: session.pm2Name,
    });

    this.sessions.set(session.id, session);
    this.allocatedPorts.add(session.port);
    return this.toSnapshot(session);
  }

  async stopSession(id: string): Promise<SessionSnapshot | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;

    // Stop via PM2 if this is a PM2-managed session
    if (session.pm2Name) {
      try {
        await stopProcess(session.pm2Name);
        await deleteProcess(session.pm2Name);
        // Clean up ecosystem config
        await removeAppFromEcosystem(
          session.workingDirectory,
          session.isAdmin ?? false,
          session.pm2Name,
        );
      } catch (error) {
        this.appendLog(session, `[manager] PM2 stop error: ${(error as Error).message}`);
      }
      session.pm2Name = undefined;
      session.detachedPid = undefined;
    } else if (session.process) {
      session.process.kill("SIGTERM");
      await session.process.exited;
      session.process = null;
    } else if (typeof session.detachedPid === "number" && session.detachedPid > 0) {
      try {
        process.kill(session.detachedPid, "SIGTERM");
      } catch {
        // ignore failures when the process already exited or cannot be signalled
      }
      session.detachedPid = undefined;
    }

    // Dispose protocol adapter
    if (session.adapter) {
      session.adapter.dispose().catch(() => {});
      session.adapter = undefined;
    }

    // Clean up MCP config files created during injection
    if (session.mcpCleanupFiles && session.mcpCleanupFiles.length > 0) {
      cleanupMcpConfig(session.mcpCleanupFiles).catch(() => {});
      session.mcpCleanupFiles = undefined;
    }

    session.status = "stopped";
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

    if (session.process) {
      try {
        session.process.kill("SIGTERM");
      } catch {
        // best effort; process should already be exited
      }
      session.process = null;
    }

    // Snapshot before deleting so we can notify browsers
    const snapshot = this.toSnapshot(session);
    this.releasePort(session.port);
    this.sessions.delete(id);
    this.emit({ type: "session-deleted", session: snapshot });
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

  getAdapter(id: string): AgentAdapter | null {
    const session = this.sessions.get(id);
    return session?.adapter ?? null;
  }

  setPinnedFile(id: string, filePath: string | null): SessionSnapshot | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.pinnedFile = filePath ?? undefined;
    const snapshot = this.toSnapshot(session);
    this.emit({ type: "session-updated", session: snapshot });
    return snapshot;
  }

  private spawnAgentProcess(session: AgentSession): Bun.Subprocess {
    // Strip KEYTELEPORT_PRIVKEY from child env — agents must use their
    // per-user bot key via the bot-crypto API, never the root server key.
    const { KEYTELEPORT_PRIVKEY: _stripped, ...parentEnv } = Bun.env;
    const env = {
      ...parentEnv,
      SESSION_ID: session.id,
      SESSION_AGENT: session.agent,
      SESSION_PORT: session.port.toString(),
      SESSION_DIRECTORY: session.workingDirectory,
      SESSION_NAME: session.name,
      ...(session.definition.env ?? {}),
    };

    const proc = Bun.spawn(session.command, {
      cwd: session.workingDirectory,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (typeof proc.pid === "number" && proc.pid > 0) {
      session.detachedPid = proc.pid;
    }

    if (proc.stdout) {
      this.captureStream(proc.stdout, session, "stdout");
    }

    if (proc.stderr) {
      this.captureStream(proc.stderr, session, "stderr");
    }

    proc.exited.then((code) => {
      session.exitCode = code ?? undefined;
      session.detachedPid = undefined;
      if (session.status === "running") {
        session.status = code === 0 ? "stopped" : "error";
        this.releasePort(session.port);
        this.emit({ type: "session-stopped", session: this.toSnapshot(session) });
      }
    }).catch((error) => {
      session.exitCode = undefined;
      session.status = "error";
      this.appendLog(session, `[manager] spawn monitoring failed: ${(error as Error).message}`);
      this.releasePort(session.port);
      this.emit({ type: "session-stopped", session: this.toSnapshot(session) });
    });

    return proc;
  }

  private async spawnAgentProcessViaPM2(session: AgentSession): Promise<void> {
    const sessionConfig: SessionConfig = {
      sessionId: session.id,
      sessionName: session.name,
      agent: session.agent,
      port: session.port,
      workingDirectory: session.workingDirectory,
      userAlias: session.userAlias ?? "anonymous",
      isAdmin: session.isAdmin ?? false,
      config: this.config,
      commandOverride: session.command,
      envOverride: session.definition.env ?? {},
    };

    // Add to ecosystem config and get process name
    const { ecosystemPath, processName } = await addAppToEcosystem(sessionConfig);
    session.pm2Name = processName;

    this.appendLog(session, `[manager] starting via PM2 as ${processName}`);

    // Start the process via PM2
    await startProcessFromConfig(ecosystemPath, processName);

    // Wait for process to come online
    const proc = await waitForStatus(processName, "online", 15000);
    if (!proc) {
      throw new Error(`PM2 process ${processName} failed to start within timeout`);
    }

    // Store the PID for rehydration
    if (typeof proc.pid === "number" && proc.pid > 0) {
      session.detachedPid = proc.pid;
    }

    this.appendLog(session, `[manager] PM2 process ${processName} online (pid: ${proc.pid})`);
  }

  private async monitorSession(session: AgentSession): Promise<void> {
    // Bun.spawn returns PID synchronously — no polling needed.
    if (session.process && typeof session.process.pid === "number" && session.process.pid > 0) {
      session.detachedPid = session.process.pid;
    }
  }

  private captureStream(stream: ReadableStream<any>, session: AgentSession, label: "stdout" | "stderr") {
    const decoder = new TextDecoder();
    (async () => {
      const reader = stream.getReader();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = this.flushBuffer(buffer, session, label);
      }
      if (buffer.length > 0) {
        this.appendLog(session, `[${label}] ${buffer.trimEnd()}`);
      }
    })().catch((error) => {
      this.appendLog(session, `[manager] failed to read ${label}: ${(error as Error).message}`);
    });
  }

  private flushBuffer(buffer: string, session: AgentSession, label: string): string {
    const lines = buffer.split(/\r?\n/);
    if (lines.length === 1) {
      return buffer;
    }

    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i]?.trimEnd();
      if (line) {
        this.appendLog(session, `[${label}] ${line}`);
      }
    }

    return lines[lines.length - 1] ?? "";
  }

  private appendLog(session: AgentSession, entry: string) {
    const cleanedEntry = sanitizeLogEntry(entry);
    if (!cleanedEntry) {
      return;
    }
    session.logs.push(cleanedEntry);
    if (session.logs.length > MAX_LOG_LINES) {
      session.logs.splice(0, session.logs.length - MAX_LOG_LINES);
    }
    this.emitSessionUpdatedDebounced(session);
  }

  /** Debounce session-updated emissions from rapid log appends (200ms) */
  private emitSessionUpdatedDebounced(session: AgentSession) {
    const existing = this.logUpdateDebounce.get(session.id);
    if (existing) clearTimeout(existing);
    this.logUpdateDebounce.set(session.id, setTimeout(() => {
      this.logUpdateDebounce.delete(session.id);
      this.emit({ type: "session-updated", session: this.toSnapshot(session) });
    }, 200));
  }

  private async resolveDefaultWorkingDirectory(npubHint?: string): Promise<string> {
    const npub = normaliseNpub(npubHint ?? getAuthenticatedNpub());
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
      pid: session.process?.pid ?? session.detachedPid,
      command: session.command,
      workingDirectory: session.workingDirectory,
      exitCode: session.exitCode,
      logs: session.logs.slice(-50),
      origin: session.origin,
      userAlias: session.userAlias,
      isAdmin: session.isAdmin,
      pm2Name: session.pm2Name,
      targetFile: session.targetFile,
      pinnedFile: session.pinnedFile,
      metadata: session.metadata,
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
