/**
 * Bot Key Export
 *
 * Resolves the bot key nsec for a given user session so it can be
 * injected as AGENT_NSEC into agent subprocess environments or
 * returned via the CLI export-bot-key command.
 *
 * Resolution order:
 *   1. In-memory unlocked key (fastest, no crypto)
 *   2. Escrow unlock (server-side, uses KEYTELEPORT_PRIVKEY)
 */

import { nip19 } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils";

import { getDecryptedBotKey, unlockViaEscrow, storeBotKeyInMemory } from "./bot-key-manager";
import type { BotKeyRecord } from "./bot-key-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportedBotKey {
  /** nsec1… bech32-encoded secret key */
  nsec: string;
  /** 64-char hex secret key */
  nsecHex: string;
  /** 64-char hex public key */
  botPubkeyHex: string;
  /** npub1… bech32 public key */
  botNpub: string;
  /** How the key was resolved */
  source: "memory" | "escrow";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the bot key nsec for a user, returning it in export-friendly form.
 *
 * @param npub - The user's npub (owner of the bot key)
 * @param record - The active BotKeyRecord from the store
 * @returns Exported key data, or null if resolution failed
 */
export function exportBotKeyForUser(
  npub: string,
  record: BotKeyRecord,
): ExportedBotKey | null {
  // 1. Try in-memory unlocked key
  const unlocked = getDecryptedBotKey(npub);
  if (unlocked && unlocked.pubkeyHex === record.botPubkeyHex) {
    return formatExport(unlocked.secretKey, record, "memory");
  }

  // 2. Try escrow unlock
  try {
    const secretKey = unlockViaEscrow(
      record.encryptedEscrow,
      record.botPubkeyHex,
      record.escrowUuid,
    );
    // Store in memory for future use
    storeBotKeyInMemory(npub, secretKey, record.botPubkeyHex, "escrow");
    return formatExport(secretKey, record, "escrow");
  } catch {
    return null;
  }
}

/**
 * Resolve the nsec hex string for a user's bot key.
 * Lightweight version for env-var injection (no bech32 encoding overhead).
 *
 * @param npub - The user's npub
 * @param record - The active BotKeyRecord from the store
 * @returns nsec hex string, or null if resolution failed
 */
export function resolveBotNsecHex(
  npub: string,
  record: BotKeyRecord,
): string | null {
  // 1. Try in-memory unlocked key
  const unlocked = getDecryptedBotKey(npub);
  if (unlocked && unlocked.pubkeyHex === record.botPubkeyHex) {
    return bytesToHex(unlocked.secretKey);
  }

  // 2. Try escrow unlock
  try {
    const secretKey = unlockViaEscrow(
      record.encryptedEscrow,
      record.botPubkeyHex,
      record.escrowUuid,
    );
    storeBotKeyInMemory(npub, secretKey, record.botPubkeyHex, "escrow");
    return bytesToHex(secretKey);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function formatExport(
  secretKey: Uint8Array,
  record: BotKeyRecord,
  source: "memory" | "escrow",
): ExportedBotKey {
  const nsecHex = bytesToHex(secretKey);
  return {
    nsec: nip19.nsecEncode(secretKey),
    nsecHex,
    botPubkeyHex: record.botPubkeyHex,
    botNpub: record.botNpub,
    source,
  };
}
