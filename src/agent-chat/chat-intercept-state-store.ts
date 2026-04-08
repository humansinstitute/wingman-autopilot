import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';
import type { SQLQueryBindings } from 'bun:sqlite';

import { databaseFile } from '../storage/message-store';
import type {
  AgentInterceptDecision,
  ChatInterceptStateRecord,
  ChatInterceptStateStatus,
} from './types';

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
    case 'interrupt_failed':
    case 'idle':
    case 'archived':
    case 'blocked_auth':
    case 'blocked_decrypt':
      return value;
    default:
      return 'pending';
  }
}

function normaliseDecision(value: unknown): AgentInterceptDecision {
  switch (value) {
    case 'respond':
    case 'ignore':
    case 'failed':
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
         routing_key, subscription_id, agent_id, session_id, session_class, workspace_owner_npub,
         source_app_npub, channel_id, thread_id, target_bot_npub, last_message_id_seen, pending_message_count,
         state, last_decision, last_activity_at, created_at, updated_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5, ?6,
         ?7, ?8, ?9, ?10, ?11, ?12,
         ?13, ?14, ?15, ?16, ?17
       )
       ON CONFLICT(routing_key) DO UPDATE SET
         subscription_id = excluded.subscription_id,
         agent_id = excluded.agent_id,
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
         last_decision = excluded.last_decision,
         last_activity_at = excluded.last_activity_at,
         updated_at = excluded.updated_at`,
    ).run(
      record.routingKey,
      record.subscriptionId,
      record.agentId,
      record.sessionId,
      record.sessionClass,
      record.workspaceOwnerNpub,
      record.sourceAppNpub,
      record.channelId,
      record.threadId,
      record.botNpub,
      record.lastMessageIdSeen,
      record.pendingMessageCount,
      record.state,
      record.lastDecision,
      record.lastActivityAt,
      record.createdAt,
      record.updatedAt,
    );

    return this.getByRoutingKey(record.routingKey) ?? record;
  }

  upsertMessage(input: {
    routingKey: string;
    subscriptionId: string;
    agentId: string;
    workspaceOwnerNpub: string;
    sourceAppNpub: string;
    channelId: string;
    threadId: string;
    botNpub: string;
    messageId: string;
    at?: string;
  }): { record: ChatInterceptStateRecord; wasDuplicate: boolean } {
    const now = input.at ?? new Date().toISOString();
    const existing = this.getByRoutingKey(input.routingKey);
    const wasDuplicate = existing?.lastMessageIdSeen === input.messageId;
    if (existing && wasDuplicate) {
      return { record: existing, wasDuplicate: true };
    }
    const nextCount = existing
      ? existing.pendingMessageCount + 1
      : 1;

    const record = this.save({
      routingKey: input.routingKey,
      subscriptionId: input.subscriptionId,
      agentId: input.agentId,
      sessionId: existing?.sessionId ?? null,
      sessionClass: 'chat',
      workspaceOwnerNpub: input.workspaceOwnerNpub,
      sourceAppNpub: input.sourceAppNpub,
      channelId: input.channelId,
      threadId: input.threadId,
      botNpub: input.botNpub,
      lastMessageIdSeen: input.messageId,
      pendingMessageCount: nextCount,
      state: existing?.sessionId ? existing.state : 'pending',
      lastDecision: 'pending',
      lastActivityAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return { record, wasDuplicate };
  }

  private listWhere(whereClause: string, args: SQLQueryBindings[]): ChatInterceptStateRecord[] {
    return this.db
      .query(
        `SELECT
           routing_key,
           subscription_id,
           agent_id,
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
           last_decision,
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
           agent_id,
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
           last_decision,
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
      agentId: String(row.agent_id ?? ''),
      sessionId: typeof row.session_id === 'string' ? row.session_id : null,
      sessionClass: 'chat',
      workspaceOwnerNpub: String(row.workspace_owner_npub ?? ''),
      sourceAppNpub: String(row.source_app_npub ?? ''),
      channelId: String(row.channel_id ?? ''),
      threadId: String(row.thread_id ?? ''),
      botNpub: String(row.target_bot_npub ?? ''),
      lastMessageIdSeen: typeof row.last_message_id_seen === 'string' ? row.last_message_id_seen : null,
      pendingMessageCount: normalisePendingMessageCount(row.pending_message_count),
      state: normaliseState(row.state),
      lastDecision: normaliseDecision(row.last_decision),
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
        agent_id TEXT NOT NULL DEFAULT '',
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
        last_decision TEXT NOT NULL DEFAULT 'pending',
        last_activity_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_intercept_state_subscription
        ON chat_intercept_state(subscription_id, updated_at DESC);
    `);

    if (!hasColumn(this.db, 'chat_intercept_state', 'pending_message_count')) {
      this.db.exec(`
        ALTER TABLE chat_intercept_state
          ADD COLUMN pending_message_count INTEGER NOT NULL DEFAULT 0
      `);
    }
    if (!hasColumn(this.db, 'chat_intercept_state', 'agent_id')) {
      this.db.exec(`
        ALTER TABLE chat_intercept_state
          ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''
      `);
    }
    if (!hasColumn(this.db, 'chat_intercept_state', 'last_decision')) {
      this.db.exec(`
        ALTER TABLE chat_intercept_state
          ADD COLUMN last_decision TEXT NOT NULL DEFAULT 'pending'
      `);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chat_intercept_state_subscription
        ON chat_intercept_state(subscription_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_chat_intercept_state_agent
        ON chat_intercept_state(agent_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_chat_intercept_state_session
        ON chat_intercept_state(session_id);
    `);
  }
}

export const chatInterceptStateStore = new ChatInterceptStateStore();
export { ChatInterceptStateStore };
