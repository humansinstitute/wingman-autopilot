import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { normaliseNpub } from "../identity/npub-utils";

const PORT_START = 41000;
const PORTS_PER_USER = 3;
const MAX_INT32 = 2_147_483_647;

export class InsufficientBalanceError extends Error {
  readonly balance: number;
  readonly required: number;

  constructor(balance: number, required: number) {
    super(`Insufficient balance: requires ${required} sats, available ${balance} sats.`);
    this.name = "InsufficientBalanceError";
    this.balance = balance;
    this.required = required;
  }
}

export interface IdentityUserRecord {
  npub: string;
  normalizedNpub: string;
  alias: string;
  roles: string[];
  onboardedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  ports: number[];
  balance: number;
}

type IdentityUserRow = {
  normalizedNpub: string;
  npub: string;
  alias: string;
  roles: string;
  onboardedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  ports: string | null;
  balance: number | null;
};

type TouchOptions = {
  alias?: string | null;
  lastSeenAt?: string | Date | null;
};

const DEFAULT_DB_PATH = new URL("../../data/identity-users.db", import.meta.url).pathname;

const parseRoles = (input: string | null | undefined): string[] => {
  if (!input || input.trim().length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
};

const toIsoString = (value: string | Date | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return value.toISOString();
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return trimmed;
  }
  return date.toISOString();
};

class IdentityUserStore {
  private readonly db: Database;
  private nextPort: number = PORT_START;

  constructor(filePath: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.initialise();
    this.ensurePortsColumn();
    this.ensureBalanceColumn();
    this.synchronisePortAssignments();
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identity_users (
        normalized_npub TEXT PRIMARY KEY,
        npub TEXT NOT NULL,
        alias TEXT NOT NULL,
        roles TEXT NOT NULL DEFAULT '[]',
        onboarded_at TEXT,
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ports TEXT,
        balance INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  private ensurePortsColumn() {
    const columns = this.db.query<{ name: string }>("PRAGMA table_info(identity_users)").all();
    const hasPortsColumn = columns.some((column) => column?.name === "ports");
    if (!hasPortsColumn) {
      this.db.exec(`ALTER TABLE identity_users ADD COLUMN ports TEXT`);
    }
  }

  private ensureBalanceColumn() {
    const columns = this.db.query<{ name: string }>("PRAGMA table_info(identity_users)").all();
    const hasBalanceColumn = columns.some((column) => column?.name === "balance");
    if (!hasBalanceColumn) {
      this.db.exec(`ALTER TABLE identity_users ADD COLUMN balance INTEGER NOT NULL DEFAULT 0`);
    } else {
      this.db.exec(`UPDATE identity_users SET balance = 0 WHERE balance IS NULL`);
    }
  }

  private parsePorts(value: string | null | undefined): number[] {
    if (!value || value.trim().length === 0) {
      return [];
    }
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) {
        return [];
      }
      const unique = new Set<number>();
      for (const entry of parsed) {
        const parsedValue =
          typeof entry === "number" ? entry : Number.parseInt(String(entry), 10);
        if (Number.isInteger(parsedValue) && parsedValue >= 0) {
          unique.add(parsedValue);
        }
      }
      return Array.from(unique).sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  private portsEqual(left: number[], right: number[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }

  private calculateNextPort(): number {
    const result = this.db.query<{ count: number }>("SELECT COUNT(1) as count FROM identity_users").get();
    const count = Number.isFinite(result?.count) ? Number(result?.count) : 0;
    return PORT_START + count * PORTS_PER_USER;
  }

  private synchronisePortAssignments() {
    const rows = this.db
      .query<{ normalizedNpub: string; ports: string | null; createdAt: string }>(
        `SELECT
           normalized_npub as normalizedNpub,
           ports,
           created_at as createdAt
         FROM identity_users
         ORDER BY created_at ASC, normalized_npub ASC`,
      )
      .all();

    if (rows.length === 0) {
      this.nextPort = PORT_START;
      return;
    }

    const update = this.db.prepare(
      `UPDATE identity_users
         SET ports = ?2,
             updated_at = ?3
       WHERE normalized_npub = ?1`,
    );
    const now = new Date().toISOString();

    let next = PORT_START;
    for (const row of rows) {
      const expected = [next, next + 1, next + 2];
      next += PORTS_PER_USER;
      const currentPorts = this.parsePorts(row.ports);
      if (this.portsEqual(currentPorts, expected)) {
        continue;
      }
      update.run(row.normalizedNpub, JSON.stringify(expected), now);
    }

    this.nextPort = next;
  }

  private allocatePorts(): [number, number, number] {
    if (!Number.isInteger(this.nextPort) || this.nextPort < PORT_START) {
      this.nextPort = this.calculateNextPort();
    }
    const start = this.nextPort;
    this.nextPort = start + PORTS_PER_USER;
    return [start, start + 1, start + 2];
  }

  listUsers(): IdentityUserRecord[] {
    const statement = this.db.prepare<IdentityUserRow, IdentityUserRow>(
      `SELECT
         normalized_npub as normalizedNpub,
         npub,
         alias,
         roles,
         onboarded_at as onboardedAt,
         last_seen_at as lastSeenAt,
         created_at as createdAt,
         updated_at as updatedAt,
         ports,
         balance
       FROM identity_users
       ORDER BY alias`,
    );
    const rows = statement.all();
    return rows.map((row) => this.hydrate(row));
  }

  ensurePortAssignments(): IdentityUserRecord[] {
    this.synchronisePortAssignments();
    return this.listUsers();
  }

  getByNormalized(normalizedNpub: string): IdentityUserRecord | null {
    if (!normalizedNpub) {
      return null;
    }
    return this.get(normalizedNpub);
  }

  ensurePortsFor(npub: string | null | undefined): number[] {
    const normalized = normaliseNpub(npub ?? null);
    if (!normalized) {
      return [];
    }
    const existing = this.get(normalized);
    if (existing) {
      return existing.ports;
    }
    const created = this.touch(normalized);
    return created.ports;
  }

  touch(npub: string, options: TouchOptions = {}): IdentityUserRecord {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }
    const aliasInput = typeof options.alias === "string" ? options.alias.trim() : null;
    const lastSeenIso = toIsoString(options.lastSeenAt);
    const existing = this.get(normalized);
    const now = new Date().toISOString();

    if (existing) {
      const update = this.db.prepare(
        `UPDATE identity_users
         SET npub = ?2,
             alias = CASE WHEN ?3 IS NOT NULL AND length(?3) > 0 THEN ?3 ELSE alias END,
             last_seen_at = CASE WHEN ?4 IS NOT NULL THEN ?4 ELSE last_seen_at END,
             updated_at = ?5
         WHERE normalized_npub = ?1`,
      );
      update.run(normalized, npub, aliasInput, lastSeenIso, now);
      return this.getOrThrow(normalized);
    }

    const alias = aliasInput && aliasInput.length > 0 ? aliasInput : npub;
    const ports = this.allocatePorts();
    const insert = this.db.prepare(
      `INSERT INTO identity_users (
         normalized_npub,
         npub,
         alias,
         roles,
         onboarded_at,
         last_seen_at,
         created_at,
         updated_at,
         ports,
         balance
       ) VALUES (?1, ?2, ?3, '[]', NULL, ?4, ?5, ?5, ?6, ?7)`,
    );
    insert.run(normalized, npub, alias, lastSeenIso, now, JSON.stringify(ports), 0);
    return this.getOrThrow(normalized);
  }

  setRole(npub: string, role: string, enabled: boolean): IdentityUserRecord {
    const record = this.touch(npub);
    const normalized = record.normalizedNpub;
    const roles = new Set(record.roles);
    if (enabled) {
      roles.add(role);
    } else {
      roles.delete(role);
    }
    const updatedRoles = JSON.stringify(Array.from(roles).sort());
    const now = new Date().toISOString();
    const onboardedAt =
      role === "onboard" ? (enabled ? now : null) : record.onboardedAt;

    const update = this.db.prepare(
      `UPDATE identity_users
         SET roles = ?2,
             onboarded_at = ?3,
             updated_at = ?4
       WHERE normalized_npub = ?1`,
    );
    update.run(normalized, updatedRoles, onboardedAt, now);
    return this.getOrThrow(normalized);
  }

  setBalance(npub: string, satoshis: number): IdentityUserRecord {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }
    const record = this.touch(npub);
    const desired = Math.max(0, Math.trunc(Number.isFinite(satoshis) ? satoshis : 0));
    if (record.balance === desired) {
      return record;
    }
    const update = this.db.prepare(
      `UPDATE identity_users
         SET balance = ?2,
             updated_at = ?3
       WHERE normalized_npub = ?1`,
    );
    const now = new Date().toISOString();
    update.run(normalized, desired, now);
    return this.getOrThrow(normalized);
  }

  ensureBalanceDefaults(defaultBalance: number, overrides: Record<string, number>) {
    const sanitizedDefault = this.sanitiseAmount(defaultBalance, { allowZero: true });
    const normalizedOverrides = new Map<string, number>();
    for (const [npub, value] of Object.entries(overrides ?? {})) {
      const normalized = normaliseNpub(npub);
      if (!normalized) continue;
      const overrideBalance = this.sanitiseAmount(value, { allowZero: true });
      this.touch(npub);
      normalizedOverrides.set(normalized, overrideBalance);
    }

    const users = this.listUsers();
    const update = this.db.prepare(
      `UPDATE identity_users
         SET balance = ?2,
             updated_at = ?3
       WHERE normalized_npub = ?1`,
    );
    const now = new Date().toISOString();
    const apply = this.db.transaction(() => {
      for (const user of users) {
        const target = normalizedOverrides.get(user.normalizedNpub) ?? sanitizedDefault;
        if (user.balance !== target) {
          update.run(user.normalizedNpub, target, now);
        }
      }
    });
    apply();
  }

  credit(npub: string, satoshis: number): number {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }
    const amount = this.sanitiseAmount(satoshis);
    if (amount <= 0) {
      return this.getOrThrow(normalized).balance;
    }

    this.touch(npub);
    const now = new Date().toISOString();
    const update = this.db.prepare(
      `UPDATE identity_users
         SET balance = MIN(balance + ?2, ?4),
             updated_at = ?3
       WHERE normalized_npub = ?1`,
    );
    update.run(normalized, amount, now, MAX_INT32);
    return this.getOrThrow(normalized).balance;
  }

  debit(npub: string, satoshis: number): number {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }
    const amount = this.sanitiseAmount(satoshis);
    if (amount <= 0) {
      return this.getOrThrow(normalized).balance;
    }

    this.touch(npub);
    const now = new Date().toISOString();
    const update = this.db.prepare(
      `UPDATE identity_users
         SET balance = balance - ?2,
             updated_at = ?3
       WHERE normalized_npub = ?1
         AND balance >= ?2`,
    );
    const result = update.run(normalized, amount, now);
    if (!result || result.changes !== 1) {
      const current = this.get(normalized);
      const available = current?.balance ?? 0;
      throw new InsufficientBalanceError(available, amount);
    }
    return this.getOrThrow(normalized).balance;
  }

  private get(normalizedNpub: string): IdentityUserRecord | null {
    const statement = this.db.prepare<IdentityUserRow, IdentityUserRow>(
      `SELECT
         normalized_npub as normalizedNpub,
         npub,
         alias,
         roles,
         onboarded_at as onboardedAt,
         last_seen_at as lastSeenAt,
         created_at as createdAt,
         updated_at as updatedAt,
         ports,
         balance
       FROM identity_users
       WHERE normalized_npub = ?1`,
    );
    const row = statement.get(normalizedNpub);
    if (!row) return null;
    return this.hydrate(row);
  }

  private getOrThrow(normalizedNpub: string): IdentityUserRecord {
    const record = this.get(normalizedNpub);
    if (!record) {
      throw new Error(`Failed to load identity user ${normalizedNpub}`);
    }
    return record;
  }

  private hydrate(row: IdentityUserRow): IdentityUserRecord {
    return {
      npub: row.npub,
      normalizedNpub: row.normalizedNpub,
      alias: row.alias,
      roles: Array.from(new Set(parseRoles(row.roles))).sort(),
      onboardedAt: row.onboardedAt ?? null,
      lastSeenAt: row.lastSeenAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ports: this.parsePorts(row.ports),
      balance: this.normaliseBalance(row.balance),
    };
  }

  private normaliseBalance(value: number | null | undefined): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.trunc(value));
    }
    if (value === null || value === undefined) {
      return 0;
    }
    const parsed = Number.parseInt(String(value), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.trunc(parsed));
    }
    return 0;
  }

  private sanitiseAmount(value: number, options?: { allowZero?: boolean }): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    const normalized = Math.trunc(value);
    if (normalized <= 0) {
      return options?.allowZero ? 0 : 0;
    }
    return Math.min(normalized, MAX_INT32);
  }
}

export const identityUserStore = new IdentityUserStore();

const DEFAULT_BALANCE_SATOSHIS = 0;
const BALANCE_OVERRIDES: Record<string, number> = {
  npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy: 100_000,
};

identityUserStore.ensureBalanceDefaults(DEFAULT_BALANCE_SATOSHIS, BALANCE_OVERRIDES);
