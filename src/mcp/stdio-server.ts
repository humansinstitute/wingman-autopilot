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
import {
  listAppsSchema,
  listAppsDescription,
  handleListApps,
} from "./tools/list-apps";
import {
  manageAppSchema,
  manageAppDescription,
  handleManageApp,
} from "./tools/manage-app";
import {
  readLogsSchema,
  readLogsDescription,
  handleReadLogs,
} from "./tools/read-logs";
import {
  listSessionsSchema,
  listSessionsDescription,
  handleListSessions,
} from "./tools/list-sessions";
import {
  createSessionSchema,
  createSessionDescription,
  handleCreateSession,
} from "./tools/create-session";
import {
  listCaproverAppsSchema,
  listCaproverAppsDescription,
  handleListCaproverApps,
} from "./tools/list-caprover-apps";
import {
  deployCaproverAppSchema,
  deployCaproverAppDescription,
  handleDeployCaproverApp,
} from "./tools/deploy-caprover-app";
import {
  listSkillsSchema,
  listSkillsDescription,
  handleListSkills,
} from "./tools/list-skills";
import {
  runSkillSchema,
  runSkillDescription,
  handleRunSkill,
} from "./tools/run-skill";
import {
  generateImageSchema,
  generateImageDescription,
  handleGenerateImage,
} from "./tools/generate-image";
import {
  getProjectSchema,
  getProjectDescription,
  handleGetProject,
} from "./tools/get-project";
import {
  saveMemorySchema,
  saveMemoryDescription,
  handleSaveMemory,
} from "./tools/save-memory";
import {
  searchMemorySchema,
  searchMemoryDescription,
  handleSearchMemory,
} from "./tools/search-memory";
import {
  deleteMemorySchema,
  deleteMemoryDescription,
  handleDeleteMemory,
} from "./tools/delete-memory";
import {
  pinArtifactSchema,
  pinArtifactDescription,
  handlePinArtifact,
} from "./tools/pin-artifact";
import {
  getPinnedArtifactSchema,
  getPinnedArtifactDescription,
  handleGetPinnedArtifact,
} from "./tools/get-pinned-artifact";
import {
  ngitInitSchema,
  ngitInitDescription,
  handleNgitInit,
} from "./tools/ngit-init";
import {
  ngitPublishRepoSchema,
  ngitPublishRepoDescription,
  handleNgitPublishRepo,
} from "./tools/ngit-publish-repo";
import {
  ngitPushStateSchema,
  ngitPushStateDescription,
  handleNgitPushState,
} from "./tools/ngit-push-state";
import {
  ngitListReposSchema,
  ngitListReposDescription,
  handleNgitListRepos,
} from "./tools/ngit-list-repos";
import {
  ngitSendPatchSchema,
  ngitSendPatchDescription,
  handleNgitSendPatch,
} from "./tools/ngit-send-patch";
import {
  ngitCreatePrSchema,
  ngitCreatePrDescription,
  handleNgitCreatePr,
} from "./tools/ngit-create-pr";
import {
  ngitCreateIssueSchema,
  ngitCreateIssueDescription,
  handleNgitCreateIssue,
} from "./tools/ngit-create-issue";
import {
  ngitSetStatusSchema,
  ngitSetStatusDescription,
  handleNgitSetStatus,
} from "./tools/ngit-set-status";
import {
  ngitListProposalsSchema,
  ngitListProposalsDescription,
  handleNgitListProposals,
} from "./tools/ngit-list-proposals";

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

// ---- list_apps ----
server.tool(
  "list_apps",
  listAppsDescription,
  listAppsSchema,
  (_params) => handleListApps({} as Record<string, never>, wingmanUrl, sessionId),
);

// ---- manage_app ----
server.tool(
  "manage_app",
  manageAppDescription,
  manageAppSchema,
  (params) => handleManageApp(params, wingmanUrl, sessionId),
);

// ---- read_logs ----
server.tool(
  "read_logs",
  readLogsDescription,
  readLogsSchema,
  (params) => handleReadLogs(params, wingmanUrl, sessionId),
);

// ---- list_sessions ----
server.tool(
  "list_sessions",
  listSessionsDescription,
  listSessionsSchema,
  (_params) => handleListSessions({} as Record<string, never>, wingmanUrl, sessionId),
);

// ---- create_session ----
server.tool(
  "create_session",
  createSessionDescription,
  createSessionSchema,
  (params) => handleCreateSession(params, wingmanUrl, sessionId),
);

// ---- list_caprover_apps ----
server.tool(
  "list_caprover_apps",
  listCaproverAppsDescription,
  listCaproverAppsSchema,
  (_params) => handleListCaproverApps({} as Record<string, never>, wingmanUrl, sessionId),
);

// ---- deploy_caprover_app ----
server.tool(
  "deploy_caprover_app",
  deployCaproverAppDescription,
  deployCaproverAppSchema,
  (params) => handleDeployCaproverApp(params, wingmanUrl, sessionId),
);

// ---- list_skills ----
server.tool(
  "list_skills",
  listSkillsDescription,
  listSkillsSchema,
  (params) => handleListSkills(params, wingmanUrl, sessionId),
);

// ---- run_skill ----
server.tool(
  "run_skill",
  runSkillDescription,
  runSkillSchema,
  (params) => handleRunSkill(params, wingmanUrl, sessionId),
);

// ---- generate_image ----
server.tool(
  "generate_image",
  generateImageDescription,
  generateImageSchema,
  (params) => handleGenerateImage(params, wingmanUrl, sessionId),
);

// ---- get_project ----
server.tool(
  "get_project",
  getProjectDescription,
  getProjectSchema,
  (_params) => handleGetProject({} as Record<string, never>, wingmanUrl, sessionId),
);

// ---- pin_artifact ----
server.tool(
  "pin_artifact",
  pinArtifactDescription,
  pinArtifactSchema,
  (params) => handlePinArtifact(params, wingmanUrl, sessionId),
);

// ---- get_pinned_artifact ----
server.tool(
  "get_pinned_artifact",
  getPinnedArtifactDescription,
  getPinnedArtifactSchema,
  (_params) => handleGetPinnedArtifact({} as Record<string, never>, wingmanUrl, sessionId),
);

// ---- save_memory ----
server.tool(
  "save_memory",
  saveMemoryDescription,
  saveMemorySchema,
  (params) => handleSaveMemory(params, wingmanUrl, sessionId),
);

// ---- search_memory ----
server.tool(
  "search_memory",
  searchMemoryDescription,
  searchMemorySchema,
  (params) => handleSearchMemory(params, wingmanUrl, sessionId),
);

// ---- delete_memory ----
server.tool(
  "delete_memory",
  deleteMemoryDescription,
  deleteMemorySchema,
  (params) => handleDeleteMemory(params, wingmanUrl, sessionId),
);

// ---- ngit_init ----
server.tool(
  "ngit_init",
  ngitInitDescription,
  ngitInitSchema,
  (params) => handleNgitInit(params, wingmanUrl, sessionId),
);

// ---- ngit_publish_repo ----
server.tool(
  "ngit_publish_repo",
  ngitPublishRepoDescription,
  ngitPublishRepoSchema,
  (params) => handleNgitPublishRepo(params, wingmanUrl, sessionId),
);

// ---- ngit_push_state ----
server.tool(
  "ngit_push_state",
  ngitPushStateDescription,
  ngitPushStateSchema,
  (params) => handleNgitPushState(params, wingmanUrl, sessionId),
);

// ---- ngit_list_repos ----
server.tool(
  "ngit_list_repos",
  ngitListReposDescription,
  ngitListReposSchema,
  (params) => handleNgitListRepos(params, wingmanUrl, sessionId),
);

// ---- ngit_send_patch ----
server.tool(
  "ngit_send_patch",
  ngitSendPatchDescription,
  ngitSendPatchSchema,
  (params) => handleNgitSendPatch(params, wingmanUrl, sessionId),
);

// ---- ngit_create_pr ----
server.tool(
  "ngit_create_pr",
  ngitCreatePrDescription,
  ngitCreatePrSchema,
  (params) => handleNgitCreatePr(params, wingmanUrl, sessionId),
);

// ---- ngit_create_issue ----
server.tool(
  "ngit_create_issue",
  ngitCreateIssueDescription,
  ngitCreateIssueSchema,
  (params) => handleNgitCreateIssue(params, wingmanUrl, sessionId),
);

// ---- ngit_set_status ----
server.tool(
  "ngit_set_status",
  ngitSetStatusDescription,
  ngitSetStatusSchema,
  (params) => handleNgitSetStatus(params, wingmanUrl, sessionId),
);

// ---- ngit_list_proposals ----
server.tool(
  "ngit_list_proposals",
  ngitListProposalsDescription,
  ngitListProposalsSchema,
  (params) => handleNgitListProposals(params, wingmanUrl, sessionId),
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  `[wingman-mcp] Server started (session=${sessionId}, wingman=${wingmanUrl})`,
);
