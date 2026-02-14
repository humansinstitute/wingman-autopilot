/**
 * MCP Tool: get_wingman_identity
 *
 * Returns Wingman's public key (hex and npub) so the agent knows its
 * delegate identity. Returns the per-user bot identity when available
 * (BOT_PUBKEY_HEX / BOT_NPUB env vars), otherwise falls back to the
 * root identity. Never exposes the private key.
 */

import { resolvePrivateKey } from "./nip44-utils";

export const wingmanIdentitySchema = {};

export const wingmanIdentityDescription =
  "Get Wingman's public identity (hex pubkey and npub). " +
  "Use this to understand which pubkey represents this Wingman agent. " +
  "This is your delegate identity — use it in delegate_pubkeys when syncing records, " +
  "but never as owner_pubkey (the owner is always the end-user).";

export function handleGetWingmanIdentity() {
  // Prefer per-user bot identity when available
  const botPubkeyHex = process.env.BOT_PUBKEY_HEX;
  const botNpub = process.env.BOT_NPUB;

  if (botPubkeyHex && botNpub) {
    // Also resolve root key for reference
    let rootInfo = "";
    try {
      const rootKey = resolvePrivateKey();
      rootInfo = `\n\nRoot (shared) identity: ${rootKey.pubkeyHex}\nBot key takes priority for all signing and crypto operations.`;
    } catch {
      // Root key may not be available
    }

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Wingman identity (bot key):`,
            `  hexpub: ${botPubkeyHex}`,
            `  npub:   ${botNpub}`,
            ``,
            `This is your per-user bot identity. When syncing records to SuperBased, ` +
            `include this pubkey in delegate_pubkeys so you can later fetch and decrypt them. ` +
            `The owner_pubkey must always be the end-user's pubkey, never this one.` +
            rootInfo,
          ].join("\n"),
        },
      ],
    };
  }

  // Fall back to root key
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
