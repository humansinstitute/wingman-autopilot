/**
 * Bot Crypto API Handler
 *
 * HTTP handler for /api/mcp/bot-crypto/* routes.
 * Proxies NIP-44 encrypt/decrypt operations using the user's bot key
 * for MCP child processes that don't have direct access to the key.
 */

import { finalizeEvent } from "nostr-tools";

import { getDecryptedBotKey } from "./bot-key-manager";
import { nip44Encrypt, nip44Decrypt } from "../superbased/nip44-crypto";
import { publishToRelays } from "../ngit/relay-publisher";
import type { SessionSnapshot } from "../agents/process-manager";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BotCryptoApiDependencies {
  getSession: (sessionId: string) => SessionSnapshot | undefined;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
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

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createBotCryptoApiHandler(deps: BotCryptoApiDependencies) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/mcp/bot-crypto")) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    // segments: ["api", "mcp", "bot-crypto", ...]

    try {
      // POST /api/mcp/bot-crypto/encrypt
      if (segments.length === 4 && segments[3] === "encrypt" && method === "POST") {
        return await handleEncrypt(deps, request);
      }

      // POST /api/mcp/bot-crypto/decrypt
      if (segments.length === 4 && segments[3] === "decrypt" && method === "POST") {
        return await handleDecrypt(deps, request);
      }

      // POST /api/mcp/bot-crypto/sign-event
      if (segments.length === 4 && segments[3] === "sign-event" && method === "POST") {
        return await handleSignEvent(deps, request);
      }

      // POST /api/mcp/bot-crypto/publish-event
      if (segments.length === 4 && segments[3] === "publish-event" && method === "POST") {
        return await handlePublishEvent(deps, request);
      }

      return jsonError("Not found", 404);
    } catch (err) {
      console.error("[bot-crypto-api] Error:", err);
      return jsonError((err as Error).message, 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/mcp/bot-crypto/encrypt
 *
 * Body: { sessionId, plaintext, recipientPubkey }
 * Returns: { ciphertext, senderPubkey }
 */
async function handleEncrypt(
  deps: BotCryptoApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const plaintext = body.plaintext as string | undefined;
  const recipientPubkey = body.recipientPubkey as string | undefined;

  if (!sessionId || !plaintext || !recipientPubkey) {
    return jsonError("sessionId, plaintext, and recipientPubkey are required", 400);
  }

  if (!/^[0-9a-fA-F]{64}$/.test(recipientPubkey)) {
    return jsonError("recipientPubkey must be a 64-character hex string", 400);
  }

  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }
  if (!session.npub) {
    return jsonError("Session has no associated user", 403);
  }

  const botKey = getDecryptedBotKey(session.npub);
  if (!botKey) {
    return jsonError("Bot key not unlocked for this user", 503);
  }

  const ciphertext = nip44Encrypt(plaintext, botKey.secretKey, recipientPubkey);
  return Response.json({ ciphertext, senderPubkey: botKey.pubkeyHex });
}

/**
 * POST /api/mcp/bot-crypto/decrypt
 *
 * Body: { sessionId, ciphertext, senderPubkey }
 * Returns: { plaintext, decryptedBy }
 */
async function handleDecrypt(
  deps: BotCryptoApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const ciphertext = body.ciphertext as string | undefined;
  const senderPubkey = body.senderPubkey as string | undefined;

  if (!sessionId || !ciphertext || !senderPubkey) {
    return jsonError("sessionId, ciphertext, and senderPubkey are required", 400);
  }

  if (!/^[0-9a-fA-F]{64}$/.test(senderPubkey)) {
    return jsonError("senderPubkey must be a 64-character hex string", 400);
  }

  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }
  if (!session.npub) {
    return jsonError("Session has no associated user", 403);
  }

  const botKey = getDecryptedBotKey(session.npub);
  if (!botKey) {
    return jsonError("Bot key not unlocked for this user", 503);
  }

  try {
    const plaintext = nip44Decrypt(ciphertext, botKey.secretKey, senderPubkey);
    return Response.json({ plaintext, decryptedBy: botKey.pubkeyHex });
  } catch (err) {
    return jsonError(`Decryption failed: ${(err as Error).message}`, 400);
  }
}

/**
 * POST /api/mcp/bot-crypto/sign-event
 *
 * Body: { sessionId, event: { kind, content, tags, created_at? } }
 * Returns: { event: <signed event>, signerPubkey }
 */
async function handleSignEvent(
  deps: BotCryptoApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const eventTemplate = body.event as {
    kind?: number;
    content?: string;
    tags?: string[][];
    created_at?: number;
  } | undefined;

  if (!sessionId || !eventTemplate) {
    return jsonError("sessionId and event are required", 400);
  }

  if (typeof eventTemplate.kind !== "number") {
    return jsonError("event.kind must be a number", 400);
  }

  if (typeof eventTemplate.content !== "string") {
    return jsonError("event.content must be a string", 400);
  }

  if (!Array.isArray(eventTemplate.tags)) {
    return jsonError("event.tags must be an array", 400);
  }

  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }
  if (!session.npub) {
    return jsonError("Session has no associated user", 403);
  }

  const botKey = getDecryptedBotKey(session.npub);
  if (!botKey) {
    return jsonError("Bot key not unlocked for this user", 503);
  }

  const template = {
    kind: eventTemplate.kind,
    content: eventTemplate.content,
    tags: eventTemplate.tags,
    created_at: eventTemplate.created_at ?? Math.floor(Date.now() / 1000),
  };

  let signedEvent;
  try {
    signedEvent = finalizeEvent(template, botKey.secretKey);
  } catch (err) {
    console.error("[bot-crypto-api] finalizeEvent failed:", err);
    return jsonError(`Event signing failed: ${(err as Error).message}`, 500);
  }

  // Serialize to plain object — finalizeEvent returns a branded type
  // with Symbol properties that could cause issues with JSON.stringify
  const eventPayload = {
    id: signedEvent.id,
    pubkey: signedEvent.pubkey,
    created_at: signedEvent.created_at,
    kind: signedEvent.kind,
    tags: signedEvent.tags,
    content: signedEvent.content,
    sig: signedEvent.sig,
  };

  return Response.json({
    event: eventPayload,
    signerPubkey: botKey.pubkeyHex,
  });
}

/**
 * POST /api/mcp/bot-crypto/publish-event
 *
 * Body: { sessionId, event: { kind, content, tags, created_at? }, relays: string[] }
 * Returns: { event: <signed event>, signerPubkey, publish: PublishResult }
 */
async function handlePublishEvent(
  deps: BotCryptoApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const eventTemplate = body.event as {
    kind?: number;
    content?: string;
    tags?: string[][];
    created_at?: number;
  } | undefined;
  const relays = body.relays as string[] | undefined;

  if (!sessionId || !eventTemplate || !Array.isArray(relays) || relays.length === 0) {
    return jsonError("sessionId, event, and relays (non-empty array) are required", 400);
  }

  if (typeof eventTemplate.kind !== "number") {
    return jsonError("event.kind must be a number", 400);
  }

  if (typeof eventTemplate.content !== "string") {
    return jsonError("event.content must be a string", 400);
  }

  if (!Array.isArray(eventTemplate.tags)) {
    return jsonError("event.tags must be an array", 400);
  }

  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }
  if (!session.npub) {
    return jsonError("Session has no associated user", 403);
  }

  const botKey = getDecryptedBotKey(session.npub);
  if (!botKey) {
    return jsonError("Bot key not unlocked for this user", 503);
  }

  const template = {
    kind: eventTemplate.kind,
    content: eventTemplate.content,
    tags: eventTemplate.tags,
    created_at: eventTemplate.created_at ?? Math.floor(Date.now() / 1000),
  };

  let signedEvent;
  try {
    signedEvent = finalizeEvent(template, botKey.secretKey);
  } catch (err) {
    console.error("[bot-crypto-api] finalizeEvent failed:", err);
    return jsonError(`Event signing failed: ${(err as Error).message}`, 500);
  }

  // Serialize to plain object for safe JSON transport
  const eventPayload = {
    id: signedEvent.id,
    pubkey: signedEvent.pubkey,
    created_at: signedEvent.created_at,
    kind: signedEvent.kind,
    tags: signedEvent.tags,
    content: signedEvent.content,
    sig: signedEvent.sig,
  };

  let publishResult;
  try {
    publishResult = await publishToRelays(eventPayload, relays);
  } catch (err) {
    console.error("[bot-crypto-api] publishToRelays failed:", err);
    return jsonError(`Relay publishing failed: ${(err as Error).message}`, 500);
  }

  return Response.json({
    event: eventPayload,
    signerPubkey: botKey.pubkeyHex,
    publish: publishResult,
  });
}
