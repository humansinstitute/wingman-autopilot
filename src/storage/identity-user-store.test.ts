import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "bun:test";

import { IdentityUserStore } from "./identity-user-store";

const PETE_NPUB = "npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy";
const WM21_NPUB = "npub1s4658awhcachmhzk5jhsg256gzdl7e4gh5a9zq8skjyt7g3k2axql224qz";

function withStore(fn: (store: IdentityUserStore, dbPath: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "identity-user-store-"));
  const dbPath = join(dir, "identity-users.db");
  try {
    const store = new IdentityUserStore(dbPath);
    fn(store, dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedLegacyUser(dbPath: string, npub: string, ports: number[], createdAt: string) {
  const db = new Database(dbPath);
  db.run(
    `INSERT INTO identity_users (
       normalized_npub,
       npub,
       alias,
       roles,
       created_at,
       updated_at,
       ports,
       balance
     ) VALUES (?1, ?1, ?1, '[]', ?2, ?2, ?3, 0)`,
    [npub, createdAt, JSON.stringify(ports)],
  );
  db.close();
}

describe("IdentityUserStore app ports", () => {
  test("stores a Nostr profile name separately from the generated alias", () => {
    withStore((store) => {
      const user = store.touch(PETE_NPUB, { alias: "honest-ivory-thicket" });
      const updated = store.setProfileName(PETE_NPUB, "Pete");

      expect(user.alias).toBe("honest-ivory-thicket");
      expect(updated.alias).toBe("honest-ivory-thicket");
      expect(updated.profileName).toBe("Pete");
    });
  });

  test("assigns 1000 default app ports to a new user", () => {
    withStore((store) => {
      const user = store.touch(PETE_NPUB);

      expect(user.ports).toHaveLength(1000);
      expect(user.ports[0]).toBe(41000);
      expect(user.ports.at(-1)).toBe(41999);
    });
  });

  test("tops up legacy users to 1000 ports without moving existing ports", () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-user-store-legacy-"));
    const dbPath = join(dir, "identity-users.db");
    try {
      new IdentityUserStore(dbPath);
      seedLegacyUser(dbPath, PETE_NPUB, [41000, 41001, 41002], "2026-01-01T00:00:00.000Z");
      seedLegacyUser(dbPath, WM21_NPUB, [41003, 41004], "2026-01-02T00:00:00.000Z");

      const migrated = new IdentityUserStore(dbPath);
      const users = migrated.listUsers();
      const pete = users.find((user) => user.normalizedNpub === PETE_NPUB);
      const wm21 = users.find((user) => user.normalizedNpub === WM21_NPUB);

      expect(pete?.ports).toHaveLength(1000);
      expect(wm21?.ports).toHaveLength(1000);
      expect(pete?.ports.slice(0, 3)).toEqual([41000, 41001, 41002]);
      expect(wm21?.ports.slice(0, 2)).toEqual([41003, 41004]);

      const petePorts = new Set(pete?.ports ?? []);
      const overlap = (wm21?.ports ?? []).filter((port) => petePorts.has(port));
      expect(overlap).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
