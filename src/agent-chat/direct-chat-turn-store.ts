import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { databaseFile } from '../storage/message-store';

export interface DirectChatTurnRecord {
  turnId: string;
  routingKey: string;
  sourceMessageIds: string[];
  clientRequestId: string;
  replyBody: string | null;
  publishedMessageId: string | null;
  state: 'accepted' | 'reply_ready' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export class DirectChatTurnStore {
  private readonly db: Database;

  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_direct_chat_turns (
      turn_id TEXT PRIMARY KEY,
      routing_key TEXT NOT NULL,
      source_message_ids_json TEXT NOT NULL,
      client_request_id TEXT NOT NULL UNIQUE,
      reply_body TEXT,
      published_message_id TEXT,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_agent_direct_turns_routing ON agent_direct_chat_turns(routing_key, updated_at DESC);`);
  }

  getPending(routingKey: string): DirectChatTurnRecord | null {
    const row = this.db.query("SELECT * FROM agent_direct_chat_turns WHERE routing_key = ?1 AND state != 'completed' ORDER BY created_at ASC LIMIT 1").get(routingKey);
    return row ? this.map(row as Record<string, unknown>) : null;
  }

  save(record: DirectChatTurnRecord): DirectChatTurnRecord {
    this.db.query(`INSERT INTO agent_direct_chat_turns (turn_id, routing_key, source_message_ids_json, client_request_id, reply_body, published_message_id, state, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT(turn_id) DO UPDATE SET reply_body=excluded.reply_body, published_message_id=excluded.published_message_id, state=excluded.state, updated_at=excluded.updated_at`)
      .run(record.turnId, record.routingKey, JSON.stringify(record.sourceMessageIds), record.clientRequestId, record.replyBody, record.publishedMessageId, record.state, record.createdAt, record.updatedAt);
    return record;
  }

  private map(row: Record<string, unknown>): DirectChatTurnRecord {
    let sourceMessageIds: string[] = [];
    try { sourceMessageIds = JSON.parse(String(row.source_message_ids_json ?? '[]')); } catch {}
    return {
      turnId: String(row.turn_id), routingKey: String(row.routing_key), sourceMessageIds,
      clientRequestId: String(row.client_request_id), replyBody: typeof row.reply_body === 'string' ? row.reply_body : null,
      publishedMessageId: typeof row.published_message_id === 'string' ? row.published_message_id : null,
      state: String(row.state) as DirectChatTurnRecord['state'], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }
}

export const directChatTurnStore = new DirectChatTurnStore();
