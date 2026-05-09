/**
 * MCP Tool: get_wingman_identity
 *
 * Returns the shared Wingman bot public identity (hex and npub).
 */

import { getBotPubkey, getWingmanNpub } from "./nip44-utils";

export const wingmanIdentitySchema = {};

export const wingmanIdentityDescription =
  "Get Wingman's public identity (hex pubkey and npub). " +
  "Use this to understand which pubkey represents this Wingman instance.";

export function handleGetWingmanIdentity() {
  const botPubkeyHex = getBotPubkey();
  const botNpub = getWingmanNpub();

  if (botPubkeyHex && botNpub) {
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Wingman identity:`,
            `  hexpub: ${botPubkeyHex}`,
            `  npub:   ${botNpub}`,
            ``,
            `This is the shared bot identity for this Wingman instance.`,
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
        text: "Wingman identity not available. Set WINGMAN_PRIV and restart this Wingman instance.",
      },
    ],
  };
}
