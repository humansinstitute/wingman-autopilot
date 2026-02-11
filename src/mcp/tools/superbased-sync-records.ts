/**
 * MCP Tool: superbased_sync_records
 *
 * Sync records to a SuperBased / Flux Adaptor API. Plaintext payloads
 * are encrypted server-side to owner + all delegates before upload.
 */

import { z } from "zod";

export const superbasedSyncRecordsSchema = {
  app_npub: z
    .string()
    .describe("The app's npub identifier for the SuperBased collection"),
  records: z
    .array(
      z.object({
        plaintext_payload: z.string().describe("The plaintext content to encrypt and sync"),
        owner_pubkey: z.string().describe("Record owner's public key (64-char hex)"),
        delegate_pubkeys: z
          .array(z.string())
          .optional()
          .describe("Additional delegate public keys (Wingman is always included)"),
        id: z.string().optional().describe("Record ID for updates (omit for new records)"),
        collection: z.string().optional().describe("Collection name"),
        metadata: z.record(z.unknown()).optional().describe("Arbitrary metadata to store alongside the record"),
      }),
    )
    .describe("Array of records to encrypt and sync"),
  base_url: z
    .string()
    .optional()
    .describe("SuperBased API base URL. Uses SUPERBASED_URL env var if omitted."),
};

export const superbasedSyncRecordsDescription =
  "Encrypt and sync records to a SuperBased / Flux Adaptor API. " +
  "Each record's plaintext_payload is encrypted to the owner, all specified delegates, " +
  "and Wingman itself (so it can read the records back later). " +
  "Authentication uses Wingman's NIP-98 identity. " +
  "Returns the sync result from the upstream API.";

interface SyncRecord {
  plaintext_payload: string;
  owner_pubkey: string;
  delegate_pubkeys?: string[];
  id?: string;
  collection?: string;
  metadata?: Record<string, unknown>;
}

interface SuperbasedSyncRecordsParams {
  app_npub: string;
  records: SyncRecord[];
  base_url?: string;
}

export async function handleSuperbasedSyncRecords(
  params: SuperbasedSyncRecordsParams,
  wingmanUrl: string,
  _sessionId: string,
) {
  try {
    const response = await fetch(`${wingmanUrl}/api/superbased/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_npub: params.app_npub,
        records: params.records,
        base_url: params.base_url,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Sync records failed (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = await response.json();

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Successfully synced ${result.synced} records.`,
            "",
            JSON.stringify(result.result, null, 2),
          ].join("\n"),
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
