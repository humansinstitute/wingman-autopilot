# Wingman architecture (as built)

Last reviewed against the live repository on 2026-04-07.

## App purpose

Wingman is a Bun-based orchestration server and browser control plane for running, supervising, and tooling AI agent sessions from one local service.

In the live repository it currently does all of the following:

- launches and tracks agent runtimes for `codex`, `claude`, `goose`, `opencode`, and `gemini`
- serves the browser SPA for `/home`, `/live`, `/apps`, `/projects`, `/todos`, `/chat`, `/settings`, `/privacy`, `/nightwatch`, `/scheduler`, `/triggers`, `/jobs`, and `/files`/`/docs`
- exposes a large local HTTP API for sessions, apps, auth, docs/files, MCP callbacks, jobs, scheduler, billing, Git/Gitea, Nostr, and SuperBased
- brokers per-agent MCP tool calls back into Wingman over HTTP
- manages browser auth, bot keys, delegated NIP-98 auth, and bot-key export/signing flows
- stores local operational state for sessions, archives, apps, aliases, projects, todos, jobs, billing, memory, feature flags, user settings, and artifacts
- proxies user-managed web apps through `/host/<alias>` or optional subdomain routing

## Local repo / root path

- Local repository root during this review: `/Users/mini/code/wingmen`
- Bun module entry from [`package.json`](/Users/mini/code/wingmen/package.json): `src/index.ts`
- Main runtime composition root: [`src/server.ts`](/Users/mini/code/wingmen/src/server.ts)

## Role in the wider stack

The repository-level architecture note in [`docs/architecture.md`](/Users/mini/code/wingmen/docs/architecture.md) positions `wingmen` as the runtime harness beside Tower, Flight Deck, Yoke, and related services.

That suite relationship is documented in-repo, but the code in this repository is still self-contained enough to run as a standalone local control plane. I did not find a hard runtime dependency on Tower or Flight Deck for Wingman core boot.

## Runtime boundaries

### 1. Wingman server process

The main process starts in [`src/index.ts`](/Users/mini/code/wingmen/src/index.ts).

As built, boot currently works like this:

1. `src/index.ts` installs process-level rejection/exception handlers.
2. It runs the setup wizard in [`src/setup/wizard.ts`](/Users/mini/code/wingmen/src/setup/wizard.ts).
3. After setup, it dynamically imports [`src/server.ts`](/Users/mini/code/wingmen/src/server.ts).
4. `src/server.ts` loads config, constructs stores/services, installs access rules, starts background loops, and calls `Bun.serve(...)`.

`src/server.ts` is still the dominant composition hotspot. Route handlers have been extracted into `src/server/*.ts`, but `src/server.ts` still owns a large amount of startup and wiring logic.

### 2. Agent runtime processes

Session runtimes are managed by [`ProcessManager`](/Users/mini/code/wingmen/src/agents/process-manager.ts).

Current execution modes:

- direct child-process spawn (`agentSpawnMode: "bun"`)
- PM2-managed spawn (`agentSpawnMode: "pm2"`)

Current transport/runtime split:

- default path: agents run behind the external `agentapi` binary and Wingman talks to them through [`AgentApiAdapter`](/Users/mini/code/wingmen/src/agents/agentapi-adapter.ts)
- native seams already exist for [`CodexAdapter`](/Users/mini/code/wingmen/src/agents/codex-adapter.ts) and [`OpenCodeAdapter`](/Users/mini/code/wingmen/src/agents/opencode-adapter.ts)

That means the agent process boundary and the agent protocol boundary are no longer identical.

### 3. Browser runtime

The browser app is served directly by Wingman from [`src/ui/`](/Users/mini/code/wingmen/src/ui), [`public/`](/Users/mini/code/wingmen/public), and selected vendor modules exposed by [`src/server/static-assets.ts`](/Users/mini/code/wingmen/src/server/static-assets.ts).

The browser entry is [`src/ui/index.html`](/Users/mini/code/wingmen/src/ui/index.html), which loads `/app.js`.

The frontend is mixed-mode today:

- [`src/ui/app.js`](/Users/mini/code/wingmen/src/ui/app.js) is still the SPA shell and major orchestration file
- newer areas use Dexie + Alpine stores backed by IndexedDB
- older areas still use imperative rendering and module-local state

This migration is real but incomplete. It would be inaccurate to describe the frontend as fully Dexie/Alpine already.

### 4. External services and binaries

The live code expects or optionally integrates with:

- `agentapi` in `out/agentapi`
- local agent CLIs on `$PATH` unless overridden by env vars
- PM2 when PM2 mode is enabled
- Nostr relays
- optional Gitea
- optional CapRover
- optional SuperBased / Flux Adaptor API
- Maple proxy for private chat
- OpenRouter-backed provider proxy for team billing mode

## Major subsystems

### Boot and config

- [`src/index.ts`](/Users/mini/code/wingmen/src/index.ts): process entrypoint
- [`src/setup/wizard.ts`](/Users/mini/code/wingmen/src/setup/wizard.ts): first-run setup gate
- [`src/config.ts`](/Users/mini/code/wingmen/src/config.ts): env parsing, defaults, agent definitions, routing mode, relay config, and integration URLs
- [`src/server/bootstrap/`](/Users/mini/code/wingmen/src/server/bootstrap): `agentapi` installation, warm restart, PM2 reconciliation/cleanup, and Wingman core registration

Notable current config behavior:

- agent types are `codex`, `claude`, `goose`, `opencode`, and `gemini`
- app routing mode can be path-based or subdomain-based
- session transport remains SSE-first
- some legacy env names such as `AGENT_MODE` are still supported with deprecation warnings

### HTTP server and route composition

Top-level request routing still happens in [`src/server.ts`](/Users/mini/code/wingmen/src/server.ts), with `/api/*` dispatch centralized through [`createApiRouteHandler`](/Users/mini/code/wingmen/src/server/api-routes.ts).

Important implemented route families include:

- sessions and archives: [`src/server/session-api-routes.ts`](/Users/mini/code/wingmen/src/server/session-api-routes.ts)
- auth and identity profile: [`src/server/auth-routes.ts`](/Users/mini/code/wingmen/src/server/auth-routes.ts)
- apps and workspace tree: [`src/server/apps-api-routes.ts`](/Users/mini/code/wingmen/src/server/apps-api-routes.ts)
- starter projects: [`src/server/starter-projects-routes.ts`](/Users/mini/code/wingmen/src/server/starter-projects-routes.ts)
- private chat and chat events: [`src/server/chat-routes.ts`](/Users/mini/code/wingmen/src/server/chat-routes.ts), [`src/server/chat-events.ts`](/Users/mini/code/wingmen/src/server/chat-events.ts)
- docs/files/git actions inside the workspace surface: [`src/server/docs-routes.ts`](/Users/mini/code/wingmen/src/server/docs-routes.ts)
- provider proxy and billing: [`src/server/provider-proxy-routes.ts`](/Users/mini/code/wingmen/src/server/provider-proxy-routes.ts), [`src/server/billing-routes.ts`](/Users/mini/code/wingmen/src/server/billing-routes.ts)
- uploads and voice notes: [`src/server/upload-routes.ts`](/Users/mini/code/wingmen/src/server/upload-routes.ts), [`src/server/voice-note-routes.ts`](/Users/mini/code/wingmen/src/server/voice-note-routes.ts)
- feature flags: [`src/server/feature-flags-routes.ts`](/Users/mini/code/wingmen/src/server/feature-flags-routes.ts)
- system and restart operations: [`src/server/system-routes.ts`](/Users/mini/code/wingmen/src/server/system-routes.ts)
- admin users and port assignment: [`src/server/admin-users-routes.ts`](/Users/mini/code/wingmen/src/server/admin-users-routes.ts)
- agent-chat subscriptions: [`src/server/agent-chat-routes.ts`](/Users/mini/code/wingmen/src/server/agent-chat-routes.ts)

The `/api` surface currently includes, at minimum:

- `/api/sessions*`, `/api/delegate-sessions*`, `/api/archive*`
- `/api/apps*`, `/api/workspace/tree`
- `/api/projects*`, `/api/npub-projects*`
- `/api/todos*`
- `/api/nightwatch*`
- `/api/scheduler*`
- `/api/autopilot-jobs*`
- `/api/chats*`, `/api/maple/models`
- `/api/auth*`, `/api/identity/profile`
- `/api/admin/users*`, `/api/admin/ports`
- `/api/docs*`, `/api/directories`, `/api/uploads*`
- `/api/feature-flags*`, `/api/system*`, `/api/user/settings*`
- `/api/mcp/*`, `/api/bot-keys*`, `/api/mcp/bot-crypto*`
- `/api/git/*`, `/api/gitea*`, `/api/ngit*`
- `/api/superbased*`
- `/api/provider/*`
- `/api/caprover*`

### Agent orchestration

[`src/agents/process-manager.ts`](/Users/mini/code/wingmen/src/agents/process-manager.ts) is the main orchestration seam.

It currently handles:

- session creation, stop, delete, and rehydration
- port allocation
- launch command resolution
- MCP config injection via [`src/agents/mcp-injector.ts`](/Users/mini/code/wingmen/src/agents/mcp-injector.ts)
- billing launch config injection
- Gitea credential helper injection
- adapter creation and session adapter lookup
- session lifecycle event emission for browser subscribers

Related modules under [`src/agents/`](/Users/mini/code/wingmen/src/agents):

- adapter selection: [`src/agents/agent-adapter.ts`](/Users/mini/code/wingmen/src/agents/agent-adapter.ts)
- PM2 helpers: [`src/agents/pm2-wrapper.ts`](/Users/mini/code/wingmen/src/agents/pm2-wrapper.ts)
- ecosystem generation: [`src/agents/ecosystem-generator.ts`](/Users/mini/code/wingmen/src/agents/ecosystem-generator.ts)
- runtime polling: [`src/agents/agent-status-poller.ts`](/Users/mini/code/wingmen/src/agents/agent-status-poller.ts)
- agent HTTP client helpers: [`src/agents/agent-client.ts`](/Users/mini/code/wingmen/src/agents/agent-client.ts)

### Auth, identity, and access control

The implemented auth model has multiple layers:

- cookie-backed browser auth in [`src/auth/session-cookie.ts`](/Users/mini/code/wingmen/src/auth/session-cookie.ts)
- request-scoped auth context in [`src/auth/request-context.ts`](/Users/mini/code/wingmen/src/auth/request-context.ts)
- access policy evaluation in [`src/auth/access-control.ts`](/Users/mini/code/wingmen/src/auth/access-control.ts)
- delegated NIP-98 resolution in [`src/auth/nip98-auth.ts`](/Users/mini/code/wingmen/src/auth/nip98-auth.ts)

Important current behavior:

- a verified NIP-98 signer can become the effective request identity
- bot-signed NIP-98 requests are mapped back to the owning user when that mapping exists
- login/bootstrap flows provision and manage per-user bot-key material through `src/identity/*`

Identity and bot-key concerns are split across:

- [`src/identity/`](/Users/mini/code/wingmen/src/identity)
- [`src/auth/keyteleport.ts`](/Users/mini/code/wingmen/src/auth/keyteleport.ts)
- [`src/mcp/nip98-api.ts`](/Users/mini/code/wingmen/src/mcp/nip98-api.ts)

### Persistence

Persistence is local and mostly file-backed SQLite, with a smaller number of JSON registries.

Examples confirmed in code:

- main live session/message store: [`data/wingman.db`](/Users/mini/code/wingmen/data/wingman.db) via [`src/storage/message-store.ts`](/Users/mini/code/wingmen/src/storage/message-store.ts)
- session archive store: [`data/session-archive.db`](/Users/mini/code/wingmen/data/session-archive.db)
- identity users: [`data/identity-users.db`](/Users/mini/code/wingmen/data/identity-users.db)
- todos: [`data/todos.db`](/Users/mini/code/wingmen/data/todos.db)
- per-user project tracking: [`data/npub-projects.db`](/Users/mini/code/wingmen/data/npub-projects.db)
- team billing: [`data/team-billing.db`](/Users/mini/code/wingmen/data/team-billing.db)
- jobs: [`data/jobs.db`](/Users/mini/code/wingmen/data/jobs.db)
- prompt queue: [`data/prompt-queue.db`](/Users/mini/code/wingmen/data/prompt-queue.db)

Additional SQLite-backed stores also exist for feature flags, artifacts, grants, memory, starter projects, file watchers, scheduler state, and user settings.

JSON-backed registries confirmed in code:

- [`data/apps.json`](/Users/mini/code/wingmen/data/apps.json)
- [`data/app-aliases.json`](/Users/mini/code/wingmen/data/app-aliases.json)
- [`data/identity-roles.json`](/Users/mini/code/wingmen/data/identity-roles.json)

This is an embedded single-node persistence model. I did not find Postgres, Redis, or another external database used as the source of truth for Wingman core state.

### Browser UI

The browser app is still centered on [`src/ui/app.js`](/Users/mini/code/wingmen/src/ui/app.js), but several data-heavy surfaces now use Dexie-backed Alpine stores.

Confirmed Dexie-backed areas:

- live session/message cache: [`src/ui/live/db.js`](/Users/mini/code/wingmen/src/ui/live/db.js)
- sessions store: [`src/ui/sessions/store.js`](/Users/mini/code/wingmen/src/ui/sessions/store.js)
- apps store: [`src/ui/apps/store.js`](/Users/mini/code/wingmen/src/ui/apps/store.js)
- scheduler store: [`src/ui/scheduler/db.js`](/Users/mini/code/wingmen/src/ui/scheduler/db.js), [`src/ui/scheduler/store.js`](/Users/mini/code/wingmen/src/ui/scheduler/store.js)
- Night Watch store: [`src/ui/nightwatch/db.js`](/Users/mini/code/wingmen/src/ui/nightwatch/db.js), [`src/ui/nightwatch/store.js`](/Users/mini/code/wingmen/src/ui/nightwatch/store.js)
- chat component store: [`src/ui/live/chat-component.js`](/Users/mini/code/wingmen/src/ui/live/chat-component.js)

Still-true architectural seam:

- old path: imperative UI orchestration in `src/ui/app.js`
- newer path: Dexie + Alpine islands

### Real-time transport

The browser-facing real-time model is primarily SSE, not WebSockets.

Confirmed SSE paths:

- per-session event streaming: [`src/server/session-events.ts`](/Users/mini/code/wingmen/src/server/session-events.ts)
- session lifecycle broadcast: [`src/server/session-broadcaster.ts`](/Users/mini/code/wingmen/src/server/session-broadcaster.ts)
- chat streaming/events: [`src/server/chat-events.ts`](/Users/mini/code/wingmen/src/server/chat-events.ts)
- NIP-98 browser signing subscription: [`src/ui/nip98/signing-listener.js`](/Users/mini/code/wingmen/src/ui/nip98/signing-listener.js)

Important current limitation:

- subdomain app proxying explicitly does not fully support WebSocket proxying yet; [`src/server/subdomain-proxy.ts`](/Users/mini/code/wingmen/src/server/subdomain-proxy.ts) returns an error for WebSocket upgrade attempts

### MCP control plane

Each agent gets a stdio MCP server from [`src/mcp/stdio-server.ts`](/Users/mini/code/wingmen/src/mcp/stdio-server.ts).

That stdio server is agent-side, but the stateful authority remains the Wingman HTTP server. MCP tools generally call back into Wingman APIs rather than mutating state locally inside the MCP process.

The MCP surface currently includes tool modules for:

- sessions and apps
- Git/Gitea/worktree operations
- CapRover deployment
- NIP-98 signing and access grants
- Nostr read/sign/publish flows
- memory save/search/delete
- image generation
- SuperBased fetch/sync/history/storage operations
- artifact pinning and project lookup

### Apps, projects, and hosted web apps

App lifecycle is separate from agent session lifecycle.

Core pieces:

- app registry: [`src/apps/app-registry.ts`](/Users/mini/code/wingmen/src/apps/app-registry.ts)
- app process manager: [`src/apps/app-process-manager.ts`](/Users/mini/code/wingmen/src/apps/app-process-manager.ts)
- alias registry: [`src/apps/app-alias-registry.ts`](/Users/mini/code/wingmen/src/apps/app-alias-registry.ts)
- runtime port registry: [`src/apps/runtime-port-registry.ts`](/Users/mini/code/wingmen/src/apps/runtime-port-registry.ts)
- app discovery: [`src/apps/app-detector.ts`](/Users/mini/code/wingmen/src/apps/app-detector.ts)

Current routing behavior:

- path mode proxies web apps under `/host/<alias>`
- optional subdomain mode proxies `<alias>.<base-domain>`
- Wingman chooses the public app URL based on configured routing mode

### Projects, todos, jobs, scheduler, and Night Watch

These are related operator features, but they are implemented as separate subsystems:

- projects: [`src/projects/`](/Users/mini/code/wingmen/src/projects)
- todos: [`src/todos/`](/Users/mini/code/wingmen/src/todos)
- scheduler: [`src/scheduler/`](/Users/mini/code/wingmen/src/scheduler)
- jobs: [`src/jobs-api.ts`](/Users/mini/code/wingmen/src/jobs-api.ts), [`src/jobs-db.ts`](/Users/mini/code/wingmen/src/jobs-db.ts), [`src/jobs-dispatch.ts`](/Users/mini/code/wingmen/src/jobs-dispatch.ts)
- Night Watch: [`src/nightwatch/`](/Users/mini/code/wingmen/src/nightwatch)

Current terminology drift worth preserving in documentation:

- the product/UI surface says "Jobs"
- the implementation still uses the older internal/API name `autopilot-jobs` in routes and store names

That is a compatibility seam, not a separate product.

### Nostr, git, Gitea, and SuperBased

Nostr is not just auth glue in this repository. It is part of automation, signing, delegation, and collaboration behavior.

Key areas:

- Nostr listeners/executors: [`src/nostr/`](/Users/mini/code/wingmen/src/nostr)
- bot identity and delegated signing: [`src/identity/`](/Users/mini/code/wingmen/src/identity), [`src/mcp/wingman-signer.ts`](/Users/mini/code/wingmen/src/mcp/wingman-signer.ts)
- ngit/NIP-34 collaboration: [`src/ngit/`](/Users/mini/code/wingmen/src/ngit)
- Gitea and workflow helpers: [`src/gitea/`](/Users/mini/code/wingmen/src/gitea), [`src/git/`](/Users/mini/code/wingmen/src/git)
- SuperBased adaptor integration: [`src/superbased/`](/Users/mini/code/wingmen/src/superbased)

## Entry points

Implemented entry points confirmed in the repo:

- Bun server entry: `bun start` or `bun run src/index.ts`
- browser SPA: [`src/ui/index.html`](/Users/mini/code/wingmen/src/ui/index.html)
- agent-side stdio MCP server: [`src/mcp/stdio-server.ts`](/Users/mini/code/wingmen/src/mcp/stdio-server.ts)
- CLI utilities under [`clis/`](/Users/mini/code/wingmen/clis) for sessions, delegate sessions, apps, deploy, scheduler, jobs, and bot-key export
- operational scripts under [`scripts/`](/Users/mini/code/wingmen/scripts), including warm restart helpers

## Build and deployment shape

### Build shape

As built, Wingman mostly runs from source:

- backend runtime: Bun + TypeScript ESM
- frontend modules: served directly from `src/ui/`
- vendor browser modules: served from `node_modules` through the static asset service

One explicit frontend prebuild is present:

- `bun run build:bunker-client`
- input: [`src/ui/identity/bunker-client.ts`](/Users/mini/code/wingmen/src/ui/identity/bunker-client.ts)
- output: [`public/vendor/bunker-client.js`](/Users/mini/code/wingmen/public/vendor/bunker-client.js)

One explicit runtime binary bootstrap is present:

- [`src/server/bootstrap/agentapi.ts`](/Users/mini/code/wingmen/src/server/bootstrap/agentapi.ts)
- installs the platform-correct `agentapi` binary into `out/agentapi`

### Deployment shape

What is clearly implemented in this repository:

- Wingman can deploy tracked apps to CapRover
- Wingman can run registered apps and, optionally, agent sessions through PM2
- warm restart support exists through [`scripts/warm-restart-manager.ts`](/Users/mini/code/wingmen/scripts/warm-restart-manager.ts) and [`src/server/bootstrap/warm-restart.ts`](/Users/mini/code/wingmen/src/server/bootstrap/warm-restart.ts)

What remains uncertain from repo code alone:

- I did not find a repository-owned production manifest for deploying Wingman core itself
- because of that, the exact production deployment mechanism for the Wingman server is not clear from this repository alone

## Operational seams that matter

### 1. `src/server.ts` is still the main composition hotspot

Even after route extraction, `src/server.ts` still owns:

- startup/bootstrap
- store and service construction
- access rule registration
- background loop startup
- SPA/static asset routing
- app proxy behavior
- final `Bun.serve(...)` request handling

### 2. `ProcessManager` is the critical orchestration seam

Session launch behavior converges in [`src/agents/process-manager.ts`](/Users/mini/code/wingmen/src/agents/process-manager.ts).

Changes to session semantics will usually belong there or in helpers called from there, not in the HTTP route layer.

### 3. Agent transport and agent process are now separate abstractions

This matters because:

- native adapters bypass some `agentapi` assumptions
- browser event streaming falls back to heartbeat-only SSE for native adapters
- readiness, billing, and event behavior can differ by adapter type

### 4. Frontend migration is active, not finished

Any UI change still has to choose between:

- the large imperative shell in `src/ui/app.js`
- the newer Dexie + Alpine store-based path

### 5. Workspace scoping is the main isolation seam

User isolation is enforced primarily through:

- request auth context
- workspace scope resolution
- access-control checks
- path safety utilities
- ownership checks in app/project/todo/session routes

### 6. Store migrations are distributed

Many SQLite-backed stores self-migrate on startup with local schema checks and `ALTER TABLE` logic. There is no single central migration framework.

### 7. Warm restart is a real operational feature

Warm restart is not just planned. The live code writes restart markers, tracks restart state, rehydrates sessions, and cleans up orphaned PM2/session state.

### 8. App management and agent management are adjacent but distinct

The codebase manages both long-lived registered apps and shorter-lived agent sessions. They share some process and routing machinery, but they are separate concepts with separate stores and route families.
