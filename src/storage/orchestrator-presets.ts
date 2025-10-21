import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "./message-store";

export interface OrchestratorPresetRecord {
  id: string;
  label: string;
  agent: string;
  templateDir: string | null;
  activeRoot: string | null;
  directoryPrefix: string | null;
  workingDirectory: string | null;
  introMessage: string | null;
  pollTimeoutMs: number;
  pollIntervalMs: number;
  retryAttempts: number;
  retryDelayMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestratorPresetSummary {
  id: string;
  label: string;
  agent: string;
}

export interface OrchestratorPresetInput {
  id: string;
  label: string;
  agent: string;
  templateDir?: string | null;
  activeRoot?: string | null;
  directoryPrefix?: string | null;
  workingDirectory?: string | null;
  introMessage?: string | null;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
}

class OrchestratorPresetStore {
  private readonly db: Database;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.initialise();
  }

  listPresets(): OrchestratorPresetSummary[] {
    const statement = this.db.prepare<[], OrchestratorPresetSummary>(
      `SELECT id, label, agent
       FROM orchestrator_presets
       ORDER BY label`,
    );
    return statement.all();
  }

  getPreset(id: string): OrchestratorPresetRecord | null {
    const statement = this.db.prepare<[string], OrchestratorPresetRecord>(
      `SELECT
         id,
         label,
         agent,
         template_dir as templateDir,
         active_root as activeRoot,
         directory_prefix as directoryPrefix,
         working_directory as workingDirectory,
         intro_message as introMessage,
         poll_timeout_ms as pollTimeoutMs,
         poll_interval_ms as pollIntervalMs,
         retry_attempts as retryAttempts,
         retry_delay_ms as retryDelayMs,
         created_at as createdAt,
         updated_at as updatedAt
       FROM orchestrator_presets
       WHERE id = ?1`,
    );
    return statement.get(id) ?? null;
  }

  ensurePreset(input: OrchestratorPresetInput) {
    const existing = this.getPreset(input.id);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const statement = this.db.prepare(
      `INSERT INTO orchestrator_presets (
         id,
         label,
         agent,
         template_dir,
         active_root,
         directory_prefix,
         working_directory,
         intro_message,
         poll_timeout_ms,
         poll_interval_ms,
         retry_attempts,
         retry_delay_ms,
         created_at,
         updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)`,
    );

    statement.run(
      input.id,
      input.label,
      input.agent,
      input.templateDir ?? null,
      input.activeRoot ?? null,
      input.directoryPrefix ?? null,
      input.workingDirectory ?? null,
      input.introMessage ?? null,
      input.pollTimeoutMs ?? 30000,
      input.pollIntervalMs ?? 250,
      input.retryAttempts ?? 10,
      input.retryDelayMs ?? 1000,
      now,
    );

    return this.getPreset(input.id);
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_presets (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        agent TEXT NOT NULL,
        template_dir TEXT,
        active_root TEXT,
        directory_prefix TEXT,
        working_directory TEXT,
        intro_message TEXT,
        poll_timeout_ms INTEGER NOT NULL DEFAULT 30000,
        poll_interval_ms INTEGER NOT NULL DEFAULT 250,
        retry_attempts INTEGER NOT NULL DEFAULT 10,
        retry_delay_ms INTEGER NOT NULL DEFAULT 1000,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_orchestrator_presets_label ON orchestrator_presets(label);
    `);
  }
}

export const orchestratorPresetStore = new OrchestratorPresetStore(databaseFile);
