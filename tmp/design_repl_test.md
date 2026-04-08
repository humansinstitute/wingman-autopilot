# Wingman API Test REPL Design

## Goal

`tmp/testsrepl.ts` is a standalone operator and agent testing tool for exercising Wingman HTTP APIs without going through the browser UI.

The purpose is:

- inspect the exact HTTP status and response body returned by Wingman
- switch between the auth modes that matter for AI agents
- reproduce access-control bugs, delegation bugs, and routing mistakes quickly
- test the API shape directly before baking assumptions into higher-level agents

This is intentionally a direct HTTP client, not a wrapper around the existing `clis/*.ts` commands.

Note: the main session CLI now supports delegated owner-space session and archive control through `clis/sessions.ts --owner <npub>`. The REPL remains useful for raw route testing, SSE inspection, and debugging edge cases.

## Why Direct HTTP Instead Of Shelling Out

The existing CLIs already prove that the HTTP routes work, but they hide some of the behavior behind command-specific formatting.

For debugging agent behavior we care about:

- which auth mode was used
- which route was hit
- which request body was sent
- what raw status code came back
- whether the server returned `401`, `403`, `404`, `409`, `202`, or a transport failure

The REPL prints request and response details on every call so access issues are easier to diagnose.

## Auth Modes

The REPL supports the three auth patterns that exist in the server:

### `owner-cli`

Signs NIP-98 directly with an owner or user nsec.

Use this to test:

- normal programmatic access to `/api/sessions`
- app APIs at `/api/apps`
- owner-scoped access behavior without bot delegation

### `delegate-bot`

Signs NIP-98 with a bot nsec while preserving the bot as the signer.

Use this to test the main AI agent pattern:

- bot-signed requests
- self-space bot access
- explicit owner-space delegation
- `/api/owners/:ownerNpub/...`
- delegation registration and owner-space restrictions

This is the most important mode for agent debugging.

### `in-session-agent`

Uses the bot-crypto signing API with `SESSION_ID`.

Use this to test:

- requests made from inside a live Wingman-managed agent session
- whether `SESSION_ID`-based signing works
- whether the session can act through its injected bot identity

This mode does not require the raw nsec in the REPL, but it does require `SESSION_ID`.

## Route Strategy

The REPL now separates signer mode from route targeting:

- auth mode answers "who signs the request?"
- `set owner <npub>` answers "which owner space do convenience commands target?"

That means:

- no owner target set => convenience commands use self-space routes like `/api/sessions` and `/api/apps`
- owner target set => convenience commands use explicit owner-space routes like `/api/owners/:ownerNpub/sessions`
- `req` is still available for any legacy or edge route, including `/api/delegate-sessions`

The generic `req` command is always available so you can hit any route manually, even if there is no convenience wrapper.

## Command Surface

The tool has two layers:

### 1. State and transport commands

- `mode ...`
- `set url ...`
- `set key ...`
- `set session-id ...`
- `set output ...`
- `set verbose ...`
- `state`
- `req METHOD PATH [BODY]`

These are for transport and auth debugging.

### 2. Convenience commands

- `sessions ...`
- `delegations ...`
- `apps ...`

Notable session views:

- `sessions list`
  - raw route response, including mixed metadata where applicable
- `sessions active`
  - active sessions for the current route scope
- `sessions my-active`
  - active sessions in self-space
- `sessions delegated-active [owner-npub]`
  - active sessions in one delegated owner space, or all delegated owner spaces when omitted

These mirror the most common workflows while still exposing the underlying HTTP result.

## Output Model

Every request records:

- HTTP method
- full URL
- auth mode used
- request body if present
- response status
- response headers
- parsed body

Output modes:

- `pretty`: readable status plus pretty-printed JSON body
- `json`: prints the full response snapshot as JSON
- `raw`: prints only the raw response body

For access debugging, `pretty` plus `verbose=on` is the best default.

## Session Send Behavior

The REPL preserves the server’s actual semantics:

- `sessions send` uses the normal message path
- `sessions send-raw` sets `type: "raw"` and bypasses normal user-message semantics

In owner-space delegated mode this is especially important because delegated message posts may queue first and only dispatch immediately when the runtime is stable.

That means:

- `200` can mean queued and dispatched immediately
- `202` can mean accepted into the queue but not dispatched yet
- `402` or `403` usually means an auth or balance gate blocked dispatch

## Active Session Views

One confusing part of Wingman is that some session endpoints mix live session data with historical or stored identity summaries.

To make that easier to inspect, the REPL now has explicit active-session views:

- `sessions active`
  - shows only the live `sessions` array for the current route scope
- `sessions my-active`
  - forces self-space and shows only live sessions there
- `sessions delegated-active`
  - fetches `/api/delegations`, then loads live owner-space sessions for each delegated owner

This is useful when the UI shows a small number of running sessions but the raw list payload includes much larger historical counts in identity summaries.

## SSE Support

`sessions events` connects to `/api/sessions/:id/events` for a bounded number of seconds.

This is intended for short inspection sessions, not a full terminal UI replacement.

## Known Limits

- The command parser is simple. For JSON bodies with spaces, quote the argument or use compact JSON.
- The REPL does not try to resolve short session ID prefixes itself.
- It is a debugging tool, not a production client.

## Recommended Testing Workflow

### Delegated agent testing

1. `mode delegate-bot`
2. `set key <bot-nsec>`
3. `sessions list`
4. `set owner <owner-npub>`
5. `delegations list`
6. `sessions list`
7. `sessions create codex --name worker --directory /Users/mini/code`
8. `sessions send "inspect the repo"`
9. `sessions read`
10. `sessions events --seconds 10`

### Owner access comparison

1. `mode owner-cli`
2. `set key <owner-nsec>`
3. `req GET /api/sessions`
4. `req GET /api/delegations`
5. `set owner <owner-npub>`
6. `sessions list`

This makes route and access differences obvious.

## Relationship To The Main CLI

Common delegated control no longer requires the REPL.

Use `clis/sessions.ts --owner <npub>` for:

- create delegated sessions
- read full delegated transcripts
- send delegated messages
- stop delegated sessions
- list and inspect delegated archived sessions

Use the REPL when you need:

- raw HTTP request/response visibility
- ad hoc route testing
- legacy `/api/delegate-sessions` debugging
- SSE event inspection

### In-session debugging

1. `mode in-session-agent`
2. `set session-id <live-session-id>`
3. `req GET /api/sessions`
4. `sessions send "health check"`

## Why This Lives In `tmp/`

This is an exploratory testing tool. It is intentionally outside the main application path so the API surface and auth behavior can be exercised without committing to a public or supported CLI contract yet.
