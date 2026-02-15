/**
 * MCP Tool: get_wingman_identity
 *
 * Returns the agent's per-user bot key identity (hex and npub).
 * Never exposes the root server key.
 */

import { getBotPubkey, getBotNpub } from "./nip44-utils";

export const wingmanIdentitySchema = {};

export const wingmanIdentityDescription =
  "Get Wingman's public identity (hex pubkey and npub). " +
  "Use this to understand which pubkey represents this Wingman agent. " +
  "This is your delegate identity — use it in delegate_pubkeys when syncing records, " +
  "but never as owner_pubkey (the owner is always the end-user).";

export function handleGetWingmanIdentity() {
  const botPubkeyHex = getBotPubkey();
  const botNpub = getBotNpub();

  if (botPubkeyHex && botNpub) {
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
            `The owner_pubkey must always be the end-user's pubkey, never this one.`,
          ].join("\n"),
        },
      ],
    };
  }

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: "Bot key identity not available. The session may not have a bot key configured yet. " +
          "A bot key is auto-generated when the session starts — try again shortly.",
      },
    ],
  };
}
