/**
 * Jobs DB — manages job_definitions, job_runs, and scope_job_rules.
 * Uses better-sqlite3 for node compatibility with the wingman21 ecosystem.
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const ROOT_DIR = resolve(__dirname, '..');
export const DB_PATH = process.env.JOBS_DB_PATH || join(ROOT_DIR, 'data', 'jobs.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS job_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  default_worker_prompt TEXT,
  default_manager_prompt TEXT,
  default_manager_goal TEXT,
  default_worker_dir TEXT,
  default_manager_dir TEXT,
  manager_check_interval_seconds INTEGER DEFAULT 180,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES job_definitions(id),
  goal TEXT,
  manager_goal TEXT,
  worker_session_id TEXT,
  manager_session_id TEXT,
  worker_prompt TEXT,
  manager_context TEXT,
  worker_dir TEXT,
  manager_dir TEXT,
  refs_json TEXT,
  status TEXT CHECK(status IN ('new','starting','running','complete','failed','stopped')) DEFAULT 'new',
  output_summary TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scope_job_rules (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  task_state TEXT,
  job_id TEXT NOT NULL REFERENCES job_definitions(id),
  created_at TEXT DEFAULT (datetime('now'))
);
`;

export function openJobsDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

// --------------- Job Definitions ---------------

export function createDefinition(db, def) {
  const id = def.id || randomUUID();
  const stmt = db.prepare(`
    INSERT INTO job_definitions (id, name, description, default_worker_prompt, default_manager_prompt, default_manager_goal, default_worker_dir, default_manager_dir, manager_check_interval_seconds, created_at, updated_at)
    VALUES (@id, @name, @description, @default_worker_prompt, @default_manager_prompt, @default_manager_goal, @default_worker_dir, @default_manager_dir, @manager_check_interval_seconds, datetime('now'), datetime('now'))
  `);
  stmt.run({
    id,
    name: def.name,
    description: def.description || null,
    default_worker_prompt: def.default_worker_prompt || null,
    default_manager_prompt: def.default_manager_prompt || null,
    default_manager_goal: def.default_manager_goal || null,
    default_worker_dir: def.default_worker_dir || null,
    default_manager_dir: def.default_manager_dir || null,
    manager_check_interval_seconds: def.manager_check_interval_seconds ?? 180,
  });
  return id;
}

export function getDefinition(db, id) {
  return db.prepare('SELECT * FROM job_definitions WHERE id = ?').get(id);
}

export function listDefinitions(db) {
  return db.prepare('SELECT * FROM job_definitions ORDER BY created_at DESC').all();
}

export function updateDefinition(db, id, fields) {
  const sets = ["updated_at = datetime('now')"];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'id' || k === 'created_at') continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  db.prepare(`UPDATE job_definitions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function deleteDefinition(db, id) {
  db.prepare('DELETE FROM job_definitions WHERE id = ?').run(id);
}

// --------------- Job Runs ---------------

export function createRun(db, run) {
  const id = run.id || randomUUID();
  const stmt = db.prepare(`
    INSERT INTO job_runs (id, job_id, goal, manager_goal, worker_session_id, manager_session_id, worker_prompt, manager_context, worker_dir, manager_dir, refs_json, status, output_summary, created_at, updated_at)
    VALUES (@id, @job_id, @goal, @manager_goal, @worker_session_id, @manager_session_id, @worker_prompt, @manager_context, @worker_dir, @manager_dir, @refs_json, @status, @output_summary, datetime('now'), datetime('now'))
  `);
  stmt.run({
    id,
    job_id: run.job_id,
    goal: run.goal || null,
    manager_goal: run.manager_goal || null,
    worker_session_id: run.worker_session_id || null,
    manager_session_id: run.manager_session_id || null,
    worker_prompt: run.worker_prompt || null,
    manager_context: run.manager_context || null,
    worker_dir: run.worker_dir || null,
    manager_dir: run.manager_dir || null,
    refs_json: run.refs_json || null,
    status: run.status || 'new',
    output_summary: run.output_summary || null,
  });
  return id;
}

export function getRun(db, id) {
  return db.prepare('SELECT * FROM job_runs WHERE id = ?').get(id);
}

export function listRuns(db, jobId) {
  if (jobId) {
    return db.prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY created_at DESC').all(jobId);
  }
  return db.prepare('SELECT * FROM job_runs ORDER BY created_at DESC').all();
}

export function updateRun(db, id, fields) {
  const sets = ["updated_at = datetime('now')"];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'id' || k === 'created_at') continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  db.prepare(`UPDATE job_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function updateRunStatus(db, id, status, outputSummary) {
  const sets = ["status = ?", "updated_at = datetime('now')"];
  const vals = [status];
  if (outputSummary !== undefined) {
    sets.push('output_summary = ?');
    vals.push(outputSummary);
  }
  vals.push(id);
  db.prepare(`UPDATE job_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}
