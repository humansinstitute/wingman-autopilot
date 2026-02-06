/**
 * NIP-98 API Handler
 *
 * HTTP handler for /api/mcp/nip98/* routes.
 * Called by the MCP stdio server (running inside agent processes)
 * to sign NIP-98 tokens and manage grants.
 *
 * Follows the CaproverApi pattern — factory function returning a
 * (request, url, method) => Response handler.
 */

import type { SessionSnapshot } from "../agents/process-manager";
import { signWithWingmanKey, isWingmanKeyAvailable } from "./wingman-signer";
import type { Nip98GrantStore } from "./grants-store";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface Nip98ApiDependencies {
  grantsStore: Nip98GrantStore;
  /** Resolve a session by its ID. Returns null if not found. */
  getSession: (sessionId: string) => SessionSnapshot | null;
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

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createNip98ApiHandler(deps: Nip98ApiDependencies) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/mcp/nip98")) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    // segments: ["api", "mcp", "nip98", ...]

    try {
      // POST /api/mcp/nip98/sign
      if (segments.length === 4 && segments[3] === "sign" && method === "POST") {
        return await handleSign(deps, request);
      }

      // POST /api/mcp/nip98/request-grant
      if (segments.length === 4 && segments[3] === "request-grant" && method === "POST") {
        return await handleRequestGrant(deps, request);
      }

      // GET /api/mcp/nip98/grants?sessionId=...
      if (segments.length === 4 && segments[3] === "grants" && method === "GET") {
        return handleListGrants(deps, url);
      }

      // DELETE /api/mcp/nip98/grants/:id
      if (segments.length === 5 && segments[3] === "grants" && method === "DELETE") {
        return handleRevokeGrant(deps, segments[4]!);
      }

      // GET /api/mcp/nip98/status
      if (segments.length === 4 && segments[3] === "status" && method === "GET") {
        return handleStatus();
      }

      return jsonError("Not found", 404);
    } catch (err) {
      console.error("[nip98-api] Error:", err);
      return jsonError((err as Error).message, 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/mcp/nip98/sign
 *
 * Body: { sessionId, url, method, bodyHash?, tier? }
 * Returns: { token, signedBy }
 */
async function handleSign(
  deps: Nip98ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const targetUrl = body.url as string | undefined;
  const httpMethod = body.method as string | undefined;
  const bodyHash = body.bodyHash as string | undefined;
  const tier = (body.tier as number) ?? 1;

  if (!sessionId || !targetUrl || !httpMethod) {
    return jsonError("sessionId, url, and method are required", 400);
  }

  // Validate the session exists
  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }

  if (tier === 1) {
    // Tier 1: sign with Wingman's server key
    const result = await signWithWingmanKey(targetUrl, httpMethod, bodyHash);
    return Response.json(result);
  }

  if (tier === 2) {
    // Tier 2: user delegation — check for active grant
    if (!session.npub) {
      return jsonError("Session has no associated user — cannot sign Tier 2", 403);
    }

    const domain = new URL(targetUrl).hostname;
    const grant = deps.grantsStore.findActiveGrant(domain, session.npub, sessionId);
    if (!grant) {
      return jsonError(
        `No active grant for ${domain}. Call request_api_access first.`,
        403,
      );
    }

    // TODO Phase 2: Route sign request to user's browser via SSE/WS.
    // For now, return an error explaining browser signing is not yet wired.
    return jsonError(
      "Tier 2 browser signing is not yet implemented. " +
        "Grant exists — browser signing pipeline coming in Phase 2.",
      501,
    );
  }

  return jsonError("tier must be 1 or 2", 400);
}

/**
 * POST /api/mcp/nip98/request-grant
 *
 * Body: { sessionId, domain, reason, durationHours?, endpoints? }
 * Returns: { granted, grantId? } or { error }
 */
async function handleRequestGrant(
  deps: Nip98ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const domain = body.domain as string | undefined;
  const reason = body.reason as string | undefined;
  const durationHours = (body.durationHours as number) ?? 24;
  const endpoints = body.endpoints as Array<{ method: string; path: string }> | undefined;

  if (!sessionId || !domain || !reason) {
    return jsonError("sessionId, domain, and reason are required", 400);
  }

  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }
  if (!session.npub) {
    return jsonError("Session has no associated user", 403);
  }

  // TODO Phase 2: Send consent request to browser via SSE/WS and wait.
  // For now, auto-approve grants so Tier 2 flow can be tested end-to-end
  // once browser signing is wired up.
  const grant = deps.grantsStore.createGrant({
    domain,
    userNpub: session.npub,
    sessionId,
    signerType: "ephemeral",
    durationHours: Math.min(durationHours, 168), // Cap at 7 days
    reason,
    endpoints: endpoints?.map((e) => ({
      method: e.method as "GET" | "POST" | "PUT" | "DELETE" | "*",
      pathPattern: e.path,
    })),
  });

  console.log(
    `[nip98-api] Grant auto-approved: ${grant.id} for ${domain} (session=${sessionId})`,
  );

  return Response.json({ granted: true, grantId: grant.id });
}

/**
 * GET /api/mcp/nip98/grants?sessionId=...
 */
function handleListGrants(deps: Nip98ApiDependencies, url: URL): Response {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return jsonError("sessionId query parameter is required", 400);
  }

  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }
  if (!session.npub) {
    return Response.json({ grants: [] });
  }

  const grants = deps.grantsStore.listGrantsForSession(sessionId, session.npub);
  return Response.json({ grants });
}

/**
 * DELETE /api/mcp/nip98/grants/:id
 */
function handleRevokeGrant(deps: Nip98ApiDependencies, grantId: string): Response {
  const removed = deps.grantsStore.revokeGrant(grantId);
  if (!removed) {
    return jsonError("Grant not found", 404);
  }
  return Response.json({ success: true });
}

/**
 * GET /api/mcp/nip98/status
 */
function handleStatus(): Response {
  return Response.json({
    tier1Available: isWingmanKeyAvailable(),
    tier2Available: false, // Phase 2
  });
}
