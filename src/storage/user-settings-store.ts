/**
 * User Settings Store
 *
 * SQLite key-value store for per-user settings (e.g. API keys).
 * Keyed by npub + setting key.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "./message-store";

// ============================================================
// Store Implementation
// ============================================================

class UserSettingsStore {
  private readonly db: Database;

  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
  }

  get(npub: string, key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string, string]>(
        "SELECT value FROM user_settings WHERE npub = ?1 AND key = ?2",
      )
      .get(npub, key);
    return row?.value ?? null;
  }

  set(npub: string, key: string, value: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO user_settings (npub, key, value, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(npub, key) DO UPDATE SET value = ?3, updated_at = ?4`,
      )
      .run(npub, key, value, now);
  }

  delete(npub: string, key: string): boolean {
    const result = this.db
      .query("DELETE FROM user_settings WHERE npub = ?1 AND key = ?2")
      .run(npub, key);
    return result.changes > 0;
  }

  getAll(npub: string): Record<string, string> {
    const rows = this.db
      .query<{ key: string; value: string }, [string]>(
        "SELECT key, value FROM user_settings WHERE npub = ?1",
      )
      .all(npub);
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_settings (
        npub TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (npub, key)
      );
    `);
  }
}

export const userSettingsStore = new UserSettingsStore();
export { UserSettingsStore };
