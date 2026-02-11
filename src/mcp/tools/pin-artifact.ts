/**
 * MCP Tool: pin_artifact
 *
 * Pin a file as the active artifact in the Wingman UI right-hand panel.
 */

import { z } from "zod";

export const pinArtifactSchema = {
  file_path: z.string().describe("Absolute path to the file to pin in the UI panel"),
};

export const pinArtifactDescription =
  "Pin a file as the active artifact in the Wingman UI right-hand panel. " +
  "The file will be displayed using the writer/editor view. " +
  "Use this to show design docs, code files, or any text file to the user.";

interface PinArtifactParams {
  file_path: string;
}

export async function handlePinArtifact(
  params: PinArtifactParams,
  wingmanUrl: string,
  sessionId: string,
) {
  const { file_path } = params;

  try {
    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/artifact/pin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, filePath: file_path }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to pin artifact (${response.status}): ${error}`,
          },
        ],
      };
    }

    const { pinnedFile } = await response.json();

    return {
      content: [
        {
          type: "text" as const,
          text: `Pinned artifact: ${pinnedFile}`,
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
