# Implementation Ticket: PG-Native Flight Deck Agent CLI

## Context

Agents launched from `~/wingmen/wingman21` need a complete shell-friendly way to interact with Flight Deck through Autopilot. Flight Deck has moved to the Postgres-backed Flight Deck PG/Tower path, and agents must use current Autopilot CLI/API helpers instead of retired local sync wrappers.

Current Autopilot state is incomplete:

- `clis/wingman.ts` still imports the old board client from `src/board/yoke-board.ts`.
- `src/board/yoke-board.ts` shells through retired local workspace-sync commands and environment variables.
- `src/mcp/tools/flightdeck.ts` exposes useful PG-backed session helpers for context, thread reads, chat replies, task comments/state, docs, and daily scope, but this is not a full general-purpose CLI contract for agents.
- `src/agent-chat/tower-client.ts` already contains many typed Flight Deck PG route helpers that should become the foundation for a real CLI.

Do not add compatibility fallbacks to retired sync paths. Missing operations should fail clearly and point at the exact missing Tower or Autopilot API route.

## Goal

Build a PG-native Flight Deck CLI under Autopilot's `wingman` command so agents can reliably read and update Flight Deck workspaces, chats, tasks, docs, files, and related coordination records from shell scripts.

The CLI should be the recommended path in agent instructions and should be suitable for direct use from `~/wingmen/wingman21` sessions.

## Workdir

`/Users/mini/code/wingmanbefree/autopilot`

Work on `main` unless the repo is already on another branch. Preserve concurrent work. Commit all nonignored tested state when complete. Do not restart Autopilot, Tower, Flight Deck, or running WApps unless Pete explicitly asks in the current conversation.

## Required CLI Contract

Add a PG-native command group. Suggested shape:

```bash
bun clis/wingman.ts flightdeck context --json
bun clis/wingman.ts flightdeck status --json
bun clis/wingman.ts flightdeck workspaces list --json
bun clis/wingman.ts flightdeck workspace show <workspace-id> --json
bun clis/wingman.ts flightdeck workspace me <workspace-id> --json
bun clis/wingman.ts flightdeck scopes list --workspace <workspace-id> --json
bun clis/wingman.ts flightdeck scope show <scope-id> --workspace <workspace-id> --json
bun clis/wingman.ts flightdeck channels list --workspace <workspace-id> --scope <scope-id> --json
bun clis/wingman.ts flightdeck channel show <channel-id> --workspace <workspace-id> --json
bun clis/wingman.ts flightdeck threads list --workspace <workspace-id> --channel <channel-id> --json
bun clis/wingman.ts flightdeck thread read <thread-id> --workspace <workspace-id> --channel <channel-id> --json
bun clis/wingman.ts flightdeck chat reply --workspace <workspace-id> --channel <channel-id> --thread <thread-id> --body "..."
bun clis/wingman.ts flightdeck tasks list --workspace <workspace-id> --json
bun clis/wingman.ts flightdeck task show <task-id> --workspace <workspace-id> --json
bun clis/wingman.ts flightdeck task create --workspace <workspace-id> --title "..." --body "..." --json
bun clis/wingman.ts flightdeck task patch <task-id> --workspace <workspace-id> --json-file payload.json
bun clis/wingman.ts flightdeck task state <task-id> --workspace <workspace-id> --state in_progress --json
bun clis/wingman.ts flightdeck task comments <task-id> --workspace <workspace-id> --json
bun clis/wingman.ts flightdeck task comment <task-id> --workspace <workspace-id> --body "..." --json
bun clis/wingman.ts flightdeck task assign <task-id> --workspace <workspace-id> --agent wm21 --json
bun clis/wingman.ts flightdeck docs list --workspace <workspace-id> --channel <channel-id> --json
bun clis/wingman.ts flightdeck doc create --workspace <workspace-id> --channel <channel-id> --title "..." --body-file file.md --json
bun clis/wingman.ts flightdeck doc show <doc-id> --workspace <workspace-id> --body --json
bun clis/wingman.ts flightdeck doc update <doc-id> --workspace <workspace-id> --body-file file.md --json
bun clis/wingman.ts flightdeck doc comments <doc-id> --workspace <workspace-id> --json
bun clis/wingman.ts flightdeck doc reply <doc-id> --workspace <workspace-id> --body "..." --json
bun clis/wingman.ts flightdeck files list --workspace <workspace-id> --json
bun clis/wingman.ts flightdeck file upload --workspace <workspace-id> --path ./artifact.png --json
bun clis/wingman.ts flightdeck file show <file-id> --workspace <workspace-id> --json
bun clis/wingman.ts flightdeck audio create --workspace <workspace-id> --channel <channel-id> --file ./note.m4a --json
bun clis/wingman.ts flightdeck reactions create --workspace <workspace-id> --target <record-ref> --emoji "+1" --json
bun clis/wingman.ts flightdeck events poll --workspace <workspace-id> --since <cursor> --json
```

Add flow and approval commands when PG/Tower typed routes exist. If they do not exist yet, add a short `docs/flightdeck-pg-cli-missing-routes.md` note listing the exact missing endpoint, desired method/path, auth context, request shape, and response shape.

## Required Behavior

- Use NIP-98 signed requests to Tower/Flight Deck PG routes.
- Resolve auth from `AGENT_NSEC` first, then `WINGMAN_NSEC`, then the existing bot key export path when appropriate.
- Respect `$WINGMAN_URL` for local Autopilot context and allow explicit `--url`/`--tower-url` overrides.
- Use active session dispatch context when available, but allow explicit workspace/channel/thread/task flags.
- Output machine-readable JSON with `--json`; keep human output concise.
- Never require raw Postgres credentials, raw object storage credentials, local mirrored state, or retired sync databases.
- Make missing endpoint failures explicit and actionable.
- Use existing typed helpers from `src/agent-chat/tower-client.ts` where possible.
- Keep command names and errors stable enough for agent scripts.

## Suggested Implementation Shape

- Replace the old `clis/wingman.ts board ...` path with `clis/wingman.ts flightdeck ...`.
- Add a reusable PG CLI client under `src/flightdeck-pg/` or a clearly named equivalent.
- Keep request signing and URL resolution in shared helpers rather than duplicating auth logic in every command.
- Move any reusable MCP Flight Deck helper logic into shared library functions so MCP tools and CLI commands do not drift.
- Remove imports from the old board client in the CLI path.
- Add docs showing common agent workflows: read current task, read latest comments, comment with validation, change state, read a chat thread, reply in-thread, create/update a document, upload an artifact.

## Suggested Files To Inspect

- `clis/wingman.ts`
- `src/board/yoke-board.ts`
- `src/agent-chat/tower-client.ts`
- `src/mcp/tools/flightdeck.ts`
- `src/mcp/stdio-server.ts`
- `src/agent-chat/subscription-runtime.ts`
- `src/server/agent-chat-routes.ts`
- `/Users/mini/code/wingmanbefree/wingman-tower/src/routes/flightdeck-pg.ts`
- `/Users/mini/code/wingmanbefree/wingman-tower/src/openapi.ts`
- `/Users/mini/code/wingmanbefree/wingman-tower/docs/pg-backend.md`

## Acceptance Tests

At minimum, prove:

1. `bun clis/wingman.ts flightdeck context --json` resolves active context when dispatch metadata is present.
2. The CLI can list/read a task, read task comments, add a task comment, and update task state through PG/Tower routes.
3. The CLI can read a chat thread and post a reply to that thread.
4. The CLI can create, read, update, and comment on a document.
5. File or audio upload uses the PG/Tower storage prepare/upload/complete path.
6. Missing PG endpoints fail with clear errors and do not call retired sync commands.
7. CLI and MCP helpers share the same PG client where practical.
8. No production CLI code imports `src/board/yoke-board.ts`.

Run targeted checks:

```bash
bun --check clis/wingman.ts
bun test src/flightdeck-pg/*.test.ts clis/wingman*.test.ts
```

Also run a grep guard before handoff:

```bash
rg -n "yoke|wingman-yoke|WINGMAN_YOKE|FLIGHTDECK_CLI_PATH|AGENT_CHAT_YOKE_CLI_PATH" clis src/flightdeck-pg src/board
```

The grep should return no matches in the new CLI implementation path. If historical tests or docs still mention retired names, explain why they were left and ensure no runtime CLI path depends on them.

## Completion Criteria

- Autopilot has a PG-native `wingman flightdeck` CLI that covers core agent Flight Deck workflows.
- The old CLI board path is removed or converted so it cannot silently route through retired sync tooling.
- Missing API coverage is documented in a focused note with exact routes needed.
- Agent-facing docs point to the new CLI.
- Tests and grep guards pass, or unrelated pre-existing failures are reported clearly.
- The repo is committed with a clear message and clean or intentionally explained git state.
