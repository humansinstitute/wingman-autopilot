# Feature Design: Clickable Local File Links

## Status

This is the finalised design brief for the flow run started from the request:

> In `~/code/wingmen` can you please consider a new feature to allow links to local files to be clickable? Often agent sessions return `/Users/mini/<project>/docs/design.md` links that are on the machine and could be accessed via the files menu but I have to manually navigate. It would be good to be able to click and go straight there.

This revision incorporates the review and reflection feedback from the earlier passes and resolves the remaining design choices into an implementation-ready v1 brief.

## Product Outcome

Wingman should let a user click a local file reference that appears in agent output and open that target in the existing Files surface without manually browsing through the file tree.

The feature is specifically about local file references that already appear in session output and that fall within the current Files-accessible scope. It is not a general markdown-rich-chat project and it is not a `file://` browser feature.

## Decision Summary

### Decision 1: Keep v1 scoped to local file activation only

V1 will activate:

- bare absolute local paths in chat-style output
- markdown links whose destination is a local absolute path
- markdown links with angle-bracket destinations for local paths containing spaces

V1 will not activate ordinary web links in chat output unless they are already supported by the current image-specific path.

Reason:

- that is the actual user request
- it keeps regression risk low in the current chat renderer
- it avoids turning this into a broader markdown-rendering change

### Decision 2: Keep the current chat renderer shape

V1 will extend `src/ui/rendering/chat-message-content.js` instead of replacing it with full markdown rendering.

`renderChatMessageHtml(...)` should continue to preserve the current plain-text-heavy presentation using `<pre class="wm-message-plain">`, while selectively emitting anchors only for recognized local file references.

Reason:

- the current conversation UI is intentionally plain-text oriented
- switching to generic markdown rendering would change spacing and transcript readability
- the existing markdown helper is not a drop-in solution for local file routing

### Decision 3: Use `/files/<path>` as the bootstrap link contract

The v1 link target will be the existing Files route using the local path as the route slug.

Examples:

- `/Users/mini/code/wingmen/docs/design.md` -> `/files//Users/mini/code/wingmen/docs/design.md`
- `[architecture](/Users/mini/code/wingmen/docs/architecture.md)` -> `/files//Users/mini/code/wingmen/docs/architecture.md`

This initial URL may look slightly awkward for absolute paths, but it is already compatible with the current Files routing flow:

- `parseFilesPathFromUrl()` reads the slug after `/files/`
- `navigateToFilesSlug()` probes whether that slug is a directory or file
- the docs API resolves the target path with existing authorization
- `loadFilesTree()` and `loadFilesPreview()` replace the browser URL using the backend `relativePath`, which normalizes the visible URL back to a cleaner relative `/files/...` path after the target is loaded

Reason:

- no new backend route is required for v1
- existing files/docs APIs already accept in-scope absolute paths
- the server remains the authorization boundary

### Decision 4: Full-page navigation is acceptable in v1

V1 will use normal anchors for local file links and accept a normal browser navigation into the Files route.

We will not require a delegated click handler or SPA-only `pushState` navigation in the first release.

Reason:

- the user pain is "one click to the file", not "stay entirely inside the current SPA state"
- a normal link to `/files/...` already solves the problem
- adding delegated click interception can be a follow-up if the reload feels too heavy in practice

### Decision 5: Line numbers are deferred

If a detected reference includes a trailing `:line` suffix such as `/Users/mini/code/wingmen/src/server.ts:625`, v1 will link to the file and ignore the line-number jump behavior.

The rendered text may continue to show the original `:625` suffix, but the generated href should target the file path only.

Reason:

- there is no current file-preview or editor contract for direct line navigation
- preserving line metadata through the current Files URL normalization would require extra route work
- stripping the suffix from the href keeps the parser boundary simple and avoids over-promising

### Decision 6: Do not pre-check scope in the renderer

V1 will render supported local-looking paths as links based on syntax alone and will not try to pre-compute whether the current Files scope can actually open them.

If the clicked target is outside the active workspace scope, the existing Files/docs backend should reject it and the user should see the current Files error path.

Reason:

- it keeps the renderer simple and deterministic
- it avoids duplicating server-side scope logic in the browser
- it preserves the existing trust boundary in `resolveDocsPath(...)`

## Current System Facts

### Chat rendering

`src/ui/rendering/chat-message-content.js` currently:

- special-cases markdown image lines
- rewrites uploaded `file://` image URLs into `/uploads/...`
- emits other content as escaped plain text inside `<pre class="wm-message-plain">`

This renderer is used by:

- `src/ui/live/conversation-window.js`
- `src/ui/live/chat-component.js`
- `src/ui/views/live-view.js`
- `src/ui/chat/private-chat.js`
- `src/ui/home/archive.js`

The archived surface that matters here is the archived-session dialog under Home archive, not a separate transcript system.

### Files navigation

`src/ui/files/api.js` already provides the route/bootstrap behavior needed for v1:

- `parseFilesPathFromUrl()`
- `navigateToFilesSlug(slug)`
- `loadFilesTree(path)`
- `loadFilesPreview(path)`

The route bootstrap works for absolute paths because the docs APIs accept absolute paths within the allowed scope. After a successful load, the Files UI rewrites the browser URL to the backend-reported `relativePath`, so the absolute bootstrap URL does not need to remain visible.

### Backend authorization

`src/server/docs-routes.ts` uses `resolveDocsPath(...)` to normalize requested paths and reject anything outside the configured docs root for the active workspace context.

That means frontend link activation is a convenience feature, not a trust boundary. A bad or maliciously crafted local-looking path should still fail closed on the server if it falls outside the allowed root. The brief should not imply that every visible `/Users/...` path on the machine is necessarily openable from every session; that depends on the current workspace scope.

## V1 Scope

### In scope

- local file activation in live session conversation
- local file activation in private chat
- local file activation in the archived-session dialog
- bare absolute path detection for common local paths
- markdown local-link activation
- directory targets opening the Files browser
- file targets opening the Files preview

### Out of scope

- generic rich markdown rendering for chat
- activation of ordinary remote hyperlinks in chat
- support for arbitrary `file://` URIs from message text
- line-number jumping in preview or editor
- client-side prevalidation of Files scope before rendering a local-looking link
- Tower schema changes
- Yoke schema changes
- new backend resolver routes for local links

## Supported Input Shapes

V1 should explicitly support these shapes when the resolved target stays inside the active Files scope:

### Bare absolute paths without spaces

Examples:

- `/Users/mini/code/wingmen/docs/design.md`
- `/Users/mini/code/wingmen/src/server.ts`
- `/home/pete/code/project/README.md`

### Markdown links whose destination is a local absolute path

Examples:

- `[design doc](/Users/mini/code/wingmen/docs/design.md)`
- `[server](/Users/mini/code/wingmen/src/server.ts:625)`

### Markdown links with angle-bracket destinations for spaced paths

Examples:

- `[My Report](</Users/mini/Documents/My Report.md>)`
- `[My Report line 3](</Users/mini/Documents/My Report.md:3>)`

### Explicitly unsupported in v1

- bare local paths with spaces in plain text
- `~/...` shorthand paths
- arbitrary Windows path forms
- arbitrary colon-containing strings that only look vaguely path-like

## Rendering Contract

V1 should introduce a focused local-file parsing layer rather than trying to repurpose the generic markdown helper unchanged.

Recommended shape:

- keep image-line handling exactly as it works today
- for plain-text blocks, replace the current "escape entire block" behavior with "escape everything except recognized local file references"
- preserve the `<pre class="wm-message-plain">` container so formatting stays visually close to current chat output
- preserve the current newline-collapsing behavior from `collapseNewlines(...)`

Recommended responsibility split:

1. Add a shared helper in the UI rendering layer, for example `src/ui/rendering/local-file-links.js`.
2. The helper should detect supported local-link forms and return escaped HTML fragments plus safe internal hrefs.
3. `renderChatMessageHtml(...)` should call that helper for non-image text blocks.

The helper should do all of the following:

- detect markdown local links before scanning for bare paths so the same target is not linked twice
- recognize angle-bracket destinations for markdown paths with spaces
- strip a trailing `:line` suffix from the generated href when present
- keep the visible link text close to the original message text
- emit anchors with a dedicated class such as `wm-local-file-link`
- escape link labels and href attributes with the same rigor as the current renderer
- leave unrecognized text fully escaped and unchanged

## Link Detection Rules

The parser should be intentionally conservative.

### Bare path detection

Bare-path activation should require all of the following:

- the text starts with a known absolute-path prefix such as `/Users/` or `/home/`
- the candidate looks like a path, not an arbitrary slash-delimited string
- the candidate ends at whitespace or explicit surrounding punctuation boundaries such as `.`, `,`, `)`, and `]`
- a trailing `:number` suffix is treated as optional line metadata, not part of the resolved path

Examples the matcher should handle deliberately:

- `See /Users/mini/code/wingmen/docs/design.md.`
- `Look at (/Users/mini/code/wingmen/src/server.ts:625)`
- `Path: /Users/mini/code/wingmen/docs/design.md, then continue`

This keeps the matcher from turning unrelated text into clickable anchors.

### Markdown link detection

Markdown activation should require all of the following:

- a syntactically valid markdown link shape
- a destination that resolves to a supported local absolute path
- no reliance on the generic markdown helper's current `target="_blank"` semantics

This matters because generic markdown rendering would open links with web-link behavior, while this feature needs internal Files routing.

## URL Generation

For each recognized local path target:

1. Normalize the local path candidate for href generation.
2. Remove any `:line` suffix from the navigated target.
3. Percent-encode unsafe characters inside path segments while preserving `/` separators in the route slug.
4. Build an internal href under `/files/`.

Examples:

- source text: `/Users/mini/code/wingmen/docs/design.md`
- href: `/files//Users/mini/code/wingmen/docs/design.md`

- source text: `/Users/mini/code/wingmen/src/server.ts:625`
- href: `/files//Users/mini/code/wingmen/src/server.ts`

- source text: `[My Report](</Users/mini/Documents/My Report.md:3>)`
- href: `/files//Users/mini/Documents/My%20Report.md`

The implementation detail matters here: do not percent-encode the whole path with `encodeURIComponent(...)`, because that would encode `/` separators and break the current `/files/<slug>` contract. The generated href should match the examples above.

## UX Expectations

### Successful in-scope path

When a user clicks a supported local file reference:

- the browser navigates to `/files/...`
- the Files route probes the target
- a directory target opens as the current directory
- a file target opens the parent directory and file preview
- after load, the browser URL is normalized to the backend-reported relative path

### Out-of-scope or invalid path

When a user clicks a local-looking path that is outside the allowed scope or not actually readable:

- the click still routes into the Files surface
- the backend rejects the target
- the user sees the existing error behavior for that Files request

This is acceptable for v1 because it preserves the existing trust model and avoids duplicating server-side access logic in the browser.

## Implementation Plan

### 1. Add a local-link rendering helper

Add a shared helper module in the UI rendering layer that:

- parses markdown local links
- parses bare absolute paths
- returns escaped HTML with local-file anchors only

This helper should be narrowly scoped to the supported v1 shapes rather than marketed as a general markdown engine.

### 2. Update `renderChatMessageHtml(...)`

Change `src/ui/rendering/chat-message-content.js` so that:

- image-line handling remains unchanged
- text blocks still render inside `<pre class="wm-message-plain">`
- non-image text blocks pass through the new local-link helper before being wrapped in `<pre>`

The helper should emit anchors with a dedicated class so long file links can be styled intentionally without affecting existing inline image styling.

### 3. Add focused link styling

Add CSS for the local-file anchor class so long absolute paths remain readable inside the existing `<pre class="wm-message-plain">` presentation.

The styling goal is readability, not a new visual language. It should preserve transcript scanning and avoid breaking the current inline-image treatment.

### 4. Reuse the existing conversation surfaces

No per-surface feature branching should be needed once the shared renderer is updated, because these already flow through `renderChatMessageHtml(...)`:

- `src/ui/live/conversation-window.js`
- `src/ui/live/chat-component.js`
- `src/ui/views/live-view.js`
- `src/ui/chat/private-chat.js`
- `src/ui/home/archive.js`

### 5. Do not add backend routes in v1

Do not introduce a new `/open-file` or `/api/local-links/resolve` endpoint for the first release.

The existing docs routes already provide:

- path normalization
- directory/file probing
- scope enforcement
- relative-path normalization after load

### 6. Add targeted tests

The deliverable should include tests, not just implementation notes.

Recommended coverage:

- parser tests for bare absolute paths
- parser tests for markdown local links
- parser tests for angle-bracket markdown destinations with spaces
- parser tests for trailing punctuation and `:line` suffix handling
- regression tests proving remote links are not newly activated
- regression tests proving uploaded image markdown still renders inline
- Files bootstrap tests for absolute-path slugs resolving into the existing tree/preview flow
- a rendering-level test that proves mixed text plus local links still renders inside `<pre class="wm-message-plain">`

Given the repo's current test setup, the natural shape is renderer-adjacent coverage such as `src/ui/rendering/chat-message-content.test.js` plus a Files-route test adjacent to `src/ui/files/api.js`.

## Acceptance Criteria

### Core behavior

- In live session conversation, clicking a supported local file reference opens the Files surface on that target.
- In private chat, clicking a supported local file reference opens the Files surface on that target.
- In the archived-session dialog, clicking a supported local file reference opens the Files surface on that target.
- Markdown links to local absolute paths are clickable.
- Bare absolute local paths without spaces are clickable.
- Directory targets open the directory view and file targets open the preview flow.
- Uploaded image markdown still behaves as it does today.
- Ordinary remote links in chat do not become a side effect of this change.
- Supported local-looking paths may still render as links even when the active Files scope cannot open them; those targets fail closed through the existing Files error behavior.
- Out-of-scope paths do not bypass backend authorization.

### Concrete validation examples

- `/Users/mini/code/wingmen/docs/feature-clickable-local-file-links.md`
- `[design doc](/Users/mini/code/wingmen/docs/feature-clickable-local-file-links.md)`
- `/Users/mini/code/wingmen/src/server.ts`
- `/Users/mini/code/wingmen/src/server.ts:625`
- `[My Report](</Users/mini/Documents/My Report.md>)`

## Follow-Up Work, If Needed

These are valid follow-ups, but they are not part of the v1 deliverable:

- SPA click interception for local file anchors to avoid a full-page navigation
- support for `~/...` shorthand path expansion
- preservation of `line` metadata through Files URL normalization
- editor deep-link or line-jump behavior
- broader markdown-link activation in conversation surfaces

## Final Design Summary

Implement v1 as a focused `wingmen` frontend change:

- extend `renderChatMessageHtml(...)` rather than replacing chat rendering wholesale
- add a dedicated local-file parsing helper
- generate internal `/files/...` anchors for supported local paths
- rely on the existing docs/files APIs for path validation and normalization
- ship the change with targeted renderer and route tests

That is the smallest design that fully addresses the reported user pain while keeping rendering risk and backend scope under control.
