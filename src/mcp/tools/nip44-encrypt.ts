/**
 * MCP Tool: nip44_encrypt
 *
 * Encrypt plaintext to a recipient pubkey using NIP-44 v2.
 * When a per-user bot key is active (BOT_PUBKEY_HEX env var set),
 * routes through the server's bot-crypto API. Otherwise falls back
 * to local crypto with the root key.
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

    // Try bot key via server proxy first
    const botResult = await tryBotCryptoEncrypt(params);
    if (botResult) {
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Encrypted by ${botResult.senderPubkey} (bot key)`,
              `Recipient: ${params.recipient_pubkey}`,
              "",
              botResult.ciphertext,
            ].join("\n"),
          },
        ],
      };
    }

    // Fall back to root key
    const { secretKey, pubkeyHex } = resolvePrivateKey();
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
