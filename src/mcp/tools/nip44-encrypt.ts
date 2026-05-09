/**
 * MCP Tool: nip44_encrypt
 *
 * Encrypt plaintext to a recipient pubkey using NIP-44 v2.
 * Routes through the server's bot-crypto API so the shared Wingman
 * instance key never leaves the server process.
 */

import { z } from "zod";

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
  "Uses the shared Wingman instance identity as the sender. " +
  "Returns base64-encoded ciphertext that only the recipient can decrypt.";

interface Nip44EncryptParams {
  plaintext: string;
  recipient_pubkey: string;
}

async function tryBotCryptoEncrypt(
  params: Nip44EncryptParams,
): Promise<{ ciphertext: string; senderPubkey: string } | null> {
  const botPubkey = process.env.BOT_PUBKEY_HEX;
  const wingmanUrl = process.env.WINGMAN_URL;
  const sessionId = process.env.SESSION_ID;

  if (!botPubkey || !wingmanUrl || !sessionId) return null;

  try {
    const response = await fetch(`${wingmanUrl}/api/mcp/bot-crypto/encrypt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        plaintext: params.plaintext,
        recipientPubkey: params.recipient_pubkey,
      }),
    });

    if (!response.ok) return null;

    const data = await response.json() as { ciphertext: string; senderPubkey: string };
    return data;
  } catch {
    return null;
  }
}

export async function handleNip44Encrypt(params: Nip44EncryptParams) {
  try {
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

    const botResult = await tryBotCryptoEncrypt(params);
    if (botResult) {
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Encrypted by ${botResult.senderPubkey} (Wingman instance)`,
              `Recipient: ${params.recipient_pubkey}`,
              "",
              botResult.ciphertext,
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
          text: "NIP-44 encryption failed: Wingman identity is not available. " +
            "Set WINGMAN_PRIV and restart this Wingman instance.",
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
