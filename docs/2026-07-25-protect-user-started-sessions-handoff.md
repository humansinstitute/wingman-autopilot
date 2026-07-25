# Protect user-started sessions from automatic close-out

## Required invariant

Pete explicitly requires that a session he starts directly must never be automatically closed by the scheduled `Close out sessions` cleanup, even if an agent mistakenly sets `metadata.nextAction = stop`.

## Production evidence

- User-started session `ccac87cc-e9be-4c4e-8381-e99c71e5a604` was stopped mid-chat after inheriting `nextAction: stop`.
- Its native-resumed session `bbedf2fa-03bd-4eee-aedb-d38bfaf8e4dd` had `AGENT:false`, `ownerNpub === createdByNpub === Pete`, and `origin.type = native-resume`, but inherited `nextAction: stop` until the supervisor manually cleared it.
- The current cleanup in `src/sessions/next-action-cleanup.ts` matches every session with `nextAction: stop`; commit `ae33101` only adds protection for active Flight Deck direct-chat state and does not protect ordinary Pete-started live sessions.
- Canonical automatic-session provenance already exists in `src/sessions/autosession-cleanup.ts`: metadata.AGENT, explicit programmatic/legacy origins, dispatch metadata, or creator/owner mismatch. Ambiguous provenance is user-started and protected.

## Change

1. Make scheduled next-action cleanup eligible only for sessions canonically classified as automatically started/agent-managed.
2. Categorically protect direct Pete-started sessions, including native resumes of those sessions, regardless of `nextAction`.
3. Preserve cleanup of genuinely automatic workers/scheduler/direct-chat sessions that set `nextAction: stop`.
4. Reuse one canonical provenance helper rather than duplicating subtly different rules.
5. Add regression tests for a production-shaped Pete session and its native resume, plus automatic worker/scheduler cleanup.
6. Work on `main`, preserve concurrent state, commit all nonignored tested state, and do not push, deploy, or restart Autopilot.
