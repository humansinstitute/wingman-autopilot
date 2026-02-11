/**
 * MCP Tool: ngit_create_issue
 *
 * Creates an issue on a Nostr repository (NIP-34 kind 1621).
 * Issues are markdown text: bug reports, feature requests, questions.
 */

import { z } from "zod";

export const ngitCreateIssueSchema = {
  repo_reference: z
    .string()
    .describe("Repository reference in format '30617:<owner-pubkey-hex>:<identifier>'"),
  repo_owner_pubkey: z
    .string()
    .describe("Hex pubkey of the repository owner"),
  content: z
    .string()
    .describe("Markdown content of the issue"),
  subject: z
    .string()
    .optional()
    .describe("Issue title / subject"),
  labels: z
    .array(z.string())
    .optional()
    .describe("Labels for the issue (e.g. 'bug', 'enhancement', 'question')"),
  relays: z
    .array(z.string())
    .optional()
    .describe("Nostr relay URLs. Defaults to Wingman's configured relays."),
};

export const ngitCreateIssueDescription =
  "Create an issue on a Nostr repository (NIP-34 kind 1621). " +
  "Issues are markdown text for bug reports, feature requests, or questions. " +
  "Appears on gitworkshop.dev and other NIP-34 clients.\n\n" +
  "IMPORTANT: You must first call request_api_access with domain='nostr.git' to get a signing grant.";

interface NgitCreateIssueParams {
  repo_reference: string;
  repo_owner_pubkey: string;
  content: string;
  subject?: string;
  labels?: string[];
  relays?: string[];
}

export async function handleNgitCreateIssue(
  params: NgitCreateIssueParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const response = await fetch(`${wingmanUrl}/api/ngit/create-issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, ...params }),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Failed to create issue (${response.status}): ${error}` }],
      };
    }

    const result = await response.json();
    return {
      content: [{
        type: "text" as const,
        text: [
          `Issue "${result.subject}" created on Nostr`,
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
