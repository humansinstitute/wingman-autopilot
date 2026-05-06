import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export type JsonObject = Record<string, unknown>;
export type PipelineScope = "shared" | "user";
export type StepKind = "code" | "agent" | "loop" | "block" | "parallel";
export type PipelineStatus = "queued" | "running" | "ok" | "needs_input" | "error" | "skipped";

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
  current: JsonObject;
  cursorIndex: number;
  activeStepId: string | null;
  result: JsonObject | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface PipelineRunSummary {
  id: string;
  definitionId: string;
  definitionPath: string | null;
  name: string;
  status: PipelineStatus;
  ownerNpub: string | null;
  ownerAlias: string | null;
  scope: PipelineScope;
  cursorIndex: number;
  activeStepId: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  inputBytes: number;
  currentBytes: number;
  resultBytes: number;
  hasInput: boolean;
  hasCurrent: boolean;
  hasResult: boolean;
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
  parentStepId: string | null;
  logicalKey: string | null;
  callbackToken: string | null;
  output: JsonObject | null;
  startedAt: string;
  completedAt: string | null;
}

export interface PipelineStepSummary {
  id: string;
  runId: string;
  stepIndex: number;
  name: string;
  kind: StepKind;
  status: PipelineStatus;
  error: string | null;
  wingmanSessionId: string | null;
  parentStepId: string | null;
  logicalKey: string | null;
  callbackToken: string | null;
  startedAt: string;
  completedAt: string | null;
  inputBytes: number;
  resultBytes: number;
  hasInput: boolean;
  hasResult: boolean;
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
        input_json, current_json, cursor_index, active_step_id, result_json, error, started_at, completed_at
      ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, NULL)`,
      [
        id,
        input.definitionId,
        input.definitionPath ?? null,
        input.name,
        input.ownerNpub ?? null,
        input.ownerAlias ?? null,
        input.scope,
        encodeJson(input.input),
        encodeJson(input.input),
        now(),
      ],
    );
    return this.getRun(id)!;
  }

  completeRun(id: string, status: PipelineStatus, result: JsonObject | null, error?: string | null): PipelineRunRecord {
    this.db.run(
      `UPDATE pipeline_runs SET status = ?, result_json = ?, error = ?, active_step_id = NULL, completed_at = ? WHERE id = ?`,
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
    status?: PipelineStatus;
    parentStepId?: string | null;
    logicalKey?: string | null;
    callbackToken?: string | null;
  }): PipelineStepRecord {
    const id = crypto.randomUUID();
    const status = input.status ?? "running";
    this.db.run(
      `INSERT INTO pipeline_steps (
        id, run_id, step_index, name, kind, status, input_json, result_json, error,
        wingman_session_id, parent_step_id, logical_key, callback_token, output_json, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, ?, NULL)`,
      [
        id,
        input.runId,
        input.stepIndex,
        input.name,
        input.kind,
        status,
        encodeJson(input.input),
        input.parentStepId ?? null,
        input.logicalKey ?? null,
        input.callbackToken ?? null,
        now(),
      ],
    );
    this.addEvent({
      runId: input.runId,
      stepId: id,
      level: "info",
      type: status === "queued" ? "step_queued" : "step_started",
      message: input.name,
      data: input.input,
    });
    return this.getStep(id)!;
  }

  startStep(id: string): PipelineStepRecord {
    this.db.run(`UPDATE pipeline_steps SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`, [now(), id]);
    const step = this.getStep(id)!;
    this.addEvent({ runId: step.runId, stepId: id, level: "info", type: "step_started", message: step.name, data: step.input });
    return step;
  }

  completeStep(input: {
    id: string;
    status: PipelineStatus;
    result: JsonObject | null;
    output?: JsonObject | null;
    error?: string | null;
    wingmanSessionId?: string | null;
  }): PipelineStepRecord {
    this.db.run(
      `UPDATE pipeline_steps
       SET status = ?, result_json = ?, output_json = COALESCE(?, output_json), error = ?, wingman_session_id = COALESCE(?, wingman_session_id), completed_at = ?
       WHERE id = ?`,
      [
        input.status,
        input.result ? encodeJson(input.result) : null,
        input.output ? encodeJson(input.output) : null,
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

  setStepCallbackToken(stepId: string, token: string): void {
    this.db.run(`UPDATE pipeline_steps SET callback_token = ? WHERE id = ?`, [token, stepId]);
  }

  updateRunProgress(runId: string, current: JsonObject, cursorIndex: number): void {
    this.db.run(
      `UPDATE pipeline_runs SET current_json = ?, cursor_index = ?, active_step_id = NULL WHERE id = ?`,
      [encodeJson(current), cursorIndex, runId],
    );
  }

  setRunActiveStep(runId: string, stepId: string | null): void {
    this.db.run(`UPDATE pipeline_runs SET active_step_id = ? WHERE id = ?`, [stepId, runId]);
  }

  getRun(id: string): PipelineRunRecord | null {
    const row = this.db.query(`SELECT * FROM pipeline_runs WHERE id = ?`).get(id) as Record<string, unknown> | null;
    return row ? mapRun(row) : null;
  }

  getRunSummary(id: string): PipelineRunSummary | null {
    const row = this.db.query(runSummarySelectSql(`WHERE id = ?`)).get(id) as Record<string, unknown> | null;
    return row ? mapRunSummary(row) : null;
  }

  getStep(id: string): PipelineStepRecord | null {
    const row = this.db.query(`SELECT * FROM pipeline_steps WHERE id = ?`).get(id) as Record<string, unknown> | null;
    return row ? mapStep(row) : null;
  }

  listRunSummaries(options: { ownerNpub?: string | null; includeShared?: boolean; limit?: number } = {}): PipelineRunSummary[] {
    const limit = options.limit ?? 100;
    let rows: Record<string, unknown>[];
    if (options.ownerNpub) {
      rows = this.db.query(
        runSummarySelectSql(`
          WHERE owner_npub = ? OR (? = 1 AND scope = 'shared')
          ORDER BY started_at DESC LIMIT ?
        `),
      ).all(options.ownerNpub, options.includeShared ? 1 : 0, limit) as Record<string, unknown>[];
    } else {
      rows = this.db.query(runSummarySelectSql(`ORDER BY started_at DESC LIMIT ?`)).all(limit) as Record<string, unknown>[];
    }
    return rows.map(mapRunSummary);
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

  listChildSteps(parentStepId: string): PipelineStepRecord[] {
    const rows = this.db
      .query(`SELECT * FROM pipeline_steps WHERE parent_step_id = ? ORDER BY step_index ASC`)
      .all(parentStepId) as Record<string, unknown>[];
    return rows.map(mapStep);
  }

  listRunningRuns(): PipelineRunRecord[] {
    const rows = this.db
      .query(`SELECT * FROM pipeline_runs WHERE status = 'running' ORDER BY started_at ASC`)
      .all() as Record<string, unknown>[];
    return rows.map(mapRun);
  }

  listStepSummaries(runId: string): PipelineStepSummary[] {
    const rows = this.db
      .query(`
        SELECT
          id, run_id, step_index, name, kind, status, error, wingman_session_id,
          parent_step_id, logical_key, callback_token, started_at, completed_at,
          length(coalesce(input_json, '')) AS input_bytes,
          length(coalesce(result_json, '')) AS result_bytes
        FROM pipeline_steps
        WHERE run_id = ?
        ORDER BY step_index ASC
      `)
      .all(runId) as Record<string, unknown>[];
    return rows.map(mapStepSummary);
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
        current_json TEXT NOT NULL DEFAULT '{}',
        cursor_index INTEGER NOT NULL DEFAULT 0,
        active_step_id TEXT,
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
        parent_step_id TEXT,
        logical_key TEXT,
        callback_token TEXT,
        output_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      )
    `);
    this.ensureColumn("pipeline_runs", "current_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("pipeline_runs", "cursor_index", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("pipeline_runs", "active_step_id", "TEXT");
    this.db.run(`UPDATE pipeline_runs SET current_json = input_json WHERE status = 'running' AND cursor_index = 0 AND current_json = '{}'`);
    this.ensureColumn("pipeline_steps", "parent_step_id", "TEXT");
    this.ensureColumn("pipeline_steps", "logical_key", "TEXT");
    this.ensureColumn("pipeline_steps", "output_json", "TEXT");
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_steps_run_order ON pipeline_steps(run_id, step_index)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_steps_parent_order ON pipeline_steps(parent_step_id, step_index)`);
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

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (!rows.some((row) => row.name === column)) {
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
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
    current: decodeJsonObject(row.current_json ?? row.input_json),
    cursorIndex: Number(row.cursor_index ?? 0),
    activeStepId: row.active_step_id === null || row.active_step_id === undefined ? null : String(row.active_step_id),
    result: decodeNullableJsonObject(row.result_json),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
  };
}

function runSummarySelectSql(suffix: string): string {
  return `
    SELECT
      id, definition_id, definition_path, name, status, owner_npub, owner_alias, scope,
      cursor_index, active_step_id, error, started_at, completed_at,
      length(coalesce(input_json, '')) AS input_bytes,
      length(coalesce(current_json, '')) AS current_bytes,
      length(coalesce(result_json, '')) AS result_bytes
    FROM pipeline_runs
    ${suffix}
  `;
}

function mapRunSummary(row: Record<string, unknown>): PipelineRunSummary {
  const inputBytes = Number(row.input_bytes ?? 0);
  const currentBytes = Number(row.current_bytes ?? 0);
  const resultBytes = Number(row.result_bytes ?? 0);
  return {
    id: String(row.id),
    definitionId: String(row.definition_id),
    definitionPath: row.definition_path === null || row.definition_path === undefined ? null : String(row.definition_path),
    name: String(row.name),
    status: row.status as PipelineStatus,
    ownerNpub: row.owner_npub === null || row.owner_npub === undefined ? null : String(row.owner_npub),
    ownerAlias: row.owner_alias === null || row.owner_alias === undefined ? null : String(row.owner_alias),
    scope: row.scope as PipelineScope,
    cursorIndex: Number(row.cursor_index ?? 0),
    activeStepId: row.active_step_id === null || row.active_step_id === undefined ? null : String(row.active_step_id),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
    inputBytes,
    currentBytes,
    resultBytes,
    hasInput: inputBytes > 0,
    hasCurrent: currentBytes > 0,
    hasResult: resultBytes > 0,
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
    parentStepId: row.parent_step_id === null || row.parent_step_id === undefined ? null : String(row.parent_step_id),
    logicalKey: row.logical_key === null || row.logical_key === undefined ? null : String(row.logical_key),
    callbackToken: row.callback_token === null || row.callback_token === undefined ? null : String(row.callback_token),
    output: decodeNullableJsonObject(row.output_json),
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
  };
}

function mapStepSummary(row: Record<string, unknown>): PipelineStepSummary {
  const inputBytes = Number(row.input_bytes ?? 0);
  const resultBytes = Number(row.result_bytes ?? 0);
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stepIndex: Number(row.step_index),
    name: String(row.name),
    kind: row.kind as StepKind,
    status: row.status as PipelineStatus,
    error: row.error === null || row.error === undefined ? null : String(row.error),
    wingmanSessionId: row.wingman_session_id === null || row.wingman_session_id === undefined ? null : String(row.wingman_session_id),
    parentStepId: row.parent_step_id === null || row.parent_step_id === undefined ? null : String(row.parent_step_id),
    logicalKey: row.logical_key === null || row.logical_key === undefined ? null : String(row.logical_key),
    callbackToken: row.callback_token === null || row.callback_token === undefined ? null : String(row.callback_token),
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
    inputBytes,
    resultBytes,
    hasInput: inputBytes > 0,
    hasResult: resultBytes > 0,
  };
}
