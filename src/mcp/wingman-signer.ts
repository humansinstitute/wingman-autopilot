/**
 * Tier 1 NIP-98 signer — signs HTTP auth events using Wingman's server key
 * (KEYTELEPORT_PRIVKEY). No browser or user interaction required.
 *
 * Creates kind 27235 events per the NIP-98 spec:
 *   https://github.com/nostr-protocol/nips/blob/master/98.md
 */

import { finalizeEvent } from "nostr-tools";
import { getKeyTeleportIdentity } from "../config";
import type { SignNip98Response } from "./types";

/** NIP-98 HTTP Auth event kind. */
const NIP98_KIND = 27235;

/**
 * Sign a NIP-98 token with the Wingman server key.
 *
 * Returns the full `Authorization` header value including the "Nostr " scheme
 * prefix, and the npub that signed it.
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

  const signedEvent = finalizeEvent(template, identity.secretKey);

  // Base64-encode the JSON event for the Authorization header
  const eventJson = JSON.stringify(signedEvent);
  const base64Token = btoa(eventJson);
  const token = `Nostr ${base64Token}`;

  return { token, signedBy: identity.npub };
}

/**
 * Check whether the Wingman server key is available for Tier 1 signing.
 */
export function isWingmanKeyAvailable(): boolean {
  return getKeyTeleportIdentity() !== null;
}
