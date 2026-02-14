/**
 * NIP-98 Signing Listener
 *
 * Subscribes to the Wingman server via SSE to receive NIP-98 signing
 * requests from agents. Signs events using NIP-07 browser extension
 * or device keystore, then posts the signed event back.
 *
 * Usage:
 *   import { startSigningListener, stopSigningListener } from "./nip98/signing-listener.js";
 *   startSigningListener(npub);  // after login
 *   stopSigningListener();       // on logout
 */

import { schnorr } from "/vendor/@noble/curves/secp256k1.js";
import * as deviceKeystore from "../identity/device-keystore.js";

let eventSource = null;
let currentNpub = null;
let reconnectTimer = null;

const RECONNECT_DELAY_MS = 3000;

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function bytesToHex(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function sha256Hex(data) {
  const encoded = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return bytesToHex(new Uint8Array(hashBuffer));
}

/**
 * Build and sign a Nostr event from a template using a raw secret key.
 * Mirrors nostr-tools finalizeEvent but uses browser-available primitives.
 */
async function signEventWithKey(template, secretKeyBytes) {
  const pubkeyBytes = schnorr.getPublicKey(secretKeyBytes);
  const pubkey = bytesToHex(pubkeyBytes);

  const event = {
    kind: template.kind,
    created_at: template.created_at,
    tags: template.tags,
    content: template.content,
    pubkey,
  };

  // Compute event ID: sha256 of JSON-serialized [0, pubkey, created_at, kind, tags, content]
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  event.id = await sha256Hex(serialized);

  // Sign with schnorr
  const sig = schnorr.sign(event.id, secretKeyBytes);
  event.sig = bytesToHex(sig instanceof Uint8Array ? sig : new Uint8Array(sig));

  return event;
}

// ---------------------------------------------------------------------------
// Signing strategy
// ---------------------------------------------------------------------------

/**
 * Sign an event template using the best available method:
 * 1. NIP-07 browser extension (window.nostr.signEvent)
 * 2. Device keystore (local keys stored in IndexedDB)
 */
async function signEvent(eventTemplate) {
  // Try NIP-07 extension first
  if (
    typeof window !== "undefined" &&
    window.nostr &&
    typeof window.nostr.signEvent === "function"
  ) {
    console.log("[nip98-listener] Signing with NIP-07 extension");
    return await window.nostr.signEvent(eventTemplate);
  }

  // Try device keystore
  if (deviceKeystore.isAvailable()) {
    const stored = await deviceKeystore.retrieveNsec();
    if (stored && stored.nsec instanceof Uint8Array && stored.nsec.length === 32) {
      console.log("[nip98-listener] Signing with device keystore");
      const signed = await signEventWithKey(eventTemplate, stored.nsec);
      return signed;
    }
  }

  throw new Error(
    "No signing method available. Log in with a NIP-07 extension or local keys.",
  );
}

// ---------------------------------------------------------------------------
// Sign request handler
// ---------------------------------------------------------------------------

async function handleSignRequest(request) {
  const { requestId, eventTemplate, type } = request;

  if (!requestId || !eventTemplate) {
    console.warn("[nip98-listener] Invalid sign request — missing fields");
    return;
  }

  const isNostrEvent = type === "nostr:sign_request";
  const label = isNostrEvent
    ? `kind ${eventTemplate.kind} (NIP-34 Git)`
    : eventTemplate.tags?.find((t) => t[0] === "u")?.[1] ?? "unknown URL";

  console.log(
    `[nip98-listener] Received sign request ${requestId} for ${label}`,
  );

  try {
    const signedEvent = await signEvent(eventTemplate);

    await fetch("/api/mcp/nip98/sign-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ requestId, signedEvent }),
    });

    console.log(`[nip98-listener] Signed and posted response for ${requestId}`);
  } catch (err) {
    console.error("[nip98-listener] Signing failed:", err);

    try {
      await fetch("/api/mcp/nip98/sign-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          requestId,
          error: err instanceof Error ? err.message : "Signing failed",
        }),
      });
    } catch (postErr) {
      console.error("[nip98-listener] Failed to post error response:", postErr);
    }
  }
}

// ---------------------------------------------------------------------------
// Bot key decrypt handler
// ---------------------------------------------------------------------------

/**
 * Handle a bot key decrypt request from the server.
 * The server sends the NIP-44 encrypted bot nsec, we decrypt it using
 * the user's key (NIP-07 nip44.decrypt or device keystore), then POST
 * the decrypted nsec hex back to /api/bot-keys/unlock.
 */
async function handleBotKeyDecryptRequest(request) {
  const { encryptedToUser, senderPubkey, botPubkeyHex } = request;

  if (!encryptedToUser || !senderPubkey) {
    console.warn("[nip98-listener] Invalid bot key decrypt request — missing fields");
    return;
  }

  console.log(`[nip98-listener] Received bot key decrypt request for bot ${botPubkeyHex?.slice(0, 16)}…`);

  try {
    let nsecHex = null;

    // Try NIP-07 extension nip44.decrypt first
    if (
      typeof window !== "undefined" &&
      window.nostr &&
      window.nostr.nip44 &&
      typeof window.nostr.nip44.decrypt === "function"
    ) {
      console.log("[nip98-listener] Decrypting bot key with NIP-07 nip44.decrypt");
      nsecHex = await window.nostr.nip44.decrypt(senderPubkey, encryptedToUser);
    }

    // Try device keystore if NIP-07 didn't work
    if (!nsecHex && deviceKeystore.isAvailable()) {
      const stored = await deviceKeystore.retrieveNsec();
      if (stored && stored.nsec instanceof Uint8Array && stored.nsec.length === 32) {
        console.log("[nip98-listener] Decrypting bot key with device keystore");
        // Device keystore gives us the raw secret key — we need NIP-44 decrypt
        // which requires the nostr-tools nip44 module. Since we're in the browser
        // and don't have nostr-tools, we can only use NIP-07 for NIP-44 decryption.
        console.warn("[nip98-listener] Device keystore cannot perform NIP-44 decryption — NIP-07 extension required for bot key unlock");
      }
    }

    if (!nsecHex) {
      console.warn("[nip98-listener] No NIP-44 decryption method available for bot key unlock");
      return;
    }

    // Validate: should be 64-char hex
    if (!/^[0-9a-fA-F]{64}$/.test(nsecHex)) {
      console.error("[nip98-listener] Decrypted bot key is not valid 64-char hex");
      return;
    }

    // POST the decrypted nsec to unlock the bot key
    const response = await fetch("/api/bot-keys/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ nsecHex }),
    });

    if (response.ok) {
      const result = await response.json();
      console.log(`[nip98-listener] Bot key unlocked successfully: ${result.botNpub?.slice(0, 20)}…`);
    } else {
      const error = await response.text();
      console.error(`[nip98-listener] Bot key unlock failed: ${error}`);
    }
  } catch (err) {
    console.error("[nip98-listener] Bot key decryption failed:", err);
  }
}

// ---------------------------------------------------------------------------
// SSE lifecycle
// ---------------------------------------------------------------------------

function connect(npub) {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  const url = `/api/mcp/nip98/subscribe`;
  eventSource = new EventSource(url);

  eventSource.onopen = () => {
    console.log("[nip98-listener] SSE connected, listening for signing requests");
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  eventSource.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "nip98:sign_request" || data.type === "nostr:sign_request") {
        await handleSignRequest(data);
      } else if (data.type === "botkey:decrypt_request") {
        await handleBotKeyDecryptRequest(data);
      }
    } catch (err) {
      console.error("[nip98-listener] Error handling SSE message:", err);
    }
  };

  eventSource.onerror = () => {
    // EventSource auto-reconnects, but if it keeps failing we log
    if (eventSource && eventSource.readyState === EventSource.CLOSED) {
      console.warn("[nip98-listener] SSE connection closed, scheduling reconnect");
      eventSource = null;
      if (currentNpub && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (currentNpub) {
            connect(currentNpub);
          }
        }, RECONNECT_DELAY_MS);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function startSigningListener(npub) {
  if (!npub || typeof npub !== "string") {
    console.warn("[nip98-listener] Cannot start without npub");
    return;
  }

  if (currentNpub === npub && eventSource) {
    return; // Already connected for this npub
  }

  stopSigningListener();
  currentNpub = npub;
  connect(npub);
}

function stopSigningListener() {
  currentNpub = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
    console.log("[nip98-listener] SSE disconnected");
  }
}

export { startSigningListener, stopSigningListener };
