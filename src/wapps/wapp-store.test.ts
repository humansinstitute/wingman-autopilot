import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { resolveWappAllowedNpubs } from "./scope-access";
import { buildFlightDeckWappRecordPayload } from "./wapp-publisher";
import { buildWappRuntimeEnv } from "./runtime-env";
import { WappStore } from "./wapp-store";

function withStore(fn: (store: WappStore) => void) {
  const dir = mkdtempSync(join(tmpdir(), "wapps-store-"));
  try {
    fn(new WappStore(join(dir, "wapps.sqlite")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("WApp store and helpers", () => {
  test("creates and updates WApp assignment records", () => withStore((store) => {
    const record = store.create({
      id: "wapp-1",
      appId: "app-1",
      title: "Ops Board",
      ownerNpub: "npub1owner",
      createdByNpub: "npub1creator",
      workspaceOwnerNpub: "npub1workspace",
      scopeId: "scope-1",
      scopeLineage: { l1Id: "l1" },
      allowedNpubs: ["npub1owner", "npub1member"],
      launchUrl: "https://apps.example/wapp",
      sourceWingmanUrl: "http://localhost:3000",
      subdomainAlias: "quiet-river",
    });

    expect(record.scopeLineage).toMatchObject({ scopeId: "scope-1", l1Id: "l1" });
    expect(store.getByAppId("app-1")?.id).toBe("wapp-1");

    const updated = store.update("wapp-1", { allowedNpubs: ["npub1owner"] });
    expect(updated?.allowedNpubs).toEqual(["npub1owner"]);
  }));

  test("derives allowlist from owner plus supplied scope members", () => {
    expect(resolveWappAllowedNpubs({
      scopeId: "scope-1",
      ownerNpub: "npub1owner",
      allowedNpubs: ["npub1member", "npub1owner", ""],
    })).toEqual(["npub1member", "npub1owner"]);
  });

  test("builds Flight Deck wapp record payload", () => withStore((store) => {
    const record = store.create({
      id: "wapp-2",
      appId: "app-2",
      title: "Client Portal",
      ownerNpub: "npub1owner",
      createdByNpub: "npub1creator",
      workspaceOwnerNpub: "npub1workspace",
      scopeId: "scope-2",
      scopeLineage: { l2Id: "l2" },
      allowedNpubs: ["npub1owner"],
      launchUrl: "/host/client-portal",
    });
    const payload = buildFlightDeckWappRecordPayload(record, "npub1flightdeck");
    expect(payload).toMatchObject({
      app_namespace: "npub1flightdeck",
      collection_space: "wapp",
      schema_version: 1,
      record_id: "wapp-2",
      data: {
        wapp_id: "wapp-2",
        app_id: "app-2",
        scope_l2_id: "l2",
      },
      encrypt_to_npubs: ["npub1owner"],
    });
  }));

  test("builds runtime env with WApp db path under app root", () => withStore((store) => {
    const record = store.create({
      id: "wapp-3",
      appId: "app-3",
      title: "Field Log",
      ownerNpub: "npub1owner",
      createdByNpub: "npub1creator",
      workspaceOwnerNpub: "npub1workspace",
      scopeId: "scope-3",
      allowedNpubs: ["npub1owner"],
      launchUrl: "/host/field-log",
    });
    expect(buildWappRuntimeEnv(record, "/tmp/wapp")).toMatchObject({
      WAPP_ID: "wapp-3",
      WAPP_APP_ID: "app-3",
      WAPP_DB_PATH: "/tmp/wapp/data/db.sqlite",
    });
  }));
});
