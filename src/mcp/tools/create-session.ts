/**
 * MCP Tool: create_session
 *
 * Spawn a new agent session.
 */

import { z } from "zod";

export const createSessionSchema = {
  agent: z
    .enum(["codex", "claude", "goose", "opencode", "gemini"])
    .describe("The agent type to spawn"),
  directory: z
    .string()
    .optional()
    .describe("Working directory for the new session (defaults to server default)"),
  name: z
    .string()
    .optional()
    .describe("Human-readable name for the session"),
};

export const createSessionDescription =
  "Spawn a new agent session. Choose the agent type (codex, claude, " +
  "goose, opencode, gemini) and optionally set a working directory " +
  "and name. Returns the new session details including ID and port.";

interface CreateSessionParams {
  agent: string;
  directory?: string;
  name?: string;
}

export async function handleCreateSession(
  params: CreateSessionParams,
  wingmanUrl: string,
  sessionId: string,
) {
  const { agent, directory, name } = params;

  try {
    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          agent,
          directory,
          name,
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
            text: `Failed to create session (${response.status}): ${error}`,
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
            `Session created successfully`,
            `  Agent: ${result.agent}`,
            `  ID: ${result.id}`,
            `  Name: ${result.name}`,
            `  Port: ${result.port}`,
            `  Dir: ${result.workingDirectory}`,
            `  Status: ${result.status}`,
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
