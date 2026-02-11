/**
 * MCP Tool: nip44_encrypt
 *
 * Encrypt plaintext to a recipient pubkey using NIP-44 v2.
 * Runs directly in the MCP process — pure crypto, no server call.
 */

import { z } from "zod";
import { resolvePrivateKey } from "./nip44-utils";
import { nip44Encrypt } from "../../superbased/nip44-crypto";

export const nip44EncryptSchema = {
  plaintext: z
    .string()
    .describe("The plaintext content to encrypt"),
  recipient_pubkey: z
    .string()
    .describe("Recipient's public key (64-char hex)"),
};

export const nip44EncryptDescription =
  "Encrypt plaintext to a recipient pubkey using NIP-44 v2. " +
  "Uses the Wingman server identity (KEYTELEPORT_PRIVKEY) as the sender. " +
  "Returns base64-encoded ciphertext that only the recipient can decrypt. " +
  "This is direct crypto — no server round-trip needed.";

interface Nip44EncryptParams {
  plaintext: string;
  recipient_pubkey: string;
}

export async function handleNip44Encrypt(params: Nip44EncryptParams) {
  try {
    const { secretKey, pubkeyHex } = resolvePrivateKey();

    if (!/^[0-9a-fA-F]{64}$/.test(params.recipient_pubkey)) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "recipient_pubkey must be a 64-character hex string.",
          },
        ],
      };
    }

    const ciphertext = nip44Encrypt(params.plaintext, secretKey, params.recipient_pubkey);

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Encrypted by ${pubkeyHex}`,
            `Recipient: ${params.recipient_pubkey}`,
            "",
            ciphertext,
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
          text: `NIP-44 encryption failed: ${(err as Error).message}`,
        },
      ],
    };
  }
}
