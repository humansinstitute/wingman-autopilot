import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';
import type { SQLQueryBindings } from 'bun:sqlite';

import { databaseFile } from '../storage/message-store';
import type { ChatInterceptStateRecord, ChatInterceptStateStatus } from './types';

const DEFAULT_DB_PATH = databaseFile;

function hasColumn(db: Database, tableName: string, columnName: string): boolean {
  const rows = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

function normalisePendingMessageCount(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return Math.floor(numeric);
}

function normaliseState(value: unknown): ChatInterceptStateStatus {
  switch (value) {
    case 'active':
    case 'interrupting':
    case 'idle':
    case 'archived':
    case 'blocked_auth':
    case 'blocked_decrypt':
      return value;
    default:
      return 'pending';
  }
}

class ChatInterceptStateStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.initialise();
  }

  listBySubscriptionId(subscriptionId: string): ChatInterceptStateRecord[] {
    return this.listWhere('subscription_id = ?1', [subscriptionId]);
  }

  listAll(): ChatInterceptStateRecord[] {
    return this.listWhere('1 = 1', []);
  }

  getByRoutingKey(routingKey: string): ChatInterceptStateRecord | null {
    return this.getWhere('routing_key = ?1', [routingKey]);
  }

  save(record: ChatInterceptStateRecord): ChatInterceptStateRecord {
    this.db.query(
      `INSERT INTO chat_intercept_state (
         routing_key, subscription_id, session_id, session_class, workspace_owner_npub, source_app_npub,
         channel_id, thread_id, target_bot_npub, last_message_id_seen, pending_message_count, state,
         last_activity_at, created_at, updated_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5, ?6,
         ?7, ?8, ?9, ?10, ?11, ?12,
         ?13, ?14, ?15
       )
       ON CONFLICT(routing_key) DO UPDATE SET
         subscription_id = excluded.subscription_id,
         session_id = excluded.session_id,
         session_class = excluded.session_class,
         workspace_owner_npub = excluded.workspace_owner_npub,
         source_app_npub = excluded.source_app_npub,
         channel_id = excluded.channel_id,
         thread_id = excluded.thread_id,
         target_bot_npub = excluded.target_bot_npub,
         last_message_id_seen = excluded.last_message_id_seen,
         pending_message_count = excluded.pending_message_count,
         state = excluded.state,
         last_activity_at = excluded.last_activity_at,
         updated_at = excluded.updated_at`,
    ).run(
      record.routingKey,
      record.subscriptionId,
      record.sessionId,
      record.sessionClass,
      record.workspaceOwnerNpub,
      record.sourceAppNpub,
      record.channelId,
      record.threadId,
      record.targetBotNpub,
      record.lastMessageIdSeen,
      record.pendingMessageCount,
      record.state,
      record.lastActivityAt,
      record.createdAt,
      record.updatedAt,
    );

    return this.getByRoutingKey(record.routingKey) ?? record;
  }

  upsertMessage(input: {
    routingKey: string;
    subscriptionId: string;
    workspaceOwnerNpub: string;
    sourceAppNpub: string;
    channelId: string;
    threadId: string;
    targetBotNpub: string;
    messageId: string;
    at?: string;
  }): ChatInterceptStateRecord {
    const now = input.at ?? new Date().toISOString();
    const existing = this.getByRoutingKey(input.routingKey);
    const nextCount = existing
      ? existing.lastMessageIdSeen === input.messageId
        ? existing.pendingMessageCount
        : existing.pendingMessageCount + 1
      : 1;

    return this.save({
      routingKey: input.routingKey,
      subscriptionId: input.subscriptionId,
      sessionId: existing?.sessionId ?? null,
      sessionClass: 'chat',
      workspaceOwnerNpub: input.workspaceOwnerNpub,
      sourceAppNpub: input.sourceAppNpub,
      channelId: input.channelId,
      threadId: input.threadId,
      targetBotNpub: input.targetBotNpub,
      lastMessageIdSeen: input.messageId,
      pendingMessageCount: nextCount,
      state: existing?.sessionId ? existing.state : 'pending',
      lastActivityAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  private listWhere(whereClause: string, args: SQLQueryBindings[]): ChatInterceptStateRecord[] {
    return this.db
      .query(
        `SELECT
           routing_key,
           subscription_id,
           session_id,
           session_class,
           workspace_owner_npub,
           source_app_npub,
           channel_id,
           thread_id,
           target_bot_npub,
           last_message_id_seen,
           pending_message_count,
           state,
           last_activity_at,
           created_at,
           updated_at
         FROM chat_intercept_state
         WHERE ${whereClause}
         ORDER BY updated_at DESC, routing_key ASC`,
      )
      .all(...args)
      .map((row) => this.mapRow(row as Record<string, string | number | null>));
  }

  private getWhere(whereClause: string, args: SQLQueryBindings[]): ChatInterceptStateRecord | null {
    const row = this.db
      .query(
        `SELECT
           routing_key,
           subscription_id,
           session_id,
           session_class,
           workspace_owner_npub,
           source_app_npub,
           channel_id,
           thread_id,
           target_bot_npub,
           last_message_id_seen,
           pending_message_count,
           state,
           last_activity_at,
           created_at,
           updated_at
         FROM chat_intercept_state
         WHERE ${whereClause}
         LIMIT 1`,
      )
      .get(...args) as Record<string, string | number | null> | null;
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: Record<string, string | number | null>): ChatInterceptStateRecord {
    return {
      routingKey: String(row.routing_key ?? ''),
      subscriptionId: String(row.subscription_id ?? ''),
      sessionId: typeof row.session_id === 'string' ? row.session_id : null,
      sessionClass: 'chat',
      workspaceOwnerNpub: String(row.workspace_owner_npub ?? ''),
      sourceAppNpub: String(row.source_app_npub ?? ''),
      channelId: String(row.channel_id ?? ''),
      threadId: String(row.thread_id ?? ''),
      targetBotNpub: String(row.target_bot_npub ?? ''),
      lastMessageIdSeen: typeof row.last_message_id_seen === 'string' ? row.last_message_id_seen : null,
      pendingMessageCount: normalisePendingMessageCount(row.pending_message_count),
      state: normaliseState(row.state),
      lastActivityAt: String(row.last_activity_at ?? ''),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
    };
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_intercept_state (
        routing_key TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        session_id TEXT,
        session_class TEXT NOT NULL,
        workspace_owner_npub TEXT NOT NULL,
        source_app_npub TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        target_bot_npub TEXT NOT NULL,
        last_message_id_seen TEXT,
        pending_message_count INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_intercept_state_subscription
        ON chat_intercept_state(subscription_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_chat_intercept_state_session
        ON chat_intercept_state(session_id);
    `);

    if (!hasColumn(this.db, 'chat_intercept_state', 'pending_message_count')) {
      this.db.exec(`
        ALTER TABLE chat_intercept_state
          ADD COLUMN pending_message_count INTEGER NOT NULL DEFAULT 0
      `);
    }
  }
}

export const chatInterceptStateStore = new ChatInterceptStateStore();
export { ChatInterceptStateStore };
