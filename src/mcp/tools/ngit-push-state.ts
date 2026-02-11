/**
 * MCP Tool: ngit_push_state
 *
 * Pushes repository branch/tag state to Nostr (NIP-34 kind 30618).
 * Signs the event using the logged-in user's identity via Tier 2 browser
 * delegation, then publishes to Nostr relays.
 *
 * Requires an active grant for domain "nostr.git" — call request_api_access first.
 */

import { z } from "zod";

export const ngitPushStateSchema = {
  identifier: z
    .string()
    .describe("Repository identifier — must match the `d` tag of an existing repository announcement"),
  refs: z
    .record(z.string(), z.string())
    .describe("Branch/tag name → commit SHA mapping. E.g. { 'refs/heads/main': 'abc123...', 'refs/heads/dev': 'def456...' }"),
  head: z
    .string()
    .optional()
    .describe("Default branch name (e.g. 'main'). Included as the HEAD reference."),
  relays: z
    .array(z.string())
    .optional()
    .describe("Nostr relay URLs to publish to. Defaults to Wingman's configured relays if omitted."),
};

export const ngitPushStateDescription =
  "Push repository branch and tag state to Nostr (NIP-34 kind 30618). " +
  "This updates the repository's ref state visible on gitworkshop.dev and other NIP-34 clients. " +
  "The event is signed with the logged-in user's Nostr identity via browser delegation.\n\n" +
  "IMPORTANT: You must first call request_api_access with domain='nostr.git' to get a signing grant. " +
  "The identifier must match an existing repository announcement (kind 30617).";

interface NgitPushStateParams {
  identifier: string;
  refs: Record<string, string>;
  head?: string;
  relays?: string[];
}

export async function handleNgitPushState(
  params: NgitPushStateParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const response = await fetch(`${wingmanUrl}/api/ngit/push-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        identifier: params.identifier,
        refs: params.refs,
        head: params.head,
        relays: params.relays,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to push state (${response.status}): ${error}`,
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
            `Repository state for "${params.identifier}" pushed to Nostr`,
            "",
            `Event ID: ${result.eventId}`,
            `Refs updated: ${result.refsCount}`,
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
