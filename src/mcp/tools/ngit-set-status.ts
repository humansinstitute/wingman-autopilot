/**
 * MCP Tool: ngit_set_status
 *
 * Sets the status of a patch, PR, or issue on Nostr (NIP-34 kind 1630-1633).
 * Only the original author or a repo maintainer can meaningfully set status.
 */

import { z } from "zod";

export const ngitSetStatusSchema = {
  target_event_id: z
    .string()
    .describe("Event ID of the target patch, PR, or issue (the root event)"),
  status: z
    .enum(["open", "applied", "closed", "draft"])
    .describe("Status to set: 'open' (1630), 'applied' / merged / resolved (1631), 'closed' (1632), 'draft' (1633)"),
  content: z
    .string()
    .optional()
    .describe("Optional markdown comment explaining the status change"),
  repo_reference: z
    .string()
    .optional()
    .describe("Repository reference (recommended, format: '30617:<pubkey>:<identifier>')"),
  earliest_unique_commit: z
    .string()
    .optional()
    .describe("Earliest unique commit SHA (recommended)"),
  repo_owner_pubkey: z
    .string()
    .optional()
    .describe("Hex pubkey of the repository owner"),
  target_author_pubkey: z
    .string()
    .optional()
    .describe("Hex pubkey of the target event's author"),
  accepted_revision_id: z
    .string()
    .optional()
    .describe("Event ID of an accepted revision root (for 'applied' status)"),
  merge_commit: z
    .string()
    .optional()
    .describe("Merge commit SHA (for 'applied' status on merged patches)"),
  applied_as_commits: z
    .array(z.string())
    .optional()
    .describe("Commit SHAs in the main branch (for 'applied' status on applied patches)"),
  applied_patch_ids: z
    .array(z.object({
      eventId: z.string(),
      relay: z.string().optional(),
      pubkey: z.string().optional(),
    }))
    .optional()
    .describe("Patch event IDs that were applied (for `q` tags)"),
  relays: z
    .array(z.string())
    .optional()
    .describe("Nostr relay URLs. Defaults to Wingman's configured relays."),
};

export const ngitSetStatusDescription =
  "Set the status of a patch, PR, or issue on Nostr (NIP-34 kind 1630-1633). " +
  "Status kinds: open (1630), applied/merged/resolved (1631), closed (1632), draft (1633). " +
  "The most recent status event from the author or a maintainer takes precedence.\n\n" +
  "IMPORTANT: You must first call request_api_access with domain='nostr.git' to get a signing grant.";

interface NgitSetStatusParams {
  target_event_id: string;
  status: string;
  content?: string;
  repo_reference?: string;
  earliest_unique_commit?: string;
  repo_owner_pubkey?: string;
  target_author_pubkey?: string;
  accepted_revision_id?: string;
  merge_commit?: string;
  applied_as_commits?: string[];
  applied_patch_ids?: Array<{ eventId: string; relay?: string; pubkey?: string }>;
  relays?: string[];
}

export async function handleNgitSetStatus(
  params: NgitSetStatusParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const response = await fetch(`${wingmanUrl}/api/ngit/set-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, ...params }),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Failed to set status (${response.status}): ${error}` }],
      };
    }

    const result = await response.json();
    return {
      content: [{
        type: "text" as const,
        text: [
          `Status set to "${result.status}" on event ${result.targetEventId.slice(0, 16)}…`,
          `Status Event ID: ${result.eventId}`,
          `Kind: ${result.kind}`,
          `Relays: ${result.successes} succeeded, ${result.failures} failed`,
        ].join("\n"),
      }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to reach Wingman server: ${(err as Error).message}` }],
    };
  }
}
