import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import type { RequestAuthContext } from "../auth/request-context";
import type { AppRecord } from "../apps/app-registry";
import { WappStore } from "../wapps/wapp-store";
import { handleWappsApi, type WappsApiContext } from "./wapps-api-routes";

const authContext: RequestAuthContext = {
  npub: "npub1owner",
  actorNpub: "npub1owner",
  session: { id: "session-1" } as any,
  delegatedByBot: false,
};

const app: AppRecord = {
  id: "app-1",
  label: "Ops Board",
  root: "/tmp/app",
  scripts: { start: "bun src/server.ts" },
  tmuxSession: "ops-board",
  ownerNpub: "npub1owner",
  createdAt: "2026-05-14T00:00:00.000Z",
  updatedAt: "2026-05-14T00:00:00.000Z",
  webApp: true,
  webAppPort: 4100,
};

function makeContext(): { ctx: WappsApiContext; cleanup: () => void; published: unknown[] } {
  const dir = mkdtempSync(join(tmpdir(), "wapps-api-"));
  const published: unknown[] = [];
  return {
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    published,
    ctx: {
      adminNpub: null,
      viewerNpub: "npub1owner",
      sourceWingmanUrl: "http://localhost:3000",
      flightDeckAppNamespace: "npub1flightdeck",
      AccessActions: { AppsManage: "apps:manage" as any },
      ensureApiAccess: async () => null,
      ensureDirectory: async (root) => root,
      canAccessApp: (candidate) => candidate.ownerNpub === "npub1owner",
      appRegistry: {
        getApp: async (id) => id === app.id ? app : undefined,
      },
      appAliasRegistry: {
        getByAppId: async () => ({ alias: "ops-board" }),
      },
      wappStore: new WappStore(join(dir, "wapps.sqlite")),
      publisher: {
        publish: async (payload) => {
          published.push(payload);
          return { published: false, reference: "local-payload:wapp" };
        },
      },
      buildLaunchUrl: (alias) => `http://localhost:3000/host/${alias}`,
    },
  };
}

describe("handleWappsApi", () => {
  test("creates, refreshes, and publishes a WApp", async () => {
    const { ctx, cleanup, published } = makeContext();
    try {
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
          allowedNpubs: ["npub1member"],
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      expect(createResponse?.status).toBe(201);
      const created = await createResponse!.json() as any;
      expect(created.wapp.allowedNpubs).toEqual(["npub1member", "npub1owner"]);

      const refreshRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}/refresh-allowlist`, {
        method: "POST",
        body: JSON.stringify({ allowedNpubs: ["npub1other"] }),
      });
      const refreshResponse = await handleWappsApi(refreshRequest, new URL(refreshRequest.url), "POST", authContext, ctx);
      const refreshed = await refreshResponse!.json() as any;
      expect(refreshed.wapp.allowedNpubs).toEqual(["npub1other", "npub1owner"]);

      const publishRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}/publish`, { method: "POST" });
      const publishResponse = await handleWappsApi(publishRequest, new URL(publishRequest.url), "POST", authContext, ctx);
      expect(publishResponse?.status).toBe(200);
      expect(published).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
