/**
 * Jobs DB — SQLite store for job definitions.
 *
 * Follows the CaproverStore pattern: bun:sqlite Database,
 * databaseFile helper for path resolution.
 */

import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { databaseFile } from "./storage/message-store";
import type { AgentType } from "./config";
import { resolveJobAgent } from "./jobs/agent-config";

// ============================================================
// Types
// ============================================================

export interface JobDefinition {
  id: string;
  name: string;
  worker_prompt: string;
  manager_prompt: string;
  manager_goal: string;
  worker_agent: AgentType;
  manager_agent: AgentType;
  manager_dir: string;
  check_interval: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateJobInput {
  id: string;
  name: string;
  worker_prompt: string;
  manager_prompt: string;
  manager_goal: string;
  worker_agent?: AgentType;
  manager_agent?: AgentType;
  manager_dir: string;
  check_interval?: number;
  enabled?: boolean;
}

export interface UpdateJobInput {
  name?: string;
  worker_prompt?: string;
  manager_prompt?: string;
  manager_goal?: string;
  worker_agent?: AgentType;
  manager_agent?: AgentType;
  manager_dir?: string;
  check_interval?: number;
  enabled?: boolean;
}

export interface JobRun {
  id: string;
  job_id: string;
  goal: string | null;
  manager_goal: string | null;
  worker_agent: AgentType | null;
  manager_agent: AgentType | null;
  worker_session_id: string | null;
  manager_session_id: string | null;
  worker_prompt: string | null;
  manager_context: string | null;
  worker_dir: string | null;
  manager_dir: string | null;
  refs_json: string | null;
  status: string;
  output_summary: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Store
// ============================================================

const DB_PATH = join(dirname(databaseFile), "jobs.db");

function hasColumn(database: Database, tableName: string, columnName: string): boolean {
  const rows = database.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

function applyMigrations(database: Database): void {
  if (!hasColumn(database, "job_definitions", "worker_agent")) {
    database.run("ALTER TABLE job_definitions ADD COLUMN worker_agent TEXT NOT NULL DEFAULT 'claude'");
  }
  if (!hasColumn(database, "job_definitions", "manager_agent")) {
    database.run("ALTER TABLE job_definitions ADD COLUMN manager_agent TEXT NOT NULL DEFAULT 'claude'");
  }
  if (!hasColumn(database, "job_runs", "worker_agent")) {
    database.run("ALTER TABLE job_runs ADD COLUMN worker_agent TEXT");
  }
  if (!hasColumn(database, "job_runs", "manager_agent")) {
    database.run("ALTER TABLE job_runs ADD COLUMN manager_agent TEXT");
  }
}

function openDb(): Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode = WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS job_definitions (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      worker_prompt   TEXT NOT NULL DEFAULT '',
      manager_prompt  TEXT NOT NULL DEFAULT '',
      manager_goal    TEXT NOT NULL DEFAULT '',
      worker_agent    TEXT NOT NULL DEFAULT 'claude',
      manager_agent   TEXT NOT NULL DEFAULT 'claude',
      manager_dir     TEXT NOT NULL DEFAULT '',
      check_interval  INTEGER NOT NULL DEFAULT 300,
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS job_runs (
      id                  TEXT PRIMARY KEY,
      job_id              TEXT NOT NULL,
      goal                TEXT,
      manager_goal        TEXT,
      worker_agent        TEXT,
      manager_agent       TEXT,
      worker_session_id   TEXT,
      manager_session_id  TEXT,
      worker_prompt       TEXT,
      manager_context     TEXT,
      worker_dir          TEXT,
      manager_dir         TEXT,
      refs_json           TEXT,
      status              TEXT NOT NULL DEFAULT 'new',
      output_summary      TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  applyMigrations(db);
  return db;
}

let _db: Database | undefined;
function db(): Database {
  if (!_db) _db = openDb();
  return _db;
}

export function listJobs(): JobDefinition[] {
  return db()
    .query("SELECT * FROM job_definitions ORDER BY created_at DESC")
    .all() as JobDefinition[];
}

export function getJob(id: string): JobDefinition | undefined {
  return (
    db()
      .query("SELECT * FROM job_definitions WHERE id = ?")
      .get(id) as JobDefinition | null
  ) ?? undefined;
}

export function createJob(input: CreateJobInput): JobDefinition {
  const now = new Date().toISOString();
  const checkInterval = input.check_interval ?? 300;
  const enabled = input.enabled !== false ? 1 : 0;
  const workerAgent = resolveJobAgent(input.worker_agent);
  const managerAgent = resolveJobAgent(input.manager_agent);

  db()
    .query(
      `INSERT INTO job_definitions (id, name, worker_prompt, manager_prompt, manager_goal, worker_agent, manager_agent, manager_dir, check_interval, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.name,
      input.worker_prompt,
      input.manager_prompt,
      input.manager_goal,
      workerAgent,
      managerAgent,
      input.manager_dir,
      checkInterval,
      enabled,
      now,
      now,
    );

  return getJob(input.id)!;
}

export function updateJob(id: string, input: UpdateJobInput): JobDefinition | undefined {
  const existing = getJob(id);
  if (!existing) return undefined;

  const sets: string[] = [];
  const values: SQLQueryBindings[] = [];

  if (input.name !== undefined) { sets.push("name = ?"); values.push(input.name); }
  if (input.worker_prompt !== undefined) { sets.push("worker_prompt = ?"); values.push(input.worker_prompt); }
  if (input.manager_prompt !== undefined) { sets.push("manager_prompt = ?"); values.push(input.manager_prompt); }
  if (input.manager_goal !== undefined) { sets.push("manager_goal = ?"); values.push(input.manager_goal); }
  if (input.worker_agent !== undefined) { sets.push("worker_agent = ?"); values.push(resolveJobAgent(input.worker_agent)); }
  if (input.manager_agent !== undefined) { sets.push("manager_agent = ?"); values.push(resolveJobAgent(input.manager_agent)); }
  if (input.manager_dir !== undefined) { sets.push("manager_dir = ?"); values.push(input.manager_dir); }
  if (input.check_interval !== undefined) { sets.push("check_interval = ?"); values.push(input.check_interval); }
  if (input.enabled !== undefined) { sets.push("enabled = ?"); values.push(input.enabled ? 1 : 0); }

  if (sets.length === 0) return existing;

  sets.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);

  db()
    .query(`UPDATE job_definitions SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values);

  return getJob(id);
}

export function deleteJob(id: string): boolean {
  const result = db()
    .query("DELETE FROM job_definitions WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

// ============================================================
// Job Runs
// ============================================================

export function listRuns(jobId?: string, status?: string): JobRun[] {
  const clauses: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (jobId) { clauses.push("job_id = ?"); params.push(jobId); }
  if (status) { clauses.push("status = ?"); params.push(status); }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db()
    .query(`SELECT * FROM job_runs ${where} ORDER BY created_at DESC`)
    .all(...params) as JobRun[];
}

export function getRun(id: string): JobRun | undefined {
  return (
    db()
      .query("SELECT * FROM job_runs WHERE id = ?")
      .get(id) as JobRun | null
  ) ?? undefined;
}

export interface CreateRunInput {
  id?: string;
  job_id: string;
  goal?: string;
  manager_goal?: string;
  worker_agent?: AgentType;
  manager_agent?: AgentType;
  worker_session_id?: string;
  manager_session_id?: string;
  worker_prompt?: string;
  manager_context?: string;
  worker_dir?: string;
  manager_dir?: string;
  refs_json?: string;
  status?: string;
  output_summary?: string;
}

export function createRun(input: CreateRunInput): JobRun {
  const id = input.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  db()
    .query(
      `INSERT INTO job_runs (id, job_id, goal, manager_goal, worker_agent, manager_agent, worker_session_id, manager_session_id, worker_prompt, manager_context, worker_dir, manager_dir, refs_json, status, output_summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.job_id,
      input.goal ?? null,
      input.manager_goal ?? null,
      input.worker_agent ?? null,
      input.manager_agent ?? null,
      input.worker_session_id ?? null,
      input.manager_session_id ?? null,
      input.worker_prompt ?? null,
      input.manager_context ?? null,
      input.worker_dir ?? null,
      input.manager_dir ?? null,
      input.refs_json ?? null,
      input.status ?? "new",
      input.output_summary ?? null,
      now,
      now,
    );
  return getRun(id)!;
}

export function updateRun(id: string, fields: Partial<Omit<JobRun, "id" | "created_at">>): boolean {
  const sets: string[] = [];
  const vals: SQLQueryBindings[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === "id" || k === "created_at") continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return false;
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  const result = db()
    .query(`UPDATE job_runs SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals);
  return result.changes > 0;
}

export function updateRunStatus(id: string, status: string, outputSummary?: string): boolean {
  const sets = ["status = ?", "updated_at = datetime('now')"];
  const vals: SQLQueryBindings[] = [status];
  if (outputSummary !== undefined) {
    sets.push("output_summary = ?");
    vals.push(outputSummary);
  }
  vals.push(id);
  const result = db()
    .query(`UPDATE job_runs SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals);
  return result.changes > 0;
}
