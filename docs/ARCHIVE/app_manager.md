# Wingman App Manager Specification

## Goal

Create a manual-registration app management subsystem ("Wingman Running") that lets operators start, stop, restart, rebuild, and observe long-running web applications from Wingman via UI controls, HTTP APIs, and MCP tools. It should also control the Wingman server itself using the same workflow.

## Scope

- Manage user-defined web apps that expose lifecycle scripts (typically via `package.json`).
- Run commands in dedicated tmux sessions so apps remain active in the background.
- Provide status reporting, error surfacing, and log access for each app.
- Add an "Apps" dashboard page with per-app controls.
- Expose management endpoints for Wingman agents through HTTP + MCP.
- Persist manual app registrations; no automatic discovery in v1.
- Defer secrets management, remote deployments, and historical analytics for later iterations.

## Architecture Overview

1. **Registry Layer** (new `AppRegistry` service):
   - Stores app definitions in `data/apps.json`.
   - Supports CRUD: register app, update overrides, remove app, list apps.
   - Schema per app:
     ```json
     {
       "id": "uuid-or-slug",
       "label": "Human Name",
       "root": "/abs/path/to/app",
       "scripts": {
         "start": "bun run start",
         "stop": "bun run stop",
         "restart": "bun run restart",
         "build": "bun run build"
       },
       "tmuxSession": "wingman-app-messenger",
       "notes": "optional context"
     }
     ```
   - During registration, attempt to read `package.json` to prefill scripts; allow overrides and validation. Non-Node apps can skip auto-detect and rely on manual command entry.
   - Provide helper `discoverScripts(root)` that reads `package.json` and returns supported script names.

2. **Process Supervisor** (new `AppProcessManager` module):
   - Ensures a tmux session exists per app (`tmux new-session -d -s <session> -c <root>`).
   - Runs lifecycle commands via `tmux send-keys` + `Enter`, optionally using helper shell wrappers to capture exit codes.
   - Maintains in-memory state machine:
     - `status`: `idle`, `running`, `stopping`, `restarting`, `building`, `failed`.
     - `lastExitCode`, `lastAction`, `updatedAt`.
   - Serializes conflicting actions (e.g., queue restart until stop completes).
   - Uses `tmux has-session` + `tmux display-message -p "#{session_attached}"` to determine if the app is still running; fall back to log-based heuristics if necessary.
   - Captures output by piping every session through `tmux pipe-pane -o 'cat >> data/app-logs/<id>.log'`.
   - Exposes methods:
     - `getStatus(appId)`
     - `start(appId)`
     - `stop(appId)`
     - `restart(appId)`
     - `build(appId)`
     - `tailLogs(appId, lines = 100)`

3. **Wingman Self-Restart**:
   - Treat Wingman server as a special app entry (`id: "wingman-core"`).
   - Register a restart script (e.g., `bun run scripts/restart-wingman.ts`) that:
     1. Spawns a detached process to launch the new server instance.
     2. Gracefully shuts down the current process.
   - Hide start/stop buttons if not applicable; expose only restart/build as needed.

4. **HTTP API Extensions** (under `/api/apps`):
   - `GET /api/apps`: return registry entries merged with live status.
   - `POST /api/apps`: register a new app; request body includes root path and optional command overrides.
   - `PUT /api/apps/:id`: update scripts, label, or notes.
   - `DELETE /api/apps/:id`: remove registration and optionally kill tmux session.
   - `POST /api/apps/:id/actions`: body `{ "action": "start" | "stop" | "restart" | "build" }`.
   - `GET /api/apps/:id/logs?tail=n`: return last `n` lines (default 100) from `data/app-logs`.
   - Respond with detailed error messages when commands fail (exit code, truncated stderr).
   - Enforce sequential execution by rejecting concurrent conflicting actions with 409 responses.

5. **MCP Tool Bridge**:
   - Define tool namespace `apps`.
   - Available functions:
     - `listApps()`: fetch via `GET /api/apps`.
     - `appAction({ id, action })`: call `/actions`.
     - `tailAppLogs({ id, lines })`.
   - Ensure metadata includes status and script availability so agents can decide which actions make sense.

6. **UI: Apps Dashboard** (new route `src/ui/pages/apps.tsx`):
   - Layout:
     - Header with "Apps" title and "Add App" button.
     - Grid/list of cards: `name`, `status` badge, last action timestamp, action buttons (enabled if script exists).
     - Per-card log preview (last few lines) with button to open full modal.
     - Dedicated card or section for "Wingman Server" entry highlighting restart control.
   - "Add App" dialog:
     - Inputs: name, absolute path, optional script overrides (prefilled via discovery call), optional tmux session name.
     - On submit: POST to `/api/apps`, then refresh list.
   - Error handling: show toast/snackbar when actions fail, display exit code snippet.
   - Poll `GET /api/apps` periodically (e.g., every 5s) for live status updates.

7. **CLI / Auxiliary Scripts**:
   - Optional helper `bun run scripts/register-app.ts` for CLI-driven registration when not using UI.
   - Provide `scripts/restart-wingman.ts` (or similar) to support self-restart sequence.

## Data Persistence

- `data/apps.json`: JSON array or keyed object storing registry entries. Only mutate via `AppRegistry` to prevent corruption.
- `data/app-logs/`: directory storing rolling log files per app (rotate when exceeding size threshold, e.g., 10 MB).
- Consider file locking or atomic writes (`fs.writeFileSync` with temp file, rename) to avoid race conditions.

## Error/Status Reporting

- Supervisor aggregates:
  - Exit codes and truncated error output (keep in memory for immediate feedback).
  - Human-readable messages describing the last state transition.
  - Timestamp for `lastSuccessAt` and `lastFailureAt`.
- API responses surface these details; UI renders them in tooltips or expandable panels.
- In case tmux session is missing, auto-mark status as `stopped` and allow "start" to recreate it.

## Sequencing Rules

- Only one active action per app at a time.
- `restart` behaves as `stop` → `start`; if stop fails, do not proceed to start.
- `build` runs independently but cannot execute while `start`/`stop` is active (queue or reject with `409`).
- Provide simple in-memory queue per app or reject with message instructing user to retry after current action settles.

## Security & Permissions

- Commands execute with Wingman server permissions; ensure only trusted paths are registered.
- (Future) Add allow-list or prompt for confirmation when registering commands outside expected directories.
- Sanitize user input to prevent command injection (store scripts verbatim but invoke via shell wrapper that only runs declared command).

## Observability

- Integrate existing logging framework: log lifecycle events (`start`, `stop`, `restart`, `build`, `error`) with metadata (`appId`, `exitCode`, `duration`).
- Provide aggregated metrics hooks for future dashboards (counts of running apps, failures, etc.).

## Future Enhancements (Out of Scope for v1)

- Auto-discovery of apps in configured directories.
- Per-app environment variable management or secret injection.
- Remote host orchestration (SSH, containers, Kubernetes).
- Health checks and uptime monitoring.
- Historical timelines and notifications.
- Configurable command templates (`preStart`, `postStop`, etc.).
