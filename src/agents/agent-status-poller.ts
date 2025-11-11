import { buildAgentUrl } from "./agent-client";
import type { ProcessManager, SessionSnapshot } from "./process-manager";
import { isAgentRuntimeStatus, type AgentRuntimeStatus } from "../types/agent-status";

interface AgentStatusPollerOptions {
  host: string;
  intervalMs: number;
  maxIntervalMs: number;
  timeoutMs: number;
}

interface PollState {
  port: number;
  timer: ReturnType<typeof setTimeout> | null;
  nextIntervalMs: number;
  consecutiveFailures: number;
  errorLogged: boolean;
}

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
    };

    this.watchers.set(session.id, state);
    this.schedulePoll(session.id, state, 0);
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
      state.nextIntervalMs = this.options.intervalMs;
    } catch (error) {
      state.consecutiveFailures += 1;
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
    } finally {
      if (this.watchers.has(sessionId)) {
        this.schedulePoll(sessionId, state, state.nextIntervalMs);
      }
    }
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
