/**
 * MCP Tool: superbased_fetch_records (v3)
 *
 * Fetch records delegated to Wingman from a SuperBased / Flux Adaptor API.
 * Records are auto-decrypted server-side before being returned.
 * v3: Includes version numbers and uses top-level encrypted_from.
 */

import { z } from "zod";
import { wingmanIdentityPreamble } from "./nip44-utils";

export const superbasedFetchRecordsSchema = {
  app_npub: z
    .string()
    .describe("The app's npub identifier for the SuperBased collection"),
  owner_pubkey: z
    .string()
    .describe("Hex pubkey of the record owner to fetch records for. Records are scoped to this owner only."),
  collection: z
    .string()
    .optional()
    .describe("Filter by collection name"),
  since: z
    .string()
    .optional()
    .describe("ISO timestamp — only return records modified after this time"),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of records to return"),
  cursor: z
    .string()
    .optional()
    .describe("Pagination cursor from a previous response"),
  base_url: z
    .string()
    .optional()
    .describe("SuperBased API base URL. Uses SUPERBASED_URL env var if omitted."),
};

export const superbasedFetchRecordsDescription =
  "Fetch encrypted records where Wingman is a delegate from a SuperBased / Flux Adaptor API. " +
  "Records are scoped to the specified owner_pubkey (the end-user's pubkey, NOT Wingman's). " +
  "Records are automatically decrypted using Wingman's NIP-44 key. " +
  "Each record includes a `decrypted_payload` field (or `decrypt_error` if decryption failed). " +
  "Records include `version` numbers and `record_id` (UUID) for sync tracking. " +
  "Supports filtering by collection, time range, and pagination.";

interface SuperbasedFetchRecordsParams {
  app_npub: string;
  owner_pubkey: string;
  collection?: string;
  since?: string;
  limit?: number;
  cursor?: string;
  base_url?: string;
}

export async function handleSuperbasedFetchRecords(
  params: SuperbasedFetchRecordsParams,
  wingmanUrl: string,
  _sessionId: string,
) {
  try {
    const query = new URLSearchParams();
    query.set("app_npub", params.app_npub);
    query.set("owner_pubkey", params.owner_pubkey);
    if (params.collection) query.set("collection", params.collection);
    if (params.since) query.set("since", params.since);
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.cursor) query.set("cursor", params.cursor);
    if (params.base_url) query.set("base_url", params.base_url);

    const url = `${wingmanUrl}/api/superbased/records?${query.toString()}`;
    const response = await fetch(url);

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Fetch records failed (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = await response.json() as {
      records: Record<string, unknown>[];
      count: number;
      cursor: string | null;
    };

    const preamble = wingmanIdentityPreamble();

    if (result.count === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: preamble + "No delegated records found.",
          },
        ],
      };
    }

    // Format records for display
    const decrypted = result.records.filter(
      (r: Record<string, unknown>) => r.decrypted_payload !== null,
    ).length;
    const failed = result.count - decrypted;

    const summary = [
      `Found ${result.count} records (${decrypted} decrypted, ${failed} failed).`,
      result.cursor ? `Cursor for next page: ${result.cursor}` : null,
    ].filter(Boolean).join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: preamble + summary + "\n\n" + JSON.stringify(result.records, null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to reach Wingman server: ${(err as Error).message}`,
        },
      ],
    };
  }
}
