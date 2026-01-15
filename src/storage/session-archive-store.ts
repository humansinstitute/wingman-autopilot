import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import type { AgentRuntimeStatus } from "../types/agent-status";
import type { SessionOrigin } from "../agents/process-manager";

export interface ArchivedSession {
  id: string;
  agent: string;
  name: string | null;
  npub: string | null;
  workingDirectory: string | null;
  startedAt: string;
  archivedAt: string;
  messageCount: number;
  origin: SessionOrigin | null;
}

export interface ArchivedMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
}

export interface ArchiveSessionInput {
  id: string;
  agent: string;
  name: string | null;
  npub: string | null;
  workingDirectory: string | null;
  startedAt: string;
  origin: SessionOrigin | null;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    createdAt: string;
  }>;
}

export interface ArchiveListOptions {
  limit?: number;
  offset?: number;
  filter?: string;
}

const DEFAULT_DB_PATH = new URL("../../data/session-archive.db", import.meta.url).pathname;

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

const wildcardToSqlLike = (pattern: string): string => {
  // Convert wildcard pattern to SQL LIKE pattern
  // * -> % (match any characters)
  // ? -> _ (match single character)
  return pattern
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .replace(/\*/g, "%")
    .replace(/\?/g, "_");
};

class SessionArchiveStore {
  private readonly db: Database;

  constructor(filePath: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.initialise();
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS archived_sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        name TEXT,
        npub TEXT,
        working_directory TEXT,
        started_at TEXT NOT NULL,
        archived_at TEXT NOT NULL,
        origin TEXT
      );

      CREATE TABLE IF NOT EXISTS archived_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES archived_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_archived_sessions_date ON archived_sessions(archived_at DESC);
      CREATE INDEX IF NOT EXISTS idx_archived_messages_session ON archived_messages(session_id, created_at);
    `);
  }

  archiveSession(input: ArchiveSessionInput): void {
    const archivedAt = new Date().toISOString();

    const tx = this.db.transaction(() => {
      // Insert archived session
      this.db.run(
        `INSERT OR REPLACE INTO archived_sessions
         (id, agent, name, npub, working_directory, started_at, archived_at, origin)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        [
          input.id,
          input.agent,
          input.name,
          input.npub,
          input.workingDirectory,
          input.startedAt,
          archivedAt,
          input.origin ? JSON.stringify(input.origin) : null,
        ]
      );

      // Clear any existing messages for this session (in case of re-archive)
      this.db.run(`DELETE FROM archived_messages WHERE session_id = ?1`, [input.id]);

      // Insert archived messages
      const insertMsg = this.db.prepare(
        `INSERT INTO archived_messages (id, session_id, role, content, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      );
      for (const msg of input.messages) {
        insertMsg.run(msg.id, input.id, msg.role, msg.content, msg.createdAt);
      }
    });

    tx();
    console.log(`[archive] Archived session ${input.id} with ${input.messages.length} messages`);
  }

  listArchivedSessions(options: ArchiveListOptions = {}): ArchivedSession[] {
    const limit = Math.min(Math.max(1, options.limit ?? 50), 200);
    const offset = Math.max(0, options.offset ?? 0);
    const filter = options.filter?.trim() ?? "";

    let query = `
      SELECT
        s.id,
        s.agent,
        s.name,
        s.npub,
        s.working_directory as workingDirectory,
        s.started_at as startedAt,
        s.archived_at as archivedAt,
        s.origin,
        (SELECT COUNT(1) FROM archived_messages m WHERE m.session_id = s.id) as messageCount
      FROM archived_sessions s
    `;

    const params: (string | number)[] = [];

    if (filter) {
      const likePattern = wildcardToSqlLike(filter);
      query += ` WHERE (s.name LIKE ?1 ESCAPE '\\' OR s.working_directory LIKE ?1 ESCAPE '\\')`;
      params.push(`%${likePattern}%`);
    }

    query += ` ORDER BY s.archived_at DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;
    params.push(limit, offset);

    const rows = this.db.query(query).all(...params) as Array<
      Omit<ArchivedSession, "origin"> & { origin: string | null }
    >;

    return rows.map((row) => ({
      ...row,
      origin: parseStoredOrigin(row.origin),
    }));
  }

  getArchivedSession(sessionId: string): ArchivedSession | null {
    const row = this.db.query(`
      SELECT
        s.id,
        s.agent,
        s.name,
        s.npub,
        s.working_directory as workingDirectory,
        s.started_at as startedAt,
        s.archived_at as archivedAt,
        s.origin,
        (SELECT COUNT(1) FROM archived_messages m WHERE m.session_id = s.id) as messageCount
      FROM archived_sessions s
      WHERE s.id = ?1
    `).get(sessionId) as (Omit<ArchivedSession, "origin"> & { origin: string | null }) | null;

    if (!row) return null;

    return {
      ...row,
      origin: parseStoredOrigin(row.origin),
    };
  }

  getArchivedMessages(sessionId: string): ArchivedMessage[] {
    return this.db.query(`
      SELECT id, session_id as sessionId, role, content, created_at as createdAt
      FROM archived_messages
      WHERE session_id = ?1
      ORDER BY datetime(created_at), rowid
    `).all(sessionId) as ArchivedMessage[];
  }

  deleteArchivedSession(sessionId: string): boolean {
    const result = this.db.run(
      `DELETE FROM archived_sessions WHERE id = ?1`,
      [sessionId]
    );
    return result.changes > 0;
  }

  getArchiveCount(): number {
    const row = this.db.query(`SELECT COUNT(1) as count FROM archived_sessions`).get() as { count: number };
    return row?.count ?? 0;
  }
}

export const sessionArchiveStore = new SessionArchiveStore();
