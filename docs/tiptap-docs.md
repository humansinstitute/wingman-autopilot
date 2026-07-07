# TipTap Editing For Files And Session Artifacts

## Goal

Add a TipTap-based rich text editing experience to Autopilot for:

- text files in the Files/Docs view;
- pinned files in the live Chat Session Plus Artifact pane.

The first implementation should be file-backed. Autopilot should continue reading and writing the real workspace file through the existing docs file API. This is different from Flight Deck documents, which store a richer document model and only derive Markdown-compatible fields for compatibility.

## Current Autopilot Surfaces

### Files/Docs View

Relevant files:

- `src/ui/views/files-view.js`
- `src/ui/files/api.js`
- `src/ui/modals/file-editor.js`
- `src/ui/writer/writer-panel.js`
- `src/server/docs-routes.ts`

The Files/Docs view already supports:

- directory browsing through `GET /api/docs/tree`;
- preview loading through `GET /api/docs/file`;
- raw file loading through `GET /api/docs/file/raw`;
- file saves through `PUT /api/docs/file` with `expectedMtimeMs`;
- image/PDF/JSON/CSV/code/Markdown preview detection in `docs-routes.ts`;
- an Ace modal editor for direct text editing;
- a writer panel that renders Markdown blocks, edits blocks with textareas, polls file mtimes, and handles pasted image upload into the current file directory.

The writer panel is already reused in the Files/Docs preview body for editable text files:

```js
createWriterPanel(null, files.previewPath, { showToast })
```

### Chat Session Plus Artifact Pane

Relevant files:

- `src/ui/views/live-view.js`
- `src/ui/live/artifact-pane-state.js`
- `src/ui/live/writer-panel-state.js`
- `src/ui/writer/artifact-file-selector.js`
- `src/ui/writer/writer-panel.js`
- `src/ui/services/sessions.js`
- `src/mcp/wingman-api.ts`

The live session artifact editor is also file-backed. The UI pins one or more file paths into session metadata through:

- `POST /api/mcp/wingman/artifact/pin`
- `GET /api/mcp/wingman/artifact/pin?sessionId=...`

When the pane opens, `live-view.js` chooses the active pinned path and renders:

```js
createWriterPanel(sessionId, effectiveFile, { showToast })
```

This means TipTap can replace or augment one shared editor component and cover both requested surfaces.

### Generated Artifacts Gallery

Relevant files:

- `src/storage/artifacts-store.ts`
- `src/ui/live/artifacts-panel.js`
- `src/server/api-routes.ts`
- `src/server/session-api-routes.ts`

This is separate from the pinned artifact editor. The gallery lists generated artifact metadata from SQLite and serves raw files through `/api/artifacts/:id/raw`. It should not be the first target for editing unless we later decide generated artifacts should be editable and written back to their source files.

## Flight Deck Reference

Relevant Flight Deck files:

- `../wm-fd-2/src/docs/editor/prosemirror-flightdeck-schema.js`
- `../wm-fd-2/src/docs/editor/tiptap-editor-adapter.js`
- `../wm-fd-2/src/docs/editor/markdown-to-prosemirror.js`
- `../wm-fd-2/src/docs/editor/prosemirror-to-flightdeck.js`

Flight Deck uses TipTap with:

- `@tiptap/core`
- `@tiptap/starter-kit`
- `@tiptap/extension-link`
- `@tiptap/extension-placeholder`
- table extensions
- task list extensions
- image support
- custom Flight Deck nodes/marks for mentions, storage files, storage images, upload placeholders, and stable block IDs.

The transferable pieces are:

- a small editor adapter around `new Editor(...)`;
- a schema module that centralizes extensions;
- Markdown-to-ProseMirror conversion;
- ProseMirror-to-Markdown conversion;
- paste handling for images;
- stable editor lifecycle methods: `destroy`, `setEditable`, `getJSON`.

The non-transferable piece is the data model. Flight Deck stores `editor_state`, `content_blocks`, and `content_format` on document records. Autopilot should not add those fields to normal workspace files. For direct Markdown/text editing, the canonical persisted state remains the file contents.

## Proposed Architecture

### Shared Editor Module

Add a new UI module under `src/ui/tiptap/`:

- `src/ui/tiptap/extensions.js`
- `src/ui/tiptap/markdown-to-prosemirror.js`
- `src/ui/tiptap/prosemirror-to-markdown.js`
- `src/ui/tiptap/file-editor-adapter.js`
- `src/ui/tiptap/tiptap-file-panel.js`

Keep these helpers out of `src/ui/app.js`, `src/ui/views/files-view.js`, and `src/ui/views/live-view.js`.

`tiptap-file-panel.js` should expose a component with the same shape as the existing writer panel:

```js
createTiptapFilePanel(sessionId, targetFile, {
  showToast,
  mode,
  fallbackEditor,
}) -> { panel, cleanup }
```

The component should own:

- file load through `/api/docs/file/raw`;
- mtime tracking;
- dirty state;
- save through `PUT /api/docs/file`;
- conflict display;
- image paste upload;
- TipTap instance creation and destruction.

### Editor Mode Routing

Add a small routing helper, for example `src/ui/writer/editor-mode.js`:

- Markdown files (`.md`, `.markdown`, `.mdx`) default to TipTap rich mode.
- Other text/code files continue using Ace or the existing textarea/code writer path.
- JSON and CSV keep the structured preview and Ace modal editing.
- Binary, image, and PDF files remain preview-only.

The Files/Docs view and the Chat Session Plus Artifact pane should both call the same factory:

```js
createFileEditingPanel(sessionId, targetFile, { showToast })
```

That factory can choose TipTap or the existing writer panel. This prevents `files-view.js` and `live-view.js` from learning TipTap-specific branching.

### Toolbar

Create a reusable toolbar module such as `src/ui/tiptap/toolbar.js`.

Required controls for the first pass:

- bold;
- italic;
- inline code;
- link add/remove;
- heading level;
- bullet list;
- ordered list;
- task list if enabled;
- blockquote;
- code block;
- undo;
- redo;
- save;
- source toggle.

The source toggle matters because direct Markdown editing is not lossless for every Markdown construct. Users need a way to inspect and repair the raw Markdown without leaving the pane.

### Markdown Round-Trip Policy

The file contents are canonical. TipTap works on an in-memory ProseMirror document derived from Markdown.

Load flow:

1. `GET /api/docs/file/raw`.
2. Decode bytes to text.
3. Parse Markdown to ProseMirror JSON.
4. Render TipTap.
5. Keep the original text and `mtimeMs`.

Save flow:

1. Serialize ProseMirror JSON back to Markdown.
2. Save through `PUT /api/docs/file` with `expectedMtimeMs`.
3. Update `mtimeMs` from the response.
4. Update the raw-source buffer.

Known lossy areas:

- frontmatter ordering and comments;
- HTML blocks;
- MDX JSX;
- reference-style links;
- table alignment;
- nested complex list formatting;
- fenced code block edge cases;
- comments and unusual whitespace.

For those cases, the source toggle is the escape hatch. The implementation should not silently discard unsupported nodes. If parsing or serialization encounters unsupported content, surface a visible warning and prefer source mode.

### ProseMirror Schema

Start with a smaller Autopilot schema than Flight Deck:

- StarterKit with headings, lists, blockquote, code block, horizontal rule, history;
- Link;
- Placeholder;
- TaskList/TaskItem if the Markdown serializer supports them;
- Image for Markdown image syntax;
- optional Table only after round-trip tests cover table output.

Do not copy Flight Deck storage nodes, mentions, or block ID extensions in the first pass. They are tied to Flight Deck records and Tower storage semantics.

### Image Paste

Reuse the current file-backed behavior from `writer-panel.js`:

- upload pasted images with `POST /api/docs/file`;
- write them into the same directory as the Markdown file;
- insert a relative Markdown image reference into the document;
- render previews through `/api/docs/file/download?path=...&inline=1`.

TipTap paste handling should insert an upload placeholder node or a temporary paragraph while the upload is pending. On success it should replace the placeholder with an image node whose `src` is the relative filename. On failure it should remove the placeholder and show a visible error.

### Conflict Handling

Keep using `expectedMtimeMs`.

On a save conflict:

- do not overwrite the file;
- show a conflict banner in the editor panel;
- offer `Reload`, `Copy current draft`, and `Open source compare` actions;
- keep the unsaved ProseMirror JSON/Markdown draft in memory until the user chooses an action.

Polling should pause while the editor is dirty or focused. When polling detects an external mtime change while clean, reload automatically and announce it with `aria-live`.

### Server Changes

Most server functionality already exists in `src/server/docs-routes.ts`.

Likely backend additions:

- expand Markdown extension handling consistently for `.mdx` if TipTap supports source-mode fallback;
- optional `GET /api/docs/file/editor-metadata?path=...` if the UI needs a lighter capability check than full raw load;
- tests around `PUT /api/docs/file` conflict behavior and Markdown file MIME/capability detection.

Avoid adding TipTap conversion endpoints unless browser-side parsing is too heavy. Keeping conversion client-side avoids making the server responsible for editor-specific document shape.

### Static Assets And Dependencies

Autopilot currently serves selected packages through `/vendor/...` in `src/server/static-assets.ts`. Add TipTap dependencies to `package.json` and register the required vendor packages:

- `@tiptap/core`
- `@tiptap/starter-kit`
- `@tiptap/extension-link`
- `@tiptap/extension-placeholder`
- `@tiptap/extension-image`
- `@tiptap/extension-task-list`
- `@tiptap/extension-task-item`
- `@tiptap/pm`
- optional table packages when table support is enabled.

Because files under `src/ui` are dynamically served with `application/javascript`, new modules under `src/ui/tiptap/` should load correctly as long as imports resolve. Vendor package registration must preserve JavaScript MIME types or browser module loading will fail.

### Files/Docs View Integration

Change `src/ui/views/files-view.js` narrowly:

- replace direct `createWriterPanel(...)` usage with a shared `createFileEditingPanel(...)`;
- keep image/PDF/JSON/CSV preview branches unchanged;
- add a toolbar action that toggles rich/source mode for Markdown files if the editor panel does not expose that internally;
- keep the Ace modal available as raw edit fallback.

The preview body should not duplicate TipTap lifecycle logic. It should mount the returned panel and call cleanup when the preview file changes, matching the existing `activeFileWriter` pattern.

### Chat Session Plus Artifact Pane Integration

Change `src/ui/views/live-view.js` narrowly:

- replace direct `createWriterPanel(sessionId, effectiveFile, ...)` usage with the same shared `createFileEditingPanel(...)`;
- keep `createArtifactFileSelector(...)`, pinned pager, and pane state logic unchanged;
- preserve the current behavior where pinned files take priority over `targetFile`.

This gives the live Artifact pane the same Markdown editor as Files/Docs without duplicating implementation.

### Accessibility And Agent Testing

The TipTap panel should include:

- `role="region"` and a clear accessible label;
- `aria-label` on every toolbar button;
- `aria-pressed` for toggle buttons;
- `data-testid` on the panel, toolbar, source toggle, save button, conflict banner, and editor mount;
- `aria-live="polite"` for save/reload/conflict status;
- keyboard-accessible toolbar controls;
- a visible focus outline inside the editor.

Suggested test ids:

- `tiptap-file-panel`
- `tiptap-toolbar`
- `tiptap-editor`
- `tiptap-source-editor`
- `tiptap-save-button`
- `tiptap-conflict-banner`
- `tiptap-mode-toggle`

## Implementation Phases

### Phase 1: Markdown Editor Foundation

- Add TipTap dependencies and static vendor registrations.
- Add `src/ui/tiptap/` modules.
- Support Markdown load, edit, source toggle, save, and cleanup.
- Support conflict banner on stale mtime.
- Add unit tests for Markdown conversion and editor factory selection.

### Phase 2: Files/Docs Integration

- Route Markdown preview editing through `createFileEditingPanel(...)`.
- Keep existing Ace modal as raw editor.
- Verify `.md`, `.markdown`, and `.mdx` behavior.
- Add focused tests for `files-view.js` integration and static asset MIME serving.

### Phase 3: Chat Session Plus Artifact Integration

- Route pinned file editing through `createFileEditingPanel(...)`.
- Preserve artifact selector, pinning, pager, and layout behavior.
- Add tests that `live-view.js` uses the shared factory and keeps artifact selector fallback.

### Phase 4: Pasted Images And Rich Blocks

- Add image paste upload and relative path insertion.
- Add task lists.
- Add tables only after round-trip tests are acceptable.

### Phase 5: Polish And Migration Decisions

- Add editor preference persistence if users want Ace/source as default.
- Consider a read-only rich preview mode for unsupported Markdown.
- Decide whether generated artifact records should be editable or remain gallery-only.

## Testing Plan

Automated:

- `bun test src/server/docs-routes.test.ts`
- `bun test src/server/static-routes.test.ts`
- new tests for Markdown parse/serialize helpers;
- new tests for editor mode selection;
- existing `src/ui/views/files-view.test.js`;
- existing `src/ui/views/live-view.test.js`;
- existing `src/ui/live/writer-panel-state.test.js`.

Manual:

- open `/files/docs/tiptap-docs.md`;
- edit heading, paragraph, list, link, and code block;
- save and confirm the file on disk changed;
- paste an image into a Markdown file and confirm relative image rendering;
- pin the file to a live session and edit it in the Artifact pane;
- trigger a conflict by editing the file externally before saving and confirm the UI refuses to overwrite.

## Risks

- Markdown round-tripping can change formatting even when content is preserved.
- TipTap's package graph may require more vendor registrations than expected.
- MDX support may be rich-preview-only unless source mode is the default for `.mdx`.
- Large Markdown files are currently limited by `MAX_DOCS_FILE_SIZE`.
- Polling plus rich editing can be disruptive unless paused while dirty/focused.

## Recommendation

Implement TipTap as a shared file editor panel, not as a new document system. Use it for Markdown files in both Files/Docs and Chat Session Plus Artifact panes, keep Ace/source editing available, and avoid copying Flight Deck's record-backed document model into Autopilot. This gives Autopilot rich editing where it is useful while preserving the direct-file semantics agents and developers expect.
