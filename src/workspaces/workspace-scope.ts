import { mkdirSync } from "node:fs";
import { normalize, sep } from "node:path";

import type { WingmanConfig } from "../config";
import type { RequestAuthContext } from "../auth/request-context";
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
  _systemDocsRoot: string,
  _systemDocsBoundary: string,
): WorkspaceScope => {
  const normalizedNpub = getEffectiveOwnerNpub(context);
  const isAdmin = Boolean(adminNpub && normalizedNpub && normalizedNpub === adminNpub);
  const workspaceRoot = normalize(config.defaultWorkingDirectory);
  const workspaceBoundary = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;

  ensureDirectoryExists(workspaceRoot);

  return {
    allowedDirectories: [workspaceRoot],
    defaultDirectory: workspaceRoot,
    aliasDirectory: null,
    docsRoot: workspaceRoot,
    docsRootBoundary: workspaceBoundary,
    isAdmin,
  };
};
