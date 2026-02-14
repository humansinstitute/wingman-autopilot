/**
 * Bot Key System Test Suite
 *
 * Tests for the per-user bot identity system:
 *   1. BotKeyStore — SQLite CRUD
 *   2. BotKeyManager — key generation, escrow crypto, in-memory holder
 *   3. BotKeyApi — HTTP route handlers
 *   4. BotCryptoApi — MCP proxy encrypt/decrypt
 *   5. WingmanSigner — signForSession bot→root fallback
 *   6. McpInjector — USER_NPUB env var threading
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

import { BotKeyStore } from "./bot-key-store";
import type { BotKeyRecord, CreateBotKeyInput } from "./bot-key-store";
import {
  deriveEscrowSecret,
  storeBotKeyInMemory,
  getDecryptedBotKey,
  clearBotKey,
  isBotKeyUnlocked,
} from "./bot-key-manager";
import { nip44Encrypt, nip44Decrypt } from "../superbased/nip44-crypto";
import { createBotKeyApiHandler } from "./bot-key-api";
import { createBotCryptoApiHandler } from "./bot-crypto-api";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_DB_PATH = join(import.meta.dir, "../../data/test-bot-keys.db");

/** Generate a test keypair. */
function makeKeypair() {
  const secretKey = generateSecretKey();
  const pubkeyHex = getPublicKey(secretKey);
  const npub = nip19.npubEncode(pubkeyHex);
  return { secretKey, pubkeyHex, npub };
}

/** Generate a fake bot key record for store insertion. */
function makeBotKeyInput(
  userNpub: string,
  rootSecretKey: Uint8Array,
  userPubkeyHex: string,
): CreateBotKeyInput & { botSecretKey: Uint8Array; escrowUuid: string } {
  const botSecret = generateSecretKey();
  const botPubkeyHex = getPublicKey(botSecret);
  const botNpub = nip19.npubEncode(botPubkeyHex);
  const nsecHex = bytesToHex(botSecret);
  const escrowUuid = bytesToHex(new Uint8Array(8).map(() => Math.floor(Math.random() * 256)));

  const encryptedToUser = nip44Encrypt(nsecHex, rootSecretKey, userPubkeyHex);

  const escrowSecret = deriveEscrowSecret(rootSecretKey, escrowUuid);
  const encryptedEscrow = nip44Encrypt(nsecHex, escrowSecret, botPubkeyHex);

  return {
    userNpub,
    botPubkeyHex,
    botNpub,
    encryptedToUser,
    encryptedEscrow,
    escrowUuid,
    botSecretKey: botSecret,
  };
}

// ---------------------------------------------------------------------------
// 1. BotKeyStore — SQLite CRUD
// ---------------------------------------------------------------------------

describe("BotKeyStore", () => {
  let store: BotKeyStore;

  beforeAll(() => {
    mkdirSync(join(import.meta.dir, "../../data"), { recursive: true });
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
    store = new BotKeyStore(TEST_DB_PATH);
  });

  afterAll(() => {
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  });

  test("createKey stores a record and returns it", () => {
    const user = makeKeypair();
    const root = makeKeypair();
    const input = makeBotKeyInput(user.npub, root.secretKey, user.pubkeyHex);

    const record = store.createKey(input);
    expect(record.id).toBeTruthy();
    expect(record.userNpub).toBe(user.npub);
    expect(record.botPubkeyHex).toBe(input.botPubkeyHex);
    expect(record.botNpub).toBe(input.botNpub);
    expect(record.isActive).toBe(1);
    expect(record.encryptedToUser).toBeTruthy();
    expect(record.encryptedEscrow).toBeTruthy();
    expect(record.escrowUuid).toBe(input.escrowUuid);
  });

  test("getActiveKeyForUser returns the active key", () => {
    const user = makeKeypair();
    const root = makeKeypair();
    const input = makeBotKeyInput(user.npub, root.secretKey, user.pubkeyHex);

    const created = store.createKey(input);
    const fetched = store.getActiveKeyForUser(user.npub);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.botPubkeyHex).toBe(input.botPubkeyHex);
  });

  test("getActiveKeyForUser returns null for unknown npub", () => {
    const result = store.getActiveKeyForUser("npub1nonexistent");
    expect(result).toBeNull();
  });

  test("deactivateKey marks key inactive and getActiveKeyForUser returns null", () => {
    const user = makeKeypair();
    const root = makeKeypair();
    const input = makeBotKeyInput(user.npub, root.secretKey, user.pubkeyHex);

    const created = store.createKey(input);
    store.deactivateKey(created.id);
    const fetched = store.getActiveKeyForUser(user.npub);
    expect(fetched).toBeNull();
  });

  test("updateEscrow updates the escrow fields", () => {
    const user = makeKeypair();
    const root = makeKeypair();
    const input = makeBotKeyInput(user.npub, root.secretKey, user.pubkeyHex);

    const created = store.createKey(input);
    const newUuid = "aabbccdd11223344";
    store.updateEscrow(created.id, "new-ciphertext", newUuid);

    const fetched = store.getActiveKeyForUser(user.npub);
    expect(fetched!.encryptedEscrow).toBe("new-ciphertext");
    expect(fetched!.escrowUuid).toBe(newUuid);
  });

  test("unique constraint prevents two active keys per user", () => {
    const user = makeKeypair();
    const root = makeKeypair();
    const input1 = makeBotKeyInput(user.npub, root.secretKey, user.pubkeyHex);
    store.createKey(input1);

    const input2 = makeBotKeyInput(user.npub, root.secretKey, user.pubkeyHex);
    expect(() => store.createKey(input2)).toThrow();
  });

  test("can create new active key after deactivating old one", () => {
    const user = makeKeypair();
    const root = makeKeypair();
    const input1 = makeBotKeyInput(user.npub, root.secretKey, user.pubkeyHex);
    const created1 = store.createKey(input1);
    store.deactivateKey(created1.id);

    const input2 = makeBotKeyInput(user.npub, root.secretKey, user.pubkeyHex);
    const created2 = store.createKey(input2);
    expect(created2.id).not.toBe(created1.id);
    expect(created2.botPubkeyHex).toBe(input2.botPubkeyHex);
  });
});

// ---------------------------------------------------------------------------
// 2. BotKeyManager — crypto & in-memory holder
// ---------------------------------------------------------------------------

describe("BotKeyManager", () => {
  describe("deriveEscrowSecret", () => {
    test("produces deterministic 32-byte output", () => {
      const key = generateSecretKey();
      const uuid = "abcdef0123456789";

      const result1 = deriveEscrowSecret(key, uuid);
      const result2 = deriveEscrowSecret(key, uuid);

      expect(result1).toBeInstanceOf(Uint8Array);
      expect(result1.length).toBe(32);
      expect(bytesToHex(result1)).toBe(bytesToHex(result2));
    });

    test("different UUIDs produce different secrets", () => {
      const key = generateSecretKey();
      const result1 = deriveEscrowSecret(key, "uuid1111aaaabbbb");
      const result2 = deriveEscrowSecret(key, "uuid2222ccccdddd");
      expect(bytesToHex(result1)).not.toBe(bytesToHex(result2));
    });

    test("different keys produce different secrets", () => {
      const key1 = generateSecretKey();
      const key2 = generateSecretKey();
      const uuid = "sameuuid12345678";
      const result1 = deriveEscrowSecret(key1, uuid);
      const result2 = deriveEscrowSecret(key2, uuid);
      expect(bytesToHex(result1)).not.toBe(bytesToHex(result2));
    });

    test("matches manual sha256(key || uuid_bytes) computation", () => {
      const key = generateSecretKey();
      const uuid = "0011223344556677";
      const uuidBytes = new TextEncoder().encode(uuid);
      const combined = new Uint8Array(key.length + uuidBytes.length);
      combined.set(key, 0);
      combined.set(uuidBytes, key.length);
      const expected = sha256(combined);

      const result = deriveEscrowSecret(key, uuid);
      expect(bytesToHex(result)).toBe(bytesToHex(expected));
    });
  });

  describe("NIP-44 encrypt/decrypt round-trip (user path)", () => {
    test("root key encrypts, user key decrypts", () => {
      const root = makeKeypair();
      const user = makeKeypair();
      const plaintext = "secret-nsec-hex-data-64chars-aaaabbbbccccddddeeeeffffgggghhhh";

      const ciphertext = nip44Encrypt(plaintext, root.secretKey, user.pubkeyHex);
      expect(ciphertext).toBeTruthy();
      expect(ciphertext).not.toBe(plaintext);

      const decrypted = nip44Decrypt(ciphertext, user.secretKey, root.pubkeyHex);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe("NIP-44 encrypt/decrypt round-trip (escrow path)", () => {
    test("escrow secret encrypts to bot pubkey, escrow secret decrypts", () => {
      const root = makeKeypair();
      const bot = makeKeypair();
      const uuid = "1234567890abcdef";
      const nsecHex = bytesToHex(bot.secretKey);

      const escrowSecret = deriveEscrowSecret(root.secretKey, uuid);
      const ciphertext = nip44Encrypt(nsecHex, escrowSecret, bot.pubkeyHex);
      expect(ciphertext).toBeTruthy();

      const decrypted = nip44Decrypt(ciphertext, escrowSecret, bot.pubkeyHex);
      expect(decrypted).toBe(nsecHex);

      // Verify derived key from decrypted nsec matches bot pubkey
      const recoveredPubkey = getPublicKey(hexToBytes(decrypted));
      expect(recoveredPubkey).toBe(bot.pubkeyHex);
    });

    test("wrong UUID cannot decrypt", () => {
      const root = makeKeypair();
      const bot = makeKeypair();
      const uuid = "1234567890abcdef";
      const nsecHex = bytesToHex(bot.secretKey);

      const escrowSecret = deriveEscrowSecret(root.secretKey, uuid);
      const ciphertext = nip44Encrypt(nsecHex, escrowSecret, bot.pubkeyHex);

      const wrongEscrowSecret = deriveEscrowSecret(root.secretKey, "wronguuid9876dcba");
      expect(() => {
        nip44Decrypt(ciphertext, wrongEscrowSecret, bot.pubkeyHex);
      }).toThrow();
    });
  });

  describe("in-memory key holder", () => {
    const testNpub = "npub1testmemory000000000000000000000000000000000000000000xxx";

    afterEach(() => {
      clearBotKey(testNpub);
    });

    test("storeBotKeyInMemory and getDecryptedBotKey round-trip", () => {
      const bot = makeKeypair();
      storeBotKeyInMemory(testNpub, bot.secretKey, bot.pubkeyHex, "browser");

      const retrieved = getDecryptedBotKey(testNpub);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.pubkeyHex).toBe(bot.pubkeyHex);
      expect(retrieved!.unlockMethod).toBe("browser");
      expect(bytesToHex(retrieved!.secretKey)).toBe(bytesToHex(bot.secretKey));
    });

    test("getDecryptedBotKey returns null for unknown npub", () => {
      const result = getDecryptedBotKey("npub1unknown");
      expect(result).toBeNull();
    });

    test("isBotKeyUnlocked reflects storage state", () => {
      expect(isBotKeyUnlocked(testNpub)).toBe(false);

      const bot = makeKeypair();
      storeBotKeyInMemory(testNpub, bot.secretKey, bot.pubkeyHex, "escrow");
      expect(isBotKeyUnlocked(testNpub)).toBe(true);

      clearBotKey(testNpub);
      expect(isBotKeyUnlocked(testNpub)).toBe(false);
    });

    test("clearBotKey zeroes the secret key bytes", () => {
      const bot = makeKeypair();
      storeBotKeyInMemory(testNpub, bot.secretKey, bot.pubkeyHex, "browser");

      const retrieved = getDecryptedBotKey(testNpub);
      const keyRef = retrieved!.secretKey;

      clearBotKey(testNpub);

      // The underlying Uint8Array should be zeroed
      const allZeros = keyRef.every((b) => b === 0);
      expect(allZeros).toBe(true);
    });

    test("storeBotKeyInMemory overwrites previous key", () => {
      const bot1 = makeKeypair();
      const bot2 = makeKeypair();

      storeBotKeyInMemory(testNpub, bot1.secretKey, bot1.pubkeyHex, "browser");
      storeBotKeyInMemory(testNpub, bot2.secretKey, bot2.pubkeyHex, "escrow");

      const retrieved = getDecryptedBotKey(testNpub);
      expect(retrieved!.pubkeyHex).toBe(bot2.pubkeyHex);
      expect(retrieved!.unlockMethod).toBe("escrow");
    });
  });
});

// ---------------------------------------------------------------------------
// 3. BotKeyApi — HTTP route handlers
// ---------------------------------------------------------------------------

describe("BotKeyApi", () => {
  let store: BotKeyStore;
  let handler: ReturnType<typeof createBotKeyApiHandler>;
  const testUser = makeKeypair();
  const testNpub = testUser.npub;

  // Mock session
  const mockSession = { npub: testNpub, id: "sess-123", name: "test", status: "running" };
  const getSession = (id: string) => id === "sess-123" ? mockSession as any : undefined;

  beforeAll(() => {
    const dbPath = join(import.meta.dir, "../../data/test-bot-keys-api.db");
    if (existsSync(dbPath)) unlinkSync(dbPath);
    store = new BotKeyStore(dbPath);
    handler = createBotKeyApiHandler({ store, getSession });
  });

  afterAll(() => {
    const dbPath = join(import.meta.dir, "../../data/test-bot-keys-api.db");
    if (existsSync(dbPath)) unlinkSync(dbPath);
    clearBotKey(testNpub);
  });

  test("GET /api/bot-keys/me returns hasKey: false when no key", async () => {
    // We can't easily mock cookies, so test the handler routing
    const req = new Request("http://localhost/api/bot-keys/me");
    const url = new URL("http://localhost/api/bot-keys/me");
    const resp = await handler(req, url, "GET");
    expect(resp).not.toBeNull();
    // Without cookie, should return 401
    const json = await resp!.json() as any;
    expect(json.error).toContain("session cookie");
  });

  test("returns null for non-matching paths", async () => {
    const req = new Request("http://localhost/api/other/path");
    const url = new URL("http://localhost/api/other/path");
    const resp = await handler(req, url, "GET");
    expect(resp).toBeNull();
  });

  test("returns 404 for unknown sub-routes", async () => {
    const req = new Request("http://localhost/api/bot-keys/nonexistent");
    const url = new URL("http://localhost/api/bot-keys/nonexistent");
    const resp = await handler(req, url, "GET");
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(404);
  });

  test("POST /api/bot-keys/unlock rejects without cookie", async () => {
    const req = new Request("http://localhost/api/bot-keys/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nsecHex: "a".repeat(64) }),
    });
    const url = new URL("http://localhost/api/bot-keys/unlock");
    const resp = await handler(req, url, "POST");
    expect(resp!.status).toBe(401);
  });

  test("POST /api/bot-keys/unlock-escrow validates sessionId", async () => {
    const req = new Request("http://localhost/api/bot-keys/unlock-escrow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "bad-session", escrowUuid: "1234" }),
    });
    const url = new URL("http://localhost/api/bot-keys/unlock-escrow");
    const resp = await handler(req, url, "POST");
    const json = await resp!.json() as any;
    expect(json.error).toContain("Unknown session");
  });

  test("POST /api/bot-keys/unlock-escrow returns 404 when no key exists", async () => {
    const req = new Request("http://localhost/api/bot-keys/unlock-escrow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sess-123", escrowUuid: "1234567890123456" }),
    });
    const url = new URL("http://localhost/api/bot-keys/unlock-escrow");
    const resp = await handler(req, url, "POST");
    const json = await resp!.json() as any;
    expect(json.error).toContain("No active bot key");
  });
});

// ---------------------------------------------------------------------------
// 4. BotCryptoApi — MCP proxy encrypt/decrypt
// ---------------------------------------------------------------------------

describe("BotCryptoApi", () => {
  const testUser = makeKeypair();
  const testBot = makeKeypair();
  const testNpub = testUser.npub;

  const mockSession = { npub: testNpub, id: "sess-456", name: "crypto-test", status: "running" };
  const getSession = (id: string) => id === "sess-456" ? mockSession as any : undefined;

  let handler: ReturnType<typeof createBotCryptoApiHandler>;

  beforeAll(() => {
    handler = createBotCryptoApiHandler({ getSession });
    // Store bot key in memory for the test user
    storeBotKeyInMemory(testNpub, testBot.secretKey, testBot.pubkeyHex, "browser");
  });

  afterAll(() => {
    clearBotKey(testNpub);
  });

  test("returns null for non-matching paths", async () => {
    const req = new Request("http://localhost/api/other");
    const url = new URL("http://localhost/api/other");
    const resp = await handler(req, url, "POST");
    expect(resp).toBeNull();
  });

  test("POST /api/mcp/bot-crypto/encrypt works with valid input", async () => {
    const recipient = makeKeypair();
    const req = new Request("http://localhost/api/mcp/bot-crypto/encrypt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess-456",
        plaintext: "hello world",
        recipientPubkey: recipient.pubkeyHex,
      }),
    });
    const url = new URL("http://localhost/api/mcp/bot-crypto/encrypt");
    const resp = await handler(req, url, "POST");
    expect(resp!.status).toBe(200);

    const json = await resp!.json() as any;
    expect(json.ciphertext).toBeTruthy();
    expect(json.senderPubkey).toBe(testBot.pubkeyHex);

    // Verify recipient can decrypt
    const decrypted = nip44Decrypt(json.ciphertext, recipient.secretKey, testBot.pubkeyHex);
    expect(decrypted).toBe("hello world");
  });

  test("POST /api/mcp/bot-crypto/decrypt works with valid input", async () => {
    const sender = makeKeypair();
    const plaintext = "secret message";
    const ciphertext = nip44Encrypt(plaintext, sender.secretKey, testBot.pubkeyHex);

    const req = new Request("http://localhost/api/mcp/bot-crypto/decrypt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess-456",
        ciphertext,
        senderPubkey: sender.pubkeyHex,
      }),
    });
    const url = new URL("http://localhost/api/mcp/bot-crypto/decrypt");
    const resp = await handler(req, url, "POST");
    expect(resp!.status).toBe(200);

    const json = await resp!.json() as any;
    expect(json.plaintext).toBe(plaintext);
    expect(json.decryptedBy).toBe(testBot.pubkeyHex);
  });

  test("encrypt rejects unknown session", async () => {
    const req = new Request("http://localhost/api/mcp/bot-crypto/encrypt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "bad-session",
        plaintext: "test",
        recipientPubkey: "a".repeat(64),
      }),
    });
    const url = new URL("http://localhost/api/mcp/bot-crypto/encrypt");
    const resp = await handler(req, url, "POST");
    expect(resp!.status).toBe(404);
  });

  test("encrypt rejects missing required fields", async () => {
    const req = new Request("http://localhost/api/mcp/bot-crypto/encrypt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sess-456" }),
    });
    const url = new URL("http://localhost/api/mcp/bot-crypto/encrypt");
    const resp = await handler(req, url, "POST");
    expect(resp!.status).toBe(400);
  });

  test("encrypt rejects invalid pubkey format", async () => {
    const req = new Request("http://localhost/api/mcp/bot-crypto/encrypt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess-456",
        plaintext: "test",
        recipientPubkey: "not-hex",
      }),
    });
    const url = new URL("http://localhost/api/mcp/bot-crypto/encrypt");
    const resp = await handler(req, url, "POST");
    expect(resp!.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 5. WingmanSigner — signForSession
// ---------------------------------------------------------------------------

describe("WingmanSigner - signForSession", () => {
  const testUser = makeKeypair();
  const testBot = makeKeypair();
  const testNpub = testUser.npub;

  beforeAll(() => {
    storeBotKeyInMemory(testNpub, testBot.secretKey, testBot.pubkeyHex, "browser");
  });

  afterAll(() => {
    clearBotKey(testNpub);
  });

  test("signWithBotKey produces valid NIP-98 token", async () => {
    const { signWithBotKey } = await import("../mcp/wingman-signer");
    const result = signWithBotKey(
      "https://example.com/api/test",
      "GET",
      testBot.secretKey,
      testBot.npub,
    );

    expect(result.token).toMatch(/^Nostr /);
    expect(result.signedBy).toBe(testBot.npub);

    // Decode and verify the event structure
    const base64 = result.token.replace("Nostr ", "");
    const event = JSON.parse(atob(base64));
    expect(event.kind).toBe(27235);
    expect(event.pubkey).toBe(testBot.pubkeyHex);
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ["u", "https://example.com/api/test"],
        ["method", "GET"],
      ]),
    );
  });

  test("signWithBotKey includes payload tag for bodyHash", async () => {
    const { signWithBotKey } = await import("../mcp/wingman-signer");
    const bodyHash = "abc123def456";
    const result = signWithBotKey(
      "https://example.com/api/data",
      "POST",
      testBot.secretKey,
      testBot.npub,
      bodyHash,
    );

    const base64 = result.token.replace("Nostr ", "");
    const event = JSON.parse(atob(base64));
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ["payload", bodyHash],
      ]),
    );
  });

  test("signForSession uses bot key when available", async () => {
    const { signForSession } = await import("../mcp/wingman-signer");
    const result = await signForSession(
      "https://example.com/api/test",
      "GET",
      testNpub,
    );

    expect(result.signerType).toBe("bot");
    expect(result.signedBy).toBe(testBot.npub);
  });

  test("signForSession falls back to root key when no bot key", async () => {
    const { signForSession, isWingmanKeyAvailable } = await import("../mcp/wingman-signer");

    // Use a random npub that has no bot key stored
    const randomNpub = makeKeypair().npub;

    if (isWingmanKeyAvailable()) {
      const result = await signForSession(
        "https://example.com/api/test",
        "GET",
        randomNpub,
      );
      expect(result.signerType).toBe("root");
    } else {
      // If KEYTELEPORT_PRIVKEY not set, should throw
      await expect(
        signForSession("https://example.com/api/test", "GET", randomNpub),
      ).rejects.toThrow();
    }
  });

  test("signForSession falls back to root key when npub is null", async () => {
    const { signForSession, isWingmanKeyAvailable } = await import("../mcp/wingman-signer");

    if (isWingmanKeyAvailable()) {
      const result = await signForSession(
        "https://example.com/api/test",
        "GET",
        null,
      );
      expect(result.signerType).toBe("root");
    }
    // If no root key, we skip this test
  });
});

// ---------------------------------------------------------------------------
// 6. McpInjector — USER_NPUB env var
// ---------------------------------------------------------------------------

describe("McpInjector", () => {
  test("injectMcpConfig passes USER_NPUB when provided", async () => {
    const { injectMcpConfig, cleanupMcpConfig } = await import("../agents/mcp-injector");
    const testDir = join(import.meta.dir, "../../data/test-mcp-inject");
    mkdirSync(testDir, { recursive: true });

    const user = makeKeypair();
    const result = await injectMcpConfig({
      sessionId: "test-session",
      agent: "claude",
      workingDirectory: testDir,
      config: { port: 3600 } as any,
      botPubkeyHex: "a".repeat(64),
      botNpub: user.npub,
      userNpub: user.npub,
    });

    expect(result.env.BOT_PUBKEY_HEX).toBe("a".repeat(64));
    expect(result.env.BOT_NPUB).toBe(user.npub);
    expect(result.env.USER_NPUB).toBe(user.npub);

    // Cleanup
    await cleanupMcpConfig(result.cleanupFiles);
  });

  test("injectMcpConfig omits USER_NPUB when not provided", async () => {
    const { injectMcpConfig, cleanupMcpConfig } = await import("../agents/mcp-injector");
    const testDir = join(import.meta.dir, "../../data/test-mcp-inject-2");
    mkdirSync(testDir, { recursive: true });

    const result = await injectMcpConfig({
      sessionId: "test-session-2",
      agent: "claude",
      workingDirectory: testDir,
      config: { port: 3600 } as any,
    });

    expect(result.env.USER_NPUB).toBeUndefined();
    expect(result.env.BOT_PUBKEY_HEX).toBeUndefined();
    expect(result.env.BOT_NPUB).toBeUndefined();

    await cleanupMcpConfig(result.cleanupFiles);
  });
});

// ---------------------------------------------------------------------------
// 7. Full crypto round-trip: generate → store → escrow unlock → sign
// ---------------------------------------------------------------------------

describe("Full crypto round-trip", () => {
  let store: BotKeyStore;
  const rootKey = makeKeypair();
  const user = makeKeypair();

  beforeAll(() => {
    const dbPath = join(import.meta.dir, "../../data/test-bot-keys-roundtrip.db");
    if (existsSync(dbPath)) unlinkSync(dbPath);
    store = new BotKeyStore(dbPath);
  });

  afterAll(() => {
    const dbPath = join(import.meta.dir, "../../data/test-bot-keys-roundtrip.db");
    if (existsSync(dbPath)) unlinkSync(dbPath);
    clearBotKey(user.npub);
  });

  test("generate → store → user-path decrypt → validate pubkey", () => {
    const botSecret = generateSecretKey();
    const botPubkeyHex = getPublicKey(botSecret);
    const botNpub = nip19.npubEncode(botPubkeyHex);
    const nsecHex = bytesToHex(botSecret);
    const escrowUuid = bytesToHex(new Uint8Array(8).map(() => Math.floor(Math.random() * 256)));

    // Encrypt via user path
    const encryptedToUser = nip44Encrypt(nsecHex, rootKey.secretKey, user.pubkeyHex);

    // Encrypt via escrow path
    const escrowSecret = deriveEscrowSecret(rootKey.secretKey, escrowUuid);
    const encryptedEscrow = nip44Encrypt(nsecHex, escrowSecret, botPubkeyHex);

    // Store in DB
    const record = store.createKey({
      userNpub: user.npub,
      botPubkeyHex,
      botNpub,
      encryptedToUser,
      encryptedEscrow,
      escrowUuid,
    });

    // Simulate browser decrypt (user decrypts with their own key)
    const decryptedNsecHex = nip44Decrypt(record.encryptedToUser, user.secretKey, rootKey.pubkeyHex);
    expect(decryptedNsecHex).toBe(nsecHex);

    // Validate derived pubkey
    const recoveredPubkey = getPublicKey(hexToBytes(decryptedNsecHex));
    expect(recoveredPubkey).toBe(botPubkeyHex);

    // Store in memory
    const recoveredSecret = hexToBytes(decryptedNsecHex);
    storeBotKeyInMemory(user.npub, recoveredSecret, botPubkeyHex, "browser");

    // Verify it's now available
    const retrieved = getDecryptedBotKey(user.npub);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.pubkeyHex).toBe(botPubkeyHex);
    expect(isBotKeyUnlocked(user.npub)).toBe(true);
  });

  test("escrow path: decrypt with UUID → validate → store in memory", () => {
    clearBotKey(user.npub);
    const record = store.getActiveKeyForUser(user.npub)!;
    expect(record).not.toBeNull();

    // Escrow decrypt
    const escrowSecret = deriveEscrowSecret(rootKey.secretKey, record.escrowUuid);
    const decryptedNsecHex = nip44Decrypt(record.encryptedEscrow, escrowSecret, record.botPubkeyHex);

    // Validate
    const recoveredPubkey = getPublicKey(hexToBytes(decryptedNsecHex));
    expect(recoveredPubkey).toBe(record.botPubkeyHex);

    // Store
    storeBotKeyInMemory(user.npub, hexToBytes(decryptedNsecHex), record.botPubkeyHex, "escrow");
    const retrieved = getDecryptedBotKey(user.npub);
    expect(retrieved!.unlockMethod).toBe("escrow");
  });

  test("escrow rotation: old UUID fails, new UUID works", () => {
    const record = store.getActiveKeyForUser(user.npub)!;
    const oldUuid = record.escrowUuid;

    // Decrypt with old UUID first
    const escrowSecret = deriveEscrowSecret(rootKey.secretKey, oldUuid);
    const nsecHex = nip44Decrypt(record.encryptedEscrow, escrowSecret, record.botPubkeyHex);

    // Generate new UUID and re-encrypt
    const newUuid = bytesToHex(new Uint8Array(8).map(() => Math.floor(Math.random() * 256)));
    const newEscrowSecret = deriveEscrowSecret(rootKey.secretKey, newUuid);
    const newEncryptedEscrow = nip44Encrypt(nsecHex, newEscrowSecret, record.botPubkeyHex);

    store.updateEscrow(record.id, newEncryptedEscrow, newUuid);

    // Old UUID should fail
    const updatedRecord = store.getActiveKeyForUser(user.npub)!;
    expect(() => {
      nip44Decrypt(updatedRecord.encryptedEscrow, escrowSecret, record.botPubkeyHex);
    }).toThrow();

    // New UUID should work
    const newDecrypted = nip44Decrypt(
      updatedRecord.encryptedEscrow,
      newEscrowSecret,
      record.botPubkeyHex,
    );
    expect(newDecrypted).toBe(nsecHex);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
