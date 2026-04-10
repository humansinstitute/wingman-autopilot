/**
 * Bot Key API Handler
 *
 * HTTP handler for /api/bot-keys/* routes.
 * Manages per-user bot keypair lifecycle: query, unlock, rotate, replace.
 */

import { getPublicKey, nip19 } from "nostr-tools";

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
import { exportBotKeyForUser } from "./bot-key-export";
import { buildDelegateRegistryTemplate, getBotDisplayName, signBotProfileEvent } from "./bot-identity-publisher";
import { publishDelegateRegistryEvent } from "./delegate-registry-publisher";
import { getBotProfileStatus, publishBotProfileEvent } from "./bot-profile-publisher";
import type { SessionSnapshot } from "../agents/process-manager";
import type { StoredSessionRecord } from "../storage/message-store";
import { normaliseNpub } from "./npub-utils";
import { parseBody, jsonError } from "../utils/request-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BotKeyApiDependencies {
  store: BotKeyStore;
  getSession: (sessionId: string) => SessionSnapshot | undefined;
  getStoredSession?: (sessionId: string) => StoredSessionRecord | null;
  onBotKeyUnlocked?: (npub: string, secretKey: Uint8Array, botPubkeyHex: string) => void;
  defaultRelays?: string[];
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

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

      // POST /api/bot-keys/export-nsec
      if (segments.length === 3 && segments[2] === "export-nsec" && method === "POST") {
        return await handleExportNsec(deps, request);
      }

      // POST /api/bot-keys/force-sync
      if (segments.length === 3 && segments[2] === "force-sync" && method === "POST") {
        return await handleForceSync(deps, request);
      }

      // GET /api/bot-keys/delegate-registry
      if (segments.length === 3 && segments[2] === "delegate-registry" && method === "GET") {
        return handleDelegateRegistry(deps, request);
      }
      // POST /api/bot-keys/delegate-registry/publish
      if (
        segments.length === 4 &&
        segments[2] === "delegate-registry" &&
        segments[3] === "publish" &&
        method === "POST"
      ) {
        return await handlePublishDelegateRegistry(deps, request);
      }
      // GET /api/bot-keys/bot-profile/status
      if (segments.length === 4 && segments[2] === "bot-profile" && segments[3] === "status" && method === "GET") {
        return await handleBotProfileStatus(deps, request, url);
      }
      // POST /api/bot-keys/bot-profile/publish
      if (segments.length === 4 && segments[2] === "bot-profile" && segments[3] === "publish" && method === "POST") {
        return await handlePublishBotProfile(deps, request);
      }

      return jsonError("Not found", 404);
    } catch (err) {
      console.error("[bot-key-api] Error:", err);
      return jsonError((err as Error).message, 500);
    }
  };
}

/**
 * POST /api/bot-keys/delegate-registry/publish
 *
 * Accepts a browser-signed kind 30078 event and publishes it to relays.
 * Body: { signedEvent, relays? }
 */
async function handlePublishDelegateRegistry(deps: BotKeyApiDependencies, request: Request): Promise<Response> {
  const npub = getNpubFromCookie(request);
  if (!npub) {
    return jsonError("Not authenticated — session cookie required", 401);
  }
  const userNpub = normaliseNpub(npub);
  if (!userNpub) {
    return jsonError("Invalid session npub", 400);
  }
  const record = deps.store.getActiveKeyForUser(userNpub);
  if (!record) {
    return jsonError("No active bot key for this user", 404);
  }

  const body = await parseBody(request);
  const signedEvent = body.signedEvent;
  const relays = body.relays;

  try {
    const result = await publishDelegateRegistryEvent({
      ownerNpub: userNpub,
      signedEvent,
      expectedDelegatePubkeys: [record.botPubkeyHex],
      requestedRelays: relays,
      defaultRelays: Array.isArray(deps.defaultRelays) ? deps.defaultRelays : [],
    });
    return Response.json({ published: true, ...result });
  } catch (err) {
    return jsonError((err as Error).message, 400);
  }
}

/**
 * GET /api/bot-keys/bot-profile/status
 *
 * Checks whether the active bot already has a kind 0 profile on relays.
 * Query: ?relays=wss://...,wss://...
 */
async function handleBotProfileStatus(deps: BotKeyApiDependencies, request: Request, url: URL): Promise<Response> {
  const npub = getNpubFromCookie(request);
  if (!npub) {
    return jsonError("Not authenticated — session cookie required", 401);
  }

  const record = deps.store.getActiveKeyForUser(npub);
  if (!record) {
    return jsonError("No active bot key for this user", 404);
  }

  const relayParam = url.searchParams.get("relays");
  const requestedRelays = relayParam
    ? relayParam
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
    : undefined;

  try {
    const status = await getBotProfileStatus({
      botPubkeyHex: record.botPubkeyHex,
      requestedRelays,
      defaultRelays: Array.isArray(deps.defaultRelays) ? deps.defaultRelays : [],
    });
    return Response.json({
      ...status,
      botPubkeyHex: record.botPubkeyHex,
      botNpub: record.botNpub,
    });
  } catch (err) {
    return jsonError((err as Error).message, 400);
  }
}

/**
 * POST /api/bot-keys/bot-profile/publish
 *
 * Publishes a server-signed kind 0 profile event for the active bot.
 * Body: { relays? }
 */
async function handlePublishBotProfile(deps: BotKeyApiDependencies, request: Request): Promise<Response> {
  const npub = getNpubFromCookie(request);
  if (!npub) {
    return jsonError("Not authenticated — session cookie required", 401);
  }

  const record = deps.store.getActiveKeyForUser(npub);
  if (!record) {
    return jsonError("No active bot key for this user", 404);
  }

  const body = await parseBody(request);
  const relays = body.relays;
  const displayName = record.displayName || getBotDisplayName(record.botPubkeyHex);

  // Resolve signing key for this authenticated user's active bot.
  // Prefer unlocked in-memory key; otherwise unlock via escrow on demand.
  let transientSecretKey: Uint8Array | null = null;
  const unlocked = getDecryptedBotKey(npub);
  const signingKey = unlocked?.pubkeyHex === record.botPubkeyHex
    ? unlocked.secretKey
    : (transientSecretKey = unlockViaEscrow(
      record.encryptedEscrow,
      record.botPubkeyHex,
      record.escrowUuid,
    ));

  try {
    const signedEvent = signBotProfileEvent(signingKey, displayName);
    const result = await publishBotProfileEvent({
      botPubkeyHex: record.botPubkeyHex,
      signedEvent,
      requestedRelays: relays,
      defaultRelays: Array.isArray(deps.defaultRelays) ? deps.defaultRelays : [],
    });
    return Response.json({ published: true, signedEvent, ...result });
  } catch (err) {
    return jsonError((err as Error).message, 400);
  } finally {
    transientSecretKey?.fill(0);
  }
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
    displayName: record.displayName || getBotDisplayName(record.botPubkeyHex),
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
async function handleUnlock(deps: BotKeyApiDependencies, request: Request): Promise<Response> {
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
async function handleUnlockEscrow(deps: BotKeyApiDependencies, request: Request): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const escrowUuid = body.escrowUuid as string | undefined;

  if (!sessionId || !escrowUuid) {
    return jsonError("sessionId and escrowUuid are required", 400);
  }

  const session = deps.getSession(sessionId) ?? deps.getStoredSession?.(sessionId) ?? null;
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
 * POST /api/bot-keys/export-nsec
 *
 * Returns the bot key nsec for the calling session's user.
 * Used by CLIs and downstream tools to obtain AGENT_NSEC.
 * Body: { sessionId }
 */
async function handleExportNsec(deps: BotKeyApiDependencies, request: Request): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;

  if (!sessionId) {
    return jsonError("sessionId is required", 400);
  }

  const session = deps.getSession(sessionId) ?? deps.getStoredSession?.(sessionId) ?? null;
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

  const exported = exportBotKeyForUser(session.npub, record);
  if (!exported) {
    return jsonError("Could not resolve bot key — escrow unlock failed", 503);
  }

  return Response.json({
    nsec: exported.nsec,
    nsecHex: exported.nsecHex,
    botPubkeyHex: exported.botPubkeyHex,
    botNpub: exported.botNpub,
    source: exported.source,
  });
}

/**
 * POST /api/bot-keys/rotate-escrow
 *
 * Rotate the escrow UUID. Returns the new UUID.
 * Body: { currentUuid }
 */
async function handleRotateEscrow(deps: BotKeyApiDependencies, request: Request): Promise<Response> {
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
async function handleReplace(deps: BotKeyApiDependencies, request: Request): Promise<Response> {
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

  // Generate new keypair (also signs kind 0 profile event)
  const generated = generateBotKey(userPubkeyHex);
  const record = deps.store.createKey({
    userNpub: npub,
    botPubkeyHex: generated.botPubkeyHex,
    botNpub: generated.botNpub,
    displayName: generated.displayName,
    encryptedToUser: generated.encryptedToUser,
    encryptedEscrow: generated.encryptedEscrow,
    escrowUuid: generated.escrowUuid,
  });

  return Response.json({
    replaced: true,
    botNpub: record.botNpub,
    botPubkeyHex: record.botPubkeyHex,
    displayName: generated.displayName,
    signedProfileEvent: generated.signedProfileEvent,
  });
}

/**
 * POST /api/bot-keys/force-sync
 *
 * Ensures an authenticated user has a bot key, unlocks it in memory via escrow,
 * and ensures bot profile kind 0 is published.
 */
async function handleForceSync(deps: BotKeyApiDependencies, request: Request): Promise<Response> {
  const npub = getNpubFromCookie(request);
  if (!npub) {
    return jsonError("Not authenticated — session cookie required", 401);
  }

  const decode = nip19.decode(npub);
  if (decode.type !== "npub" || typeof decode.data !== "string") {
    return jsonError("Invalid npub in session", 400);
  }
  const userPubkeyHex = decode.data;

  let record = deps.store.getActiveKeyForUser(npub);
  let created = false;
  if (!record) {
    const generated = generateBotKey(userPubkeyHex);
    record = deps.store.createKey({
      userNpub: npub,
      botPubkeyHex: generated.botPubkeyHex,
      botNpub: generated.botNpub,
      displayName: generated.displayName,
      encryptedToUser: generated.encryptedToUser,
      encryptedEscrow: generated.encryptedEscrow,
      escrowUuid: generated.escrowUuid,
    });
    created = true;
  }

  let unlocked = isBotKeyUnlocked(npub);
  if (!unlocked) {
    const secretKey = unlockViaEscrow(record.encryptedEscrow, record.botPubkeyHex, record.escrowUuid);
    storeBotKeyInMemory(npub, secretKey, record.botPubkeyHex, "escrow");
    deps.onBotKeyUnlocked?.(npub, secretKey, record.botPubkeyHex);
    unlocked = true;
  }

  const relays = Array.isArray(deps.defaultRelays) ? deps.defaultRelays : [];
  let botProfilePublished = false;
  let botProfileError: string | null = null;
  if (relays.length > 0) {
    try {
      const status = await getBotProfileStatus({
        botPubkeyHex: record.botPubkeyHex,
        defaultRelays: relays,
      });
      if (!status.exists) {
        const key = getDecryptedBotKey(npub);
        if (!key || key.pubkeyHex !== record.botPubkeyHex) {
          throw new Error("Bot key unavailable in memory for profile signing");
        }
        const signedEvent = signBotProfileEvent(key.secretKey, record.displayName || getBotDisplayName(record.botPubkeyHex));
        await publishBotProfileEvent({
          botPubkeyHex: record.botPubkeyHex,
          signedEvent,
          defaultRelays: relays,
        });
        botProfilePublished = true;
      }
    } catch (error) {
      botProfileError = error instanceof Error ? error.message : String(error);
    }
  }

  const delegateTemplate = buildDelegateRegistryTemplate([
    {
      pubkey: record.botPubkeyHex,
      name: record.displayName || getBotDisplayName(record.botPubkeyHex),
      active: true,
    },
  ]);

  return Response.json({
    ok: true,
    created,
    unlocked,
    botNpub: record.botNpub,
    botPubkeyHex: record.botPubkeyHex,
    botProfilePublished,
    botProfileError,
    delegateTemplate,
  });
}

/**
 * GET /api/bot-keys/delegate-registry
 *
 * Returns an unsigned kind 30078 event template listing the user's bot
 * delegates. The browser signs it with NIP-07 and publishes to relays.
 */
function handleDelegateRegistry(deps: BotKeyApiDependencies, request: Request): Response {
  const npub = getNpubFromCookie(request);
  if (!npub) {
    return jsonError("Not authenticated — session cookie required", 401);
  }

  const record = deps.store.getActiveKeyForUser(npub);
  if (!record) {
    return jsonError("No active bot key for this user", 404);
  }

  const displayName = record.displayName || getBotDisplayName(record.botPubkeyHex);

  const template = buildDelegateRegistryTemplate([
    {
      pubkey: record.botPubkeyHex,
      name: displayName,
      active: true,
    },
  ]);

  return Response.json({
    eventTemplate: template,
    delegates: [
      {
        pubkey: record.botPubkeyHex,
        npub: record.botNpub,
        name: displayName,
      },
    ],
  });
}
