# Decision: AGENT_NSEC Export E2E Verification

**Date:** 2026-03-31
**Context:** Review and verification of AGENT_NSEC export implementation

## Summary

Comprehensive end-to-end testing confirms the AGENT_NSEC injection pipeline is working correctly. All previously identified bugs (task executor missing npub, PM2 KEYTELEPORT_PRIVKEY leak, silent error swallowing) have been fixed in prior commits.

## Verification Results

### What was tested (22 new E2E tests + 34 existing = 56 total)

1. **Bot key resolution → nsec hex**: In-memory path correctly resolves 64-char hex. Pubkey derivation round-trips. Null returned on missing key or pubkey mismatch.

2. **Full export (nsec + nsecHex)**: `exportBotKeyForUser` returns all fields. bech32 nsec round-trips to matching nsecHex.

3. **MCP injector propagation**: `injectMcpConfig` includes AGENT_NSEC in returned env for codex agent. Omits AGENT_NSEC when `agentNsec` is undefined. Identity env keys appear in codex `-c` command args.

4. **PM2 ecosystem env propagation**: AGENT_NSEC in `envOverride` flows through `createAppConfig` to PM2 runtime env. KEYTELEPORT_PRIVKEY stripped from `envOverride`. Bash preamble includes `unset KEYTELEPORT_PRIVKEY`. SESSION_ID always present.

5. **npub format consistency**: All paths use bech32 `npub1...` format. `storeBotKeyInMemory` and `getDecryptedBotKey` use same key. Lookup with wrong npub (bot npub vs user npub) returns null.

6. **Edge cases**: Wiped (all-zero) key detectable. Valid AGENT_NSEC never all zeros. Undefined npub (old task executor bug) produces no AGENT_NSEC. adminNpub fix (current) resolves AGENT_NSEC. Sequential sessions reuse in-memory key.

### Confirmed fix status

| Bug | Status | Verified by |
|-----|--------|-------------|
| Task executor missing npub | Fixed (server.ts:769 passes adminNpub) | E2E test: "with adminNpub the task executor path resolves AGENT_NSEC" |
| PM2 KEYTELEPORT_PRIVKEY leak | Fixed (ecosystem-generator strips + unsets) | E2E test: "KEYTELEPORT_PRIVKEY is stripped" + "bash preamble unsets" |
| Silent error swallowing | Fixed (diagnostic logging in bot-key-export) | Visible in test output: `[bot-key-export] escrow unlock failed...` |

### No remaining failures found

The AGENT_NSEC export implementation is complete and working. No additional code changes were needed.

## Files Added

- `src/agents/agent-nsec-e2e.test.ts` — 22 E2E tests covering the full injection pipeline
