# Wingmen As-Built Summary Report

Status: revised approval summary  
Reviewed against the live repository on 2026-04-06

## Scope

This summary is the approval-package rollup for the current `docs/asbuilt/` set and the live repository under `/Users/mini/code/wingmen`.

It is intended to replace the stale Flight Deck summary that still described:

- live refresh as a co-equal SSE plus polling model
- live conversation state as mirrored in both Dexie and `state.conversations`
- `AGENT_MODE` as an active overloaded runtime contract

## Repo docs reviewed for this revision

- `docs/asbuilt/architecture.md`
- `docs/asbuilt/data model.md`
- `docs/asbuilt/middleware.md`
- `docs/asbuilt/frontend.md`
- `docs/asbuilt/design.md`
- `docs/asbuilt/important.md`
- `docs/asbuilt/issues.md`

## Repo markdown changed in this revision

- updated `docs/asbuilt/frontend.md`
- updated `docs/asbuilt/important.md`
- updated `docs/asbuilt/issues.md`
- created `docs/asbuilt/summary-report.md`

## Executive summary

Wingman is a Bun-based control plane for AI-agent sessions, local app/runtime orchestration, browser-based operations, and Nostr-linked identity tooling. The server composition root is still `src/server.ts`, and the browser shell is still largely composed through `src/ui/app.js`, even though route and feature logic have been partially extracted into smaller modules.

The frontend remains a hybrid architecture rather than a completed Dexie-first migration. Live messages and live session status now flow through Dexie-backed stores in `src/ui/live/db.js`; sessions, apps, scheduler, and Night Watch also have Dexie-backed browser caches. Projects, files, private chat, and much of the shell still rely on imperative rendering and the mutable singleton from `src/ui/state/index.js`.

For live sessions, the current browser contract is SSE-first, not polling-first. The browser bootstraps with catch-up fetches, then connects `EventSource` to `/api/sessions/:id/events`. `src/server/session-events.ts` emits an initial `transport` event so the browser can distinguish full `event-stream` sessions from `heartbeat-only` streams. The retired `state.conversations` mirror is no longer part of the live-session path; Dexie `MessageStore` is the browser-side source of truth for live transcripts, and current consumers such as the live view, status indicators, queue modal, and clipboard/export paths read from Dexie instead of an in-memory conversation mirror.

The polling nuance matters. The repo docs previously simplified this too far. The current implementation in `src/ui/live/refresh-controller.js` and its tests is:

- stable `event-stream` sessions: bootstrap fetch, then SSE with polling off
- active sessions whose runtime status is `running`: 1s compatibility polling can remain active even when stream mode is `event-stream`
- `heartbeat-only` sessions: 1s compatibility polling while SSE provides liveness/transport state
- degraded or disconnected sessions: 2s recovery polling until reconnect and healthy transport resume

That means the stale Flight Deck summary was wrong to describe live refresh as a permanent co-equal SSE plus polling model, but the live repo is also not strictly "SSE only after bootstrap" in every active runtime state.

The environment contract has also narrowed. `AGENT_SPAWN_MODE` is the primary spawn-mode setting and `AGENTAPI_BIN` is the primary binary-path setting. `AGENT_MODE` is now compatibility-only input: `AGENT_MODE=pm2` maps to spawn mode only when `AGENT_SPAWN_MODE` is not set to a valid value, `AGENT_MODE=tmux` maps to the legacy tmux binary only when `AGENTAPI_BIN` is unset, and `AGENT_MODE=standard` is a deprecated no-op.

Startup handling for the Wingman core app record is also different from the stale summary. Ordinary startup no longer deletes same-root legacy app entries. `src/server/bootstrap/wingman-core-registry.ts` reconciles or adopts `wingman-core` and preserves remaining same-root legacy entries. Deletion is now an explicit operator action through `cleanupLegacyWingmanRootApps(...)`, not normal boot behavior.

## Validation notes

This revision was validated by direct source inspection of:

- `src/ui/live/refresh-controller.js`
- `src/ui/live/refresh-controller.test.js`
- `src/ui/live/db.js`
- `src/ui/state/index.js`
- `src/config.ts`
- `src/server/bootstrap/wingman-core-registry.ts`
- the current `docs/asbuilt/` markdown set listed above

## Bottom line for approval

The approval-package summary should now state:

- live refresh is SSE-first with bounded polling windows, not a permanent co-equal SSE plus polling loop
- the live `state.conversations` mirror is retired and Dexie `MessageStore` is the browser-side live transcript authority
- `AGENT_MODE` is compatibility-only input, not the primary active contract
- ordinary startup preserves same-root legacy Wingman app records; explicit cleanup is separate
