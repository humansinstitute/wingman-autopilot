# Flight Deck-bound session turn publishing

Status: approved for implementation  
Date: 2026-07-25

## Problem

Agent Direct Chat currently publishes only the terminal response from the prompt it directly sends and awaits. Later turns injected through another valid Autopilot path—especially supervised dispatch callbacks—run in the same Flight Deck-bound session but their commentary and terminal response remain only in the session transcript.

Confirmed example:

- Flight Deck-bound session: `b4f408f2-f73a-4d48-835d-32bb2234a7f3`
- associated workspace/channel/thread metadata were present;
- the supervised callback was correctly kept internal;
- the supervisor produced the terminal response beginning `Architecture check complete...`;
- Tower's authoritative thread contained the initial direct-chat response but not this later terminal response.

The direct-chat runtime's `publishTurn()` is tied to the original Flight Deck-triggered turn, while the general prompt queue can start additional turns without entering that runtime.

## Required contract

For every turn executed by an explicitly Flight Deck-bound agent session:

1. The initiating prompt is internal and is never published merely because it started the turn.
2. Agent commentary/thinking is surfaced through the existing transient Flight Deck activity mechanism.
3. The authoritative terminal assistant response is published as a durable message to the associated Flight Deck thread.
4. This applies regardless of whether the turn was initiated by a Flight Deck human message, a supervised dispatch callback, or another legitimate internal Autopilot prompt.
5. Worker session output is not published merely because the worker has optional reporting context. Only a session explicitly bound as `sessionClass=flightdeck_chat` with complete Flight Deck routing metadata is eligible.

Required binding metadata:

```text
sessionClass = flightdeck_chat
flightdeckTowerServiceNpub
flightdeckWorkspaceId
flightdeckChannelId
flightdeckThreadId
flightdeckAgentNpub
```

Scope and trigger/source message identifiers may be used when available but must not be required for later internal turns.

## Behaviour and safeguards

- Capture only terminal assistant/agent messages after the exact initiating prompt boundary.
- Never publish user prompts, callback envelopes, tool output, or combined terminal transcripts.
- Use authoritative native Codex history where required by the existing response-capture contract.
- Persist an outbound publication record/cursor before or with delivery so restarts do not lose completed turns.
- Deduplicate by a stable session plus turn/final-message identity.
- Retry transient Tower publication failures durably.
- Preserve ordered publication per Flight Deck-bound session.
- Direct Chat's existing initial-turn publishing must be moved behind the same central bridge or share its idempotency contract so the initial response is not duplicated.
- The callback dispatch lifecycle and the Flight Deck publish lifecycle are related but separate: callback delivery must not itself publish content, and acknowledgement must not fabricate a Flight Deck message.
- Existing Flight Deck activity should show commentary for later internal turns and clear/complete when the terminal response is published.

## Preferred architecture

Create a central Flight Deck-bound session turn output bridge owned by Autopilot's session/prompt lifecycle, rather than adding callback-specific publishing.

The bridge should receive or observe a typed accepted-turn record containing at least:

```text
session id
prompt boundary / accepted time
turn id
prompt type (direct chat, dispatch callback, normal queued prompt, etc.)
optional source message ids
Flight Deck binding resolved from session metadata
```

It then:

1. observes commentary while the turn runs and updates Agent Activity;
2. captures the authoritative terminal response;
3. writes a durable idempotent outbound publication record;
4. publishes the terminal response through the existing Tower PG message creator;
5. marks the outbound record complete and activity completed;
6. retries recoverable incomplete records after restart.

If a smaller implementation safely centralises this through the existing prompt-dispatch completion path, that is acceptable, provided direct-chat and callback turns share one idempotency mechanism and the tested behaviour matches this contract.

## Acceptance tests

1. A normal Flight Deck direct-chat prompt produces exactly one durable thread reply.
2. A supervised callback prompt is not published.
3. Commentary produced while handling that callback appears through Flight Deck activity.
4. The callback supervisor's terminal response is published exactly once to its bound thread.
5. Reprocessing/polling/restart recovery does not duplicate the response.
6. A plain Autopilot worker without `sessionClass=flightdeck_chat` publishes nothing to Flight Deck even when reporting context exists.
7. A Flight Deck-bound session with missing required binding metadata fails visibly and does not publish to an inferred or stale channel/thread.
8. Existing direct-chat recovery, native Codex final-message capture, prompt queue, and supervised dispatch tests continue to pass.

## Validation

Run focused tests for the new bridge plus:

```bash
bun test src/agent-chat/direct-chat-runtime.test.ts \
  src/agent-chat/session-runtime-session-ops.test.ts \
  src/server/prompt-dispatch.test.ts \
  src/session-dispatch
```

Run the broader relevant suite chosen from the touched modules and `git diff --check`. Do not restart the live Autopilot process; the manager will request separate approval before a live restart/test.
