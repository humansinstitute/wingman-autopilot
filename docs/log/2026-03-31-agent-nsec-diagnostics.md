# Decision: AGENT_NSEC Injection — Root Cause & Fixes

**Date:** 2026-03-31
**Context:** Pete reported AGENT_NSEC/session-memory export fix appeared unresolved after cache clearing

## Problem

The prior AGENT_NSEC injection implementation (commit `0b82d07`) wired the correct code paths but had **zero diagnostic visibility** when resolution failed at runtime and a **concrete bug** in the task executor path.

## Root Cause Analysis

### Timing (confirmed correct)

The `session-started` event fires **synchronously** at process-manager.ts:366, BEFORE the bot key lookup at line 388. Since `emit()` iterates listeners synchronously, the server.ts handler runs to completion (auto-generating and unlocking the bot key) before control returns to the process-manager's bot key lookup. There is no timing issue in the synchronous escrow path.

However: when escrow fails, the fallback is an **async** browser SSE decrypt request (line 1148). This fires-and-forgets — the agent process is spawned before the browser can respond, so AGENT_NSEC is permanently missing for that session.

### Bug 1: Task executor sessions had no npub

`server.ts:769` passed `undefined` for the `explicitNpub` parameter:
```typescript
createSession: (agent, dir, name, origin, metadata) =>
    manager.createSession(agent, dir, name, origin, undefined, undefined, metadata),
```

With no npub, the entire bot key lookup block (line 382) is skipped because `if (npub)` is false. This means all Nostr-triggered task sessions could never get AGENT_NSEC.

**Fix:** Pass `adminNpub` as the explicit npub for task executor sessions.

### Bug 2: Silent error swallowing

All error paths in bot key resolution used empty `catch {}` blocks, making runtime failures invisible.

### Bug 3: PM2 KEYTELEPORT_PRIVKEY leak

PM2-mode agent subprocesses inherited `KEYTELEPORT_PRIVKEY` from the parent env. Direct-spawn mode stripped it at line 773, but PM2 mode didn't.

## npub Matching Verification

All main session creation paths resolve npubs consistently:

| Path | npub Source | Format |
|------|-----------|--------|
| Session API (browser) | `authContext.npub` (cookie) | `npub1...` |
| Session API (bot NIP-98) | `resolveNip98AuthContext` → `ownerNpub` | `npub1...` |
| MCP create_session | `callerSession.npub` | `npub1...` |
| Scheduler engine | `job.userNpub` | `npub1...` |
| Autopilot jobs | `input.authContext.npub` | `npub1...` |
| Task executor | Was `undefined`, now `adminNpub` | `npub1...` |

The `activeKeys` Map in `bot-key-manager.ts` is keyed by user npub (bech32). Both `storeBotKeyInMemory(npub, ...)` and `getDecryptedBotKey(npub)` use the same format. No mismatch.

## Changes

### Round 1 (commit 2be7e53)
- Diagnostic logging in process-manager and bot-key-export
- Wiped-key validation (all-zeros detection)
- PM2 KEYTELEPORT_PRIVKEY stripping
- 16 injection flow tests

### Round 2 (commit 7532365)
- **Fix task executor: pass adminNpub** instead of undefined
- Log npub value and `isBotKeyUnlocked` state at lookup time
- Log when session has no npub
- 4 additional npub matching tests (20 total)

## Files Changed

- `src/server.ts` — task executor passes adminNpub
- `src/agents/process-manager.ts` — diagnostic logging + isBotKeyUnlocked import
- `src/identity/bot-key-export.ts` — error detail logging
- `src/agents/ecosystem-generator.ts` — PM2 KEYTELEPORT_PRIVKEY stripping
- `src/agents/agent-nsec-injection.test.ts` — 20 tests

## How to Verify

After deploy, start a new session and check logs for:
- `[manager] bot key lookup for npub=npub1... (in-memory=true)` — key was pre-unlocked
- `[manager] AGENT_NSEC resolved for npub1...` — success
- `[manager] session has no npub` — would indicate missing npub (now fixed for task executor)
- `[bot-key-export] escrow unlock failed` — would indicate KEYTELEPORT_PRIVKEY issue
