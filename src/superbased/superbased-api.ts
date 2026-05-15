/**
 * SuperBased API Handler (v3)
 *
 * HTTP handler for /api/superbased/* routes. Proxies requests to a
 * SuperBased / Flux Adaptor API with NIP-98 authentication (Tier 1),
 * and handles NIP-44 encryption/decryption of record payloads.
 *
 * v3: Append-only versioned records, UUID record IDs, no metadata column.
 *
 * Uses the shared Wingman instance identity for signing and crypto.
 */

import { signForSession } from "../mcp/wingman-signer";
import { loadWingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import { nip44Encrypt, nip44Decrypt, encryptToMultipleRecipients } from "./nip44-crypto";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { parseBody, jsonError } from "../utils/request-utils";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface SuperbasedApiDependencies {
  /** Default base URL from config.superbasedUrl. */
  defaultBaseUrl: string | null;
  /** Optional session lookup to resolve user npub from session_id. */
  getSession?: (sessionId: string) => { npub?: string | null } | null;
}

export interface SuperbasedPlaintextRecordInput {
  record_id?: string;
  collection?: string;
  plaintext_payload: string;
  delegate_pubkeys?: string[];
}

export interface SuperbasedSyncPlaintextInput {
  base_url?: string;
  owner_pubkey: string;
  records: SuperbasedPlaintextRecordInput[];
  user_npub?: string;
  session_id?: string;
}

export interface SuperbasedSyncPlaintextResult {
  synced: Array<{ record_id: string; version: number }>;
  created: number;
  updated: number;
  rejected: unknown[];
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type NamespaceMode = "default";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveBaseUrl(
  paramUrl: string | undefined,
  defaultUrl: string | null,
): string {
  const raw = paramUrl?.trim();
  const url = raw && raw.length > 0 ? raw : defaultUrl;
  if (!url) {
    throw new Error(
      "No SuperBased URL configured. Set SUPERBASED_URL or pass base_url parameter.",
    );
  }
  // Validate URL scheme to prevent SSRF via protocol smuggling (e.g. file://, javascript://)
  const parsed = URL.parse(url);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error("base_url must use http or https scheme");
  }
  return url.replace(/\/+$/, "");
}

function resolveNamespaceMode(raw: unknown): NamespaceMode {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!value || value === "default" || value === "appless" || value === "app-less") {
    return "default";
  }
  throw new Error("This Wingman SuperBased proxy is app-less only (namespace_mode=default)");
}

function resolveUserNpub(
  deps: SuperbasedApiDependencies,
  explicitUserNpub: string | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (explicitUserNpub && explicitUserNpub.trim().length > 0) {
    return explicitUserNpub;
  }
  if (!sessionId || !deps.getSession) {
    return undefined;
  }
  const session = deps.getSession(sessionId);
  const sessionNpub = session?.npub;
  return sessionNpub && sessionNpub.length > 0 ? sessionNpub : undefined;
}

/**
 * Resolve the signing key identity from WINGMAN_PRIV.
 */
function resolveSigningIdentity(userNpub?: string | null): {
  secretKey: Uint8Array;
  pubkey: string;
  source: "wingman";
} {
  const identity = loadWingmanInstanceIdentity();
  if (!identity) {
    throw new Error("No Wingman instance key available (set WINGMAN_PRIV)");
  }
  return { secretKey: identity.secretKey, pubkey: identity.pubkeyHex, source: "wingman" };
}

export async function syncSuperbasedPlaintextRecords(
  deps: SuperbasedApiDependencies,
  input: SuperbasedSyncPlaintextInput,
): Promise<SuperbasedSyncPlaintextResult> {
  const baseUrl = resolveBaseUrl(input.base_url, deps.defaultBaseUrl);
  const effectiveUserNpub = resolveUserNpub(deps, input.user_npub, input.session_id);
  const signingIdentity = resolveSigningIdentity(effectiveUserNpub);

  if (!input.owner_pubkey) {
    throw new Error("owner_pubkey is required");
  }
  if (!input.records || !Array.isArray(input.records) || input.records.length === 0) {
    throw new Error("records array is required and must be non-empty");
  }

  const encryptedRecords = input.records.map((record, index) => {
    const plaintext = record.plaintext_payload;
    if (!plaintext) {
      throw new Error(`Record ${index}: plaintext_payload is required`);
    }

    let recordId = record.record_id;
    if (!recordId) {
      recordId = crypto.randomUUID();
    } else if (!UUID_RE.test(recordId)) {
      throw new Error(
        `Record ${index}: record_id "${recordId}" is not a valid UUID. ` +
        `Use UUID format or omit to auto-generate.`,
      );
    }

    const collection = record.collection || "default";
    const delegatePubkeys = record.delegate_pubkeys;
    const encryptedData = nip44Encrypt(plaintext, signingIdentity.secretKey, input.owner_pubkey);

    const delegatePayloads: Record<string, string> = {};
    if (delegatePubkeys && delegatePubkeys.length > 0) {
      const delegateEncrypted = encryptToMultipleRecipients(
        plaintext,
        signingIdentity.secretKey,
        delegatePubkeys,
      );
      for (const [pubkey, ciphertext] of Object.entries(delegateEncrypted)) {
        delegatePayloads[pubkey] = ciphertext;
      }
    }

    return {
      record_id: recordId,
      owner_pubkey: input.owner_pubkey,
      collection,
      encrypted_data: encryptedData,
      encrypted_from: signingIdentity.pubkey,
      delegate_payloads: Object.keys(delegatePayloads).length > 0 ? delegatePayloads : undefined,
    };
  });

  const syncUrl = `${baseUrl}/records/sync`;
  const response = await authenticatedPost(syncUrl, { records: encryptedRecords }, effectiveUserNpub);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upstream sync error (${response.status}): ${text}`);
  }

  const result = await response.json() as {
    synced?: Array<{ record_id: string; version: number }>;
    created?: number;
    updated?: number;
    rejected?: unknown[];
  };

  console.log(
    `[superbased-api] Synced ${encryptedRecords.length} records to default namespace`,
  );

  return {
    synced: result.synced ?? encryptedRecords.map(r => ({
      record_id: r.record_id,
      version: 1,
    })),
    created: result.created ?? 0,
    updated: result.updated ?? 0,
    rejected: result.rejected ?? [],
  };
}

/**
 * Make an authenticated GET request to the SuperBased API.
 */
async function authenticatedGet(url: string, userNpub?: string | null): Promise<globalThis.Response> {
  const { token } = await signForSession(url, "GET", userNpub);
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
  userNpub?: string | null,
): Promise<globalThis.Response> {
  const jsonBody = JSON.stringify(body);
  const bodyHash = bytesToHex(sha256(new TextEncoder().encode(jsonBody)));
  const { token } = await signForSession(url, "POST", userNpub, bodyHash);
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

      // GET /api/superbased/storage/:objectId/download-url
      if (
        segments.length === 5 &&
        segments[2] === "storage" &&
        segments[4] === "download-url" &&
        method === "GET"
      ) {
        return await handleStorageDownloadUrl(deps, url, segments[3]!);
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

  const userNpub = url.searchParams.get("user_npub") ?? undefined;
  const sessionId = url.searchParams.get("session_id") ?? undefined;
  const effectiveUserNpub = resolveUserNpub(deps, userNpub, sessionId);

  try {
    const healthUrl = `${baseUrl}/health`;
    const response = await authenticatedGet(healthUrl, effectiveUserNpub);
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
  try {
    resolveNamespaceMode(url.searchParams.get("namespace_mode"));
  } catch (err) {
    return jsonError((err as Error).message, 400);
  }
  if (appNpub) {
    // Legacy metadata only in app-less mode; ignored for routing.
  }

  const ownerPubkey = url.searchParams.get("owner_pubkey");
  if (!ownerPubkey) {
    return jsonError("owner_pubkey query parameter is required", 400);
  }

  const userNpub = url.searchParams.get("user_npub") ?? undefined;
  const sessionId = url.searchParams.get("session_id") ?? undefined;
  const effectiveUserNpub = resolveUserNpub(deps, userNpub, sessionId);

  let signingIdentity: { secretKey: Uint8Array; pubkey: string; source: string };
  try {
    signingIdentity = resolveSigningIdentity(effectiveUserNpub);
  } catch (err) {
    return jsonError((err as Error).message, 500);
  }

  // Build the upstream URL with query params
  const upstreamUrl = new URL(`${baseUrl}/records/delegated`);
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
    const response = await authenticatedGet(upstreamUrl.toString(), effectiveUserNpub);

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
      const delegatePayload = record.delegate_payload as string | undefined;
      const senderPubkey = record.encrypted_from as string | undefined;

      if (!delegatePayload || !senderPubkey) {
        return { ...record, decrypted_payload: null, decrypt_error: "Missing delegate_payload or encrypted_from" };
      }

      try {
        const plaintext = nip44Decrypt(delegatePayload, signingIdentity.secretKey, senderPubkey);
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
  try {
    resolveNamespaceMode(body.namespace_mode);
  } catch (err) {
    return jsonError((err as Error).message, 400);
  }
  if (appNpub) {
    // Legacy metadata only in app-less mode; ignored for routing.
  }

  const ownerPubkey = body.owner_pubkey as string | undefined;
  if (!ownerPubkey) {
    return jsonError("owner_pubkey is required", 400);
  }

  const records = body.records as Array<Record<string, unknown>> | undefined;
  if (!records || !Array.isArray(records) || records.length === 0) {
    return jsonError("records array is required and must be non-empty", 400);
  }

  const userNpub = body.user_npub as string | undefined;
  const sessionId = body.session_id as string | undefined;

  try {
    const result = await syncSuperbasedPlaintextRecords(deps, {
      base_url: baseUrl,
      owner_pubkey: ownerPubkey,
      records: records.map((record) => ({
        record_id: record.record_id as string | undefined,
        collection: record.collection as string | undefined,
        plaintext_payload: record.plaintext_payload as string,
        delegate_pubkeys: record.delegate_pubkeys as string[] | undefined,
      })),
      user_npub: userNpub,
      session_id: sessionId,
    });
    return Response.json(result);
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
  try {
    resolveNamespaceMode(url.searchParams.get("namespace_mode"));
  } catch (err) {
    return jsonError((err as Error).message, 400);
  }
  if (appNpub) {
    // Legacy metadata only in app-less mode; ignored for routing.
  }

  const recordId = url.searchParams.get("record_id");
  if (!recordId) {
    return jsonError("record_id query parameter is required", 400);
  }

  const includeData = url.searchParams.get("include_data") === "true";
  const userNpub = url.searchParams.get("user_npub") ?? undefined;
  const sessionId = url.searchParams.get("session_id") ?? undefined;
  const effectiveUserNpub = resolveUserNpub(deps, userNpub, sessionId);

  const upstreamUrl = new URL(
    `${baseUrl}/records/history/${recordId}`,
  );
  if (includeData) {
    upstreamUrl.searchParams.set("include_data", "true");
  }

  try {
    const response = await authenticatedGet(upstreamUrl.toString(), effectiveUserNpub);

    if (!response.ok) {
      const text = await response.text();
      return jsonError(`Upstream API error (${response.status}): ${text}`, response.status);
    }

    const data = await response.json() as Record<string, unknown>;

    // If include_data=true and we have versions with delegate payloads, decrypt them
    if (includeData && data.versions && Array.isArray(data.versions)) {
      let signingIdentity: { secretKey: Uint8Array; pubkey: string } | null = null;
      try {
        signingIdentity = resolveSigningIdentity(effectiveUserNpub);
      } catch {
        // Non-fatal: just skip decryption
      }

      if (signingIdentity) {
        const key = signingIdentity;
        data.versions = (data.versions as Record<string, unknown>[]).map(
          (ver: Record<string, unknown>) => {
            const delegatePayload = ver.delegate_payload as string | undefined;
            const senderPubkey = ver.encrypted_from as string | undefined;
            if (!delegatePayload || !senderPubkey) return ver;

            try {
              const plaintext = nip44Decrypt(delegatePayload, key.secretKey, senderPubkey);
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

/**
 * GET /api/superbased/storage/:objectId/download-url
 *
 * Proxy a presigned download URL request for a storage object.
 * Signs with the user's bot key (or root fallback) via signForSession.
 */
async function handleStorageDownloadUrl(
  deps: SuperbasedApiDependencies,
  url: URL,
  objectId: string,
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

  const userNpub = url.searchParams.get("user_npub") ?? undefined;
  const sessionId = url.searchParams.get("session_id") ?? undefined;
  const effectiveUserNpub = resolveUserNpub(deps, userNpub, sessionId);
  if (!effectiveUserNpub) {
    return jsonError("user_npub query parameter is required", 400);
  }

  const targetUrl = `${baseUrl}/storage/${objectId}/download-url`;

  try {
    const response = await authenticatedGet(targetUrl, effectiveUserNpub);

    if (!response.ok) {
      const text = await response.text();
      return jsonError(`Upstream API error (${response.status}): ${text}`, response.status);
    }

    const data = await response.json();
    return Response.json(data);
  } catch (err) {
    console.warn(`[superbased-api] Storage download URL failed: ${(err as Error).message}`);
    return jsonError(`Storage download URL failed: ${(err as Error).message}`, 502);
  }
}
