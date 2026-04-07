# Wingman middleware and boundary layer (as built)

Last reviewed against the live repository on 2026-04-07.

## Scope

This document describes the current HTTP and middleware boundary implemented by `src/server.ts` and the route modules it composes. It sits on top of:

- `docs/asbuilt/architecture.md` for runtime boundaries
- `docs/asbuilt/data model.md` for persisted state

The focus here is request handling, auth and filtering, route registration, SSE/live-update paths, and background entrypoints that materially affect boundary behavior.

## Composition root

`src/server.ts` is still the operational composition root.

At startup it:

- loads config and feature flags
- instantiates stores and service objects
- creates extracted route handlers for sessions, auth, docs, uploads, scheduler, jobs, Gitea, SuperBased, MCP, billing, admin, apps, agent-chat, and system operations
- registers access-control rules
- starts Bun’s HTTP server via `Bun.serve(...)`
- starts long-running boundary-adjacent loops such as scheduler execution, session status polling, live message persistence, upload cleanup, Nostr listeners, file watcher runners, and workspace subscription reconnects

## Request pipeline

Every HTTP request flows through the same high-level path in `Bun.serve(...).fetch(...)`:

1. Build `url` and `method`.
2. Resolve cookie-based auth with `resolveRequestAuthContext(request)`.
3. Run the rest of the request inside `runWithRequestContext(authContext, ...)` so downstream code can read request-scoped auth.
4. Handle the dedicated webhook path first: `POST /v1/api/webhook/off`.
5. Apply subdomain app proxying before Wingman UI/API routing when the host matches the configured app subdomain pattern.
6. Apply path-based app proxying for `/host/<alias>` and `/host/<alias>/*`.
7. Redirect `GET /` to `/home`.
8. Serve SPA shell routes from `src/ui/index.html`.
9. Serve UI assets, vendor modules, Ace assets, and `public/` assets.
10. Dispatch `/api/*` through `handleApi(...)`.
11. Serve authenticated temp uploads from `/uploads/images/...` and `/uploads/files/...`.
12. Refresh session cookies on the way out with `maybeRefreshSessionCookie(...)`.

Important non-API boundary behavior:

- SPA paths include `/home`, `/apps`, `/projects`, `/todos`, `/docs`, `/files`, `/live`, `/chat`, `/settings`, `/privacy`, `/nightwatch`, `/scheduler`, and `/triggers`.
- `createStaticAssetService(...)` is responsible for MIME-aware static serving, including ES module assets under `src/ui`.
- `compressResponse(...)` is applied to most UI/static responses.
- Uploaded files are never public in the generic sense; serving checks the caller’s session and per-user path segment before returning a file.
- App proxying is HTTP-only today; both `/host/<alias>` routing and subdomain routing reject WebSocket upgrades with `501`.

## Auth and middleware layers

The implemented middleware stack is layered rather than centralized in a single Express-style middleware chain.

### 1. Cookie session auth

`resolveRequestAuthContext(...)` parses the Wingman session cookie and populates:

- `npub`
- `actorNpub`
- `session`
- `authMethod: "session"`
- `error` for invalid cookies

This is the default browser auth path.

### 2. NIP-98 auth fallback

Certain API families explicitly upgrade the request auth context with `resolveNip98AuthContext(...)`. This is used for programmatic callers and delegated bot callers.

As built, that is used for:

- `/api/npub-projects*`
- `/api/apps*` and `/api/workspace/tree`
- `/api/autopilot-jobs*`
- `/api/archive*`
- `/api/sessions*`
- `/api/delegate-sessions*`

Practical consequence:

- a request can be anonymous at the cookie layer but authenticated at the API layer through NIP-98
- delegated bot auth is tracked explicitly and affects session-origin handling

### 3. Access-control rules

`src/auth/access-control.ts` provides the policy engine. `src/server.ts` registers the current rules:

- `sessions:manage` requires auth, but allows NIP-98
- `files:read` requires session auth
- `files:write` requires session auth
- `apps:manage` requires auth, but allows NIP-98
- `ui:restricted` requires session auth
- `todos:manage` requires session auth
- `projects:manage` requires session auth
- `deployments:manage` requires session auth
- `system:manage` requires admin
- `admin:users` requires admin
- `feature-flags:manage` requires admin

`ensureApiAccess(...)` turns denied access into JSON errors. `ensurePageAccess(...)` is the page-oriented equivalent.

### 4. Localhost-only filters

Some routes are intentionally machine-local and are rejected unless the request IP resolves to loopback:

- `/api/mcp/bot-crypto/*`
- `/api/mcp/nip98/*`
- `/api/git/*`

These are intended for MCP stdio servers or local child processes rather than browser traffic.

### 5. Handler-local auth models

Several handlers implement their own boundary rules on top of access-control:

- `/api/gitea/*`, `/api/ngit/*`, `/api/mcp/wingman/*`, and parts of `/api/superbased/*` validate by `sessionId` in the request body/query rather than cookie auth
- `/api/chats*` requires a cookie-backed session before the chat handler is entered
- `/api/scheduler/*` reads the caller `npub` from request context and rejects when missing
- `/api/bot-keys/*` mixes cookie auth and session-linked escrow flows
- `/api/provider/*` depends on team billing mode and session-linked usage attribution

## Registered route inventory

### Server-level routes outside `handleApi`

| Route/prefix | Method(s) | Behavior |
| --- | --- | --- |
| `/` | `GET` | Redirects to `/home` |
| `/v1/api/webhook/off` | `POST` | Stops a session by webhook token or authenticated session |
| `/host/<alias>` and `/host/<alias>/*` | any | Path-based proxy into a registered app |
| app subdomains | any | Host-based proxy into a registered app |
| `/uploads/images/<segment>/...` | `GET` | Authenticated image serving |
| `/uploads/files/<segment>/...` | `GET` | Authenticated attachment serving |
| SPA routes listed above | `GET` | Return the shared SPA shell |

### Top-level utility API routes in `api-routes.ts`

| Route | Method(s) | Notes |
| --- | --- | --- |
| `/api/config` | `GET` | Returns server config visible to the viewer, including feature flags and allowed directories |
| `/api/directories` | `GET`, `POST` | Directory listing/creation within workspace scope |
| `/api/artifacts/:id/raw` | `GET` | Streams an artifact file after `sessions:manage` auth |
| `/api/user/settings` | `GET` | Lists current user settings with masking for secret-like keys |
| `/api/user/settings/:key` | `PUT`, `DELETE` | Sets or deletes a user-scoped setting |

### Session, archive, and delegate session APIs

Implemented in `src/server/session-api-routes.ts`.

| Route | Method(s) | Notes |
| --- | --- | --- |
| `/api/archive` | `GET` | Lists archived sessions with validated `limit`, `offset`, `filter` |
| `/api/archive/:id` | `GET`, `DELETE` | Reads or deletes an archived session |
| `/api/archive/:id/messages` | `GET` | Returns archived transcript |
| `/api/sessions/subscribe` | `GET` | Browser SSE for session lifecycle updates |
| `/api/delegate-sessions` | `GET`, `POST` | NIP-98 programmatic session listing/creation |
| `/api/delegate-sessions/:id` | `GET`, `DELETE` | Programmatic read/stop |
| `/api/delegate-sessions/:id/messages` | `GET`, `POST` | Programmatic transcript read and queued prompt/message submission |
| `/api/sessions` | `GET`, `POST` | List live sessions or create one |
| `/api/sessions/:id` | `GET`, `PATCH`, `DELETE` | Read, rename, stop |
| `/api/sessions/:id/storage` | `DELETE` | Delete local session storage after stop/archive conditions pass |
| `/api/sessions/:id/logs` | `GET` | Returns process logs |
| `/api/sessions/:id/artifacts` | `GET` | Lists session artifacts |
| `/api/sessions/:id/messages` | `GET`, `POST` | Read transcript or send agent input |
| `/api/sessions/:id/history` | `GET` | Returns live or archived message history |
| `/api/sessions/:id/events` | `GET` | SSE proxy to agent events or heartbeat-only fallback for native adapters |
| `/api/sessions/:id/queue/...` | mixed | Queue inspection, edit, delete, and dispatch endpoints |
| `/api/sessions/:id/fork-to-worktree` | `POST` | Creates a git worktree and seeds a new session with context |

Boundary behavior worth calling out:

- session IDs can resolve by unique prefix, not only exact match
- non-admin users only see sessions whose normalized `npub` matches their own
- cookie-authenticated viewers and owner-linked NIP-98 callers can stop owned sessions through `/api/sessions/:id`
- the stricter `metadata.AGENT` stop rule is enforced on the MCP-only `/api/mcp/wingman/sessions/stop` endpoint, not on `/api/sessions/:id`
- message sending debits sats for non-credit-billing sessions and returns `402` on insufficient balance

### Auth and identity routes

Implemented in `src/server/auth-routes.ts`.

| Route | Method(s) | Notes |
| --- | --- | --- |
| `/api/auth/session` | `POST`, `DELETE` | Login/logout; POST mints session cookie and ensures a bot key exists |
| `/api/auth/keyteleport` | `POST` | Accepts encrypted KeyTeleport payload |
| `/api/auth/keyteleport/config` | `GET` | Returns whether KeyTeleport is configured |
| `/api/auth/keyteleport/registration` | `GET` | Returns registration blob |
| `/api/identity/profile` | `GET` | Returns profile picture info for self or admin-selected npub |

### Docs/files routes

Implemented in `src/server/docs-routes.ts`.

| Route | Method(s) | Notes |
| --- | --- | --- |
| `/api/docs/directory` | `POST` | Creates a directory inside docs scope |
| `/api/docs/tree` | `GET` | Lists docs tree with optional hidden files |
| `/api/docs/file` | `POST`, `GET`, `PUT`, `DELETE` | Create/read/update/delete docs files |
| `/api/docs/file/raw` | `GET` | Returns base64-encoded file payload |
| `/api/docs/file/download` | `GET` | Returns a download response for small files |
| `/api/docs/file/copy` | `POST` | Copies a file |
| `/api/docs/file/move` | `POST` | Moves or renames a file |
| `/api/docs/git` | `POST` | Runs a constrained git action in a docs directory |
| `/api/docs/worktrees` | `POST` | Creates a git worktree |

Important boundary behavior:

- all path resolution is constrained to `workspaceScope.docsRoot`
- many file operations enforce max size and optimistic concurrency via `expectedMtimeMs`
- preview responses are shaped for the UI, not as raw filesystem reads

### Upload and attachment routes

Implemented in `src/server/upload-routes.ts` and `src/server/voice-note-routes.ts`.

| Route | Method(s) | Notes |
| --- | --- | --- |
| `/api/uploads/images` | `POST` | Multipart image upload, 10 MB limit, returns placeholder markup and public path |
| `/api/uploads/files` | `POST` | Multipart attachment upload, 25 MB limit, returns file placeholders |
| `/api/uploads/voice-notes` | `POST` | Multipart audio upload plus transcription, stored as attachment |

The upload APIs return structured JSON rather than the file body itself. The returned `publicPath` points at the authenticated `/uploads/...` serving layer.

### Chat routes

Implemented in `src/server/chat-routes.ts`.

| Route | Method(s) | Notes |
| --- | --- | --- |
| `/api/maple/models` | `GET` | Lists available chat models |
| `/api/chats` | `GET`, `POST` | List or create chat sessions |
| `/api/chats/:id` | `GET`, `PATCH`, `DELETE` | Inspect, rename, delete a chat |
| `/api/chats/:id/messages` | `GET`, `POST` | Transcript read and streamed message send |
| `/api/chats/:id/events` | `GET` | SSE for chat updates |

### Projects and todos

Implemented in `src/projects/project-api.ts` and `src/todos/todo-api.ts`.

| Route | Method(s) | Notes |
| --- | --- | --- |
| `/api/projects` | `GET`, `POST` | Lists or creates shared project records |
| `/api/projects/:id/apps` | `POST` | Links an app/folder into a project |
| `/api/npub-projects*` | mixed | Per-user project projection; CORS-enabled and allows NIP-98 fallback |
| `/api/todos` | `GET`, `POST` | Lists or creates encrypted todos for the current user |
| `/api/todos/:id` | `GET`, `PUT`, `PATCH`, `DELETE` | Per-item todo CRUD |

Boundary behavior:

- project creation validates existing directories and app ownership
- todo writes enforce owner scoping, app ownership, project existence, and rock/pebble/sand parent rules

### Scheduler, jobs, and Night Watch

| Route | Method(s) | Notes |
| --- | --- | --- |
| `/api/nightwatch*` | mixed | Night Watch session/report management |
| `/api/scheduler/jobs` | `GET`, `POST` | List or create scheduled jobs |
| `/api/scheduler/jobs/:id` | `PATCH`, `DELETE` | Update or remove a scheduled job |
| `/api/scheduler/jobs/:id/trigger` | `POST` | Manual job trigger |
| `/api/scheduler/jobs/:id/runs` | `GET` | Run history for a scheduled job |
| `/api/autopilot-jobs/definitions` | `GET`, `POST` | Job definition CRUD |
| `/api/autopilot-jobs/definitions/:id` | `GET`, `PATCH`, `DELETE` | Per-definition CRUD |
| `/api/autopilot-jobs/runs` | `GET`, `POST` | List or launch manager/worker runs |
| `/api/autopilot-jobs/runs/:id` | `GET` | Run status/detail |
| `/api/autopilot-jobs/runs/:id/stop` | `POST` | Stops linked sessions and marks the run stopped |

Scheduler and jobs are separate models at the HTTP layer too:

- scheduler routes manage durable recurring triggers
- autopilot-jobs routes manage reusable manager/worker definitions and ad hoc runs
- autopilot-jobs is also one of the API families that accepts NIP-98 fallback auth before handler dispatch

### Agent-chat subscriptions

Implemented in `src/server/agent-chat-routes.ts` with runtime state in `src/agent-chat/subscription-runtime.ts`.

| Route | Method(s) | Notes |
| --- | --- | --- |
| `/api/agent-chat/subscriptions` | `GET`, `POST` | Lists current workspace subscriptions or creates/updates one |
| `/api/agent-chat/subscriptions/:id` | `GET`, `DELETE` | Reads or removes a specific subscription |

Boundary behavior:

- this surface is browser-session oriented and gated by `ui:restricted`
- the HTTP handler itself is CRUD-only; the live work happens in `WorkspaceSubscriptionManager`
- creating a subscription provisions or reloads a workspace key, then opens an outbound SSE client connection to the remote workspace stream
- matching `record-changed` events trigger an authenticated record-history pull plus decrypt attempt inside the runtime, not inside the request/response path

### Gitea, git workflow, and SuperBased

| Route | Method(s) | Notes |
| --- | --- | --- |
| `/api/gitea/set-remote` | `POST` | Creates or updates the `gitea` remote for a session directory |
| `/api/gitea/push` | `POST` | Pushes after passing push-guard checks |
| `/api/gitea/pull` | `POST` | Pulls from `gitea` remote |
| `/api/gitea/commit-and-push` | `POST` | Stages all, commits, and pushes |
| `/api/gitea/remote-url` | `GET` | Returns clone URL and derived web URL |
| `/api/git/status` | `POST` | Git status with workflow context |
| `/api/git/branches` | `POST` | List branches |
| `/api/git/branch/create` | `POST` | Create a branch |
| `/api/git/branch/switch` | `POST` | Switch branches |
| `/api/git/worktrees` | `POST` | List worktrees |
| `/api/git/worktree/add` | `POST` | Add a worktree |
| `/api/git/worktree/remove` | `POST` | Remove a worktree |
| `/api/git/merge` | `POST` | Merge with optional report generation |
| `/api/superbased/health` | `GET` | Tier-1 signed upstream health check |
| `/api/superbased/records` | `GET` | Fetches delegated records and auto-decrypts delegate payloads |
| `/api/superbased/sync` | `POST` | Encrypts owner/delegate payloads and syncs them upstream |
| `/api/superbased/history` | `GET` | Fetches version history and can decrypt included payloads |
| `/api/superbased/storage/:objectId/download-url` | `GET` | Returns a presigned download URL |

Boundary behavior:

- `/api/git/*` is localhost-only
- `/api/gitea/*` and `/api/superbased/*` validate by session or user linkage inside the handler rather than generic cookie checks
- SuperBased is strictly app-less at this proxy layer and rejects other namespace modes

### MCP-facing routes

Implemented in `src/mcp/nip98-api.ts`, `src/mcp/wingman-api.ts`, and `src/identity/bot-crypto-api.ts`.

| Route | Method(s) | Notes |
| --- | --- | --- |
| `/api/mcp/nip98/sign` | `POST` | Tier 1 or Tier 2 NIP-98 signing |
| `/api/mcp/nip98/request-grant` | `POST` | Creates a domain grant for Tier 2 signing |
| `/api/mcp/nip98/grants` | `GET` | Lists grants for a session |
| `/api/mcp/nip98/grants/:id` | `DELETE` | Revokes a grant |
| `/api/mcp/nip98/status` | `GET` | Returns tier availability |
| `/api/mcp/nip98/subscribe` | `GET` | Browser SSE for interactive Tier 2 signing |
| `/api/mcp/nip98/sign-response` | `POST` | Browser posts signed events back |
| `/api/mcp/bot-crypto/encrypt` | `POST` | NIP-44 encrypt using unlocked bot key |
| `/api/mcp/bot-crypto/decrypt` | `POST` | NIP-44 decrypt using unlocked bot key |
| `/api/mcp/bot-crypto/sign-event` | `POST` | Signs a Nostr event with unlocked bot key |
| `/api/mcp/wingman/apps` | `GET` | Lists registered apps |
| `/api/mcp/wingman/apps/action` | `POST` | Starts/stops/builds apps |
| `/api/mcp/wingman/logs` | `GET` | Session or app logs |
| `/api/mcp/wingman/sessions` | `GET`, `POST` | List or create sessions from agent context |
| `/api/mcp/wingman/sessions/stop` | `POST` | Stop another same-owner agent-managed session |
| `/api/mcp/wingman/caprover/apps` | `GET` | Lists tracked CapRover apps |
| `/api/mcp/wingman/caprover/deploy` | `POST` | Deploys from image or tarball |
| `/api/mcp/wingman/skills` | `GET` | Lists skills |
| `/api/mcp/wingman/skills/load` | `GET` | Loads one skill body |
| `/api/mcp/wingman/generate-image` | `POST` | Image generation plus artifact registration |
| `/api/mcp/wingman/artifacts` | `GET`, `POST` | List/register artifacts |
| `/api/mcp/wingman/project` | `GET` | Resolve the caller session’s linked project |
| `/api/mcp/wingman/memory` | `GET`, `POST`, `DELETE` | Search/save/delete memories |
| `/api/mcp/wingman/artifact/pin` | `GET`, `POST` | Read or set the pinned artifact |

Important boundary behavior:

- MCP Wingman and Gitea routes trust `sessionId` as the primary caller identity
- bot-crypto applies per-session and global rate limits
- Tier 2 NIP-98 signing uses browser SSE plus a pending-request store to round-trip signatures back to the waiting local caller

### Other delegated API families registered in `api-routes.ts`

These are live parts of the current boundary even though they are not the focus of this step:

- `/api/apps*` and `/api/workspace/tree`
- `/api/apps/starter-projects*`
- `/api/agent-chat/subscriptions*`
- `/api/caprover*`
- `/api/bot-keys*`
- `/api/provider/<openai|anthropic|openrouter>/*`
- `/api/billing/team`, `/api/billing/usage`
- `/api/system/restart/status`, `/api/system/restart`, `/api/system/cleanup`
- `/api/admin/users*`, `/api/admin/ports`
- `/api/feature-flags*`

## Request and response shaping

Current response conventions are consistent enough to matter:

- most handler responses use `Response.json(...)`
- most validation failures return `400` with `{ error: string }`
- auth failures are usually `401` or `403`
- balance failures return `402` with `balance` and `required`
- not-found cases generally return `404` with `{ error: "Not found" }`
- successful collection reads commonly shape as `{ items }`, `{ jobs }`, `{ sessions }`, `{ chats }`, `{ artifacts }`, or `{ settings }`
- many create actions return `{ resource }` with `201`

Non-JSON exceptions:

- SSE endpoints return `text/event-stream`
- `/api/artifacts/:id/raw` streams the artifact file
- `/api/docs/file/download` returns a download response with `content-disposition`
- `/uploads/...` returns raw file bodies after per-user access checks
- the provider proxy can return upstream JSON or upstream SSE

Special shaping worth noting:

- `/api/user/settings` masks secret-looking values on read
- upload endpoints return placeholder text plus storage paths rather than echoing raw binary
- session event streams emit explicit `heartbeat` and `status` events in addition to proxied upstream data

## SSE and live-update paths

There are five important live-update channels in the current middleware layer:

1. `GET /api/sessions/:id/events`
   - proxies the agent `/events` stream when the adapter exposes one
   - otherwise emits a heartbeat-only stream for native SDK adapters
   - reconnects to upstream on transient failures and emits `status` events describing the retry

2. `GET /api/sessions/subscribe`
   - Wingman-owned SSE for session lifecycle updates
   - scoped per viewer `npub`
   - receives `session-started`, `session-updated`, `session-stopped`, and `session-deleted`

3. `POST /api/chats/:id/messages`
   - returns a streamed SSE response while Maple chat completion events are arriving
   - ends with `data: [DONE]`

4. `GET /api/chats/:id/events`
   - chat-specific SSE for private chat sessions
   - currently mostly an init plus keepalive channel rather than a second full message stream

5. `GET /api/mcp/nip98/subscribe`
   - browser-side SSE channel for interactive Tier 2 NIP-98 signing
   - also used as a hook point to trigger pending bot-key unlock behavior

Separate from those browser-facing channels, `WorkspaceSubscriptionManager` also maintains outbound SSE client connections to remote workspace backends. That stream is initiated from the agent-chat runtime rather than exposed as a Wingman browser endpoint, but it is now part of the live middleware boundary.

All of these use keepalive comments or heartbeat events to survive browser/proxy idle timeouts.

## Background entry points that affect middleware behavior

The following startup jobs are part of the effective middleware story because they change what requests see:

- `rehydrateWarmSessions(...)` restores sessions after a warm restart
- `rehydrateOrphanedSessions(...)` reclaims surviving agent sessions after restart/crash
- `cleanupOrphanedAgentProcesses(...)` removes stale PM2-managed agent processes
- `reconcileAppsWithPM2(...)` reconciles app runtime state with the app registry
- `workspaceSubscriptionManager.startupReload()` restores persisted agent-chat subscriptions and reconnects workspace SSE clients
- `schedulerEngine.start()` loads enabled scheduler jobs and begins executing triggers
- `AgentRuntimeStatusPoller.start()` updates live session runtime state used by API reads
- `LiveMessagePersistenceLoop.start()` keeps persisted message history synchronized for session/chat reads
- `scheduleCleanup(...)` runs daily cleanup for image and attachment temp storage
- `FileWatcherRunner.start()` activates filesystem-triggered session automation
- `startTaskListener(...)` enables MG task assignment over Nostr when configured
- `createTriggerListener(...)` subscribes unlocked bot keys to Nostr trigger jobs
- `manager.on(...)` lifecycle handlers persist session state, generate/broadcast live updates, auto-unlock bot keys, and clear bot key memory when the last eligible session stops

## Important boundary-layer quirks

- `src/server.ts` remains the main router and dependency wiring file even after route extraction.
- `/api` dispatch still has an internal precedence order: browser logs first, then provider proxy and billing handlers, then the family-specific route tables in `api-routes.ts`.
- The API layer mixes three caller identities: browser session cookie, NIP-98 programmatic identity, and sessionId-based MCP/internal identity.
- Some route families are intentionally machine-local, while others are open to programmatic remote use if they can establish NIP-98 or session-linked identity.
- Session ownership is enforced at the normalized-`npub` layer rather than by opaque tenancy IDs.
- The provider proxy is not a generic open proxy. It only allows a fixed set of upstream model API paths and rewrites auth to the team billing provider key.
- `/api/npub-projects*` is the main exception to the otherwise same-origin JSON style: it adds permissive CORS response headers and handles preflight locally.
