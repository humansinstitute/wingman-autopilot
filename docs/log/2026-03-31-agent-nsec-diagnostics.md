# Decision: AGENT_NSEC Injection Diagnostics & PM2 Security Fix

**Date:** 2026-03-31
**Context:** Pete reported AGENT_NSEC/session-memory export fix appeared unresolved after cache clearing

## Problem

The prior AGENT_NSEC injection implementation (commit `0b82d07`) wired the correct code paths but had **zero diagnostic visibility** when resolution failed at runtime. All error paths used empty `catch {}` blocks, making it impossible to determine why AGENT_NSEC wasn't being injected in production.

## Investigation

Traced the full runtime path:

1. `session-started` event fires synchronously (process-manager.ts:366)
2. Server.ts handler auto-generates bot key + auto-unlocks via escrow
3. Process-manager resolves AGENT_NSEC via `resolveBotNsecHex`
4. Value flows to subprocess env and .mcp.json

The code logic is correct, but multiple failure modes were silently swallowed:
- `getBotKeyStore()` returning null (DB init failure)
- `getActiveKeyForUser()` finding no key
- Escrow unlock failing (KEYTELEPORT_PRIVKEY missing/invalid)
- In-memory key pubkey mismatch
- Wiped key (all zeros) being passed as valid

Additionally: PM2 mode was NOT stripping `KEYTELEPORT_PRIVKEY` from child agent env, while direct spawn mode did (line 773). This was a security inconsistency.

## Changes

1. **Diagnostic logging** in process-manager bot key resolution:
   - Logs when bot key store is unavailable
   - Logs when no active key exists for user
   - Logs when AGENT_NSEC resolution fails (with reason)
   - Logs successful AGENT_NSEC resolution

2. **Error detail logging** in `resolveBotNsecHex`:
   - Logs specific escrow unlock error message
   - Logs pubkey mismatch between in-memory and DB record

3. **Wiped key validation**: Detects all-zeros hex (from `secretKey.fill(0)`) and rejects it

4. **PM2 security fix**: `KEYTELEPORT_PRIVKEY` now stripped from PM2 agent subprocesses via:
   - `unset KEYTELEPORT_PRIVKEY` in bash bootstrap prefix
   - Destructuring-strip from `envOverride` in `createAppConfig`

5. **Test suite**: 16 tests covering resolution, propagation, validation, PM2 env

## Files Changed

- `src/agents/process-manager.ts` — diagnostic logging + validation
- `src/identity/bot-key-export.ts` — error detail logging
- `src/agents/ecosystem-generator.ts` — PM2 KEYTELEPORT_PRIVKEY stripping
- `src/agents/agent-nsec-injection.test.ts` — new test suite

## Outcome

With these diagnostics, any future AGENT_NSEC resolution failure will produce specific log messages that pinpoint the root cause (DB unavailable, no key, escrow failure, wiped key, pubkey mismatch). The PM2 security fix ensures consistent KEYTELEPORT_PRIVKEY isolation across both spawn modes.
