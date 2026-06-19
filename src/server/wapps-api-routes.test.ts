import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import type { RequestAuthContext } from "../auth/request-context";
import type { AppRecord } from "../apps/app-registry";
import { buildWappScopeAccessResolution, FlightDeckScopeAccessResolver, WappScopeAccessError } from "../wapps/scope-access";
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

function makeContext(): {
  ctx: WappsApiContext;
  cleanup: () => void;
  published: unknown[];
  registrations: unknown[];
  scopeMembers: Map<string, string[]>;
} {
  const dir = mkdtempSync(join(tmpdir(), "wapps-api-"));
  const published: unknown[] = [];
  const registrations: unknown[] = [];
  const authoritySecret = generateSecretKey();
  const scopeMembers = new Map<string, string[]>([
    ["scope-1", ["npub1member", "npub1owner", " npub1member "]],
    ["scope-2", ["npub1other"]],
  ]);
  return {
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    published,
    registrations,
    scopeMembers,
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
          return { published: true, reference: "superbased:wapp:v1" };
        },
      },
      scopeAccessResolver: {
        resolveWappScopeAccess: async (input) => {
          if (!scopeMembers.has(input.scopeId)) {
            throw new WappScopeAccessError("invalid-scope", `Unknown scope ${input.scopeId}`);
          }
          return buildWappScopeAccessResolution({
            ...input,
            scopeLineage: {
              scopeId: input.scopeId,
              l1Id: input.scopeId === "scope-2" ? "l1-next" : "l1",
              l2Id: null,
              l3Id: null,
              l4Id: null,
              l5Id: null,
            },
            memberNpubs: scopeMembers.get(input.scopeId),
          });
        },
      },
      towerRegistrationIdentity: {
        botNpub: nip19.npubEncode(getPublicKey(authoritySecret)),
        botPubkeyHex: getPublicKey(authoritySecret),
        botSecret: authoritySecret,
      },
      towerWappRegistrar: {
        register: async (input) => {
          registrations.push(input);
          return { workspaceOwnerNpub: input.workspaceOwnerNpub, appNpub: input.appNpub, app: { app_npub: input.appNpub } };
        },
      },
      buildLaunchUrl: (alias) => `http://localhost:3000/host/${alias}`,
    },
  };
}

describe("handleWappsApi", () => {
  test("creates Tower bindings and Tower-backed WApps without exposing APP_NSEC", async () => {
    const { ctx, cleanup, registrations } = makeContext();
    try {
      const secret = generateSecretKey();
      const appNsec = nip19.nsecEncode(secret);
      const appNpub = nip19.npubEncode(getPublicKey(secret));
      const bindingRequest = new Request("http://localhost:3000/api/wapps/tower-bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "tower-dev",
          label: "Tower Dev",
          towerUrl: "https://tower.example",
          workspaceOwnerNpub: "npub1workspace",
          userAlias: "tester",
          isDefault: true,
        }),
      });
      const bindingResponse = await handleWappsApi(bindingRequest, new URL(bindingRequest.url), "POST", authContext, ctx);
      expect(bindingResponse?.status).toBe(201);

      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
          towerBindingId: "tower-dev",
          appKeyMode: "import",
          appNsec,
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      expect(createResponse?.status).toBe(201);
      const created = await createResponse!.json() as any;
      expect(created.wapp).toMatchObject({
        towerBindingId: "tower-dev",
        appNpub,
        towerBinding: { id: "tower-dev", towerUrl: "https://tower.example" },
      });
      expect(registrations).toHaveLength(1);
      expect(registrations[0]).toMatchObject({
        towerUrl: "https://tower.example",
        workspaceOwnerNpub: "npub1workspace",
        appNpub,
        appName: "Ops Board",
      });
      expect(JSON.stringify(created)).not.toContain(appNsec);
      expect(ctx.wappStore.getAppNsec(created.wapp.id)).toBe(appNsec);
    } finally {
      cleanup();
    }
  });

  test("rejects Tower app key replacement on existing WApps", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      const secret = generateSecretKey();
      const appNsec = nip19.nsecEncode(secret);
      const appNpub = nip19.npubEncode(getPublicKey(secret));
      const replacementNsec = nip19.nsecEncode(generateSecretKey());
      ctx.wappStore.createTowerBinding({
        id: "tower-dev",
        label: "Tower Dev",
        towerUrl: "https://tower.example",
        workspaceOwnerNpub: "npub1workspace",
      });
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
          towerBindingId: "tower-dev",
          appKeyMode: "import",
          appNsec,
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      const created = await createResponse!.json() as any;

      const regenerateRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appKeyMode: "generate" }),
      });
      const regenerateResponse = await handleWappsApi(regenerateRequest, new URL(regenerateRequest.url), "PATCH", authContext, ctx);
      expect(regenerateResponse?.status).toBe(400);
      expect(await regenerateResponse!.json()).toMatchObject({
        error: "WApp app key replacement is not supported for existing assignments",
      });

      const importRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appKeyMode: "import", appNsec: replacementNsec }),
      });
      const importResponse = await handleWappsApi(importRequest, new URL(importRequest.url), "PATCH", authContext, ctx);
      expect(importResponse?.status).toBe(400);
      expect(ctx.wappStore.get(created.wapp.id)?.appNpub).toBe(appNpub);
      expect(ctx.wappStore.getAppNsec(created.wapp.id)).toBe(appNsec);
    } finally {
      cleanup();
    }
  });

  test("registers existing Tower app npub when updating Tower binding", async () => {
    const { ctx, cleanup, registrations } = makeContext();
    try {
      const secret = generateSecretKey();
      const appNsec = nip19.nsecEncode(secret);
      const appNpub = nip19.npubEncode(getPublicKey(secret));
      ctx.wappStore.createTowerBinding({
        id: "tower-dev",
        label: "Tower Dev",
        towerUrl: "https://tower-dev.example",
        workspaceOwnerNpub: "npub1workspace",
      });
      ctx.wappStore.createTowerBinding({
        id: "tower-stage",
        label: "Tower Stage",
        towerUrl: "https://tower-stage.example",
        workspaceOwnerNpub: "npub1workspace",
      });
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
          towerBindingId: "tower-dev",
          appKeyMode: "import",
          appNsec,
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      const created = await createResponse!.json() as any;
      registrations.length = 0;

      const updateRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ towerBindingId: "tower-stage" }),
      });
      const updateResponse = await handleWappsApi(updateRequest, new URL(updateRequest.url), "PATCH", authContext, ctx);
      expect(updateResponse?.status).toBe(200);
      const updated = await updateResponse!.json() as any;
      expect(updated.wapp).toMatchObject({ towerBindingId: "tower-stage", appNpub });
      expect(registrations).toHaveLength(1);
      expect(registrations[0]).toMatchObject({
        towerUrl: "https://tower-stage.example",
        workspaceOwnerNpub: "npub1workspace",
        appNpub,
      });
    } finally {
      cleanup();
    }
  });

  test("returns a clear error when Tower app registration fails", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      ctx.wappStore.createTowerBinding({
        id: "tower-dev",
        label: "Tower Dev",
        towerUrl: "https://tower.example",
        workspaceOwnerNpub: "npub1workspace",
      });
      ctx.towerWappRegistrar = {
        register: async () => {
          throw new Error("Tower registration failed: Not authorized to manage this workspace");
        },
      };
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
          towerBindingId: "tower-dev",
          appKeyMode: "generate",
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      expect(createResponse?.status).toBe(502);
      expect(await createResponse!.json()).toMatchObject({
        error: "wapp-tower-registration-failed",
        message: "Tower registration failed: Not authorized to manage this workspace",
      });
      expect(ctx.wappStore.list()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("creates and refreshes WApp allowlists from resolved scope members", async () => {
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
          allowedNpubs: ["npub1malicious"],
          schedule: {
            timezone: "UTC",
            windows: [{ days: [1, 2, 3, 4, 5], start_time: "06:00", end_time: "12:00" }],
          },
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      expect(createResponse?.status).toBe(201);
      const created = await createResponse!.json() as any;
      expect(created.wapp.allowedNpubs).toEqual(["npub1member", "npub1owner"]);
      expect(created.wapp.status).toBe("active");
      expect(created.wapp.schedule).toMatchObject({
        timezone: "UTC",
        windows: [{ days: [1, 2, 3, 4, 5], startTime: "06:00", endTime: "12:00" }],
      });

      const refreshRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}/refresh-allowlist`, {
        method: "POST",
        body: JSON.stringify({ allowedNpubs: ["npub1malicious"] }),
      });
      ctx.scopeAccessResolver.resolveWappScopeAccess = async (input) => buildWappScopeAccessResolution({
        ...input,
        memberNpubs: ["npub1other", "npub1owner", "npub1other"],
      });
      const refreshResponse = await handleWappsApi(refreshRequest, new URL(refreshRequest.url), "POST", authContext, ctx);
      const refreshed = await refreshResponse!.json() as any;
      expect(refreshed.wapp.allowedNpubs).toEqual(["npub1other", "npub1owner"]);
      expect(refreshed.wapp.scopeLineage.scopeId).toBe("scope-1");

      const publishRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}/publish`, { method: "POST" });
      const publishResponse = await handleWappsApi(publishRequest, new URL(publishRequest.url), "POST", authContext, ctx);
      expect(publishResponse?.status).toBe(200);
      expect(published).toHaveLength(1);
      expect((published[0] as any).data.schedule.windows[0]).toEqual({
        days: [1, 2, 3, 4, 5],
        start_time: "06:00",
        end_time: "12:00",
      });
    } finally {
      cleanup();
    }
  });

  test("creates WApp allowlist from yoke scope groups and cached group members", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      ctx.scopeAccessResolver = new FlightDeckScopeAccessResolver(async () => ({
        record_id: "scope-yoke",
        owner_npub: "npub1workspace",
        l1_id: "l1-yoke",
        l2_id: "l2-yoke",
        group_ids: ["group-1"],
        shares: [{ type: "group", group_id: "group-1", access: "write" }],
        accessGroups: [{
          group_id: "group-1",
          current_group_npub: "npub1groupcurrent",
          member_npubs_json: JSON.stringify(["npub1member", "npub1other", "npub1member"]),
        }],
      }));
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-yoke",
          allowedNpubs: ["npub1malicious"],
          scopeLineage: { l1Id: "request-lineage" },
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      expect(createResponse?.status).toBe(201);
      const created = await createResponse!.json() as any;
      expect(created.wapp.allowedNpubs).toEqual(["npub1member", "npub1other", "npub1owner"]);
      expect(created.wapp.scopeLineage).toMatchObject({ scopeId: "scope-yoke", l1Id: "l1-yoke", l2Id: "l2-yoke" });
    } finally {
      cleanup();
    }
  });

  test("rejects yoke scopes owned by a different workspace", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      ctx.scopeAccessResolver = new FlightDeckScopeAccessResolver(async () => ({
        record_id: "scope-yoke",
        owner_npub: "npub1differentworkspace",
        group_ids: [],
        member_npubs: ["npub1member"],
      }));
      const request = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-yoke",
        }),
      });
      const response = await handleWappsApi(request, new URL(request.url), "POST", authContext, ctx);
      expect(response?.status).toBe(400);
      expect(await response!.json()).toMatchObject({ error: "invalid-scope" });
    } finally {
      cleanup();
    }
  });

  test("updates scope access from resolver instead of request allowlist", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      const created = await createResponse!.json() as any;

      const updateRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scopeId: "scope-2",
          allowedNpubs: ["npub1malicious"],
        }),
      });
      const updateResponse = await handleWappsApi(updateRequest, new URL(updateRequest.url), "PATCH", authContext, ctx);
      expect(updateResponse?.status).toBe(200);
      const updated = await updateResponse!.json() as any;
      expect(updated.wapp.scopeId).toBe("scope-2");
      expect(updated.wapp.scopeLineage.l1Id).toBe("l1-next");
      expect(updated.wapp.allowedNpubs).toEqual(["npub1other", "npub1owner"]);
    } finally {
      cleanup();
    }
  });

  test("patch refreshes unchanged scope access and ignores request lineage authority", async () => {
    const { ctx, cleanup, scopeMembers } = makeContext();
    try {
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      const created = await createResponse!.json() as any;
      scopeMembers.set("scope-1", ["npub1other"]);

      const updateRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          allowedNpubs: ["npub1malicious"],
          scopeLineage: { scopeId: "scope-1", l1Id: "request-lineage" },
        }),
      });
      const updateResponse = await handleWappsApi(updateRequest, new URL(updateRequest.url), "PATCH", authContext, ctx);
      expect(updateResponse?.status).toBe(200);
      const updated = await updateResponse!.json() as any;
      expect(updated.wapp.scopeId).toBe("scope-1");
      expect(updated.wapp.scopeLineage.l1Id).toBe("l1");
      expect(updated.wapp.allowedNpubs).toEqual(["npub1other", "npub1owner"]);
    } finally {
      cleanup();
    }
  });

  test("rejects unknown scope input on create", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      const request = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "missing-scope",
          allowedNpubs: ["npub1malicious"],
        }),
      });
      const response = await handleWappsApi(request, new URL(request.url), "POST", authContext, ctx);
      expect(response?.status).toBe(400);
      expect(await response!.json()).toMatchObject({ error: "invalid-scope" });
    } finally {
      cleanup();
    }
  });

  test("rejects grouped scopes when group membership cannot be resolved", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      ctx.scopeAccessResolver = new FlightDeckScopeAccessResolver(async () => ({
        record_id: "scope-yoke",
        workspace_owner_npub: "npub1workspace",
        l1_id: "l1-yoke",
        group_ids: ["missing-group"],
        shares: [{ type: "group", group_id: "missing-group", access: "write" }],
        accessGroups: [],
      }));
      const request = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-yoke",
        }),
      });
      const response = await handleWappsApi(request, new URL(request.url), "POST", authContext, ctx);
      expect(response?.status).toBe(400);
      expect(await response!.json()).toMatchObject({ error: "unresolvable-scope" });
    } finally {
      cleanup();
    }
  });

  test("does not stamp lastPublishedAt when publish transport is unavailable", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      ctx.publisher = {
        publish: async () => ({ published: false, error: "wapp-publish-transport-unavailable", status: 503 }),
      };
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      const created = await createResponse!.json() as any;
      const publishRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}/publish`, { method: "POST" });
      const publishResponse = await handleWappsApi(publishRequest, new URL(publishRequest.url), "POST", authContext, ctx);
      expect(publishResponse?.status).toBe(503);
      expect(ctx.wappStore.get(created.wapp.id)?.lastPublishedAt).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("deletes WApps by publishing a deleted Flight Deck record", async () => {
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
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      const created = await createResponse!.json() as any;
      published.length = 0;

      const deleteRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}`, { method: "DELETE" });
      const deleteResponse = await handleWappsApi(deleteRequest, new URL(deleteRequest.url), "DELETE", authContext, ctx);
      const deleted = await deleteResponse!.json() as any;

      expect(deleteResponse?.status).toBe(200);
      expect(deleted.wapp.recordState).toBe("deleted");
      expect(ctx.wappStore.get(created.wapp.id)?.recordState).toBe("deleted");
      expect(published).toHaveLength(1);
      expect((published[0] as any).record_id).toBe(created.wapp.id);
      expect((published[0] as any).data.record_state).toBe("deleted");
    } finally {
      cleanup();
    }
  });

  test("archives WApps by publishing an archived Flight Deck record", async () => {
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
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      const created = await createResponse!.json() as any;
      published.length = 0;

      const archiveRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}/archive`, { method: "POST" });
      const archiveResponse = await handleWappsApi(archiveRequest, new URL(archiveRequest.url), "POST", authContext, ctx);
      const archived = await archiveResponse!.json() as any;

      expect(archiveResponse?.status).toBe(200);
      expect(archived.wapp.status).toBe("archived");
      expect(archived.wapp.recordState).toBe("archived");
      expect(published).toHaveLength(1);
      expect((published[0] as any).data.status).toBe("archived");
      expect((published[0] as any).data.record_state).toBe("archived");
    } finally {
      cleanup();
    }
  });

  test("keeps WApp active when delete tombstone publication fails", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      ctx.publisher = {
        publish: async () => ({ published: false, error: "wapp-publish-transport-unavailable", status: 503 }),
      };
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      const created = await createResponse!.json() as any;

      const deleteRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}`, { method: "DELETE" });
      const deleteResponse = await handleWappsApi(deleteRequest, new URL(deleteRequest.url), "DELETE", authContext, ctx);

      expect(deleteResponse?.status).toBe(503);
      expect(ctx.wappStore.get(created.wapp.id)?.recordState).toBe("active");
    } finally {
      cleanup();
    }
  });

  test("rejects WApp template creation in non-empty roots unless forced", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      const root = mkdtempSync(join(tmpdir(), "wapp-template-existing-"));
      writeFileSync(join(root, "package.json"), "{}\n");
      const request = new Request("http://localhost:3000/api/wapps/templates/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root }),
      });
      const response = await handleWappsApi(request, new URL(request.url), "POST", authContext, ctx);
      expect(response?.status).toBe(400);
      expect((await response!.json()).error).toContain("not empty");

      const forced = new Request("http://localhost:3000/api/wapps/templates/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root, force: true }),
      });
      const forcedResponse = await handleWappsApi(forced, new URL(forced.url), "POST", authContext, ctx);
      expect(forcedResponse?.status).toBe(201);
      rmSync(root, { recursive: true, force: true });
    } finally {
      cleanup();
    }
  });
});
