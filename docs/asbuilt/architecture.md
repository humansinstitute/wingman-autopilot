# Wingman architecture (as built)

Last reviewed against the live repository on 2026-04-05.

## App purpose

Wingman is a Bun-based orchestration server and browser UI for running and supervising AI agent sessions from one control plane. In the current codebase it does five things at once:

- launches and tracks agent runtimes such as Codex, Claude, Goose, OpenCode, and Gemini
- serves the browser UI for `/home`, `/live`, `/apps`, `/projects`, `/todos`, `/chat`, `/settings`, `/nightwatch`, `/scheduler`, and `/triggers`
- brokers agent-side MCP tooling back into Wingman over HTTP
- manages user identity, bot keys, NIP-98 grants, and Nostr-triggered automation
- stores local operational state for sessions, apps, projects, todos, jobs, billing, and related metadata
- EDIT it also does url producing for registering and running apps

## Local repo / root path

- Local repository root during this review: `/Users/mini/code/wingmen`
- Main runtime entry from `package.json`: `src/index.ts`
- Main HTTP composition root: `src/server.ts`

## Runtime boundaries

### 1. Wingman server process

The main application process is Bun running `src/index.ts`, which first runs the setup wizard (`src/setup/wizard.ts`) and then dynamically imports `src/server.ts`.

`src/server.ts` is the operational composition root. It:

- loads environment/config from `src/config.ts`
- ensures the `out/agentapi` binary exists via `src/server/bootstrap/agentapi.ts`
- instantiates stores and service objects
- wires route handlers and access rules
- starts `Bun.serve(...)`
- starts background loops such as agent status polling, live message persistence, warm-session rehydration, scheduler execution, Nostr listeners, and cleanup tasks

### 2. Agent runtime processes

Agent sessions are separate runtimes managed by `ProcessManager` in `src/agents/process-manager.ts`.

As built, there are two execution modes:

- `bun` spawn mode: Wingman starts the agent command directly with `Bun.spawn(...)`
- `pm2` spawn mode: Wingman writes PM2 ecosystem entries and starts sessions through PM2 helpers in `src/agents/pm2-wrapper.ts`

Most agents still run behind the external `agentapi` binary. Wingman talks to them through adapter abstractions in `src/agents/agent-adapter.ts`.

There is already a seam for native adapters:

- default: `AgentApiAdapter`
- feature-flagged: `CodexAdapter` and `OpenCodeAdapter`

That means the agent protocol boundary is no longer identical to the process boundary.

### 3. Browser runtime

The browser UI is served directly by Wingman from `src/ui/`, `public/`, and selected `node_modules` packages via `src/server/static-assets.ts`.

The frontend is not a fully migrated single pattern yet. The current state is mixed:

- `src/ui/app.js` is still the main bootstrap/orchestration file for the SPA shell
- several newer areas use Dexie + Alpine stores with IndexedDB-backed caching
- older areas still use imperative DOM rendering and module-local state

Real-time browser updates primarily use SSE, not WebSockets. Session event streaming is proxied by `src/server/session-events.ts`.

### 4. External services

Wingman depends on several external or semi-external systems at runtime:

- `agentapi` binary in `out/agentapi`
- agent CLIs on `$PATH`
- PM2 when PM2 mode is enabled
- Nostr relays for identity, triggers, and task events
- optional Gitea
- optional CapRover
- optional SuperBased / Flux Adaptor API
- Maple proxy for private chats
- OpenRouter-backed provider proxy for team billing mode

## Major subsystems

### Boot and configuration

- `src/index.ts` is the process entrypoint
- `src/setup/wizard.ts` gates first-run configuration and writes `.env` values when needed
- `src/config.ts` centralises runtime config, defaults, agent command templates, and integration env vars
- `src/server/bootstrap/*` handles startup concerns such as `agentapi` installation, warm restart markers, and PM2 reconciliation/cleanup

### HTTP server and route composition

`src/server.ts` still owns top-level routing and dependency wiring, even though route logic has been increasingly extracted into `src/server/*.ts`.

Current route families include:

- `src/server/api-routes.ts` for `/api/*` dispatch
- `src/server/session-api-routes.ts` for live sessions and archives
- `src/server/auth-routes.ts` for login, logout, keyteleport, and identity profile lookups
- `src/server/chat-routes.ts` for private chat sessions
- `src/server/docs-routes.ts` for docs/file operations inside the viewer workspace
- `src/server/apps-api-routes.ts`, `src/server/starter-projects-routes.ts`, `src/server/admin-users-routes.ts`, `src/server/system-routes.ts`, and related route modules
- `src/server/subdomain-proxy.ts` plus inline path-based handling for app routing

The codebase has partially refactored route logic out of `src/server.ts`, but `src/server.ts` still remains the dominant composition file.

### Agent orchestration

`src/agents/process-manager.ts` is the core runtime manager. It is responsible for:

- allocating agent ports
- creating/stopping/deleting sessions
- injecting MCP config and agent env
- injecting Gitea git credentials
- injecting billing proxy config
- creating adapter instances
- emitting lifecycle events for browser subscribers
- rehydrating sessions after restart

Supporting agent pieces live under `src/agents/`:

- adapter layer and agent client helpers
- PM2 wrapper and ecosystem generation
- log reading
- status polling
- MCP config injection

### Auth, identity, and access control

The implemented auth model has three layers:

- browser session cookies via `src/auth/session-cookie.ts`
- request-scoped auth context via `src/auth/request-context.ts`
- access policy checks via `src/auth/access-control.ts`

NIP-98 is also a first-class path for programmatic callers:

- `src/auth/nip98-auth.ts` resolves verified signers into effective request identity
- bot-signed requests can act on behalf of the mapped owner npub

Identity and bot-key concerns live under `src/identity/` and `src/auth/keyteleport.ts`. Login time also provisions per-user bot keys when absent.

### Persistence

Persistence is local and mostly file-backed. The dominant pattern is Bun SQLite databases under `data/`, with a few JSON registries.

Examples visible in the live code:

- `data/wingman.db` for sessions/messages and related tables
- `data/identity-users.db`
- `data/todos.db`
- `data/npub-projects.db`
- `data/setup.db`
- shared or adjacent SQLite files for scheduler, CapRover tracking, Night Watch, memory, starter projects, and feature flags
- JSON registries such as `data/apps.json`, `data/app-aliases.json`, and `data/identity-roles.json`

This is an embedded single-node persistence model. I did not find a repository-level Postgres, Redis, or external DB dependency for core Wingman state.

### Browser UI

The browser entry is `src/ui/index.html`, which loads `/app.js`.

As built, the frontend has two architectural styles running side by side:

- legacy imperative rendering concentrated in `src/ui/app.js` and many view/helper modules
- newer Dexie + Alpine stores for live sessions, apps, scheduler, jobs, and Night Watch

Dexie-backed areas currently include:

- `src/ui/live/db.js`
- `src/ui/sessions/store.js`
- `src/ui/apps/store.js`
- `src/ui/scheduler/db.js` and `src/ui/scheduler/store.js`
- `src/ui/nightwatch/db.js` and `src/ui/nightwatch/store.js`

This means "Dexie + Alpine migration target" is partially implemented, not complete.

### MCP control plane

Each agent gets a stdio MCP server from `src/mcp/stdio-server.ts`.

That MCP server does not directly mutate Wingman state in-process. Instead it calls back into Wingman over HTTP routes under `/api/mcp/wingman/*` and related MCP HTTP endpoints.

This split matters:

- stdio MCP server runs in the agent-side process context
- Wingman remains the stateful authority on sessions, apps, memories, grants, artifacts, and integrations

### Apps, projects, and deploy operations

App registration and lifecycle are separate from agent sessions.

- app registry: `src/apps/app-registry.ts`
- app process control: `src/apps/app-process-manager.ts`
- alias routing and runtime port registry: `src/apps/*`
- project linking: `src/projects/project-store.ts` and `src/projects/project-api.ts`
- per-user project tracking by directory: `src/projects/npub-project-store.ts`

Deploy-related support exists for tracked apps through CapRover, not for the Wingman server itself:

- `src/caprover/*`
- app deployment endpoints exposed through the API
- CLI wrappers under `clis/deploy.ts` and related commands

### Scheduling, automation, and night operations

There are three related automation subsystems:

- scheduler: `src/scheduler/*`
- autopilot jobs: `src/jobs-api.ts`, `src/jobs-db.ts`, `src/jobs-dispatch.ts`
- Night Watch: `src/nightwatch/*`

They overlap but are not the same subsystem:

- scheduler manages recurring or trigger-based jobs
- jobs manage manual/structured manager-worker execution runs
- Night Watch is the overnight or autonomous review/report path tied into session state

### Nostr, git, and external collaboration

Nostr is not just auth glue here. It also drives automation and collaboration features:

- NIP-98 grant and signing flows: `src/mcp/nip98-api.ts`, `src/mcp/browser-subscribers.ts`
- bot identity and delegated signing: `src/identity/*`, `src/mcp/wingman-signer.ts`
- task listener and trigger listener: `src/nostr/*`
- ngit/NIP-34 collaboration: `src/ngit/*`
- Gitea integration and git workflow support: `src/gitea/*`

## Entry points

Implemented entry points I found in the repo:

- server process: `bun start` or `bun run src/index.ts`
- browser UI: `src/ui/index.html` served by the Wingman server
- per-agent MCP server: `src/mcp/stdio-server.ts`
- CLI utilities under `clis/`, including sessions, apps, deploy, scheduler, and jobs helpers

Within the HTTP surface, the important operational entry families are:

- `/api/sessions*`
- `/api/apps*`
- `/api/auth*`
- `/api/chats*`
- `/api/docs*`
- `/api/todos*`
- `/api/projects*`
- `/api/feature-flags*`
- `/api/system*`
- `/api/mcp/*`
- `/api/ngit/*`
- `/api/gitea/*`
- `/api/git-workflow/*`
- `/api/superbased/*`
- `/api/provider/*`
- `/api/caprover/*`

## Build / deploy shape

### Build shape

As built, Wingman itself is mostly "run from source":

- backend runtime is Bun with TypeScript ESM
- frontend modules are served directly from `src/ui/`
- selected browser dependencies are served straight from `node_modules` through the static asset service

The one explicit frontend prebuild I found is:

- `bun run build:bunker-client`
  - builds `src/ui/identity/bunker-client.ts`
  - outputs `public/vendor/bunker-client.js`

The one explicit runtime binary bootstrap I found is:

- `src/server/bootstrap/agentapi.ts`
  - reads `downloads.json`
  - downloads the correct `agentapi` release for the current platform
  - installs it into `out/agentapi`

### Deploy shape

What is implemented clearly:

- Wingman can deploy tracked apps to CapRover
- Wingman can run its managed apps and, optionally, agent sessions through PM2
- warm restart support exists through `scripts/warm-restart-manager.ts` and the warm restart marker flow

What is not clearly defined in this repository:

- I did not find a Dockerfile, `captain-definition`, compose file, or repository-owned production manifest for deploying the Wingman server itself
- because of that, the production deployment mechanism for Wingman core is uncertain from repo code alone

## Integration points

### Local OS / filesystem

- user workspaces are derived from `DIRECTORY_DEF` and `FOLDERACCESS`
- non-admin users are scoped into alias-specific workspace directories by `src/workspaces/workspace-scope.ts`
- docs/file APIs are restricted to the resolved workspace/doc roots
- temp uploads live under `tmp/uploads`
- user operational data is created under `~/Documents/Wingman/users` and `~/.wingmen`

### Agent toolchain

- external agent CLIs are expected on `$PATH` unless overridden by env vars
- `agentapi` is an external binary managed at startup
- PM2 is used when app or session lifecycle is delegated to PM2

### Nostr

- connect relays come from config
- browser signing and grant approval flows bridge agent requests back to the user
- Nostr-triggered tasks and scheduling are first-class runtime behaviours, not add-ons

### Git / repo hosting

- Gitea integration handles user provisioning, credential helpers, repo operations, and git workflow APIs
- ngit support publishes git collaboration metadata to Nostr

### Billing / provider proxy

- team billing is handled by `src/billing/team-billing-service.ts`
- provider proxy routes forward to OpenRouter-backed upstreams while enforcing Wingman-issued session proxy tokens
- session launch config can inject provider credentials into agent sessions

### Chat / LLM completion

- private chat uses Maple proxy via `src/chat/maple-client.ts`
- provider proxy routes support OpenAI-compatible and Anthropic-compatible upstream shapes through OpenRouter

### Data sync / external data plane

- SuperBased integration provides authenticated fetch/sync/history/storage URL operations
- NIP-44 encryption and decryption is performed inside Wingman before syncing delegated records

## Architectural seams that matter for maintenance

### 1. `src/server.ts` is still the main composition hotspot

Route handlers are being extracted, but `src/server.ts` still owns too many responsibilities:

- startup/bootstrap
- store construction
- background jobs
- access rule registration
- route wiring
- SPA/static asset decisions
- app proxy behaviour

When changing server behaviour, expect cross-cutting edits unless more composition is pulled out first.

### 2. `ProcessManager` is the critical orchestration seam

`src/agents/process-manager.ts` is where session launch behaviour actually converges:

- command construction from config
- MCP injection
- Gitea env injection
- billing env injection
- spawn mode choice
- adapter creation
- lifecycle event emission

Changes to session semantics should usually land here or in a new helper called from here, not in route handlers.

### 3. Agent transport and agent process are no longer the same abstraction

The adapter layer means "how Wingman talks to an agent" is separate from "how the agent process was started."

That matters because:

- SSE proxying depends on whether an adapter exposes an upstream events URL
- native SDK adapters bypass some `agentapi` assumptions
- billing and readiness behaviour can differ by adapter type

### 4. Frontend architecture is intentionally in transition

The current frontend is mixed-mode:

- old path: imperative rendering through `src/ui/app.js`
- new path: Dexie + Alpine islands

Any UI work needs to decide which side of that seam it belongs on. Treating the migration as complete would be inaccurate.

### 5. Workspace scoping is the main per-user isolation seam

User isolation is primarily enforced by:

- request auth context
- workspace scope resolution
- access policy checks
- file/docs path guards
- ownership checks in app/project/todo routes

This is the boundary to review first when touching anything that reads or writes local files.

### 6. Local stores own their own schema drift

Many stores self-migrate on startup by checking columns/tables and applying `ALTER TABLE` logic. There is no single central migration framework.

That keeps the app self-contained, but it also means schema changes are distributed across many modules.

### 7. Warm restart and rehydration are operationally important

Warm restart is not theoretical. The code actively:

- writes restart markers
- preserves sessions during restart
- rehydrates known sessions from stored state
- cleans up PM2 orphans

Operational bugs around session persistence, PM2 state, or stored session metadata can surface as restart bugs rather than request bugs.

### 8. App management and agent management are adjacent but distinct

The codebase manages both:

- ephemeral or semi-ephemeral agent sessions
- longer-lived registered apps

They share PM2 helpers and some routing ideas, but they have different stores, lifecycle rules, and UI concepts. Mixing these concerns tends to make maintenance harder.

## Uncertainties noted during this review

- The repository clearly supports deploying user-managed apps through CapRover, but I could not confirm a single canonical production deployment method for the Wingman server itself from repo files alone.
- The docs mention a Dexie + Alpine migration target, but the live implementation is still hybrid rather than fully migrated.