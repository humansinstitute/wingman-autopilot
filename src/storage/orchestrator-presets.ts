import { randomUUID } from "node:crypto";
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

export interface CreateOrchestratorPresetInput {
  id?: string;
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
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
  }

  listPresets(): OrchestratorPresetSummary[] {
    const statement = this.db.prepare(
      `SELECT id, label, agent
       FROM orchestrator_presets
       ORDER BY label`,
    );
    return statement.all() as OrchestratorPresetSummary[];
  }

  getPreset(id: string): OrchestratorPresetRecord | null {
    const statement = this.db.prepare(
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
    const record = statement.get(id);
    return (record as OrchestratorPresetRecord | undefined) ?? null;
  }

  ensurePreset(input: OrchestratorPresetInput) {
    const existing = this.getPreset(input.id);
    if (existing) {
      const updates: string[] = [];
      const values: unknown[] = [];

      const applyUpdate = <Key extends keyof OrchestratorPresetInput>(
        field: Key,
        column: string,
      ) => {
        if (Object.prototype.hasOwnProperty.call(input, field)) {
          const newValue = input[field];
          const existingValue = existing[field as keyof OrchestratorPresetRecord];
          if (newValue !== existingValue) {
            updates.push(`${column} = ?${updates.length + 1}`);
            values.push(newValue ?? null);
          }
        }
      };

      applyUpdate("label", "label");
      applyUpdate("agent", "agent");
      applyUpdate("templateDir", "template_dir");
      applyUpdate("activeRoot", "active_root");
      applyUpdate("directoryPrefix", "directory_prefix");
      applyUpdate("workingDirectory", "working_directory");
      applyUpdate("introMessage", "intro_message");
      applyUpdate("pollTimeoutMs", "poll_timeout_ms");
      applyUpdate("pollIntervalMs", "poll_interval_ms");
      applyUpdate("retryAttempts", "retry_attempts");
      applyUpdate("retryDelayMs", "retry_delay_ms");

      if (updates.length > 0) {
        const now = new Date().toISOString();
        const statement = this.db.prepare(
          `UPDATE orchestrator_presets
             SET ${updates.join(", ")}, updated_at = ?${updates.length + 1}
           WHERE id = ?${updates.length + 2}`,
        );
        statement.run(...values, now, input.id);
        return this.getPreset(input.id);
      }

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

  createPreset(input: CreateOrchestratorPresetInput): OrchestratorPresetRecord {
    const id = (input.id ?? this.generateId(input.label)).trim();
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
      id,
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

    const record = this.getPreset(id);
    if (!record) {
      throw new Error("Failed to create orchestrator preset");
    }
    return record;
  }

  private generateId(label: string): string {
    const base = label
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const randomSuffix = randomUUID().slice(0, 8);
    const slug = base.length > 0 ? base : "preset";
    return `${slug}-${randomSuffix}`;
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
