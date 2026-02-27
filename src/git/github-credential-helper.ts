/**
 * GitHub Credential Helper
 *
 * Builds per-user git credential environment for github.com HTTPS remotes.
 * Credentials are read from user settings and scoped to this host only.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { userSettingsStore } from "../storage/user-settings-store";

const HELPER_FILENAME = "github-credential-helper.sh";

const HELPER_SCRIPT = `#!/bin/sh
# Wingman GitHub credential helper — reads from env vars
case "$1" in
  get)
    echo "username=\${WINGMAN_GITHUB_USERNAME}"
    echo "password=\${WINGMAN_GITHUB_TOKEN}"
    ;;
esac
`;

let helperVerifiedPath: string | null = null;

function ensureGitHubCredentialHelper(dataDir: string): string | null {
  if (helperVerifiedPath) return helperVerifiedPath;

  const helperPath = join(dataDir, HELPER_FILENAME);

  try {
    mkdirSync(dataDir, { recursive: true });
    if (!existsSync(helperPath)) {
      writeFileSync(helperPath, HELPER_SCRIPT, { mode: 0o755 });
    } else {
      chmodSync(helperPath, 0o755);
    }
    helperVerifiedPath = helperPath;
    return helperPath;
  } catch (error) {
    console.error(`[github-cred] Failed to prepare credential helper: ${(error as Error).message}`);
    return null;
  }
}

function getUserGitHubCredentials(
  npub: string,
): { username: string; token: string } | null {
  const token =
    userSettingsStore.get(npub, "github_api_key")?.trim() ||
    userSettingsStore.get(npub, "github_token")?.trim() ||
    "";
  if (!token) return null;

  const username =
    userSettingsStore.get(npub, "github_username")?.trim() ||
    userSettingsStore.get(npub, "github_user")?.trim() ||
    "x-access-token";

  return { username, token };
}

export function getGitHubGitEnvForUser(
  npub: string | null | undefined,
  dataDir: string,
): Record<string, string> | null {
  const normalizedNpub = typeof npub === "string" ? npub.trim() : "";
  if (!normalizedNpub) return null;

  const creds = getUserGitHubCredentials(normalizedNpub);
  if (!creds) return null;

  const helperPath = ensureGitHubCredentialHelper(dataDir);
  if (!helperPath) return null;

  return {
    WINGMAN_GITHUB_USERNAME: creds.username,
    WINGMAN_GITHUB_TOKEN: creds.token,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: helperPath,
  };
}
