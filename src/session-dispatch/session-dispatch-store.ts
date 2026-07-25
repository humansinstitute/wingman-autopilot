import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export type DispatchState = "creating" | "running" | "callback_pending" | "callback_delivered" | "acknowledged" | "closed" | "failed";
export type TerminalStatus = "completed" | "failed" | "cancelled" | "stopped";

export interface SessionDispatch {
  dispatchId: string;
  workerSessionId: string;
  callbackSessionId: string | null;
  ownerNpub: string | null;
  state: DispatchState;
  prompt: string;
  promptQueuedAt: string;
  reportingContext: Record<string, unknown>;
  terminalStatus: TerminalStatus | null;
  terminalMessage: string | null;
  terminalMessageCreatedAt: string | null;
  terminalFingerprint: string | null;
  callbackPrompt: string | null;
  callbackAttemptCount: number;
  callbackQueuedAt: string | null;
  callbackAcknowledgedAt: string | null;
  closedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;

export class SessionDispatchStore {
  private db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_dispatches (
      dispatch_id TEXT PRIMARY KEY, worker_session_id TEXT NOT NULL,
      callback_session_id TEXT, owner_npub TEXT, state TEXT NOT NULL,
      prompt TEXT NOT NULL, prompt_queued_at TEXT NOT NULL,
      reporting_context_json TEXT NOT NULL DEFAULT '{}', terminal_status TEXT,
      terminal_message TEXT, terminal_message_created_at TEXT,
      terminal_fingerprint TEXT, callback_prompt TEXT,
      callback_attempt_count INTEGER NOT NULL DEFAULT 0, callback_queued_at TEXT,
      callback_acknowledged_at TEXT, closed_at TEXT, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_callback ON session_dispatches(callback_session_id, state);
    CREATE INDEX IF NOT EXISTS idx_dispatch_worker ON session_dispatches(worker_session_id, state);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_terminal ON session_dispatches(dispatch_id, terminal_fingerprint)
      WHERE terminal_fingerprint IS NOT NULL;`);
  }

  create(input: Omit<SessionDispatch, "dispatchId" | "createdAt" | "updatedAt">): SessionDispatch {
    const now = new Date().toISOString();
    const record = { ...input, dispatchId: `dispatch_${randomUUID()}`, createdAt: now, updatedAt: now };
    this.db.query(`INSERT INTO session_dispatches VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.dispatchId, record.workerSessionId, record.callbackSessionId, record.ownerNpub,
        record.state, record.prompt, record.promptQueuedAt, JSON.stringify(record.reportingContext),
        record.terminalStatus, record.terminalMessage, record.terminalMessageCreatedAt,
        record.terminalFingerprint, record.callbackPrompt, record.callbackAttemptCount,
        record.callbackQueuedAt, record.callbackAcknowledgedAt, record.closedAt, record.lastError,
        record.createdAt, record.updatedAt);
    return record;
  }

  get(id: string): SessionDispatch | null {
    const row = this.db.query("SELECT * FROM session_dispatches WHERE dispatch_id = ?").get(id) as Row | null;
    return row ? this.map(row) : null;
  }

  list(filters: { callbackSessionId?: string; state?: DispatchState; ownerNpub?: string | null } = {}): SessionDispatch[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filters.callbackSessionId) { clauses.push("callback_session_id = ?"); values.push(filters.callbackSessionId); }
    if (filters.state) { clauses.push("state = ?"); values.push(filters.state); }
    if (filters.ownerNpub !== undefined) { clauses.push("owner_npub IS ?"); values.push(filters.ownerNpub); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.query(`SELECT * FROM session_dispatches${where} ORDER BY created_at DESC`).all(...values as any[]) as Row[]).map((row) => this.map(row));
  }

  update(id: string, patch: Partial<SessionDispatch>): SessionDispatch {
    const current = this.get(id);
    if (!current) throw new Error(`Dispatch not found: ${id}`);
    const next = { ...current, ...patch, dispatchId: id, updatedAt: new Date().toISOString() };
    this.db.query(`UPDATE session_dispatches SET state=?, terminal_status=?, terminal_message=?,
      terminal_message_created_at=?, terminal_fingerprint=?, callback_prompt=?, callback_attempt_count=?,
      callback_queued_at=?, callback_acknowledged_at=?, closed_at=?, last_error=?, updated_at=? WHERE dispatch_id=?`)
      .run(next.state, next.terminalStatus, next.terminalMessage, next.terminalMessageCreatedAt,
        next.terminalFingerprint, next.callbackPrompt, next.callbackAttemptCount, next.callbackQueuedAt,
        next.callbackAcknowledgedAt, next.closedAt, next.lastError, next.updatedAt, id);
    return next;
  }

  private map(row: Row): SessionDispatch {
    return {
      dispatchId: String(row.dispatch_id), workerSessionId: String(row.worker_session_id),
      callbackSessionId: row.callback_session_id as string | null, ownerNpub: row.owner_npub as string | null,
      state: row.state as DispatchState, prompt: String(row.prompt), promptQueuedAt: String(row.prompt_queued_at),
      reportingContext: JSON.parse(String(row.reporting_context_json || "{}")),
      terminalStatus: row.terminal_status as TerminalStatus | null, terminalMessage: row.terminal_message as string | null,
      terminalMessageCreatedAt: row.terminal_message_created_at as string | null,
      terminalFingerprint: row.terminal_fingerprint as string | null, callbackPrompt: row.callback_prompt as string | null,
      callbackAttemptCount: Number(row.callback_attempt_count), callbackQueuedAt: row.callback_queued_at as string | null,
      callbackAcknowledgedAt: row.callback_acknowledged_at as string | null, closedAt: row.closed_at as string | null,
      lastError: row.last_error as string | null, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }
}
