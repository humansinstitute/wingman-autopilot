# Warm Restart Implementation Snapshot

## Current State (2025-02-16)

- `src/server.ts` now reads `~/.wingmen/restart.json` and skips the tmux cleanup step when a warm restart marker is present. After boot it calls `rehydrateWarmSessions`, which uses the persisted session records in SQLite to re-create `ProcessManager` entries and reconnect to running agents. Successful rehydration clears the marker and records the outcome for status reporting.
- A new `/api/system/restart` endpoint writes the warm restart marker, flips the shutdown flag to preserve agent sessions, and invokes `scripts/warm-restart.sh`. The script SIGTERMs the current Wingman process, waits for exit, then relaunches `bun run src/index.ts`. `/api/system/restart/status` exposes progress/outcome for the UI and other tooling.
- UI updates render Wingman as a dedicated card with restart progress, last outcome summary, error messaging, and a “Restart Wingman” action that calls the new API. Log viewing remains available, but start/stop/build controls are hidden.
- Session metadata now persists extra fields (`port`, `pid`, `tmux_session`, `tmux_window`, `working_directory`, `command`) in the `sessions` table. These are recorded on every session event and used during warm-start rehydration.
- Shutdown behaviour honours the `preserveSessionsOnShutdown` flag so warm restarts leave agent sessions running. Cold shutdowns still stop agents.
- Known gaps: TypeScript `bun x tsc --noEmit` fails because of legacy type definitions (unrelated to this change); warm restart flow still needs manual verification in a real environment.

## Follow-up Actions

1. **Manual verification of warm restart flow**
   - Start Wingman normally (`bun run src/index.ts`), launch one or more agent sessions, and confirm they persist in tmux (`tmux ls`).
   - Visit `/apps`, trigger “Restart Wingman”, wait for the server to restart, and confirm:
     - `~/.wingmen/restart.json` is created then removed after boot.
     - Active agent tmux windows remain running and appear in `/api/sessions`.
     - Message history is available immediately after restart.
     - UI status card reflects restored session count and any failures.

2. **Manual cold restart regression**
   - Stop Wingman with `Ctrl+C` (no warm marker) and ensure startup still performs tmux cleanup and no stale sessions remain.

3. **TypeScript hygiene (optional)**
   - Resolve the outstanding Bun type errors if `bun x tsc --noEmit` should pass (requires addressing long-standing definitions in `src/agents/runtime.ts` and form-data handling).

4. **Operational documentation**
   - Incorporate verification notes/screenshots into `docs/restart.md` or README once the workflow is validated.
