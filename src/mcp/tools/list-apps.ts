/**
 * MCP Tool: list_apps
 *
 * Lists all registered Wingman apps with their current status.
 */

import { z } from "zod";

export const listAppsSchema = {};

export const listAppsDescription =
  "List registered apps with status (id, label, running, scripts). " +
  "Use this to see what apps are available to manage.";

export async function handleListApps(
  _params: Record<string, never>,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/apps?sessionId=${encodeURIComponent(sessionId)}`,
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to list apps (${response.status}): ${error}`,
          },
        ],
      };
    }

    const { apps } = await response.json();

    if (!apps || apps.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No apps registered. Register apps via the Wingman UI.",
          },
        ],
      };
    }

    const lines = ["Registered Apps:", ""];
    for (const app of apps) {
      const statusIcon = app.running ? "[running]" : "[stopped]";
      lines.push(`${statusIcon} ${app.label} (${app.id})`);
      lines.push(`  Root: ${app.root}`);
      lines.push(`  Status: ${app.status}`);
      if (app.pm2Name) {
        lines.push(`  PM2: ${app.pm2Name}`);
      }
      const scripts = Object.keys(app.scripts || {});
      if (scripts.length > 0) {
        lines.push(`  Scripts: ${scripts.join(", ")}`);
      }
      lines.push("");
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
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
