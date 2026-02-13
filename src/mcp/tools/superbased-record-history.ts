/**
 * MCP Tool: superbased_record_history
 *
 * Fetch version history for a specific record from SuperBased.
 * Returns the version chain: version number, state, encrypted_from, created_at.
 * Useful for debugging sync issues and auditing record changes.
 */

import { z } from "zod";
import { wingmanIdentityPreamble } from "./nip44-utils";

export const superbasedRecordHistorySchema = {
  app_npub: z
    .string()
    .describe("The app's npub identifier for the SuperBased collection"),
  record_id: z
    .string()
    .describe("UUID of the record to fetch history for"),
  include_data: z
    .boolean()
    .optional()
    .describe("Include and decrypt payload data for each version (default: false)"),
  base_url: z
    .string()
    .optional()
    .describe("SuperBased API base URL. Uses SUPERBASED_URL env var if omitted."),
};

export const superbasedRecordHistoryDescription =
  "Fetch version history for a specific record from a SuperBased / Flux Adaptor API. " +
  "Returns the version chain showing version number, record_state, encrypted_from, and created_at " +
  "for each version. Set include_data=true to also decrypt and return payload content. " +
  "Useful for debugging sync issues and auditing record changes.";

interface SuperbasedRecordHistoryParams {
  app_npub: string;
  record_id: string;
  include_data?: boolean;
  base_url?: string;
}

export async function handleSuperbasedRecordHistory(
  params: SuperbasedRecordHistoryParams,
  wingmanUrl: string,
  _sessionId: string,
) {
  try {
    const query = new URLSearchParams();
    query.set("app_npub", params.app_npub);
    query.set("record_id", params.record_id);
    if (params.include_data) query.set("include_data", "true");
    if (params.base_url) query.set("base_url", params.base_url);

    const url = `${wingmanUrl}/api/superbased/history?${query.toString()}`;
    const response = await fetch(url);

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Record history failed (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = await response.json() as {
      record_id: string;
      owner_pubkey: string;
      versions: Array<{
        version: number;
        record_state: string;
        encrypted_from: string;
        created_at: string;
        decrypted_payload?: string;
        decrypt_error?: string;
      }>;
    };

    if (!result.versions || result.versions.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No history found for record ${params.record_id}.`,
          },
        ],
      };
    }

    const preamble = wingmanIdentityPreamble();
    const lines = [
      preamble + `Record: ${result.record_id}`,
      `Owner: ${result.owner_pubkey}`,
      `Versions: ${result.versions.length}`,
      "",
    ];

    for (const ver of result.versions) {
      lines.push(`  v${ver.version}  ${ver.record_state}  ${ver.created_at}  from:${ver.encrypted_from?.slice(0, 12)}...`);
      if (ver.decrypted_payload) {
        lines.push(`    payload: ${ver.decrypted_payload.slice(0, 200)}${ver.decrypted_payload.length > 200 ? "..." : ""}`);
      }
      if (ver.decrypt_error) {
        lines.push(`    decrypt_error: ${ver.decrypt_error}`);
      }
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
