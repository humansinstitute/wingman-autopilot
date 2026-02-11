/**
 * MCP Tool: ngit_publish_repo
 *
 * Publishes a git repository announcement to Nostr (NIP-34 kind 30617).
 * Signs the event using the logged-in user's identity via Tier 2 browser
 * delegation, then publishes to Nostr relays.
 *
 * Requires an active grant for domain "nostr.git" — call request_api_access first.
 */

import { z } from "zod";

export const ngitPublishRepoSchema = {
  identifier: z
    .string()
    .describe("Repository identifier (kebab-case, e.g. 'my-project'). Used as the Nostr `d` tag — must be unique per user."),
  name: z
    .string()
    .optional()
    .describe("Human-readable project name"),
  description: z
    .string()
    .optional()
    .describe("Short description of the repository"),
  clone_urls: z
    .array(z.string())
    .optional()
    .describe("Git clone URLs (https, ssh). E.g. ['https://github.com/user/repo.git']"),
  web_urls: z
    .array(z.string())
    .optional()
    .describe("Web URLs for browsing the repository. E.g. ['https://github.com/user/repo']"),
  relays: z
    .array(z.string())
    .optional()
    .describe("Nostr relay URLs for patches and issues. Defaults to Wingman's configured relays if omitted."),
  maintainers: z
    .array(z.string())
    .optional()
    .describe("Additional maintainer pubkeys (hex). The signing user is always the primary maintainer."),
  hashtags: z
    .array(z.string())
    .optional()
    .describe("Topics/hashtags for discoverability (e.g. ['rust', 'nostr', 'bitcoin'])"),
  earliest_unique_commit: z
    .string()
    .optional()
    .describe("SHA of the earliest unique commit — used to identify the repo among forks"),
};

export const ngitPublishRepoDescription =
  "Publish a git repository announcement to Nostr (NIP-34 kind 30617). " +
  "This makes the repository discoverable on gitworkshop.dev and other NIP-34 clients. " +
  "The event is signed with the logged-in user's Nostr identity via browser delegation.\n\n" +
  "IMPORTANT: You must first call request_api_access with domain='nostr.git' to get a signing grant. " +
  "The user must have an active browser session for Tier 2 signing.";

interface NgitPublishRepoParams {
  identifier: string;
  name?: string;
  description?: string;
  clone_urls?: string[];
  web_urls?: string[];
  relays?: string[];
  maintainers?: string[];
  hashtags?: string[];
  earliest_unique_commit?: string;
}

export async function handleNgitPublishRepo(
  params: NgitPublishRepoParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const response = await fetch(`${wingmanUrl}/api/ngit/publish-repo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        identifier: params.identifier,
        name: params.name,
        description: params.description,
        clone_urls: params.clone_urls,
        web_urls: params.web_urls,
        relays: params.relays,
        maintainers: params.maintainers,
        hashtags: params.hashtags,
        earliest_unique_commit: params.earliest_unique_commit,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to publish repository (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = await response.json();
    const relayStatus = result.relays
      ?.map((r: { relay: string; ok: boolean; error?: string }) =>
        `  ${r.ok ? "✓" : "✗"} ${r.relay}${r.error ? ` (${r.error})` : ""}`,
      )
      .join("\n") ?? "  No relay results";

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Repository "${params.name ?? params.identifier}" published to Nostr`,
            "",
            `Event ID: ${result.eventId}`,
            `Identifier: ${result.identifier}`,
            `Kind: ${result.kind}`,
            `Relays: ${result.successes} succeeded, ${result.failures} failed`,
            relayStatus,
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
