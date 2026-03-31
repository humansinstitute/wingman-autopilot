# Decision: Bot Key Export & AGENT_NSEC Injection

**Date**: 2026-03-31
**Scope**: Per-user bot key export for CLI and session environment

## Context

Agent sessions need the bot key nsec available as an environment variable (`AGENT_NSEC`) so downstream tools can sign Nostr events directly without going through the bot-crypto API proxy. Previously, only `BOT_PUBKEY_HEX` and `BOT_NPUB` were injected — the secret key was only accessible via HTTP proxy calls to `/api/mcp/bot-crypto/*`.

## Decision

1. **Auto-inject `AGENT_NSEC`** into spawned agent subprocess environments alongside existing `BOT_PUBKEY_HEX` / `BOT_NPUB` env vars. Resolution uses in-memory unlocked key first, then escrow fallback.

2. **New API endpoint** `POST /api/bot-keys/export-nsec` accepts `{ sessionId }` and returns `{ nsec, nsecHex, botPubkeyHex, botNpub, source }`. Validated by session ownership — only the session's user's bot key is returned.

3. **New CLI** `clis/export-bot-key.ts` calls the export endpoint and outputs nsec in multiple formats (`--env`, `--hex`, `--nsec`, `--json`). Default `--env` prints `AGENT_NSEC=<hex>` for `eval $(...)` usage.

4. **Core module** `src/identity/bot-key-export.ts` encapsulates the resolution logic (memory → escrow) in two functions: `exportBotKeyForUser` (full export) and `resolveBotNsecHex` (lightweight hex-only for env injection).

## Security Considerations

- `AGENT_NSEC` gives the subprocess direct signing capability. This is intentional — the bot key is a per-user ephemeral identity, not the root server key.
- `KEYTELEPORT_PRIVKEY` remains stripped from child env (unchanged).
- The export API endpoint requires a valid session ID — there is no cookie-only path to export nsec.
- The nsec is the bot key's secret, not the user's root key.

## Files Changed

- `src/identity/bot-key-export.ts` — new export resolution module
- `src/identity/bot-key-export.test.ts` — unit tests (10 cases)
- `src/identity/bot-key-api.ts` — added export-nsec route
- `src/agents/mcp-injector.ts` — AGENT_NSEC in injection context and env
- `src/agents/process-manager.ts` — resolve and pass agentNsec
- `clis/export-bot-key.ts` — CLI command
- `package.json` — added cli:export-bot-key script
