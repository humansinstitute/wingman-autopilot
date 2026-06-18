# Flight Deck PG Agent CLI

Autopilot agents should use the PG-native Flight Deck CLI:

```bash
bun clis/wingman.ts flightdeck context --json
bun clis/wingman.ts flightdeck tasks list --workspace <workspace-id> --channel <channel-id> --json
bun clis/wingman.ts flightdeck task show <task-id> --workspace <workspace-id> --json
bun clis/wingman.ts flightdeck task comments <task-id> --workspace <workspace-id> --json
bun clis/wingman.ts flightdeck task comment <task-id> --workspace <workspace-id> --body "Validated locally." --json
bun clis/wingman.ts flightdeck task state <task-id> --workspace <workspace-id> --state in_progress --json
bun clis/wingman.ts flightdeck thread read <thread-id> --workspace <workspace-id> --channel <channel-id> --json
bun clis/wingman.ts flightdeck chat reply --workspace <workspace-id> --channel <channel-id> --thread <thread-id> --body "..." --json
bun clis/wingman.ts flightdeck doc create --workspace <workspace-id> --channel <channel-id> --title "Notes" --body-file notes.md --json
bun clis/wingman.ts flightdeck doc update <doc-id> --workspace <workspace-id> --body-file notes.md --json
bun clis/wingman.ts flightdeck file upload --workspace <workspace-id> --channel <channel-id> --path ./artifact.png --json
```

Authentication resolves `--key`, then `AGENT_NSEC`, then `WINGMAN_NSEC`. Requests to Tower are NIP-98 signed. The CLI respects `WINGMAN_URL` for Autopilot context and accepts `--url`, `--tower-url`, and `--app-npub` overrides.

The retired `wingman board ...` production path has been removed; missing PG coverage returns explicit route-gap errors instead of using local mirrored state.
