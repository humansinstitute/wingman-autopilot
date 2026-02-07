/**
 * MCP Tool: manage_app
 *
 * Start, stop, restart, build, or setup an app by ID.
 */

import { z } from "zod";

export const manageAppSchema = {
  app_id: z.string().describe("The app ID to manage"),
  action: z
    .enum(["start", "stop", "restart", "build", "setup"])
    .describe("Lifecycle action to perform on the app"),
};

export const manageAppDescription =
  "Start, stop, restart, build, or setup a registered app by its ID. " +
  "Use list_apps first to see available apps and their current status.";

interface ManageAppParams {
  app_id: string;
  action: string;
}

export async function handleManageApp(
  params: ManageAppParams,
  wingmanUrl: string,
  sessionId: string,
) {
  const { app_id, action } = params;

  try {
    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/apps/action`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          appId: app_id,
          action,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `App action failed (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = await response.json();
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `App "${app_id}" — ${action} completed`,
            `Status: ${result.status}`,
            `Running: ${result.running}`,
            result.message ? `Message: ${result.message}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
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
