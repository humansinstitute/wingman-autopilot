/**
 * MCP Tool: nip44_decrypt
 *
 * Decrypt a NIP-44 v2 ciphertext from a sender pubkey.
 * When a per-user bot key is active (BOT_PUBKEY_HEX env var set),
 * routes through the server's bot-crypto API. Otherwise falls back
 * to local crypto with the root key.
 */

import { z } from "zod";

export const nip44DecryptSchema = {
  ciphertext: z
    .string()
    .describe("Base64-encoded NIP-44 ciphertext to decrypt"),
  sender_pubkey: z
    .string()
    .describe("Sender's public key (64-char hex) — needed to derive the shared secret"),
};

export const nip44DecryptDescription =
  "Decrypt a NIP-44 v2 encrypted payload using your per-user bot key. " +
  "Requires the sender's pubkey to derive the conversation key. " +
  "Returns the decrypted plaintext.";

interface Nip44DecryptParams {
  ciphertext: string;
  sender_pubkey: string;
}

async function tryBotCryptoDecrypt(
  params: Nip44DecryptParams,
): Promise<{ plaintext: string; decryptedBy: string } | null> {
  const botPubkey = process.env.BOT_PUBKEY_HEX;
  const wingmanUrl = process.env.WINGMAN_URL;
  const sessionId = process.env.SESSION_ID;

  if (!botPubkey || !wingmanUrl || !sessionId) return null;

  try {
    const response = await fetch(`${wingmanUrl}/api/mcp/bot-crypto/decrypt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        ciphertext: params.ciphertext,
        senderPubkey: params.sender_pubkey,
      }),
    });

    if (!response.ok) return null;

    const data = await response.json() as { plaintext: string; decryptedBy: string };
    return data;
  } catch {
    return null;
  }
}

export async function handleNip44Decrypt(params: Nip44DecryptParams) {
  try {
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

    const botResult = await tryBotCryptoDecrypt(params);
    if (botResult) {
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Decrypted by ${botResult.decryptedBy} (bot key)`,
              `Sender: ${params.sender_pubkey}`,
              "",
              botResult.plaintext,
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
          text: "NIP-44 decryption failed: bot key is not available. " +
            "Ensure the session has a bot key configured and unlocked.",
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
