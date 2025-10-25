# Wingman V2 Server Refactor Plan

## Current State Summary
- `src/server.ts` (~2.3k LOC) still centralises bootstrap, HTTP routing, agent orchestration, docs explorer, uploads, static asset serving, webhook handling, and git worktree management in one module.
- Top-level side effects now span tmux cleanup, preset seeding, directory creation across project/user data roots, file watcher startup, and image cleanup scheduling.
- API handling is split between a `handleWebhookRequest` pre-check and a long `handleApi` switch that covers `/api/config`, `/docs/*`, `/orchestrators*`, `/sessions*`, `/uploads`, `/directories`, and git worktree provisioning.
- Utility concerns (path sanitisation, preset working dir generation, message sync, image placeholder building, doc tree traversal, git commands, watcher orchestration, etc.) remain inline, impeding reuse and isolated testing.
- Static asset helpers (`serveIndex`, `resolveAsset`, `servePublicAsset`, `serveAceBuildsAsset`, `resolveTempImage`) continue to live beside business logic.
- Docs endpoints now operate relative to the user home (`~/Documents/Wingman`) with extra boundary checks, further increasing the surface area inside the module.

## Refactor Objectives
- Reduce `src/server.ts` to a thin entrypoint that wires together clearly scoped modules.
- Group domain logic by responsibility (sessions, orchestrators, docs, uploads, static assets, bootstrap tasks, webhooks, git utilities) to improve readability and future changes.
- Preserve current HTTP contract and side effects (default presets, message store sync, image cleanup schedule, file watcher lifecycle).
- Improve testability of discrete behaviors by relocating them into functions without hidden module state.
- Provide migration steps that minimise risk and allow incremental PRs/commits.

## Proposed Module Layout
- `src/server/index.ts`: Bun entrypoint; imports bootstrap routines and the HTTP server factory.
- `src/server/bootstrap/`
  - `tmux.ts`: `ensureWingmanAgentsSessionClean`, tmux helpers.
  - `presets.ts`: default preset definitions + `ensurePreset`.
  - `images.ts`: `scheduleImageCleanup` and related constants.
  - `paths.ts`: directory discovery (`homeDirectory`, `userDataRoot`, docs roots, etc.) to be shared.
  - `watchers.ts`: `FileWatcherRunner` lifecycle and orchestrator trigger directory bootstrap.
- `src/server/services/`
  - `session-service.ts`: wraps `ProcessManager`, message store sync helpers, URL builders.
  - `docs-service.ts`: docs browsing/loading/updating utilities with home-directory boundary checks.
  - `orchestrator-service.ts`: preset directory prep, intro message delivery, launch orchestration.
  - `uploads-service.ts`: image storage paths, placeholders, cleanup runner integration.
  - `git-worktree-service.ts`: git command helpers (`describeGitRepository`, `createGitWorktree`, validation utilities).
  - `directory-service.ts`: project/user-directory listing shared by docs/orchestrators.
- `src/server/routes/`
  - `router.ts`: exports a function `(request, url) => Response` delegating to individual route modules.
  - `config-routes.ts`, `docs-routes.ts`, `orchestrator-routes.ts`, `session-routes.ts`, `upload-routes.ts`, `directory-routes.ts`: each expose handlers for their URL space.
  - `webhook-routes.ts`: wrappers around webhook endpoints (currently `/v1/api/webhook/off`).
  - `git-worktree-routes.ts`: surface git worktree provisioning if separation from docs routes is preferred.
- `src/server/static/`
  - `assets.ts`: `resolveAsset`, `servePublicAsset`, `serveAceBuildsAsset`.
  - `index.ts`: `serveIndex`.
  - `images.ts`: `resolveTempImage`.
- Shared utilities (`src/server/utils/`) for helpers like `sleep`, `normaliseOptionalString`, `parsePresetInteger`, and host selection.

> NOTE: Layout names are suggestions; adapt to existing conventions during implementation to avoid churn.

## Migration Phases
1. **Bootstrap Extraction**
   - Create `src/server/bootstrap` modules for tmux cleanup, preset seeding, image cleanup, docs/home path discovery, and watcher startup.
   - Update `src/server.ts` imports to use new helpers while keeping routing inline.
   - Verify side effects still run on startup (`bun start` smoke/manual check).

2. **Service Layer Extraction**
   - Move docs/path utilities, orchestrator helpers, message sync helpers, upload utilities, git worktree helpers, and directory listing helpers into `services/`.
   - Ensure git commands and watcher controls expose clear error handling boundaries for re-use.
   - Replace inline calls in `src/server.ts` with service functions; keep API switch statement intact for now.
   - Ensure shared state (`manager`, `messageStore`, `config`, `fileWatcherRunner`) flows through explicit parameters or exported singletons.

3. **Route Modularisation**
   - Introduce `routes/router.ts` that maps pathname + method to handlers returned by service calls.
   - Gradually relocate each `/api/...` group to dedicated route modules, keeping response shapes unchanged (including webhook preflight and git worktree endpoints).
   - Unit slice by slice (e.g., start with `/api/config`, then docs, uploads, sessions, orchestrator directories, webhooks) to limit diff scope.

4. **Static Asset & Webhook Separation**
   - Move static asset helpers to `static/` modules; update the main request handler to call the extracted functions.
   - Extract webhook handling into a dedicated route module to decouple pre-check logic from the main API path.
   - Ensure path safety checks remain intact (`ace-builds` boundary, image directory validation, docs root guard).
   - Harden `servePublicAsset` by normalising and bounding requests to the public directory (mirror the `/ace-builds` guard) to close the current traversal gap. The extracted helper should:
     - Resolve `../public` to an absolute path once and cache a boundary string (e.g., via `normalize(join(projectRoot, "public"))`).
     - Normalise every request suffix (`normalize(join(publicRoot, suffix))`) and reject anything that does not start with the boundary prefix.
     - Keep MIME sniffing and cache headers unchanged. Add a manual regression step (`/../README.md` must 404) to Phase 4 validation.

5. **Finalize Entry Point**
   - Replace monolithic `handleApi` with router import; reduce `src/server.ts` to:
     - load config
     - run bootstrap tasks
     - create `ProcessManager`
     - start Bun server using extracted router + static handlers.
   - Relocate the final file to `src/server/index.ts` (or similar) and update `src/index.ts` import.
   - Delete deprecated helpers left behind after extraction.

6. **Cleanup & Documentation**
   - Update architecture docs to reflect new module layout and watcher/git responsibilities.
   - Consider adding lightweight tests for services (if/when testing strategy permits).
   - Review lint/format post-refactor to ensure TypeScript strictness remains satisfied.

## Key Considerations & Risks
- Maintain path safety when refactoring docs and upload helpers; keep `normalize` + boundary checks intact, especially against home-directory traversal.
- Address the static asset traversal bug (`servePublicAsset`) early to avoid shipping the refactor with a known security regression; new static module should enforce directory boundaries the same way image and ace-build helpers do, including explicit rejection logs for attempted escapes.
- Preserve async ordering during bootstrap (config load → tmux cleanup → directory creation → watcher startup → ProcessManager init → presets/image schedule). Converting to explicit bootstrap pipeline should enforce order.
- Ensure `manager` events still update `messageStore` when moved into services and that watcher teardown remains hooked into lifecycle events.
- Verify orchestrator launch flow still waits for agent readiness and handles retries; extraction should not change timing constants.
- Keep git command error handling user-facing; map thrown errors to HTTP responses consistently when moved into services/routes.
- Be mindful of default exports vs. singleton instances to avoid double-initialisation across modules.
- Keep incremental commits small; avoid moving code and rewriting logic simultaneously to ease review.

## Open Questions / Follow-Ups
- Confirm desired naming for new directories (`src/server/` vs `src/http/`) before moving files.
- Decide whether to keep `manager`, `config`, `fileWatcherRunner`, and server exports for external imports or expose via service modules.
- Determine if we should introduce a minimal router utility (e.g., map of `{method, path}`) or stick with manual branching for now.
- Evaluate adding type definitions for API responses once routes are modularised (including webhook payloads).
- Clarify long-term plan for git worktree helpers (e.g., reuse in UI or CLI) before locking module boundaries.
- Align future monitoring/logging enhancements with the new structure (e.g., dedicated middleware slot).

## Success Metrics & Validation
- **Phase 1**: `src/server.ts` LOC reduced by ~20%; bootstrap modules created and imported successfully; `bun start` passes smoke tests.
- **Phase 2**: Services extracted with clear interfaces; shared state passed via parameters; no regressions in API responses.
- **Phase 3**: Routes modularized; router handles delegation; response shapes unchanged.
- **Phase 4**: Static assets and webhooks separated; path safety preserved.
- **Phase 5**: `src/server.ts` < 500 LOC; entry point clean; all imports resolved.
- **Phase 6**: Architecture docs updated; lint/format passes; optional tests added for services.

## Additional Recommendations
- **Version Control**: Create a feature branch for the refactor. Use `git commit --fixup` for iterative improvements.
- **Code Review**: For each phase, include a summary of changes and rationale in PR descriptions.
- **Rollback Plan**: Keep original `server.ts` as backup; test thoroughly before merging.
- **Performance**: Monitor startup time and memory usage post-refactor to ensure no degradation.
- **Future-Proofing**: Design services with dependency injection in mind for easier testing later.
