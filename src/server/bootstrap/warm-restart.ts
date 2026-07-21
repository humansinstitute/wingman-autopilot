import { readFile, rm, writeFile } from "node:fs/promises";
import type { ProcessManager } from "../../agents/process-manager";
import type { MessageStore } from "../../storage/message-store";
import { isAgentRuntimeStatus } from "../../types/agent-status";
import type { AgentType } from "../../config";
import { waitForAgentReady as waitForAgentReadyCore } from "../../agents/agent-client";
import { hasTmuxWindow } from "../../agents/tmux-wrapper";
import {
  resolveNativeResumeLaunch,
  type NativeResumeSourceSession,
} from "../../sessions/native-resume-launch";

export type WarmRestartMarker = {
  createdAt: string;
  sessionIds?: string[];
  reason?: string;
  version?: number;
  mode?: "preserve" | "native-resume";
  requestedBy?: string | null;
  status?: string;
  message?: string;
};

export interface WarmRestartOutcome {
  restored: number;
  failed: string[];
  timestamp: string;
  mode?: "preserve" | "native-resume";
  resumedSessions?: Array<{ sourceSessionId: string; sessionId: string }>;
}

export const warmRestartState = {
  inProgress: false,
  marker: null as WarmRestartMarker | null,
};

export const warmRestartOutcome: { current: WarmRestartOutcome | null } = { current: null };

export const readStreamToString = async (
  stream: ReadableStream<Uint8Array> | number | null | undefined,
): Promise<string> => {
  if (!stream || typeof stream === "number") return "";
  return new Response(stream).text();
};

export const loadWarmRestartMarker = async (filePath: string): Promise<WarmRestartMarker | null> => {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as WarmRestartMarker;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === "ENOENT") {
      return null;
    }
    console.warn(`[restart] failed to read marker at ${filePath}: ${nodeError?.message ?? error}`);
    return null;
  }
};

export const clearWarmRestartMarker = async (filePath: string) => {
  try {
    await rm(filePath, { force: true });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code && nodeError.code !== "ENOENT") {
      console.warn(`[restart] failed to remove marker ${filePath}: ${nodeError.message}`);
    }
  }
};

export const writeWarmRestartMarker = async (filePath: string, marker: WarmRestartMarker) => {
  const payload = JSON.stringify(marker, null, 2);
  await writeFile(filePath, `${payload}\n`, "utf8");
};

export const parseStoredCommand = (value: string | null): string[] | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed.every((entry) => typeof entry === "string") ? (parsed as string[]) : undefined) : undefined;
  } catch {
    return undefined;
  }
};

export const isProcessAlive = (pid: number | null | undefined): boolean => {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === "EPERM") {
      return true;
    }
    return false;
  }
};

export const rehydrateWarmSessions = async (
  marker: WarmRestartMarker | null,
  markerPath: string,
  agentHost: string,
  manager: ProcessManager,
  ensureUserWorkspace: (npub: string | null) => string,
  defaultWorkingDirectory: string,
  store: MessageStore,
  allowedAgents: AgentType[],
) => {
  if (!marker || marker.mode === "native-resume") {
    return;
  }

  // If the marker explicitly lists session IDs, only restore those.
  // An empty array means nothing to restore (e.g. failed restart with no live sessions).
  if (marker.sessionIds && marker.sessionIds.length === 0) {
    await clearWarmRestartMarker(markerPath);
    return;
  }
  const targetIds = marker.sessionIds && marker.sessionIds.length > 0 ? new Set(marker.sessionIds) : null;
  const storedSessions = store.listSessions();
  let restored = 0;
  const failed: string[] = [];

  for (const record of storedSessions) {
    if (targetIds && !targetIds.has(record.id)) {
      continue;
    }

    if (!record.id || typeof record.id !== "string") {
      continue;
    }

    const agentName = typeof record.agent === "string" ? record.agent.toLowerCase() : "";
    if (!allowedAgents.includes(agentName as AgentType)) {
      failed.push(record.id);
      continue;
    }

    const port = typeof record.port === "number" && Number.isFinite(record.port) ? record.port : null;
    if (!port) {
      failed.push(record.id);
      continue;
    }

    const storedPid = typeof record.pid === "number" ? record.pid : null;
    const tmuxSession = record.tmuxSession ?? null;
    const tmuxWindow = record.tmuxWindow ?? null;
    if (tmuxSession && tmuxWindow) {
      const tmuxExists = await hasTmuxWindow(tmuxSession, tmuxWindow).catch(() => false);
      if (!tmuxExists) {
        console.warn(`[restart] tmux window ${tmuxSession}:${tmuxWindow} for session ${record.id} is not present; skipping rehydration`);
        failed.push(record.id);
        continue;
      }
    } else if (storedPid && !isProcessAlive(storedPid)) {
      console.warn(`[restart] stored pid ${storedPid} for session ${record.id} is not running; skipping rehydration`);
      failed.push(record.id);
      continue;
    }

    try {
      await waitForAgentReadyCore(agentHost, port, agentName as AgentType, {
        timeoutMs: 5000,
        pollIntervalMs: 250,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[restart] agent for session ${record.id} not reachable: ${message}`);
      failed.push(record.id);
      continue;
    }

    const command = parseStoredCommand(record.command);
    const snapshot = manager.rehydrateSession({
      id: record.id,
      agent: agentName as AgentType,
      port,
      name: record.name ?? record.id,
      startedAt: record.startedAt,
      workingDirectory: record.workingDirectory ?? defaultWorkingDirectory,
      command,
      pid: storedPid ?? undefined,
      logs: undefined,
      npub: record.npub ?? undefined,
      agentRuntimeStatus: isAgentRuntimeStatus(record.runtimeStatus) ? record.runtimeStatus : null,
      origin: record.origin ?? null,
      pm2Name: record.pm2Name ?? undefined,
      tmuxSession: record.tmuxSession ?? undefined,
      tmuxWindow: record.tmuxWindow ?? undefined,
      targetFile: record.targetFile ?? undefined,
      metadata: record.metadata,
    });

    if (!snapshot) {
      failed.push(record.id);
      continue;
    }

    ensureUserWorkspace(snapshot.npub ?? null);
    if (isAgentRuntimeStatus(record.runtimeStatus)) {
      manager.setAgentRuntimeStatus(snapshot.id, record.runtimeStatus);
    }
    store.recordSession({
      id: snapshot.id,
      agent: snapshot.agent,
      startedAt: snapshot.startedAt,
      name: snapshot.name,
      npub: snapshot.npub,
      port: snapshot.port,
      pid: snapshot.pid,
      workingDirectory: snapshot.workingDirectory,
      command: snapshot.command,
      runtimeStatus: snapshot.agentRuntimeStatus ?? null,
      origin: snapshot.origin ?? null,
      pm2Name: record.pm2Name ?? undefined,
      tmuxSession: record.tmuxSession ?? undefined,
      tmuxWindow: record.tmuxWindow ?? undefined,
      metadata: snapshot.metadata,
    });
    restored += 1;
  }

  warmRestartOutcome.current = {
    restored,
    failed,
    timestamp: new Date().toISOString(),
    mode: "preserve",
  };
  warmRestartState.marker = null;

  if (restored > 0) {
    console.log(`[restart] rehydrated ${restored} session${restored === 1 ? "" : "s"} from previous run`);
  }
  if (failed.length > 0) {
    console.warn(
      `[restart] failed to rehydrate ${failed.length} session${failed.length === 1 ? "" : "s"}: ${failed.join(", ")}`,
    );
  }

  await clearWarmRestartMarker(markerPath);
};

export const resumeStoppedNativeSessions = async (
  marker: WarmRestartMarker | null,
  markerPath: string,
  manager: ProcessManager,
  store: MessageStore,
  allowedAgents: AgentType[],
): Promise<WarmRestartOutcome | null> => {
  if (!marker || marker.mode !== "native-resume") return null;

  const targetIds = Array.isArray(marker.sessionIds) ? marker.sessionIds : [];
  const recordsById = new Map(store.listSessions().map((record) => [record.id, record]));
  const failed: string[] = [];
  const resumedSessions: Array<{ sourceSessionId: string; sessionId: string }> = [];
  const isAgentType = (agent: string): agent is AgentType => allowedAgents.includes(agent as AgentType);

  for (const sourceSessionId of targetIds) {
    const source = recordsById.get(sourceSessionId) as NativeResumeSourceSession | undefined;
    if (!source) {
      failed.push(sourceSessionId);
      continue;
    }
    try {
      const launch = resolveNativeResumeLaunch(source, isAgentType, marker.requestedBy);
      const session = await manager.createSession(
        launch.agent,
        launch.workingDirectory,
        launch.name,
        launch.origin,
        undefined,
        launch.ownerNpub,
        launch.metadata,
      );
      resumedSessions.push({ sourceSessionId, sessionId: session.id });
    } catch (error) {
      console.warn(
        `[restart] failed to native-resume session ${sourceSessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      failed.push(sourceSessionId);
    }
  }

  const outcome: WarmRestartOutcome = {
    restored: resumedSessions.length,
    failed,
    timestamp: new Date().toISOString(),
    mode: "native-resume",
    resumedSessions,
  };
  warmRestartOutcome.current = outcome;
  warmRestartState.marker = null;
  await clearWarmRestartMarker(markerPath);
  console.log(
    `[restart] native-resumed ${outcome.restored} of ${targetIds.length} stopped session${targetIds.length === 1 ? "" : "s"}`,
  );
  return outcome;
};

export interface OrphanedSessionsOutcome {
  restored: number;
  checked: number;
  timestamp: string;
}

export const orphanedSessionsOutcome: { current: OrphanedSessionsOutcome | null } = { current: null };

/**
 * Attempts to reconnect to orphaned agent sessions that are still running.
 * This runs on every startup and looks for sessions in the database that:
 * - Have port and pid stored
 * - Are not already loaded in memory
 * - Have a process still alive at the stored PID
 * - Have an agent still responding at the stored port
 */
export const rehydrateOrphanedSessions = async (
  agentHost: string,
  manager: ProcessManager,
  ensureUserWorkspace: (npub: string | null) => string,
  defaultWorkingDirectory: string,
  store: MessageStore,
  allowedAgents: AgentType[],
  maxAgeHours: number = 24,
): Promise<OrphanedSessionsOutcome> => {
  const candidates = store.listRehydrationCandidates(maxAgeHours);
  const existingSessions = new Set(manager.listSessions().map((s) => s.id));

  let restored = 0;
  let checked = 0;

  for (const record of candidates) {
    // Skip sessions already in memory (from warm restart or already running)
    if (existingSessions.has(record.id)) {
      continue;
    }

    if (!record.id || typeof record.id !== "string") {
      continue;
    }

    const agentName = typeof record.agent === "string" ? record.agent.toLowerCase() : "";
    if (!allowedAgents.includes(agentName as AgentType)) {
      continue;
    }

    const port = typeof record.port === "number" && Number.isFinite(record.port) ? record.port : null;
    if (!port) {
      continue;
    }

    const storedPid = typeof record.pid === "number" ? record.pid : null;
    const tmuxSession = record.tmuxSession ?? null;
    const tmuxWindow = record.tmuxWindow ?? null;
    if (!storedPid && (!tmuxSession || !tmuxWindow)) {
      continue;
    }

    checked += 1;

    if (tmuxSession && tmuxWindow) {
      const tmuxExists = await hasTmuxWindow(tmuxSession, tmuxWindow).catch(() => false);
      if (!tmuxExists) {
        continue;
      }
    } else {
      // First check: is the process still alive?
      if (!isProcessAlive(storedPid)) {
        continue;
      }
    }

    // Second check: is the agent responding?
    try {
      await waitForAgentReadyCore(agentHost, port, agentName as AgentType, {
        timeoutMs: 3000,
        pollIntervalMs: 200,
      });
    } catch {
      // Agent not responding, skip this session
      continue;
    }

    // Both checks passed - rehydrate the session
    const command = parseStoredCommand(record.command);
    const snapshot = manager.rehydrateSession({
      id: record.id,
      agent: agentName as AgentType,
      port,
      name: record.name ?? record.id,
      startedAt: record.startedAt,
      workingDirectory: record.workingDirectory ?? defaultWorkingDirectory,
      command,
      pid: storedPid ?? undefined,
      logs: undefined,
      npub: record.npub ?? undefined,
      agentRuntimeStatus: isAgentRuntimeStatus(record.runtimeStatus) ? record.runtimeStatus : null,
      origin: record.origin ?? null,
      pm2Name: record.pm2Name ?? undefined,
      tmuxSession: record.tmuxSession ?? undefined,
      tmuxWindow: record.tmuxWindow ?? undefined,
      targetFile: record.targetFile ?? undefined,
      metadata: record.metadata,
    });

    if (!snapshot) {
      continue;
    }

    ensureUserWorkspace(snapshot.npub ?? null);
    if (isAgentRuntimeStatus(record.runtimeStatus)) {
      manager.setAgentRuntimeStatus(snapshot.id, record.runtimeStatus);
    }
    store.recordSession({
      id: snapshot.id,
      agent: snapshot.agent,
      startedAt: snapshot.startedAt,
      name: snapshot.name,
      npub: snapshot.npub,
      port: snapshot.port,
      pid: snapshot.pid,
      workingDirectory: snapshot.workingDirectory,
      command: snapshot.command,
      runtimeStatus: snapshot.agentRuntimeStatus ?? null,
      origin: snapshot.origin ?? null,
      pm2Name: record.pm2Name ?? undefined,
      tmuxSession: record.tmuxSession ?? undefined,
      tmuxWindow: record.tmuxWindow ?? undefined,
      metadata: snapshot.metadata,
    });

    console.log(`[orphan] reconnected to session ${record.id} (${agentName} on port ${port})`);
    restored += 1;
  }

  const outcome: OrphanedSessionsOutcome = {
    restored,
    checked,
    timestamp: new Date().toISOString(),
  };
  orphanedSessionsOutcome.current = outcome;

  if (restored > 0) {
    console.log(`[orphan] reconnected to ${restored} orphaned session${restored === 1 ? "" : "s"}`);
  } else if (checked > 0) {
    console.log(`[orphan] checked ${checked} candidate session${checked === 1 ? "" : "s"}, none still running`);
  }

  return outcome;
};
