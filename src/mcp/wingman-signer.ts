/**
 * Tier 1 NIP-98 signer — signs HTTP auth events using either the user's
 * bot key (preferred) or the shared Wingman server key (fallback).
 *
 * Creates kind 27235 events per the NIP-98 spec:
 *   https://github.com/nostr-protocol/nips/blob/master/98.md
 */

import { finalizeEvent } from "nostr-tools";
import { getKeyTeleportIdentity } from "../config";
import { getDecryptedBotKey } from "../identity/bot-key-manager";
import type { SignNip98Response } from "./types";

/** NIP-98 HTTP Auth event kind. */
const NIP98_KIND = 27235;

/**
 * Build and sign a NIP-98 token with the given secret key.
 */
function buildNip98Token(
  url: string,
  method: string,
  secretKey: Uint8Array,
  npub: string,
  bodyHash?: string,
): SignNip98Response {
  const tags: string[][] = [
    ["u", url],
    ["method", method.toUpperCase()],
  ];

  if (bodyHash) {
    tags.push(["payload", bodyHash]);
  }

  const template = {
    kind: NIP98_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  };

  const signedEvent = finalizeEvent(template, secretKey);

  const eventJson = JSON.stringify(signedEvent);
  const base64Token = btoa(eventJson);
  const token = `Nostr ${base64Token}`;

  return { token, signedBy: npub };
}

/**
 * Sign a NIP-98 token with the Wingman server key (root identity).
 *
 * @throws If KEYTELEPORT_PRIVKEY is not configured.
 */
export async function signWithWingmanKey(
  url: string,
  method: string,
  bodyHash?: string,
): Promise<SignNip98Response> {
  const identity = getKeyTeleportIdentity();
  if (!identity) {
    throw new Error(
      "Wingman server key not configured. Set KEYTELEPORT_PRIVKEY to enable Tier 1 NIP-98 signing.",
    );
  }

  return buildNip98Token(url, method, identity.secretKey, identity.npub, bodyHash);
}

/**
 * Sign a NIP-98 token with a user's bot key.
 *
 * @throws If the provided secret key is invalid.
 */
export function signWithBotKey(
  url: string,
  method: string,
  secretKey: Uint8Array,
  npub: string,
  bodyHash?: string,
): SignNip98Response {
  return buildNip98Token(url, method, secretKey, npub, bodyHash);
}

export interface SignForSessionResult extends SignNip98Response {
  signerType: "bot" | "root";
}

/**
 * Sign a NIP-98 token for a specific user session.
 * Tries the user's bot key first, falls back to the root key.
 *
 * @param url - Target URL for the NIP-98 token
 * @param method - HTTP method
 * @param userNpub - User's npub (optional — if missing, uses root key)
 * @param bodyHash - SHA-256 hash of the request body (optional)
 */
export async function signForSession(
  url: string,
  method: string,
  userNpub?: string | null,
  bodyHash?: string,
): Promise<SignForSessionResult> {
  // Try bot key first when user npub is available
  if (userNpub) {
    const botKey = getDecryptedBotKey(userNpub);
    if (botKey) {
      const result = signWithBotKey(url, method, botKey.secretKey, botKey.npub, bodyHash);
      return { ...result, signerType: "bot" };
    }
  }

  // Fall back to root key
  const result = await signWithWingmanKey(url, method, bodyHash);
  return { ...result, signerType: "root" };
}

/**
 * Check whether the Wingman server key is available for Tier 1 signing.
 */
export function isWingmanKeyAvailable(): boolean {
  return getKeyTeleportIdentity() !== null;
}
