/**
 * Gitea User Manager
 *
 * Provisions per-user Gitea accounts via the admin API using the
 * shared wm21 admin token. Each user gets their own repos, identity,
 * and API token stored in userSettingsStore.
 *
 * Username is derived from the deterministic 3-word identity alias
 * (e.g. "clever-coral-haven") so the same npub always maps to the
 * same Gitea username.
 */

import { randomBytes } from "node:crypto";

import type { WingmanConfig } from "../config";
import { userSettingsStore } from "../storage/user-settings-store";
import type { GiteaConfig } from "./gitea-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProvisionResult {
  username: string;
  apiToken: string;
  created: boolean;
}

// ---------------------------------------------------------------------------
// Admin API helpers
// ---------------------------------------------------------------------------

async function adminGet(
  baseUrl: string,
  path: string,
  adminToken: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/v1${path}`, {
    headers: { Authorization: `token ${adminToken}` },
  });
}

async function adminPost(
  baseUrl: string,
  path: string,
  adminToken: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/v1${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `token ${adminToken}`,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Check whether a Gitea user exists.
 */
async function giteaUserExists(
  baseUrl: string,
  adminToken: string,
  username: string,
): Promise<boolean> {
  const resp = await adminGet(baseUrl, `/users/${username}`, adminToken);
  return resp.status === 200;
}

/**
 * Create a Gitea user via the admin API.
 * Returns true if created, false if username was already taken (422).
 * Throws on unexpected errors.
 */
async function createGiteaUser(
  baseUrl: string,
  adminToken: string,
  username: string,
  password: string,
): Promise<boolean> {
  const resp = await adminPost(baseUrl, "/admin/users", adminToken, {
    username,
    email: `${username}@wingman-os.ai`,
    password,
    must_change_password: false,
    visibility: "public",
  });

  if (resp.ok) return true;
  if (resp.status === 422) return false; // username taken
  const text = await resp.text();
  throw new Error(`Gitea create user failed (${resp.status}): ${text}`);
}

/**
 * Create an API token for a Gitea user.
 */
async function createGiteaToken(
  baseUrl: string,
  adminToken: string,
  username: string,
): Promise<string> {
  const resp = await adminPost(
    baseUrl,
    `/users/${username}/tokens`,
    adminToken,
    { name: "wingman", scopes: ["all"] },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gitea create token failed (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as { sha1?: string; token?: string };
  const token = data.sha1 || data.token;
  if (!token) {
    throw new Error("Gitea token response missing sha1/token field");
  }
  return token;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure a Gitea user account exists for the given npub.
 *
 * 1. Check userSettingsStore for existing token → return early if set
 * 2. Check if user exists on Gitea → create if not
 * 3. Create API token for the user
 * 4. Store username + token in userSettingsStore
 *
 * The `alias` parameter is the deterministic 3-word identity alias
 * from `generateIdentityAlias()`.
 */
export async function ensureGiteaUser(
  config: WingmanConfig,
  npub: string,
  alias: string,
): Promise<ProvisionResult | null> {
  const baseUrl = config.giteaUrl;
  const adminToken = config.giteaApiToken;
  if (!baseUrl || !adminToken) return null;

  // Already provisioned?
  const existingToken = userSettingsStore.get(npub, "gitea_api_token");
  const existingUsername = userSettingsStore.get(npub, "gitea_username");
  if (existingToken && existingUsername) {
    return { username: existingUsername, apiToken: existingToken, created: false };
  }

  // Try the primary alias as username
  let username = alias;
  const password = randomBytes(32).toString("hex");

  const exists = await giteaUserExists(baseUrl, adminToken, username);
  if (!exists) {
    const created = await createGiteaUser(baseUrl, adminToken, username, password);
    if (!created) {
      // Username collision — append 4-char hex suffix from npub hash
      const suffix = npub.slice(-8, -4);
      username = `${alias}-${suffix}`;
      const retryCreated = await createGiteaUser(baseUrl, adminToken, username, password);
      if (!retryCreated) {
        // Check if the suffixed user also exists (maybe from a previous attempt)
        const suffixedExists = await giteaUserExists(baseUrl, adminToken, username);
        if (!suffixedExists) {
          throw new Error(`Failed to create Gitea user: ${username} (both alias and suffix taken)`);
        }
      }
    }
  }

  // Create API token
  const apiToken = await createGiteaToken(baseUrl, adminToken, username);

  // Persist
  userSettingsStore.set(npub, "gitea_username", username);
  userSettingsStore.set(npub, "gitea_api_token", apiToken);

  console.log(`[gitea] User provisioned: ${username} for ${npub.slice(0, 16)}...`);

  return { username, apiToken, created: true };
}

/**
 * Resolve Gitea credentials for a given npub.
 *
 * Returns per-user credentials if available, otherwise falls back
 * to the admin (wm21) credentials from config.
 */
export function resolveGiteaCredentials(
  npub: string | undefined,
  config: WingmanConfig,
): GiteaConfig | null {
  const baseUrl = config.giteaUrl;
  if (!baseUrl) return null;

  // Try per-user credentials first
  if (npub) {
    const userToken = userSettingsStore.get(npub, "gitea_api_token");
    const username = userSettingsStore.get(npub, "gitea_username");
    if (userToken && username) {
      return { url: baseUrl, apiToken: userToken, owner: username };
    }
  }

  // Fall back to admin (wm21)
  if (config.giteaApiToken && config.giteaOwner) {
    return { url: baseUrl, apiToken: config.giteaApiToken, owner: config.giteaOwner };
  }

  return null;
}
