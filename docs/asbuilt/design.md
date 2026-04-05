# Wingman design system and UI conventions (as built)

Last reviewed against the live repository on 2026-04-06.

## Scope and source of truth

This document describes the UI design language that is implemented today in the browser app under `src/ui/`.

Source of truth for this review:

- `src/ui/index.html`
- `src/ui/styles.css`
- `src/ui/app.js`
- `src/ui/navigation/navigation.js`
- `src/ui/views/home-view.js`
- `src/ui/views/live-view.js`
- `src/ui/views/files-view.js`
- `src/ui/views/settings-view.js`
- `src/ui/views/settings-tabs.js`
- `src/ui/apps/cards.js`
- `src/ui/nightwatch/page.js`
- `src/ui/scheduler/page.js`
- `src/ui/jobs/page.js`
- the earlier as-built documents in `docs/asbuilt/architecture.md`, `docs/asbuilt/data model.md`, `docs/asbuilt/middleware.md`, and `docs/asbuilt/frontend.md`

The current design system is real but not fully uniform. The shell, cards, buttons, dialogs, live view, files view, and app pages share a fairly consistent token set. Settings, Night Watchman, Scheduler, and Jobs also reuse some shared primitives, but those newer areas mix in a second naming vocabulary and some inline styles.

## Design posture

Wingman currently presents itself as a dark-first operational control plane with an optional light theme.

The visual character in the live code is:

- dark, earthy surfaces with green as the dominant action color
- rounded cards and pill-like controls rather than sharp enterprise tables
- soft shadows and translucent green overlays instead of hard flat separators
- a compact, utility-oriented shell for authenticated users
- a deliberately louder guest landing treatment on `/home` with oversized slogan text and brand-led presentation

In practice there are really two design moods:

- guest home: bold, sparse, slogan-driven landing layout
- authenticated app: restrained, card-based admin/orchestration interface

## Theme tokens in use today

The main token set is declared in `src/ui/styles.css` under `:root` and overridden by `body[data-theme="light"]`.

Canonical tokens actually used across the shell:

- accent: `--accent-primary #10b981`, `--accent-secondary #059669`, `--accent-tertiary #065f46`
- backgrounds: `--bg-gradient-start`, `--bg-gradient-end`, `--bg-primary`, `--bg-secondary`, `--bg-tertiary`
- text: `--text-primary`, `--text-secondary`, `--text-tertiary`
- borders/shadows: `--border-primary`, `--shadow-sm`, `--shadow-md`
- code surfaces: `--code-bg`, `--inline-code-bg`
- layout constants: `--nav-height`, `--wm-viewport-height`

Dark mode is the default because `:root` sets `color-scheme: dark` and the default palette is dark. Light mode is an override on `body[data-theme="light"]`, not a separate stylesheet.

Important implementation note:

- some newer CSS also references `--surface-secondary`, `--surface-tertiary`, `--accent-color`, and `--border`
- those names are not the main top-level token set used by the shell
- as built, the stable token vocabulary for new work should be considered the `--bg-*`, `--text-*`, `--accent-*`, and `--border-primary` family

## Typography

Global typography is system-first:

- base font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Helvetica Neue", Arial, sans-serif`
- monospace usage: `SFMono-Regular`, Menlo, Consolas, Liberation Mono, and similar stacks for paths, logs, code, and previews

Common text treatments in the live UI:

- product title: `1.5rem`, semibold, slight negative tracking in the header
- route/page headings: usually `1.75rem` to `1.35rem`
- card section headings: around `1.25rem`
- helper labels and metadata: `0.7rem` to `0.85rem`, often uppercase with added letter spacing
- code/log/path values: monospace, usually `0.85rem` to `0.95rem`

Typography usage patterns:

- uppercase + tracking is used for metadata, chips, and supporting labels
- body copy remains fairly plain and utilitarian
- live conversation and file preview text use larger line-height than table/list UI
- the guest home page is the main exception, with oversized slogan lines such as `YOU / CAN JUST / DO THINGS!`

## Color usage

Green is the dominant semantic and interactive color. It is used for:

- primary buttons
- active tabs and route pills
- hover states
- selected rows and pills
- focus outlines
- positive emphasis in status surfaces

Secondary accent colors appear by component rather than by a global semantic scale:

- blue is used for assistant chat/message surfaces and some “starting/running” states
- red is used for destructive actions, failures, and some runtime badges
- gray is used for archived, inactive, or placeholder treatments

Implemented color rules that show up repeatedly:

- primary surfaces stay low-contrast and dark/light-theme aware through tokens
- interactive overlays use translucent accent fills rather than opaque blocks
- code and logs use nearly black backgrounds even in light theme
- selected state is typically shown by both border-color and fill-color, not color alone

## Page shell and navigation

### Global shell

The browser shell is fixed around three persistent elements from `src/ui/index.html`:

- sticky header: `.wm-header`
- pull-to-refresh status bar: `#pull-refresh`
- route mount point: `main#app`

The header is sticky at the top with a fixed height token (`--nav-height`) and a card-like treatment:

- background uses `--bg-primary`
- bottom border uses `--border-primary`
- shadow uses `--shadow-sm`

### Header contents

The header includes:

- brand link with logo, title, and tagline
- quick-launch session button for authenticated users
- optional live-view webview/writer toggles
- current-session indicator pill on wider screens
- login button for guests
- hamburger menu toggle for authenticated users

### Navigation pattern

Navigation is menu-panel based, not a permanently visible sidebar.

Implemented route links in the menu:

- Agents (`/live`)
- Night Watchman (`/nightwatch`) when enabled
- Triggers (`/triggers`) for admins
- Jobs (`/jobs`) for admins
- Apps (`/apps`)
- Files (`/files`)
- Privacy Policy (`/privacy`)

Navigation behavior in the current code:

- route changes are handled imperatively in `src/ui/navigation/navigation.js`
- the menu is the primary global navigator once authenticated
- menu links open login first when auth is required
- the active route is reflected by an `.active` class on menu items
- live session tabs are a second navigation layer for active sessions
- tabs can be globally hidden with `body[data-tabs-visible="false"]`

### Route container sizing

`#app` is the main width governor and changes by route:

- default routes: max width `1080px`
- `/apps`: `1200px`
- `/projects`: `1100px`
- `/files`: `1440px`
- `/live`: reduced top padding and, when a webview is open, full-height edge-to-edge layout with independent column scrolling

This means page layout width is route-driven rather than based on one universal content container.

## Layout system

Wingman’s layout system is simple but consistent:

- shell-level max-width containers by route
- card-based vertical stacks for most pages
- flex and grid layouts inside cards
- sticky subregions for live tabs and live composer

### Core structural patterns

Common layout primitives that show up repeatedly:

- `.wm-card`: rounded bordered panel with padding and shadow
- `.wm-home-section-header`: title row with optional actions
- `.wm-table-container`: horizontal overflow wrapper for tables
- `.wm-tabs` / `.wm-tab`: pill navigation rows
- `.wm-actions`, `.wm-app-actions`, `.session-card-actions`: clustered action rows
- `.wm-form-group`, `.wm-scheduler-grid-two`, `.wm-scheduler-grid-split`: small form layout helpers in Alpine pages

### Live view layout

The live route is the most specialized layout in the product:

- sticky tabs bar directly below the header
- scrollable conversation region
- sticky composer at the bottom with a gradient fade
- optional split-panel layout through `.wm-live-split`

The split layout supports:

- chat + webview
- chat + writer
- chat + app controls
- chat + artifacts

Desktop split variants use proportional columns such as:

- normal split
- chat narrow / app wide
- app narrow / chat wide

### Files layout

The files route uses a two-pane layout when space permits:

- left column: file browser
- right column: preview/editor surface

The default desktop grid is:

- `minmax(260px, 360px)` sidebar
- `minmax(0, 2fr)` preview area

The browser pane can also be “shelved”, collapsing the layout to a single column.

### Apps layout

The apps page uses a split layout:

- collapsible workspace tree sidebar
- main app card column

At narrower widths it collapses to a vertical stack.

## Spacing and shape

The current design language favors medium-to-large spacing and rounded corners.

Repeated values visible across the CSS:

- card padding: usually `1.5rem` to `1.75rem`
- major page gaps: `1rem` to `1.75rem`
- small control gaps: `0.25rem` to `0.75rem`
- pill/button radii: from `0.5rem` to `999px`
- card radii: around `0.75rem` to `0.85rem`

Practical spacing rules visible in the code:

- cards are allowed to breathe; dense data is usually grouped inside them, not packed edge-to-edge
- headers and action rows use wrap-friendly gaps so controls can fold on smaller screens
- interactive surfaces nearly always reserve visible padding around text and icons
- mobile styles reduce card/page padding but keep targets comfortably tappable

## Common controls

### Buttons

There are two active button families.

Primary shell family:

- `.wm-button`
- variants: default, `.secondary`, `.danger`, `.wm-button--small`
- used throughout shell pages, dialogs, files, apps, and live composer

Shared Alpine page family:

- `.wm-btn`
- variants: `--sm`, `--primary`, `--danger`
- used on Jobs, Scheduler, and Night Watchman pages

Button behavior implemented in CSS:

- raised hover state with slight upward motion
- disabled state removes lift and lowers opacity
- some buttons support `data-state="loading" | "success" | "error"` with inline spinner/check/error feedback
- mobile rules often make action buttons full-width

### Tabs and pills

The app uses pill-based selection patterns heavily:

- session tabs in live view
- menu session tabs
- settings tabs
- session indicator pill
- status chips for sessions and apps

Session tabs are rounded pills with active-state border and fill. Settings tabs are flatter segmented buttons, though that area uses the newer mixed token vocabulary.

### Inputs and selects

Forms are built from:

- raw dialog inputs and selects in `index.html`
- shared `.wm-input`
- shared `.wm-select`
- `.wm-form-group`

Input styling today:

- filled surface using `--bg-secondary`
- `1px` border
- rounded corners around `0.4rem` to `0.75rem`
- focus shown by a strong outline rather than subtle shadow
- text inputs in dialogs keep `16px` font size on mobile to avoid iOS zoom

### Dialogs and overlays

Dialogs are a major control family:

- session launch
- job launch
- identity and key dialogs
- file picker and directory dialogs
- file editor overlay
- archive dialog
- voice note dialog

Shared dialog conventions:

- dark/light tokenized panel background
- rounded corners around `1rem`
- shadow-heavy modal presentation
- dimmed backdrop
- vertical form flow with footer actions aligned right on desktop and stacked on mobile

### Cards

`.wm-card` is the main building block for authenticated UI. It is used for:

- home sections
- app cards
- files panes
- settings sections
- many modal-like subpanels

Cards generally provide:

- surface separation
- internal spacing
- local headings and action groups
- a place to mix lists, tables, forms, and secondary metadata

### Status and feedback controls

Current status patterns include:

- app status badges
- session status pills
- agent status indicators and pills
- toast notifications
- pull-to-refresh banner
- live chat connection bar
- empty, loading, and error placeholders

Runtime feedback is often color-coded but usually also changes label text or iconography.

## Route-specific design notes

### Home

Authenticated `/home` is a card stack with:

- running apps
- live sessions
- archive access

Guest `/home` is intentionally different:

- full-height landing treatment
- oversized slogan text
- minimal login CTA
- reduced chrome
- a stronger brand/marketing tone than the rest of the app

### Live

The live screen is optimized for active session work:

- sticky tabs
- chat bubbles with different user/assistant treatments
- monospace raw logs inside collapsible details
- sticky composer with command menu, attachment flows, and mention autocomplete
- optional mobile tab bar for split views

### Files

The files view is closer to an IDE/browser hybrid:

- collapsible browser header
- hover-reveal star and delete affordances
- compact icon toolbar buttons
- markdown/code preview styling
- optional writer integration

### Apps

The apps page uses operational cards:

- strong status chip in the header
- metadata rows using label/value format
- log previews inside cards
- grouped lifecycle actions

### Settings, Scheduler, Jobs, Night Watchman

These pages are visually close to the rest of the app but are less fully unified:

- they use shared shell spacing and cards
- they also introduce `.wm-btn`, `.wm-input`, `.wm-form-group`, and some inline styles
- Night Watchman report cards especially still mix CSS classes with hard-coded inline colors and spacing

## Responsiveness

The UI is actively responsive, but route by route rather than through one global grid system.

Important breakpoints present in `src/ui/styles.css`:

- `1000px`: apps split collapses vertically
- `980px`: files two-pane layout collapses to single column
- `900px`: global page padding tightens and desktop session indicator is hidden
- `768px`: header/menu adjustments, dialogs shrink, live split becomes stacked/mobile-tab driven
- `720px`: settings tabs become horizontally scrollable, many layouts collapse to one column, files controls compact further
- `640px`: Night Watchman stacks vertically, voice/dialog controls tighten
- `600px` and `480px`: smallest dialog/home/mobile adjustments

Mobile-specific implemented behavior includes:

- sticky header retained
- hamburger menu remains the primary nav affordance
- live split can show only one pane at a time through mobile tabs
- composer remains reachable at the bottom
- dialogs become wider relative to viewport and action buttons become taller
- files layout introduces mobile section toggles and single-column behavior

## Accessibility and interaction details visible in the UI code

The current implementation includes several practical accessibility conventions:

- semantic shell elements: `header`, `nav`, `main`, `dialog`
- `aria-label` on icon-only and navigation controls
- `aria-live="polite"` on the session indicator and pull-to-refresh status
- `role="tablist"` / `role="tab"` / `role="tabpanel"` for settings tabs
- `focus-visible` outlines on major interactive controls
- authenticated/admin-only visibility handled via body data attributes plus CSS classes

This is not fully systematized in one accessibility layer, but the shell-level patterns are present and intentional.

## Practical style-guide rules that match the current implementation

If a new page or component needs to match Wingman as it exists today, the safest as-built rules are:

- use `.wm-card` as the default section container instead of inventing custom panel chrome
- use the main token set: `--bg-*`, `--text-*`, `--accent-*`, `--border-primary`
- default to green as the primary action/accent color
- keep corners rounded; most controls and surfaces are visibly softened
- prefer pill or rounded-tab selection controls over square segmented navigation
- keep tables inside `.wm-table-container` and provide a mobile card fallback when the content is dense
- use monospace only for code, paths, logs, ports, and identifiers
- keep forms vertically grouped with clear labels and compact helper text
- treat dialogs as first-class UI, with consistent spacing and a clear confirm/cancel footer
- on mobile, favor stacked layouts, full-width action buttons, and 44px minimum tap targets
- for live/session work, preserve sticky tabs and sticky composer behavior rather than letting those controls scroll away

## Known design inconsistencies in the live implementation

These are part of the as-built state and matter when documenting or extending the UI:

- there are two button families: `.wm-button` and `.wm-btn`
- there are two token vocabularies in play, but only one is clearly defined at the top level
- some newer Alpine pages still rely on inline styles for spacing and status colors
- the guest home page intentionally breaks from the authenticated control-plane look
- not every page is using the same state/rendering pattern, so some controls are visually shared but structurally duplicated

## Summary

Wingman today has a recognizable implemented design language:

- dark-first, green-accented, rounded operational UI
- sticky top shell with menu-driven navigation
- route-sized content containers
- card-based content organization
- specialized high-density live and files layouts
- responsive behavior tuned per page

It is best described as a partially consolidated design system rather than a fully unified one. The shell and major operational views are visually coherent; the newer Alpine-backed admin pages are moving in the same direction but are not fully normalized yet.
