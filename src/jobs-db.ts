/**
 * Jobs DB — SQLite store for job definitions.
 *
 * Follows the CaproverStore pattern: bun:sqlite Database,
 * databaseFile helper for path resolution.
 */

import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { Database } from "bun:sqlite";
import { databaseFile } from "./storage/message-store";

// ============================================================
// Types
// ============================================================

export interface JobDefinition {
  id: string;
  name: string;
  worker_prompt: string;
  manager_prompt: string;
  manager_goal: string;
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
  manager_dir: string;
  check_interval?: number;
  enabled?: boolean;
}

export interface UpdateJobInput {
  name?: string;
  worker_prompt?: string;
  manager_prompt?: string;
  manager_goal?: string;
  manager_dir?: string;
  check_interval?: number;
  enabled?: boolean;
}

// ============================================================
// Store
// ============================================================

const DB_PATH = join(dirname(databaseFile), "jobs.db");

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
      manager_dir     TEXT NOT NULL DEFAULT '',
      check_interval  INTEGER NOT NULL DEFAULT 300,
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
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

  db()
    .query(
      `INSERT INTO job_definitions (id, name, worker_prompt, manager_prompt, manager_goal, manager_dir, check_interval, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.name,
      input.worker_prompt,
      input.manager_prompt,
      input.manager_goal,
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
  const values: unknown[] = [];

  if (input.name !== undefined) { sets.push("name = ?"); values.push(input.name); }
  if (input.worker_prompt !== undefined) { sets.push("worker_prompt = ?"); values.push(input.worker_prompt); }
  if (input.manager_prompt !== undefined) { sets.push("manager_prompt = ?"); values.push(input.manager_prompt); }
  if (input.manager_goal !== undefined) { sets.push("manager_goal = ?"); values.push(input.manager_goal); }
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
