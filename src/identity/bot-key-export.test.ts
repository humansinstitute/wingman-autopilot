/**
 * Tests for bot-key-export module.
 *
 * Validates that exportBotKeyForUser and resolveBotNsecHex correctly
 * resolve bot keys from memory or escrow, and produce the expected
 * nsec / nsecHex / pubkey output.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils";

// We mock the bot-key-manager functions so tests don't need real crypto state
import {
  getDecryptedBotKey,
  storeBotKeyInMemory,
  clearBotKey,
} from "./bot-key-manager";
import type { BotKeyRecord } from "./bot-key-store";
import { exportBotKeyForUser, resolveBotNsecHex } from "./bot-key-export";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBotKeyRecord(
  secretKey: Uint8Array,
  userNpub: string,
  overrides: Partial<BotKeyRecord> = {},
): BotKeyRecord {
  const pubkeyHex = getPublicKey(secretKey);
  return {
    id: "test-id-" + Math.random().toString(36).slice(2, 8),
    userNpub,
    botPubkeyHex: pubkeyHex,
    botNpub: nip19.npubEncode(pubkeyHex),
    displayName: "TestBot",
    encryptedToUser: "encrypted-to-user-blob",
    encryptedEscrow: "encrypted-escrow-blob",
    escrowUuid: "test-escrow-uuid",
    isActive: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bot-key-export", () => {
  const testUserNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
  let testBotSecret: Uint8Array;
  let testRecord: BotKeyRecord;

  beforeEach(() => {
    // Fresh key for each test
    testBotSecret = generateSecretKey();
    testRecord = makeBotKeyRecord(testBotSecret, testUserNpub);
    // Clear any previously stored keys
    clearBotKey(testUserNpub);
  });

  describe("exportBotKeyForUser", () => {
    test("returns null when key is not in memory and escrow fails", () => {
      // No key in memory, and escrow blob is fake so unlockViaEscrow will throw
      const result = exportBotKeyForUser(testUserNpub, testRecord);
      expect(result).toBeNull();
    });

    test("returns export data from memory when key is unlocked", () => {
      // Pre-store the key in memory
      storeBotKeyInMemory(
        testUserNpub,
        testBotSecret,
        testRecord.botPubkeyHex,
        "browser",
      );

      const result = exportBotKeyForUser(testUserNpub, testRecord);
      expect(result).not.toBeNull();
      expect(result!.source).toBe("memory");
      expect(result!.nsecHex).toBe(bytesToHex(testBotSecret));
      expect(result!.nsec).toBe(nip19.nsecEncode(testBotSecret));
      expect(result!.botPubkeyHex).toBe(testRecord.botPubkeyHex);
      expect(result!.botNpub).toBe(testRecord.botNpub);
    });

    test("nsec bech32 round-trips to the same secret key", () => {
      storeBotKeyInMemory(
        testUserNpub,
        testBotSecret,
        testRecord.botPubkeyHex,
        "browser",
      );

      const result = exportBotKeyForUser(testUserNpub, testRecord);
      expect(result).not.toBeNull();

      // Decode the nsec back and verify it matches
      const decoded = nip19.decode(result!.nsec);
      expect(decoded.type).toBe("nsec");
      expect(bytesToHex(decoded.data as Uint8Array)).toBe(result!.nsecHex);
    });

    test("does not return key from memory if pubkey mismatch", () => {
      // Store a different key in memory under the same npub
      const differentSecret = generateSecretKey();
      storeBotKeyInMemory(
        testUserNpub,
        differentSecret,
        getPublicKey(differentSecret),
        "browser",
      );

      // Record has a different botPubkeyHex than what's in memory
      const result = exportBotKeyForUser(testUserNpub, testRecord);
      // Should fail because in-memory pubkey doesn't match record,
      // and escrow blob is fake
      expect(result).toBeNull();
    });
  });

  describe("resolveBotNsecHex", () => {
    test("returns null when key is not available", () => {
      const result = resolveBotNsecHex(testUserNpub, testRecord);
      expect(result).toBeNull();
    });

    test("returns hex nsec from memory when key is unlocked", () => {
      storeBotKeyInMemory(
        testUserNpub,
        testBotSecret,
        testRecord.botPubkeyHex,
        "browser",
      );

      const result = resolveBotNsecHex(testUserNpub, testRecord);
      expect(result).toBe(bytesToHex(testBotSecret));
    });

    test("returns 64-char hex string", () => {
      storeBotKeyInMemory(
        testUserNpub,
        testBotSecret,
        testRecord.botPubkeyHex,
        "browser",
      );

      const result = resolveBotNsecHex(testUserNpub, testRecord);
      expect(result).not.toBeNull();
      expect(result!.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(result!)).toBe(true);
    });

    test("does not return hex when pubkey mismatch in memory", () => {
      const differentSecret = generateSecretKey();
      storeBotKeyInMemory(
        testUserNpub,
        differentSecret,
        getPublicKey(differentSecret),
        "browser",
      );

      const result = resolveBotNsecHex(testUserNpub, testRecord);
      expect(result).toBeNull();
    });
  });

  describe("AGENT_NSEC env var format", () => {
    test("nsecHex is suitable for AGENT_NSEC env var", () => {
      storeBotKeyInMemory(
        testUserNpub,
        testBotSecret,
        testRecord.botPubkeyHex,
        "browser",
      );

      const result = resolveBotNsecHex(testUserNpub, testRecord);
      expect(result).not.toBeNull();

      // Should be usable by resolveSecretKey in clis/lib/auth.ts
      // (accepts 64-char hex)
      expect(/^[0-9a-fA-F]{64}$/.test(result!)).toBe(true);
    });

    test("nsec bech32 is also a valid AGENT_NSEC format", () => {
      storeBotKeyInMemory(
        testUserNpub,
        testBotSecret,
        testRecord.botPubkeyHex,
        "browser",
      );

      const result = exportBotKeyForUser(testUserNpub, testRecord);
      expect(result).not.toBeNull();

      // Should start with nsec1 prefix
      expect(result!.nsec.startsWith("nsec1")).toBe(true);
    });
  });
});
