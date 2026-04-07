# Agent Chat Phase 1 Bootstrap

This note documents the runtime ownership boundary for the phase 1 Agent Chat bootstrap added in `wingmen`.

## Ownership Rule

- the human operator configures the subscription from Wingmen
- the browser signer performs the one privileged Tower workspace-key registration request
- the bot runtime owns the persisted workspace subscription after that
- the bot runtime loads its own workspace session key blob, refreshes wrapped group keys, opens Tower SSE, and performs record pull/decrypt
- the human root key never enters Wingmen server runtime state

## Persisted Runtime State

Wingmen stores one durable `workspace_subscription` per `workspace_owner_npub + bot_npub` pair, including:

- canonical phase 1 subscription fields from `agent_chat.md`
- persisted workspace-key blob for restart-safe bot auth
- persisted wrapped group-key rows for restart-safe decrypt attempts
- persisted diagnostics for auth, group-key refresh, SSE events, decrypt results, and startup reload

## Phase 1 Scope

This bootstrap is intentionally limited to:

- bot-first subscription bootstrap
- restart reload and SSE reopen
- `chat_message` advisory observation
- one-record pull and decrypt diagnostics

It does not implement phase 2 trigger evaluation or chat session routing.
