/**
 * API route handlers for authentication endpoints.
 * Extracted from server.ts to reduce file size.
 */

import { nip19 } from "nostr-tools";
import { normaliseNpub } from "../identity/npub-utils";
import type { RequestAuthContext } from "../auth/request-context";
import type { AccessAction } from "../auth/access-control";
import type { SessionCookiePayload } from "../auth/session-cookie";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

// ---------- Context supplied by server.ts ----------

export interface AuthApiContext {
  config: {
    registrationEnabled: boolean;
    connectRelays: string[];
    giteaUrl: string | null;
    giteaApiToken: string | null;
    giteaOwner: string | null;
  };
  adminNpub: string | null;

  identityUserStore: {
    getByNormalized: (npub: string) => { npub: string; pictureUrl: string | null } | null;
    touch: (npub: string, opts: { alias: string; lastSeenAt: string }) => void;
  };

  botKeyStore: {
    getActiveKeyForUser: (npub: string) => unknown | null;
    createKey: (opts: {
      userNpub: string;
      botPubkeyHex: string;
      botNpub: string;
      displayName: string;
      encryptedToUser: string;
      encryptedEscrow: string;
      escrowUuid: string;
    }) => void;
  };

  mintSessionCookie: (npub: string) => {
    cookie: string;
    expiresAt: number;
    payload: SessionCookiePayload;
  };
  SessionCookieError: new (...args: any[]) => Error;
  SESSION_COOKIE_NAME: string;
  shouldUseSecureCookies: () => boolean;

  generateIdentityAlias: (npub: string) => string;
  generateBotKey: (userPubkeyHex: string) => {
    botPubkeyHex: string;
    botNpub: string;
    displayName: string;
    encryptedToUser: string;
    encryptedEscrow: string;
    escrowUuid: string;
  };

  handleKeyTeleport: (request: Request) => Response | Promise<Response>;
  handleKeyTeleportRegistration: (request: Request) => Response | Promise<Response>;
  ensureGiteaUser: (config: any, npub: string, alias: string) => Promise<any>;

  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  AccessActions: { UiRestricted: AccessAction };
  getViewerNormalizedNpub: (authContext: RequestAuthContext) => string | null;
  normaliseOptionalString: (value: unknown) => string | null;
  resolveAndCacheNostrProfile: (npub: string, opts: { force?: boolean; relays?: string[] }) => Promise<{ pictureUrl: string | null }>;
  onSessionAuthenticated?: (npub: string) => void | Promise<void>;
}

// ---------- Main handler ----------

export async function handleAuthApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: AuthApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;

  // POST /api/auth/session — login / session creation
  if (pathname === "/api/auth/session" && method === "POST") {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const { npub, encryptedNsec } = payload as Record<string, unknown>;
    if (typeof npub !== "string" || npub.trim().length === 0) {
      return Response.json({ error: "npub is required" }, { status: 400 });
    }

    const trimmedNpub = npub.trim();
    if (typeof encryptedNsec !== "undefined" && encryptedNsec !== null && typeof encryptedNsec !== "string") {
      return Response.json({ error: "encryptedNsec must be a string" }, { status: 400 });
    }

    try {
      // Block new registrations when REGISTER=FALSE
      if (!ctx.config.registrationEnabled) {
        const normalized = normaliseNpub(trimmedNpub);
        const existingUser = normalized ? ctx.identityUserStore.getByNormalized(normalized) : null;
        if (!existingUser) {
          return Response.json({ error: "Registration is currently disabled" }, { status: 403 });
        }
      }

      const existingSession = authContext.session;
      if (existingSession && existingSession.npub !== trimmedNpub) {
        // Allow overwriting with a new npub, but clear stale signed data by minting a new cookie.
      }

      const { cookie, expiresAt, payload: cookiePayload } = ctx.mintSessionCookie(trimmedNpub);
      authContext.npub = cookiePayload.npub;
      authContext.actorNpub = cookiePayload.npub;
      authContext.signerNpub = cookiePayload.npub;
      authContext.subjectNpub = cookiePayload.npub;
      authContext.targetOwnerNpub = cookiePayload.npub;
      authContext.delegatedOwnerNpub = null;
      authContext.delegateRelationshipId = null;
      authContext.delegateScopes = null;
      authContext.session = cookiePayload;
      delete authContext.error;
      const alias = ctx.generateIdentityAlias(trimmedNpub);
      try {
        ctx.identityUserStore.touch(trimmedNpub, {
          alias,
          lastSeenAt: new Date().toISOString(),
        });
      } catch (error) {
        console.warn(`[admin] failed to record identity ${trimmedNpub}:`, error);
      }
      void ctx.onSessionAuthenticated?.(trimmedNpub);

      // Ensure every authenticated user has a bot key at login time.
      try {
        const existingBotKey = ctx.botKeyStore.getActiveKeyForUser(trimmedNpub);
        if (!existingBotKey) {
          const decoded = nip19.decode(trimmedNpub);
          if (decoded.type === "npub") {
            const userPubkeyHex = decoded.data as string;
            const generated = ctx.generateBotKey(userPubkeyHex);
            ctx.botKeyStore.createKey({
              userNpub: trimmedNpub,
              botPubkeyHex: generated.botPubkeyHex,
              botNpub: generated.botNpub,
              displayName: generated.displayName,
              encryptedToUser: generated.encryptedToUser,
              encryptedEscrow: generated.encryptedEscrow,
              escrowUuid: generated.escrowUuid,
            });
            console.log(`[bot-key] Generated bot key at login for ${trimmedNpub.slice(0, 20)}…: ${generated.botNpub.slice(0, 20)}…`);
          }
        }
      } catch (error) {
        console.warn(`[bot-key] Failed login-time bot generation for ${trimmedNpub}:`, error);
      }

      // Fire-and-forget Gitea user provisioning
      if (ctx.config.giteaUrl && ctx.config.giteaApiToken && ctx.config.giteaOwner) {
        ctx.ensureGiteaUser(ctx.config, trimmedNpub, alias).catch((err) => {
          console.warn(`[gitea] user provisioning failed for ${trimmedNpub}:`, err);
        });
      }

      const headers = new Headers({
        "cache-control": "no-store",
      });
      headers.append("set-cookie", cookie);
      return Response.json({ expiresAt }, { headers });
    } catch (error) {
      if (error instanceof ctx.SessionCookieError) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: `Failed to mint session cookie: ${message}` }, { status: 500 });
    }
  }

  // DELETE /api/auth/session — logout
  if (pathname === "/api/auth/session" && method === "DELETE") {
    const headers = new Headers({
      "cache-control": "no-store",
    });
    const secureFlag = ctx.shouldUseSecureCookies() ? "; Secure" : "";
    headers.append(
      "set-cookie",
      `${ctx.SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secureFlag}`,
    );
    authContext.npub = null;
    authContext.actorNpub = null;
    authContext.signerNpub = null;
    authContext.subjectNpub = null;
    authContext.targetOwnerNpub = null;
    authContext.delegatedOwnerNpub = null;
    authContext.delegateRelationshipId = null;
    authContext.delegateScopes = null;
    authContext.session = null;
    delete authContext.error;
    return new Response(null, { status: 204, headers });
  }

  // POST /api/auth/keyteleport — receive encrypted key blob from Welcome
  if (pathname === "/api/auth/keyteleport" && method === "POST") {
    return ctx.handleKeyTeleport(request);
  }

  // GET /api/auth/keyteleport/config — keyteleport configuration
  if (pathname === "/api/auth/keyteleport/config" && method === "GET") {
    const { getKeyTeleportIdentity, KEYTELEPORT_WELCOME_URL } = await import("../config");
    const identity = getKeyTeleportIdentity();
    const isConfigured = Boolean(identity);
    return Response.json({
      enabled: isConfigured,
      welcomeUrl: isConfigured ? KEYTELEPORT_WELCOME_URL : null,
      appNpub: identity?.npub ?? null,
    });
  }

  // GET /api/auth/keyteleport/registration — registration blob
  if (pathname === "/api/auth/keyteleport/registration" && method === "GET") {
    return ctx.handleKeyTeleportRegistration(request);
  }

  // GET /api/identity/profile — profile lookup
  if (pathname === "/api/identity/profile" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.UiRestricted, request, url, authContext);
    if (denied) {
      return denied;
    }
    const viewerNormalized = ctx.getViewerNormalizedNpub(authContext);
    const viewerIsAdmin = Boolean(ctx.adminNpub && viewerNormalized && ctx.adminNpub === viewerNormalized);
    const targetInput = ctx.normaliseOptionalString(url.searchParams.get("npub")) ?? authContext.npub;
    const refresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("force") === "1";
    if (!targetInput) {
      return Response.json({ error: "npub is required" }, { status: 400 });
    }
    const normalizedTarget = normaliseNpub(targetInput);
    if (!normalizedTarget) {
      return Response.json({ error: "Invalid npub" }, { status: 400 });
    }
    if (!viewerIsAdmin && normalizedTarget !== viewerNormalized) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    try {
      const profile = await ctx.resolveAndCacheNostrProfile(targetInput, {
        force: refresh,
        relays: ctx.config.connectRelays,
      });
      const record = ctx.identityUserStore.getByNormalized(normalizedTarget);
      return Response.json({
        npub: record?.npub ?? targetInput,
        pictureUrl: profile.pictureUrl ?? record?.pictureUrl ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  return null;
}
