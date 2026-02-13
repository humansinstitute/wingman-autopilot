/**
 * SuperBased API Handler (v3)
 *
 * HTTP handler for /api/superbased/* routes. Proxies requests to a
 * SuperBased / Flux Adaptor API with NIP-98 authentication (Tier 1),
 * and handles NIP-44 encryption/decryption of record payloads.
 *
 * v3: Append-only versioned records, UUID record IDs, no metadata column.
 */

import { signWithWingmanKey } from "../mcp/wingman-signer";
import { getKeyTeleportIdentity } from "../config";
import { nip44Encrypt, nip44Decrypt, encryptToMultipleRecipients } from "./nip44-crypto";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface SuperbasedApiDependencies {
  /** Default base URL from config.superbasedUrl. */
  defaultBaseUrl: string | null;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function resolveBaseUrl(
  paramUrl: string | undefined,
  defaultUrl: string | null,
): string {
  const url = paramUrl?.trim();
  if (url && url.length > 0) return url.replace(/\/+$/, "");
  if (defaultUrl) return defaultUrl;
  throw new Error(
    "No SuperBased URL configured. Set SUPERBASED_URL or pass base_url parameter.",
  );
}

/**
 * Make an authenticated GET request to the SuperBased API.
 */
async function authenticatedGet(url: string): Promise<globalThis.Response> {
  const { token } = await signWithWingmanKey(url, "GET");
  return fetch(url, {
    headers: { Authorization: token },
  });
}

/**
 * Make an authenticated POST request to the SuperBased API.
 */
async function authenticatedPost(
  url: string,
  body: unknown,
): Promise<globalThis.Response> {
  const jsonBody = JSON.stringify(body);
  const bodyHash = bytesToHex(sha256(new TextEncoder().encode(jsonBody)));
  const { token } = await signWithWingmanKey(url, "POST", bodyHash);
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: jsonBody,
  });
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createSuperbasedApiHandler(deps: SuperbasedApiDependencies) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/superbased")) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    // segments: ["api", "superbased", ...]

    try {
      // GET /api/superbased/health
      if (segments.length === 3 && segments[2] === "health" && method === "GET") {
        return await handleHealth(deps, url);
      }

      // GET /api/superbased/records
      if (segments.length === 3 && segments[2] === "records" && method === "GET") {
        return await handleFetchRecords(deps, url);
      }

      // POST /api/superbased/sync
      if (segments.length === 3 && segments[2] === "sync" && method === "POST") {
        return await handleSyncRecords(deps, request);
      }

      // GET /api/superbased/history
      if (segments.length === 3 && segments[2] === "history" && method === "GET") {
        return await handleHistory(deps, url);
      }

      return jsonError("Not found", 404);
    } catch (err) {
      console.error("[superbased-api] Error:", err);
      return jsonError((err as Error).message, 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/superbased/health
 */
async function handleHealth(
  deps: SuperbasedApiDependencies,
  url: URL,
): Promise<Response> {
  let baseUrl: string;
  try {
    baseUrl = resolveBaseUrl(
      url.searchParams.get("base_url") ?? undefined,
      deps.defaultBaseUrl,
    );
  } catch (err) {
    return jsonError((err as Error).message, 400);
  }

  try {
    const healthUrl = `${baseUrl}/health`;
    const response = await authenticatedGet(healthUrl);
    const data = await response.json();
    return Response.json({ status: response.status, data });
  } catch (err) {
    console.warn(`[superbased-api] Health check failed: ${(err as Error).message}`);
    return jsonError(`Health check failed: ${(err as Error).message}`, 502);
  }
}

/**
 * GET /api/superbased/records
 *
 * Fetch records delegated to Wingman, auto-decrypt each delegate_payload.
 * v3: encrypted_from is a top-level field, delegate_payload is singular.
 */
async function handleFetchRecords(
  deps: SuperbasedApiDependencies,
  url: URL,
): Promise<Response> {
  let baseUrl: string;
  try {
    baseUrl = resolveBaseUrl(
      url.searchParams.get("base_url") ?? undefined,
      deps.defaultBaseUrl,
    );
  } catch (err) {
    return jsonError((err as Error).message, 400);
  }

  const appNpub = url.searchParams.get("app_npub");
  if (!appNpub) {
    return jsonError("app_npub query parameter is required", 400);
  }

  const ownerPubkey = url.searchParams.get("owner_pubkey");
  if (!ownerPubkey) {
    return jsonError("owner_pubkey query parameter is required", 400);
  }

  const identity = getKeyTeleportIdentity();
  if (!identity) {
    return jsonError("Wingman server key not configured (KEYTELEPORT_PRIVKEY)", 500);
  }

  // Build the upstream URL with query params
  const upstreamUrl = new URL(`${baseUrl}/records/${appNpub}/delegated`);
  upstreamUrl.searchParams.set("owner", ownerPubkey);
  const collection = url.searchParams.get("collection");
  const since = url.searchParams.get("since");
  const limit = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  if (collection) upstreamUrl.searchParams.set("collection", collection);
  if (since) upstreamUrl.searchParams.set("since", since);
  if (limit) upstreamUrl.searchParams.set("limit", limit);
  if (cursor) upstreamUrl.searchParams.set("cursor", cursor);

  try {
    const response = await authenticatedGet(upstreamUrl.toString());

    if (!response.ok) {
      const text = await response.text();
      return jsonError(`Upstream API error (${response.status}): ${text}`, response.status);
    }

    const data = await response.json() as
      | Record<string, unknown>[]
      | { records?: Record<string, unknown>[]; cursor?: string };
    const rawRecords = Array.isArray(data) ? data : (data.records ?? []);
    const nextCursor = Array.isArray(data) ? null : (data.cursor ?? null);

    // Decrypt each record's delegate_payload (singular in v3)
    const decryptedRecords = rawRecords.map((record: Record<string, unknown>) => {
      // v3: delegate_payload (singular) — the ciphertext for this delegate only
      const delegatePayload = record.delegate_payload as string | undefined;
      // v3: encrypted_from is a top-level field
      const senderPubkey = record.encrypted_from as string | undefined;

      if (!delegatePayload || !senderPubkey) {
        return { ...record, decrypted_payload: null, decrypt_error: "Missing delegate_payload or encrypted_from" };
      }

      try {
        const plaintext = nip44Decrypt(delegatePayload, identity.secretKey, senderPubkey);
        return { ...record, decrypted_payload: plaintext, decrypt_error: null };
      } catch (err) {
        return { ...record, decrypted_payload: null, decrypt_error: (err as Error).message };
      }
    });

    // Defense in depth: filter to only the requested owner's records
    const ownerFiltered = decryptedRecords.filter(
      (r: Record<string, unknown>) => r.owner_pubkey === ownerPubkey,
    );

    return Response.json({
      records: ownerFiltered,
      count: ownerFiltered.length,
      cursor: nextCursor,
    });
  } catch (err) {
    console.warn(`[superbased-api] Fetch records failed: ${(err as Error).message}`);
    return jsonError(`Fetch records failed: ${(err as Error).message}`, 502);
  }
}

/**
 * POST /api/superbased/sync
 *
 * Encrypt payloads to owner + delegates, then POST to upstream v3 sync endpoint.
 * v3: No metadata, encrypted_from is top-level, UUID record IDs.
 */
async function handleSyncRecords(
  deps: SuperbasedApiDependencies,
  request: Request,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await parseBody(request);
  } catch (err) {
    return jsonError((err as Error).message, 400);
  }

  let baseUrl: string;
  try {
    baseUrl = resolveBaseUrl(
      body.base_url as string | undefined,
      deps.defaultBaseUrl,
    );
  } catch (err) {
    return jsonError((err as Error).message, 400);
  }

  const appNpub = body.app_npub as string | undefined;
  if (!appNpub) {
    return jsonError("app_npub is required", 400);
  }

  const ownerPubkey = body.owner_pubkey as string | undefined;
  if (!ownerPubkey) {
    return jsonError("owner_pubkey is required", 400);
  }

  const records = body.records as Array<Record<string, unknown>> | undefined;
  if (!records || !Array.isArray(records) || records.length === 0) {
    return jsonError("records array is required and must be non-empty", 400);
  }

  const identity = getKeyTeleportIdentity();
  if (!identity) {
    return jsonError("Wingman server key not configured (KEYTELEPORT_PRIVKEY)", 500);
  }

  // Encrypt each record and build v3 upstream payload
  const encryptedRecords = records.map((record, index) => {
    const plaintext = record.plaintext_payload as string | undefined;
    if (!plaintext) {
      throw new Error(`Record ${index}: plaintext_payload is required`);
    }

    // Auto-generate UUID if not provided; validate format when provided
    let recordId = record.record_id as string | undefined;
    if (!recordId) {
      recordId = crypto.randomUUID();
    } else if (!UUID_RE.test(recordId)) {
      throw new Error(
        `Record ${index}: record_id "${recordId}" is not a valid UUID. ` +
        `Use UUID format or omit to auto-generate.`,
      );
    }

    const collection = (record.collection as string) || "default";
    const delegatePubkeys = record.delegate_pubkeys as string[] | undefined;

    // Encrypt to owner
    const encryptedData = nip44Encrypt(plaintext, identity.secretKey, ownerPubkey);

    // Encrypt to each delegate (if any) — do NOT auto-add Wingman
    const delegatePayloads: Record<string, string> = {};
    if (delegatePubkeys && delegatePubkeys.length > 0) {
      const delegateEncrypted = encryptToMultipleRecipients(
        plaintext,
        identity.secretKey,
        delegatePubkeys,
      );
      for (const [pubkey, ciphertext] of Object.entries(delegateEncrypted)) {
        delegatePayloads[pubkey] = ciphertext;
      }
    }

    return {
      record_id: recordId,
      owner_pubkey: ownerPubkey,
      collection,
      encrypted_data: encryptedData,
      encrypted_from: identity.pubkey,
      delegate_payloads: Object.keys(delegatePayloads).length > 0 ? delegatePayloads : undefined,
    };
  });

  const syncUrl = `${baseUrl}/records/${appNpub}/sync`;

  try {
    const response = await authenticatedPost(syncUrl, {
      records: encryptedRecords,
    });

    if (!response.ok) {
      const text = await response.text();
      return jsonError(`Upstream sync error (${response.status}): ${text}`, response.status);
    }

    const result = await response.json() as {
      synced?: Array<{ record_id: string; version: number }>;
      created?: number;
      updated?: number;
      rejected?: unknown[];
    };

    console.log(
      `[superbased-api] Synced ${encryptedRecords.length} records to ${appNpub}`,
    );

    // Return per-record record_id + version from upstream,
    // falling back to our generated IDs if upstream doesn't return synced array
    const synced = result.synced ?? encryptedRecords.map(r => ({
      record_id: r.record_id,
      version: 1,
    }));

    return Response.json({
      synced,
      created: result.created ?? 0,
      updated: result.updated ?? 0,
      rejected: result.rejected ?? [],
    });
  } catch (err) {
    console.warn(`[superbased-api] Sync records failed: ${(err as Error).message}`);
    return jsonError(`Sync records failed: ${(err as Error).message}`, 502);
  }
}

/**
 * GET /api/superbased/history
 *
 * Proxy to upstream history endpoint for a specific record.
 * Returns version chain. Optionally decrypts data if include_data=true.
 */
async function handleHistory(
  deps: SuperbasedApiDependencies,
  url: URL,
): Promise<Response> {
  let baseUrl: string;
  try {
    baseUrl = resolveBaseUrl(
      url.searchParams.get("base_url") ?? undefined,
      deps.defaultBaseUrl,
    );
  } catch (err) {
    return jsonError((err as Error).message, 400);
  }

  const appNpub = url.searchParams.get("app_npub");
  if (!appNpub) {
    return jsonError("app_npub query parameter is required", 400);
  }

  const recordId = url.searchParams.get("record_id");
  if (!recordId) {
    return jsonError("record_id query parameter is required", 400);
  }

  const includeData = url.searchParams.get("include_data") === "true";

  const upstreamUrl = new URL(
    `${baseUrl}/records/${appNpub}/history/${recordId}`,
  );
  if (includeData) {
    upstreamUrl.searchParams.set("include_data", "true");
  }

  try {
    const response = await authenticatedGet(upstreamUrl.toString());

    if (!response.ok) {
      const text = await response.text();
      return jsonError(`Upstream API error (${response.status}): ${text}`, response.status);
    }

    const data = await response.json() as Record<string, unknown>;

    // If include_data=true and we have versions with delegate payloads, decrypt them
    if (includeData && data.versions && Array.isArray(data.versions)) {
      const identity = getKeyTeleportIdentity();
      if (identity) {
        data.versions = (data.versions as Record<string, unknown>[]).map(
          (ver: Record<string, unknown>) => {
            const delegatePayload = ver.delegate_payload as string | undefined;
            const senderPubkey = ver.encrypted_from as string | undefined;
            if (!delegatePayload || !senderPubkey) return ver;

            try {
              const plaintext = nip44Decrypt(delegatePayload, identity.secretKey, senderPubkey);
              return { ...ver, decrypted_payload: plaintext };
            } catch {
              return { ...ver, decrypt_error: "Failed to decrypt" };
            }
          },
        );
      }
    }

    return Response.json(data);
  } catch (err) {
    console.warn(`[superbased-api] History fetch failed: ${(err as Error).message}`);
    return jsonError(`History fetch failed: ${(err as Error).message}`, 502);
  }
}
