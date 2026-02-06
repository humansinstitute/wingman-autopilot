/**
 * MCP Config Injector
 *
 * Writes per-agent MCP configuration so agents discover the Wingman MCP
 * server on startup. Each agent type has its own config mechanism:
 *
 *   Claude  → .mcp.json in the working directory
 *   Goose   → environment variables (future)
 *   Others  → TBD per agent support
 *
 * Called from process-manager before spawning the agent process.
 */

import { join, resolve, dirname } from "node:path";
import { existsSync } from "node:fs";

import type { AgentType, WingmanConfig } from "../config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpInjectionContext {
  sessionId: string;
  agent: AgentType;
  workingDirectory: string;
  config: WingmanConfig;
}

export interface McpInjectionResult {
  /** Additional env vars to pass to the agent process. */
  env: Record<string, string>;
  /** Files modified by injection — cleanup will remove our entry only. */
  cleanupFiles: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write MCP configuration for the given agent session.
 * Returns extra env vars and a list of files to clean up later.
 */
export async function injectMcpConfig(
  ctx: McpInjectionContext,
): Promise<McpInjectionResult> {
  const wingmanUrl = `http://localhost:${ctx.config.port}`;
  const mcpServerPath = resolve(
    dirname(import.meta.url.replace("file://", "")),
    "../mcp/stdio-server.ts",
  );

  const baseEnv: Record<string, string> = {
    WINGMAN_URL: wingmanUrl,
  };

  switch (ctx.agent) {
    case "claude":
      return injectClaude(ctx, mcpServerPath, baseEnv);
    default:
      // Other agents: just pass env vars. The stdio server path is
      // available if the agent supports MCP via environment config.
      return {
        env: {
          ...baseEnv,
          WINGMAN_MCP_SERVER: mcpServerPath,
        },
        cleanupFiles: [],
      };
  }
}

/**
 * Remove the "wingman" MCP server entry from config files created during
 * injection. Preserves any other user-defined MCP servers.
 */
export async function cleanupMcpConfig(files: string[]): Promise<void> {
  for (const filePath of files) {
    try {
      if (!existsSync(filePath)) continue;

      const file = Bun.file(filePath);
      const config = await file.json() as Record<string, unknown>;
      const servers = config.mcpServers as Record<string, unknown> | undefined;

      if (servers && "wingman" in servers) {
        delete servers.wingman;

        // If no servers remain and no other top-level keys, remove the file
        if (Object.keys(servers).length === 0 && Object.keys(config).length <= 1) {
          const { unlink } = await import("node:fs/promises");
          await unlink(filePath);
        } else {
          await Bun.write(filePath, JSON.stringify(config, null, 2) + "\n");
        }
      }
    } catch {
      // File may already be gone or corrupted — ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Agent-specific injectors
// ---------------------------------------------------------------------------

/**
 * Claude discovers MCP servers from .mcp.json in the project root.
 * We merge a "wingman" server entry into the existing config.
 */
async function injectClaude(
  ctx: McpInjectionContext,
  mcpServerPath: string,
  baseEnv: Record<string, string>,
): Promise<McpInjectionResult> {
  const mcpConfigPath = join(ctx.workingDirectory, ".mcp.json");

  const wingmanServer = {
    type: "stdio" as const,
    command: "bun",
    args: ["run", mcpServerPath],
    env: {
      WINGMAN_URL: baseEnv.WINGMAN_URL!,
      SESSION_ID: ctx.sessionId,
    },
  };

  // Merge into existing .mcp.json if present
  let existingConfig: Record<string, unknown> = {};
  if (existsSync(mcpConfigPath)) {
    try {
      const file = Bun.file(mcpConfigPath);
      existingConfig = await file.json();
    } catch {
      // Corrupted file — start fresh
    }
  }

  const mcpServers =
    (existingConfig.mcpServers as Record<string, unknown>) ?? {};
  mcpServers.wingman = wingmanServer;

  const config = { ...existingConfig, mcpServers };
  await Bun.write(mcpConfigPath, JSON.stringify(config, null, 2) + "\n");

  console.log(`[mcp-injector] Wrote Claude MCP config: ${mcpConfigPath}`);

  return { env: baseEnv, cleanupFiles: [mcpConfigPath] };
}
