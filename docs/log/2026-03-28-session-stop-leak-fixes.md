# Session Stop Leak Fixes — 2026-03-28

## Context
RCA identified several leak paths in the session stop flow where resources (ports, PM2 processes) could be leaked and run status could be marked as stopped even when sessions were still alive.

## Decisions

### 1. CLI Auth: Standardize on WINGMAN_NSEC
- **Before**: `resolveSecretKey()` tried `WINGMAN_NIP98_NSEC` as fallback, docs listed `KEYTELEPORT_PRIVKEY` as CLI auth option
- **After**: Only `WINGMAN_NSEC` (and explicit `--key` flag) are valid CLI auth sources
- **Rationale**: `WINGMAN_NIP98_NSEC` was legacy naming, `KEYTELEPORT_PRIVKEY` is a server-side key that should never be used for CLI auth. Simplifies the mental model.
- **Scope**: CLI auth resolution and user-facing docs only. Server-side KEYTELEPORT_PRIVKEY usage (bot keys, signing, escrow) is unchanged.

### 2. jobs-runs.ts: Fail loudly on session stop failures
- **Before**: `stopSession()` return value was ignored; run was always marked as stopped
- **After**: Track `anyFailed` flag; throw (non-zero exit) if any session stop fails, leaving the run in its current status
- **Rationale**: Silent success masks real failures; operators need to know when a stop didn't actually work

### 3. jobs-api handleStopRun: Stop sessions server-side
- **Before**: Only called `updateRunStatus("stopped")` — never actually stopped linked sessions
- **After**: Calls `manager.stopSession()` for each linked session; only marks stopped if all succeed; returns 500 with details on failure
- **Rationale**: The API-backed approach avoids shelling one CLI into another and uses the same ProcessManager that manages the sessions

### 4. process-manager: Refuse to mark stopped when PM2 process survives
- **Before**: If PM2 delete failed, session was still marked stopped and port released (leaked PM2 process + unreachable port)
- **After**: If `deletedFromPm2` is false after cleanup, throw an error. Session stays in current state, port stays allocated. Operator must investigate.
- **Rationale**: Better to keep the port reserved and the session visible than to silently leak a process

## Files Changed
- `clis/lib/auth.ts` — Standardize on WINGMAN_NSEC
- `clis/README.md` — Remove legacy env var references
- `README.md` — Update CLI auth example
- `clis/jobs-runs.ts` — Propagate stop failures, exit non-zero
- `src/jobs-api.ts` — Stop linked sessions before marking run stopped
- `src/agents/process-manager.ts` — Throw on PM2 cleanup failure, export `pm2StopShouldMarkStopped`

## Tests Added/Updated
- `clis/lib/auth.test.ts` — 6 tests for WINGMAN_NSEC-only resolution
- `clis/lib/jobs-runs-stop.test.ts` — 2 tests for failure propagation logic
- `src/agents/process-manager.test.ts` — 2 tests for pm2StopShouldMarkStopped
- `src/jobs-api.test.ts` — 2 tests for server-side session stop behavior

## Residual Risk
- If a PM2 process becomes truly orphaned (e.g., PM2 daemon crash), the session will remain in "running" state with no way to stop it through normal flows. The existing orphan sweep on server startup (`sweepOrphanedPm2Processes`) should catch these on next restart.
