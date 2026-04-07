# Wingman API Test REPL Design

## Goal

`tmp/testsrepl.ts` is a standalone operator and agent testing tool for exercising Wingman HTTP APIs without going through the browser UI.

The purpose is:

- inspect the exact HTTP status and response body returned by Wingman
- switch between the auth modes that matter for AI agents
- reproduce access-control bugs, delegation bugs, and routing mistakes quickly
- test the API shape directly before baking assumptions into higher-level agents

This is intentionally a direct HTTP client, not a wrapper around the existing `clis/*.ts` commands.

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

Signs NIP-98 with a bot nsec that Wingman maps back to the owning user.

Use this to test the main AI agent pattern:

- bot-signed requests
- delegated owner resolution
- `/api/delegate-sessions`
- same-owner access restrictions

This is the most important mode for agent debugging.

### `in-session-agent`

Uses the bot-crypto signing API with `SESSION_ID`.

Use this to test:

- requests made from inside a live Wingman-managed agent session
- whether `SESSION_ID`-based signing works
- whether the session can act through its injected bot identity

This mode does not require the raw nsec in the REPL, but it does require `SESSION_ID`.

## Route Strategy

The REPL follows the route conventions already present in the server:

- `owner-cli` convenience session commands use `/api/sessions`
- `delegate-bot` convenience session commands use `/api/delegate-sessions` for list, create, info, read, send, and stop
- queue, history, and SSE event testing use `/api/sessions` because those routes only exist there
- app commands always use `/api/apps`

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
- `apps ...`

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

In delegated mode this is especially important because delegated message posts may queue first and only dispatch immediately when the runtime is stable.

That means:

- `200` can mean queued and dispatched immediately
- `202` can mean accepted into the queue but not dispatched yet
- `402` or `403` usually means an auth or balance gate blocked dispatch

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
4. `sessions create codex --name worker --directory /Users/mini/code`
5. `sessions send "inspect the repo"`
6. `sessions read`
7. `sessions events --seconds 10`

### Owner access comparison

1. `mode owner-cli`
2. `set key <owner-nsec>`
3. `req GET /api/sessions`
4. `req GET /api/delegate-sessions`

This makes route and access differences obvious.

### In-session debugging

1. `mode in-session-agent`
2. `set session-id <live-session-id>`
3. `req GET /api/sessions`
4. `sessions send "health check"`

## Why This Lives In `tmp/`

This is an exploratory testing tool. It is intentionally outside the main application path so the API surface and auth behavior can be exercised without committing to a public or supported CLI contract yet.
