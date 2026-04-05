# Wingman important maintenance caveats (as built)

Last reviewed against the live repository on 2026-04-06.

## Scope and source of truth

This document captures the non-obvious implementation rules, operational shortcuts, and sharp edges that matter when changing or operating Wingman.

Primary source of truth for this review:

- `docs/asbuilt/architecture.md`
- `docs/asbuilt/data model.md`
- `docs/asbuilt/middleware.md`
- `docs/asbuilt/frontend.md`
- `docs/asbuilt/design.md`
- `package.json`
- `src/index.ts`
- `src/server.ts`
- `src/config.ts`
- `src/agents/process-manager.ts`
- `src/mcp/stdio-server.ts`
- `src/server/static-assets.ts`
- `src/auth/nip98-auth.ts`
- `src/auth/request-context.ts`
- `src/ui/app.js`
- `src/ui/state/index.js`
- `src/ui/sessions/store.js`
- `src/ui/live/db.js`
- `src/ui/chat/`
- `src/apps/`
- `src/projects/`
- `src/caprover/`

## Startup is not read-only

- `bun start` runs `src/index.ts`, which runs the setup wizard before it imports `src/server.ts`. A failed or cancelled wizard exits the process before the server is even loaded.
- Server startup mutates local state. It creates directories under `~/Documents/Wingman`, `~/Documents/Wingman/users`, `tmp/uploads`, and `~/.wingmen`, and it can also create or update `out/agentapi`.
- `src/server/bootstrap/agentapi.ts` treats `downloads.json` as the release manifest for `agentapi`. It verifies SHA-256, writes `out/agentapi`, and writes a sibling `.version` file. Deleting the version file makes the next boot behave like an upgrade path even if the binary already exists.
- `src/index.ts` globally swallows a specific class of Nostr relay rejections (`Event rejected`, `AUTH required`, `rate-limited`, `blocked`) so those do not crash the whole process. Other uncaught exceptions still terminate the server.

## `AGENT_MODE` is overloaded

- `AGENT_MODE=tmux` still changes the default `agentapi` binary path from `out/agentapi` to `out/agentapi-tmux`.
- Agent persistence is now controlled by `AGENT_SPAWN_MODE=pm2`. `AGENT_MODE=pm2` is only a deprecated compatibility alias for that setting.
- Do not assume `AGENT_MODE` means one thing. In the live code it still carries legacy meaning for both agentapi binary selection and spawn behavior.

## Session launch is intentionally layered and partially degradable

- `ProcessManager.createSession()` does not just spawn a subprocess. It allocates a port, creates an in-memory session, then attempts several optional injections before spawn:
- bot key lookup and possible `AGENT_NSEC` injection
- MCP config injection
- Gitea credential injection
- billing proxy injection
- Most of these steps are best-effort. Failures are logged as non-fatal and the session may still launch in a degraded state.
- When billing injects `CODEX_HOME` plus an API key, `prepareCodexApiAuthHome()` writes `auth.json` into that directory with mode `0600`. That side effect happens during launch, not during a separate provisioning step.
- Project tracking is fire-and-forget after launch. Missing project linkage is not necessarily a launch failure.

## Agent transport and browser streaming are no longer 1:1

- Most agents still run behind the external `agentapi` binary, but Codex and OpenCode already have native SDK adapters behind feature flags.
- The stdio MCP server in `src/mcp/stdio-server.ts` is not the state authority. It runs inside the agent context and calls back into Wingman over HTTP.
- Native SDK adapters do not expose an upstream `/events` URL. In those cases `src/server/session-events.ts` serves a heartbeat-only SSE stream and the browser depends on the rest of the live sync path to stay current.
- If live updates look inconsistent for Codex/OpenCode native sessions, treat it as a hybrid transport problem, not just an SSE bug.

## Stop and restart behavior is conservative on purpose

- PM2-backed sessions are only marked stopped when the PM2 entry is actually gone. If `stopProcess()` or `deleteProcess()` fails and the process still exists, the session is left running and its port is not released.
- Warm restart recovery is marker-based and best-effort. `src/server/bootstrap/warm-restart.ts` only rehydrates sessions whose stored PID is alive and whose agent endpoint responds on the recorded port.
- After rehydration, `cleanupOrphanedAgentProcesses()` deletes PM2 agent processes that were not reclaimed. Restart bugs can come from reconciliation order, not just missing persistence.
- Automatic prompt dispatch waits for runtime stability, not just process existence. `waitForSessionPromptReadiness()` requires repeated `stable` polls, and Codex gets a longer readiness timeout than the other agents.

## Auth is layered, route-specific, and broader than it looks

- Cookie auth is the default browser path, but NIP-98 is not a global middleware. It is applied selectively by route families that explicitly opt in.
- `resolveNip98AuthContext()` rewrites bot-signed requests to the owner npub while preserving the bot signer in `actorNpub` and marking `delegatedByBot=true`.
- `/api/npub-projects*` is an important special case. If there is no session cookie but NIP-98 succeeds, the API route handler treats that caller as admin for project lookup/update purposes.
- Opening browser subscriptions can change bot-key availability. On SSE subscribe, the server first tries escrow auto-unlock; if that fails it asks the browser to decrypt the stored key material.

## The frontend is still a hybrid system

- `src/ui/app.js` is still the real composition root. Even when features are extracted into smaller modules, new top-level behavior usually still needs `app.js` wiring.
- The frontend is not Dexie-first end to end. Sessions, apps, scheduler, and Night Watch use Dexie-backed Alpine stores, but projects, files, private chat, and much of the shell still rely on the mutable singleton in `src/ui/state/index.js`.
- Live sessions are updated through both SSE and polling. SSE writes to Dexie, while legacy rendering paths still mirror data into `state.conversations`.
- Fixes to live rendering often need to consider both data paths. Repairing only the Dexie path or only the legacy in-memory path can leave half the UI stale.
- `scheduler` and `jobs` are treated as stable pages in the shell so Alpine-owned DOM is not torn down on routine rerenders.

## Static asset serving is manual and easy to break

- `src/server/static-assets.ts` is a custom asset server. Browser ESM loading depends on it returning the correct MIME type.
- Dynamic UI asset serving only derives explicit MIME overrides for `.js`, `.css`, `.json`, and `.map`. When adding files under `src/ui`, keep that constraint in mind.
- Top-level shortcuts like `/app.js` and a few other paths are hardcoded in `uiAssetMap`.
- Bare-module browser imports only work for vendor packages that are explicitly registered in `src/server.ts` with `registerVendorPackage(...)`.
- Adding a new client-side dependency can fail at runtime even if Bun installs it correctly, because the browser can only load packages the static asset service knows how to rewrite and serve.

## App routing depends on volatile runtime state

- App metadata is persisted in `data/apps.json` and aliases are persisted in `data/app-aliases.json`, but the port used for reverse proxying lives in the in-memory `runtimePortRegistry`.
- On startup, PM2 reconciliation tries to rebuild that runtime port map from PM2 metadata and port detection. If that reconstruction fails, a running app can still be treated as unavailable.
- Path and subdomain routing both depend on the same runtime port registry. Alias resolution only succeeds when all three are true:
- the alias exists
- the app is considered running
- a runtime port is registered
- WebSocket proxying is not implemented for either path routing or subdomain routing. Both code paths return HTTP 501.
- Routing diagnostics bypass the normal logging stack and append directly to `tmp/logs-routing.log`.

## App deploy behavior is local-repo centric

- CapRover deployment is tracked in SQLite, but the deploy payload is generated from the local app directory at deploy time.
- `createAppTarball()` depends on the system `tar` binary. This is an external runtime dependency, not a Bun-native archive implementation.
- Tarball exclusion is intentionally simple. It merges a fixed exclude list with a basic `.gitignore` parser that does not implement the full gitignore spec.
- The default exclude set removes `node_modules`, `.env*`, logs, coverage, SQLite files, and `dist`. If a project expects `dist` artifacts to be deployed, the current helper will silently omit them.
- CapRover tarball creation hard-fails if `captain-definition.json` is missing or excluded.

## Gitea integration mutates per-user credentials

- When Gitea is configured, session launch can inject scoped Git credentials and author identity into the agent subprocess environment.
- `ensureGiteaUser()` can reset the password of an existing per-user Gitea account in order to mint a fresh API token. That is normal in this codebase.
- Per-user Gitea credentials are stored in `userSettingsStore`, not in a dedicated Gitea-only database.

## Local CLIs and scripts have a few traps

- `package.json` still exposes useful operational entry points: `cli:*`, `appctl`, `build:bunker-client`, and `cleanports`.
- `scripts/wingman-appctl.ts` is only a deprecated shim. The maintained entry point is `clis/appctl.ts`.
- The shared CLI auth helper defaults to `http://127.0.0.1:3000` when `WINGMAN_URL` and `PORT` are absent, but the server config defaults to port `3600`. Local CLI calls often need an explicit `WINGMAN_URL` or `PORT`.
- `bun run cleanports` uses `lsof` and kills listeners across the configured agent port range. It is a recovery tool, but it is not Wingman-specific once pointed at those ports.
- Warm restart tooling exists in multiple forms (`scripts/warm-restart-manager.ts`, `scripts/warm-restart.sh`, `scripts/restart-wingman.ts`). The server-side restart flow is the marker-aware path, not just a blind respawn.

## Persistence is intentionally split and sometimes duplicated

- Wingman does not have one canonical relational schema. It uses several SQLite databases, multiple JSON registries, and browser IndexedDB caches.
- `projects` and `npub_projects` are related but distinct models. One is the shared project graph; the other is a per-user directory usage graph.
- `identity_users.roles` and `data/identity-roles.json` overlap. That duplication is live behavior, not dead legacy.
- `apps.json` and `app-aliases.json` remain authoritative for app registration and routing identity even though related runtime state is elsewhere.
- Browser Dexie databases are disposable read models, not the primary write authority.

## Maintenance heuristics that match the live code

- Treat startup, restart, and reconciliation paths as first-class product behavior. A change that looks harmless in a route handler can still break cold boot or warm recovery.
- When debugging “app unavailable” or “session disappeared” reports, check runtime reconstruction layers before touching persistence:
- PM2 state
- runtime port registry
- warm restart marker and rehydration
- browser Dexie cache versus server truth
- When touching frontend module boundaries, assume `src/ui/app.js` and `src/server/static-assets.ts` still define the real integration contract.
