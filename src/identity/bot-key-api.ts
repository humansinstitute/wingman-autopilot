/**
 * Bot Key API Handler
 *
 * HTTP handler for /api/bot-keys/* routes.
 * Manages per-user bot keypair lifecycle: query, unlock, rotate, replace.
 */

import { getPublicKey } from "nostr-tools";

import { readSessionCookie } from "../auth/session-cookie";
import type { BotKeyStore, BotKeyRecord } from "./bot-key-store";
import {
  generateBotKey,
  unlockViaEscrow,
  rotateEscrowUuid,
  storeBotKeyInMemory,
  getDecryptedBotKey,
  isBotKeyUnlocked,
} from "./bot-key-manager";
import type { SessionSnapshot } from "../agents/process-manager";
import { normaliseNpub } from "./npub-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BotKeyApiDependencies {
  store: BotKeyStore;
  getSession: (sessionId: string) => SessionSnapshot | undefined;
  onBotKeyUnlocked?: (npub: string, secretKey: Uint8Array, botPubkeyHex: string) => void;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object") {
      throw new Error("Expected JSON object");
    }
    return body as Record<string, unknown>;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function getNpubFromCookie(request: Request): string | null {
  try {
    const cookieHeader = request.headers.get("cookie");
    const session = readSessionCookie(cookieHeader);
    return session?.npub ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createBotKeyApiHandler(deps: BotKeyApiDependencies) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/bot-keys")) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    // segments: ["api", "bot-keys", ...]

    try {
      // GET /api/bot-keys/me
      if (segments.length === 3 && segments[2] === "me" && method === "GET") {
        return handleGetMe(deps, request);
      }

      // GET /api/bot-keys/encrypted
      if (segments.length === 3 && segments[2] === "encrypted" && method === "GET") {
        return handleGetEncrypted(deps, request);
      }

      // POST /api/bot-keys/unlock
      if (segments.length === 3 && segments[2] === "unlock" && method === "POST") {
        return await handleUnlock(deps, request);
      }

      // POST /api/bot-keys/unlock-escrow
      if (segments.length === 3 && segments[2] === "unlock-escrow" && method === "POST") {
        return await handleUnlockEscrow(deps, request);
      }

      // POST /api/bot-keys/rotate-escrow
      if (segments.length === 3 && segments[2] === "rotate-escrow" && method === "POST") {
        return await handleRotateEscrow(deps, request);
      }

      // POST /api/bot-keys/replace
      if (segments.length === 3 && segments[2] === "replace" && method === "POST") {
        return await handleReplace(deps, request);
      }

      return jsonError("Not found", 404);
    } catch (err) {
      console.error("[bot-key-api] Error:", err);
      return jsonError((err as Error).message, 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/bot-keys/me
 *
 * Returns the user's bot identity (npub, pubkey, unlock status).
 */
function handleGetMe(deps: BotKeyApiDependencies, request: Request): Response {
  const npub = getNpubFromCookie(request);
  if (!npub) {
    return jsonError("Not authenticated — session cookie required", 401);
  }

  const record = deps.store.getActiveKeyForUser(npub);
  if (!record) {
    return Response.json({ hasKey: false });
  }

  return Response.json({
    hasKey: true,
    botNpub: record.botNpub,
    botPubkeyHex: record.botPubkeyHex,
    unlocked: isBotKeyUnlocked(npub),
    createdAt: record.createdAt,
  });
}

/**
 * GET /api/bot-keys/encrypted
 *
 * Returns the NIP-44 blob encrypted to the user's pubkey for browser decryption.
 */
async function handleGetEncrypted(deps: BotKeyApiDependencies, request: Request): Promise<Response> {
  const npub = getNpubFromCookie(request);
  if (!npub) {
    return jsonError("Not authenticated — session cookie required", 401);
  }

  const record = deps.store.getActiveKeyForUser(npub);
  if (!record) {
    return jsonError("No active bot key for this user", 404);
  }

  // Include the root pubkey so the browser knows the sender for NIP-44 decrypt
  let senderPubkey: string | null = null;
  try {
    const { getKeyTeleportIdentity } = await import("../config");
    const identity = getKeyTeleportIdentity();
    senderPubkey = identity?.pubkey ?? null;
  } catch { /* non-fatal */ }

  return Response.json({
    encryptedToUser: record.encryptedToUser,
    botPubkeyHex: record.botPubkeyHex,
    botNpub: record.botNpub,
    senderPubkey,
  });
}

/**
 * POST /api/bot-keys/unlock
 *
 * Browser posts decrypted nsec hex after NIP-07/device keystore decryption.
 * Body: { nsecHex }
 */
async function handleUnlock(deps: BotKeyApiDependencies, request: Request): Response {
  const npub = getNpubFromCookie(request);
  if (!npub) {
    return jsonError("Not authenticated — session cookie required", 401);
  }

  const record = deps.store.getActiveKeyForUser(npub);
  if (!record) {
    return jsonError("No active bot key for this user", 404);
  }

  const body = await parseBody(request);
  let nsecHex = (body.nsecHex as string | undefined)?.trim();
  // Left-pad if leading zero was dropped (some NIP-07 extensions strip it)
  if (nsecHex && /^[0-9a-fA-F]{63}$/.test(nsecHex)) nsecHex = "0" + nsecHex;
  if (!nsecHex || !/^[0-9a-fA-F]{64}$/.test(nsecHex)) {
    return jsonError("nsecHex must be a 64-character hex string", 400);
  }

  // Validate: derive pubkey from provided secret and compare
  const secretKey = hexToBytes(nsecHex);
  const derivedPubkey = getPublicKey(secretKey);
  if (derivedPubkey !== record.botPubkeyHex) {
    secretKey.fill(0);
    return jsonError("Provided key does not match the bot's public key", 403);
  }

  storeBotKeyInMemory(npub, secretKey, record.botPubkeyHex, "browser");
  deps.onBotKeyUnlocked?.(npub, secretKey, record.botPubkeyHex);

  return Response.json({ unlocked: true, botNpub: record.botNpub });
}

/**
 * POST /api/bot-keys/unlock-escrow
 *
 * Autonomous unlock using escrow UUID. Validated by session ID.
 * Body: { sessionId, escrowUuid }
 */
async function handleUnlockEscrow(deps: BotKeyApiDependencies, request: Request): Response {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const escrowUuid = body.escrowUuid as string | undefined;

  if (!sessionId || !escrowUuid) {
    return jsonError("sessionId and escrowUuid are required", 400);
  }

  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }
  if (!session.npub) {
    return jsonError("Session has no associated user", 403);
  }

  const record = deps.store.getActiveKeyForUser(session.npub);
  if (!record) {
    return jsonError("No active bot key for this user", 404);
  }

  if (escrowUuid !== record.escrowUuid) {
    return jsonError("Invalid escrow UUID", 403);
  }

  try {
    const secretKey = unlockViaEscrow(record.encryptedEscrow, record.botPubkeyHex, escrowUuid);
    storeBotKeyInMemory(session.npub, secretKey, record.botPubkeyHex, "escrow");
    deps.onBotKeyUnlocked?.(session.npub, secretKey, record.botPubkeyHex);
    return Response.json({ unlocked: true, botNpub: record.botNpub });
  } catch (err) {
    return jsonError(`Escrow unlock failed: ${(err as Error).message}`, 403);
  }
}

/**
 * POST /api/bot-keys/rotate-escrow
 *
 * Rotate the escrow UUID. Returns the new UUID.
 * Body: { currentUuid }
 */
async function handleRotateEscrow(deps: BotKeyApiDependencies, request: Request): Response {
  const npub = getNpubFromCookie(request);
  if (!npub) {
    return jsonError("Not authenticated — session cookie required", 401);
  }

  const record = deps.store.getActiveKeyForUser(npub);
  if (!record) {
    return jsonError("No active bot key for this user", 404);
  }

  const body = await parseBody(request);
  const currentUuid = body.currentUuid as string | undefined;
  if (!currentUuid) {
    return jsonError("currentUuid is required", 400);
  }

  if (currentUuid !== record.escrowUuid) {
    return jsonError("Invalid current escrow UUID", 403);
  }

  try {
    const { newEncryptedEscrow, newEscrowUuid } = rotateEscrowUuid(
      record.encryptedEscrow,
      record.botPubkeyHex,
      currentUuid,
    );
    deps.store.updateEscrow(record.id, newEncryptedEscrow, newEscrowUuid);
    return Response.json({ rotated: true, newEscrowUuid });
  } catch (err) {
    return jsonError(`Escrow rotation failed: ${(err as Error).message}`, 500);
  }
}

/**
 * POST /api/bot-keys/replace
 *
 * Deactivate the old key and generate a new keypair.
 * Body: { userPubkeyHex }
 */
async function handleReplace(deps: BotKeyApiDependencies, request: Request): Response {
  const npub = getNpubFromCookie(request);
  if (!npub) {
    return jsonError("Not authenticated — session cookie required", 401);
  }

  const body = await parseBody(request);
  const userPubkeyHex = body.userPubkeyHex as string | undefined;
  if (!userPubkeyHex || !/^[0-9a-fA-F]{64}$/.test(userPubkeyHex)) {
    return jsonError("userPubkeyHex must be a 64-character hex string", 400);
  }

  // Deactivate existing key if any
  const existing = deps.store.getActiveKeyForUser(npub);
  if (existing) {
    deps.store.deactivateKey(existing.id);
  }

  // Generate new keypair
  const generated = generateBotKey(userPubkeyHex);
  const record = deps.store.createKey({
    userNpub: npub,
    botPubkeyHex: generated.botPubkeyHex,
    botNpub: generated.botNpub,
    encryptedToUser: generated.encryptedToUser,
    encryptedEscrow: generated.encryptedEscrow,
    escrowUuid: generated.escrowUuid,
  });

  return Response.json({
    replaced: true,
    botNpub: record.botNpub,
    botPubkeyHex: record.botPubkeyHex,
    escrowUuid: record.escrowUuid,
  });
}
