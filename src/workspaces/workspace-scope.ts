import { mkdirSync } from "node:fs";
import { join, normalize, sep } from "node:path";

import type { WingmanConfig } from "../config";
import type { RequestAuthContext } from "../auth/request-context";
import { generateIdentityAlias } from "../identity/identity-alias";
import { getEffectiveOwnerNpub } from "../auth/effective-owner";

export type WorkspaceScope = {
  allowedDirectories: string[];
  defaultDirectory: string;
  aliasDirectory: string | null;
  docsRoot: string;
  docsRootBoundary: string;
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
  systemDocsRoot: string,
  systemDocsBoundary: string,
): WorkspaceScope => {
  const normalizedNpub = getEffectiveOwnerNpub(context);
  const isAdmin = Boolean(adminNpub && normalizedNpub && normalizedNpub === adminNpub);

  if (!normalizedNpub || isAdmin) {
    return {
      allowedDirectories: config.allowedDirectories,
      defaultDirectory: config.defaultWorkingDirectory,
      aliasDirectory: null,
      docsRoot: systemDocsRoot,
      docsRootBoundary: systemDocsBoundary,
      isAdmin,
    };
  }

  const alias = generateIdentityAlias(normalizedNpub);
  const aliasDirectory = normalize(join(config.defaultWorkingDirectory, alias));
  ensureDirectoryExists(aliasDirectory);
  const aliasBoundary = aliasDirectory.endsWith(sep) ? aliasDirectory : `${aliasDirectory}${sep}`;

  return {
    allowedDirectories: [aliasDirectory],
    defaultDirectory: aliasDirectory,
    aliasDirectory,
    docsRoot: aliasDirectory,
    docsRootBoundary: aliasBoundary,
    isAdmin: false,
  };
};
