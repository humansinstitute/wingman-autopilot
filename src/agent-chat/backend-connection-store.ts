import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';
import type { SQLQueryBindings } from 'bun:sqlite';

import { databaseFile } from '../storage/message-store';
import type { BackendConnectionRecord } from './types';

const DEFAULT_DB_PATH = databaseFile;

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [];
  } catch {
    return [];
  }
}

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

class BackendConnectionStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.initialise();
  }

  listForManagerNpub(npub: string): BackendConnectionRecord[] {
    return this.listWhere('managed_by_npub = ?1', [npub]);
  }

  getById(backendConnectionId: string): BackendConnectionRecord | null {
    return this.getWhere('backend_connection_id = ?1', [backendConnectionId]);
  }

  findReusable(input: {
    managedByNpub: string;
    backendBaseUrl: string;
    serviceNpub?: string | null;
  }): BackendConnectionRecord | null {
    if (input.serviceNpub) {
      const match = this.getWhere(
        'managed_by_npub = ?1 AND backend_base_url = ?2 AND service_npub = ?3',
        [input.managedByNpub, input.backendBaseUrl, input.serviceNpub],
      );
      if (match) {
        return match;
      }
    }
    return this.getWhere(
      'managed_by_npub = ?1 AND backend_base_url = ?2 AND service_npub IS NULL',
      [input.managedByNpub, input.backendBaseUrl],
    );
  }

  createDefault(input: {
    managedByNpub: string;
    backendBaseUrl: string;
    serviceNpub?: string | null;
    relayUrls?: string[];
    openapiUrl?: string | null;
    docsUrl?: string | null;
    healthUrl?: string | null;
    supportedVersion?: string | null;
  }): BackendConnectionRecord {
    const now = new Date().toISOString();
    return {
      backendConnectionId: randomUUID(),
      managedByNpub: input.managedByNpub,
      backendBaseUrl: input.backendBaseUrl,
      serviceNpub: input.serviceNpub ?? null,
      relayUrls: input.relayUrls ?? [],
      openapiUrl: input.openapiUrl ?? null,
      docsUrl: input.docsUrl ?? null,
      healthUrl: input.healthUrl ?? null,
      supportedVersion: input.supportedVersion ?? null,
      sharePolicy: 'private',
      healthStatus: 'degraded',
      lastHealthResult: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  save(record: BackendConnectionRecord): BackendConnectionRecord {
    this.db.query(
      `INSERT INTO backend_connections (
         backend_connection_id, managed_by_npub, backend_base_url, service_npub,
         relay_urls_json, openapi_url, docs_url, health_url, supported_version,
         share_policy, health_status, last_health_result_json, created_at, updated_at
       ) VALUES (
         ?1, ?2, ?3, ?4,
         ?5, ?6, ?7, ?8, ?9,
         ?10, ?11, ?12, ?13, ?14
       )
       ON CONFLICT(backend_connection_id) DO UPDATE SET
         managed_by_npub = excluded.managed_by_npub,
         backend_base_url = excluded.backend_base_url,
         service_npub = excluded.service_npub,
         relay_urls_json = excluded.relay_urls_json,
         openapi_url = excluded.openapi_url,
         docs_url = excluded.docs_url,
         health_url = excluded.health_url,
         supported_version = excluded.supported_version,
         share_policy = excluded.share_policy,
         health_status = excluded.health_status,
         last_health_result_json = excluded.last_health_result_json,
         updated_at = excluded.updated_at`,
    ).run(
      record.backendConnectionId,
      record.managedByNpub,
      record.backendBaseUrl,
      record.serviceNpub,
      serialiseJsonValue(record.relayUrls),
      record.openapiUrl,
      record.docsUrl,
      record.healthUrl,
      record.supportedVersion,
      record.sharePolicy,
      record.healthStatus,
      serialiseJsonValue(record.lastHealthResult),
      record.createdAt,
      record.updatedAt,
    );
    return this.getById(record.backendConnectionId) ?? record;
  }

  private listWhere(whereClause: string, args: SQLQueryBindings[]): BackendConnectionRecord[] {
    return this.db
      .query(
        `SELECT
           backend_connection_id, managed_by_npub, backend_base_url, service_npub,
           relay_urls_json, openapi_url, docs_url, health_url, supported_version,
           share_policy, health_status, last_health_result_json, created_at, updated_at
         FROM backend_connections
         WHERE ${whereClause}
         ORDER BY updated_at DESC`,
      )
      .all(...args)
      .map((row) => this.mapRow(row as Record<string, string | null>));
  }

  private getWhere(whereClause: string, args: SQLQueryBindings[]): BackendConnectionRecord | null {
    const row = this.db
      .query(
        `SELECT
           backend_connection_id, managed_by_npub, backend_base_url, service_npub,
           relay_urls_json, openapi_url, docs_url, health_url, supported_version,
           share_policy, health_status, last_health_result_json, created_at, updated_at
         FROM backend_connections
         WHERE ${whereClause}
         LIMIT 1`,
      )
      .get(...args) as Record<string, string | null> | null;
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: Record<string, string | null>): BackendConnectionRecord {
    return {
      backendConnectionId: row.backend_connection_id!,
      managedByNpub: row.managed_by_npub!,
      backendBaseUrl: row.backend_base_url!,
      serviceNpub: row.service_npub ?? null,
      relayUrls: parseJsonArray(row.relay_urls_json ?? null),
      openapiUrl: row.openapi_url ?? null,
      docsUrl: row.docs_url ?? null,
      healthUrl: row.health_url ?? null,
      supportedVersion: row.supported_version ?? null,
      sharePolicy: row.share_policy as BackendConnectionRecord['sharePolicy'],
      healthStatus: row.health_status as BackendConnectionRecord['healthStatus'],
      lastHealthResult: parseJsonValue(row.last_health_result_json ?? null),
      createdAt: row.created_at!,
      updatedAt: row.updated_at!,
    };
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS backend_connections (
        backend_connection_id TEXT PRIMARY KEY,
        managed_by_npub TEXT NOT NULL,
        backend_base_url TEXT NOT NULL,
        service_npub TEXT,
        relay_urls_json TEXT,
        openapi_url TEXT,
        docs_url TEXT,
        health_url TEXT,
        supported_version TEXT,
        share_policy TEXT NOT NULL,
        health_status TEXT NOT NULL,
        last_health_result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_backend_connections_manager
        ON backend_connections(managed_by_npub, updated_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_connections_manager_service
        ON backend_connections(managed_by_npub, backend_base_url, service_npub);
    `);
  }
}

export const backendConnectionStore = new BackendConnectionStore();
export { BackendConnectionStore };
