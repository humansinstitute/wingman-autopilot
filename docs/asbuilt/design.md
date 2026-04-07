# Wingman design system and UI conventions (as built)

Last reviewed against the live repository on 2026-04-08.

## Scope and source of truth

This document describes the UI design language that is implemented today in the browser app under `src/ui/`.

Primary review inputs for this refresh:

- `docs/asbuilt/architecture.md`
- `docs/asbuilt/data model.md`
- `docs/asbuilt/middleware.md`
- `docs/asbuilt/frontend.md`
- `src/ui/index.html`
- `src/ui/styles.css`
- `src/ui/app.js`
- `src/ui/navigation/navigation.js`
- routed views and reusable UI modules under `src/ui/views/`, `src/ui/live/`, `src/ui/chat/`, `src/ui/common/`, `src/ui/core/`, `src/ui/modals/`, `src/ui/projects/`, `src/ui/apps/`, and `src/ui/writer/`
- design-impacting state modules under `src/ui/sessions/store.js`, `src/ui/jobs/store.js`, `src/ui/scheduler/store.js`, `src/ui/nightwatch/store.js`, `src/ui/apps/store.js`, `src/ui/projects/state.js`, `src/ui/todos/state.js`, and `src/ui/identity/state-manager.js`

The live UI is coherent enough to describe as a design system, but it is still only partially consolidated. The shell, cards, buttons, split panels, session dialogs, files UI, and app cards share a real visual language. Newer Alpine-backed pages and some side panels still mix in a second token vocabulary and inline styling.

## Design posture

Wingman currently presents as an operations-oriented local control plane with two distinct moods:

- guest home: loud, slogan-led, minimal chrome, almost poster-like
- authenticated app: compact, card-based, utility-first orchestration UI

The dominant visual traits in the authenticated product are:

- green-led accents and feedback surfaces
- rounded cards, pills, and soft-cornered inputs
- tokenized dark/light surfaces rather than pure black or pure white
- soft shadows and translucent fills instead of hard separators
- route-specific width and density choices instead of one universal grid

Important implementation correction from the earlier doc:

- the CSS token defaults are dark-derived
- but `app.js` currently boots to light theme on first visit when there is no saved preference
- this means the product is dark-capable and dark-styled at the token level, but not dark-by-default in actual runtime behavior

## Theme tokens in use today

The canonical top-level token set is declared in `src/ui/styles.css` under `:root` and overridden by `body[data-theme="light"]`.

Stable shell tokens used repeatedly:

- accent: `--accent-primary`, `--accent-secondary`, `--accent-tertiary`
- backgrounds: `--bg-gradient-start`, `--bg-gradient-end`, `--bg-primary`, `--bg-secondary`, `--bg-tertiary`
- text: `--text-primary`, `--text-secondary`, `--text-tertiary`
- border/shadow: `--border-primary`, `--shadow-sm`, `--shadow-md`
- code: `--code-bg`, `--inline-code-bg`
- layout: `--nav-height`, `--wm-viewport-height`

Two token vocabularies are still in play:

- the shell and older shared surfaces mostly use the `--bg-*`, `--text-*`, `--accent-*`, `--border-primary` family
- some newer or partially extracted UI still references names like `--border`, `--bg`, `--text-muted`, `--surface-secondary`, or `--accent-color`

That second vocabulary is not consistently declared at the top of the stylesheet. It appears in side panels and inline-styled widgets, so it should be treated as drift rather than the canonical design token system.

## Typography

Global typography remains system-first:

- base stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Helvetica Neue", Arial, sans-serif`
- monospace stack for paths, logs, code, and previews: `SFMono-Regular`, Menlo, Consolas, `Liberation Mono`, and similar fallbacks

Implemented type patterns:

- header product title: `1.5rem`, semibold, slightly tightened tracking
- route headings: generally `1.75rem` to `1.25rem`
- metadata and small labels: `0.7rem` to `0.85rem`, often uppercase with added letter spacing
- chat/file body text: larger line-height than table/list UI
- guest landing headline: oversized block lines such as `YOU / CAN JUST / DO THINGS!`

The product does not use a custom brand typeface. Contrast between surfaces, spacing, case, and layout carries more of the design identity than typography alone.

## Color usage

Green remains the dominant interactive and status color. It is used for:

- primary actions
- active pills and tabs
- selected rows
- focus outlines
- positive runtime emphasis
- translucent hover and selection fills

Other colors are component-scoped rather than globally semantic:

- blue shows up in some assistant/chat and status contexts
- red is used for destructive actions, failures, and warnings
- gray/brown neutrals handle most background and metadata surfaces

Recurring color rules in the implementation:

- selected states usually combine border, fill, and label changes rather than color alone
- code and terminal surfaces stay very dark in both themes
- the guest landing uses broader visual contrast than the authenticated shell
- some Night Watchman and artifacts UI still hard-codes status colors or inline fills instead of using the shared token set

## Page shell and modal chrome

### Global shell

The persistent shell from `src/ui/index.html` is built around:

- sticky header: `.wm-header`
- pull-to-refresh status strip: `#pull-refresh`
- route mount point: `main#app`

The header is fixed by `--nav-height` and styled as a card-like top bar with:

- `--bg-primary` background
- `--border-primary` bottom border
- `--shadow-sm` shadow

### Header contents

The live header composition currently includes:

- brand link with dual light/dark logo assets, title, and Latin tagline
- authenticated quick-launch button with a small dropdown menu
- route-conditional live toggles for webview and writer panels
- desktop current-session indicator pill on wider screens
- guest login button
- authenticated hamburger menu

Theme and tabs toggles are not permanently visible in the header row. They live inside the opened menu panel.

### Shared modal families

The shell ships a large amount of shared chrome before any page route renders. Current modal/dialog families in `index.html` include:

- session launch
- job launch
- identity unlock
- identity login
- directory browser
- file transfer / copy / move
- feature flag creation
- app creation mode picker
- starter project picker
- app create/edit
- app clone
- app logs
- app deploy
- project creation

The modal system is visually related but not fully singular. There are several chrome families:

- generic `dialog` defaults
- `.wm-session-dialog` for the agent/job launch flow
- `.wm-directory-dialog` for chooser-style modals
- `.wm-project-dialog` for centered form flow
- `.wm-dialog` for feature flags
- file-editor overlay chrome rendered outside native `<dialog>`

Shared modal conventions that are actually implemented:

- rounded corners around `1rem`
- dimmed backdrop
- vertically stacked form bodies
- right-aligned or wrapped footer actions
- mobile width reduction through media queries
- `16px` dialog input font sizing on smaller screens to avoid iOS zoom

## Navigation and routed composition

### Route composition

There is still no router framework. `src/ui/app.js` and `src/ui/navigation/navigation.js` perform string-based route resolution and imperative history updates.

Implemented shell routes during this review:

- `/home`
- `/live` and `/live/:sessionId`
- `/apps`
- `/projects`
- `/files/*` and legacy `/docs/*`
- `/settings`
- `/chat` and `/chat/:id`
- `/privacy`
- `/nightwatch`
- `/scheduler` and `/triggers`
- `/jobs`

### Menu navigation pattern

Global navigation is menu-panel based, not sidebar based.

Menu links currently expose:

- Agents
- Night Watchman when feature-enabled
- Triggers for admins
- Jobs for admins
- Apps
- Files
- Privacy Policy in the footer

Important as-built nuance:

- some routed pages exist without first-class menu links
- `Projects` is reachable through other UI flows and `window.navigateToProjects`, but is not listed in the current menu panel
- `Settings` is also routed and rendered, but not present as a top-level menu link
- `Chat` exists as a route and full-page design surface, but it is not exposed in the menu either

### Navigation behavior

Current navigation behavior in code:

- route changes are handled with `pushState`/`replaceState`
- auth-gated routes open the identity login dialog instead of navigating
- active menu links receive an `.active` class
- live session tabs act as a second navigation layer
- session tabs can be globally hidden with `body[data-tabs-visible="false"]`
- leaving live routes explicitly tears down live refresh wiring

## Layout system and route sizing

Wingman does not use a single universal content container. Width and height are route-driven.

### `#app` route sizing

Current `#app` constraints in CSS:

- default routes: `max-width: 1080px`
- `/apps`: `1200px`
- `/projects`: `1100px`
- `/files`: `1440px`
- `/live`: reduced top padding and no bottom padding
- `/live` with webview/writer/app side panel open: full-height edge-to-edge layout with independent column scrolling

Important shell overrides:

- `#app:has(.wm-home-guest-landing)` removes the normal width cap for the guest landing
- private chat does not change `#app` width directly, but `.wm-chat` applies its own `max-width: 1400px`

### Core layout primitives

Repeated structural patterns:

- `.wm-card` for most authenticated sections
- `.wm-home-section-header` for titled card headers
- `.wm-table-container` for horizontally scrollable tables
- `.wm-tabs` and `.wm-tab` for pill-style selection
- `.wm-actions`, `.wm-app-actions`, `.session-card-actions` for button clusters
- `.wm-form-group`, `.wm-scheduler-grid-two`, `.wm-scheduler-grid-split` for Alpine-page forms

### Route-specific layout notes

Home:

- guest route is full-bleed and slogan-led
- authenticated route is a card stack

Live:

- sticky tabs bar below the header
- scrollable main conversation region
- sticky composer with fade treatment
- optional split layout through `.wm-live-split`

Files:

- two-pane browser/preview layout on desktop
- collapsible “shelved” browser behavior
- single-column fallback on smaller screens

Apps:

- split view with collapsible workspace tree sidebar and card column

Projects:

- simple page header plus project card grid
- each project card nests an app list with status chips and action rows

Chat:

- wide centered conversation shell
- left-side list of chats or a full conversation view depending on route state
- reuses the shared `.wm-composer` form class for the message composer

Settings:

- top page title plus segmented settings tabs
- each tab mostly renders `.wm-card` sections

## Spacing and shape

The design language still favors medium-to-large spacing and softened corners.

Repeated values visible across the CSS:

- page padding: `1.5rem` to `2rem` at desktop, reduced on smaller screens
- card padding: usually `1.5rem` to `1.75rem`
- major layout gaps: `0.75rem` to `1.75rem`
- control gaps: `0.25rem` to `0.75rem`
- pill radii: `999px`
- standard control radii: roughly `0.4rem` to `0.75rem`
- modal/card radii: roughly `0.85rem` to `1rem`

Practical spacing rules in the code:

- most data is grouped inside cards rather than packed edge-to-edge
- headers and action rows wrap intentionally on smaller screens
- touch targets are enlarged in smaller breakpoints
- mobile layouts tend to preserve comfort before density

## Common controls and reusable patterns

### Buttons

Two button families remain active.

Primary shell family:

- `.wm-button`
- variants: default, `.secondary`, `.danger`, `--small`
- used across home, apps, files, dialogs, projects, and live work

Shared Alpine/admin family:

- `.wm-btn`
- variants: `--sm`, `--primary`, `--danger`
- used by scheduler, Night Watchman, and jobs surfaces

Implemented button behavior:

- hover lift or background shift on many shell buttons
- disabled state lowers opacity and removes lift
- some identity/admin buttons use `data-state="loading" | "success" | "error"` feedback
- mobile rules often expand important action buttons to full width or taller tap targets

### Tabs, pills, and status chips

Wingman heavily favors pill-based selection and badge treatment:

- live session tabs
- menu session tabs
- settings tabs
- session indicator pill
- app and project status chips
- admin filter selectors and section toggles

Settings tabs are visually flatter than the live tabs, but still rounded and tokenized. They also implement `role="tablist"`, `role="tab"`, and `role="tabpanel"`.

### Inputs and form helpers

Input styling is broadly consistent:

- filled surface using `--bg-secondary` or `--bg-tertiary`
- `1px` border
- rounded corners
- focus shown through a visible outline or border-color change
- dialog inputs on mobile are explicitly kept at readable/touch-safe sizing

Shared helpers include:

- `.wm-input`
- `.wm-select`
- `.wm-form-group`
- `.working-directory-field`
- `.wm-checkbox`

### Cards

`.wm-card` remains the core authenticated container. It is used for:

- home sections
- app cards
- project cards
- files panes
- settings sections
- many empty/error/loading placeholders

App cards are the most reused compound pattern. The same card treatment appears:

- on the Apps page
- in the Projects page’s linked-app rows
- inside the live app-controls side panel
- for the Wingman core app/system card

### Reused live-side panel chrome

The live route now has a stronger reusable side-panel pattern than the earlier doc captured.

Shared panel treatment across webview, writer, app controls, and artifacts:

- `.wm-webview-toolbar`
- layout mode toggle buttons
- a shared close button style
- narrow/wide split modes
- mobile tab switching via `writer/mobile-tabs.js`

This side-panel family is visually coherent, but not fully normalized. Notable drift:

- writer and app-controls mostly reuse the shared toolbar cleanly
- artifacts still injects substantial inline style and references token names like `--border`, `--bg`, and `--text-muted`

### Files and editor patterns

Files UI uses several reusable secondary patterns:

- hover-reveal affordances for favourites/delete actions
- compact toolbar icon buttons
- directory-browser chooser lists
- full-screen file editor overlay with Ace
- optional paired writer workflow for docs/markdown editing

The file editor is not a native `<dialog>`; it is an overlay surface with its own header, status row, editor region, and footer.

## Route-specific design notes

### Home

Authenticated `/home` is a practical dashboard made of card stacks for:

- running apps
- live agent sessions
- archive access

Guest `/home` is intentionally different:

- full-bleed landing treatment
- giant stacked slogan lines
- minimal CTA
- privacy link and external footer link rather than full authenticated shell affordances

### Live

The live route is still the densest and most specialized design surface:

- sticky tabs
- scrollable conversation region
- sticky composer
- collapsible raw terminal output
- chat/webview, chat/writer, chat/app-card, and chat/artifacts panel combinations
- mobile one-pane-at-a-time tab behavior when the split collapses

### Files

The files route feels closest to an IDE/workspace browser hybrid:

- browser + preview split
- compact toolbars
- markdown/code preview
- writer handoff
- file move/copy modal flows

### Apps

The apps route uses operational cards with:

- strong status chips
- label/value metadata rows
- log preview blocks
- grouped lifecycle actions

### Projects

The projects page reuses card chrome but presents a simpler hierarchy:

- page header with refresh/create actions
- project cards
- nested app rows with status chips, code paths, and action buttons

### Settings, Scheduler, Jobs, Night Watchman

These pages visually align with the main shell, but they are the least normalized part of the authenticated UI:

- they reuse shell spacing and `.wm-card`
- they use the newer `.wm-btn`, `.wm-input`, `.wm-form-group` helpers
- Night Watchman and some admin surfaces still mix tokenized classes with inline style decisions

### Private chat

Private chat is its own design surface, separate from live agent sessions:

- centered wide chat shell
- list/detail composition
- user and assistant bubbles
- streaming indicator on assistant output
- shared composer styling

It is visually close to live chat, but it is implemented separately and does not share the full live split-panel shell.

## Design-impacting state behavior

The current UI design is materially affected by browser-side state choices, not just CSS.

### Body dataset flags

`app.js` drives shell presentation through body data attributes:

- `data-theme`
- `data-tabs-visible`
- `data-authenticated`
- `data-admin`
- `data-menu-open`

Those flags directly control visibility, logo swapping, tab bar visibility, guest/authenticated chrome, and admin-only surfaces.

### Identity transitions

`src/ui/identity/state-manager.js` is one of the strongest design-affecting modules in the browser:

- login opens/closes modal-driven flows
- successful authentication can force the shell back to `/home`
- auth state flips guest/authenticated/admin chrome
- identity changes reset session/app owner filters
- signing listeners and post-auth fetches are started/stopped from here
- identity state is persisted and cross-tab synchronized

### Session and app filtering

`src/ui/sessions/store.js` and `src/ui/apps/store.js` change what the user sees based on identity:

- non-admin viewers are effectively pinned to their own `npub`
- admin viewers get owner filter options
- identity summaries can update alias, balance, and assigned ports shown elsewhere in the shell
- apps store also carries `pendingOpenDialog` and `pendingFocusId`, which changes post-navigation UI behavior on the Apps page

### Dexie-backed instant render

Sessions, apps, scheduler, and Night Watchman all prefer:

1. instant render from Dexie
2. liveQuery subscription
3. background server sync

Design consequence:

- pages can paint immediately from cached data
- visible card/table content can update after first render without route reload

### Night Watchman and scheduler presentation filters

State behavior directly shapes those pages:

- Night Watchman keeps `filterProject` and `filterStatus` in the Alpine store
- scheduler and Night Watchman replace their Dexie caches wholesale on sync, so the visible lists are full server snapshots rather than partial patches

### Projects and todos

Projects and todos are still visually and architecturally less mature:

- `projects/state.js` is in-memory only and fetch-driven
- todo state is also in-memory only
- `todos/state.js` explicitly disables `ensureLoaded()`
- todo UI code exists, but it is not currently part of the routed shell, so it does not define the live app’s visible design language today

### Settings tab persistence and files preferences

Some view state persists locally and changes the visual shell on revisit:

- settings active tab is stored in `state.ui.settingsActiveTabId`
- file-browser preferences such as hidden files, shelved browser state, and favourites are read from local storage during bootstrap
- theme and tab visibility are persisted locally

## Responsiveness

The UI is actively responsive, but mostly route by route rather than from one central layout system.

Important breakpoints present in the stylesheet:

- `1000px`: apps split collapses vertically
- `980px`: files layout collapses
- `900px`: page padding tightens and desktop session indicator hides
- `768px`: header/menu/dialog/live split adjustments
- `720px`: settings tabs scroll horizontally and many dense layouts collapse
- `640px`: Night Watchman/dialog controls tighten
- `600px` and `480px`: smallest mobile refinements

Mobile-specific behavior currently implemented:

- sticky header is retained
- hamburger menu remains the main nav affordance
- live split becomes mobile-tab-driven
- composer stays anchored and reachable
- dialogs widen relative to viewport and controls get taller
- files and chat layouts simplify rather than preserve desktop density

## Accessibility and interaction details visible in the UI code

The current shell includes several practical accessibility conventions:

- semantic `header`, `nav`, `main`, and `dialog`
- `aria-label` on many icon-only and navigation controls
- `aria-live="polite"` on pull-to-refresh and session indicator regions
- `role="status"` on the desktop session indicator
- tab semantics on settings navigation
- `focus-visible` styles on major interactive controls
- `data-testid` attributes on some testing-critical controls, especially in job/app/live panels

This is still not centralized in one accessibility system, but the shell-level intent is clear and visible in the live code.

## Known design inconsistencies in the live implementation

These are real parts of the as-built state:

- there are still two button families: `.wm-button` and `.wm-btn`
- there are still two token vocabularies in use, but only one is well defined globally
- some newer pages and side panels still rely on inline styles
- the artifacts panel is the clearest example of inline-style drift
- guest home intentionally breaks from the authenticated control-plane look
- routed pages exist that are not exposed through the global menu
- the visible theme default comes from JS preference boot logic and does not match the dark-first impression of the raw CSS token declarations

## Practical style-guide rules that match the current implementation

If a new page or component needs to match Wingman as built today, the safest rules are:

- use `.wm-card` as the default section container
- prefer the `--bg-*`, `--text-*`, `--accent-*`, `--border-primary` token family
- use green as the default accent/action color
- keep corners visibly rounded
- prefer pills or rounded segmented controls over square tabs
- preserve route-specific width choices instead of forcing one global layout width
- reuse the webview/writer toolbar pattern for new live-side panels
- keep forms vertically grouped with clear labels and helper text
- treat dialogs as first-class surfaces with consistent spacing and clear footers
- on mobile, favor stacked layouts and larger tap targets over dense desktop parity

## Summary

Wingman today has a recognizable implemented design language:

- rounded, green-led operational UI
- sticky shell with menu-panel navigation
- route-specific width and density
- card-based organization for most authenticated work
- specialized live, files, chat, and app surfaces
- state-driven visibility and personalization at the shell level

It is best described as a partially consolidated design system. The shell and major operational routes are coherent. The newer Alpine/admin areas and some side panels are aligned in direction, but are not fully normalized yet.
