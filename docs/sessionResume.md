# Session Resume Planning

## Motivation
- Operators need to revive previously stopped agent sessions without reconfiguring a fresh run.
- Codex CLI already supports reconnecting when supplied a prior `sessionId`/`refid`; Wingman should surface this path.
- Persisting resumable sessions unlocks future cross-agent resume support (Claude, Goose, OpenCode).

## Current Behaviour Snapshot
- `ProcessManager` (src/agents/process-manager.ts) allocates a fresh `crypto.randomUUID()` for each run and discards state when a session stops.
- `messageStore` (src/storage/message-store.ts) persists transcripts but not the metadata required to reconstruct an agent process.
- UI Live tab and `/api/sessions` only list in-memory sessions; stopped ones vanish from the dashboard, preventing reactivation.

## Target Outcomes
- Persisted catalog of sessions (active + stopped) that records command, working directory, agent type, and resume tokens.
- API surface to list restorable sessions and trigger a resume request.
- Codex-specific resume path that issues the CLI `--session <id>` (or equivalent) to rehydrate the agent backend.
- UX affordance to select a stopped session, view limited history, and resume from the dashboard or CLI.

## Assumptions
- Agent CLIs expose a stable flag to reconnect (Codex: `codex session resume <id>` or similar; confirm exact syntax).
- Stopped sessions may require port reallocation; previous port might be unavailable.
- Resume must not mutate historical transcripts already persisted in `messageStore`.
- We will respect the user's request for manual testing; automated suites remain unchanged.

## Design Outline

### 1. Session Registry Persistence
- Extend the SQLite schema with a `session_registry` (or enrich the existing `sessions` table) capturing:
  - `id`, `agent`, `status`, `started_at`, `stopped_at`, `working_directory`, `command`, `resume_token`, `last_port`, `metadata`.
- Record an entry when `ProcessManager.createSession` succeeds and patch `stopSession` to mark status + timestamps instead of removing the record.
- Store `SESSION_ID` (already exported to the env) and any resume token emitted by the agent process (parse stdout for refid lines or expose via structured events).
- Provide helper methods on `messageStore` or a new repository module to fetch resumable sessions independent of in-memory state.

### 2. Process Manager Enhancements
- Add `resumeSession(id: string): Promise<SessionSnapshot>`:
  - Fetch persisted metadata; bail if agent type no longer configured.
  - Allocate a fresh port (release old one).
  - Rebuild the launch command; for Codex append the resume switch (see next section).
  - Spawn subprocess, attach log capture, and push state back into `sessions` Map.
- Ensure resumed sessions reuse the original `id` so existing transcripts remain associated.
- Emit new event type (e.g., `session-resumed`) or reuse `session-started` with a `resumed: true` flag for UI cues.

### 3. Codex Resume Path
- Determine CLI contract (pending confirmation):
  - Option A: `codex resume <sessionId>`
  - Option B: `codex chat --session <sessionId>`
  - Validate by cross-referencing CLI docs or manual invocation.
- Update `config.ts` command builder for Codex to accept an optional resume token:
  - Extend `AgentCommandContext` to include `resumeToken?: string`.
  - During resume, pass through `--resume <token>` (placeholder; adjust to actual CLI syntax).
- Capture the resume token:
  - Monitor stdout for a line such as `refid: abc123`; parse and persist via a ProcessManager hook.
  - Alternatively, allow CLI to echo the token to a well-defined file path/pipe (if configurable).

### 4. API Surface
- `/api/sessions`:
  - Include stopped sessions with a `resumable` flag and `resumeToken` (mask if sensitive).
- New endpoint: `POST /api/sessions/:id/resume` triggering `ProcessManager.resumeSession`.
- Optional query: `GET /api/sessions?status=stopped` for dashboards.
- Ensure responses include latest `logs` (maybe limited) to aid selection.

### 5. UI Experience
- Home tab:
  - Add table section for stopped/resumable sessions with "Resume" action.
- Live tab:
  - When no active session is selected, offer a resume dropdown.
  - Preserve message drafts and log state after resume (current state maps already keyed by session id).
- Provide minimal toast copy consistent with branding (“Session resumed. We're on your wing.” already noted in docs/branding.md).

### 6. CLI Integration
- Extend `wingman-cli.js` to accept `--resume <id>` or surface a subcommand that proxies the new REST endpoint.
- Print helpful output when a session transitions from stopped → running.

### 7. Observability & Cleanup
- Retain historical logs but rotate to avoid unbounded growth (e.g., keep last N entries per session in SQLite or disk files).
- Consider garbage collection policy for stale sessions (manual purge, time-based cleanup).
- Document manual resume steps in README and docs once implemented.

## Implementation Phasing
1. Introduce persistence layer updates (schema migration scripts, data access methods).
2. Capture Codex resume token during run; store in registry.
3. Implement `ProcessManager.resumeSession` and REST endpoint.
4. Update UI + CLI to surface resume option.
5. Manual verification flow:
   - Start Codex session, capture `refid`.
   - Stop session via UI/API.
   - Resume using new action; confirm conversation continuity and CLI output.

## Open Questions
- Does Codex CLI expose a dedicated resume command or require full argument replay?
- Should resumed sessions reuse prior port when available, or always allocate fresh?
- How do other agents signal resume tokens? Need discovery before generalising.
- Do we need to persist environment overrides (e.g., per-session env vars) for accurate replay?

## Next Steps
- Confirm Codex CLI contract and stdout semantics (manual experiment).
- Design SQLite migration path (existing `data/wingman.db` is already in use).
- Align UI copy/design with branding guidelines once implementation begins.
