# Wingman CLIs

NIP-98 authenticated command-line tools for interacting with Wingman servers.

## Authentication

All CLIs authenticate using NIP-98 (Nostr HTTP Auth). Provide a signing key via:

1. `--key <nsec|hex>` flag
2. `WINGMAN_NSEC` environment variable

Set the server URL via `--url` flag or `WINGMAN_URL` env (default: `http://localhost:3000`).

## CLIs

### appctl — App lifecycle management

```bash
bun clis/appctl.ts list
bun clis/appctl.ts status <app-id>
bun clis/appctl.ts start <app-id>
bun clis/appctl.ts stop <app-id>
bun clis/appctl.ts restart <app-id>
bun clis/appctl.ts build <app-id>
bun clis/appctl.ts setup <app-id>
bun clis/appctl.ts register <app-id> --directory /path/to/app
bun clis/appctl.ts unregister <app-id>
bun clis/appctl.ts clone <repo-url> --directory my-project
bun clis/appctl.ts starters
bun clis/appctl.ts starters-create --name "My Template" --git-url <url> [--web-app]
bun clis/appctl.ts starters-delete <id>
```

### sessions — Session management

```bash
bun clis/sessions.ts list
bun clis/sessions.ts create claude-code --name "my-task" --directory /tmp/project
bun clis/sessions.ts info <session-id>
bun clis/sessions.ts logs <session-id>
bun clis/sessions.ts send <session-id> "do the thing"
bun clis/sessions.ts stop <session-id>
bun clis/sessions.ts stop-self --bot-crypto
bun clis/sessions.ts artifacts <session-id>
bun clis/sessions.ts queue <session-id>
bun clis/sessions.ts queue-add <session-id> "run the tests"
bun clis/sessions.ts queue-next <session-id>
bun clis/sessions.ts archive [--limit 20] [--filter text]
bun clis/sessions.ts archive-info <archive-id>
bun clis/sessions.ts archive-logs <archive-id>
bun clis/sessions.ts archive-delete <archive-id>
```

### delegate-sessions — Bot-delegated session management

Use this when you are operating as a user's Wingman bot and want the server
to authorize based on the bot->owner relationship rather than a browser session
or agent `SESSION_ID`.

```bash
bun clis/delegate-sessions.ts list --key $WINGMAN_NSEC
bun clis/delegate-sessions.ts create codex --name "worker" --directory /tmp/project
bun clis/delegate-sessions.ts info <session-id>
bun clis/delegate-sessions.ts read <session-id>
bun clis/delegate-sessions.ts send <session-id> "do the thing"
bun clis/delegate-sessions.ts stop <session-id>
bun clis/delegate-sessions.ts create codex --name "worker" --metadata '{"role":"heartbeat-worker"}'
```

### status — System overview

```bash
bun clis/status.ts                         # combined dashboard (apps + sessions)
bun clis/status.ts full                    # everything: config, flags, apps, sessions, recent archives
bun clis/status.ts apps                    # app summary
bun clis/status.ts sessions                # session summary
bun clis/status.ts config                  # server configuration
bun clis/status.ts flags                   # feature flags
bun clis/status.ts flags-set <id> true     # set a feature flag
bun clis/status.ts restart                 # trigger warm restart
bun clis/status.ts restart-status          # check restart progress
```

### deploy — CapRover deployments

```bash
bun clis/deploy.ts list
bun clis/deploy.ts deploy <app-id> --caprover-name my-app-prod
bun clis/deploy.ts status <app-id>
bun clis/deploy.ts logs <app-id>
```

### scheduler — Trigger management

```bash
bun clis/scheduler.ts list
bun clis/scheduler.ts create --name "Daily run" --agent codex --working-directory /tmp/project --prompt "check repo" --trigger-type cron --cron "0 * * * *"
bun clis/scheduler.ts update <job-id> --enabled false
bun clis/scheduler.ts delete <job-id>
bun clis/scheduler.ts trigger <job-id>
bun clis/scheduler.ts runs <job-id>
```

### jobs / jobs-dispatch / jobs-manager — Autopilot jobs

```bash
bun clis/jobs.ts create --id movie-research --name "Movie Research" \
  --worker-agent codex --manager-agent claude \
  --worker-prompt "Research the assigned movie topic" \
  --manager-prompt "Manage the worker and approve the output" \
  --manager-goal "Deliver a solid brief" \
  --manager-dir /tmp/movie-research

bun clis/jobs-dispatch.ts start movie-research \
  --worker-agent goose --manager-agent gemini \
  --worker-dir /tmp/movie-research --manager-dir /tmp/movie-review \
  --goal "Research the best Korean thrillers of the 2000s"

bun clis/jobs-manager.ts read-worker <run-id> --bot-crypto
```

## Common flags

| Flag | Description |
|------|-------------|
| `--url <url>` | Wingman server URL |
| `--key <nsec\|hex>` | Nostr signing key |
| `--json` | Raw JSON output |
| `-h, --help` | Show help |

## Shared library

`clis/lib/auth.ts` contains the shared NIP-98 auth logic used by all CLIs:

- `resolveSecretKey()` — parse nsec/hex key
- `buildAuthHeader()` — construct NIP-98 authorization header
- `requestJson()` — authenticated fetch wrapper
- `resolveBaseUrl()` — URL resolution from flags/env
- `parseCommonFlags()` — shared CLI flag parsing
- `buildConfig()` — combine URL + key into a CliConfig
