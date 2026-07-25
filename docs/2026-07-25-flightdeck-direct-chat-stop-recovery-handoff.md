# Flight Deck direct-chat stop and recovery fix

## Goal

Fix the production failure where an ongoing Flight Deck agent discussion is stopped and later messages cannot recover it.

## Confirmed production evidence

- Scheduler job `Close out sessions` (`actionType=cleanup`, every 15 minutes) stops every live session whose metadata has `nextAction: stop`.
- A Flight Deck chat manager may set `nextAction: stop` after one completed response even though Pete can continue the same discussion later. Pete explicitly says these conversations must not be treated as disposable/finished merely because one turn completed.
- Affected archived sessions include `27d5c647-9312-4a16-a0e4-74cffb6837b6` and `f22d9d7f-cb9e-4e2c-b1e2-3c3a67e31029`.
- Current `chat_intercept_state` rows for their threads are `pending`/`failed`, with pending counts 3 and 2.
- Server error: `Accepted Direct Chat session <id> is missing.`
- In `DirectChatRuntime.processQueue`, a durable turn with state `accepted` calls `awaitAcceptedFinalResponse` directly against `intercept.sessionId`. This bypasses `resolveSession`, so a stopped/archived/missing process cannot native-resume or fall back.
- Ordinary non-accepted stopped sessions already use `resolveSession`, which attempts native resume first and otherwise creates a continuity replacement with thread history.

## Required behavior

1. Flight Deck direct-chat sessions must remain restartable across stopped/archived processes.
2. For a new message or recoverable accepted turn, try native resume using stored native-agent metadata first.
3. If native resume is unavailable, create a new Autopilot session bound to the same Flight Deck thread (do not create a new Flight Deck thread) and bootstrap it with the complete authoritative current thread history plus all undelivered messages.
4. Accepted-turn recovery must be idempotent and must not double-publish or duplicate prompts.
5. The scheduled close-out mechanism must not terminate an active Flight Deck direct-chat turn. Design a deterministic guard based on runtime/intercept/turn state, not timing guesses.
6. Do not globally make completed worker/scheduled sessions immortal. Preserve cleanup for genuinely terminal sessions.
7. Clarify lifecycle ownership so a manager setting `nextAction: stop` after one reply does not make a continuing Flight Deck discussion unrecoverable. Prefer a system-level invariant over relying only on agent prompt discipline.

## Tests required

- Production-shaped accepted turn + missing/archived session recovers through native resume.
- Native resume failure creates a generation-two replacement bound to the same routing key/thread and prompt includes full thread context and pending messages.
- Repeated replay/event delivery remains exactly once.
- Cleanup does not stop a Flight Deck chat with an active/accepted/pending turn.
- Cleanup still stops a genuinely terminal eligible session.
- Run focused direct-chat and cleanup tests, then the broad relevant suite. Report unrelated pre-existing failures separately.

## Repo and state rules

- Work on `main` in `/Users/mini/code/wingmanbefree/autopilot`.
- Preserve concurrent work. Before committing, inspect the full worktree and commit all nonignored tested state unless there is a clear safety reason to stop.
- Do not reset, revert, rebase, force-push, restart Autopilot, or deploy.
- Produce a tested commit and report files, behavior, tests, commit, and whether restart is required for live activation.
