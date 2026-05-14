import { join } from "node:path";

import type { WappRecord } from "./types";
import { wappStore, type WappStore } from "./wapp-store";

export function buildWappRuntimeEnv(wapp: WappRecord, wappRoot: string): Record<string, string> {
  return {
    WAPP_ID: wapp.id,
    WAPP_APP_ID: wapp.appId,
    WAPP_OWNER_NPUB: wapp.ownerNpub,
    WAPP_WORKSPACE_OWNER_NPUB: wapp.workspaceOwnerNpub,
    WAPP_SCOPE_ID: wapp.scopeId,
    WAPP_ALLOWED_NPUBS_JSON: JSON.stringify(wapp.allowedNpubs),
    WAPP_DB_PATH: join(wappRoot, "data", "db.sqlite"),
  };
}

export function getWappRuntimeEnvForApp(
  appId: string,
  appRoot: string,
  store: WappStore = wappStore,
): Record<string, string> {
  const wapp = store.getByAppId(appId);
  return wapp ? buildWappRuntimeEnv(wapp, appRoot) : {};
}
