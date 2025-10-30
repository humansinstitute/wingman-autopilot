import { mkdirSync } from "node:fs";
import { join, normalize } from "node:path";

import type { WingmanConfig } from "../config";
import type { RequestAuthContext } from "../auth/request-context";
import { normaliseNpub } from "../identity/npub-utils";
import { generateIdentityAlias } from "../identity/identity-alias";

export type WorkspaceScope = {
  allowedDirectories: string[];
  defaultDirectory: string;
  aliasDirectory: string | null;
  isAdmin: boolean;
};

const ensureDirectoryExists = (directory: string) => {
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[workspace] failed to ensure directory ${directory}: ${message}`);
  }
};

export const resolveWorkspaceScope = (
  config: WingmanConfig,
  context: RequestAuthContext,
  adminNpub: string | null,
): WorkspaceScope => {
  const normalizedNpub = normaliseNpub(context.npub ?? null);
  const isAdmin = Boolean(adminNpub && normalizedNpub && normalizedNpub === adminNpub);

  if (!normalizedNpub || isAdmin) {
    return {
      allowedDirectories: config.allowedDirectories,
      defaultDirectory: config.defaultWorkingDirectory,
      aliasDirectory: null,
      isAdmin,
    };
  }

  const alias = generateIdentityAlias(context.npub);
  const aliasDirectory = normalize(join(config.defaultWorkingDirectory, alias));
  ensureDirectoryExists(aliasDirectory);

  return {
    allowedDirectories: [aliasDirectory],
    defaultDirectory: aliasDirectory,
    aliasDirectory,
    isAdmin: false,
  };
};
