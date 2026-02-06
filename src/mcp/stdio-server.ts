#!/usr/bin/env bun
/**
 * Wingman MCP Server — stdio transport
 *
 * Spawned as a child process of each agent. Communicates with the agent
 * via stdin/stdout (MCP JSON-RPC protocol). Makes HTTP calls back to the
 * Wingman server for NIP-98 signing and grant management.
 *
 * Environment variables (set by process-manager when spawning the agent):
 *   WINGMAN_URL   — Base URL of the Wingman server (e.g. http://localhost:3600)
 *   SESSION_ID    — UUID of the agent session
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  signNip98Schema,
  signNip98Description,
  handleSignNip98,
} from "./tools/sign-nip98";
import {
  requestAccessSchema,
  requestAccessDescription,
  handleRequestAccess,
} from "./tools/request-access";
import {
  checkSupportSchema,
  checkSupportDescription,
  handleCheckSupport,
} from "./tools/check-support";
import {
  listGrantsSchema,
  listGrantsDescription,
  handleListGrants,
} from "./tools/list-grants";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const wingmanUrl = process.env.WINGMAN_URL ?? "http://localhost:3600";
const sessionId = process.env.SESSION_ID ?? "";

if (!sessionId) {
  console.error("[wingman-mcp] WARNING: SESSION_ID not set — tools may fail");
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "wingman",
  version: "1.0.0",
});

// ---- sign_nip98 ----
server.tool("sign_nip98", signNip98Description, signNip98Schema, (params) =>
  handleSignNip98(params, wingmanUrl, sessionId),
);

// ---- request_api_access ----
server.tool(
  "request_api_access",
  requestAccessDescription,
  requestAccessSchema,
  (params) => handleRequestAccess(params, wingmanUrl, sessionId),
);

// ---- check_nip98_support ----
server.tool(
  "check_nip98_support",
  checkSupportDescription,
  checkSupportSchema,
  (params) => handleCheckSupport(params),
);

// ---- list_active_grants ----
server.tool(
  "list_active_grants",
  listGrantsDescription,
  listGrantsSchema,
  (_params) => handleListGrants({} as Record<string, never>, wingmanUrl, sessionId),
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  `[wingman-mcp] Server started (session=${sessionId}, wingman=${wingmanUrl})`,
);
