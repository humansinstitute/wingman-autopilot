/**
 * Key Teleport route handler
 * Handles secure key import from Welcome (trusted key manager) via NIP-44 encrypted payloads
 */

import { nip44, verifyEvent } from "nostr-tools";
import { getKeyTeleportIdentity, getKeyTeleportWelcomePubkey } from "../config";

// Convert Uint8Array to hex string
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface KeyTeleportRequest {
  blob: string;
}

interface KeyTeleportPayload {
  apiRoute: string;
  hash_id: string;
  timestamp: number;
}

interface KeyManagerResponse {
  success?: boolean;
  ncryptsec?: string;
  error?: string;
}

/**
 * Handle POST /api/auth/keyteleport
 * 1. Decrypt the NIP-44 encrypted blob
 * 2. Verify the signature is from the Welcome pubkey
 * 3. Fetch the ncryptsec from the key manager
 * 4. Return ncryptsec to client
 */
export async function handleKeyTeleport(request: Request): Promise<Response> {
  // Check if Key Teleport is configured
  const identity = getKeyTeleportIdentity();
  const welcomePubkey = getKeyTeleportWelcomePubkey();

  if (!identity || !welcomePubkey) {
    return Response.json({ error: "Key Teleport not configured" }, { status: 503 });
  }

  // Parse request body
  let body: KeyTeleportRequest | null;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!body?.blob) {
    return Response.json({ error: "Missing blob parameter" }, { status: 400 });
  }

  try {
    // The blob is a base64-encoded signed Nostr event with NIP-44 encrypted content
    // Decode the base64 blob to get the event JSON
    let eventJson: string;
    try {
      eventJson = atob(body.blob);
    } catch {
      return Response.json({ error: "Invalid blob encoding" }, { status: 400 });
    }

    // Parse the signed event
    let signedEvent: {
      pubkey: string;
      content: string;
      sig: string;
      id: string;
      kind: number;
      created_at: number;
      tags: string[][];
    };
    try {
      signedEvent = JSON.parse(eventJson);
    } catch {
      return Response.json({ error: "Invalid event format" }, { status: 400 });
    }

    // Verify the event signature
    if (!verifyEvent(signedEvent)) {
      return Response.json({ error: "Invalid event signature" }, { status: 400 });
    }

    // Verify the event is from the trusted Welcome pubkey
    if (signedEvent.pubkey !== welcomePubkey) {
      console.error(`[KeyTeleport] Event from untrusted pubkey: ${signedEvent.pubkey.slice(0, 16)}...`);
      return Response.json({ error: "Untrusted source" }, { status: 403 });
    }

    // Decrypt the event content using NIP-44
    const secretKeyHex = bytesToHex(identity.secretKey);
    const conversationKey = nip44.v2.utils.getConversationKey(secretKeyHex, signedEvent.pubkey);

    let decryptedContent: string;
    try {
      decryptedContent = nip44.v2.decrypt(signedEvent.content, conversationKey);
    } catch (err) {
      console.error("[KeyTeleport] Failed to decrypt content:", err);
      return Response.json({ error: "Decryption failed" }, { status: 400 });
    }

    // Parse the decrypted payload
    let payload: KeyTeleportPayload;
    try {
      payload = JSON.parse(decryptedContent);
    } catch {
      return Response.json({ error: "Invalid payload format" }, { status: 400 });
    }

    // Validate required fields
    if (!payload.apiRoute || !payload.hash_id || !payload.timestamp) {
      return Response.json({ error: "Missing required fields in payload" }, { status: 400 });
    }

    // Check timestamp - the timestamp indicates when the key expires on the key manager
    const now = Math.floor(Date.now() / 1000);
    if (payload.timestamp < now) {
      return Response.json({ error: "Key teleport link has expired" }, { status: 410 });
    }

    // Fetch the ncryptsec from the key manager (Welcome)
    const keyManagerUrl = `${payload.apiRoute}?id=${encodeURIComponent(payload.hash_id)}`;

    console.log(`[KeyTeleport] Fetching key from: ${keyManagerUrl}`);

    let keyManagerRes: Response;
    try {
      keyManagerRes = await fetch(keyManagerUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });
    } catch (err) {
      console.error("[KeyTeleport] Failed to fetch from key manager:", err);
      return Response.json({ error: "Failed to reach key manager" }, { status: 502 });
    }

    if (!keyManagerRes.ok) {
      console.error(`[KeyTeleport] Key manager returned ${keyManagerRes.status}`);
      return Response.json({ error: "Key manager request failed" }, { status: 502 });
    }

    let keyData: KeyManagerResponse;
    try {
      keyData = await keyManagerRes.json();
    } catch {
      return Response.json({ error: "Invalid response from key manager" }, { status: 502 });
    }

    if (!keyData.ncryptsec) {
      return Response.json({ error: "Key not found" }, { status: 404 });
    }

    // Validate ncryptsec format
    if (!keyData.ncryptsec.startsWith("ncryptsec1")) {
      return Response.json({ error: "Invalid key format from key manager" }, { status: 502 });
    }

    console.log("[KeyTeleport] Successfully retrieved ncryptsec");

    // Return the ncryptsec to the client
    return Response.json({ ncryptsec: keyData.ncryptsec });
  } catch (err) {
    console.error("[KeyTeleport] Unexpected error:", err);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
