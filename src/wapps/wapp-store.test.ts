import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { resolveWappAllowedNpubs } from "./scope-access";
import { buildFlightDeckWappRecordPayload, SuperbasedWappPublisher } from "./wapp-publisher";
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
      memberNpubs: ["npub1member", "npub1owner", ""],
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

  test("publishes WApp payload through configured SuperBased sync", async () => {
    const ownerHex = "a".repeat(64);
    const delegateHex = "b".repeat(64);
    const calls: unknown[] = [];
    const publisher = new SuperbasedWappPublisher(
      { defaultBaseUrl: "https://superbased.example" },
      async (_deps, input) => {
        calls.push(input);
        return {
          synced: [{ record_id: input.records[0]!.record_id, version: 7 }],
          created: 1,
          updated: 0,
          rejected: [],
        };
      },
    );
    const payload = buildFlightDeckWappRecordPayload({
      id: "00000000-0000-4000-8000-000000000001",
      appId: "app-4",
      title: "Publishing",
      description: null,
      ownerNpub: ownerHex,
      createdByNpub: ownerHex,
      workspaceOwnerNpub: ownerHex,
      scopeId: "scope-4",
      scopeLineage: { scopeId: "scope-4", l1Id: null, l2Id: null, l3Id: null, l4Id: null, l5Id: null },
      allowedNpubs: [ownerHex, delegateHex],
      launchUrl: "https://apps.example/publishing",
      sourceWingmanUrl: null,
      subdomainAlias: null,
      recordState: "active",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
      lastPublishedAt: null,
    }, ownerHex);

    const result = await publisher.publish(payload);
    expect(result).toMatchObject({ published: true, reference: "superbased:00000000-0000-4000-8000-000000000001:v7" });
    expect(calls).toEqual([expect.objectContaining({
      owner_pubkey: ownerHex,
      records: [expect.objectContaining({
        record_id: "00000000-0000-4000-8000-000000000001",
        collection: "wapp",
        delegate_pubkeys: [delegateHex],
      })],
    })]);
  });

  test("publisher fails clearly when SuperBased transport is unavailable", async () => {
    const publisher = new SuperbasedWappPublisher({ defaultBaseUrl: null });
    const result = await publisher.publish({
      app_namespace: "autopilot",
      collection_space: "wapp",
      schema_version: 1,
      record_id: "00000000-0000-4000-8000-000000000002",
      data: {
        title: "No Transport",
        description: null,
        owner_npub: "a".repeat(64),
        wapp_id: "00000000-0000-4000-8000-000000000002",
        app_id: "app-5",
        launch_url: "https://apps.example/no-transport",
        source_wingman_url: null,
        workspace_owner_npub: "a".repeat(64),
        scope_id: "scope-5",
        scope_l1_id: null,
        scope_l2_id: null,
        scope_l3_id: null,
        scope_l4_id: null,
        scope_l5_id: null,
        record_state: "active",
      },
      encrypt_to_npubs: ["a".repeat(64)],
    });
    expect(result).toMatchObject({
      published: false,
      error: "wapp-publish-transport-unavailable",
      status: 503,
    });
  });
});
