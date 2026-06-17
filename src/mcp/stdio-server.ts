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
  stopSessionSchema,
  stopSessionDescription,
  handleStopSession,
} from "./tools/stop-session";
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
  nip44EncryptSchema,
  nip44EncryptDescription,
  handleNip44Encrypt,
} from "./tools/nip44-encrypt";
import {
  nip44DecryptSchema,
  nip44DecryptDescription,
  handleNip44Decrypt,
} from "./tools/nip44-decrypt";
import {
  superbasedHealthSchema,
  superbasedHealthDescription,
  handleSuperbasedHealth,
} from "./tools/superbased-health";
import {
  superbasedFetchRecordsSchema,
  superbasedFetchRecordsDescription,
  handleSuperbasedFetchRecords,
} from "./tools/superbased-fetch-records";
import {
  superbasedSyncRecordsSchema,
  superbasedSyncRecordsDescription,
  handleSuperbasedSyncRecords,
} from "./tools/superbased-sync-records";
import {
  superbasedRecordHistorySchema,
  superbasedRecordHistoryDescription,
  handleSuperbasedRecordHistory,
} from "./tools/superbased-record-history";
import {
  superbasedStorageDownloadSchema,
  superbasedStorageDownloadDescription,
  handleSuperbasedStorageDownload,
} from "./tools/superbased-storage-download";
import {
  wingmanIdentitySchema,
  wingmanIdentityDescription,
  handleGetWingmanIdentity,
} from "./tools/wingman-identity";
import {
  gitPushSchema,
  gitPushDescription,
  handleGitPush,
} from "./tools/git-push";
import {
  nostrGetProfileSchema,
  nostrGetProfileDescription,
  handleNostrGetProfile,
} from "./tools/nostr-profile";
import {
  nostrGetFeedSchema,
  nostrGetFeedDescription,
  handleNostrGetFeed,
} from "./tools/nostr-feed";
import {
  nostrSignEventSchema,
  nostrSignEventDescription,
  handleNostrSignEvent,
} from "./tools/nostr-sign-event";
import {
  nostrPublishEventSchema,
  nostrPublishEventDescription,
  handleNostrPublishEvent,
} from "./tools/nostr-publish-event";
import {
  giteaInfoSchema,
  giteaInfoDescription,
  handleGiteaInfo,
} from "./tools/gitea-info";
import {
  gitStatusSchema,
  gitStatusDescription,
  handleGitStatus,
} from "./tools/git-status";
import {
  gitBranchSchema,
  gitBranchDescription,
  handleGitBranch,
} from "./tools/git-branch";
import {
  gitWorktreeSchema,
  gitWorktreeDescription,
  handleGitWorktree,
} from "./tools/git-worktree";
import {
  gitMergeSchema,
  gitMergeDescription,
  handleGitMerge,
} from "./tools/git-merge";
import {
  flightdeckChatReplyDescription,
  flightdeckChatReplySchema,
  flightdeckContextDescription,
  flightdeckContextSchema,
  flightdeckDocCommentsDescription,
  flightdeckDocCommentsSchema,
  flightdeckDocCreateDescription,
  flightdeckDocCreateSchema,
  flightdeckDocGetDescription,
  flightdeckDocGetSchema,
  flightdeckDocReplyDescription,
  flightdeckDocReplySchema,
  flightdeckDocUpdateDescription,
  flightdeckDocUpdateSchema,
  flightdeckDailyScopeGetDescription,
  flightdeckDailyScopeGetSchema,
  flightdeckDailyScopeUpsertDescription,
  flightdeckDailyScopeUpsertSchema,
  flightdeckTaskCommentDescription,
  flightdeckTaskCommentSchema,
  flightdeckTaskCommentsDescription,
  flightdeckTaskCommentsSchema,
  flightdeckTaskStateDescription,
  flightdeckTaskStateSchema,
  flightdeckThreadReadDescription,
  flightdeckThreadReadSchema,
  handleFlightdeckChatReply,
  handleFlightdeckContext,
  handleFlightdeckDocComments,
  handleFlightdeckDocCreate,
  handleFlightdeckDocGet,
  handleFlightdeckDocReply,
  handleFlightdeckDocUpdate,
  handleFlightdeckDailyScopeGet,
  handleFlightdeckDailyScopeUpsert,
  handleFlightdeckTaskComment,
  handleFlightdeckTaskComments,
  handleFlightdeckTaskState,
  handleFlightdeckThreadRead,
} from "./tools/flightdeck";

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

// ---- stop_session ----
server.tool(
  "stop_session",
  stopSessionDescription,
  stopSessionSchema,
  (params) => handleStopSession(params, wingmanUrl, sessionId),
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

// ---- Flight Deck PG helpers ----
server.tool(
  "flightdeck_context",
  flightdeckContextDescription,
  flightdeckContextSchema,
  (_params) => handleFlightdeckContext({} as Record<string, never>, wingmanUrl, sessionId),
);

server.tool(
  "flightdeck_thread_read",
  flightdeckThreadReadDescription,
  flightdeckThreadReadSchema,
  (params) => handleFlightdeckThreadRead(params, wingmanUrl, sessionId),
);

server.tool(
  "flightdeck_chat_reply",
  flightdeckChatReplyDescription,
  flightdeckChatReplySchema,
  (params) => handleFlightdeckChatReply(params, wingmanUrl, sessionId),
);

server.tool(
  "flightdeck_task_comment",
  flightdeckTaskCommentDescription,
  flightdeckTaskCommentSchema,
  (params) => handleFlightdeckTaskComment(params, wingmanUrl, sessionId),
);

server.tool(
  "flightdeck_task_comments",
  flightdeckTaskCommentsDescription,
  flightdeckTaskCommentsSchema,
  (params) => handleFlightdeckTaskComments(params, wingmanUrl, sessionId),
);

server.tool(
  "flightdeck_task_state",
  flightdeckTaskStateDescription,
  flightdeckTaskStateSchema,
  (params) => handleFlightdeckTaskState(params, wingmanUrl, sessionId),
);

server.tool(
  "flightdeck_doc_create",
  flightdeckDocCreateDescription,
  flightdeckDocCreateSchema,
  (params) => handleFlightdeckDocCreate(params, wingmanUrl, sessionId),
);

server.tool(
  "flightdeck_doc_get",
  flightdeckDocGetDescription,
  flightdeckDocGetSchema,
  (params) => handleFlightdeckDocGet(params, wingmanUrl, sessionId),
);

server.tool(
  "flightdeck_doc_update",
  flightdeckDocUpdateDescription,
  flightdeckDocUpdateSchema,
  (params) => handleFlightdeckDocUpdate(params, wingmanUrl, sessionId),
);

server.tool(
  "flightdeck_doc_comments",
  flightdeckDocCommentsDescription,
  flightdeckDocCommentsSchema,
  (params) => handleFlightdeckDocComments(params, wingmanUrl, sessionId),
);

server.tool(
  "flightdeck_doc_reply",
  flightdeckDocReplyDescription,
  flightdeckDocReplySchema,
  (params) => handleFlightdeckDocReply(params, wingmanUrl, sessionId),
);

server.tool(
  "flightdeck_daily_scope_get",
  flightdeckDailyScopeGetDescription,
  flightdeckDailyScopeGetSchema,
  (params) => handleFlightdeckDailyScopeGet(params, wingmanUrl, sessionId),
);

server.tool(
  "flightdeck_daily_scope_upsert",
  flightdeckDailyScopeUpsertDescription,
  flightdeckDailyScopeUpsertSchema,
  (params) => handleFlightdeckDailyScopeUpsert(params, wingmanUrl, sessionId),
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

// ---- nip44_encrypt ----
server.tool(
  "nip44_encrypt",
  nip44EncryptDescription,
  nip44EncryptSchema,
  (params) => handleNip44Encrypt(params),
);

// ---- nip44_decrypt ----
server.tool(
  "nip44_decrypt",
  nip44DecryptDescription,
  nip44DecryptSchema,
  (params) => handleNip44Decrypt(params),
);

// ---- get_wingman_identity ----
server.tool(
  "get_wingman_identity",
  wingmanIdentityDescription,
  wingmanIdentitySchema,
  () => handleGetWingmanIdentity(),
);

// ---- superbased_health ----
server.tool(
  "superbased_health",
  superbasedHealthDescription,
  superbasedHealthSchema,
  (params) => handleSuperbasedHealth(params, wingmanUrl, sessionId),
);

// ---- superbased_fetch_records ----
server.tool(
  "superbased_fetch_records",
  superbasedFetchRecordsDescription,
  superbasedFetchRecordsSchema,
  (params) => handleSuperbasedFetchRecords(params, wingmanUrl, sessionId),
);

// ---- superbased_sync_records ----
server.tool(
  "superbased_sync_records",
  superbasedSyncRecordsDescription,
  superbasedSyncRecordsSchema,
  (params) => handleSuperbasedSyncRecords(params, wingmanUrl, sessionId),
);

// ---- superbased_record_history ----
server.tool(
  "superbased_record_history",
  superbasedRecordHistoryDescription,
  superbasedRecordHistorySchema,
  (params) => handleSuperbasedRecordHistory(params, wingmanUrl, sessionId),
);

// ---- superbased_storage_download_url ----
server.tool(
  "superbased_storage_download_url",
  superbasedStorageDownloadDescription,
  superbasedStorageDownloadSchema,
  (params) => handleSuperbasedStorageDownload(params, wingmanUrl, sessionId),
);

// ---- git_push ----
server.tool(
  "git_push",
  gitPushDescription,
  gitPushSchema,
  (params) => handleGitPush(params, wingmanUrl, sessionId),
);

// ---- gitea_info ----
server.tool(
  "gitea_info",
  giteaInfoDescription,
  giteaInfoSchema,
  (_params) => handleGiteaInfo({} as Record<string, never>, wingmanUrl, sessionId),
);

// ---- nostr_get_profile ----
server.tool(
  "nostr_get_profile",
  nostrGetProfileDescription,
  nostrGetProfileSchema,
  (params) => handleNostrGetProfile(params),
);

// ---- nostr_get_feed ----
server.tool(
  "nostr_get_feed",
  nostrGetFeedDescription,
  nostrGetFeedSchema,
  (params) => handleNostrGetFeed(params),
);

// ---- nostr_sign_event ----
server.tool(
  "nostr_sign_event",
  nostrSignEventDescription,
  nostrSignEventSchema,
  (params) => handleNostrSignEvent(params, wingmanUrl, sessionId),
);

// ---- nostr_publish_event ----
server.tool(
  "nostr_publish_event",
  nostrPublishEventDescription,
  nostrPublishEventSchema,
  (params) => handleNostrPublishEvent(params, wingmanUrl, sessionId),
);

// ---- git_status ----
server.tool(
  "git_status",
  gitStatusDescription,
  gitStatusSchema,
  (_params) => handleGitStatus({} as Record<string, never>, wingmanUrl, sessionId),
);

// ---- git_branch ----
server.tool(
  "git_branch",
  gitBranchDescription,
  gitBranchSchema,
  (params) => handleGitBranch(params, wingmanUrl, sessionId),
);

// ---- git_worktree ----
server.tool(
  "git_worktree",
  gitWorktreeDescription,
  gitWorktreeSchema,
  (params) => handleGitWorktree(params, wingmanUrl, sessionId),
);

// ---- git_merge ----
server.tool(
  "git_merge",
  gitMergeDescription,
  gitMergeSchema,
  (params) => handleGitMerge(params, wingmanUrl, sessionId),
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  `[wingman-mcp] Server started (session=${sessionId}, wingman=${wingmanUrl})`,
);
