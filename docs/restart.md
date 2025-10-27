# Wingman Warm Restart & UI Plan

## Objectives
- Restart the Wingman server from the UI without destroying active agent tmux panes or session history.
- Rehydrate in-memory state (process manager, UI dashboards, message caches) after restart by leveraging persisted metadata.
- Present a dedicated Wingman card in the Apps view with log tailing plus a restart control, instead of the full app management surface.

## Warm Restart Flow
1. **Restart action (UI → server)**  
   - Add a `POST /api/system/restart` (name tbd) handler invoked by the Wingman card.  
   - Handler writes `~/.wingmen/restart.json` containing restart intent, timestamp, and a list of session IDs flagged for preservation.  
   - Handler shells out to `scripts/warm-restart.sh` and returns 202 with task state (UI shows spinner + log stream).

2. **Shell script responsibilities**  
   - Gracefully stop the running Bun server (SIGTERM or existing shutdown command).  
   - Skip killing the `wingman-agents` tmux session.  
   - Relaunch Wingman via `bun run src/index.ts --warm-start` (or env flag).  
   - Exit non-zero if stop/start fails so the UI can surface errors.

3. **Cold start vs warm start**  
   - `src/server.ts` reads `~/.wingmen/restart.json` early.  
   - When the marker is present, **skip** `ensureWingmanAgentsSessionClean()` to preserve panes.  
   - After successful hydration (see below) delete the marker.  
   - If the marker is stale or hydration fails, log a warning and fall back to the cold-start cleanup path.

## Session Persistence & Rehydration
1. **Schema extension**  
   - Extend `sessions` table columns to include: `port`, `tmux_session`, `tmux_window`, `working_directory`, and latest `command` hash/args.  
   - Update `MessageStore.recordSession` to store these fields (via new parameters and SQL migration).  
   - Ensure all call sites (`manager` events, file watcher) pass the extra metadata from `SessionSnapshot`.

2. **Runtime hydration on warm start**  
   - On boot, if `restart.json` exists, load session rows from SQLite.  
   - For each row, verify the `tmux_session`/`tmux_window` still exists (`tmux list-windows`).  
   - Reconstruct `ProcessManager` entries: populate maps, ports, command metadata, and attach log readers by reattaching to the tmux pane output (tail via `tmux capture-pane -p -S -100`).  
   - Re-run `syncSessionMessages(sessionId, true)` to repopulate message cache.  
   - For mismatches (missing tmux window, occupied port) log warnings, fall back to cold-stop cleanup for that entry, and notify UI via system status endpoint.

3. **Stop events**  
   - On deliberate cold stop (`ctrl+c` or non-warm boot) remove the restart marker, kill `wingman-agents`, and continue current behavior.  
   - Guard warm stop so a manual `bun start` without marker continues to clean tmux.

## UI Adjustments
1. **Wingman card** (`src/ui/app.js`)  
   - Detect `app.id === "wingman-core"` and render a slimmed component:  
     - Log tail viewer (reuse existing preview but extend to live streaming).  
     - `Restart Wingman` primary button that calls `/api/system/restart`.  
     - Optional secondary button to open full logs dialog.  
     - Remove controls for start/stop/build/edit/remove; display current status + last restart timestamp.  
   - Show a warning badge if the warm restart script reports failure or hydration falls back to cold start.

2. **Log streaming**  
   - Introduce `/api/system/logs` (or reuse websocket) providing live Bun server logs for the UI card.  
   - Ensure the stream continues across restarts by rehydrating the log buffer from the restart marker or by tailing a log file.

3. **Progress feedback**  
   - When restart initiates, disable the button, show spinner, and poll a status endpoint (e.g., `/api/system/restart/status`) until the new server confirms hydration complete.  
   - On success, reload app/session lists so UI reflects reattached agents.

## Safety Checks & Questions
- **Tmux verification:** Decide whether missing panes should abort warm restart entirely or just trigger cold cleanup for that session.  
- **Port collisions:** Handle the case where preserved agents still listen on ports already reclaimed by another process.  
- **Auth & access:** Confirm the restart endpoint is restricted to authenticated UI users (current Admin UI assumptions).  
- **Script location:** Do we embed `warm-restart.sh` under `scripts/` and ship alongside the repo? Ensure executable permissions.  
- **Out-of-band restarts:** Document that manual `ctrl+c` + `bun start` performs a cold boot; operators wanting warm behavior must trigger via UI or run the script directly.

## Implementation Order
1. Extend `sessions` schema + update persistence writes and migrations.  
2. Add warm-start flag detection in `src/server.ts`, skipping tmux cleanup when present.  
3. Implement ProcessManager hydration path using persisted metadata + tmux inspection.  
4. Create restart marker writer, shell script, and API endpoint.  
5. Update UI card rendering + restart workflow for Wingman.  
6. Document operational flow (this file), add README/docs cross-link, and test warm restart manually.

