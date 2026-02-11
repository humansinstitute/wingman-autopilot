/**
 * MCP Tool: ngit_create_pr
 *
 * Creates a pull request on a Nostr repository (NIP-34 kind 1618).
 * The PR branch must be pushed to an accessible clone URL first.
 */

import { z } from "zod";

export const ngitCreatePrSchema = {
  repo_reference: z
    .string()
    .describe("Repository reference in format '30617:<owner-pubkey-hex>:<identifier>'"),
  earliest_unique_commit: z
    .string()
    .describe("SHA of the earliest unique commit in the repository"),
  repo_owner_pubkey: z
    .string()
    .describe("Hex pubkey of the repository owner"),
  subject: z
    .string()
    .describe("PR title / subject"),
  description: z
    .string()
    .optional()
    .describe("Markdown description of the pull request"),
  commit_id: z
    .string()
    .describe("Branch tip commit SHA"),
  clone_urls: z
    .array(z.string())
    .describe("Git clone URLs where the branch can be fetched"),
  branch_name: z
    .string()
    .optional()
    .describe("Branch name (e.g. 'feature/my-feature')"),
  merge_base: z
    .string()
    .optional()
    .describe("Merge base commit SHA"),
  labels: z
    .array(z.string())
    .optional()
    .describe("Labels / topics for the PR"),
  replaces_patch_id: z
    .string()
    .optional()
    .describe("Event ID of a root patch this PR replaces"),
  recipients: z
    .array(z.string())
    .optional()
    .describe("Additional recipient pubkeys (hex)"),
  relays: z
    .array(z.string())
    .optional()
    .describe("Nostr relay URLs. Defaults to Wingman's configured relays."),
};

export const ngitCreatePrDescription =
  "Create a pull request on a Nostr repository (NIP-34 kind 1618). " +
  "The PR branch must be pushed to an accessible git server first — " +
  "provide the clone URLs so reviewers can fetch the branch. " +
  "Appears on gitworkshop.dev and other NIP-34 clients.\n\n" +
  "IMPORTANT: You must first call request_api_access with domain='nostr.git' to get a signing grant.";

interface NgitCreatePrParams {
  repo_reference: string;
  earliest_unique_commit: string;
  repo_owner_pubkey: string;
  subject: string;
  description?: string;
  commit_id: string;
  clone_urls: string[];
  branch_name?: string;
  merge_base?: string;
  labels?: string[];
  replaces_patch_id?: string;
  recipients?: string[];
  relays?: string[];
}

export async function handleNgitCreatePr(
  params: NgitCreatePrParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const response = await fetch(`${wingmanUrl}/api/ngit/create-pr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, ...params }),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Failed to create PR (${response.status}): ${error}` }],
      };
    }

    const result = await response.json();
    return {
      content: [{
        type: "text" as const,
        text: [
          `Pull request "${result.subject}" created on Nostr`,
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
