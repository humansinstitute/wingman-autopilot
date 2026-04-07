import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';
import type { SQLQueryBindings } from 'bun:sqlite';

import { databaseFile } from '../storage/message-store';
import type { WorkspaceSubscriptionRecord } from './types';

const DEFAULT_DB_PATH = databaseFile;

function parseJsonValue<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function serialiseJsonValue(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

class WorkspaceSubscriptionStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.initialise();
  }

  listForManagerNpub(npub: string): WorkspaceSubscriptionRecord[] {
    return this.listWhere('managed_by_npub = ?1', [npub]);
  }

  listStartupCandidates(): WorkspaceSubscriptionRecord[] {
    return this.listWhere(
      "sse_status != 'disabled' AND health_status IN ('healthy', 'degraded')",
      [],
    );
  }

  getBySubscriptionId(subscriptionId: string): WorkspaceSubscriptionRecord | null {
    return this.getWhere('subscription_id = ?1', [subscriptionId]);
  }

  getByWorkspaceAndBot(workspaceOwnerNpub: string, botNpub: string): WorkspaceSubscriptionRecord | null {
    return this.getWhere(
      'workspace_owner_npub = ?1 AND bot_npub = ?2',
      [workspaceOwnerNpub, botNpub],
    );
  }

  save(record: WorkspaceSubscriptionRecord): WorkspaceSubscriptionRecord {
    this.db.query(
      `INSERT INTO workspace_subscriptions (
         subscription_id, workspace_owner_npub, backend_base_url, bot_npub, source_app_npub,
         ws_key_npub, ws_key_status, group_key_status, sse_status, health_status,
         trigger_config_record_id, last_sse_event_id, last_auth_ok_at, last_group_refresh_at,
         last_error_code, last_error_at, created_at, updated_at, managed_by_npub,
         ws_key_blob_json, wrapped_group_keys_json, last_auth_result_json,
         last_group_refresh_result_json, last_decrypt_result_json, last_sse_event_json,
         last_successful_startup_reload_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5,
         ?6, ?7, ?8, ?9, ?10,
         ?11, ?12, ?13, ?14,
         ?15, ?16, ?17, ?18, ?19,
         ?20, ?21, ?22,
         ?23, ?24, ?25,
         ?26
       )
       ON CONFLICT(subscription_id) DO UPDATE SET
         workspace_owner_npub = excluded.workspace_owner_npub,
         backend_base_url = excluded.backend_base_url,
         bot_npub = excluded.bot_npub,
         source_app_npub = excluded.source_app_npub,
         ws_key_npub = excluded.ws_key_npub,
         ws_key_status = excluded.ws_key_status,
         group_key_status = excluded.group_key_status,
         sse_status = excluded.sse_status,
         health_status = excluded.health_status,
         trigger_config_record_id = excluded.trigger_config_record_id,
         last_sse_event_id = excluded.last_sse_event_id,
         last_auth_ok_at = excluded.last_auth_ok_at,
         last_group_refresh_at = excluded.last_group_refresh_at,
         last_error_code = excluded.last_error_code,
         last_error_at = excluded.last_error_at,
         updated_at = excluded.updated_at,
         managed_by_npub = excluded.managed_by_npub,
         ws_key_blob_json = excluded.ws_key_blob_json,
         wrapped_group_keys_json = excluded.wrapped_group_keys_json,
         last_auth_result_json = excluded.last_auth_result_json,
         last_group_refresh_result_json = excluded.last_group_refresh_result_json,
         last_decrypt_result_json = excluded.last_decrypt_result_json,
         last_sse_event_json = excluded.last_sse_event_json,
         last_successful_startup_reload_at = excluded.last_successful_startup_reload_at`,
    ).run(
      record.subscriptionId,
      record.workspaceOwnerNpub,
      record.backendBaseUrl,
      record.botNpub,
      record.sourceAppNpub,
      record.wsKeyNpub,
      record.wsKeyStatus,
      record.groupKeyStatus,
      record.sseStatus,
      record.healthStatus,
      record.triggerConfigRecordId,
      record.lastSseEventId,
      record.lastAuthOkAt,
      record.lastGroupRefreshAt,
      record.lastErrorCode,
      record.lastErrorAt,
      record.createdAt,
      record.updatedAt,
      record.managedByNpub,
      record.wsKeyBlobJson,
      record.wrappedGroupKeysJson,
      serialiseJsonValue(record.lastAuthResult),
      serialiseJsonValue(record.lastGroupRefreshResult),
      serialiseJsonValue(record.lastDecryptResult),
      serialiseJsonValue(record.lastSseEvent),
      record.lastSuccessfulStartupReloadAt,
    );

    return this.getBySubscriptionId(record.subscriptionId) ?? record;
  }

  createDefault(input: {
    managedByNpub: string;
    workspaceOwnerNpub: string;
    backendBaseUrl: string;
    botNpub: string;
    sourceAppNpub: string;
    triggerConfigRecordId?: string | null;
  }): WorkspaceSubscriptionRecord {
    const now = new Date().toISOString();
    return {
      subscriptionId: randomUUID(),
      workspaceOwnerNpub: input.workspaceOwnerNpub,
      backendBaseUrl: input.backendBaseUrl,
      botNpub: input.botNpub,
      sourceAppNpub: input.sourceAppNpub,
      wsKeyNpub: null,
      wsKeyStatus: 'pending',
      groupKeyStatus: 'pending',
      sseStatus: 'disconnected',
      healthStatus: 'degraded',
      triggerConfigRecordId: input.triggerConfigRecordId ?? null,
      lastSseEventId: null,
      lastAuthOkAt: null,
      lastGroupRefreshAt: null,
      lastErrorCode: null,
      lastErrorAt: null,
      createdAt: now,
      updatedAt: now,
      managedByNpub: input.managedByNpub,
      wsKeyBlobJson: null,
      wrappedGroupKeysJson: null,
      lastAuthResult: null,
      lastGroupRefreshResult: null,
      lastDecryptResult: null,
      lastSseEvent: null,
      lastSuccessfulStartupReloadAt: null,
    };
  }

  delete(subscriptionId: string): boolean {
    const result = this.db
      .query('DELETE FROM workspace_subscriptions WHERE subscription_id = ?1')
      .run(subscriptionId);
    return result.changes > 0;
  }

  private listWhere(whereClause: string, args: SQLQueryBindings[]): WorkspaceSubscriptionRecord[] {
    return this.db
      .query(
        `SELECT
           subscription_id,
           workspace_owner_npub,
           backend_base_url,
           bot_npub,
           source_app_npub,
           ws_key_npub,
           ws_key_status,
           group_key_status,
           sse_status,
           health_status,
           trigger_config_record_id,
           last_sse_event_id,
           last_auth_ok_at,
           last_group_refresh_at,
           last_error_code,
           last_error_at,
           created_at,
           updated_at,
           managed_by_npub,
           ws_key_blob_json,
           wrapped_group_keys_json,
           last_auth_result_json,
           last_group_refresh_result_json,
           last_decrypt_result_json,
           last_sse_event_json,
           last_successful_startup_reload_at
         FROM workspace_subscriptions
         WHERE ${whereClause}
         ORDER BY updated_at DESC`,
      )
      .all(...args)
      .map((row) => this.mapRow(row as Record<string, string | null>));
  }

  private getWhere(whereClause: string, args: SQLQueryBindings[]): WorkspaceSubscriptionRecord | null {
    const row = this.db
      .query(
        `SELECT
           subscription_id,
           workspace_owner_npub,
           backend_base_url,
           bot_npub,
           source_app_npub,
           ws_key_npub,
           ws_key_status,
           group_key_status,
           sse_status,
           health_status,
           trigger_config_record_id,
           last_sse_event_id,
           last_auth_ok_at,
           last_group_refresh_at,
           last_error_code,
           last_error_at,
           created_at,
           updated_at,
           managed_by_npub,
           ws_key_blob_json,
           wrapped_group_keys_json,
           last_auth_result_json,
           last_group_refresh_result_json,
           last_decrypt_result_json,
           last_sse_event_json,
           last_successful_startup_reload_at
         FROM workspace_subscriptions
         WHERE ${whereClause}
         LIMIT 1`,
      )
      .get(...args) as Record<string, string | null> | null;
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: Record<string, string | null>): WorkspaceSubscriptionRecord {
    return {
      subscriptionId: row.subscription_id!,
      workspaceOwnerNpub: row.workspace_owner_npub!,
      backendBaseUrl: row.backend_base_url!,
      botNpub: row.bot_npub!,
      sourceAppNpub: row.source_app_npub!,
      wsKeyNpub: row.ws_key_npub ?? null,
      wsKeyStatus: row.ws_key_status as WorkspaceSubscriptionRecord['wsKeyStatus'],
      groupKeyStatus: row.group_key_status as WorkspaceSubscriptionRecord['groupKeyStatus'],
      sseStatus: row.sse_status as WorkspaceSubscriptionRecord['sseStatus'],
      healthStatus: row.health_status as WorkspaceSubscriptionRecord['healthStatus'],
      triggerConfigRecordId: row.trigger_config_record_id ?? null,
      lastSseEventId: row.last_sse_event_id ?? null,
      lastAuthOkAt: row.last_auth_ok_at ?? null,
      lastGroupRefreshAt: row.last_group_refresh_at ?? null,
      lastErrorCode: row.last_error_code ?? null,
      lastErrorAt: row.last_error_at ?? null,
      createdAt: row.created_at!,
      updatedAt: row.updated_at!,
      managedByNpub: row.managed_by_npub ?? null,
      wsKeyBlobJson: row.ws_key_blob_json ?? null,
      wrappedGroupKeysJson: row.wrapped_group_keys_json ?? null,
      lastAuthResult: parseJsonValue(row.last_auth_result_json ?? null),
      lastGroupRefreshResult: parseJsonValue(row.last_group_refresh_result_json ?? null),
      lastDecryptResult: parseJsonValue(row.last_decrypt_result_json ?? null),
      lastSseEvent: parseJsonValue(row.last_sse_event_json ?? null),
      lastSuccessfulStartupReloadAt: row.last_successful_startup_reload_at ?? null,
    };
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_subscriptions (
        subscription_id TEXT PRIMARY KEY,
        workspace_owner_npub TEXT NOT NULL,
        backend_base_url TEXT NOT NULL,
        bot_npub TEXT NOT NULL,
        source_app_npub TEXT NOT NULL,
        ws_key_npub TEXT,
        ws_key_status TEXT NOT NULL,
        group_key_status TEXT NOT NULL,
        sse_status TEXT NOT NULL,
        health_status TEXT NOT NULL,
        trigger_config_record_id TEXT,
        last_sse_event_id TEXT,
        last_auth_ok_at TEXT,
        last_group_refresh_at TEXT,
        last_error_code TEXT,
        last_error_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        managed_by_npub TEXT,
        ws_key_blob_json TEXT,
        wrapped_group_keys_json TEXT,
        last_auth_result_json TEXT,
        last_group_refresh_result_json TEXT,
        last_decrypt_result_json TEXT,
        last_sse_event_json TEXT,
        last_successful_startup_reload_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_subscriptions_workspace_bot
        ON workspace_subscriptions(workspace_owner_npub, bot_npub);

      CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_managed_by
        ON workspace_subscriptions(managed_by_npub);

      CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_health
        ON workspace_subscriptions(health_status, sse_status);
    `);
  }
}

export const workspaceSubscriptionStore = new WorkspaceSubscriptionStore();
export { WorkspaceSubscriptionStore };
