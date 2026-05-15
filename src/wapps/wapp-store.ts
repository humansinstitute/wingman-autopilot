import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";

import { databaseFile } from "../storage/message-store";
import { normalizeWappScopeLineage } from "./scope-access";
import type { CreateWappInput, UpdateWappInput, WappRecord, WappRecordState, WappScopeLineage } from "./types";

const defaultWappDbPath = new URL("../../data/wapps.sqlite", import.meta.url).pathname;

interface WappRow {
  id: string;
  app_id: string;
  title: string;
  description: string | null;
  owner_npub: string;
  created_by_npub: string;
  workspace_owner_npub: string;
  scope_id: string;
  scope_lineage_json: string;
  allowed_npubs_json: string;
  launch_url: string;
  source_wingman_url: string | null;
  subdomain_alias: string | null;
  record_state: WappRecordState;
  created_at: string;
  updated_at: string;
  last_published_at: string | null;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToRecord(row: WappRow): WappRecord {
  return {
    id: row.id,
    appId: row.app_id,
    title: row.title,
    description: row.description,
    ownerNpub: row.owner_npub,
    createdByNpub: row.created_by_npub,
    workspaceOwnerNpub: row.workspace_owner_npub,
    scopeId: row.scope_id,
    scopeLineage: parseJson<WappScopeLineage>(
      row.scope_lineage_json,
      normalizeWappScopeLineage(row.scope_id),
    ),
    allowedNpubs: parseJson<string[]>(row.allowed_npubs_json, []),
    launchUrl: row.launch_url,
    sourceWingmanUrl: row.source_wingman_url,
    subdomainAlias: row.subdomain_alias,
    recordState: row.record_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastPublishedAt: row.last_published_at,
  };
}

export class WappStore {
  private readonly db: Database;

  constructor(dbPath: string = defaultWappDbPath) {
    mkdirSync(dirname(dbPath || databaseFile), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wapp_records (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        owner_npub TEXT NOT NULL,
        created_by_npub TEXT NOT NULL,
        workspace_owner_npub TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        scope_lineage_json TEXT NOT NULL,
        allowed_npubs_json TEXT NOT NULL,
        launch_url TEXT NOT NULL,
        source_wingman_url TEXT,
        subdomain_alias TEXT,
        record_state TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_published_at TEXT
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_wapp_records_app_id ON wapp_records(app_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_wapp_records_owner ON wapp_records(owner_npub)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_wapp_records_scope ON wapp_records(workspace_owner_npub, scope_id)");
  }

  list(): WappRecord[] {
    return (this.db.query("SELECT * FROM wapp_records ORDER BY updated_at DESC").all() as WappRow[]).map(rowToRecord);
  }

  get(id: string): WappRecord | null {
    const row = this.db.query("SELECT * FROM wapp_records WHERE id = ?").get(id) as WappRow | null;
    return row ? rowToRecord(row) : null;
  }

  getByAppId(appId: string): WappRecord | null {
    const row = this.db.query("SELECT * FROM wapp_records WHERE app_id = ? AND record_state = 'active' ORDER BY updated_at DESC LIMIT 1").get(appId) as WappRow | null;
    return row ? rowToRecord(row) : null;
  }

  create(input: CreateWappInput): WappRecord {
    const now = new Date().toISOString();
    const id = input.id?.trim() || randomUUID();
    const lineage = normalizeWappScopeLineage(input.scopeId, input.scopeLineage);
    this.db.query(`
      INSERT INTO wapp_records (
        id, app_id, title, description, owner_npub, created_by_npub, workspace_owner_npub,
        scope_id, scope_lineage_json, allowed_npubs_json, launch_url, source_wingman_url,
        subdomain_alias, record_state, created_at, updated_at, last_published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
    `).run(
      id,
      input.appId,
      input.title,
      input.description ?? null,
      input.ownerNpub,
      input.createdByNpub,
      input.workspaceOwnerNpub,
      input.scopeId,
      JSON.stringify(lineage),
      JSON.stringify(input.allowedNpubs),
      input.launchUrl,
      input.sourceWingmanUrl ?? null,
      input.subdomainAlias ?? null,
      now,
      now,
    );
    return this.get(id)!;
  }

  update(id: string, input: UpdateWappInput): WappRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    const sets: string[] = [];
    const values: SQLQueryBindings[] = [];
    const add = (column: string, value: SQLQueryBindings) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (input.title !== undefined) add("title", input.title);
    if (input.description !== undefined) add("description", input.description);
    if (input.workspaceOwnerNpub !== undefined) add("workspace_owner_npub", input.workspaceOwnerNpub);
    if (input.scopeId !== undefined) add("scope_id", input.scopeId);
    if (input.scopeLineage !== undefined || input.scopeId !== undefined) {
      add("scope_lineage_json", JSON.stringify(normalizeWappScopeLineage(input.scopeId ?? existing.scopeId, input.scopeLineage ?? existing.scopeLineage)));
    }
    if (input.allowedNpubs !== undefined) add("allowed_npubs_json", JSON.stringify(input.allowedNpubs));
    if (input.launchUrl !== undefined) add("launch_url", input.launchUrl);
    if (input.sourceWingmanUrl !== undefined) add("source_wingman_url", input.sourceWingmanUrl);
    if (input.subdomainAlias !== undefined) add("subdomain_alias", input.subdomainAlias);
    if (input.recordState !== undefined) add("record_state", input.recordState);
    if (input.lastPublishedAt !== undefined) add("last_published_at", input.lastPublishedAt);
    if (sets.length === 0) return existing;
    add("updated_at", new Date().toISOString());
    values.push(id);
    this.db.query(`UPDATE wapp_records SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  archive(id: string): WappRecord | null {
    return this.update(id, { recordState: "archived" });
  }

  markDeleted(id: string): WappRecord | null {
    return this.update(id, { recordState: "deleted" });
  }
}

export const wappStore = new WappStore();
