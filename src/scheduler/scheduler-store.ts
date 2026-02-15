/**
 * Scheduler Store
 *
 * SQLite store for scheduled jobs and run history.
 * Follows the NightWatchStore pattern — shares the main wingman.db database.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "../storage/message-store";

// ============================================================
// Types
// ============================================================

export interface ScheduledJob {
  id: string;
  name: string;
  userNpub: string;
  botNpub: string;
  wrappedKeyCiphertext: string;
  wrappedKeyNonce: string;
  agent: string;
  workingDirectory: string;
  initialPrompt: string;
  nightwatchmanEnabled: boolean;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledJobRun {
  id: string;
  jobId: string;
  sessionId: string | null;
  startedAt: string;
  status: "started" | "success" | "error";
  errorMessage: string | null;
}

export interface CreateJobInput {
  name: string;
  userNpub: string;
  botNpub: string;
  wrappedKeyCiphertext: string;
  wrappedKeyNonce: string;
  agent: string;
  workingDirectory: string;
  initialPrompt: string;
  nightwatchmanEnabled?: boolean;
  cronExpression: string;
  timezone?: string;
}

export interface UpdateJobInput {
  name?: string;
  agent?: string;
  workingDirectory?: string;
  initialPrompt?: string;
  nightwatchmanEnabled?: boolean;
  cronExpression?: string;
  timezone?: string;
  enabled?: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
}

// ============================================================
// Raw row type (integers, not booleans)
// ============================================================

interface RawJobRow {
  id: string;
  name: string;
  userNpub: string;
  botNpub: string;
  wrappedKeyCiphertext: string;
  wrappedKeyNonce: string;
  agent: string;
  workingDirectory: string;
  initialPrompt: string;
  nightwatchmanEnabled: number;
  cronExpression: string;
  timezone: string;
  enabled: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToJob(row: RawJobRow): ScheduledJob {
  return {
    ...row,
    nightwatchmanEnabled: Boolean(row.nightwatchmanEnabled),
    enabled: Boolean(row.enabled),
  };
}

// ============================================================
// Store Implementation
// ============================================================

const DEFAULT_DB_PATH = databaseFile;

class SchedulerStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.initialise();
  }

  // ----------------------------------------------------------
  // Job CRUD
  // ----------------------------------------------------------

  createJob(input: CreateJobInput): ScheduledJob {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .query(
        `INSERT INTO scheduled_jobs (
           id, name, user_npub, bot_npub,
           wrapped_key_ciphertext, wrapped_key_nonce,
           agent, working_directory, initial_prompt,
           nightwatchman_enabled, cron_expression, timezone,
           enabled, last_run_at, next_run_at,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, NULL, NULL, ?13, ?14)`,
      )
      .run(
        id,
        input.name,
        input.userNpub,
        input.botNpub,
        input.wrappedKeyCiphertext,
        input.wrappedKeyNonce,
        input.agent,
        input.workingDirectory,
        input.initialPrompt,
        input.nightwatchmanEnabled !== false ? 1 : 0,
        input.cronExpression,
        input.timezone ?? "UTC",
        now,
        now,
      );

    return this.getJob(id)!;
  }

  getJob(id: string): ScheduledJob | null {
    const row = this.db
      .query<RawJobRow, [string]>(
        `SELECT
           id,
           name,
           user_npub AS userNpub,
           bot_npub AS botNpub,
           wrapped_key_ciphertext AS wrappedKeyCiphertext,
           wrapped_key_nonce AS wrappedKeyNonce,
           agent,
           working_directory AS workingDirectory,
           initial_prompt AS initialPrompt,
           nightwatchman_enabled AS nightwatchmanEnabled,
           cron_expression AS cronExpression,
           timezone,
           enabled,
           last_run_at AS lastRunAt,
           next_run_at AS nextRunAt,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM scheduled_jobs
         WHERE id = ?1`,
      )
      .get(id);
    return row ? rowToJob(row) : null;
  }

  listJobs(userNpub?: string): ScheduledJob[] {
    if (userNpub) {
      const rows = this.db
        .query<RawJobRow, [string]>(
          `SELECT
             id, name,
             user_npub AS userNpub,
             bot_npub AS botNpub,
             wrapped_key_ciphertext AS wrappedKeyCiphertext,
             wrapped_key_nonce AS wrappedKeyNonce,
             agent, working_directory AS workingDirectory,
             initial_prompt AS initialPrompt,
             nightwatchman_enabled AS nightwatchmanEnabled,
             cron_expression AS cronExpression,
             timezone, enabled,
             last_run_at AS lastRunAt,
             next_run_at AS nextRunAt,
             created_at AS createdAt,
             updated_at AS updatedAt
           FROM scheduled_jobs
           WHERE user_npub = ?1
           ORDER BY created_at DESC`,
        )
        .all(userNpub);
      return rows.map(rowToJob);
    }

    const rows = this.db
      .query<RawJobRow, []>(
        `SELECT
           id, name,
           user_npub AS userNpub,
           bot_npub AS botNpub,
           wrapped_key_ciphertext AS wrappedKeyCiphertext,
           wrapped_key_nonce AS wrappedKeyNonce,
           agent, working_directory AS workingDirectory,
           initial_prompt AS initialPrompt,
           nightwatchman_enabled AS nightwatchmanEnabled,
           cron_expression AS cronExpression,
           timezone, enabled,
           last_run_at AS lastRunAt,
           next_run_at AS nextRunAt,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM scheduled_jobs
         ORDER BY created_at DESC`,
      )
      .all();
    return rows.map(rowToJob);
  }

  listEnabledJobs(): ScheduledJob[] {
    const rows = this.db
      .query<RawJobRow, []>(
        `SELECT
           id, name,
           user_npub AS userNpub,
           bot_npub AS botNpub,
           wrapped_key_ciphertext AS wrappedKeyCiphertext,
           wrapped_key_nonce AS wrappedKeyNonce,
           agent, working_directory AS workingDirectory,
           initial_prompt AS initialPrompt,
           nightwatchman_enabled AS nightwatchmanEnabled,
           cron_expression AS cronExpression,
           timezone, enabled,
           last_run_at AS lastRunAt,
           next_run_at AS nextRunAt,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM scheduled_jobs
         WHERE enabled = 1
         ORDER BY created_at DESC`,
      )
      .all();
    return rows.map(rowToJob);
  }

  updateJob(id: string, input: UpdateJobInput): ScheduledJob | null {
    const sets: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      sets.push(`name = ?${paramIndex++}`);
      values.push(input.name);
    }
    if (input.agent !== undefined) {
      sets.push(`agent = ?${paramIndex++}`);
      values.push(input.agent);
    }
    if (input.workingDirectory !== undefined) {
      sets.push(`working_directory = ?${paramIndex++}`);
      values.push(input.workingDirectory);
    }
    if (input.initialPrompt !== undefined) {
      sets.push(`initial_prompt = ?${paramIndex++}`);
      values.push(input.initialPrompt);
    }
    if (input.nightwatchmanEnabled !== undefined) {
      sets.push(`nightwatchman_enabled = ?${paramIndex++}`);
      values.push(input.nightwatchmanEnabled ? 1 : 0);
    }
    if (input.cronExpression !== undefined) {
      sets.push(`cron_expression = ?${paramIndex++}`);
      values.push(input.cronExpression);
    }
    if (input.timezone !== undefined) {
      sets.push(`timezone = ?${paramIndex++}`);
      values.push(input.timezone);
    }
    if (input.enabled !== undefined) {
      sets.push(`enabled = ?${paramIndex++}`);
      values.push(input.enabled ? 1 : 0);
    }
    if (input.lastRunAt !== undefined) {
      sets.push(`last_run_at = ?${paramIndex++}`);
      values.push(input.lastRunAt);
    }
    if (input.nextRunAt !== undefined) {
      sets.push(`next_run_at = ?${paramIndex++}`);
      values.push(input.nextRunAt);
    }

    if (sets.length === 0) return this.getJob(id);

    const now = new Date().toISOString();
    sets.push(`updated_at = ?${paramIndex++}`);
    values.push(now);

    values.push(id);

    this.db
      .query(`UPDATE scheduled_jobs SET ${sets.join(", ")} WHERE id = ?${paramIndex}`)
      .run(...values);

    return this.getJob(id);
  }

  deleteJob(id: string): boolean {
    // Delete runs first (FK cascade)
    this.db.query("DELETE FROM scheduled_job_runs WHERE job_id = ?1").run(id);
    const result = this.db.query("DELETE FROM scheduled_jobs WHERE id = ?1").run(id);
    return result.changes > 0;
  }

  // ----------------------------------------------------------
  // Run History
  // ----------------------------------------------------------

  recordRun(jobId: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO scheduled_job_runs (id, job_id, session_id, started_at, status, error_message)
         VALUES (?1, ?2, NULL, ?3, 'started', NULL)`,
      )
      .run(id, jobId, now);
    return id;
  }

  completeRun(
    runId: string,
    status: "success" | "error",
    sessionId?: string,
    errorMessage?: string,
  ): void {
    this.db
      .query(
        `UPDATE scheduled_job_runs
         SET status = ?2, session_id = ?3, error_message = ?4
         WHERE id = ?1`,
      )
      .run(runId, status, sessionId ?? null, errorMessage ?? null);
  }

  getJobRuns(jobId: string, limit = 20): ScheduledJobRun[] {
    return this.db
      .query<ScheduledJobRun, [string, number]>(
        `SELECT
           id,
           job_id AS jobId,
           session_id AS sessionId,
           started_at AS startedAt,
           status,
           error_message AS errorMessage
         FROM scheduled_job_runs
         WHERE job_id = ?1
         ORDER BY started_at DESC
         LIMIT ?2`,
      )
      .all(jobId, limit);
  }

  // ----------------------------------------------------------
  // Initialization
  // ----------------------------------------------------------

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        user_npub TEXT NOT NULL,
        bot_npub TEXT NOT NULL,
        wrapped_key_ciphertext TEXT NOT NULL,
        wrapped_key_nonce TEXT NOT NULL,
        agent TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        initial_prompt TEXT NOT NULL,
        nightwatchman_enabled INTEGER NOT NULL DEFAULT 1,
        cron_expression TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_user
        ON scheduled_jobs(user_npub);
      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_enabled
        ON scheduled_jobs(enabled);

      CREATE TABLE IF NOT EXISTS scheduled_job_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        session_id TEXT,
        started_at TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        FOREIGN KEY (job_id) REFERENCES scheduled_jobs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_job
        ON scheduled_job_runs(job_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_started
        ON scheduled_job_runs(started_at DESC);
    `);
  }
}

export { SchedulerStore };
