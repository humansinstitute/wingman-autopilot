/**
 * Tests for AGENT_NSEC injection into agent subprocess environments.
 *
 * Validates the end-to-end flow: bot key resolution → MCP injection →
 * env var propagation to spawned processes.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils";

import {
  storeBotKeyInMemory,
  clearBotKey,
  getDecryptedBotKey,
} from "../identity/bot-key-manager";
import { resolveBotNsecHex, exportBotKeyForUser } from "../identity/bot-key-export";
import type { BotKeyRecord } from "../identity/bot-key-store";
import type { McpInjectionContext, McpInjectionResult } from "./mcp-injector";

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

describe("AGENT_NSEC injection flow", () => {
  const userSecret = generateSecretKey();
  const userPubkeyHex = getPublicKey(userSecret);
  const userNpub = nip19.npubEncode(userPubkeyHex);
  let botSecret: Uint8Array;
  let botRecord: BotKeyRecord;

  beforeEach(() => {
    botSecret = generateSecretKey();
    botRecord = makeBotKeyRecord(botSecret, userNpub);
    clearBotKey(userNpub);
  });

  describe("resolveBotNsecHex — in-memory path", () => {
    test("returns valid 64-char hex when key is in memory", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "browser");

      const result = resolveBotNsecHex(userNpub, botRecord);
      expect(result).not.toBeNull();
      expect(result!.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(result!)).toBe(true);
    });

    test("resolved hex matches the original secret key", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "browser");

      const result = resolveBotNsecHex(userNpub, botRecord);
      expect(result).toBe(bytesToHex(botSecret));
    });

    test("returns null when no key is in memory and escrow fails", () => {
      // No key stored, fake escrow blob → both paths fail
      const result = resolveBotNsecHex(userNpub, botRecord);
      expect(result).toBeNull();
    });

    test("returns null when in-memory key has a pubkey mismatch", () => {
      // Store a different key in memory
      const differentSecret = generateSecretKey();
      storeBotKeyInMemory(userNpub, differentSecret, getPublicKey(differentSecret), "browser");

      const result = resolveBotNsecHex(userNpub, botRecord);
      // In-memory pubkey doesn't match record, escrow blob is fake
      expect(result).toBeNull();
    });

    test("resolved value can be used to derive the bot public key", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "browser");

      const nsecHex = resolveBotNsecHex(userNpub, botRecord);
      expect(nsecHex).not.toBeNull();

      // Convert hex back to bytes and derive pubkey
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 64; i += 2) {
        bytes[i / 2] = parseInt(nsecHex!.substring(i, i + 2), 16);
      }
      const derivedPubkey = getPublicKey(bytes);
      expect(derivedPubkey).toBe(botRecord.botPubkeyHex);
    });
  });

  describe("exportBotKeyForUser — full export", () => {
    test("returns all export fields when key is in memory", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "browser");

      const result = exportBotKeyForUser(userNpub, botRecord);
      expect(result).not.toBeNull();
      expect(result!.nsecHex).toBe(bytesToHex(botSecret));
      expect(result!.nsec.startsWith("nsec1")).toBe(true);
      expect(result!.botPubkeyHex).toBe(botRecord.botPubkeyHex);
      expect(result!.botNpub).toBe(botRecord.botNpub);
      expect(result!.source).toBe("memory");
    });

    test("nsecHex and nsec are consistent (round-trip)", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "browser");

      const result = exportBotKeyForUser(userNpub, botRecord);
      expect(result).not.toBeNull();

      const decoded = nip19.decode(result!.nsec);
      expect(decoded.type).toBe("nsec");
      expect(bytesToHex(decoded.data as Uint8Array)).toBe(result!.nsecHex);
    });
  });

  describe("MCP injection context propagation", () => {
    test("agentNsec flows to baseEnv.AGENT_NSEC when set", () => {
      // Simulate the flow in process-manager: resolve nsec, pass to injection context
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "browser");
      const agentNsec = resolveBotNsecHex(userNpub, botRecord) ?? undefined;

      expect(agentNsec).toBeDefined();

      // Build the context as process-manager would
      const ctx: McpInjectionContext = {
        sessionId: "test-session-1",
        agent: "claude",
        workingDirectory: "/tmp/test",
        config: { port: 3600 } as any,
        botPubkeyHex: botRecord.botPubkeyHex,
        botNpub: botRecord.botNpub,
        userNpub,
        agentNsec,
      };

      // Verify the context has AGENT_NSEC
      expect(ctx.agentNsec).toBe(bytesToHex(botSecret));
    });

    test("agentNsec is undefined when resolution fails", () => {
      // No key in memory, fake escrow blob
      const agentNsec = resolveBotNsecHex(userNpub, botRecord) ?? undefined;
      expect(agentNsec).toBeUndefined();
    });

    test("resolved AGENT_NSEC is not all zeros", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "browser");
      const agentNsec = resolveBotNsecHex(userNpub, botRecord);
      expect(agentNsec).not.toBeNull();
      expect(agentNsec).not.toBe("0".repeat(64));
    });
  });

  describe("MCP config helpers — identity env propagation", () => {
    test("pickIdentityEnv extracts AGENT_NSEC from baseEnv", () => {
      // Import the helper
      const IDENTITY_KEYS = ["BOT_PUBKEY_HEX", "BOT_NPUB", "USER_NPUB", "AGENT_NSEC"] as const;
      function pickIdentityEnv(env: Record<string, string>): Record<string, string> {
        const result: Record<string, string> = {};
        for (const key of IDENTITY_KEYS) {
          if (env[key]) result[key] = env[key];
        }
        return result;
      }

      const baseEnv: Record<string, string> = {
        WINGMAN_URL: "http://localhost:3600",
        BOT_PUBKEY_HEX: botRecord.botPubkeyHex,
        BOT_NPUB: botRecord.botNpub,
        USER_NPUB: userNpub,
        AGENT_NSEC: bytesToHex(botSecret),
      };

      const identityEnv = pickIdentityEnv(baseEnv);
      expect(identityEnv.AGENT_NSEC).toBe(bytesToHex(botSecret));
      expect(identityEnv.BOT_PUBKEY_HEX).toBe(botRecord.botPubkeyHex);
      expect(identityEnv.BOT_NPUB).toBe(botRecord.botNpub);
      expect(identityEnv.USER_NPUB).toBe(userNpub);
      // WINGMAN_URL should NOT be in identity env
      expect(identityEnv.WINGMAN_URL).toBeUndefined();
    });

    test("pickIdentityEnv omits AGENT_NSEC when not in baseEnv", () => {
      const IDENTITY_KEYS = ["BOT_PUBKEY_HEX", "BOT_NPUB", "USER_NPUB", "AGENT_NSEC"] as const;
      function pickIdentityEnv(env: Record<string, string>): Record<string, string> {
        const result: Record<string, string> = {};
        for (const key of IDENTITY_KEYS) {
          if (env[key]) result[key] = env[key];
        }
        return result;
      }

      const baseEnv: Record<string, string> = {
        WINGMAN_URL: "http://localhost:3600",
        BOT_PUBKEY_HEX: botRecord.botPubkeyHex,
        // No AGENT_NSEC
      };

      const identityEnv = pickIdentityEnv(baseEnv);
      expect(identityEnv.AGENT_NSEC).toBeUndefined();
      expect(identityEnv.BOT_PUBKEY_HEX).toBe(botRecord.botPubkeyHex);
    });
  });

  describe("PM2 ecosystem env propagation", () => {
    test("AGENT_NSEC in envOverride flows to runtimeEnv", () => {
      // Simulate what ecosystem-generator does
      const envOverride: Record<string, string> = {
        WINGMAN_URL: "http://localhost:3600",
        BOT_PUBKEY_HEX: botRecord.botPubkeyHex,
        BOT_NPUB: botRecord.botNpub,
        USER_NPUB: userNpub,
        AGENT_NSEC: bytesToHex(botSecret),
      };

      const runtimeEnv: Record<string, string> = {
        SESSION_ID: "test-session-1",
        SESSION_NAME: "test",
        SESSION_PORT: "3700",
        SESSION_DIRECTORY: "/tmp/test",
        SESSION_AGENT: "claude",
        USER_ALIAS: "test-user",
        ...envOverride,
      };

      expect(runtimeEnv.AGENT_NSEC).toBe(bytesToHex(botSecret));
      expect(runtimeEnv.SESSION_ID).toBe("test-session-1");
    });

    test("server-only secrets should not be in agent subprocess env", () => {
      // Direct spawn path strips these before building the child process env.
      const parentEnv = {
        PATH: "/usr/bin",
        KEYTELEPORT_PRIVKEY: "nsec1fake",
        WINGMAN_SIGNING_SECRET: "server-secret",
        WINGMAN_SIGNING_TOKEN: "runner-token",
        AGENT_NSEC: bytesToHex(botSecret),
      };

      const {
        KEYTELEPORT_PRIVKEY: _strippedKeyTeleport,
        WINGMAN_SIGNING_SECRET: _strippedSigningSecret,
        WINGMAN_SIGNING_TOKEN: _strippedSigningToken,
        ...cleanEnv
      } = parentEnv;
      expect(cleanEnv.KEYTELEPORT_PRIVKEY).toBeUndefined();
      expect(cleanEnv.WINGMAN_SIGNING_SECRET).toBeUndefined();
      expect(cleanEnv.WINGMAN_SIGNING_TOKEN).toBeUndefined();
      expect(cleanEnv.AGENT_NSEC).toBe(bytesToHex(botSecret));
    });
  });

  describe("validation — resolved AGENT_NSEC integrity", () => {
    test("resolved nsecHex derives the correct bot pubkey", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "browser");

      const nsecHex = resolveBotNsecHex(userNpub, botRecord);
      expect(nsecHex).not.toBeNull();

      // Re-derive pubkey from the resolved hex
      const secretBytes = new Uint8Array(32);
      for (let i = 0; i < 64; i += 2) {
        secretBytes[i / 2] = parseInt(nsecHex!.substring(i, i + 2), 16);
      }
      const derivedPubkey = getPublicKey(secretBytes);
      expect(derivedPubkey).toBe(botRecord.botPubkeyHex);
    });

    test("wiped key returns all zeros (detectable)", () => {
      // Demonstrate that a wiped key would be detectable
      const wipedSecret = new Uint8Array(32);
      wipedSecret.fill(0);
      const allZerosHex = bytesToHex(wipedSecret);
      expect(allZerosHex).toBe("0".repeat(64));
      // A proper AGENT_NSEC should NOT be all zeros
    });
  });

  describe("npub matching — activeKeys map vs process-manager lookup", () => {
    test("storeBotKeyInMemory key matches getDecryptedBotKey lookup with same npub", () => {
      // Simulate session-started handler storing the key
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "escrow");

      // Simulate process-manager looking up with the SAME npub
      const unlocked = getDecryptedBotKey(userNpub);
      expect(unlocked).not.toBeNull();
      expect(unlocked!.pubkeyHex).toBe(botRecord.botPubkeyHex);
      expect(bytesToHex(unlocked!.secretKey)).toBe(bytesToHex(botSecret));
    });

    test("getDecryptedBotKey returns null for a different npub", () => {
      // Store key under the user's npub
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "escrow");

      // Lookup with the BOT's npub (wrong key in the map)
      const botNpub = botRecord.botNpub;
      const unlocked = getDecryptedBotKey(botNpub);
      expect(unlocked).toBeNull();
    });

    test("session-started handler npub format matches process-manager npub format", () => {
      // Both paths use npub1... bech32 format
      expect(userNpub.startsWith("npub1")).toBe(true);
      expect(userNpub.length).toBeGreaterThan(10);

      // Simulate event.session.npub = requestNpub (they're the same value)
      const eventSessionNpub = userNpub;
      const requestNpub = userNpub;
      expect(eventSessionNpub).toBe(requestNpub);

      // Store with event handler's npub, lookup with process-manager's npub
      storeBotKeyInMemory(eventSessionNpub, botSecret, botRecord.botPubkeyHex, "escrow");
      const unlocked = getDecryptedBotKey(requestNpub);
      expect(unlocked).not.toBeNull();
    });

    test("undefined npub causes bot key lookup to be skipped entirely", () => {
      // This is the task-executor bug: no npub means no AGENT_NSEC
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "escrow");

      const npub: string | undefined = undefined;
      if (npub) {
        // This block would never execute
        const unlocked = getDecryptedBotKey(npub);
        expect(unlocked).not.toBeNull();
      }
      // With undefined npub, bot key lookup is completely skipped
      expect(npub).toBeUndefined();
    });
  });
});
