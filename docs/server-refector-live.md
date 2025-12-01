# Server Refactor (Live Tracker)

Working log to shrink `src/server.ts` by moving self-contained slices into scoped modules. Keep this file up to date as we migrate code; tick items only after the move is done and the change is reflected here.

## Context
- `src/server.ts` is ~6.1k LOC with bootstrap, static assets, uploads, docs, git helpers, orchestrator presets, access control, and routing all inline.
- Prior plans: see `docs/refactor.md` and `docs/refactor-prep.md` for target structure and quick wins.

## Ready-to-Migrate Slices (initial pass)
- [x] Agent API bootstrap (`ensureAgentApiBinary`, platform/arch selection, SHA verification, chmod) → `src/server/bootstrap/agentapi.ts` (imported into `src/server.ts`).
- [x] Warm restart helpers (`runTmuxCommand`, warm restart marker load/write/clear, `rehydrateWarmSessions`, restart flags) → `src/server/bootstrap/warm-restart.ts` (server now imports state + helpers).
- [x] Upload utilities (user workspace + upload directory setup, `createImageFilename`/`createAttachmentFilename`, placeholder builders) → `src/server/uploads/helpers.ts` (server uses the helper factory).
- [ ] Static asset resolution (ace/public/vendor root discovery and `createStaticAssetService` wiring) → `src/server/static/assets.ts`.
- [ ] Docs navigation helpers (`resolveDocsPath`, listing/preview metadata, directory creation/move/copy guards) → `src/server/docs/service.ts`.
- [ ] Git helpers (`runCommand`, repo/worktree description, validation + creation helpers) → `src/server/git/`.
- [ ] Orchestrator preset helpers (template/active directory listing, preset working dir prep, intro message rendering/sending) → `src/server/orchestrator/`.
- [ ] Access control bootstrap (registering access rules + `ensureApiAccess`/`ensurePageAccess`/admin guards) → `src/server/auth/access-rules.ts`.

## Next Step
- Pick the lowest-risk slice above (likely the agent API bootstrap or uploads helpers), draft the target module, update imports, and mark the item complete here with a short note on the outcome.
