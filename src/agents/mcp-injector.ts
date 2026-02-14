/**
 * MCP Config Injector
 *
 * Writes per-agent MCP configuration so agents discover the Wingman MCP
 * server on startup. Each agent type has its own config mechanism:
 *
 *   Claude  → .mcp.json in the working directory
 *   Goose   → config.yaml extension entry
 *   Others  → TBD per agent support
 *
 * Called from process-manager before spawning the agent process.
 */

import { join, resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as yaml from "js-yaml";

import type { AgentType, WingmanConfig } from "../config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpInjectionContext {
  sessionId: string;
  agent: AgentType;
  workingDirectory: string;
  config: WingmanConfig;
  /** Per-user bot identity (set when bot key exists for session owner). */
  botPubkeyHex?: string;
  botNpub?: string;
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

  // Pass bot identity env vars when available
  if (ctx.botPubkeyHex) {
    baseEnv.BOT_PUBKEY_HEX = ctx.botPubkeyHex;
  }
  if (ctx.botNpub) {
    baseEnv.BOT_NPUB = ctx.botNpub;
  }

  switch (ctx.agent) {
    case "claude":
      return injectClaude(ctx, mcpServerPath, baseEnv);
    case "goose":
      return injectGoose(ctx, mcpServerPath, baseEnv);
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
      
      if (filePath.endsWith('.json')) {
        // Handle JSON config files (Claude)
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
      } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
        // Handle YAML config files (Goose)
        const yamlContent = await file.text();
        const config = yaml.load(yamlContent) as any;
        
        if (config?.extensions?.wingman) {
          delete config.extensions.wingman;
          
          // Write back the updated config
          const yamlOutput = yaml.dump(config, {
            indent: 2,
            lineWidth: -1,
            noRefs: true,
          });
          await Bun.write(filePath, yamlOutput);
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

/**
 * Goose discovers MCP servers from ~/.config/goose/config.yaml extensions.
 * We merge a "wingman" extension entry into the existing config.
 */
async function injectGoose(
  ctx: McpInjectionContext,
  mcpServerPath: string,
  baseEnv: Record<string, string>,
): Promise<McpInjectionResult> {
  const gooseConfigDir = join(homedir(), ".config", "goose");
  const gooseConfigPath = join(gooseConfigDir, "config.yaml");

  const wingmanExtension = {
    args: ["run", mcpServerPath],
    available_tools: [],
    bundled: null,
    cmd: "bun",
    description: "Wingman MCP server providing AI agent tools",
    enabled: true,
    env_keys: [],
    envs: {
      WINGMAN_URL: baseEnv.WINGMAN_URL!,
      SESSION_ID: ctx.sessionId,
    },
    name: "wingman",
    timeout: 300,
    type: "stdio",
  };

  // Merge into existing config.yaml if present
  let existingConfig: any = {};
  if (existsSync(gooseConfigPath)) {
    try {
      const file = Bun.file(gooseConfigPath);
      const yamlContent = await file.text();
      existingConfig = yaml.load(yamlContent) as any;
    } catch {
      // Corrupted file — start fresh
    }
  }

  // Ensure extensions section exists
  if (!existingConfig.extensions) {
    existingConfig.extensions = {};
  }

  // Add/update wingman extension
  existingConfig.extensions.wingman = wingmanExtension;

  // Write back to config file
  const yamlOutput = yaml.dump(existingConfig, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
  });
  
  // Ensure config directory exists
  if (!existsSync(gooseConfigDir)) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(gooseConfigDir, { recursive: true });
  }

  await Bun.write(gooseConfigPath, yamlOutput);

  console.log(`[mcp-injector] Wrote Goose MCP config: ${gooseConfigPath}`);

  return { env: baseEnv, cleanupFiles: [gooseConfigPath] };
}
