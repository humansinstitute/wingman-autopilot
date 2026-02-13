/**
 * NIP-44 Utilities for MCP Tools
 *
 * Resolves KEYTELEPORT_PRIVKEY from the environment (nsec or hex)
 * into a usable secret key + pubkey. Runs in the MCP child process,
 * so it reads env vars directly rather than importing from config.ts.
 */

import { getPublicKey, nip19 } from "nostr-tools";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export interface ResolvedKey {
  secretKey: Uint8Array;
  pubkeyHex: string;
  npub: string;
}

/**
 * Resolve the KEYTELEPORT_PRIVKEY env var to a secret key and pubkey.
 * Supports both nsec-encoded and raw 64-char hex formats.
 *
 * @throws If the env var is missing or in an invalid format.
 */
export function resolvePrivateKey(): ResolvedKey {
  const raw = process.env.KEYTELEPORT_PRIVKEY;
  if (!raw) {
    throw new Error(
      "KEYTELEPORT_PRIVKEY not set. Cannot perform NIP-44 crypto without a private key.",
    );
  }

  let secretKey: Uint8Array;

  if (raw.startsWith("nsec")) {
    const decoded = nip19.decode(raw);
    if (decoded.type !== "nsec") {
      throw new Error("KEYTELEPORT_PRIVKEY starts with nsec but is not a valid nsec.");
    }
    secretKey = decoded.data as Uint8Array;
  } else if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    secretKey = hexToBytes(raw);
  } else {
    throw new Error("KEYTELEPORT_PRIVKEY must be an nsec or 64-char hex string.");
  }

  const pubkeyHex = getPublicKey(secretKey);
  const npub = nip19.npubEncode(pubkeyHex);

  return { secretKey, pubkeyHex, npub };
}

// Cached pubkey (no secret key exposed)
let _cachedPubkey: string | null = null;

/**
 * Get Wingman's hex pubkey (cached). Returns null if key not configured.
 */
export function getWingmanPubkey(): string | null {
  if (_cachedPubkey) return _cachedPubkey;
  try {
    _cachedPubkey = resolvePrivateKey().pubkeyHex;
    return _cachedPubkey;
  } catch {
    return null;
  }
}

/**
 * Identity preamble for superbased tool responses.
 * Reminds the agent which pubkey is Wingman (delegate) vs the user (owner).
 */
export function wingmanIdentityPreamble(): string {
  const pubkey = getWingmanPubkey();
  if (!pubkey) return "";
  return `[Wingman agent identity: ${pubkey} — this is your delegate pubkey, never use it as owner_pubkey]\n\n`;
}
