# Supervised session dispatch callbacks

Status: approved; phases 1 and 2 implemented
Date: 2026-07-25
Scope: Autopilot session dispatch, completion capture, callback delivery, and supervisory handoff

## Decision summary

When one Autopilot session dispatches work to another session, the dispatching session should remain accountable for the outcome.

The default dispatch contract should therefore register the dispatching session as the worker's callback session. When the worker reaches a terminal turn, Autopilot should capture its final assistant message and deliver one durable, structured completion callback to the dispatching session. That callback wakes the supervisor so it can review the result, validate completion, update the originating Flight Deck task/thread, and take any necessary follow-up action.

Routine polling is not part of the normal path. A low-frequency watchdog remains a fallback for workers that crash, hang, disappear, or never produce a terminal callback.

## Problem

Creating a worker session currently does not, by itself, guarantee that the dispatching session will resume when the worker finishes. The worker may complete successfully while the manager is idle, leaving Pete to ask for status manually. Asking the manager agent to remember to poll is unreliable because the manager turn may have ended and no process is maintaining an internal timer.

Repeated time-based prompts also have undesirable behaviour:

- they consume turns while the worker is still progressing normally;
- they can queue redundant prompts into a busy supervisor;
- a fixed polling limit may expire before long work completes;
- a long polling window can continue after work has already finished;
- polling reports activity, but does not establish a durable handback of responsibility.

The required outcome is not merely worker notification. It is a reliable transfer of control back to the session that delegated the work.

## Goals

- Make the dispatching session responsible for reviewing every delegated result by default.
- Wake the dispatching session promptly when the worker completes.
- Reuse the authoritative final-assistant-message capture already used by Flight Deck response publishing.
- Persist callbacks so Autopilot restarts and temporarily busy sessions do not lose them.
- Deliver at most one completion callback for each worker terminal turn.
- Carry enough routing context for the supervisor to update the correct Flight Deck task and originating chat thread.
- Support failed, cancelled, stopped, and missing-final-message outcomes as well as successful completion.
- Retain a watchdog only as failure detection, not routine progress polling.

## Non-goals

- Automatically accepting the worker's claim that work is complete.
- Replacing Flight Deck task state, task comments, or chat reporting.
- Posting the worker's raw final message directly to Pete as an authoritative completion report.
- Interrupting unrelated user-created sessions.
- Building a general distributed workflow engine in the first implementation.

## Terminology

- **Supervisor session**: the session that initiates the dispatch and remains accountable.
- **Worker session**: the session created or selected to perform the delegated work.
- **Dispatch record**: durable relationship between supervisor, worker, and reporting context.
- **Terminal turn**: a completed agent turn with a captured final assistant message, or an explicit failed/cancelled/stopped outcome.
- **Callback**: the durable prompt delivered to the supervisor after the worker terminal outcome is captured.
- **Acknowledgement**: evidence that the callback was accepted for execution by the supervisor session.

## Proposed user experience

### Default CLI

The normal command should require no monitoring flags:

```bash
bun clis/wingman.ts dispatch \
  --agent codex \
  --directory /absolute/path/to/repo \
  --prompt-file /absolute/path/to/task.md
```

When invoked from an Autopilot session, the CLI reads `SESSION_ID` and registers it as `callbackSessionId`. The response includes both the worker session ID and dispatch ID.

Conceptual response:

```json
{
  "dispatchId": "dispatch_123",
  "workerSessionId": "session_worker",
  "callbackSessionId": "session_manager",
  "callbackEnabled": true,
  "state": "running"
}
```

### Overrides

```bash
--callback-session <session-id>
--callback false
--watchdog-after 30m
--watchdog-max-checks 4
```

`--callback-session` overrides the inferred caller. `--callback false` is explicit because unmonitored delegation should be an exception. The initial implementation may omit configurable watchdog flags and use conservative server defaults.

If no `SESSION_ID` is available, dispatch must either receive `--callback-session` or explicitly receive `--callback false`. It should not silently create unowned work.

## Dispatch record

Add a durable store, preferably in the existing Autopilot SQLite database rather than session metadata alone.

Suggested logical fields:

```text
dispatch_id                  primary key
worker_session_id            required
callback_session_id          nullable only when callback explicitly disabled
parent_dispatch_id           nullable; supports follow-up delegation chains
state                        creating|running|terminal_pending|callback_pending|callback_delivered|acknowledged|closed|failed
terminal_status              completed|failed|cancelled|stopped|null
terminal_message             nullable
terminal_message_created_at  nullable
terminal_message_fingerprint nullable; used for idempotency
callback_prompt              nullable; rendered payload retained for audit/retry
callback_attempt_count       integer
callback_queued_at           nullable
callback_delivered_at        nullable
callback_acknowledged_at     nullable
last_worker_activity_at      nullable
watchdog_due_at              nullable
watchdog_check_count         integer
created_at
updated_at
```

Reporting context should be stored as structured JSON or explicit columns:

```json
{
  "workspaceId": "...",
  "taskId": "...",
  "channelId": "...",
  "threadId": "...",
  "messageId": "...",
  "reportTarget": "task_and_originating_thread"
}
```

These fields are optional routing hints, not a mandatory reporting contract. The core
relationship is between Autopilot sessions. Task and chat identifiers are included only
when the originating session already has that context. Flow identifiers are deliberately
excluded: flow-backed dispatch is uncommon and must not burden ordinary session dispatch.

The reporting context should be inherited from the supervisor's active Flight Deck dispatch metadata unless explicitly supplied. This lets the callback instruct the supervisor where to report without giving the worker responsibility for reconstructing ephemeral manager context.

## Lifecycle

### 1. Create

The dispatch API validates the supervisor session, creates the worker, and writes the dispatch record. These actions should behave atomically from the caller's perspective: if the worker is created but the dispatch record cannot be persisted, the API returns an error that identifies the orphaned worker and attempts a safe compensating stop only when authorised and appropriate.

### 2. Run

The worker runs normally. No periodic prompt is sent merely because callback supervision is enabled.

### 3. Capture terminal outcome

When the worker's runtime reports a stable completed turn, Autopilot uses the existing final-message capture logic to select the authoritative assistant response. The capture must observe the same turn boundary rules used by Flight Deck publishing so terminal transcripts, tool output, or older assistant messages are not mistaken for the final response.

For explicit process failure, cancellation, or stop, Autopilot creates a synthetic terminal outcome even if no final assistant message exists.

### 4. Persist callback before delivery

Autopilot changes the dispatch to `callback_pending`, persists the terminal status, captured message, fingerprint, and rendered callback prompt, then attempts delivery. Persisting first provides at-least-once retry safety.

### 5. Deliver to supervisor

The callback is added to the supervisor's durable prompt queue using a typed dispatch-callback envelope. If the supervisor is idle and eligible for automatic dispatch, Autopilot executes it immediately. If the supervisor is busy, it remains as one queued callback and is dispatched when the session becomes ready.

The system must not repeatedly inject equivalent callbacks. Queue insertion should deduplicate on `dispatchId + terminal_message_fingerprint`.

### 6. Review and report

The supervisor wakes and must:

1. read the worker's completion message and latest recoverable session output;
2. read the authoritative Flight Deck task and latest comments when task context exists;
3. inspect produced files, code state, and validation evidence as appropriate;
4. decide whether the delegated goal is genuinely complete;
5. update the task and originating Flight Deck thread with completion, progress, or a blocker;
6. send corrective follow-up work when needed;
7. acknowledge or close the dispatch after the supervisory action is complete.

The callback means "review this outcome", not "automatically mark this complete".

## Callback prompt

Recommended rendered prompt:

```text
Dispatched session completion callback.

The session you dispatched to <worker-session-id> has reached a terminal state.
Dispatch: <dispatch-id>
Status: <completed|failed|cancelled|stopped>

Worker completion message:
<captured-final-assistant-message-or-explicit-no-message-note>

Review the worker's result and supporting evidence. Read the associated Flight Deck
task and latest comments if present. Validate whether the delegated goal is genuinely
complete. Update the originating Flight Deck task/thread with the outcome or blocker,
and take appropriate follow-up action. Do not treat the worker's completion claim as
automatic acceptance.

Reporting context:
<structured task/channel/thread/message references>
```

Internally, the queued prompt should retain a typed payload in addition to this human-readable content:

```json
{
  "type": "dispatch_callback",
  "dispatchId": "dispatch_123",
  "workerSessionId": "session_worker",
  "callbackSessionId": "session_manager",
  "terminalStatus": "completed",
  "terminalMessage": "Implemented the change and tests pass.",
  "reportingContext": {}
}
```

Typed data prevents later logic from parsing identifiers back out of prose.

## Completion detection

Completion must be based on an explicit runtime/turn lifecycle signal plus authoritative final-message capture. It must not be inferred solely from:

- the process being online;
- `agentRuntimeStatus === stable` without a new turn boundary;
- a pause between tool calls;
- a message containing words such as "done" or "complete";
- the session's final line of terminal output.

The implementation should expose one internal event such as:

```ts
type SessionTerminalTurnEvent = {
  sessionId: string;
  turnId?: string;
  status: 'completed' | 'failed' | 'cancelled' | 'stopped';
  finalMessage: { content: string; createdAt: string } | null;
};
```

Existing final-message capture in `src/agent-chat/session-runtime-session-ops.ts` should be extracted or wrapped as shared behaviour rather than duplicated.

## Busy, stopped, and unavailable supervisors

### Busy

Do not interrupt an active supervisor turn and do not create repeated wake prompts. Queue one deduplicated callback. Existing prompt readiness and automatic queue dispatch can deliver it once the session is ready.

### Temporarily unavailable

Retain `callback_pending` and retry delivery with bounded exponential backoff. Delivery attempts and the last error should be inspectable.

### Stopped or archived

Phase one should mark the callback undeliverable and surface it through dispatch status/API/UI. It must not silently create a replacement session or inject into another user-created session.

A later phase may support an explicit fallback supervisor policy, for example `fallback: dedicated_session`, but this requires preserved identity, directory, goal, reporting context, and access authority. It should not be implicit in the initial release.

## Follow-up work

If review finds the worker incomplete, the supervisor may send a focused prompt to the existing worker or create another worker dispatch.

- Sending another prompt to the same worker starts another supervised turn under the same dispatch or a child attempt record.
- Creating a new worker creates a new dispatch with `parent_dispatch_id` pointing to the original.
- Each terminal worker turn generates at most one callback.
- The supervisor remains the callback owner until it explicitly closes or transfers responsibility.

The precise retry/attempt model can be limited in phase one: a follow-up prompt may create a new dispatch record even when reusing the same worker session. This keeps terminal callbacks and acknowledgements unambiguous.

## Watchdog fallback

The callback is the normal path. The watchdog exists for missing terminal events, not routine status reporting.

It should inspect supervised dispatches where:

- the worker process disappeared without a terminal event;
- no worker activity has occurred beyond a configured stale threshold;
- callback delivery remains pending beyond a delivery threshold;
- the dispatch remains `running` beyond an optional deadline.

The watchdog should produce a failure/stalled callback to the supervisor rather than repeatedly asking the worker "Any progress?". It may reuse Night Watch scheduling/store patterns, but supervised dispatch state should remain separate because it relates two sessions and carries reporting responsibility.

No watchdog process may send prompts into unrelated Pete-created sessions. It may only deliver the callback registered by the explicit dispatch relationship.

## API changes

### Create supervised dispatch

Add a first-class endpoint rather than requiring clients to coordinate session creation and callback registration separately:

```http
POST /api/session-dispatches
```

Conceptual request:

```json
{
  "agent": "codex",
  "directory": "/absolute/path",
  "name": "Implement task",
  "prompt": "Self-contained work brief...",
  "callback": {
    "enabled": true,
    "sessionId": "session_manager"
  },
  "reportingContext": {
    "workspaceId": "...",
    "taskId": "...",
    "channelId": "...",
    "threadId": "...",
    "messageId": "..."
  }
}
```

Suggested supporting routes:

```http
GET  /api/session-dispatches/:dispatchId
GET  /api/session-dispatches?callbackSessionId=<id>&state=<state>
POST /api/session-dispatches/:dispatchId/acknowledge
POST /api/session-dispatches/:dispatchId/close
POST /api/session-dispatches/:dispatchId/retry-callback
```

Ownership checks must require the same owner/delegated authority for the worker and callback session. Cross-owner callbacks should be rejected unless an explicit delegation model authorises them.

### Existing session creation API

For compatibility, session creation may accept an optional callback object, but the first-class dispatch route should be the preferred interface because it can validate and persist the relationship as one operation.

## CLI changes

Add `dispatch` to `clis/wingman.ts`, or a dedicated `clis/dispatch.ts` surfaced through the main CLI.

Required inputs:

- agent type;
- working directory;
- prompt or prompt file;
- callback session inferred from `SESSION_ID` or provided explicitly;
- optional name/model;
- optional Flight Deck routing inherited from session metadata or provided explicitly.

All reporting-context fields are optional. A plain Autopilot session-to-session dispatch
requires only the worker instructions and callback session; it does not require a Flight
Deck task, chat, message, flow, or other workspace record.

Useful commands:

```bash
wingman dispatch ...
wingman dispatch status <dispatch-id>
wingman dispatch list --mine --active
wingman dispatch acknowledge <dispatch-id>
wingman dispatch close <dispatch-id>
wingman dispatch retry-callback <dispatch-id>
```

The CLI should print the dispatch ID prominently because the dispatch, rather than only the worker session, is the unit of accountability.

## Internal code changes

Likely implementation areas:

1. **Dispatch store**
   - Add `src/session-dispatch/session-dispatch-store.ts` backed by the main SQLite database.
   - Store state transitions, terminal capture, reporting context, delivery attempts, and acknowledgement.

2. **Dispatch service/state machine**
   - Add `src/session-dispatch/session-dispatch-service.ts`.
   - Own validation, worker creation, lifecycle transitions, idempotency, callback rendering, queue delivery, and watchdog fallback.

3. **Shared final-message capture**
   - Extract or expose the authoritative capture logic currently used in `src/agent-chat/session-runtime-session-ops.ts`.
   - Ensure native Codex and AgentAPI-backed agents follow the same terminal-turn contract.

4. **Session lifecycle event**
   - Emit a single terminal-turn event from the existing prompt/session runtime after message synchronisation.
   - Subscribe the dispatch service and match active dispatch records by worker session ID and turn/attempt.

5. **Typed prompt queue metadata**
   - Extend prompt queue records to retain `type`, dispatch ID, terminal fingerprint, and structured payload, or add a callback-specific durable inbox that materialises into the existing queue.
   - Deduplicate before enqueue.

6. **Automatic callback dispatch**
   - Reuse prompt readiness and `dispatchNextQueuedPromptForSession` behaviour.
   - Do not directly post to a busy agent endpoint.

7. **Routes and authentication**
   - Add API route composition and ownership/delegation checks.

8. **CLI and MCP tool**
   - Add the CLI command.
   - Add or update an MCP dispatch tool so agents naturally use supervised dispatch instead of raw `create-session`.

9. **Observability**
   - Expose dispatch state, callback attempts, last delivery error, worker activity, and reporting target.
   - Add concise structured logs keyed by dispatch ID.

10. **Documentation and agent instructions**
    - Make supervised dispatch the default in manager-session guidance.
    - State that raw session creation is appropriate for interactive/manual sessions, while delegated work uses dispatch.

## State transitions

```text
creating
  -> running
  -> failed                       worker creation/registration failure

running
  -> terminal_pending             terminal event observed
  -> callback_pending             crash/stop synthesises terminal outcome
  -> failed                       unrecoverable dispatch-store/runtime failure

terminal_pending
  -> callback_pending             final outcome persisted

callback_pending
  -> callback_delivered           queued/accepted by supervisor session
  -> callback_pending             transient delivery failure
  -> failed                       delivery policy exhausted; visible intervention required

callback_delivered
  -> acknowledged                 supervisor accepted callback turn

acknowledged
  -> closed                       supervisor completed review/reporting
  -> running                      explicit follow-up attempt under same dispatch model
```

For phase one, acknowledgement may mean the callback prompt was dequeued and submitted to the supervisor. A stronger later acknowledgement should be an explicit tool/API action made after Flight Deck reporting. The UI and API must distinguish delivery acknowledgement from completed supervisory review.

## Idempotency and loop prevention

- Create requests should accept an idempotency key when called from pipelines or task dispatch.
- A terminal event is unique by worker session plus turn/attempt identity; fall back to a fingerprint of status, message timestamp, and content.
- Callback queue insertion is unique by dispatch plus terminal fingerprint.
- Delivery retries reuse the persisted callback; they do not render new variants.
- Callback prompts are marked `dispatch_callback` and do not create a new callback relationship merely because they wake the supervisor.
- If the supervisor dispatches follow-up work, that is a new explicit relationship with its own callback.

## Flight Deck behaviour

The callback should wake the supervisor, not publish the worker response directly as Pete-facing truth. The supervisor owns the human-facing update because it has the manager context and must judge whether the work satisfies the task.

The reporting context allows the supervisor to:

- add validation and technical details to task comments;
- move the task to `review` only when genuinely ready;
- post a concise completion/progress/blocker update in the originating chat thread;
- avoid replying to stale or self-authored thread state by fetching the latest records first.

The initial implementation does not need Tower to store dispatch records. Autopilot owns session execution and can store the relationship locally. Flight Deck continues to receive only task/chat updates through the existing typed Tower routes.

## Security and authority

- The caller must be authorised to create the worker session.
- The callback session must be owned by the same user or covered by explicit owner-space delegation.
- The callback payload may contain sensitive worker output and must not cross workspace/user boundaries implicitly.
- Reporting context is advisory routing data; the supervisor must still use its authorised Tower credentials and fetch current state.
- The API must not allow arbitrary callers to inject callback-shaped prompts into another user's session.

## Validation plan

### Store and state machine tests

- Create and retrieve a dispatch relationship.
- Persist every valid transition and reject invalid transitions.
- Recover pending callbacks after process restart.
- Deduplicate repeated terminal events and callback enqueue attempts.

### Completion capture tests

- Capture the final assistant message after the correct prompt boundary.
- Reject combined terminal transcript/tool output as the final response.
- Capture native Codex and AgentAPI-backed completions consistently.
- Produce a synthetic outcome for failed, cancelled, and stopped workers.

### Delivery tests

- Deliver immediately to an idle supervisor.
- Queue once when the supervisor is busy.
- Automatically deliver when the supervisor becomes ready.
- Retry a transient failure without duplicate prompts.
- Preserve a pending callback across Autopilot restart.
- Surface an unavailable/stopped supervisor without silently losing the callback.

### End-to-end acceptance tests

1. A manager dispatches a worker using the CLI without callback flags.
2. The worker completes with a final message.
3. Exactly one callback wakes the manager.
4. The callback contains the worker result and Flight Deck routing context.
5. The manager can inspect, report, and close the dispatch.
6. No periodic progress prompts are produced during normal execution.

Failure-path acceptance:

1. A worker process disappears without a final message.
2. The fallback watchdog synthesises a stalled/failed callback.
3. The manager is woken once and can report the blocker.

## Delivery phases

### Phase 1: completion callback core

- Dispatch store and API.
- CLI command with inferred callback session.
- Terminal-turn integration and shared final-message capture.
- Durable deduplicated callback queued to the supervisor.
- Status inspection and tests.

### Phase 2: Flight Deck routing and explicit closeout

- Inherit structured task/thread context.
- Explicit acknowledgement/close commands or MCP actions.
- Clear manager prompt contract for validation and reporting.
- Dispatch status surfaced in the relevant operational UI.

### Phase 3: failure watchdog

- Detect missing workers, stale activity, and overdue callback delivery.
- Create one synthetic failure/stalled callback.
- Add configurable thresholds only if operational evidence shows they are needed.

### Phase 4: advanced supervision

- Explicit fallback supervisor policies.
- Parent/child dispatch trees and transferred ownership.
- Event-driven milestone callbacks if progress reporting beyond terminal handoff is later required.

## Open review questions

1. Should `callbackSessionId` always default from `SESSION_ID`, with `--callback false` required outside a session, or should shell/operator dispatches be allowed without a callback by default?
2. Does phase one need an explicit supervisor `close` action, or is dequeue/delivery acknowledgement sufficient until the Flight Deck integration is added?
3. What exact runtime event is the authoritative terminal-turn boundary across every supported agent adapter?
4. Should follow-up prompts to the same worker reuse one dispatch with attempts, or always create a child dispatch record initially?
5. What stale duration should activate the failure watchdog, and should the default depend on agent/runtime type?
6. Where should unresolved callbacks appear operationally: Sessions UI, Night Watch UI, a new Dispatches view, or more than one?

## Recommendation

Implement phases 1 and 2 together as the minimum useful product. Completion callbacks without Flight Deck routing still wake the manager, but the central user outcome is proactive, correctly routed reporting. Add the watchdog after the clean terminal path is reliable; it should remain a quiet safety net rather than the primary supervision mechanism.
