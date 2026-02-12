/**
 * SuperBased API Handler
 *
 * HTTP handler for /api/superbased/* routes. Proxies requests to a
 * SuperBased / Flux Adaptor API with NIP-98 authentication (Tier 1),
 * and handles NIP-44 encryption/decryption of record payloads.
 *
 * Follows the same factory pattern as ngit-api.ts.
 */

import { signWithWingmanKey } from "../mcp/wingman-signer";
import { getKeyTeleportIdentity } from "../config";
import { nip44Encrypt, nip44Decrypt, encryptToMultipleRecipients } from "./nip44-crypto";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { nip19 } from "nostr-tools";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface SuperbasedApiDependencies {
  /** Default base URL from config.superbasedUrl. */
  defaultBaseUrl: string | null;
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
      // GET /api/superbased/health?base_url=...
      if (segments.length === 3 && segments[2] === "health" && method === "GET") {
        return await handleHealth(deps, url);
      }

      // GET /api/superbased/records?app_npub=...&base_url=...&collection=...&since=...&limit=...&cursor=...
      if (segments.length === 3 && segments[2] === "records" && method === "GET") {
        return await handleFetchRecords(deps, url);
      }

      // POST /api/superbased/sync
      if (segments.length === 3 && segments[2] === "sync" && method === "POST") {
        return await handleSyncRecords(deps, request);
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
 *
 * Proxy to the SuperBased health endpoint.
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
    const cursor = Array.isArray(data) ? null : (data.cursor ?? null);

    // Decrypt each record's delegate_payload
    const decryptedRecords = rawRecords.map((record: Record<string, unknown>) => {
      const delegatePayload = record.delegate_payload as string | undefined;
      const ownerPubkey = record.owner_pubkey as string | undefined;
      const metadata = record.metadata as Record<string, unknown> | undefined;
      // Use encrypted_from if available (delegate-written records),
      // otherwise fall back to owner pubkey (owner-written records)
      const senderPubkey = (metadata?.encrypted_from as string) || ownerPubkey;

      if (!delegatePayload || !senderPubkey) {
        return { ...record, decrypted_payload: null, decrypt_error: "Missing delegate_payload or sender pubkey" };
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
      cursor,
    });
  } catch (err) {
    console.warn(`[superbased-api] Fetch records failed: ${(err as Error).message}`);
    return jsonError(`Fetch records failed: ${(err as Error).message}`, 502);
  }
}

/**
 * POST /api/superbased/sync
 *
 * Encrypt payloads to owner + delegates, then POST to the upstream sync endpoint.
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

  const records = body.records as Array<Record<string, unknown>> | undefined;
  if (!records || !Array.isArray(records) || records.length === 0) {
    return jsonError("records array is required and must be non-empty", 400);
  }

  const identity = getKeyTeleportIdentity();
  if (!identity) {
    return jsonError("Wingman server key not configured (KEYTELEPORT_PRIVKEY)", 500);
  }

  // Encrypt each record's plaintext_payload to owner + delegates
  const encryptedRecords = records.map((record, index) => {
    const plaintext = record.plaintext_payload as string | undefined;
    const ownerPubkey = record.owner_pubkey as string | undefined;
    const delegatePubkeys = record.delegate_pubkeys as string[] | undefined;

    if (!plaintext) {
      throw new Error(`Record ${index}: plaintext_payload is required`);
    }
    if (!ownerPubkey) {
      throw new Error(`Record ${index}: owner_pubkey is required`);
    }

    // Validate record_id format: must be todo_{hex} for app compatibility
    const recordId = (record.record_id ?? record.id) as string | undefined;
    if (recordId) {
      const hexMatch = recordId.match(/^todo_([a-f0-9]+)$/i);
      if (!hexMatch) {
        throw new Error(
          `Record ${index}: record_id "${recordId}" is invalid. ` +
          `Must be "todo_{hex}" (e.g. "todo_a1b2c3d4e5f67890"). ` +
          `Non-hex characters are not allowed.`,
        );
      }
    }

    // Collect all recipients: owner + delegates (including Wingman itself)
    const allRecipients = new Set<string>();
    allRecipients.add(ownerPubkey);
    allRecipients.add(identity.pubkey); // Wingman's own key for future reads
    if (delegatePubkeys) {
      for (const dp of delegatePubkeys) {
        allRecipients.add(dp);
      }
    }

    const encryptedPayloads = encryptToMultipleRecipients(
      plaintext,
      identity.secretKey,
      Array.from(allRecipients),
    );

    // Split: owner's copy → encrypted_data (string),
    //        delegate copies → delegate_payloads (map)
    const ownerCiphertext = encryptedPayloads[ownerPubkey];
    const delegatePayloads: Record<string, string> = {};
    for (const [pubkey, ciphertext] of Object.entries(encryptedPayloads)) {
      if (pubkey !== ownerPubkey) {
        delegatePayloads[pubkey] = ciphertext;
      }
    }

    // Build the record for the upstream API
    const { plaintext_payload, delegate_pubkeys: _dp, id, ...rest } = record;
    const existingMetadata = (rest.metadata as Record<string, unknown>) ?? {};

    // Derive local_id from record_id (the hex portion after "todo_")
    const finalRecordId = ((record as Record<string, unknown>).record_id ?? id) as string;
    const localIdMatch = finalRecordId?.match(/^todo_([a-f0-9]+)$/i);
    const localId = localIdMatch?.[1] || (existingMetadata.local_id as string) || undefined;

    // Derive owner npub from hex pubkey
    const ownerNpub = nip19.npubEncode(ownerPubkey);

    // Extract updated_at from payload for metadata (used by app sync logic)
    let payloadUpdatedAt = existingMetadata.updated_at as string | undefined;
    if (!payloadUpdatedAt) {
      try {
        const parsed = JSON.parse(plaintext as string);
        payloadUpdatedAt = parsed.updated_at || parsed.created_at;
      } catch { /* ignore parse errors */ }
    }

    return {
      ...rest,
      record_id: finalRecordId,
      encrypted_data: ownerCiphertext,
      delegate_payloads: delegatePayloads,
      owner_pubkey: ownerPubkey,
      metadata: {
        ...existingMetadata,
        // Always enforced by Wingman — agents don't need to provide these
        encrypted_from: identity.pubkey,
        read_delegates: Array.from(allRecipients).filter(k => k !== ownerPubkey),
        write_delegates: Array.from(allRecipients).filter(k => k !== ownerPubkey),
        schema_version: 1,
        // Derived from record_id and owner_pubkey — never rely on agent input
        ...(localId ? { local_id: localId } : {}),
        owner: ownerNpub,
        // Sensible defaults for fields agents shouldn't need to set
        device_id: (existingMetadata.device_id as string) || "wingman",
        ...(payloadUpdatedAt ? { updated_at: payloadUpdatedAt } : {}),
      },
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

    const result = await response.json();

    console.log(
      `[superbased-api] Synced ${encryptedRecords.length} records to ${appNpub}`,
    );

    return Response.json({
      synced: encryptedRecords.length,
      result,
    });
  } catch (err) {
    console.warn(`[superbased-api] Sync records failed: ${(err as Error).message}`);
    return jsonError(`Sync records failed: ${(err as Error).message}`, 502);
  }
}
