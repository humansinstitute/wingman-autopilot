/**
 * MCP Tool: nostr_publish_event
 *
 * Sign a Nostr event with the user's bot key and publish it to relays.
 * Combines signing (via bot-crypto API) and relay publishing in one step.
 */

import { z } from "zod";

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];

export const nostrPublishEventSchema = {
  kind: z
    .number()
    .int()
    .min(0)
    .describe("Nostr event kind number (e.g. 1 for short text note)"),
  content: z
    .string()
    .describe("Event content string"),
  tags: z
    .array(z.array(z.string()))
    .describe("Event tags — array of string arrays (e.g. [[\"p\", \"<pubkey>\"], [\"e\", \"<id>\"]])"),
  created_at: z
    .number()
    .int()
    .optional()
    .describe("Unix timestamp in seconds. Defaults to current time if omitted."),
  relays: z
    .array(z.string())
    .optional()
    .describe("Relay URLs to publish to. Defaults to popular public relays if omitted."),
};

export const nostrPublishEventDescription =
  "Sign a Nostr event with the user's bot key and publish it to relays. " +
  "Returns the signed event plus per-relay publish results. " +
  "If no relays are specified, publishes to default public relays.";

interface NostrPublishEventParams {
  kind: number;
  content: string;
  tags: string[][];
  created_at?: number;
  relays?: string[];
}

export async function handleNostrPublishEvent(
  params: NostrPublishEventParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const relays = params.relays && params.relays.length > 0
      ? params.relays
      : DEFAULT_RELAYS;

    const response = await fetch(`${wingmanUrl}/api/mcp/bot-crypto/publish-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        event: {
          kind: params.kind,
          content: params.content,
          tags: params.tags,
          created_at: params.created_at,
        },
        relays,
      }),
    });

    if (!response.ok) {
      const err = await response.json() as { error?: string };
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to publish event: ${err.error ?? response.statusText}`,
          },
        ],
      };
    }

    const data = await response.json() as {
      event: Record<string, unknown>;
      signerPubkey: string;
      publish: {
        successes: number;
        failures: number;
        results: { relay: string; ok: boolean; error?: string }[];
      };
    };

    const relayLines = data.publish.results.map(
      (r) => `  ${r.ok ? "OK" : "FAIL"} ${r.relay}${r.error ? ` — ${r.error}` : ""}`,
    );

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Signed by: ${data.signerPubkey} (bot key)`,
            `Event ID: ${data.event.id}`,
            `Kind: ${data.event.kind}`,
            `Published: ${data.publish.successes}/${data.publish.results.length} relays`,
            "",
            "Relay results:",
            ...relayLines,
            "",
            JSON.stringify(data.event, null, 2),
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
          text: `Nostr event publish failed: ${(err as Error).message}`,
        },
      ],
    };
  }
}
