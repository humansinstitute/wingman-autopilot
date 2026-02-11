/**
 * MCP Tool: git_push
 *
 * Push the current branch to the Gitea remote. Proxies through the
 * Wingman server's /api/gitea/push endpoint which handles credential
 * injection scoped to the Gitea URL only.
 */

import { z } from "zod";

export const gitPushSchema = {
  branch: z
    .string()
    .optional()
    .describe("Branch to push. Defaults to the current branch."),
};

export const gitPushDescription =
  "Push current branch to Gitea remote. " +
  "Uses Wingman's credential helper scoped to the Gitea URL — " +
  "does not affect pushes to GitHub or other remotes.";

interface GitPushParams {
  branch?: string;
}

export async function handleGitPush(
  params: GitPushParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const response = await fetch(`${wingmanUrl}/api/gitea/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        branch: params.branch,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Push to Gitea failed (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = await response.json() as { stdout: string; stderr: string };

    return {
      content: [
        {
          type: "text" as const,
          text: [
            "Pushed to Gitea successfully.",
            result.stdout ? `\nOutput:\n${result.stdout}` : "",
            result.stderr ? `\nStderr:\n${result.stderr}` : "",
          ].join(""),
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
