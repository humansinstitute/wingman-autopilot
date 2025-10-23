# Wingman V2 Server Refactor Plan

## Current State Summary
- `src/server.ts` (~1.7k LOC) handles bootstrap, HTTP routing, agent orchestration, docs explorer, uploads, and static asset serving in one module.
- Top-level side effects include tmux cleanup, preset seeding, directory creation, and recurring image cleanup tasks.
- API handling is implemented as a long `handleApi` function switching on `pathname` for `/api/config`, `/docs`, `/orchestrators`, `/sessions`, `/uploads`, and `/directories`.
- Utility concerns (path sanitisation, preset working dir generation, message sync, image placeholder building, etc.) are declared inline, making reuse and testing difficult.
- Static asset helpers (`serveIndex`, `resolveAsset`, `servePublicAsset`, `serveAceBuildsAsset`, `resolveTempImage`) sit beside business logic, complicating ownership boundaries.

## Refactor Objectives
- Reduce `src/server.ts` to a thin entrypoint that wires together clearly scoped modules.
- Group domain logic by responsibility (sessions, orchestrators, docs, uploads, static assets, bootstrap tasks) to improve readability and future changes.
- Preserve current HTTP contract and side effects (default presets, message store sync, image cleanup schedule).
- Improve testability of discrete behaviors by relocating them into functions without hidden module state.
- Provide migration steps that minimise risk and allow incremental PRs/commits.

## Proposed Module Layout
- `src/server/index.ts`: Bun entrypoint; imports bootstrap routines and the HTTP server factory.
- `src/server/bootstrap/`
  - `tmux.ts`: `ensureWingmanAgentsSessionClean`, tmux helpers.
  - `presets.ts`: default preset definitions + `ensurePreset`.
  - `images.ts`: `scheduleImageCleanup` and related constants.
  - `paths.ts`: directory discovery (`homeDirectory`, `userDataRoot`, etc.) to be shared.
- `src/server/services/`
  - `session-service.ts`: wraps `ProcessManager`, message store sync helpers, URL builders.
  - `docs-service.ts`: docs browsing/loading/updating utilities.
  - `orchestrator-service.ts`: preset directory prep, intro message delivery, launch orchestration.
  - `uploads-service.ts`: image storage paths, placeholders, cleanup runner integration.
- `src/server/routes/`
  - `router.ts`: exports a function `(request, url) => Response` delegating to individual route modules.
  - `config-routes.ts`, `docs-routes.ts`, `orchestrator-routes.ts`, `session-routes.ts`, `upload-routes.ts`, `directory-routes.ts`: each expose handlers for their URL space.
- `src/server/static/`
  - `assets.ts`: `resolveAsset`, `servePublicAsset`, `serveAceBuildsAsset`.
  - `index.ts`: `serveIndex`.
  - `images.ts`: `resolveTempImage`.
- Shared utilities (`src/server/utils/`) for helpers like `sleep`, `normaliseOptionalString`, `parsePresetInteger`, and host selection.

> NOTE: Layout names are suggestions; adapt to existing conventions during implementation to avoid churn.

## Migration Phases
1. **Bootstrap Extraction**
   - Create `src/server/bootstrap` modules for tmux cleanup, preset seeding, image cleanup, and directory constants.
   - Update `src/server.ts` imports to use new helpers while keeping routing inline.
   - Verify side effects still run on startup (`bun start` smoke/manual check).

2. **Service Layer Extraction**
   - Move docs/path utilities, orchestrator helpers, message sync helpers, and upload utilities into `services/`.
   - Replace inline calls in `src/server.ts` with service functions; keep API switch statement intact for now.
   - Ensure shared state (`manager`, `messageStore`, `config`) flows through explicit parameters or exported singletons.

3. **Route Modularisation**
   - Introduce `routes/router.ts` that maps pathname + method to handlers returned by service calls.
   - Gradually relocate each `/api/...` group to dedicated route modules, keeping response shapes unchanged.
   - Unit slice by slice (e.g., start with `/api/config`, then docs, uploads, sessions) to limit diff scope.

4. **Static Asset Separation**
   - Move static asset helpers to `static/` modules; update the main request handler to call the extracted functions.
   - Ensure path safety checks remain intact (`ace-builds` boundary, image directory validation).

5. **Finalize Entry Point**
   - Replace monolithic `handleApi` with router import; reduce `src/server.ts` to:
     - load config
     - run bootstrap tasks
     - create `ProcessManager`
     - start Bun server using extracted router + static handlers.
   - Relocate the final file to `src/server/index.ts` (or similar) and update `src/index.ts` import.
   - Delete deprecated helpers left behind after extraction.

6. **Cleanup & Documentation**
   - Update architecture docs to reflect new module layout.
   - Consider adding lightweight tests for services (if/when testing strategy permits).
   - Review lint/format post-refactor to ensure TypeScript strictness remains satisfied.

## Key Considerations & Risks
- Maintain path safety when refactoring docs and upload helpers; keep `normalize` + boundary checks intact.
- Preserve async ordering during bootstrap (config load → tmux cleanup → ProcessManager init → presets/image schedule). Converting to explicit bootstrap pipeline should enforce order.
- Ensure `manager` events still update `messageStore` when moved into services.
- Verify orchestrator launch flow still waits for agent readiness and handles retries; extraction should not change timing constants.
- Be mindful of default exports vs. singleton instances to avoid double-initialisation across modules.
- Keep incremental commits small; avoid moving code and rewriting logic simultaneously to ease review.

## Open Questions / Follow-Ups
- Confirm desired naming for new directories (`src/server/` vs `src/http/`) before moving files.
- Decide whether to keep `manager`, `config`, and `server` exports for external imports or expose via service modules.
- Determine if we should introduce a minimal router utility (e.g., map of `{method, path}`) or stick with manual branching for now.
- Evaluate adding type definitions for API responses once routes are modularised.
- Align future monitoring/logging enhancements with the new structure (e.g., dedicated middleware slot).

