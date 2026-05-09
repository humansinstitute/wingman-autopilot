/**
 * MCP Tool: nostr_sign_event
 *
 * Sign an arbitrary Nostr event using the shared Wingman instance key.
 * Routes through the server's bot-crypto API so the MCP child
 * process never touches the private key directly.
 */

import { z } from "zod";

export const nostrSignEventSchema = {
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
};

export const nostrSignEventDescription =
  "Sign an arbitrary Nostr event with the shared Wingman instance key. " +
  "Returns a fully signed event (with id, pubkey, and sig) ready for relay publishing. " +
  "The signer pubkey is the Wingman instance identity, not the user's key.";

interface NostrSignEventParams {
  kind: number;
  content: string;
  tags: string[][];
  created_at?: number;
}

export async function handleNostrSignEvent(
  params: NostrSignEventParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const response = await fetch(`${wingmanUrl}/api/mcp/bot-crypto/sign-event`, {
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
      }),
    });

    if (!response.ok) {
      const err = await response.json() as { error?: string };
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to sign event: ${err.error ?? response.statusText}`,
          },
        ],
      };
    }

    const data = await response.json() as {
      event: Record<string, unknown>;
      signerPubkey: string;
    };

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Signed by: ${data.signerPubkey} (Wingman instance)`,
            `Event ID: ${data.event.id}`,
            `Kind: ${data.event.kind}`,
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
          text: `Nostr event signing failed: ${(err as Error).message}`,
        },
      ],
    };
  }
}
