# Wingmen As-Built Summary Report — 2026-04-08

Status: current summary rollup  
Reviewed against the live repository on 2026-04-08

## Scope

This report rolls up the current `docs/asbuilt/` set against the live repository under `/Users/mini/code/wingmen`.

The manager prompt for this step did not supply a concrete goal or task ID, so this file uses the requested summary title and the current live-repo review date as the step anchor.

## As-built docs reviewed

- `docs/asbuilt/architecture.md`
- `docs/asbuilt/data model.md`
- `docs/asbuilt/middleware.md`
- `docs/asbuilt/frontend.md`
- `docs/asbuilt/design.md`
- `docs/asbuilt/important.md`
- `docs/asbuilt/issues.md`

## Live code reviewed for this rollup

- `docs/architecture.md`
- `src/index.ts`
- `src/server.ts`
- `src/config.ts`
- `src/server/session-events.ts`
- `src/server/bootstrap/wingman-core-registry.ts`
- `src/ui/app.js`
- `src/ui/sessions/store.js`
- `src/ui/live/refresh-controller.js`
- `src/ui/todos/state.js`

## Executive summary

Wingmen is still a Bun-based local control plane for agent-session orchestration, browser-based operations, Nostr-linked identity flows, app/runtime management, and MCP-backed tooling. The runtime composition root is still `src/server.ts`, and the browser composition root is still `src/ui/app.js`, even though both areas have ongoing extraction into smaller modules.

The frontend remains a hybrid architecture rather than a completed Dexie-first migration. Live transcripts, live session status, session catalog, apps, scheduler, and Night Watch now have real Dexie-backed browser projections. Projects, files, private chat, and much of the shell still depend on imperative rendering plus the mutable singleton in `src/ui/state/index.js`.

Live session refresh is SSE-first, but not strictly SSE-only in all healthy states. The current browser flow is bootstrap fetch plus `/api/sessions/:id/events`, with server-emitted `transport` events distinguishing `event-stream` from `heartbeat-only`. `state.conversations` is no longer part of the active live-session path; Dexie `MessageStore` is the effective browser-side transcript authority.

The current polling behavior is narrower than older summaries implied, but it still exists:

- stable `event-stream` sessions can run with polling off
- sessions whose runtime status is `running` can keep lightweight 1 second compatibility polling even when transport mode is `event-stream`
- `heartbeat-only` sessions keep 1 second compatibility polling while SSE provides liveness
- degraded or disconnected sessions use 2 second recovery polling until transport recovers

The environment contract has narrowed. `AGENT_SPAWN_MODE` and `AGENTAPI_BIN` are the active configuration knobs. `AGENT_MODE` is compatibility-only input: `pm2` is a fallback spawn-mode hint, `tmux` is only a legacy binary-path fallback when `AGENTAPI_BIN` is unset, and `standard` is an accepted deprecated no-op.

Startup now preserves legacy same-root Wingman app records instead of deleting them during ordinary boot. `ensureWingmanCoreRegistration(...)` reconciles or adopts `wingman-core` and leaves remaining same-root legacy entries in place. Explicit cleanup exists as `cleanupLegacyWingmanRootApps(...)`, but during this review I did not find a supported admin/API/CLI entrypoint that actually exposes that cleanup helper to operators.

## Current approval conclusions

The current as-built package supports these conclusions:

- live refresh is SSE-first with bounded polling windows, not a permanent co-equal SSE plus polling loop
- the live `state.conversations` mirror is retired and Dexie `MessageStore` is the browser-side live transcript authority
- `AGENT_MODE` is compatibility-only input, not the primary active contract
- ordinary startup preserves same-root legacy Wingman app records; explicit cleanup is separate from normal boot
- the frontend migration is real but incomplete; describing the product as fully Dexie + Alpine would still be inaccurate

## Current unresolved follow-up issues

The live repository still shows these evidence-backed issues from `docs/asbuilt/issues.md`:

- session background refreshes do not reliably propagate into the imperative shell, because the Dexie-backed sessions store updates `items` but the remaining imperative surfaces are not consistently re-rendered
- `/todos` is still treated as a valid SPA route server-side, but `src/ui/app.js` no longer resolves it into a browser page and `src/ui/todos/state.js` has auto-load disabled
- legacy same-root Wingman app cleanup is described in code but no operator-facing execution path was found in the reviewed repo
- jobs load failures still collapse into loading/empty-state behavior instead of a first-class error state

If an operator-facing cleanup path exists outside this repository or is generated dynamically, that was not discoverable from the live code reviewed here.

## Validation notes

This step was validated by direct source inspection of the as-built docs listed above plus the live files listed in the review inputs section.

No automated tests were run for this step, per repository instruction. No app source, config, or test files were changed in this update.
