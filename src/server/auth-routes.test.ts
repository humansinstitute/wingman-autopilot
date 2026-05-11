import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { AccessActions } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import { normaliseNpub } from "../identity/npub-utils";
import { handleAuthApi, type AuthApiContext } from "./auth-routes";

const makeNpub = () => nip19.npubEncode(getPublicKey(generateSecretKey()));

function createAuthContext(adminNpub: string): AuthApiContext {
  const knownUsers = new Set<string>();
  return {
    config: {
      registrationEnabled: false,
      connectRelays: [],
      giteaUrl: null,
      giteaApiToken: null,
      giteaOwner: null,
    },
    adminNpub: normaliseNpub(adminNpub),
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
});
