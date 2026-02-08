/**
 * Night Watch Store
 *
 * SQLite store for Night Watchman session state, report cards, and global config.
 * Follows the CaproverStore pattern — shares the main wingman.db database.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "../storage/message-store";

// ============================================================
// Types
// ============================================================

export interface NightWatchSessionState {
  sessionId: string;
  enabled: boolean;
  cycleCount: number;
  maxCycles: number;
  model: string;
  updatedAt: string;
}

export interface NightWatchReport {
  id: string;
  sessionId: string;
  sessionName: string | null;
  workingDirectory: string | null;
  status: "continue" | "complete" | "error" | "humanInput";
  summary: string;
  reasoning: string | null;
  inputMode: string | null;
  cycleCount: number;
  createdAt: string;
}

// ============================================================
// Store Implementation
// ============================================================

const DEFAULT_DB_PATH = databaseFile;

class NightWatchStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.initialise();
  }

  // ----------------------------------------------------------
  // Session Methods
  // ----------------------------------------------------------

  getSessionState(sessionId: string): NightWatchSessionState | null {
    const row = this.db
      .query<NightWatchSessionState, [string]>(
        `SELECT
           session_id AS sessionId,
           enabled,
           cycle_count AS cycleCount,
           max_cycles AS maxCycles,
           model,
           updated_at AS updatedAt
         FROM nightwatch_sessions
         WHERE session_id = ?1`,
      )
      .get(sessionId);
    if (!row) return null;
    return { ...row, enabled: Boolean(row.enabled) };
  }

  isEnabled(sessionId: string): boolean {
    const row = this.db
      .query<{ enabled: number }, [string]>(
        `SELECT enabled FROM nightwatch_sessions WHERE session_id = ?1`,
      )
      .get(sessionId);
    return Boolean(row?.enabled);
  }

  enableSession(
    sessionId: string,
    opts?: { model?: string; maxCycles?: number },
  ): NightWatchSessionState {
    const now = new Date().toISOString();
    const defaultModel = this.getConfig("default_model") ?? "google/gemini-3-flash-preview";
    const defaultMaxCycles = Number(this.getConfig("default_max_cycles") ?? "21");
    const model = opts?.model ?? defaultModel;
    const maxCycles = opts?.maxCycles ?? defaultMaxCycles;

    this.db
      .query(
        `INSERT INTO nightwatch_sessions (session_id, enabled, cycle_count, max_cycles, model, updated_at)
         VALUES (?1, 1, 0, ?2, ?3, ?4)
         ON CONFLICT(session_id) DO UPDATE SET
           enabled = 1,
           cycle_count = 0,
           max_cycles = excluded.max_cycles,
           model = excluded.model,
           updated_at = excluded.updated_at`,
      )
      .run(sessionId, maxCycles, model, now);

    return this.getSessionState(sessionId)!;
  }

  disableSession(sessionId: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE nightwatch_sessions SET enabled = 0, updated_at = ?2 WHERE session_id = ?1`,
      )
      .run(sessionId, now);
  }

  incrementCycle(sessionId: string): number {
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE nightwatch_sessions SET cycle_count = cycle_count + 1, updated_at = ?2 WHERE session_id = ?1`,
      )
      .run(sessionId, now);
    const row = this.db
      .query<{ cycleCount: number }, [string]>(
        `SELECT cycle_count AS cycleCount FROM nightwatch_sessions WHERE session_id = ?1`,
      )
      .get(sessionId);
    return row?.cycleCount ?? 0;
  }

  // ----------------------------------------------------------
  // Report Methods
  // ----------------------------------------------------------

  addReport(input: {
    sessionId: string;
    sessionName?: string | null;
    workingDirectory?: string | null;
    status: NightWatchReport["status"];
    summary: string;
    reasoning?: string | null;
    inputMode?: string | null;
    cycleCount: number;
  }): NightWatchReport {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO nightwatch_reports (id, session_id, session_name, working_directory, status, summary, reasoning, input_mode, cycle_count, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .run(
        id,
        input.sessionId,
        input.sessionName ?? null,
        input.workingDirectory ?? null,
        input.status,
        input.summary,
        input.reasoning ?? null,
        input.inputMode ?? null,
        input.cycleCount,
        now,
      );

    return {
      id,
      sessionId: input.sessionId,
      sessionName: input.sessionName ?? null,
      workingDirectory: input.workingDirectory ?? null,
      status: input.status,
      summary: input.summary,
      reasoning: input.reasoning ?? null,
      inputMode: input.inputMode ?? null,
      cycleCount: input.cycleCount,
      createdAt: now,
    };
  }

  listReports(limit = 50): NightWatchReport[] {
    return this.db
      .query<NightWatchReport, [number]>(
        `SELECT
           id,
           session_id AS sessionId,
           session_name AS sessionName,
           working_directory AS workingDirectory,
           status,
           summary,
           reasoning,
           input_mode AS inputMode,
           cycle_count AS cycleCount,
           created_at AS createdAt
         FROM nightwatch_reports
         ORDER BY created_at DESC
         LIMIT ?1`,
      )
      .all(limit);
  }

  deleteReport(id: string): boolean {
    const result = this.db
      .query("DELETE FROM nightwatch_reports WHERE id = ?1")
      .run(id);
    return result.changes > 0;
  }

  // ----------------------------------------------------------
  // Config Methods
  // ----------------------------------------------------------

  getConfig(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>(
        `SELECT value FROM nightwatch_config WHERE key = ?1`,
      )
      .get(key);
    return row?.value ?? null;
  }

  setConfig(key: string, value: string): void {
    this.db
      .query(
        `INSERT INTO nightwatch_config (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getAllConfig(): Record<string, string> {
    const rows = this.db
      .query<{ key: string; value: string }, []>(
        `SELECT key, value FROM nightwatch_config`,
      )
      .all();
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  // ----------------------------------------------------------
  // Initialization
  // ----------------------------------------------------------

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nightwatch_sessions (
        session_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        cycle_count INTEGER NOT NULL DEFAULT 0,
        max_cycles INTEGER NOT NULL DEFAULT 21,
        model TEXT NOT NULL DEFAULT 'google/gemini-3-flash-preview',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nightwatch_reports (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        session_name TEXT,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        cycle_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_nightwatch_reports_session
        ON nightwatch_reports(session_id);
      CREATE INDEX IF NOT EXISTS idx_nightwatch_reports_created
        ON nightwatch_reports(created_at DESC);

      CREATE TABLE IF NOT EXISTS nightwatch_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Migration: add working_directory column if missing
    try {
      this.db.exec(`ALTER TABLE nightwatch_reports ADD COLUMN working_directory TEXT`);
    } catch {
      // Column already exists — ignore
    }

    // Migration: add reasoning column if missing
    try {
      this.db.exec(`ALTER TABLE nightwatch_reports ADD COLUMN reasoning TEXT`);
    } catch {
      // Column already exists — ignore
    }

    // Migration: add input_mode column if missing
    try {
      this.db.exec(`ALTER TABLE nightwatch_reports ADD COLUMN input_mode TEXT`);
    } catch {
      // Column already exists — ignore
    }

    // Task sessions table - tracks MG task ↔ agent session links
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_sessions (
        session_id TEXT PRIMARY KEY,
        task_id INTEGER NOT NULL,
        team_slug TEXT NOT NULL,
        task_url TEXT NOT NULL,
        mg_base_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL
      );
    `);
  }

  // ----------------------------------------------------------
  // Task Session Methods
  // ----------------------------------------------------------

  addTaskSession(params: {
    sessionId: string;
    taskId: number;
    teamSlug: string;
    taskUrl: string;
    mgBaseUrl: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO task_sessions (session_id, task_id, team_slug, task_url, mg_base_url, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6)
         ON CONFLICT(session_id) DO UPDATE SET
           task_id = excluded.task_id,
           team_slug = excluded.team_slug,
           task_url = excluded.task_url,
           mg_base_url = excluded.mg_base_url,
           status = 'active',
           created_at = excluded.created_at`,
      )
      .run(params.sessionId, params.taskId, params.teamSlug, params.taskUrl, params.mgBaseUrl, now);
  }

  getTaskSession(sessionId: string): TaskSessionRecord | null {
    return this.db
      .query<TaskSessionRecord, [string]>(
        `SELECT
           session_id AS sessionId,
           task_id AS taskId,
           team_slug AS teamSlug,
           task_url AS taskUrl,
           mg_base_url AS mgBaseUrl,
           status,
           created_at AS createdAt
         FROM task_sessions
         WHERE session_id = ?1`,
      )
      .get(sessionId) ?? null;
  }

  updateTaskSessionStatus(sessionId: string, status: string): void {
    this.db
      .query(`UPDATE task_sessions SET status = ?2 WHERE session_id = ?1`)
      .run(sessionId, status);
  }
}

export interface TaskSessionRecord {
  sessionId: string;
  taskId: number;
  teamSlug: string;
  taskUrl: string;
  mgBaseUrl: string;
  status: string;
  createdAt: string;
}

export { NightWatchStore };
