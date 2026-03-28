/**
 * PM2 Agent Session Cleanup
 *
 * After session rehydration, sweeps PM2 for any agent processes in the
 * "wingman-agents" namespace that were NOT reclaimed by the ProcessManager.
 * These are orphans from a previous server run that should be stopped and
 * removed so they don't hold agent ports indefinitely.
 */

import {
  listProcesses,
  stopProcess,
  deleteProcess,
  type PM2ProcessDescription,
} from "../../agents/pm2-wrapper";
import { PM2_NAMESPACE_AGENTS } from "../../agents/ecosystem-generator";
import type { ProcessManager } from "../../agents/process-manager";

export interface AgentCleanupOutcome {
  checked: number;
  cleaned: number;
  failed: number;
  timestamp: string;
}

/**
 * Stop and delete any PM2 processes in the wingman-agents namespace
 * that are not tracked by the ProcessManager.
 *
 * Call this AFTER all rehydration (warm restart + orphan reconnect) has
 * completed so we don't accidentally kill sessions that were just reclaimed.
 */
export async function cleanupOrphanedAgentProcesses(
  manager: ProcessManager,
): Promise<AgentCleanupOutcome> {
  let pm2Processes: PM2ProcessDescription[];
  try {
    pm2Processes = await listProcesses();
  } catch (error) {
    console.warn(`[pm2-cleanup] failed to list PM2 processes: ${(error as Error).message}`);
    return { checked: 0, cleaned: 0, failed: 0, timestamp: new Date().toISOString() };
  }

  // Collect PM2 names that the ProcessManager currently owns
  const activePm2Names = new Set<string>();
  for (const session of manager.listSessions()) {
    if (session.pm2Name) {
      activePm2Names.add(session.pm2Name);
    }
  }

  // Filter to agent-namespace processes not owned by the manager
  const agentProcesses = pm2Processes.filter((proc) => {
    const pm2Env = proc.pm2_env as Record<string, unknown> | undefined;
    const ns = pm2Env?.namespace;
    return ns === PM2_NAMESPACE_AGENTS;
  });

  let cleaned = 0;
  let failed = 0;

  for (const proc of agentProcesses) {
    const name = proc.name;
    if (!name || activePm2Names.has(name)) {
      continue;
    }

    const status = (proc.pm2_env as Record<string, unknown> | undefined)?.status;
    console.log(`[pm2-cleanup] removing orphaned agent process ${name} (status: ${status}, pid: ${proc.pid ?? "none"})`);

    try {
      await stopProcess(name);
    } catch {
      // May already be stopped
    }
    try {
      await deleteProcess(name);
      cleaned++;
    } catch (error) {
      console.warn(`[pm2-cleanup] failed to delete ${name}: ${(error as Error).message}`);
      failed++;
    }
  }

  const outcome: AgentCleanupOutcome = {
    checked: agentProcesses.length,
    cleaned,
    failed,
    timestamp: new Date().toISOString(),
  };

  if (cleaned > 0) {
    console.log(`[pm2-cleanup] removed ${cleaned} orphaned agent process${cleaned === 1 ? "" : "es"}`);
  }
  if (failed > 0) {
    console.warn(`[pm2-cleanup] failed to remove ${failed} orphaned agent process${failed === 1 ? "" : "es"}`);
  }

  return outcome;
}
