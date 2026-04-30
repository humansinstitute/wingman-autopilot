import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export type JsonObject = Record<string, unknown>;
export type PipelineScope = "shared" | "user";
export type StepKind = "code" | "agent" | "loop" | "block";
export type PipelineStatus = "running" | "ok" | "needs_input" | "error" | "skipped";

export interface PipelineRunRecord {
  id: string;
  definitionId: string;
  definitionPath: string | null;
  name: string;
  status: PipelineStatus;
  ownerNpub: string | null;
  ownerAlias: string | null;
  scope: PipelineScope;
  input: JsonObject;
  result: JsonObject | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface PipelineStepRecord {
  id: string;
  runId: string;
  stepIndex: number;
  name: string;
  kind: StepKind;
  status: PipelineStatus;
  input: JsonObject;
  result: JsonObject | null;
  error: string | null;
  wingmanSessionId: string | null;
  callbackToken: string | null;
  startedAt: string;
  completedAt: string | null;
}

const DEFAULT_DB_PATH = "data/pipelines.sqlite";

function now(): string {
  return new Date().toISOString();
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function decodeJsonObject(value: unknown): JsonObject {
  if (typeof value !== "string" || value.length === 0) return {};
  const parsed = JSON.parse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
}

function decodeNullableJsonObject(value: unknown): JsonObject | null {
  if (value === null || value === undefined) return null;
  return decodeJsonObject(value);
}

export class PipelineStore {
  readonly path: string;
  private readonly db: Database;

  constructor(path = process.env.WINGMEN_PIPELINES_DB || DEFAULT_DB_PATH) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  createRun(input: {
    definitionId: string;
    definitionPath?: string | null;
    name: string;
    ownerNpub?: string | null;
    ownerAlias?: string | null;
    scope: PipelineScope;
    input: JsonObject;
  }): PipelineRunRecord {
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO pipeline_runs (
        id, definition_id, definition_path, name, status, owner_npub, owner_alias, scope,
        input_json, result_json, error, started_at, completed_at
      ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, NULL, NULL, ?, NULL)`,
      [
        id,
        input.definitionId,
        input.definitionPath ?? null,
        input.name,
        input.ownerNpub ?? null,
        input.ownerAlias ?? null,
        input.scope,
        encodeJson(input.input),
        now(),
      ],
    );
    return this.getRun(id)!;
  }

  completeRun(id: string, status: PipelineStatus, result: JsonObject | null, error?: string | null): PipelineRunRecord {
    this.db.run(
      `UPDATE pipeline_runs SET status = ?, result_json = ?, error = ?, completed_at = ? WHERE id = ?`,
      [status, result ? encodeJson(result) : null, error ?? null, now(), id],
    );
    return this.getRun(id)!;
  }

  createStep(input: {
    runId: string;
    stepIndex: number;
    name: string;
    kind: StepKind;
    input: JsonObject;
    callbackToken?: string | null;
  }): PipelineStepRecord {
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO pipeline_steps (
        id, run_id, step_index, name, kind, status, input_json, result_json, error,
        wingman_session_id, callback_token, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, NULL, NULL, ?, ?, NULL)`,
      [id, input.runId, input.stepIndex, input.name, input.kind, encodeJson(input.input), input.callbackToken ?? null, now()],
    );
    this.addEvent({ runId: input.runId, stepId: id, level: "info", type: "step_started", message: input.name, data: input.input });
    return this.getStep(id)!;
  }

  completeStep(input: {
    id: string;
    status: PipelineStatus;
    result: JsonObject | null;
    error?: string | null;
    wingmanSessionId?: string | null;
  }): PipelineStepRecord {
    this.db.run(
      `UPDATE pipeline_steps
       SET status = ?, result_json = ?, error = ?, wingman_session_id = COALESCE(?, wingman_session_id), completed_at = ?
       WHERE id = ?`,
      [
        input.status,
        input.result ? encodeJson(input.result) : null,
        input.error ?? null,
        input.wingmanSessionId ?? null,
        now(),
        input.id,
      ],
    );
    const step = this.getStep(input.id)!;
    this.addEvent({
      runId: step.runId,
      stepId: input.id,
      level: input.status === "ok" ? "info" : "warn",
      type: "step_completed",
      message: input.status,
      data: input.result ?? {},
    });
    return step;
  }

  setStepSession(stepId: string, sessionId: string): void {
    this.db.run(`UPDATE pipeline_steps SET wingman_session_id = ? WHERE id = ?`, [sessionId, stepId]);
  }

  getRun(id: string): PipelineRunRecord | null {
    const row = this.db.query(`SELECT * FROM pipeline_runs WHERE id = ?`).get(id) as Record<string, unknown> | null;
    return row ? mapRun(row) : null;
  }

  getStep(id: string): PipelineStepRecord | null {
    const row = this.db.query(`SELECT * FROM pipeline_steps WHERE id = ?`).get(id) as Record<string, unknown> | null;
    return row ? mapStep(row) : null;
  }

  listRuns(options: { ownerNpub?: string | null; includeShared?: boolean; limit?: number } = {}): PipelineRunRecord[] {
    const limit = options.limit ?? 100;
    let rows: Record<string, unknown>[];
    if (options.ownerNpub) {
      rows = this.db.query(
        `SELECT * FROM pipeline_runs
         WHERE owner_npub = ? OR (? = 1 AND scope = 'shared')
         ORDER BY started_at DESC LIMIT ?`,
      ).all(options.ownerNpub, options.includeShared ? 1 : 0, limit) as Record<string, unknown>[];
    } else {
      rows = this.db.query(`SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT ?`).all(limit) as Record<string, unknown>[];
    }
    return rows.map(mapRun);
  }

  listSteps(runId: string): PipelineStepRecord[] {
    const rows = this.db
      .query(`SELECT * FROM pipeline_steps WHERE run_id = ? ORDER BY step_index ASC`)
      .all(runId) as Record<string, unknown>[];
    return rows.map(mapStep);
  }

  listEventsForStep(stepId: string): Array<Record<string, unknown>> {
    return this.db.query(`SELECT * FROM pipeline_events WHERE step_id = ? ORDER BY ts ASC`).all(stepId) as Array<Record<string, unknown>>;
  }

  listCallbacksForStep(stepId: string): Array<Record<string, unknown>> {
    return this.db.query(`SELECT * FROM pipeline_callbacks WHERE step_id = ? ORDER BY received_at ASC`).all(stepId) as Array<Record<string, unknown>>;
  }

  addCallback(input: { stepId: string; accepted: boolean; payload: JsonObject; error?: string | null }): void {
    this.db.run(
      `INSERT INTO pipeline_callbacks (id, step_id, received_at, accepted, payload_json, error) VALUES (?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), input.stepId, now(), input.accepted ? 1 : 0, encodeJson(input.payload), input.error ?? null],
    );
  }

  addEvent(input: {
    runId?: string | null;
    stepId?: string | null;
    level: "debug" | "info" | "warn" | "error";
    type: string;
    message?: string;
    data?: JsonObject;
  }): void {
    this.db.run(
      `INSERT INTO pipeline_events (id, run_id, step_id, ts, level, type, message, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        input.runId ?? null,
        input.stepId ?? null,
        now(),
        input.level,
        input.type,
        input.message ?? null,
        encodeJson(input.data ?? {}),
      ],
    );
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL,
        definition_path TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_npub TEXT,
        owner_alias TEXT,
        scope TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        step_index INTEGER NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        wingman_session_id TEXT,
        callback_token TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_steps_run_order ON pipeline_steps(run_id, step_index)`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_events (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        step_id TEXT,
        ts TEXT NOT NULL,
        level TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT,
        data_json TEXT NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_events_step_ts ON pipeline_events(step_id, ts)`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_callbacks (
        id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL REFERENCES pipeline_steps(id) ON DELETE CASCADE,
        received_at TEXT NOT NULL,
        accepted INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        error TEXT
      )
    `);
  }
}

function mapRun(row: Record<string, unknown>): PipelineRunRecord {
  return {
    id: String(row.id),
    definitionId: String(row.definition_id),
    definitionPath: row.definition_path === null || row.definition_path === undefined ? null : String(row.definition_path),
    name: String(row.name),
    status: row.status as PipelineStatus,
    ownerNpub: row.owner_npub === null || row.owner_npub === undefined ? null : String(row.owner_npub),
    ownerAlias: row.owner_alias === null || row.owner_alias === undefined ? null : String(row.owner_alias),
    scope: row.scope as PipelineScope,
    input: decodeJsonObject(row.input_json),
    result: decodeNullableJsonObject(row.result_json),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
  };
}

function mapStep(row: Record<string, unknown>): PipelineStepRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stepIndex: Number(row.step_index),
    name: String(row.name),
    kind: row.kind as StepKind,
    status: row.status as PipelineStatus,
    input: decodeJsonObject(row.input_json),
    result: decodeNullableJsonObject(row.result_json),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    wingmanSessionId: row.wingman_session_id === null || row.wingman_session_id === undefined ? null : String(row.wingman_session_id),
    callbackToken: row.callback_token === null || row.callback_token === undefined ? null : String(row.callback_token),
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
  };
}
