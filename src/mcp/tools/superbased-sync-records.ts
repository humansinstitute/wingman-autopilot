/**
 * MCP Tool: superbased_sync_records (v3)
 *
 * Minimal agent interface for syncing records to SuperBased.
 * Agent provides plaintext + owner — system handles UUID generation,
 * encryption, and v3 formatting.
 */

import { z } from "zod";
import { wingmanIdentityPreamble } from "./nip44-utils";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const superbasedSyncRecordsSchema = {
  app_npub: z
    .string()
    .describe("The app's npub identifier for the SuperBased collection"),
  owner_pubkey: z
    .string()
    .describe("Record owner's public key (64-char hex). Applies to all records in this batch."),
  records: z
    .array(
      z.object({
        plaintext_payload: z
          .string()
          .describe("Free text content to encrypt and sync"),
        record_id: z
          .string()
          .optional()
          .describe("UUID for updates. Omit to auto-generate a new UUID for new records."),
        collection: z
          .string()
          .optional()
          .describe("Collection name (default: 'default')"),
        delegate_pubkeys: z
          .array(z.string())
          .optional()
          .describe("Extra delegate pubkeys to encrypt for (optional)"),
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
  "Each record's plaintext_payload is encrypted to the owner and any specified delegates. " +
  "IMPORTANT: owner_pubkey must be the end-user's pubkey, NOT Wingman's. " +
  "Include Wingman's pubkey in delegate_pubkeys so Wingman can later fetch and decrypt the records. " +
  "Use get_wingman_identity to find Wingman's pubkey if you don't know it. " +
  "Record IDs are auto-generated UUIDs when omitted, or provide an existing UUID for updates. " +
  "Returns the record_id and version for each synced record.";

interface SyncRecord {
  plaintext_payload: string;
  record_id?: string;
  collection?: string;
  delegate_pubkeys?: string[];
}

interface SuperbasedSyncRecordsParams {
  app_npub: string;
  owner_pubkey: string;
  records: SyncRecord[];
  base_url?: string;
}

export async function handleSuperbasedSyncRecords(
  params: SuperbasedSyncRecordsParams,
  wingmanUrl: string,
  _sessionId: string,
) {
  // Validate record_ids are UUIDs when provided
  for (let i = 0; i < params.records.length; i++) {
    const rid = params.records[i].record_id;
    if (rid && !UUID_RE.test(rid)) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Record ${i}: record_id "${rid}" is not a valid UUID. ` +
              `Use UUID format (e.g. "550e8400-e29b-41d4-a716-446655440000") or omit to auto-generate.`,
          },
        ],
      };
    }
  }

  try {
    const response = await fetch(`${wingmanUrl}/api/superbased/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_npub: params.app_npub,
        owner_pubkey: params.owner_pubkey,
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

    const result = await response.json() as {
      synced: Array<{ record_id: string; version: number }>;
      created: number;
      updated: number;
      rejected: unknown[];
    };

    const preamble = wingmanIdentityPreamble();
    const lines = [
      preamble + `Synced ${result.synced.length} records (${result.created} created, ${result.updated} updated).`,
    ];
    if (result.rejected.length > 0) {
      lines.push(`Rejected: ${JSON.stringify(result.rejected)}`);
    }
    lines.push("");
    for (const r of result.synced) {
      lines.push(`  ${r.record_id}  v${r.version}`);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: lines.join("\n"),
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
