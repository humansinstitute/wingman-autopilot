/**
 * ngit API Handler
 *
 * HTTP handler for /api/ngit/* routes. Builds NIP-34 event
 * templates, delegates signing to the user's browser via the
 * existing Tier 2 pending-request + SSE flow, then publishes
 * signed events to Nostr relays.
 *
 * Follows the same factory pattern as nip98-api.ts.
 */

import type { SessionSnapshot } from "../agents/process-manager";
import type { Nip98GrantStore } from "../mcp/grants-store";
import { pendingSignRequests } from "../mcp/pending-requests";
import { browserSubscribers } from "../mcp/browser-subscribers";
import {
  buildRepoAnnouncement,
  buildRepoState,
  REPO_ANNOUNCEMENT_KIND,
  REPO_STATE_KIND,
} from "./event-builder";
import type { RepoAnnouncementInput, RepoStateInput, UnsignedEventTemplate } from "./event-builder";
import { publishToRelays, queryRelays } from "./relay-publisher";
import type { SignedEvent } from "./relay-publisher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Synthetic domain for ngit grants — not a real HTTP domain. */
export const NGIT_GRANT_DOMAIN = "nostr.git";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface NgitApiDependencies {
  grantsStore: Nip98GrantStore;
  getSession: (sessionId: string) => SessionSnapshot | null;
  /** Default relay list from config.connectRelays. */
  defaultRelays: string[];
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object") {
      throw new Error("Expected JSON object");
    }
    return body as Record<string, unknown>;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

/**
 * Request the user's browser to sign an arbitrary Nostr event template.
 *
 * Reuses the same pending-request + SSE infrastructure as NIP-98 Tier 2,
 * but sends a `nostr:sign_request` type so the browser listener can
 * distinguish it from NIP-98 HTTP auth events.
 */
async function requestBrowserSign(
  eventTemplate: UnsignedEventTemplate,
  npub: string,
  grantId: string,
  description: string,
): Promise<SignedEvent> {
  if (!browserSubscribers.hasSubscriber(npub)) {
    throw new Error(
      "No active browser session for this user. Open the Wingman UI to enable signing.",
    );
  }

  const { requestId, promise } = pendingSignRequests.create(npub);

  const signRequest = {
    type: "nostr:sign_request" as const,
    requestId,
    grantId,
    description,
    eventTemplate,
  };

  const delivered = browserSubscribers.send(npub, signRequest);
  if (!delivered) {
    pendingSignRequests.reject(requestId, "Failed to deliver signing request to browser");
    throw new Error("Browser subscriber disconnected before delivery");
  }

  console.log(
    `[ngit-api] Sign request ${requestId} sent to browser (kind=${eventTemplate.kind}, npub=${npub.slice(0, 20)}…)`,
  );

  const signedEvent = await promise;
  return signedEvent as unknown as SignedEvent;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createNgitApiHandler(deps: NgitApiDependencies) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/ngit")) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    // segments: ["api", "ngit", ...]

    try {
      // POST /api/ngit/publish-repo
      if (segments.length === 3 && segments[2] === "publish-repo" && method === "POST") {
        return await handlePublishRepo(deps, request);
      }

      // POST /api/ngit/push-state
      if (segments.length === 3 && segments[2] === "push-state" && method === "POST") {
        return await handlePushState(deps, request);
      }

      // GET /api/ngit/repos?sessionId=...&pubkey=...
      if (segments.length === 3 && segments[2] === "repos" && method === "GET") {
        return await handleListRepos(deps, url);
      }

      return jsonError("Not found", 404);
    } catch (err) {
      console.error("[ngit-api] Error:", err);
      return jsonError((err as Error).message, 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

interface ValidatedSession {
  session: SessionSnapshot;
  sessionId: string;
  npub: string;
  grantId: string;
}

/**
 * Validate session, npub, and grant for ngit operations.
 */
function validateSessionAndGrant(
  deps: NgitApiDependencies,
  sessionId: string,
): ValidatedSession {
  const session = deps.getSession(sessionId);
  if (!session) {
    throw Object.assign(new Error("Unknown session"), { status: 404 });
  }

  if (!session.npub) {
    throw Object.assign(
      new Error("Session has no associated user — cannot sign NIP-34 events"),
      { status: 403 },
    );
  }

  const grant = deps.grantsStore.findActiveGrant(NGIT_GRANT_DOMAIN, session.npub, sessionId);
  if (!grant) {
    throw Object.assign(
      new Error(
        `No active grant for ${NGIT_GRANT_DOMAIN}. ` +
        `Call request_api_access with domain="${NGIT_GRANT_DOMAIN}" first.`,
      ),
      { status: 403 },
    );
  }

  return { session, sessionId, npub: session.npub, grantId: grant.id };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/ngit/publish-repo
 *
 * Build a kind 30617 repo announcement, sign via browser, publish to relays.
 */
async function handlePublishRepo(
  deps: NgitApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;

  if (!sessionId) {
    return jsonError("sessionId is required", 400);
  }

  const identifier = body.identifier as string | undefined;
  if (!identifier) {
    return jsonError("identifier is required", 400);
  }

  let validated: ValidatedSession;
  try {
    validated = validateSessionAndGrant(deps, sessionId);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return jsonError((err as Error).message, status);
  }

  // Merge caller-provided relays with defaults
  const callerRelays = body.relays as string[] | undefined;
  const relays = callerRelays && callerRelays.length > 0
    ? callerRelays
    : deps.defaultRelays;

  const input: RepoAnnouncementInput = {
    identifier,
    name: body.name as string | undefined,
    description: body.description as string | undefined,
    cloneUrls: body.clone_urls as string[] | undefined,
    webUrls: body.web_urls as string[] | undefined,
    relays,
    maintainers: body.maintainers as string[] | undefined,
    hashtags: body.hashtags as string[] | undefined,
    earliestUniqueCommit: body.earliest_unique_commit as string | undefined,
  };

  const eventTemplate = buildRepoAnnouncement(input);

  try {
    const signedEvent = await requestBrowserSign(
      eventTemplate,
      validated.npub,
      validated.grantId,
      `Publish git repository "${input.name ?? identifier}" to Nostr (NIP-34)`,
    );

    const publishResult = await publishToRelays(signedEvent, relays);

    console.log(
      `[ngit-api] Repo announcement published: ${identifier} → ${publishResult.successes}/${relays.length} relays`,
    );

    return Response.json({
      eventId: signedEvent.id,
      identifier,
      kind: REPO_ANNOUNCEMENT_KIND,
      relays: publishResult.results,
      successes: publishResult.successes,
      failures: publishResult.failures,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signing or publishing failed";
    console.warn(`[ngit-api] Publish repo failed: ${message}`);
    return jsonError(message, 502);
  }
}

/**
 * POST /api/ngit/push-state
 *
 * Build a kind 30618 repo state event, sign via browser, publish to relays.
 */
async function handlePushState(
  deps: NgitApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;

  if (!sessionId) {
    return jsonError("sessionId is required", 400);
  }

  const identifier = body.identifier as string | undefined;
  const refs = body.refs as Record<string, string> | undefined;

  if (!identifier) {
    return jsonError("identifier is required", 400);
  }
  if (!refs || typeof refs !== "object" || Object.keys(refs).length === 0) {
    return jsonError("refs is required and must be a non-empty object (branch → commit SHA)", 400);
  }

  let validated: ValidatedSession;
  try {
    validated = validateSessionAndGrant(deps, sessionId);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return jsonError((err as Error).message, status);
  }

  const callerRelays = body.relays as string[] | undefined;
  const relays = callerRelays && callerRelays.length > 0
    ? callerRelays
    : deps.defaultRelays;

  const input: RepoStateInput = {
    identifier,
    refs,
    head: body.head as string | undefined,
    relays,
  };

  const eventTemplate = buildRepoState(input);

  try {
    const signedEvent = await requestBrowserSign(
      eventTemplate,
      validated.npub,
      validated.grantId,
      `Push repository state for "${identifier}" to Nostr (NIP-34)`,
    );

    const publishResult = await publishToRelays(signedEvent, relays);

    console.log(
      `[ngit-api] Repo state published: ${identifier} (${Object.keys(refs).length} refs) → ${publishResult.successes}/${relays.length} relays`,
    );

    return Response.json({
      eventId: signedEvent.id,
      identifier,
      kind: REPO_STATE_KIND,
      refsCount: Object.keys(refs).length,
      relays: publishResult.results,
      successes: publishResult.successes,
      failures: publishResult.failures,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signing or publishing failed";
    console.warn(`[ngit-api] Push state failed: ${message}`);
    return jsonError(message, 502);
  }
}

/**
 * GET /api/ngit/repos?sessionId=...&pubkey=...
 *
 * Query relays for kind 30617 repository announcements.
 * If pubkey is omitted, uses the session user's pubkey.
 */
async function handleListRepos(
  deps: NgitApiDependencies,
  url: URL,
): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return jsonError("sessionId query parameter is required", 400);
  }

  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }

  // Use explicit pubkey or fall back to session user
  let authorHex = url.searchParams.get("pubkey");
  if (!authorHex && session.npub) {
    // Convert npub to hex for the relay filter
    try {
      const { nip19 } = await import("nostr-tools");
      const decoded = nip19.decode(session.npub);
      if (decoded.type === "npub") {
        authorHex = decoded.data as string;
      }
    } catch {
      return jsonError("Failed to decode user npub", 500);
    }
  }

  if (!authorHex) {
    return jsonError("No pubkey available — provide pubkey param or log in", 400);
  }

  const relayParam = url.searchParams.get("relays");
  const relays = relayParam
    ? relayParam.split(",").map((r) => r.trim()).filter(Boolean)
    : deps.defaultRelays;

  try {
    const events = await queryRelays(relays, {
      kinds: [REPO_ANNOUNCEMENT_KIND],
      authors: [authorHex],
      limit: 50,
    });

    const repos = events.map((e) => ({
      eventId: e.id,
      identifier: e.tags.find((t) => t[0] === "d")?.[1] ?? "",
      name: e.tags.find((t) => t[0] === "name")?.[1],
      description: e.tags.find((t) => t[0] === "description")?.[1],
      cloneUrls: e.tags.filter((t) => t[0] === "clone").map((t) => t[1]),
      webUrls: e.tags.filter((t) => t[0] === "web").map((t) => t[1]),
      relays: e.tags.find((t) => t[0] === "relays")?.slice(1) ?? [],
      maintainers: e.tags.filter((t) => t[0] === "maintainers").map((t) => t[1]),
      hashtags: e.tags.filter((t) => t[0] === "t").map((t) => t[1]),
      createdAt: e.created_at,
      pubkey: e.pubkey,
    }));

    return Response.json({ repos, count: repos.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Relay query failed";
    console.warn(`[ngit-api] List repos failed: ${message}`);
    return jsonError(message, 502);
  }
}
