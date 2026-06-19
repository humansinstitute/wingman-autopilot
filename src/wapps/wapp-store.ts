import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { databaseFile } from "../storage/message-store";
import { decryptSettingValue, encryptSettingValue, isEncryptedSettingValue } from "../storage/setting-value-crypto";
import { normalizeWappScopeLineage } from "./scope-access";
import type {
  CreateWappInput,
  CreateWappTowerBindingInput,
  UpdateWappInput,
  UpdateWappTowerBindingInput,
  WappAppKeyMode,
  WappRecord,
  WappRecordState,
  WappSchedule,
  WappScopeLineage,
  WappStatus,
  WappTowerBinding,
} from "./types";

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
  tower_binding_id: string | null;
  app_npub: string | null;
  app_nsec_encrypted?: string | null;
  status?: WappStatus;
  schedule_json?: string | null;
  record_state: WappRecordState;
  created_at: string;
  updated_at: string;
  last_published_at: string | null;
}

interface WappTowerBindingRow {
  id: string;
  label: string;
  tower_url: string;
  workspace_owner_npub: string;
  user_alias: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function decodeNsec(value: string): Uint8Array {
  const raw = value.trim();
  if (raw.startsWith("nsec1")) {
    const decoded = nip19.decode(raw);
    if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
      throw new Error("APP_NSEC must be a valid nsec value");
    }
    return decoded.data;
  }
  if (/^[a-fA-F0-9]{64}$/.test(raw)) {
    return Uint8Array.from(Buffer.from(raw, "hex"));
  }
  throw new Error("APP_NSEC must be nsec1... or 64-char hex");
}

function deriveNpubFromNsec(nsec: string): string {
  return nip19.npubEncode(getPublicKey(decodeNsec(nsec)));
}

function createAppNsec(mode: WappAppKeyMode | undefined, importedNsec: string | null | undefined): string {
  if (mode === "import") {
    if (!importedNsec?.trim()) {
      throw new Error("APP_NSEC is required when importing a WApp app key");
    }
    decodeNsec(importedNsec);
    return importedNsec.trim();
  }
  if (importedNsec?.trim()) {
    decodeNsec(importedNsec);
    return importedNsec.trim();
  }
  return nip19.nsecEncode(generateSecretKey());
}

function rowToTowerBinding(row: WappTowerBindingRow): WappTowerBinding {
  return {
    id: row.id,
    label: row.label,
    towerUrl: row.tower_url,
    workspaceOwnerNpub: row.workspace_owner_npub,
    userAlias: row.user_alias,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    towerBindingId: row.tower_binding_id,
    towerBinding: null,
    appNpub: row.app_npub,
    status: row.status === "archived" ? "archived" : "active",
    schedule: parseJson<WappSchedule | null>(row.schedule_json ?? null, null),
    recordState: row.record_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastPublishedAt: row.last_published_at,
  };
}

function trimRequired(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
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
    this.ensureColumn("wapp_records", "status", "TEXT NOT NULL DEFAULT 'active'");
    this.ensureColumn("wapp_records", "schedule_json", "TEXT");
    this.ensureColumn("wapp_records", "tower_binding_id", "TEXT");
    this.ensureColumn("wapp_records", "app_npub", "TEXT");
    this.ensureColumn("wapp_records", "app_nsec_encrypted", "TEXT");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wapp_tower_bindings (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        tower_url TEXT NOT NULL,
        workspace_owner_npub TEXT NOT NULL,
        user_alias TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_wapp_records_app_id ON wapp_records(app_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_wapp_records_owner ON wapp_records(owner_npub)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_wapp_records_scope ON wapp_records(workspace_owner_npub, scope_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_wapp_records_tower_binding ON wapp_records(tower_binding_id)");
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_wapp_tower_bindings_default ON wapp_tower_bindings(is_default) WHERE is_default = 1");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) return;
    this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  list(): WappRecord[] {
    return (this.db.query("SELECT * FROM wapp_records ORDER BY updated_at DESC").all() as WappRow[]).map((row) => this.hydrateRecord(row));
  }

  get(id: string): WappRecord | null {
    const row = this.db.query("SELECT * FROM wapp_records WHERE id = ?").get(id) as WappRow | null;
    return row ? this.hydrateRecord(row) : null;
  }

  getByAppId(appId: string): WappRecord | null {
    const row = this.db.query("SELECT * FROM wapp_records WHERE app_id = ? AND record_state = 'active' ORDER BY updated_at DESC LIMIT 1").get(appId) as WappRow | null;
    return row ? this.hydrateRecord(row) : null;
  }

  listTowerBindings(): WappTowerBinding[] {
    return (this.db.query("SELECT * FROM wapp_tower_bindings ORDER BY is_default DESC, label ASC").all() as WappTowerBindingRow[])
      .map(rowToTowerBinding);
  }

  getTowerBinding(id: string): WappTowerBinding | null {
    const row = this.db.query("SELECT * FROM wapp_tower_bindings WHERE id = ?").get(id) as WappTowerBindingRow | null;
    return row ? rowToTowerBinding(row) : null;
  }

  getDefaultTowerBinding(): WappTowerBinding | null {
    const row = this.db.query("SELECT * FROM wapp_tower_bindings WHERE is_default = 1 LIMIT 1").get() as WappTowerBindingRow | null;
    return row ? rowToTowerBinding(row) : null;
  }

  createTowerBinding(input: CreateWappTowerBindingInput): WappTowerBinding {
    const now = new Date().toISOString();
    const id = input.id?.trim() || randomUUID();
    const isDefault = input.isDefault === true ? 1 : 0;
    if (isDefault) this.clearDefaultTowerBinding();
    this.db.query(`
      INSERT INTO wapp_tower_bindings (
        id, label, tower_url, workspace_owner_npub, user_alias, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      trimRequired(input.label, "label"),
      trimRequired(input.towerUrl, "towerUrl"),
      trimRequired(input.workspaceOwnerNpub, "workspaceOwnerNpub"),
      input.userAlias?.trim() || null,
      isDefault,
      now,
      now,
    );
    return this.getTowerBinding(id)!;
  }

  updateTowerBinding(id: string, input: UpdateWappTowerBindingInput): WappTowerBinding | null {
    const existing = this.getTowerBinding(id);
    if (!existing) return null;
    const sets: string[] = [];
    const values: SQLQueryBindings[] = [];
    const add = (column: string, value: SQLQueryBindings) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (input.label !== undefined) add("label", trimRequired(input.label, "label"));
    if (input.towerUrl !== undefined) add("tower_url", trimRequired(input.towerUrl, "towerUrl"));
    if (input.workspaceOwnerNpub !== undefined) add("workspace_owner_npub", trimRequired(input.workspaceOwnerNpub, "workspaceOwnerNpub"));
    if (input.userAlias !== undefined) add("user_alias", input.userAlias?.trim() || null);
    if (input.isDefault !== undefined) {
      if (input.isDefault) this.clearDefaultTowerBinding(id);
      add("is_default", input.isDefault ? 1 : 0);
    }
    if (sets.length === 0) return existing;
    add("updated_at", new Date().toISOString());
    values.push(id);
    this.db.query(`UPDATE wapp_tower_bindings SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.getTowerBinding(id);
  }

  create(input: CreateWappInput): WappRecord {
    const now = new Date().toISOString();
    const id = input.id?.trim() || randomUUID();
    const lineage = normalizeWappScopeLineage(input.scopeId, input.scopeLineage);
    const appKey = this.resolveCreateAppKey(input.towerBindingId ?? null, input.appKeyMode, input.appNsec);
    this.db.query(`
      INSERT INTO wapp_records (
        id, app_id, title, description, owner_npub, created_by_npub, workspace_owner_npub,
        scope_id, scope_lineage_json, allowed_npubs_json, launch_url, source_wingman_url,
        subdomain_alias, tower_binding_id, app_npub, app_nsec_encrypted, status, schedule_json,
        record_state, created_at, updated_at, last_published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
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
      appKey.towerBindingId,
      appKey.appNpub,
      appKey.encryptedAppNsec,
      input.status ?? "active",
      input.schedule ? JSON.stringify(input.schedule) : null,
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
    if (input.towerBindingId !== undefined || input.appNsec !== undefined || input.appKeyMode !== undefined) {
      const appKey = this.resolveUpdateAppKey(existing, input.towerBindingId, input.appKeyMode, input.appNsec);
      add("tower_binding_id", appKey.towerBindingId);
      add("app_npub", appKey.appNpub);
      add("app_nsec_encrypted", appKey.encryptedAppNsec);
    }
    if (input.status !== undefined) add("status", input.status);
    if (input.schedule !== undefined) add("schedule_json", input.schedule ? JSON.stringify(input.schedule) : null);
    if (input.recordState !== undefined) add("record_state", input.recordState);
    if (input.lastPublishedAt !== undefined) add("last_published_at", input.lastPublishedAt);
    if (sets.length === 0) return existing;
    add("updated_at", new Date().toISOString());
    values.push(id);
    this.db.query(`UPDATE wapp_records SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  archive(id: string): WappRecord | null {
    return this.update(id, { status: "archived", recordState: "archived" });
  }

  markDeleted(id: string): WappRecord | null {
    return this.update(id, { status: "archived", recordState: "deleted" });
  }

  getAppNsec(id: string): string | null {
    const row = this.db.query("SELECT app_nsec_encrypted FROM wapp_records WHERE id = ?").get(id) as { app_nsec_encrypted: string | null } | null;
    if (!row?.app_nsec_encrypted) return null;
    return decryptSettingValue(row.app_nsec_encrypted);
  }

  private clearDefaultTowerBinding(exceptId: string | null = null): void {
    if (exceptId) {
      this.db.query("UPDATE wapp_tower_bindings SET is_default = 0 WHERE id != ?").run(exceptId);
      return;
    }
    this.db.run("UPDATE wapp_tower_bindings SET is_default = 0");
  }

  private hydrateRecord(row: WappRow): WappRecord {
    const record = rowToRecord(row);
    record.towerBinding = record.towerBindingId ? this.getTowerBinding(record.towerBindingId) : null;
    if (row.app_nsec_encrypted && !isEncryptedSettingValue(row.app_nsec_encrypted)) {
      this.db.query("UPDATE wapp_records SET app_nsec_encrypted = ? WHERE id = ?")
        .run(encryptSettingValue(row.app_nsec_encrypted), row.id);
    }
    return record;
  }

  private resolveCreateAppKey(
    towerBindingId: string | null,
    appKeyMode: WappAppKeyMode | undefined,
    appNsec: string | null | undefined,
  ): { towerBindingId: string | null; appNpub: string | null; encryptedAppNsec: string | null } {
    if (!towerBindingId) {
      if (appKeyMode === "import" || appNsec?.trim()) {
        throw new Error("towerBindingId is required when configuring a WApp app key");
      }
      return { towerBindingId: null, appNpub: null, encryptedAppNsec: null };
    }
    if (!this.getTowerBinding(towerBindingId)) {
      throw new Error(`Unknown WApp Tower binding: ${towerBindingId}`);
    }
    const nsec = createAppNsec(appKeyMode, appNsec);
    return {
      towerBindingId,
      appNpub: deriveNpubFromNsec(nsec),
      encryptedAppNsec: encryptSettingValue(nsec),
    };
  }

  private resolveUpdateAppKey(
    existing: WappRecord,
    towerBindingId: string | null | undefined,
    appKeyMode: WappAppKeyMode | undefined,
    appNsec: string | null | undefined,
  ): { towerBindingId: string | null; appNpub: string | null; encryptedAppNsec: string | null } {
    const nextBindingId = towerBindingId === undefined ? existing.towerBindingId : towerBindingId;
    if (!nextBindingId) {
      return { towerBindingId: null, appNpub: null, encryptedAppNsec: null };
    }
    if (!this.getTowerBinding(nextBindingId)) {
      throw new Error(`Unknown WApp Tower binding: ${nextBindingId}`);
    }
    const existingNsec = this.getAppNsec(existing.id);
    if (appKeyMode === undefined && appNsec === undefined && existingNsec && existing.towerBindingId === nextBindingId) {
      return {
        towerBindingId: nextBindingId,
        appNpub: existing.appNpub,
        encryptedAppNsec: encryptSettingValue(existingNsec),
      };
    }
    const nsec = createAppNsec(appKeyMode, appNsec);
    return {
      towerBindingId: nextBindingId,
      appNpub: deriveNpubFromNsec(nsec),
      encryptedAppNsec: encryptSettingValue(nsec),
    };
  }
}

export const wappStore = new WappStore();
