/**
 * NIP-44 Utilities for MCP Tools
 *
 * Resolves the agent's bot key identity from environment variables.
 * Runs in the MCP child process — agents use their per-user bot key,
 * never the root server key (KEYTELEPORT_PRIVKEY is stripped from env).
 */

/**
 * Get the bot key pubkey from env vars. Returns null if not configured.
 */
export function getBotPubkey(): string | null {
  return process.env.BOT_PUBKEY_HEX ?? null;
}

/**
 * Get the bot key npub from env vars. Returns null if not configured.
 */
export function getBotNpub(): string | null {
  return process.env.BOT_NPUB ?? null;
}

/**
 * Get the user's npub from env vars. Returns null if not configured.
 */
export function getUserNpub(): string | null {
  return process.env.USER_NPUB ?? null;
}

/**
 * Identity preamble for superbased tool responses.
 * Reminds the agent which pubkey is its bot identity (delegate) vs the user (owner).
 */
export function wingmanIdentityPreamble(): string {
  const pubkey = getBotPubkey();
  if (!pubkey) return "";
  return `[Wingman bot identity: ${pubkey} — this is your delegate pubkey, never use it as owner_pubkey]\n\n`;
}
