/**
 * MCP Tool: ngit_list_repos
 *
 * Queries Nostr relays for repository announcements (NIP-34 kind 30617)
 * published by the user or a specified pubkey.
 */

import { z } from "zod";

export const ngitListReposSchema = {
  pubkey: z
    .string()
    .optional()
    .describe("Hex pubkey to query repos for. If omitted, uses the logged-in user's pubkey."),
  relays: z
    .array(z.string())
    .optional()
    .describe("Nostr relay URLs to query. Defaults to Wingman's configured relays if omitted."),
};

export const ngitListReposDescription =
  "List git repositories published to Nostr (NIP-34 kind 30617). " +
  "Queries relays for repository announcements by the specified pubkey or the logged-in user. " +
  "Returns repository names, descriptions, clone URLs, and other metadata. " +
  "Does NOT require a signing grant — this is a read-only operation.";

interface NgitListReposParams {
  pubkey?: string;
  relays?: string[];
}

export async function handleNgitListRepos(
  params: NgitListReposParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const query = new URLSearchParams({ sessionId });
    if (params.pubkey) {
      query.set("pubkey", params.pubkey);
    }
    if (params.relays && params.relays.length > 0) {
      query.set("relays", params.relays.join(","));
    }

    const response = await fetch(
      `${wingmanUrl}/api/ngit/repos?${query.toString()}`,
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to list repos (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = await response.json();

    if (result.count === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No repositories found on the queried relays.",
          },
        ],
      };
    }

    const repoList = result.repos
      .map(
        (r: {
          identifier: string;
          name?: string;
          description?: string;
          cloneUrls: string[];
          webUrls: string[];
          hashtags: string[];
          createdAt: number;
          eventId: string;
        }) => {
          const lines = [
            `## ${r.name ?? r.identifier}`,
            r.description ? `  ${r.description}` : null,
            `  Identifier: ${r.identifier}`,
            r.cloneUrls.length > 0 ? `  Clone: ${r.cloneUrls.join(", ")}` : null,
            r.webUrls.length > 0 ? `  Web: ${r.webUrls.join(", ")}` : null,
            r.hashtags.length > 0 ? `  Tags: ${r.hashtags.join(", ")}` : null,
            `  Published: ${new Date(r.createdAt * 1000).toISOString()}`,
            `  Event ID: ${r.eventId}`,
          ];
          return lines.filter(Boolean).join("\n");
        },
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${result.count} repositories:\n\n${repoList}`,
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
