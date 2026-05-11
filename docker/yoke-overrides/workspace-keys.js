import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { decryptFromNpub, encryptForNpub, encodeNsec, decodeNsec, createNip98AuthHeader } from './nostr.js';

/**
 * Generate a fresh workspace session keypair and produce the encrypted blob envelope.
 *
 * @param {Uint8Array} userSecret - The user's real Nostr private key
 * @param {string} userNpub - The user's real npub
 * @param {string} workspaceOwnerNpub - The workspace identity
 * @returns {{ blob: object, wsKeySecret: Uint8Array, wsKeyNpub: string }}
 */
export function generateWorkspaceKey(userSecret, userNpub, workspaceOwnerNpub) {
  const wsKeySecret = generateSecretKey();
  const wsKeyPubkey = getPublicKey(wsKeySecret);
  const wsKeyNpub = nip19.npubEncode(wsKeyPubkey);
  const wsKeyNsec = encodeNsec(wsKeySecret);

  const encryptedNsec = encryptForNpub(userSecret, userNpub, wsKeyNsec);

  const blob = {
    version: 1,
    workspace_owner_npub: workspaceOwnerNpub,
    ws_key_npub: wsKeyNpub,
    ws_key_epoch: 1,
    encrypted_nsec: encryptedNsec,
    encrypted_by_npub: userNpub,
    created_at: new Date().toISOString(),
  };

  return { blob, wsKeySecret, wsKeyNpub };
}

/**
 * Decrypt a workspace key blob using the user's real key.
 * Validates that the blob was encrypted by the expected npub.
 *
 * @param {object} blob - The encrypted workspace key blob envelope
 * @param {Uint8Array} userSecret - The user's real Nostr private key
 * @param {string} userNpub - The user's real npub (for validation)
 * @returns {{ wsKeySecret: Uint8Array, wsKeyNpub: string, wsKeyEpoch: number }}
 */
export function decryptWorkspaceKey(blob, userSecret, userNpub) {
  if (blob.encrypted_by_npub !== userNpub) {
    throw new Error(
      `Workspace key blob was encrypted by ${blob.encrypted_by_npub}, not ${userNpub}. Possible key substitution.`
    );
  }

  const wsKeyNsec = decryptFromNpub(userSecret, blob.encrypted_by_npub, blob.encrypted_nsec);
  const wsKeySecret = decodeNsec(wsKeyNsec);

  // Validate the decrypted key matches the blob's stated ws_key_npub
  const derivedPubkey = getPublicKey(wsKeySecret);
  const derivedNpub = nip19.npubEncode(derivedPubkey);
  if (derivedNpub !== blob.ws_key_npub) {
    throw new Error(
      `Decrypted workspace key npub ${derivedNpub} does not match blob ws_key_npub ${blob.ws_key_npub}. Blob may be corrupt.`
    );
  }

  return {
    wsKeySecret,
    wsKeyNpub: blob.ws_key_npub,
    wsKeyEpoch: blob.ws_key_epoch ?? 1,
  };
}

/**
 * Build a workspace session object suitable for use in translators and client auth.
 * This replaces the real session for runtime operations.
 *
 * @param {Uint8Array} wsKeySecret - The decrypted workspace session private key
 * @param {string} wsKeyNpub - The workspace session public key (npub)
 * @param {number} wsKeyEpoch - The key epoch
 * @param {string} userNpub - The user's real npub (for identity resolution)
 * @returns {object} A workspace session object
 */
export function buildWorkspaceSession(wsKeySecret, wsKeyNpub, wsKeyEpoch, userNpub) {
  const pubkey = getPublicKey(wsKeySecret);
  return {
    secret: wsKeySecret,
    pubkey,
    npub: wsKeyNpub,
    userNpub,
    wsKeyEpoch,
    isWorkspaceKey: true,
  };
}

/**
 * Store a workspace key blob in the local SQLite database.
 *
 * @param {object} db - SQLite database handle
 * @param {object} blob - The encrypted workspace key blob envelope
 * @param {string} userNpub - The user's real npub
 */
export function cacheWorkspaceKeyBlob(db, blob, userNpub) {
  db.prepare(`
    INSERT INTO workspace_keys (workspace_owner_npub, user_npub, ws_key_npub, ws_key_epoch, encrypted_blob, cached_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_owner_npub) DO UPDATE SET
      user_npub = excluded.user_npub,
      ws_key_npub = excluded.ws_key_npub,
      ws_key_epoch = excluded.ws_key_epoch,
      encrypted_blob = excluded.encrypted_blob,
      cached_at = excluded.cached_at
  `).run(
    blob.workspace_owner_npub,
    userNpub,
    blob.ws_key_npub,
    blob.ws_key_epoch ?? 1,
    JSON.stringify(blob),
    new Date().toISOString(),
  );
}

/**
 * Retrieve a cached workspace key blob from the local SQLite database.
 *
 * @param {object} db - SQLite database handle
 * @param {string} workspaceOwnerNpub - The workspace identity
 * @returns {object|null} The parsed blob envelope, or null if not cached
 */
export function getCachedWorkspaceKeyBlob(db, workspaceOwnerNpub) {
  const row = db.prepare(
    `SELECT encrypted_blob FROM workspace_keys WHERE workspace_owner_npub = ?`
  ).get(workspaceOwnerNpub);
  if (!row?.encrypted_blob) return null;
  return JSON.parse(row.encrypted_blob);
}

/**
 * Remove a cached workspace key blob, optionally only when it matches the
 * expected workspace key npub.
 *
 * @param {object} db - SQLite database handle
 * @param {string} workspaceOwnerNpub - The workspace identity
 * @param {string|null} wsKeyNpub - Optional workspace key npub guard
 */
export function deleteCachedWorkspaceKeyBlob(db, workspaceOwnerNpub, wsKeyNpub = null) {
  if (wsKeyNpub) {
    db.prepare(
      `DELETE FROM workspace_keys WHERE workspace_owner_npub = ? AND ws_key_npub = ?`
    ).run(workspaceOwnerNpub, wsKeyNpub);
    return;
  }
  db.prepare(
    `DELETE FROM workspace_keys WHERE workspace_owner_npub = ?`
  ).run(workspaceOwnerNpub);
}

/**
 * Confirm Tower can resolve a workspace key back to the expected real user npub.
 *
 * @param {object} options
 * @param {object} options.client - SuperbasedClient instance using real-user auth
 * @param {object} options.config - Workspace config
 * @param {string} options.wsKeyNpub - Workspace key npub
 * @param {string} options.userNpub - Real user npub
 * @returns {Promise<boolean>}
 */
export async function isWorkspaceKeyRegistered({ client, config, wsKeyNpub, userNpub }) {
  const result = await client.fetchWorkspaceKeyMappings(config.workspaceOwnerNpub);
  return (result.mappings ?? []).some((entry) => (
    entry?.ws_key_npub === wsKeyNpub && entry?.user_npub === userNpub
  ));
}

/**
 * Bootstrap the workspace session key for a given workspace.
 * - If a cached blob exists locally, decrypt it.
 * - Otherwise, generate a new keypair, register with Tower, then cache it.
 *
 * @param {object} options
 * @param {object} options.db - SQLite database handle
 * @param {object} options.realSession - The user's real Nostr session { secret, npub }
 * @param {object} options.config - Workspace config { workspaceOwnerNpub, directHttpsUrl }
 * @param {object} options.client - SuperbasedClient instance (uses real session for registration)
 * @returns {Promise<{ wsSession: object, blob: object }>}
 */
export async function bootstrapWorkspaceKey({ db, realSession, config, client }) {
  const cached = getCachedWorkspaceKeyBlob(db, config.workspaceOwnerNpub);

  if (cached) {
    const { wsKeySecret, wsKeyNpub, wsKeyEpoch } = decryptWorkspaceKey(
      cached, realSession.secret, realSession.npub
    );
    const wsSession = buildWorkspaceSession(wsKeySecret, wsKeyNpub, wsKeyEpoch, realSession.npub);
    return { wsSession, blob: cached };
  }

  // First time: generate and register before caching locally.
  const { blob, wsKeySecret, wsKeyNpub } = generateWorkspaceKey(
    realSession.secret, realSession.npub, config.workspaceOwnerNpub
  );

  // Register with Tower (uses real session NIP-98 auth)
  await client.registerWorkspaceKey({
    workspace_owner_npub: config.workspaceOwnerNpub,
    ws_key_npub: wsKeyNpub,
  });

  cacheWorkspaceKeyBlob(db, blob, realSession.npub);

  const wsSession = buildWorkspaceSession(wsKeySecret, wsKeyNpub, 1, realSession.npub);
  return { wsSession, blob };
}

/**
 * Create a NIP-98 auth header using the workspace session key.
 */
export function createWorkspaceNip98Auth(wsSession, url, method, body) {
  return createNip98AuthHeader(url, method, body, wsSession.secret);
}
