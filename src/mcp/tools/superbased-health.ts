/**
 * MCP Tool: superbased_health
 *
 * Check the health of a SuperBased / Flux Adaptor API instance.
 * Proxies through the Wingman server for NIP-98 authentication.
 */

import { z } from "zod";

export const superbasedHealthSchema = {
  base_url: z
    .string()
    .optional()
    .describe("SuperBased API base URL. Uses SUPERBASED_URL env var if omitted."),
};

export const superbasedHealthDescription =
  "Check whether a SuperBased / Flux Adaptor API is reachable and healthy. " +
  "Authenticates via NIP-98 using the Wingman server identity. " +
  "Uses the SUPERBASED_URL default if no base_url is provided.";

interface SuperbasedHealthParams {
  base_url?: string;
}

export async function handleSuperbasedHealth(
  params: SuperbasedHealthParams,
  wingmanUrl: string,
  _sessionId: string,
) {
  try {
    const query = new URLSearchParams();
    if (params.base_url) {
      query.set("base_url", params.base_url);
    }

    const qs = query.toString();
    const url = `${wingmanUrl}/api/superbased/health${qs ? `?${qs}` : ""}`;
    const response = await fetch(url);

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Health check failed (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = await response.json();

    return {
      content: [
        {
          type: "text" as const,
          text: `SuperBased API is healthy.\n\n${JSON.stringify(result.data, null, 2)}`,
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
