/**
 * MCP Tool: ngit_list_proposals
 *
 * Queries Nostr relays for patches (1617), PRs (1618), and issues (1621)
 * on a repository. Read-only — does not require a signing grant.
 */

import { z } from "zod";

export const ngitListProposalsSchema = {
  repo_reference: z
    .string()
    .describe("Repository reference in format '30617:<owner-pubkey-hex>:<identifier>'"),
  kinds: z
    .array(z.number())
    .optional()
    .describe("Event kinds to query. Defaults to [1617, 1618, 1621] (patches, PRs, issues). Use [1617] for patches only, etc."),
  relays: z
    .array(z.string())
    .optional()
    .describe("Nostr relay URLs to query. Defaults to Wingman's configured relays."),
};

export const ngitListProposalsDescription =
  "List patches, pull requests, and issues for a Nostr repository (NIP-34). " +
  "Queries relays for kind 1617 (patches), 1618 (PRs), and 1621 (issues) " +
  "tagged with the given repository reference. " +
  "Does NOT require a signing grant — this is a read-only operation.";

interface NgitListProposalsParams {
  repo_reference: string;
  kinds?: number[];
  relays?: string[];
}

export async function handleNgitListProposals(
  params: NgitListProposalsParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const query = new URLSearchParams({ sessionId, repo_reference: params.repo_reference });
    if (params.kinds && params.kinds.length > 0) {
      query.set("kinds", params.kinds.join(","));
    }
    if (params.relays && params.relays.length > 0) {
      query.set("relays", params.relays.join(","));
    }

    const response = await fetch(`${wingmanUrl}/api/ngit/proposals?${query.toString()}`);

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Failed to list proposals (${response.status}): ${error}` }],
      };
    }

    const result = await response.json();

    if (result.count === 0) {
      return {
        content: [{ type: "text" as const, text: "No proposals found on the queried relays." }],
      };
    }

    const proposalList = result.proposals
      .map(
        (p: {
          eventId: string;
          type: string;
          subject?: string;
          content: string;
          pubkey: string;
          createdAt: number;
          commitId?: string;
          branchName?: string;
          labels: string[];
          isRoot: boolean;
        }) => {
          const lines = [
            `## [${p.type.toUpperCase()}] ${p.subject ?? "(no subject)"}`,
            `  Author: ${p.pubkey.slice(0, 16)}…`,
            `  Created: ${new Date(p.createdAt * 1000).toISOString()}`,
            p.commitId ? `  Commit: ${p.commitId.slice(0, 12)}…` : null,
            p.branchName ? `  Branch: ${p.branchName}` : null,
            p.labels.length > 0 ? `  Labels: ${p.labels.join(", ")}` : null,
            p.isRoot ? `  Root: yes` : null,
            `  Event ID: ${p.eventId}`,
            p.content ? `  Preview: ${p.content.slice(0, 200)}` : null,
          ];
          return lines.filter(Boolean).join("\n");
        },
      )
      .join("\n\n");

    return {
      content: [{
        type: "text" as const,
        text: `Found ${result.count} proposals:\n\n${proposalList}`,
      }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to reach Wingman server: ${(err as Error).message}` }],
    };
  }
}
