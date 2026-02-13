/**
 * MCP Tool: get_wingman_identity
 *
 * Returns Wingman's public key (hex and npub) so the agent knows its
 * delegate identity. Never exposes the private key.
 */

import { resolvePrivateKey } from "./nip44-utils";

export const wingmanIdentitySchema = {};

export const wingmanIdentityDescription =
  "Get Wingman's public identity (hex pubkey and npub). " +
  "Use this to understand which pubkey represents this Wingman agent. " +
  "This is your delegate identity — use it in delegate_pubkeys when syncing records, " +
  "but never as owner_pubkey (the owner is always the end-user).";

export function handleGetWingmanIdentity() {
  try {
    const key = resolvePrivateKey();
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Wingman identity:`,
            `  hexpub: ${key.pubkeyHex}`,
            `  npub:   ${key.npub}`,
            ``,
            `This is your delegate identity. When syncing records to SuperBased, ` +
            `include this pubkey in delegate_pubkeys so you can later fetch and decrypt them. ` +
            `The owner_pubkey must always be the end-user's pubkey, never this one.`,
          ].join("\n"),
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to resolve Wingman identity: ${(err as Error).message}`,
        },
      ],
    };
  }
}
