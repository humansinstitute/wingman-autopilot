import { describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { AccessActions } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import { normaliseNpub } from "../identity/npub-utils";
import { handleAuthApi, type AuthApiContext } from "./auth-routes";

const makeNpub = () => nip19.npubEncode(getPublicKey(generateSecretKey()));

function createAuthContext(adminNpub: string, adminNpubs: string[] = [adminNpub]): AuthApiContext {
  const knownUsers = new Set<string>();
  const normalizedAdmins = adminNpubs.map((npub) => normaliseNpub(npub)).filter((npub): npub is string => Boolean(npub));
  return {
    config: {
      baseUrl: "",
      registrationEnabled: false,
      connectRelays: [],
      giteaUrl: null,
      giteaApiToken: null,
      giteaOwner: null,
    },
    adminNpub: normaliseNpub(adminNpub),
    isAdminNpub: (npub) => {
      const normalized = normaliseNpub(npub ?? null);
      return Boolean(normalized && normalizedAdmins.includes(normalized));
    },
    identityUserStore: {
      getByNormalized: (npub) => knownUsers.has(npub) ? { npub, pictureUrl: null } : null,
      touch: (npub) => {
        const normalized = normaliseNpub(npub);
        if (normalized) knownUsers.add(normalized);
      },
    },
    mintSessionCookie: (npub) => ({
      cookie: "wingman_identity_session=test; Path=/",
      expiresAt: 1,
      payload: { npub, nonce: "test", issuedAt: 0, expiresAt: 1 },
    }),
    getSessionCookieName: () => "wingman_identity_session",
    SessionCookieError: Error,
    SESSION_COOKIE_NAME: "wingman_identity_session",
    shouldUseSecureCookies: () => false,
    generateIdentityAlias: (npub) => npub,
    handleKeyTeleport: () => Response.json({ ok: true }),
    handleKeyTeleportRegistration: () => Response.json({ ok: true }),
    ensureGiteaUser: async () => null,
    ensureApiAccess: async () => null,
    AccessActions: { UiRestricted: AccessActions.UiRestricted },
    getViewerNormalizedNpub: (auth) => normaliseNpub(auth.npub ?? null),
    normaliseOptionalString: (value) => typeof value === "string" && value.trim() ? value.trim() : null,
    resolveAndCacheNostrProfile: async () => ({ pictureUrl: null }),
  };
}

const requestAuthContext = (): RequestAuthContext => ({
  npub: null,
  actorNpub: null,
  session: null,
});

const signLoginEvent = (secretKey: Uint8Array, url = "http://localhost/api/auth/session") =>
  finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", url],
        ["method", "POST"],
        ["purpose", "wingman-login"],
      ],
      content: "wingman-login",
    },
    secretKey,
  );

describe("auth routes", () => {
  test("allows the configured admin to bootstrap when registration is disabled", async () => {
    const adminNpub = makeNpub();
    const request = new Request("http://localhost/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ npub: adminNpub }),
    });

    const response = await handleAuthApi(
      request,
      new URL(request.url),
      "POST",
      requestAuthContext(),
      createAuthContext(adminNpub),
    );

    expect(response?.status).toBe(200);
  });

  test("allows any configured admin to bootstrap when registration is disabled", async () => {
    const primaryAdminNpub = makeNpub();
    const secondaryAdminNpub = makeNpub();
    const request = new Request("http://localhost/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ npub: secondaryAdminNpub }),
    });

    const response = await handleAuthApi(
      request,
      new URL(request.url),
      "POST",
      requestAuthContext(),
      createAuthContext(primaryAdminNpub, [primaryAdminNpub, secondaryAdminNpub]),
    );

    expect(response?.status).toBe(200);
  });

  test("blocks unknown users when registration is disabled", async () => {
    const request = new Request("http://localhost/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ npub: makeNpub() }),
    });

    const response = await handleAuthApi(
      request,
      new URL(request.url),
      "POST",
      requestAuthContext(),
      createAuthContext(makeNpub()),
    );

    expect(response?.status).toBe(403);
    await expect(response!.json()).resolves.toMatchObject({
      error: "Registration is currently disabled",
    });
  });

  test("accepts a verified signed login event for the submitted npub", async () => {
    const secretKey = generateSecretKey();
    const adminNpub = nip19.npubEncode(getPublicKey(secretKey));
    const request = new Request("http://localhost/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ npub: adminNpub, signedEvent: signLoginEvent(secretKey) }),
    });

    const response = await handleAuthApi(
      request,
      new URL(request.url),
      "POST",
      requestAuthContext(),
      createAuthContext(adminNpub),
    );

    expect(response?.status).toBe(200);
  });

  test("rejects a signed login event from a different npub", async () => {
    const submittedNpub = makeNpub();
    const signerSecretKey = generateSecretKey();
    const request = new Request("http://localhost/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ npub: submittedNpub, signedEvent: signLoginEvent(signerSecretKey) }),
    });

    const response = await handleAuthApi(
      request,
      new URL(request.url),
      "POST",
      requestAuthContext(),
      createAuthContext(submittedNpub),
    );

    expect(response?.status).toBe(400);
    await expect(response!.json()).resolves.toMatchObject({
      error: "signedEvent.pubkey must match npub",
    });
  });
});
