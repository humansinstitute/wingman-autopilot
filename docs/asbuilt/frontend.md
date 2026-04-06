# Wingman frontend (as built)

Last reviewed against the live repository on 2026-04-06.

## Scope and source of truth

This document describes the current browser-side frontend implemented under `src/ui/`.

Source of truth for this review:

- `docs/asbuilt/architecture.md`
- `docs/asbuilt/data model.md`
- `docs/asbuilt/middleware.md`
- the current UI shell in `src/ui/index.html` and `src/ui/app.js`
- the current state, store, and view modules under `src/ui/`

The current frontend is not a pure Dexie + Alpine application yet. It is a mixed architecture:

- `src/ui/app.js` is still the main SPA shell, route switcher, and integration point
- some domains now use Alpine stores backed by Dexie/IndexedDB caches
- other domains still use imperative rendering plus the mutable shared `state` singleton from `src/ui/state/index.js`

## Entry point and shell composition

The browser entry is `src/ui/index.html`, which serves:

- a static header and route chrome
- the session and job launch dialogs
- the pull-to-refresh indicator
- a single `<main id="app"></main>` mount point for page content

`src/ui/app.js` is still the frontend composition root. It is responsible for:

- bootstrapping config, identity restore, Alpine stores, and live modules
- deriving the current route from `window.location.pathname`
- wiring top-level navigation and `history.pushState` / `popstate`
- rendering the active page into `#app`
- coordinating cross-cutting concerns such as theme, tabs visibility, session launch, file modals, header indicators, and live session behavior

There is no client-side router framework. Route resolution is string-based and handled directly in `app.js`.

Implemented top-level pages currently rendered by the shell:

- `home`
- `live`
- `apps`
- `projects`
- `files`
- `settings`
- `chat`
- `privacy`
- `nightwatch`
- `scheduler`
- `jobs`

Notably, todo modules exist under `src/ui/todos/`, but they are not currently mounted by `app.js` and there is no active top-level todos route in the shell during this review.

## Frontend state ownership

### Shared shell state

`src/ui/state/index.js` exports a mutable singleton `state` that still owns most cross-page shell state, including:

- fetched config
- session logs and legacy in-memory conversations
- message drafts and prompt queues
- file browser, preview, transfer, and editor state
- archived session viewer state
- layout state for live split panels
- identity snapshot
- admin user state
- private chat state

This is the main non-Dexie state container. Most imperative views read it directly.

### Domain ownership by area

| Domain | Primary browser owner | Persistence/caching | Notes |
| --- | --- | --- | --- |
| Config | `state.config` in `app.js` | in-memory only | Loaded from `/api/config`; also seeds agent list and feature flags |
| Identity | `state.identity` via `src/ui/identity/state-manager.js` | `localStorage` + cross-tab `storage` sync | Also emits browser events and refreshes related filters |
| Session catalog | Alpine store `sessions` in `src/ui/sessions/store.js` | Dexie `WingmanLive.apiSessions` | Used for home, nav, tabs, and active-session selection |
| Live message cache | `MessageStore` in `src/ui/live/db.js` | Dexie `WingmanLive.messages` | The canonical live conversation read/write path for SSE, bootstrap fetches, queue sends, copy-to-clipboard, and both chat renderers |
| Live session status cache | `SessionStore` in `src/ui/live/db.js` | Dexie `WingmanLive.sessions` | Stores per-session runtime status used by live indicators |
| Apps catalog | Alpine store `apps` in `src/ui/apps/store.js` | Dexie `WingmanLive.apps` | App cards still render imperatively from store data |
| Night Watch | Alpine store `nightwatch` | Dexie `WingmanNightWatch.reports` and `.config` | Page itself is Alpine-templated |
| Scheduler | Alpine store `scheduler` | Dexie `WingmanScheduler.jobs` | Page itself is Alpine-templated |
| Jobs | Alpine store `autopilotJobs` | no Dexie cache | Alpine store is in-memory only |
| Projects | `createProjectState()` in `src/ui/projects/state.js` | in-memory only | Wrapped by `createProjectFeature()` and rendered imperatively |
| Files | `state.files` and `state.fileEditor` | mostly in-memory, plus localStorage prefs | File tree and preview are fetched on demand |
| Private chat | `state.chats`, `state.chatConversations`, `state.chatStreaming` | in-memory only | Separate from live agent sessions |
| Todos | `createTodoState()` in `src/ui/todos/state.js` | in-memory only | Feature exists in code but is not currently routed into the shell |

### Practical architectural boundary

As built, the frontend has two real state patterns running side by side:

1. Shell-and-feature state in the mutable `state` singleton.
2. Alpine stores for selected domains, with Dexie caches where the team has started the migration.

The migration target exists, but it is only partial in the current codebase.

## Refresh and subscription behavior

### Boot-time loading

At startup, `app.js` does this in order:

1. initializes theme, tabs visibility, mobile live behavior, and the live module
2. registers Alpine stores for Night Watch, Scheduler, Jobs, Sessions, and Apps
3. optionally registers the Alpine live chat store
4. renders immediately from whatever browser state is already available
5. fetches `/api/config`
6. restores identity from local persistence and login handoff paths
7. fetches sessions, and if authenticated also apps and npub-projects
8. starts NIP-98 signing listeners and session-list SSE subscription when authenticated

That means the shell prefers immediate render plus later hydration, not a blank-page bootstrap.

### Session list refresh

Session-list freshness uses two mechanisms:

- explicit sync via `sessionsStore().sync()` calling `/api/sessions`
- background SSE via `src/ui/sessions/subscriber.js`, which connects to `/api/sessions/subscribe` and triggers another sync whenever session lifecycle events arrive

This keeps the home page, nav tabs, and session indicators fresh without reloading the page.

### Live session refresh

Live session pages now use an SSE-first contract:

- `src/ui/live/sse-manager.js` opens `EventSource` connections to `/api/sessions/:id/events`
- `src/server/session-events.ts` sends an initial `transport` event so the browser knows whether the stream is full `event-stream` mode or `heartbeat-only`
- `src/ui/live/refresh-controller.js` performs the initial catch-up fetch, owns reconnect handling, and decides whether fallback polling is allowed
- incoming SSE messages are written into Dexie through `MessageStore.upsertMessage()`
- incoming SSE status events are written into Dexie through `SessionStore.updateStatus()`
- bootstrap fetches and immediate POST responses sync full conversations into Dexie through `MessageStore.syncFromServer(...)`
- the Alpine chat store subscribes to Dexie with `Dexie.liveQuery(...)`
- the non-Alpine live renderer hydrates its conversation DOM from Dexie on demand; there is no in-memory `state.conversations` mirror anymore

The caller split that previously depended on `state.conversations` now looks like this:

- active UI dependencies moved to Dexie reads:
  `src/ui/status/agent-indicators.js`, `src/ui/utils/clipboard.js`, `src/ui/sessions/queue-modal.js`, `src/ui/views/live-view.js`, and the live-session paths in `src/ui/app.js`
- compatibility callers retired:
  the `state.conversations` field in `src/ui/state/index.js` and the SSE mirror/update code in `src/ui/app.js`

Steady-state behavior by mode:

- normal proxied agent streams: bootstrap fetch once, then SSE-only refresh
- native heartbeat-only streams: bootstrap fetch, then 1s compatibility polling for conversation/status/queue while SSE provides liveness
- degraded SSE windows: temporary 2s recovery polling until the stream reconnects and reports a healthy transport again

### Live connection health

The live SSE manager provides:

- per-session connection tracking
- exponential backoff reconnects
- heartbeat freshness checks
- transport-mode tracking so the UI can distinguish full event streams from heartbeat-only compatibility mode

`src/ui/live/visibility-manager.js` is used to reconnect stale live streams when the tab becomes visible again.

### Dexie-backed domain refresh

The current Dexie-backed Alpine stores all follow the same basic pattern:

1. read cached rows from IndexedDB for instant render
2. subscribe with `Dexie.liveQuery(...)`
3. fetch fresh server data in the background
4. write server truth back to Dexie
5. let Alpine react to the Dexie update

This pattern is implemented for:

- sessions
- apps
- Night Watch
- scheduler

Jobs do not follow this pattern yet because the jobs store is Alpine-only and cacheless.

### Private chat refresh

Private chat is separate from live agent sessions:

- chat list and chat history are fetched on demand
- message send uses a streamed HTTP response parsed by `streamChatResponse(...)`
- streamed assistant chunks are stored in `state.chatStreaming`

An EventSource-based chat SSE manager exists in `src/ui/chat/chat-sse-manager.js`, but the current private chat page flow mainly uses streaming fetch responses rather than that subscriber.

## Data-to-UI boundaries

### Where API boundaries are explicit

The cleaner boundary is in the service-style modules:

- `src/ui/services/sessions.js`
- `src/ui/services/apps.js`
- `src/ui/services/config.js`
- page-local API modules such as `src/ui/nightwatch/api.js`, `src/ui/scheduler/api.js`, and `src/ui/jobs/api.js`

These mostly act as thin HTTP wrappers and leave UI state updates to callers.

### Where the boundary is still direct

The frontend is not uniformly service-driven yet. Several modules still call `fetch(...)` directly, including:

- `src/ui/projects/state.js`
- `src/ui/todos/state.js`
- `src/ui/views/settings-view.js`
- `src/ui/modals/directory-browser.js`
- `src/ui/modals/file-editor.js`
- parts of `src/ui/views/live-view.js`
- parts of `src/ui/identity/state-manager.js`

So the current browser boundary is partially extracted, not centralized.

### Current source-of-truth split

The effective data ownership split is:

- server APIs remain the authority for sessions, apps, projects, files, scheduler, jobs, Night Watch, identity, and chat
- Dexie caches are browser-side read models for selected domains
- `state` is still the authority for transient UI concerns, layout, and the not-yet-migrated feature areas

The codebase does not currently enforce a single “all UI reads come from Dexie” rule across the whole frontend.

## View composition

### Shell-level route rendering

`app.js` chooses a route and then calls a page renderer:

- `renderHome()` from `src/ui/views/home-view.js`
- `renderLive()` from `src/ui/views/live-view.js`
- inline `renderApps()` inside `app.js`
- `projectFeature.renderPage()` from `src/ui/projects/view.js`
- `renderFiles()` from `src/ui/views/files-view.js`
- `renderSettings()` from `src/ui/views/settings-view.js`
- `renderChat()` from `src/ui/chat/private-chat.js`
- `renderNightWatchPage()` from `src/ui/nightwatch/page.js`
- `renderSchedulerPage()` from `src/ui/scheduler/page.js`
- `renderJobsPage()` from `src/ui/jobs/page.js`
- `renderPrivacyPolicy()` from `src/ui/views/privacy-policy.js`

`render()` in `app.js` usually rebuilds `#app` imperatively. The two exceptions intentionally treated as “stable pages” are:

- `scheduler`
- `jobs`

Those pages avoid shell-level DOM teardown during same-route refreshes because Alpine owns ongoing form state there.

### Live view composition

The live page is the richest composite view. `src/ui/views/live-view.js` assembles:

- session tabs
- the active conversation area
- raw terminal logs
- the composer
- archived-session playback when the target is no longer live
- optional split panels for:
  - webview
  - writer
  - artifacts
  - app controls

The live conversation itself has two render paths:

- Alpine chat template when `wingman-alpine-chat` is enabled
- imperative DOM conversation rendering otherwise

### Apps page composition

The apps page is still rendered imperatively in `app.js`, but it composes reusable submodules:

- app dialog controller
- app cards
- workspace tree sidebar
- app logs and deploy dialogs

Apps data comes from the Alpine store even though the actual page DOM is not Alpine-driven.

### Settings page composition

`src/ui/views/settings-view.js` composes tabbed settings sections for:

- profile / identity
- workspace
- users
- projects
- admin-only sections

The settings page mixes reusable panels with direct fetches, especially for config-adjacent sections.

### Files page composition

`src/ui/views/files-view.js` is still imperative and stateful. It combines:

- the file browser tree
- preview pane
- localStorage-backed browser preferences
- directory and file transfer dialogs
- file editor overlay
- worktree creation modal
- optional writer launch helpers from the file context

### Projects and todos

Projects are currently active and routed:

- `src/ui/projects/index.js`
- `src/ui/projects/state.js`
- `src/ui/projects/view.js`

Todos are implemented similarly in code, but not currently mounted into the active shell.

## Reusable frontend building blocks

The current frontend already has a useful library of reusable UI modules even though the shell is still imperative.

### Dialogs and overlays

- session launch dialog controller
- job launch dialog controller
- app create/edit/clone dialogs
- directory browser
- file move/copy transfer dialog
- file editor overlay
- worktree modal

### Shared panels and cards

- app cards
- workspace tree sidebar
- settings tabs
- feature flags panel
- Night Watch settings panel
- starter projects panel
- identity panels and menu identity section
- admin users panel
- collapsible card helper in `app.js`

### Live-view-specific reusable panels

- webview panel
- writer panel
- artifacts panel
- app controls panel
- command menu controller
- conversation windowing helpers
- scroll pill
- agent status indicators

### Shared utility modules

- markdown and chat-message rendering
- clipboard helpers
- toast notifications
- agent option population
- path mention autocomplete
- image attachment and voice note helpers

## As-built conclusions

The current frontend has clearly moved partway into the intended Dexie + Alpine direction, but it is not there end-to-end.

What is true today:

- the shell is still orchestrated from `src/ui/app.js`
- selected domains use Alpine stores, and some of those stores are Dexie-backed
- live session behavior is a deliberate hybrid of SSE, IndexedDB caching, and polling
- many feature pages still render imperatively from the shared `state` singleton
- reusable UI modules exist, but they are composed by an imperative shell rather than by a single reactive app model

## Review notes / uncertainty

Two areas are worth calling out as potential surprises rather than assumptions:

- todo feature modules exist, but I did not find them mounted into the current top-level route/render flow in `src/ui/app.js`
- private chat has both streamed-fetch handling and an EventSource chat SSE manager; during this review the private chat page was using the streamed-fetch path, and I did not find the EventSource subscriber wired into that page flow
