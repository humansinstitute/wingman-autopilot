/**
 * PM2 Reconciliation Module
 *
 * On server startup, reconciles PM2 running processes with SQLite session records.
 * PM2 is the source of truth for runtime state (running/stopped).
 * SQLite is the source of truth for metadata (name, user, origin).
 */

import type { ProcessManager, RehydrateSessionInput } from "../../agents/process-manager";
import type { MessageStore, StoredSessionRecord } from "../../storage/message-store";
import { listProcesses, type PM2ProcessDescription } from "../../agents/pm2-wrapper";
import { isAgentRuntimeStatus } from "../../types/agent-status";
import type { AgentType } from "../../config";

export interface ReconcileOutcome {
  rehydrated: number;
  markedStopped: number;
  orphanedPM2: number;
  timestamp: string;
}

export const reconcileOutcome: { current: ReconcileOutcome | null } = { current: null };

/**
 * Parse stored command JSON back to string array.
 */
function parseStoredCommand(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      return parsed as string[];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract session ID from PM2 process environment.
 */
function getSessionIdFromPM2(proc: PM2ProcessDescription): string | null {
  // PM2 stores custom env vars directly on pm2_env (typed as Pm2Env)
  const pm2Env = proc.pm2_env as Record<string, unknown> | undefined;
  const sessionId = pm2Env?.SESSION_ID;
  return typeof sessionId === "string" ? sessionId : null;
}

/**
 * Reconcile PM2 processes with SQLite session records.
 *
 * Algorithm:
 * 1. Get all PM2 processes
 * 2. Get all SQLite session records
 * 3. For each PM2 process with a SESSION_ID env var:
 *    - Find matching SQLite record
 *    - If found and PM2 is online, rehydrate to ProcessManager
 *    - If found and PM2 is stopped/errored, update SQLite status
 * 4. For each SQLite record not in PM2:
 *    - Mark as stopped (process no longer exists)
 */
export async function reconcileSessionsWithPM2(
  manager: ProcessManager,
  store: MessageStore,
  allowedAgents: AgentType[],
  defaultWorkingDirectory: string,
): Promise<ReconcileOutcome> {
  let rehydrated = 0;
  let markedStopped = 0;
  let orphanedPM2 = 0;

  // Get current PM2 state
  let pm2Processes: PM2ProcessDescription[] = [];
  try {
    pm2Processes = await listProcesses();
  } catch (error) {
    console.warn(`[pm2-reconcile] failed to list PM2 processes: ${(error as Error).message}`);
    return {
      rehydrated: 0,
      markedStopped: 0,
      orphanedPM2: 0,
      timestamp: new Date().toISOString(),
    };
  }

  // Get stored sessions from SQLite
  const storedSessions = store.listSessions();
  const storedById = new Map<string, StoredSessionRecord>();
  for (const session of storedSessions) {
    storedById.set(session.id, session);
  }

  // Track which SQLite sessions have matching PM2 processes
  const reconciledSessionIds = new Set<string>();

  // Process each PM2 entry
  for (const proc of pm2Processes) {
    const sessionId = getSessionIdFromPM2(proc);
    if (!sessionId) {
      // PM2 process without SESSION_ID - could be external process
      continue;
    }

    const storedRecord = storedById.get(sessionId);
    if (!storedRecord) {
      // PM2 process exists but no SQLite record - orphaned
      console.warn(`[pm2-reconcile] PM2 process ${proc.name} has session ${sessionId} but no SQLite record`);
      orphanedPM2++;
      continue;
    }

    reconciledSessionIds.add(sessionId);

    const pm2Status = proc.pm2_env?.status;
    const agentName = storedRecord.agent?.toLowerCase() as AgentType;

    // Validate agent type
    if (!allowedAgents.includes(agentName)) {
      console.warn(`[pm2-reconcile] session ${sessionId} has unsupported agent type: ${agentName}`);
      continue;
    }

    // If PM2 shows process as online, rehydrate to ProcessManager
    if (pm2Status === "online") {
      const port = storedRecord.port;
      if (!port || port <= 0) {
        console.warn(`[pm2-reconcile] session ${sessionId} has invalid port: ${port}`);
        continue;
      }

      const rehydrateInput: RehydrateSessionInput = {
        id: sessionId,
        agent: agentName,
        port,
        name: storedRecord.name ?? sessionId,
        startedAt: storedRecord.startedAt,
        workingDirectory: storedRecord.workingDirectory ?? defaultWorkingDirectory,
        command: parseStoredCommand(storedRecord.command),
        pm2Name: proc.name ?? storedRecord.pm2Name ?? undefined,
        logsDir: storedRecord.logsDir ?? undefined,
        pid: proc.pid ?? storedRecord.pid ?? undefined,
        logs: undefined,
        npub: storedRecord.npub ?? undefined,
        agentRuntimeStatus: isAgentRuntimeStatus(storedRecord.runtimeStatus)
          ? storedRecord.runtimeStatus
          : null,
        origin: storedRecord.origin ?? null,
      };

      const snapshot = manager.rehydrateSession(rehydrateInput);
      if (snapshot) {
        console.log(`[pm2-reconcile] rehydrated session ${sessionId} (PM2: ${proc.name}, port: ${port})`);

        // Update SQLite with current PM2 state
        store.recordSession({
          id: snapshot.id,
          agent: snapshot.agent,
          startedAt: snapshot.startedAt,
          name: snapshot.name,
          npub: snapshot.npub,
          port: snapshot.port,
          pid: snapshot.pid,
          pm2Name: snapshot.pm2Name,
          logsDir: snapshot.logsDir,
          workingDirectory: snapshot.workingDirectory,
          command: snapshot.command,
          runtimeStatus: snapshot.agentRuntimeStatus ?? null,
          origin: snapshot.origin ?? null,
        });

        rehydrated++;
      }
    } else {
      // PM2 shows stopped/errored - process died
      console.log(`[pm2-reconcile] session ${sessionId} PM2 status is ${pm2Status}, marking stopped`);
      markedStopped++;
    }
  }

  // Check for SQLite sessions not in PM2 (process disappeared)
  for (const storedRecord of storedSessions) {
    if (!reconciledSessionIds.has(storedRecord.id)) {
      // This session has no corresponding PM2 process
      // It's either been stopped or the process crashed
      console.log(`[pm2-reconcile] session ${storedRecord.id} has no PM2 process, treating as stopped`);
      markedStopped++;
    }
  }

  const outcome: ReconcileOutcome = {
    rehydrated,
    markedStopped,
    orphanedPM2,
    timestamp: new Date().toISOString(),
  };

  reconcileOutcome.current = outcome;

  if (rehydrated > 0) {
    console.log(`[pm2-reconcile] rehydrated ${rehydrated} session(s) from PM2`);
  }
  if (markedStopped > 0) {
    console.log(`[pm2-reconcile] ${markedStopped} session(s) marked as stopped (no PM2 process)`);
  }
  if (orphanedPM2 > 0) {
    console.warn(`[pm2-reconcile] ${orphanedPM2} orphaned PM2 process(es) found`);
  }

  return outcome;
}
