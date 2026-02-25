import { buildAgentUrl } from "./agent-client";
import type { ProcessManager, SessionSnapshot } from "./process-manager";
import { isAgentRuntimeStatus, type AgentRuntimeStatus } from "../types/agent-status";
import { getProcessByName } from "./pm2-wrapper";

interface AgentStatusPollerOptions {
  host: string;
  intervalMs: number;
  maxIntervalMs: number;
  timeoutMs: number;
  /** Delay before first poll for new sessions (avoids overlap with session-readiness polling). Default: 0 */
  initialDelayMs?: number;
}

interface PollState {
  port: number;
  timer: ReturnType<typeof setTimeout> | null;
  nextIntervalMs: number;
  consecutiveFailures: number;
  errorLogged: boolean;
  unknownStaleCheckLogged: boolean;
}

const MAX_CONSECUTIVE_FAILURES_BEFORE_STALE_STOP = 8;

type DeadSessionVerdict = "alive" | "dead" | "unknown";

const isPidAlive = (pid: number | null | undefined): boolean => {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    return nodeError?.code === "EPERM";
  }
};

export class AgentRuntimeStatusPoller {
  private readonly watchers = new Map<string, PollState>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly manager: ProcessManager,
    private readonly options: AgentStatusPollerOptions,
  ) {}

  start() {
    if (this.unsubscribe) {
      return;
    }

    for (const session of this.manager.listSessions()) {
      this.syncWatcherForSession(session);
    }

    this.unsubscribe = this.manager.on((event) => {
      this.syncWatcherForSession(event.session);
      if (event.type === "session-stopped") {
        this.stopWatcher(event.session.id);
      }
    });
  }

  stop() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    for (const [sessionId, state] of this.watchers.entries()) {
      this.clearTimer(state);
      this.watchers.delete(sessionId);
    }
  }

  private syncWatcherForSession(session: SessionSnapshot) {
    if (session.status === "running") {
      this.startWatcher(session);
    } else if (session.status === "stopped" || session.status === "error") {
      this.stopWatcher(session.id);
    }
  }

  private startWatcher(session: SessionSnapshot) {
    if (this.watchers.has(session.id)) {
      return;
    }

    const state: PollState = {
      port: session.port,
      timer: null,
      nextIntervalMs: this.options.intervalMs,
      consecutiveFailures: 0,
      errorLogged: false,
      unknownStaleCheckLogged: false,
    };

    this.watchers.set(session.id, state);
    this.schedulePoll(session.id, state, this.options.initialDelayMs ?? 0);
  }

  private stopWatcher(sessionId: string) {
    const state = this.watchers.get(sessionId);
    if (!state) {
      return;
    }
    this.clearTimer(state);
    this.watchers.delete(sessionId);
  }

  private clearTimer(state: PollState) {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private schedulePoll(sessionId: string, state: PollState, delay: number) {
    this.clearTimer(state);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.executePoll(sessionId, state);
    }, delay);
  }

  private async executePoll(sessionId: string, state: PollState) {
    try {
      const status = await this.fetchAgentStatus(state.port);
      this.manager.setAgentRuntimeStatus(sessionId, status);
      state.consecutiveFailures = 0;
      state.errorLogged = false;
      state.unknownStaleCheckLogged = false;
      state.nextIntervalMs = this.options.intervalMs;
    } catch (error) {
      state.consecutiveFailures += 1;
      this.manager.setAgentRuntimeStatus(sessionId, null);
      state.nextIntervalMs = Math.min(
        this.options.maxIntervalMs,
        Math.max(
          this.options.intervalMs,
          this.options.intervalMs * 2 ** Math.min(state.consecutiveFailures, 6),
        ),
      );
      if (!state.errorLogged) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[agent-status] polling ${sessionId} failed: ${reason}`);
        state.errorLogged = true;
      }

      if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES_BEFORE_STALE_STOP) {
        const verdict = await this.classifyDeadSession(sessionId);
        if (verdict === "dead") {
          console.warn(`[agent-status] stopping stale session ${sessionId} after repeated status failures`);
          await this.manager.stopSession(sessionId);
          this.stopWatcher(sessionId);
          return;
        }
        if (verdict === "unknown" && !state.unknownStaleCheckLogged) {
          console.warn(
            `[agent-status] stale-session check inconclusive for ${sessionId}; leaving session running`,
          );
          state.unknownStaleCheckLogged = true;
        }
        if (verdict === "alive") {
          state.unknownStaleCheckLogged = false;
        }
      }
    } finally {
      if (this.watchers.has(sessionId)) {
        this.schedulePoll(sessionId, state, state.nextIntervalMs);
      }
    }
  }

  private async classifyDeadSession(sessionId: string): Promise<DeadSessionVerdict> {
    const session = this.manager.getSession(sessionId);
    if (!session || session.status !== "running") {
      return "dead";
    }

    if (session.pm2Name) {
      let proc: Awaited<ReturnType<typeof getProcessByName>> = null;
      try {
        proc = await getProcessByName(session.pm2Name);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[agent-status] PM2 lookup failed for ${sessionId}: ${reason}`);
        return "unknown";
      }
      if (!proc) {
        return "dead";
      }
      const pm2Status = proc?.pm2_env?.status;
      if (typeof pm2Status !== "string") {
        return "unknown";
      }
      if (pm2Status === "online" || pm2Status === "launching") {
        return "alive";
      }
      return "dead";
    }

    if (typeof session.pid !== "number" || session.pid <= 0) {
      return "unknown";
    }
    return isPidAlive(session.pid) ? "alive" : "dead";
  }

  private async fetchAgentStatus(port: number): Promise<AgentRuntimeStatus | null> {
    const url = buildAgentUrl(this.options.host, port, "/status");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`status request failed (${response.status})`);
      }
      const payload = await response.json().catch(() => null);
      if (!payload || typeof payload !== "object") {
        return null;
      }
      const data = payload as Record<string, unknown>;
      const statusValue = data.status;
      return isAgentRuntimeStatus(statusValue) ? statusValue : null;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("status request timed out");
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
