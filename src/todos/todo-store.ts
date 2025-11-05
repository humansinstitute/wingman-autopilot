import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database, type Statement } from "bun:sqlite";

import { normaliseNpub } from "../identity/npub-utils";
import { decryptTodoPayload, encryptTodoPayload, type TodoPayload } from "./encryption";

const DEFAULT_DB_PATH = new URL("../../data/todos.db", import.meta.url).pathname;

export interface TodoRecord {
  id: string;
  ownerNpub: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  appId: string | null;
  priority: number;
  starred: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTodoInput {
  ownerNpub: string;
  title: string;
  description?: string | null;
  dueDate?: string | null;
  appId?: string | null;
  priority?: number | null;
  starred?: boolean | null;
}

export interface UpdateTodoInput {
  title?: string;
  description?: string | null;
  dueDate?: string | null;
  appId?: string | null;
  priority?: number | null;
  starred?: boolean | null;
}

interface TodoRow {
  id: string;
  owner_npub: string;
  app_id: string | null;
  priority: number;
  starred: number;
  payload_iv: string;
  payload_tag: string;
  payload_ciphertext: string;
  created_at: string;
  updated_at: string;
}

const normalisePriority = (value: number | null | undefined): number => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }
  const clamped = Math.max(0, Math.min(3, Math.round(value)));
  return clamped;
};

const normaliseNullableString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const toBooleanInteger = (value: boolean | null | undefined): number => (value ? 1 : 0);

const mapRowToRecord = (row: TodoRow): TodoRecord => {
  const payload = decryptTodoPayload({
    iv: row.payload_iv,
    authTag: row.payload_tag,
    ciphertext: row.payload_ciphertext,
  });
  return {
    id: row.id,
    ownerNpub: row.owner_npub,
    title: payload.title,
    description: payload.description ?? null,
    dueDate: payload.dueDate ?? null,
    appId: row.app_id,
    priority: Number.isFinite(row.priority) ? Number(row.priority) : 0,
    starred: row.starred === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export class TodoStore {
  private readonly db: Database;
  private readonly insertStatement: Statement;
  private readonly updateStatement: Statement;
  private readonly deleteStatement: Statement;
  private readonly selectByIdStatement: Statement;
  private readonly selectByOwnerStatement: Statement;
  private readonly selectStarredStatement: Statement;

  constructor(filePath: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.initialise();
    this.insertStatement = this.prepareInsert();
    this.updateStatement = this.prepareUpdate();
    this.deleteStatement = this.prepareDelete();
    this.selectByIdStatement = this.prepareSelectById();
    this.selectByOwnerStatement = this.prepareSelectByOwner();
    this.selectStarredStatement = this.prepareSelectStarred();
  }

  list(ownerNpub: string): TodoRecord[] {
    const npub = normaliseNpub(ownerNpub);
    if (!npub) {
      return [];
    }
    const rows = this.selectByOwnerStatement.all(npub) as TodoRow[];
    return rows.map(mapRowToRecord);
  }

  listStarred(ownerNpub: string): TodoRecord[] {
    const npub = normaliseNpub(ownerNpub);
    if (!npub) {
      return [];
    }
    const rows = this.selectStarredStatement.all(npub) as TodoRow[];
    return rows.map(mapRowToRecord);
  }

  get(ownerNpub: string, id: string): TodoRecord | null {
    const npub = normaliseNpub(ownerNpub);
    if (!npub || !id) {
      return null;
    }
    const row = this.selectByIdStatement.get(npub, id) as TodoRow | undefined;
    return row ? mapRowToRecord(row) : null;
  }

  create(input: CreateTodoInput): TodoRecord {
    const owner = normaliseNpub(input.ownerNpub);
    if (!owner) {
      throw new Error("Invalid owner npub");
    }
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) {
      throw new Error("Todo title is required");
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const appId = normaliseNullableString(input.appId);
    const priority = normalisePriority(input.priority);
    const starred = Boolean(input.starred);
    const payload: TodoPayload = {
      title,
      description: normaliseNullableString(input.description) ?? undefined,
      dueDate: normaliseNullableString(input.dueDate) ?? undefined,
    };
    const encrypted = encryptTodoPayload(payload);
    const params = [
      id,
      owner,
      appId,
      priority,
      toBooleanInteger(starred),
      encrypted.iv,
      encrypted.authTag,
      encrypted.ciphertext,
      now,
      now,
    ];
    this.insertStatement.run(...params);
    return {
      id,
      ownerNpub: owner,
      title: payload.title,
      description: payload.description ?? null,
      dueDate: payload.dueDate ?? null,
      appId,
      priority,
      starred,
      createdAt: now,
      updatedAt: now,
    };
  }

  update(ownerNpub: string, id: string, input: UpdateTodoInput): TodoRecord | null {
    const current = this.get(ownerNpub, id);
    if (!current) {
      return null;
    }
    const npub = normaliseNpub(ownerNpub);
    if (!npub) {
      return null;
    }
    const title =
      typeof input.title === "string"
        ? input.title.trim()
        : current.title;
    if (!title) {
      throw new Error("Todo title is required");
    }
    const description =
      input.description !== undefined
        ? normaliseNullableString(input.description)
        : current.description;
    const dueDate =
      input.dueDate !== undefined
        ? normaliseNullableString(input.dueDate)
        : current.dueDate;
    const appId =
      input.appId !== undefined
        ? normaliseNullableString(input.appId)
        : current.appId;
    const priority = input.priority !== undefined ? normalisePriority(input.priority) : current.priority;
    const starred =
      input.starred !== undefined
        ? Boolean(input.starred)
        : current.starred;
    const payload: TodoPayload = {
      title,
      description: description ?? undefined,
      dueDate: dueDate ?? undefined,
    };
    const encrypted = encryptTodoPayload(payload);
    const updatedAt = new Date().toISOString();
    const params = [
      appId,
      priority,
      toBooleanInteger(starred),
      encrypted.iv,
      encrypted.authTag,
      encrypted.ciphertext,
      updatedAt,
      npub,
      id,
    ];
    this.updateStatement.run(...params);
    return {
      id: current.id,
      ownerNpub: npub,
      title,
      description: description ?? null,
      dueDate: dueDate ?? null,
      appId,
      priority,
      starred,
      createdAt: current.createdAt,
      updatedAt,
    };
  }

  delete(ownerNpub: string, id: string): boolean {
    const npub = normaliseNpub(ownerNpub);
    if (!npub || !id) {
      return false;
    }
    const result = this.deleteStatement.run(npub, id);
    return result.changes > 0;
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        owner_npub TEXT NOT NULL,
        app_id TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        starred INTEGER NOT NULL DEFAULT 0,
        payload_iv TEXT NOT NULL,
        payload_tag TEXT NOT NULL,
        payload_ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_todos_owner ON todos(owner_npub, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_todos_owner_starred ON todos(owner_npub, starred, priority DESC, updated_at DESC);
    `);
  }

  private prepareInsert() {
    return this.db.prepare(
      `
        INSERT INTO todos (
          id,
          owner_npub,
          app_id,
          priority,
          starred,
          payload_iv,
          payload_tag,
          payload_ciphertext,
          created_at,
          updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      `,
    );
  }

  private prepareUpdate() {
    return this.db.prepare(
      `
        UPDATE todos
           SET app_id = ?1,
               priority = ?2,
               starred = ?3,
               payload_iv = ?4,
               payload_tag = ?5,
               payload_ciphertext = ?6,
               updated_at = ?7
         WHERE owner_npub = ?8
           AND id = ?9
      `,
    );
  }

  private prepareDelete() {
    return this.db.prepare(
      `
        DELETE FROM todos
         WHERE owner_npub = ?1
           AND id = ?2
      `,
    );
  }

  private prepareSelectById() {
    return this.db.prepare(
      `
        SELECT
          id,
          owner_npub,
          app_id,
          priority,
          starred,
          payload_iv,
          payload_tag,
          payload_ciphertext,
          created_at,
          updated_at
        FROM todos
        WHERE owner_npub = ?1
          AND id = ?2
      `,
    );
  }

  private prepareSelectByOwner() {
    return this.db.prepare(
      `
        SELECT
          id,
          owner_npub,
          app_id,
          priority,
          starred,
          payload_iv,
          payload_tag,
          payload_ciphertext,
          created_at,
          updated_at
        FROM todos
        WHERE owner_npub = ?1
        ORDER BY updated_at DESC
      `,
    );
  }

  private prepareSelectStarred() {
    return this.db.prepare(
      `
        SELECT
          id,
          owner_npub,
          app_id,
          priority,
          starred,
          payload_iv,
          payload_tag,
          payload_ciphertext,
          created_at,
          updated_at
        FROM todos
        WHERE owner_npub = ?1
          AND starred = 1
        ORDER BY priority DESC, updated_at DESC
      `,
    );
  }
}
