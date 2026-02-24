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
  namespace_mode: z
    .string()
    .optional()
    .describe('Namespace mode. App-less only; use "default" (or omit).'),
  app_npub: z
    .string()
    .optional()
    .describe("Legacy metadata only in app-less mode. Ignored for routing."),
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
  'Uses app-less SuperBased routes (namespace_mode="default"). ' +
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
  namespace_mode?: string;
  app_npub?: string;
  owner_pubkey: string;
  records: SyncRecord[];
  base_url?: string;
}

export async function handleSuperbasedSyncRecords(
  params: SuperbasedSyncRecordsParams,
  wingmanUrl: string,
  _sessionId: string,
) {
  const namespaceMode = (params.namespace_mode ?? "default").trim().toLowerCase();
  if (!["default", "appless", "app-less"].includes(namespaceMode)) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: "This tool is app-less only. Use namespace_mode=\"default\".",
        },
      ],
    };
  }

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
        namespace_mode: "default",
        owner_pubkey: params.owner_pubkey,
        records: params.records,
        base_url: params.base_url,
        // Pass user identity so server uses bot key for signing/encryption
        user_npub: process.env.USER_NPUB || undefined,
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
