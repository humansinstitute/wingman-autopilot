/**
 * NIP-44 Encryption Helpers
 *
 * Shared crypto utilities for encrypting/decrypting content using
 * NIP-44 v2 (nostr-tools). Used by both the server-side SuperBased
 * handler and the MCP tools.
 */

import { nip44 } from "nostr-tools";

/**
 * Encrypt plaintext for a single recipient using NIP-44 v2.
 *
 * @param plaintext  - The content to encrypt
 * @param secretKey  - Sender's 32-byte secret key
 * @param recipientPubkeyHex - Recipient's public key (64-char hex)
 * @returns Base64-encoded NIP-44 ciphertext
 */
export function nip44Encrypt(
  plaintext: string,
  secretKey: Uint8Array,
  recipientPubkeyHex: string,
): string {
  const conversationKey = nip44.v2.utils.getConversationKey(secretKey, recipientPubkeyHex);
  return nip44.v2.encrypt(plaintext, conversationKey);
}

/**
 * Decrypt NIP-44 v2 ciphertext from a sender.
 *
 * @param ciphertext - Base64-encoded NIP-44 payload
 * @param secretKey  - Recipient's 32-byte secret key
 * @param senderPubkeyHex - Sender's public key (64-char hex)
 * @returns Decrypted plaintext
 */
export function nip44Decrypt(
  ciphertext: string,
  secretKey: Uint8Array,
  senderPubkeyHex: string,
): string {
  const conversationKey = nip44.v2.utils.getConversationKey(secretKey, senderPubkeyHex);
  return nip44.v2.decrypt(ciphertext, conversationKey);
}

/**
 * Encrypt plaintext to multiple recipients. Returns a map of
 * pubkey → ciphertext so each recipient can independently decrypt.
 *
 * @param plaintext  - The content to encrypt
 * @param secretKey  - Sender's 32-byte secret key
 * @param pubkeys    - Array of recipient public keys (64-char hex)
 * @returns Record mapping each pubkey to its ciphertext
 */
export function encryptToMultipleRecipients(
  plaintext: string,
  secretKey: Uint8Array,
  pubkeys: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pubkey of pubkeys) {
    result[pubkey] = nip44Encrypt(plaintext, secretKey, pubkey);
  }
  return result;
}
