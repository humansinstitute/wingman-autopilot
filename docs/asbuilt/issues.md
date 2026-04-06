# Wingmen As-Built Issues

Status: as-built working note  
Reviewed against live code on 2026-04-06  
Companion docs:

- `docs/asbuilt/architecture.md`
- `docs/asbuilt/data model.md`
- `docs/asbuilt/middleware.md`
- `docs/asbuilt/frontend.md`
- `docs/asbuilt/design.md`
- `docs/asbuilt/important.md`

## Scope

This note captures concrete follow-up issues surfaced by the as-built review. The list is limited to problems that are visible in the live code or the maintained as-built docs today.

## Issues

### 1. Live session refresh now treats SSE as the primary path

Evidence:

- `src/ui/live/refresh-controller.js` now owns the live refresh contract instead of `src/ui/app.js`.
- `src/server/session-events.ts` emits an initial `transport` SSE event so the browser can distinguish `event-stream` sessions from `heartbeat-only` native-adapter sessions.
- `src/ui/sessions/session-routing.js` activates live refresh through the controller, and no longer starts a co-equal steady-state polling loop for every live session.

Why this matters:

- Normal live sessions now stay on SSE after bootstrap instead of keeping an always-on conversation poll running beside the stream.
- Compatibility polling still exists, but it is explicit and bounded to heartbeat-only adapters and degraded recovery windows.

Runtime contract:

- Bootstrap still does an initial catch-up fetch for conversation, logs, queue, and status.
- Full event streams then run SSE-first with no steady-state polling.
- Heartbeat-only streams keep a 1s compatibility poll because the adapter does not expose message events to proxy.
- SSE failure windows fall back to a 2s recovery poll until the stream reconnects and reports a healthy transport again.

### 2. Legacy conversation mirror was retired in favor of Dexie

Evidence:

- `src/ui/live/db.js` now owns the canonical message contract through `MessageStore.upsertMessage()`, `MessageStore.getSessionMessages()`, and `MessageStore.syncFromServer()`.
- `src/ui/live/chat-component.js` subscribes to that store with `Dexie.liveQuery(...)`.
- `src/ui/views/live-view.js`, `src/ui/status/agent-indicators.js`, and `src/ui/utils/clipboard.js` read conversation data back from Dexie instead of an in-memory mirror.

Why this matters:

- Live messages now have one browser-side source of truth instead of a silent compatibility layer.
- Debugging live chat issues is simpler because SSE, catch-up fetches, prompt sends, copy/export, and both render paths all converge on the same store.

Practical follow-up:

- Keep new live-message consumers on the `MessageStore` contract rather than reintroducing transient mirrors.
- Maintain targeted tests around message normalization/equality so legacy payload shapes keep mapping cleanly into the canonical store.

### 3. Historical note: `AGENT_MODE` used to be overloaded

Evidence:

- Older builds used `AGENT_MODE` for both binary selection and spawn-mode compatibility.
- The live contract now splits those concerns: `AGENTAPI_BIN` is the primary binary-path setting, `AGENT_SPAWN_MODE` is the primary spawn-mode setting, and `AGENT_MODE` is compatibility-only input.

Why this matters:

- Operators still encounter legacy examples and old local env files.
- The compatibility bridge remains supported, so the precedence rules need to stay explicit in code and docs.

Current contract:

- `AGENT_SPAWN_MODE` wins over `AGENT_MODE=pm2`.
- `AGENTAPI_BIN` wins over `AGENT_MODE=tmux`.
- `AGENT_MODE=standard` is deprecated and has no effect.

### 4. Startup still mutates the app registry to remove legacy entries

Evidence:

- `src/server.ts:2040-2052` removes every app entry whose root matches the Wingman project root but whose id is not `wingman-core`.

Why this matters:

- Startup is doing cleanup work that can delete records while the server boots.
- That is easy to miss during maintenance and can mask migration history that might matter when debugging app registration or recovery.

Practical follow-up:

- Separate migration cleanup from ordinary startup, or make the destructive behavior much more explicit in logs and documentation.
- Add a targeted migration test so the removal policy is deliberate rather than incidental.

### 5. The jobs UI/store swallows refresh failures too quietly

Evidence:

- `src/ui/jobs/store.js:33-65` catches and only logs failures during `init`, `syncDefinitions`, and `syncRuns`.
- `src/ui/jobs/store.js:99-128` does the same for delete and stop actions after showing a toast.

Why this matters:

- A backend or auth failure can look like an empty or stale jobs page instead of a real error state.
- The UI has limited observability into why data did not load, which makes production support and regression debugging harder.

Practical follow-up:

- Surface a visible error state when the jobs data cannot be loaded, not just console warnings.
- Add tests for failed-load behavior so empty-state and error-state are not conflated.

## Summary

The largest remaining maintenance risks in the current Wingmen implementation are duplicated chat state, legacy environment semantics, startup-time registry mutation, and quietly swallowed jobs refresh failures. The live-refresh contract has now been narrowed so SSE is primary and polling is only a documented fallback.
