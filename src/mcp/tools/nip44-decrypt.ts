/**
 * MCP Tool: nip44_decrypt
 *
 * Decrypt a NIP-44 v2 ciphertext from a sender pubkey.
 * Runs directly in the MCP process — pure crypto, no server call.
 */

import { z } from "zod";
import { resolvePrivateKey } from "./nip44-utils";
import { nip44Decrypt } from "../../superbased/nip44-crypto";

export const nip44DecryptSchema = {
  ciphertext: z
    .string()
    .describe("Base64-encoded NIP-44 ciphertext to decrypt"),
  sender_pubkey: z
    .string()
    .describe("Sender's public key (64-char hex) — needed to derive the shared secret"),
};

export const nip44DecryptDescription =
  "Decrypt a NIP-44 v2 encrypted payload using the Wingman server identity. " +
  "Requires the sender's pubkey to derive the conversation key. " +
  "Returns the decrypted plaintext. " +
  "This is direct crypto — no server round-trip needed.";

interface Nip44DecryptParams {
  ciphertext: string;
  sender_pubkey: string;
}

export async function handleNip44Decrypt(params: Nip44DecryptParams) {
  try {
    const { secretKey, pubkeyHex } = resolvePrivateKey();

    if (!/^[0-9a-fA-F]{64}$/.test(params.sender_pubkey)) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "sender_pubkey must be a 64-character hex string.",
          },
        ],
      };
    }

    const plaintext = nip44Decrypt(params.ciphertext, secretKey, params.sender_pubkey);

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Decrypted by ${pubkeyHex}`,
            `Sender: ${params.sender_pubkey}`,
            "",
            plaintext,
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
          text: `NIP-44 decryption failed: ${(err as Error).message}`,
        },
      ],
    };
  }
}
