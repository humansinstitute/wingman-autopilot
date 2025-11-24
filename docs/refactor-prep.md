Refactor prep tasks (quick wins)

- Extract static asset helpers (`serveIndex`, `resolveAsset`, `servePublicAsset`, `serveAceBuildsAsset`, `resolveTempImage`) into `src/server/static/` and import them, keeping module MIME as `application/javascript` so ES modules load correctly.
- Move the agent binary bootstrap (`ensureAgentApiBinary` platform detect/download/sha/chmod) into `src/server/bootstrap/agentapi.ts`; call it once during startup.
- Centralize shared paths/constants (project root, module dir, `agentApiBinaryPath`, public/ace/image roots) in `src/server/bootstrap/paths.ts` for reuse across routes/static/doc helpers.
- Lift the access-rule registration block into `src/server/auth/access-rules.ts` and expose an initializer; `server.ts` should just invoke it.
- Group store/process setup (projects/todos/prompt queue/message store/file watcher/preset store) in `src/server/bootstrap/state.ts` returning initialized instances for cleaner imports.
- Wrap the `/api/*` switch into `src/server/routes/api-router.ts` (can remain a switch initially) so `server.ts` delegates instead of inlining routing; similarly, create a tiny `static-router` for non-API paths if helpful.
