import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { mintSessionCookie } from "../auth/session-cookie";
import { createBotKeyApiHandler } from "./bot-key-api";
import { loadWingmanInstanceIdentity } from "./wingman-instance-identity";

function makeCookie(npub: string): string {
  return mintSessionCookie(npub, { secure: false }).cookie;
}

function createStoreStub() {
  return {
    getActiveKeyForUser: () => null,
    createKey: () => {
      throw new Error("legacy bot key creation should not be called");
    },
  } as any;
}

function createRequest(path: string, npub: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { cookie: makeCookie(npub) },
  });
}

function createPostRequest(path: string, npub: string, body: Record<string, unknown> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: makeCookie(npub),
    },
    body: JSON.stringify(body),
  });
}

describe("bot key API with Wingman instance identity", () => {
  test("returns only public Wingman details to non-admin users", async () => {
    const userNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const wingmanNsec = nip19.nsecEncode(generateSecretKey());
    const identity = loadWingmanInstanceIdentity({ WINGMAN_PRIV: wingmanNsec });
    if (!identity) throw new Error("expected identity");

    const handler = createBotKeyApiHandler({
      store: createStoreStub(),
      getSession: () => undefined,
      getInstanceIdentity: () => identity,
      isAdminNpub: () => false,
    });

    const response = await handler(createRequest("/api/bot-keys/me", userNpub), new URL("http://localhost/api/bot-keys/me"), "GET");
    const body = await response!.json() as Record<string, unknown>;

    expect(response!.status).toBe(200);
    expect(body.hasKey).toBe(true);
    expect(body.botNpub).toBe(identity.npub);
    expect(body.botPubkeyHex).toBe(identity.pubkeyHex);
    expect(body.source).toBe("wingman_priv");
    expect(body.canExportNsec).toBe(false);
    expect(body.nsec).toBeUndefined();
    expect(body.nsecHex).toBeUndefined();
  });

  test("exports the instance nsec only for admins", async () => {
    const adminNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const userNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const wingmanNsec = nip19.nsecEncode(generateSecretKey());
    const identity = loadWingmanInstanceIdentity({ WINGMAN_PRIV: wingmanNsec });
    if (!identity) throw new Error("expected identity");

    const handler = createBotKeyApiHandler({
      store: createStoreStub(),
      getSession: () => undefined,
      getInstanceIdentity: () => identity,
      isAdminNpub: (npub) => npub === adminNpub,
    });

    const denied = await handler(
      createRequest("/api/bot-keys/admin-nsec", userNpub),
      new URL("http://localhost/api/bot-keys/admin-nsec"),
      "GET",
    );
    expect(denied!.status).toBe(403);

    const allowed = await handler(
      createRequest("/api/bot-keys/admin-nsec", adminNpub),
      new URL("http://localhost/api/bot-keys/admin-nsec"),
      "GET",
    );
    const body = await allowed!.json() as Record<string, unknown>;

    expect(allowed!.status).toBe(200);
    expect(body.nsec).toBe(identity.nsec);
    expect(body.nsecHex).toBeUndefined();
    expect(body.botNpub).toBe(identity.npub);
    expect(body.botPubkeyHex).toBe(identity.pubkeyHex);
  });

  test("does not fall back to per-user key generation when WINGMAN_PRIV is missing", async () => {
    const userNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const handler = createBotKeyApiHandler({
      store: createStoreStub(),
      getSession: () => undefined,
      getInstanceIdentity: () => null,
      isAdminNpub: () => false,
    });

    const forceSync = await handler(
      createPostRequest("/api/bot-keys/force-sync", userNpub),
      new URL("http://localhost/api/bot-keys/force-sync"),
      "POST",
    );
    expect(forceSync!.status).toBe(400);
    expect((await forceSync!.json() as { error: string }).error).toContain("WINGMAN_PRIV");

    const replace = await handler(
      createPostRequest("/api/bot-keys/replace", userNpub, { userPubkeyHex: "0".repeat(64) }),
      new URL("http://localhost/api/bot-keys/replace"),
      "POST",
    );
    expect(replace!.status).toBe(400);
    expect((await replace!.json() as { error: string }).error).toContain("generation is disabled");
  });
});
