/**
 * MCP Config Injector
 *
 * Writes per-agent MCP configuration so agents discover the Wingman MCP
 * server on startup. Each agent type has its own config mechanism:
 *
 *   Claude  → .mcp.json in the working directory
 *   Goose   → config.yaml extension entry
 *   OpenCode → ~/.config/opencode/opencode.json mcp entry
 *
 * Called from process-manager before spawning the agent process.
 */

import { join, resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as yaml from "js-yaml";

import type { AgentType, WingmanConfig } from "../config";
import {
  buildClaudeWingmanServer,
  buildGooseWingmanExtension,
  buildOpenCodeWingmanMcp,
  removeClaudeWingmanServer,
  removeGooseWingmanExtension,
  removeOpenCodeWingmanMcp,
  upsertClaudeWingmanServer,
  upsertGooseWingmanExtension,
  upsertOpenCodeWingmanMcp,
} from "./mcp-config-helpers";

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
  /** User's npub (for bot key signing in superbased tools). */
  userNpub?: string;
}

export interface McpInjectionResult {
  /** Additional env vars to pass to the agent process. */
  env: Record<string, string>;
  /** Additional CLI args to append when launching the agent process. */
  commandArgs?: string[];
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
  if (ctx.userNpub) {
    baseEnv.USER_NPUB = ctx.userNpub;
  }

  switch (ctx.agent) {
    case "codex":
      return injectCodex(ctx, mcpServerPath, baseEnv);
    case "claude":
      return injectClaude(ctx, mcpServerPath, baseEnv);
    case "goose":
      return injectGoose(ctx, mcpServerPath, baseEnv);
    case "opencode":
      return injectOpenCode(ctx, mcpServerPath, baseEnv);
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
        // Handle JSON config files (Claude/OpenCode)
        const config = await file.json() as Record<string, unknown>;
        const claudeResult = removeClaudeWingmanServer(config);
        if (claudeResult.changed) {
          if (claudeResult.shouldDeleteFile) {
            const { unlink } = await import("node:fs/promises");
            await unlink(filePath);
          } else {
            await Bun.write(filePath, JSON.stringify(claudeResult.config, null, 2) + "\n");
          }
          continue;
        }

        const opencodeResult = removeOpenCodeWingmanMcp(config);
        if (opencodeResult.changed) {
          await Bun.write(filePath, JSON.stringify(opencodeResult.config, null, 2) + "\n");
        }
      } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
        // Handle YAML config files (Goose)
        const yamlContent = await file.text();
        const parsedConfig = yaml.load(yamlContent) as Record<string, unknown> | null;
        const config = parsedConfig ?? {};
        const result = removeGooseWingmanExtension(config);
        if (result.changed) {
          // Write back the updated config
          const yamlOutput = yaml.dump(result.config, {
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
  const wingmanServer = buildClaudeWingmanServer(
    mcpServerPath,
    baseEnv.WINGMAN_URL!,
    ctx.sessionId,
  );

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

  const config = upsertClaudeWingmanServer(existingConfig, wingmanServer);
  await Bun.write(mcpConfigPath, JSON.stringify(config, null, 2) + "\n");

  console.log(`[mcp-injector] Wrote Claude MCP config: ${mcpConfigPath}`);

  return { env: baseEnv, cleanupFiles: [mcpConfigPath] };
}

/**
 * Codex supports MCP server configuration via CLI config overrides.
 * We inject a wingman stdio server entry with `-c` flags so each
 * session gets the right SESSION_ID without mutating global user config.
 */
function injectCodex(
  ctx: McpInjectionContext,
  mcpServerPath: string,
  baseEnv: Record<string, string>,
): McpInjectionResult {
  const escapeTomlString = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const codexEnvInlineTable =
    `{ WINGMAN_URL = "${escapeTomlString(baseEnv.WINGMAN_URL!)}", SESSION_ID = "${escapeTomlString(ctx.sessionId)}" }`;

  const commandArgs = [
    "-c",
    'mcp_servers.wingman.command="bun"',
    "-c",
    `mcp_servers.wingman.args=${JSON.stringify(["run", mcpServerPath])}`,
    "-c",
    `mcp_servers.wingman.env=${codexEnvInlineTable}`,
  ];

  return { env: baseEnv, commandArgs, cleanupFiles: [] };
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
  const wingmanExtension = buildGooseWingmanExtension(
    mcpServerPath,
    baseEnv.WINGMAN_URL!,
    ctx.sessionId,
  );

  // Merge into existing config.yaml if present
  let existingConfig: Record<string, unknown> = {};
  if (existsSync(gooseConfigPath)) {
    try {
      const file = Bun.file(gooseConfigPath);
      const yamlContent = await file.text();
      existingConfig = (yaml.load(yamlContent) as Record<string, unknown> | null) ?? {};
    } catch {
      // Corrupted file — start fresh
    }
  }

  const config = upsertGooseWingmanExtension(existingConfig, wingmanExtension);

  // Write back to config file
  const yamlOutput = yaml.dump(config, {
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

/**
 * OpenCode discovers MCP servers from ~/.config/opencode/opencode.json mcp entries.
 * We merge a "wingman" local MCP entry into the existing config.
 */
async function injectOpenCode(
  ctx: McpInjectionContext,
  mcpServerPath: string,
  baseEnv: Record<string, string>,
): Promise<McpInjectionResult> {
  const opencodeConfigDir = join(homedir(), ".config", "opencode");
  const opencodeConfigPath = join(opencodeConfigDir, "opencode.json");
  const wingmanMcp = buildOpenCodeWingmanMcp(
    mcpServerPath,
    baseEnv.WINGMAN_URL!,
    ctx.sessionId,
  );

  let existingConfig: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
  };
  if (existsSync(opencodeConfigPath)) {
    try {
      const file = Bun.file(opencodeConfigPath);
      existingConfig = await file.json();
    } catch {
      // Corrupted file — start fresh
    }
  }

  const config = upsertOpenCodeWingmanMcp(existingConfig, wingmanMcp);

  if (!existsSync(opencodeConfigDir)) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(opencodeConfigDir, { recursive: true });
  }

  await Bun.write(opencodeConfigPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`[mcp-injector] Wrote OpenCode MCP config: ${opencodeConfigPath}`);

  return { env: baseEnv, cleanupFiles: [opencodeConfigPath] };
}
