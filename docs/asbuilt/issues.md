# Wingmen As-Built Issues

Status: updated during step 7 on 2026-04-08  
Reviewed against the live repository and the refreshed step 1-6 as-built docs:

- `docs/asbuilt/architecture.md`
- `docs/asbuilt/data model.md`
- `docs/asbuilt/middleware.md`
- `docs/asbuilt/frontend.md`
- `docs/asbuilt/design.md`
- `docs/asbuilt/important.md`

## Scope

This note captures only current, evidence-based follow-up issues visible in the live repository. Resolved historical notes from the earlier as-built pass were removed from this issue list.

## Issues

### 1. Session background refreshes do not reliably propagate into the imperative shell

Problem:

- The browser now keeps the session catalog in the Dexie-backed Alpine store in `src/ui/sessions/store.js`, but the rest of the shell still depends on imperative rerenders.

Evidence:

- `initSessionsStore(...)` in `src/ui/sessions/store.js` only accepts `showToast`, `getIdentity`, `onUnauthorized`, and `onIdentityUpdate`, and `_setupLiveQuery()` only assigns `this.items`.
- `src/ui/app.js` still passes an `onItemsChanged` callback when it initializes the store, but that callback is not consumed by the store.
- `startSessionSubscriber(...)` in `src/ui/app.js` only calls `fetchSessions()` on connect/event.
- `fetchSessions()` updates store-backed data and some per-session caches, but it does not call `render()` or `syncMenuTabs()`.
- The home page remains imperative in `src/ui/views/home-view.js` and reads `sessionsStore().items` during render rather than through Alpine bindings.

Impact:

- Session create/stop/status changes received through `/api/sessions/subscribe` can leave the home page, menu tabs, and other imperative shell surfaces stale until another render happens for some unrelated reason.

Relevant areas:

- `src/ui/sessions/store.js`
- `src/ui/app.js`
- `src/ui/views/home-view.js`
- `src/ui/sessions/subscriber.js`

### 2. `/todos` is still advertised by the server, but the browser route is effectively absent

Problem:

- Todo APIs and UI modules still exist, but the current shell does not mount a todos page.

Evidence:

- `src/server.ts` still treats `/todos` and `/todos/*` as SPA shell routes.
- `getRouteFromPath(...)` in `src/ui/app.js` has no `/todos` branch, so `/todos` falls back to `home`.
- The render switch in `src/ui/app.js` has no todos branch.
- `src/ui/todos/state.js` has `ensureLoaded()` explicitly disabled with `// DISABLED - Never auto-load todos`.
- `src/ui/todos/view.js` still expects `window.navigateToTodos`, but no current app wiring exports that navigation helper.

Impact:

- The repo still carries a todo backend and a partially maintained frontend feature, but the main browser shell does not expose a working todos route. That is both product drift and a maintenance burden because the code still looks live at first glance.

Relevant areas:

- `src/server.ts`
- `src/ui/app.js`
- `src/ui/todos/state.js`
- `src/ui/todos/view.js`

### 3. Legacy same-root Wingman app cleanup has no operator-facing execution path

Problem:

- Startup now preserves legacy same-root Wingman app records and tells operators to run `cleanupLegacyWingmanRootApps(...)`, but that cleanup path is not wired into an actual admin/API/CLI flow in this repo.

Evidence:

- `ensureWingmanCoreRegistration(...)` in `src/server/bootstrap/wingman-core-registry.ts` logs warnings that preserved legacy entries should be removed by explicitly running `cleanupLegacyWingmanRootApps()`.
- Repository search during this review found `cleanupLegacyWingmanRootApps(...)` referenced only in `src/server/bootstrap/wingman-core-registry.ts` and its test file.
- `src/server/system-routes.ts` exposes generic system cleanup and restart operations, but not targeted legacy Wingman app cleanup.

Impact:

- Same-root duplicate app records can accumulate indefinitely in `apps.json` after startup reconciliation, while the codebase implies an explicit cleanup operation exists for operators even though no supported entrypoint was found.

Relevant areas:

- `src/server/bootstrap/wingman-core-registry.ts`
- `src/server/system-routes.ts`
- `src/server/system-cleanup.ts`

### 4. Jobs load failures are still collapsed into empty-state behavior

Problem:

- The jobs UI does not surface a first-class load error state for definitions or runs.

Evidence:

- `src/ui/jobs/store.js` catches and only logs failures in `init()`, `syncDefinitions()`, and `syncRuns()`.
- The same store keeps no persistent `error` field for the page to render.
- `src/ui/jobs/page.js` renders loading and empty states (`No job definitions yet`, `No runs found`) but does not render a failed-load state.

Impact:

- Backend, auth, or transport failures can look like an empty jobs system instead of a broken one, which makes operator diagnosis harder and increases the chance of acting on stale data.

Relevant areas:

- `src/ui/jobs/store.js`
- `src/ui/jobs/page.js`
- `src/ui/jobs/api.js`

## Summary

The most obvious current follow-up issues from this as-built pass are frontend state-propagation gaps, an effectively removed-but-still-present todos feature, an unreachable legacy Wingman app cleanup path, and the jobs page's missing error-state handling.
