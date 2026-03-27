import type { SessionSnapshot } from "../agents/process-manager";

type SessionEvent =
  | { type: "session-started"; session: SessionSnapshot }
  | { type: "session-updated"; session: SessionSnapshot }
  | { type: "session-stopped"; session: SessionSnapshot }
  | { type: "session-deleted"; session: SessionSnapshot };

interface SessionManagerLike {
  listSessions(): SessionSnapshot[];
  on(listener: (event: SessionEvent) => void): () => void;
}

interface LiveMessagePersistenceLoopOptions {
  manager: SessionManagerLike;
  syncSessionMessages: (sessionId: string, force?: boolean) => Promise<unknown[]>;
  intervalMs: number;
  initialDelayMs?: number;
  logger?: Pick<Console, "warn">;
}

const shouldPersistSession = (session: SessionSnapshot): boolean => session.status === "running";

export class LiveMessagePersistenceLoop {
  private readonly inFlight = new Set<string>();
  private readonly lastSyncAt = new Map<string, number>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private initialSweepHandle: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: LiveMessagePersistenceLoopOptions) {}

  start() {
    if (this.intervalHandle) {
      return;
    }

    this.unsubscribe = this.options.manager.on((event) => {
      if (event.type === "session-stopped" || event.type === "session-deleted") {
        this.lastSyncAt.delete(event.session.id);
        this.inFlight.delete(event.session.id);
        return;
      }
      if (event.type === "session-started") {
        this.lastSyncAt.set(event.session.id, 0);
      }
    });

    const initialDelay = Math.max(0, this.options.initialDelayMs ?? 0);
    if (initialDelay === 0) {
      void this.sweepOnce();
    } else {
      this.initialSweepHandle = setTimeout(() => {
        this.initialSweepHandle = null;
        void this.sweepOnce();
      }, initialDelay);
      this.initialSweepHandle.unref?.();
    }

    this.intervalHandle = setInterval(() => {
      void this.sweepOnce();
    }, this.options.intervalMs);
    this.intervalHandle.unref?.();
  }

  stop() {
    if (this.initialSweepHandle) {
      clearTimeout(this.initialSweepHandle);
      this.initialSweepHandle = null;
    }
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.inFlight.clear();
    this.lastSyncAt.clear();
  }

  async sweepOnce() {
    const now = Date.now();
    const dueSessions = this.options.manager
      .listSessions()
      .filter((session) => shouldPersistSession(session))
      .filter((session) => {
        const last = this.lastSyncAt.get(session.id) ?? 0;
        return now - last >= this.options.intervalMs;
      });

    await Promise.all(dueSessions.map((session) => this.syncSession(session.id)));
  }

  private async syncSession(sessionId: string) {
    if (this.inFlight.has(sessionId)) {
      return;
    }
    const session = this.options.manager.listSessions().find((entry) => entry.id === sessionId);
    if (!session || !shouldPersistSession(session)) {
      return;
    }

    this.inFlight.add(sessionId);
    this.lastSyncAt.set(sessionId, Date.now());
    try {
      await this.options.syncSessionMessages(sessionId, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn?.(`[live-message-persistence] sync failed for ${sessionId}: ${message}`);
    } finally {
      this.inFlight.delete(sessionId);
    }
  }
}

export { shouldPersistSession };
