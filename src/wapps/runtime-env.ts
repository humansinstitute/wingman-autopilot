import { join } from "node:path";

import type { WappRecord } from "./types";
import { wappStore, type WappStore } from "./wapp-store";

export function buildWappRuntimeEnv(wapp: WappRecord, wappRoot: string): Record<string, string> {
  const baseEnv = {
    WAPP_ID: wapp.id,
    WAPP_APP_ID: wapp.appId,
    WAPP_OWNER_NPUB: wapp.ownerNpub,
    WAPP_WORKSPACE_OWNER_NPUB: wapp.workspaceOwnerNpub,
    WAPP_SCOPE_ID: wapp.scopeId,
    WAPP_ALLOWED_NPUBS_JSON: JSON.stringify(wapp.allowedNpubs),
  };
  if (!wapp.towerBindingId) {
    return {
      ...baseEnv,
      WAPP_DB_PATH: join(wappRoot, "data", "db.sqlite"),
    };
  }
  if (!wapp.towerBinding || !wapp.appNpub) {
    throw new Error(`WApp ${wapp.id} has an incomplete Tower binding`);
  }
  return {
    ...baseEnv,
    APP_ID: wapp.appId,
    APP_LABEL: wapp.title,
    APP_NPUB: wapp.appNpub,
    TOWER_URL: wapp.towerBinding.towerUrl,
    WORKSPACE_OWNER_NPUB: wapp.towerBinding.workspaceOwnerNpub,
    USER_ALIAS: wapp.towerBinding.userAlias ?? "",
    WAPP_DB_MODE: "tower-api",
    WAPP_TOWER_BINDING_ID: wapp.towerBinding.id,
    WAPP_TOWER_URL: wapp.towerBinding.towerUrl,
    WAPP_APP_NPUB: wapp.appNpub,
  };
}

export function getWappRuntimeEnvForWapp(
  wappId: string,
  appRoot: string,
  store: WappStore = wappStore,
): Record<string, string> {
  const wapp = store.get(wappId);
  if (!wapp || wapp.recordState !== "active") return {};
  const env = buildWappRuntimeEnv(wapp, appRoot);
  if (wapp.towerBindingId) {
    const appNsec = store.getAppNsec(wapp.id);
    if (!appNsec) {
      throw new Error(`WApp ${wapp.id} is Tower-backed but has no stored APP_NSEC`);
    }
    env.APP_NSEC = appNsec;
    env.WAPP_APP_NSEC = appNsec;
  }
  return env;
}

export function getWappRuntimeEnvForApp(
  appId: string,
  appRoot: string,
  store: WappStore = wappStore,
): Record<string, string> {
  const wapp = store.getByAppId(appId);
  if (!wapp) return {};
  return getWappRuntimeEnvForWapp(wapp.id, appRoot, store);
}
