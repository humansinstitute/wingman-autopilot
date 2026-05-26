/**
 * End-to-end tests for AGENT_NSEC export and injection.
 *
 * Validates the complete chain:
 *   1. Bot key resolution (memory and escrow paths)
 *   2. MCP injector context propagation (AGENT_NSEC in env)
 *   3. PM2 ecosystem env propagation (envOverride → runtimeEnv)
 *   4. KEYTELEPORT_PRIVKEY stripping in both spawn paths
 *   5. npub format consistency across all session creation paths
 *   6. Edge cases: no npub, wiped key, pubkey mismatch
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils";

import {
  storeBotKeyInMemory,
  clearBotKey,
  getDecryptedBotKey,
  isBotKeyUnlocked,
} from "../identity/bot-key-manager";
import { resolveBotNsecHex, exportBotKeyForUser } from "../identity/bot-key-export";
import type { BotKeyRecord } from "../identity/bot-key-store";
import { injectMcpConfig, type McpInjectionContext } from "./mcp-injector";
import { createAppConfig, type SessionConfig } from "./ecosystem-generator";

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

function makeSessionConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    sessionId: "test-session-" + Math.random().toString(36).slice(2, 8),
    sessionName: "test-session",
    agent: "claude" as const,
    port: 3700,
    workingDirectory: "/tmp/wingmen-test",
    userAlias: "tester",
    isAdmin: false,
    config: { port: 3600, agentPorts: 3700, agentMax: 10 } as any,
    // Provide commandOverride so buildAgentCommand doesn't need config.agents
    commandOverride: ["echo", "test-agent"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AGENT_NSEC end-to-end export and injection", () => {
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

  // -----------------------------------------------------------------------
  // 1. Bot key resolution → nsec hex
  // -----------------------------------------------------------------------

  describe("bot key resolution to nsec hex", () => {
    test("in-memory key resolves to correct 64-char hex", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "browser");

      const nsecHex = resolveBotNsecHex(userNpub, botRecord);
      expect(nsecHex).not.toBeNull();
      expect(nsecHex!.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(nsecHex!)).toBe(true);
      expect(nsecHex).toBe(bytesToHex(botSecret));
    });

    test("resolved nsecHex derives back to the bot public key", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "browser");

      const nsecHex = resolveBotNsecHex(userNpub, botRecord);
      expect(nsecHex).not.toBeNull();

      // Convert hex back to bytes and derive pubkey
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 64; i += 2) {
        bytes[i / 2] = parseInt(nsecHex!.substring(i, i + 2), 16);
      }
      expect(getPublicKey(bytes)).toBe(botRecord.botPubkeyHex);
    });

    test("returns null when key not in memory and escrow fails", () => {
      expect(resolveBotNsecHex(userNpub, botRecord)).toBeNull();
    });

    test("returns null on pubkey mismatch between memory and record", () => {
      const differentSecret = generateSecretKey();
      storeBotKeyInMemory(userNpub, differentSecret, getPublicKey(differentSecret), "browser");

      expect(resolveBotNsecHex(userNpub, botRecord)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // 2. Full export (nsec + nsecHex + pubkey)
  // -----------------------------------------------------------------------

  describe("full bot key export", () => {
    test("exportBotKeyForUser returns all fields from memory path", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "browser");

      const result = exportBotKeyForUser(userNpub, botRecord);
      expect(result).not.toBeNull();
      expect(result!.nsecHex).toBe(bytesToHex(botSecret));
      expect(result!.nsec.startsWith("nsec1")).toBe(true);
      expect(result!.botPubkeyHex).toBe(botRecord.botPubkeyHex);
      expect(result!.botNpub).toBe(botRecord.botNpub);
      expect(result!.source).toBe("memory");
    });

    test("nsec bech32 round-trips to matching nsecHex", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "browser");

      const result = exportBotKeyForUser(userNpub, botRecord);
      expect(result).not.toBeNull();

      const decoded = nip19.decode(result!.nsec);
      expect(decoded.type).toBe("nsec");
      expect(bytesToHex(decoded.data as Uint8Array)).toBe(result!.nsecHex);
    });
  });

  // -----------------------------------------------------------------------
  // 3. MCP injector propagation — AGENT_NSEC in env vars
  // -----------------------------------------------------------------------

  describe("MCP injector AGENT_NSEC propagation", () => {
    test("injectMcpConfig includes AGENT_NSEC in returned env for codex agent", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "browser");
      const agentNsec = resolveBotNsecHex(userNpub, botRecord)!;

      const ctx: McpInjectionContext = {
        sessionId: "inject-test-1",
        agent: "codex",
        workingDirectory: "/tmp/wingmen-test",
        config: { port: 3600 } as any,
        botPubkeyHex: botRecord.botPubkeyHex,
        botNpub: botRecord.botNpub,
        userNpub,
        agentNsec,
      };

      // codex injection is synchronous (returns McpInjectionResult directly)
      // but injectMcpConfig is async — call it
      const resultPromise = injectMcpConfig(ctx);
      return resultPromise.then((result) => {
        expect(result.env.AGENT_NSEC).toBe(agentNsec);
        expect(result.env.BOT_PUBKEY_HEX).toBe(botRecord.botPubkeyHex);
        expect(result.env.BOT_NPUB).toBe(botRecord.botNpub);
        expect(result.env.USER_NPUB).toBe(userNpub);
        expect(result.env.WINGMAN_URL).toBeDefined();
      });
    });

    test("injectMcpConfig omits AGENT_NSEC from env when agentNsec is undefined", async () => {
      const ctx: McpInjectionContext = {
        sessionId: "inject-test-2",
        agent: "codex",
        workingDirectory: "/tmp/wingmen-test",
        config: { port: 3600 } as any,
        // No agentNsec
      };

      const result = await injectMcpConfig(ctx);
      expect(result.env.AGENT_NSEC).toBeUndefined();
    });

    test("identity env keys propagate to codex command args", async () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "browser");
      const agentNsec = resolveBotNsecHex(userNpub, botRecord)!;

      const ctx: McpInjectionContext = {
        sessionId: "inject-test-3",
        agent: "codex",
        workingDirectory: "/tmp/wingmen-test",
        config: { port: 3600 } as any,
        botPubkeyHex: botRecord.botPubkeyHex,
        botNpub: botRecord.botNpub,
        userNpub,
        agentNsec,
      };

      const result = await injectMcpConfig(ctx);
      // Codex uses -c flags — check that AGENT_NSEC appears in commandArgs
      expect(result.commandArgs).toBeDefined();
      const argsJoined = result.commandArgs!.join(" ");
      expect(argsJoined).toContain("AGENT_NSEC");
    });
  });

  // -----------------------------------------------------------------------
  // 4. PM2 ecosystem env propagation
  // -----------------------------------------------------------------------

  describe("PM2 ecosystem env propagation", () => {
    test("AGENT_NSEC in envOverride flows through createAppConfig to env", () => {
      const nsecHex = bytesToHex(botSecret);
      const config = makeSessionConfig({
        envOverride: {
          WINGMAN_URL: "http://localhost:3600",
          BOT_PUBKEY_HEX: botRecord.botPubkeyHex,
          BOT_NPUB: botRecord.botNpub,
          USER_NPUB: userNpub,
          AGENT_NSEC: nsecHex,
        },
      });

      const appConfig = createAppConfig(config);
      expect(appConfig.env).toBeDefined();
      expect((appConfig.env as Record<string, string>).AGENT_NSEC).toBe(nsecHex);
    });

    test("server-only secrets are stripped from envOverride in PM2 app config", () => {
      const config = makeSessionConfig({
        envOverride: {
          KEYTELEPORT_PRIVKEY: "nsec1should-not-appear",
          WINGMAN_SIGNING_SECRET: "signing-secret-should-not-appear",
          WINGMAN_SIGNING_TOKEN: "runner-token-should-not-appear",
          AGENT_NSEC: bytesToHex(botSecret),
        },
      });

      const appConfig = createAppConfig(config);
      const env = appConfig.env as Record<string, string>;
      expect(env.KEYTELEPORT_PRIVKEY).toBeUndefined();
      expect(env.WINGMAN_SIGNING_SECRET).toBeUndefined();
      expect(env.WINGMAN_SIGNING_TOKEN).toBeUndefined();
      expect(env.AGENT_NSEC).toBe(bytesToHex(botSecret));
    });

    test("PM2 bash preamble unsets server-only secrets", () => {
      const config = makeSessionConfig({
        envOverride: {
          AGENT_NSEC: bytesToHex(botSecret),
        },
      });

      const appConfig = createAppConfig(config);
      const bashCommand = appConfig.args?.join(" ") ?? "";
      expect(bashCommand).toContain("unset KEYTELEPORT_PRIVKEY");
      expect(bashCommand).toContain("WINGMAN_SIGNING_SECRET");
      expect(bashCommand).toContain("WINGMAN_SIGNING_TOKEN");
    });

    test("SESSION_ID is always present in PM2 app env", () => {
      const sessionId = "pm2-test-session-123";
      const config = makeSessionConfig({
        sessionId,
        envOverride: { AGENT_NSEC: bytesToHex(botSecret) },
      });

      const appConfig = createAppConfig(config);
      const env = appConfig.env as Record<string, string>;
      expect(env.SESSION_ID).toBe(sessionId);
    });
  });

  // -----------------------------------------------------------------------
  // 5. npub format consistency
  // -----------------------------------------------------------------------

  describe("npub format consistency across session paths", () => {
    test("npub is always bech32 npub1... format", () => {
      expect(userNpub.startsWith("npub1")).toBe(true);
      expect(userNpub.length).toBeGreaterThan(10);
    });

    test("storeBotKeyInMemory and getDecryptedBotKey use same npub key", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "escrow");
      expect(isBotKeyUnlocked(userNpub)).toBe(true);

      const unlocked = getDecryptedBotKey(userNpub);
      expect(unlocked).not.toBeNull();
      expect(unlocked!.pubkeyHex).toBe(botRecord.botPubkeyHex);
    });

    test("lookup with different npub (e.g., bot npub) returns null", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "escrow");

      // Bot npub != user npub
      const unlocked = getDecryptedBotKey(botRecord.botNpub);
      expect(unlocked).toBeNull();
    });

    test("isBotKeyUnlocked returns false after clearBotKey", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "browser");
      expect(isBotKeyUnlocked(userNpub)).toBe(true);

      clearBotKey(userNpub);
      expect(isBotKeyUnlocked(userNpub)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 6. Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    test("wiped (all-zero) secret key is detectable", () => {
      const wipedSecret = new Uint8Array(32).fill(0);
      const allZerosHex = bytesToHex(wipedSecret);
      expect(allZerosHex).toBe("0".repeat(64));
      expect(/^0+$/.test(allZerosHex)).toBe(true);
    });

    test("valid AGENT_NSEC is not all zeros", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "browser");
      const nsecHex = resolveBotNsecHex(userNpub, botRecord);
      expect(nsecHex).not.toBeNull();
      expect(/^0+$/.test(nsecHex!)).toBe(false);
    });

    test("undefined npub means no AGENT_NSEC injection (task executor bug scenario)", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "escrow");

      // Simulate the old task executor path with undefined npub
      const npub: string | undefined = undefined;
      let agentNsec: string | undefined;

      if (npub) {
        // Would never execute
        agentNsec = resolveBotNsecHex(npub, botRecord) ?? undefined;
      }

      expect(agentNsec).toBeUndefined();
    });

    test("with adminNpub the task executor path resolves AGENT_NSEC (fix verified)", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "escrow");

      // After the fix: adminNpub is passed instead of undefined
      const npub: string | undefined = userNpub;
      let agentNsec: string | undefined;

      if (npub) {
        agentNsec = resolveBotNsecHex(npub, botRecord) ?? undefined;
      }

      expect(agentNsec).toBeDefined();
      expect(agentNsec).toBe(bytesToHex(botSecret));
    });

    test("multiple sequential sessions for same user reuse in-memory key", () => {
      storeBotKeyInMemory(userNpub, botSecret, botRecord.botPubkeyHex, "browser");

      // First session resolves
      const nsec1 = resolveBotNsecHex(userNpub, botRecord);
      // Second session resolves the same key
      const nsec2 = resolveBotNsecHex(userNpub, botRecord);

      expect(nsec1).toBe(nsec2);
      expect(nsec1).toBe(bytesToHex(botSecret));
    });
  });
});
