/**
 * MCP Tool: ngit_send_patch
 *
 * Sends a git patch to a Nostr repository (NIP-34 kind 1617).
 * The patch content should be the output of `git format-patch`.
 */

import { z } from "zod";

export const ngitSendPatchSchema = {
  repo_reference: z
    .string()
    .describe("Repository reference in format '30617:<owner-pubkey-hex>:<identifier>'"),
  earliest_unique_commit: z
    .string()
    .describe("SHA of the earliest unique commit in the repository"),
  repo_owner_pubkey: z
    .string()
    .describe("Hex pubkey of the repository owner"),
  patch_content: z
    .string()
    .describe("The git format-patch output (must be < 60kb)"),
  is_root: z
    .boolean()
    .optional()
    .describe("True if this is the first (root) patch in a series"),
  is_root_revision: z
    .boolean()
    .optional()
    .describe("True if this is the root of a revision to an earlier proposal"),
  commit_id: z
    .string()
    .optional()
    .describe("Commit SHA this patch represents"),
  parent_commit_id: z
    .string()
    .optional()
    .describe("Parent commit SHA"),
  committer: z
    .object({
      name: z.string(),
      email: z.string(),
      timestamp: z.string(),
      timezone: z.string(),
    })
    .optional()
    .describe("Committer details: name, email, timestamp, timezone offset in minutes"),
  reply_to: z
    .string()
    .optional()
    .describe("Event ID of the previous patch in the series (for NIP-10 threading)"),
  recipients: z
    .array(z.string())
    .optional()
    .describe("Additional recipient pubkeys (hex)"),
  relays: z
    .array(z.string())
    .optional()
    .describe("Nostr relay URLs. Defaults to Wingman's configured relays."),
};

export const ngitSendPatchDescription =
  "Send a git patch to a Nostr repository (NIP-34 kind 1617). " +
  "The patch content should be the output of `git format-patch`. " +
  "For a series of patches, set is_root=true on the first one and use reply_to to chain subsequent patches.\n\n" +
  "IMPORTANT: You must first call request_api_access with domain='nostr.git' to get a signing grant.";

interface NgitSendPatchParams {
  repo_reference: string;
  earliest_unique_commit: string;
  repo_owner_pubkey: string;
  patch_content: string;
  is_root?: boolean;
  is_root_revision?: boolean;
  commit_id?: string;
  parent_commit_id?: string;
  committer?: { name: string; email: string; timestamp: string; timezone: string };
  reply_to?: string;
  recipients?: string[];
  relays?: string[];
}

export async function handleNgitSendPatch(
  params: NgitSendPatchParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const response = await fetch(`${wingmanUrl}/api/ngit/send-patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, ...params }),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Failed to send patch (${response.status}): ${error}` }],
      };
    }

    const result = await response.json();
    return {
      content: [{
        type: "text" as const,
        text: [
          `Patch sent to Nostr`,
          `Event ID: ${result.eventId}`,
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
