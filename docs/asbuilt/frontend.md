# Wingman frontend (as built)

Last reviewed against the live repository on 2026-04-07.

## Scope and source of truth

This document describes the current browser-side frontend implemented under `src/ui/`.

Source of truth for this review:

- `docs/asbuilt/architecture.md`
- `docs/asbuilt/data model.md`
- `docs/asbuilt/middleware.md`
- the current UI shell in `src/ui/index.html` and `src/ui/app.js`
- the current state, store, service, live, and view modules under `src/ui/`

The current frontend is still mixed-mode rather than fully Dexie + Alpine:

- `src/ui/app.js` remains the SPA shell, route resolver, and cross-feature integration point
- some domains now use Alpine stores backed by Dexie / IndexedDB caches
- other domains still use imperative rendering plus the mutable shared `state` singleton from `src/ui/state/index.js`

## Entry point and shell composition

The browser entry is `src/ui/index.html`. As built, it provides persistent shell chrome and a large amount of shared modal infrastructure before `app.js` renders any route content:

- a persistent header with brand link, quick launcher, auth-gated nav menu, theme/tabs toggles, and live-only header toggles for webview and writer panels
- a desktop session indicator and pull-to-refresh indicator
- a single `<main id="app"></main>` mount point for page content
- shared dialogs for session launch, job launch, identity login/unlock, directory browsing, file transfer, feature flags, app create/clone/logs/deploy/starter flows, and project creation

`src/ui/app.js` is still the browser composition root. It is responsible for:

- bootstrapping config, identity restore, Alpine stores, and live modules
- deriving the current route from `window.location.pathname`
- normalizing legacy aliases such as `/docs -> /files`
- wiring top-level navigation and `history.pushState` / `popstate`
- rendering the active page into `#app`
- coordinating cross-cutting concerns such as theme, tabs visibility, auth gating, session launch, file modals, header indicators, and live session refresh

There is no client-side router framework. Route resolution is string-based and handled directly in `app.js`.

Implemented shell routes during this review:

- `home`
- `live` for `/live` and `/live/:sessionId`
- `apps`
- `projects`
- `files` for `/files/*` and legacy `/docs/*`
- `settings`
- `chat`
- `privacy`
- `nightwatch`
- `scheduler` for both `/scheduler` and `/triggers`
- `jobs`

Todo modules exist under `src/ui/todos/`, but they are not mounted by `app.js` and there is no active top-level todos route in the shell during this review.

## Frontend state ownership

### Shared shell state

`src/ui/state/index.js` exports a mutable singleton `state` that still owns most cross-page shell state, including:

- fetched config
- session logs and live-view DOM bookkeeping
- message drafts and prompt queues
- archived session viewer state
- file browser, preview, transfer, and editor state
- split-panel layout state for webview, writer, artifacts, and app controls
- identity snapshot
- admin user state
- compatibility slices for projects, todos, and Night Watch
- private chat state

This is still the main non-Dexie state container. Most imperative views read it directly.

### Domain ownership by area

| Domain | Primary browser owner | Persistence/caching | Notes |
| --- | --- | --- | --- |
| Config | `state.config` in `app.js` | in-memory only | Loaded from `/api/config`; also seeds agent options, feature flags, and auth-related UI |
| Identity | `state.identity` via `src/ui/identity/state-manager.js` | `localStorage` + cross-tab `storage` sync | Also emits browser events, resets session/app filters, starts/stops signing, and triggers post-auth refreshes |
| Session catalog | Alpine store `sessions` in `src/ui/sessions/store.js` | Dexie `WingmanLive.apiSessions` | Used for home, nav, tabs, and active-session selection; also derives alias/ports/balance updates for the signed-in identity |
| Live message cache | `MessageStore` in `src/ui/live/db.js` | Dexie `WingmanLive.messages` | Canonical live transcript cache for SSE, bootstrap fetches, queue sends, clipboard helpers, and both live chat renderers |
| Live session status cache | `SessionStore` in `src/ui/live/db.js` | Dexie `WingmanLive.sessions` | Stores per-session runtime status used by indicators and refresh decisions |
| Apps catalog | Alpine store `apps` in `src/ui/apps/store.js` | Dexie `WingmanLive.apps` | App cards still render imperatively from store data |
| Night Watch | Alpine store `nightwatch` | Dexie `WingmanNightWatch.reports` and `.config` | Page is Alpine-driven and store-backed |
| Scheduler | Alpine store `scheduler` | Dexie `WingmanScheduler.jobs` | Page is Alpine-driven and store-backed |
| Jobs | Alpine store `autopilotJobs` | no Dexie cache | Alpine store is in-memory only |
| Projects | `createProjectState()` in `src/ui/projects/state.js` | in-memory only | Wrapped by `createProjectFeature()` and rendered imperatively |
| Files | `state.files` and `state.fileEditor` | mostly in-memory, plus localStorage prefs | File tree and preview are fetched on demand |
| Private chat | `state.chats`, `state.chatConversations`, `state.chatStreaming` | in-memory only | Separate from live agent sessions |
| Todos | `createTodoState()` in `src/ui/todos/state.js` | in-memory only | Feature code exists, but `ensureLoaded()` is intentionally disabled and the feature is not routed into the shell |

### Practical architectural boundary

As built, the frontend still has two real state patterns running side by side:

1. Shell-and-feature state in the mutable `state` singleton.
2. Alpine stores for selected domains, with Dexie caches where the migration has already happened.

The migration target exists, but it is not yet end-to-end in the live code.

## Refresh and subscription behavior

### Boot-time loading

At startup, `app.js` currently does this:

1. initializes theme, tabs visibility, conversation selection lock, mobile live behavior, and the live module
2. registers Alpine stores for Night Watch, Scheduler, Jobs, Sessions, and Apps
3. optionally registers the Alpine live chat store
4. starts Alpine, seeds an initial active live session from the URL, and renders immediately from cached browser state
5. fetches `/api/config`
6. attempts identity restore from the device keystore
7. checks the Key Teleport login handoff path when still unauthenticated
8. loads sessions, and if authenticated also apps and npub-projects
9. starts the NIP-98 signing listener and session-list SSE subscriber when authenticated
10. renders again with hydrated server data

That means the shell prefers immediate render plus later hydration, not a blank-page bootstrap.

### Session list refresh

Session-list freshness uses two mechanisms:

- explicit sync via `sessionsStore().sync()` calling `/api/sessions`
- background SSE via `src/ui/sessions/subscriber.js`, which connects to `/api/sessions/subscribe` and triggers another sync whenever session lifecycle events arrive

This keeps the home page, nav tabs, and session indicators fresh without reloading the page. The session subscriber is only started for authenticated users.

### Live session refresh

Live session pages use an SSE-first contract with explicit polling fallbacks:

- `src/ui/live/sse-manager.js` opens `EventSource` connections to `/api/sessions/:id/events`
- typed `transport` events tell the browser whether the stream is `event-stream`, `heartbeat-only`, `degraded`, or still unknown
- `src/ui/live/refresh-controller.js` owns bootstrap fetches, reconnect catch-up, and polling policy
- `src/ui/live/route-transport.js` synchronizes live-route entry/exit with the refresh controller and SSE manager
- incoming SSE messages are written into Dexie through `MessageStore.upsertMessage()`
- incoming SSE status events are written into Dexie through `SessionStore.updateStatus()`
- bootstrap fetches and immediate POST responses sync full conversations back into Dexie
- the Alpine live chat store subscribes to Dexie with `Dexie.liveQuery(...)`
- the non-Alpine live renderer hydrates its DOM from Dexie on demand; there is no active in-memory `state.conversations` mirror anymore

Steady-state behavior by mode:

- stable proxied streams: bootstrap fetch once, then SSE-driven refresh with polling off
- sessions whose runtime status is `running`: lightweight 1s compatibility polling can stay active even when stream mode is `event-stream`
- heartbeat-only streams: bootstrap fetch, then 1s compatibility polling for conversation, queue, and status while SSE provides liveness
- degraded or disconnected windows: temporary 2s recovery polling until the stream reconnects cleanly

### Live connection health

The live SSE manager provides:

- per-session connection tracking
- exponential-backoff reconnects
- heartbeat freshness checks
- stream-mode tracking so the UI can distinguish full event streams from heartbeat-only compatibility mode

`src/ui/live/visibility-manager.js` is also used to re-check live freshness when the tab becomes visible again.

### Dexie-backed domain refresh

The Dexie-backed Alpine stores all follow the same general pattern:

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

- chat list and history are fetched on demand through `src/ui/services/chats.js`
- message send uses a streamed HTTP response parsed by `streamChatResponse(...)`
- streamed assistant chunks are held in `state.chatStreaming`

An EventSource-based `ChatSSEManager` exists in `src/ui/chat/chat-sse-manager.js`, but the current private-chat flow in `src/ui/chat/private-chat.js` uses the streamed-fetch path rather than subscribing that manager.

## Data-to-UI boundaries

### Service modules that do exist

The explicit browser-to-API boundary is most visible in these service modules:

- `src/ui/services/sessions.js`
  - wraps `/api/sessions*`, queue endpoints, and `/fork-to-worktree`
  - returns parsed payloads but leaves UI state and Dexie updates to callers
- `src/ui/services/apps.js`
  - wraps `/api/apps*` list, logs, actions, and delete flows
  - used by the apps store and by some imperative views
- `src/ui/services/chats.js`
  - wraps private chat CRUD plus `/api/maple/models`
  - `postChatMessageApi()` intentionally returns the streaming `Response` for the caller to parse
- `src/ui/services/agent-chat.js`
  - wraps `/api/agent-chat/subscriptions*`
  - currently used by the settings page’s Agent Chat section

Page-local API modules still exist for Night Watch, Scheduler, Jobs, Files, Billing, and related admin features.

### Where the boundary is still direct

The frontend is not uniformly service-driven yet. Direct `fetch(...)` usage is still present in important modules, including:

- `src/ui/projects/state.js`
- `src/ui/todos/state.js`
- `src/ui/views/settings-view.js`
- `src/ui/views/settings/workspace-sections.js`
- `src/ui/apps/tree.js`
- `src/ui/modals/directory-browser.js`
- `src/ui/modals/file-editor.js`
- parts of `src/ui/views/live-view.js`
- parts of `src/ui/identity/state-manager.js`

So the browser boundary is partially extracted, not centralized.

### Current source-of-truth split

The effective ownership split is:

- server APIs remain the authority for sessions, apps, projects, files, scheduler, jobs, Night Watch, identity, Agent Chat subscriptions, and chat
- Dexie caches are browser-side read models for selected domains
- `state` is still the authority for transient UI concerns, layout, and the not-yet-migrated feature areas

The live code does not enforce a strict “all UI reads come from Dexie” rule across the whole frontend.

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

`render()` in `app.js` usually rebuilds `#app` imperatively. The two intentional same-route exceptions are:

- `scheduler`
- `jobs`

Those pages are treated as stable so Alpine-owned form state does not get torn down on every render.

### Live view composition

The live page is still the richest composite view. `src/ui/views/live-view.js` assembles:

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

The live conversation itself still has two render paths:

- Alpine chat template when `wingman-alpine-chat` is enabled
- imperative DOM conversation rendering otherwise

### Apps page composition

The apps page is still rendered imperatively in `app.js`, but it composes reusable submodules:

- app dialog controller
- starter-project and clone flows
- app cards
- workspace tree sidebar
- app logs and deploy dialogs

Apps data comes from the Alpine store even though the page DOM itself is not Alpine-driven.

### Settings page composition

`src/ui/views/settings-view.js` composes tabbed settings sections for:

- profile
- workspace
- users
- projects
- admin-only sections

Within those tabs it reuses smaller sections for identity, API keys, GitHub, Gitea, Agent Chat subscriptions, team billing, feature flags, starter projects, and the Wingman core app card. It still mixes reusable panels with direct fetches for config-adjacent details.

### Files page composition

`src/ui/views/files-view.js` is still imperative and stateful. It combines:

- the file browser tree
- preview pane
- localStorage-backed browser preferences
- directory and file transfer dialogs
- file editor overlay
- worktree creation modal
- optional writer launch helpers from file context

### Projects and todos

Projects are currently active and routed:

- `src/ui/projects/index.js`
- `src/ui/projects/state.js`
- `src/ui/projects/view.js`

Todos are implemented in parallel under `src/ui/todos/`, but they are not currently routed into the active shell and their `ensureLoaded()` path is intentionally disabled.

## Reusable frontend building blocks

The frontend already has a substantial library of reusable UI modules even though the shell is still imperative.

### Dialogs and overlays

- session launch dialog controller, including worktree and writer-mode inputs
- job launch dialog controller
- app create/edit/clone/starter/deploy dialogs
- identity login dialog
- directory browser
- file move/copy transfer dialog
- file editor overlay
- worktree modal
- project creation dialog

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
- mobile tab bar
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

The live frontend has clearly moved partway toward the intended Dexie + Alpine architecture, but it is still not there end-to-end.

What is true today:

- the shell is still orchestrated from `src/ui/app.js`
- selected domains use Alpine stores, and some of those stores are Dexie-backed
- live session behavior is a deliberate hybrid of SSE, IndexedDB caching, and polling
- many feature pages still render imperatively from the shared `state` singleton
- reusable UI modules exist, but they are composed by an imperative shell rather than by a single reactive app model

## Review notes / uncertainty

Two points are worth calling out plainly rather than guessing:

- todo feature modules exist, but I did not find them mounted into the current top-level route/render flow in `src/ui/app.js`
- private chat has both streamed-fetch handling and an EventSource chat SSE manager; during this review the private chat page was using the streamed-fetch path, and I did not find the EventSource subscriber wired into that page flow
