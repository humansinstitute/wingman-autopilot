import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import type { AgentRuntimeStatus } from "../types/agent-status";
import type { SessionOrigin } from "../agents/process-manager";

export interface StoredMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
}

export interface ReplaceMessageInput {
  role: string;
  content: string;
  createdAt: string;
}

export interface SessionRecordInput {
  id: string;
  agent: string;
  startedAt: string;
  name?: string;
  npub?: string;
  port?: number;
  pid?: number;
  pm2Name?: string;
  logsDir?: string;
  workingDirectory?: string;
  command?: string[];
  runtimeStatus?: AgentRuntimeStatus | null;
  origin?: SessionOrigin | null;
}

export interface StoredSessionRecord {
  id: string;
  agent: string;
  startedAt: string;
  name: string | null;
  npub: string | null;
  port: number | null;
  pid: number | null;
  pm2Name: string | null;
  logsDir: string | null;
  workingDirectory: string | null;
  command: string | null;
  runtimeStatus: AgentRuntimeStatus | null;
  origin: SessionOrigin | null;
}

export const databaseFile = new URL("../../data/wingman.db", import.meta.url).pathname;

const parseStoredOrigin = (value: string | null): SessionOrigin | null => {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const type = typeof parsed.type === "string" ? parsed.type.trim() : "";
    const id =
      typeof parsed.id === "string"
        ? parsed.id.trim()
        : typeof parsed.id === "number"
          ? String(parsed.id)
          : "";
    if (!type || !id) {
      return null;
    }
    const origin: SessionOrigin = { type, id };
    const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
    const label = typeof parsed.label === "string" ? parsed.label.trim() : "";
    if (url) {
      origin.url = url;
    }
    if (label) {
      origin.label = label;
    }
    return origin;
  } catch {
    return null;
  }
};

export class MessageStore {
  private readonly db: Database;

  private readonly insertSession: ReturnType<MessageStore["prepareInsertSession"]>;
  private readonly deleteSession: ReturnType<MessageStore["prepareDeleteSession"]>;
  private readonly listSessionsStmt: ReturnType<MessageStore["prepareListSessions"]>;
  private readonly clearMessages: ReturnType<MessageStore["prepareClearMessages"]>;
  private readonly insertMessage: ReturnType<MessageStore["prepareInsertMessage"]>;
  private readonly listMessages: ReturnType<MessageStore["prepareListMessages"]>;
  private readonly countMessages: ReturnType<MessageStore["prepareCountMessages"]>;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.initialise();
    this.insertSession = this.prepareInsertSession();
    this.deleteSession = this.prepareDeleteSession();
    this.listSessionsStmt = this.prepareListSessions();
    this.clearMessages = this.prepareClearMessages();
    this.insertMessage = this.prepareInsertMessage();
    this.listMessages = this.prepareListMessages();
    this.countMessages = this.prepareCountMessages();
  }

  recordSession(session: SessionRecordInput) {
    this.insertSession.run(
      session.id,
      session.agent,
      session.startedAt,
      session.name ?? null,
      session.npub ?? null,
      typeof session.port === "number" ? session.port : null,
      typeof session.pid === "number" ? session.pid : null,
      session.pm2Name ?? null,
      session.logsDir ?? null,
      session.workingDirectory ?? null,
      Array.isArray(session.command) ? JSON.stringify(session.command) : null,
      session.runtimeStatus ?? null,
      session.origin ? JSON.stringify(session.origin) : null,
    );
  }

  removeSession(sessionId: string) {
    this.deleteSession.run(sessionId);
  }

  replaceMessages(sessionId: string, messages: ReplaceMessageInput[]) {
    const tx = this.db.transaction(() => {
      this.clearMessages.run(sessionId);
      for (const message of messages) {
        const role = message.role?.trim() ?? "";
        const content = message.content?.trim() ?? "";
        if (!content) {
          // Skip blank payloads.
          continue;
        }
        const createdAt = message.createdAt ?? new Date().toISOString();
        this.insertMessage.run(randomUUID(), sessionId, role || "assistant", content, createdAt);
      }
    });
    tx();
  }

  listSessionMessages(sessionId: string): StoredMessage[] {
    return this.listMessages.all(sessionId) as StoredMessage[];
  }

  hasMessages(sessionId: string): boolean {
    const row = this.countMessages.get(sessionId) as { count: number } | undefined;
    return Boolean(row?.count && row.count > 0);
  }

  getSession(sessionId: string): StoredSessionRecord | null {
    const row = this.db.query(`
      SELECT
        id,
        agent,
        started_at as startedAt,
        name,
        npub,
        port,
        pid,
        pm2_name as pm2Name,
        logs_dir as logsDir,
        working_directory as workingDirectory,
        command,
        runtime_status as runtimeStatus,
        origin
      FROM sessions
      WHERE id = ?1
    `).get(sessionId) as (Omit<StoredSessionRecord, "origin"> & { origin: string | null }) | null;

    if (!row) return null;

    return {
      ...row,
      origin: parseStoredOrigin(row.origin),
    };
  }

  listSessions(): StoredSessionRecord[] {
    const rows = this.listSessionsStmt.all() as Array<
      Omit<StoredSessionRecord, "origin"> & { origin: string | null }
    >;
    return rows.map((row) => ({
      ...row,
      origin: parseStoredOrigin(row.origin),
    }));
  }

  /**
   * Returns sessions that have port and pid stored, started within the given hours.
   * These are candidates for auto-rehydration after a restart.
   */
  listRehydrationCandidates(maxAgeHours: number = 24): StoredSessionRecord[] {
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
    const stmt = this.db.prepare(`
      SELECT
        id,
        agent,
        started_at as startedAt,
        name,
        npub,
        port,
        pid,
        pm2_name as pm2Name,
        logs_dir as logsDir,
        working_directory as workingDirectory,
        command,
        runtime_status as runtimeStatus,
        origin
      FROM sessions
      WHERE port IS NOT NULL
        AND pid IS NOT NULL
        AND started_at >= ?1
      ORDER BY started_at DESC
    `);
    const rows = stmt.all(cutoff) as Array<
      Omit<StoredSessionRecord, "origin"> & { origin: string | null }
    >;
    return rows.map((row) => ({
      ...row,
      origin: parseStoredOrigin(row.origin),
    }));
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        started_at TEXT NOT NULL,
        name TEXT,
        port INTEGER,
        pid INTEGER,
        pm2_name TEXT,
        logs_dir TEXT,
        working_directory TEXT,
        command TEXT,
        runtime_status TEXT,
        origin TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
    `);

    const sessionColumns = this.db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
    const ensureColumn = (name: string, definition: string) => {
      const exists = sessionColumns.some((column) => column.name === name);
      if (!exists) {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
      }
    };

    ensureColumn("name", "TEXT");
    ensureColumn("port", "INTEGER");
    ensureColumn("pid", "INTEGER");
    ensureColumn("pm2_name", "TEXT");
    ensureColumn("logs_dir", "TEXT");
    ensureColumn("working_directory", "TEXT");
    ensureColumn("command", "TEXT");
    ensureColumn("npub", "TEXT");
    ensureColumn("runtime_status", "TEXT");
    ensureColumn("origin", "TEXT");
  }

  private prepareInsertSession() {
    return this.db.prepare(
      `INSERT INTO sessions (id, agent, started_at, name, npub, port, pid, pm2_name, logs_dir, working_directory, command, runtime_status, origin)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
       ON CONFLICT(id) DO UPDATE SET
         agent = excluded.agent,
         started_at = excluded.started_at,
         name = excluded.name,
         npub = excluded.npub,
         port = excluded.port,
         pid = excluded.pid,
         pm2_name = excluded.pm2_name,
         logs_dir = excluded.logs_dir,
         working_directory = excluded.working_directory,
         command = excluded.command,
         runtime_status = excluded.runtime_status,
         origin = excluded.origin`,
    );
  }

  private prepareDeleteSession() {
    return this.db.prepare(`DELETE FROM sessions WHERE id = ?1`);
  }

  private prepareListSessions() {
    return this.db.prepare(
      `SELECT
         id,
         agent,
         started_at as startedAt,
         name,
         npub,
         port,
         pid,
         pm2_name as pm2Name,
         logs_dir as logsDir,
         working_directory as workingDirectory,
         command,
         runtime_status as runtimeStatus,
         origin
       FROM sessions`,
    );
  }

  private prepareClearMessages() {
    return this.db.prepare(`DELETE FROM messages WHERE session_id = ?1`);
  }

  private prepareInsertMessage() {
    return this.db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    );
  }

  private prepareListMessages() {
    return this.db.prepare(
      `SELECT id, session_id as sessionId, role, content, created_at as createdAt
       FROM messages
       WHERE session_id = ?1
       ORDER BY datetime(created_at), rowid`,
    );
  }

  private prepareCountMessages() {
    return this.db.prepare(
      `SELECT COUNT(1) as count
       FROM messages
       WHERE session_id = ?1`,
    );
  }
}

export const messageStore = new MessageStore(databaseFile);
