# Wingman

Wingman is the orchestration and control-plane layer for the Wingman suite.

In the current stack:

- `wingman-tower` is the workspace authority for auth, groups, encrypted record sync, storage, and service discovery
- `wingman-fd` is Flight Deck, the human-first local-first browser workspace
- `wingman-yoke` is the agent/operator CLI workspace client
- `wingman-flightlog` is the optional memory/history layer
- `wingmen` is the session harness that launches, supervises, and connects agents to the rest of the suite

Wingmen does not replace Tower as the source of truth for workspace data. It sits beside the workspace stack and manages agents, sessions, live views, app runtimes, MCP tooling, NIP-98-protected operational APIs, and per-user bot-key flows.

## Core Responsibilities

- Launch and manage agent sessions for Codex, Claude, Goose, OpenCode, and other supported adapters
- Provide browser control surfaces such as `/home` and `/live`
- Broker MCP tools and agent-side capabilities back into Wingman over HTTP
- Manage per-user bot keys, session identity, and delegated NIP-98 flows
- Expose operational APIs for apps, git/Gitea, jobs, memories, Nostr, and SuperBased/Flux operations
- Inject agent-local environment and MCP configuration, including bot-key material when available

## Terminology Notes

Some internal routes and modules still use older naming:

- `autopilot-jobs` is the current internal/API path for the Jobs subsystem
- `AGENT_NSEC` is the environment variable used to inject a session bot key into an agent process
- some `wm21` references are deployment-specific defaults or admin fallbacks, not product concepts

Those names are still real implementation details, but the current product framing is:

- Wingman = orchestration platform
- Jobs = reusable job definitions and runs
- Delegate sessions / agent sessions = the programmable session layer around agents

## Getting Started

Install dependencies:

```bash
bun install
```

Launch the orchestration server:

```bash
bun start
```

Visit:

- `http://localhost:<PORT>/home` for the session dashboard
- `http://localhost:<PORT>/live` for the real-time live/session surface

## Docker-First Setup

Generate a Compose `.env` file for the first isolated Wingman instance:

```bash
bun run docker:provision --admin-npub npub1...
```

`--admin-npub` is required. Docker noninteractive setup will not mark the
instance complete until the first operator whitelist is configured.

The default instance is `wingman-01`; if Docker already has that Compose project,
the provisioning script moves to `wingman-02`, `wingman-03`, and so on. It writes
the Compose project name, host port, host workspace path, base URL, and
`IDENTITY_SESSION_SECRET` into `.env`. The first instance mounts the base
machine directory `~/.wm-ap` at `/workspace`; later generated instances use
numbered directories such as `~/.wm-ap02` and `~/.wm-ap03`. Override this with
`--workspace-host-path <path>` when provisioning. `docker compose up` also fails
fast when `WINGMAN_ADMIN_NPUB` is absent from the generated environment.

Build and start the container:

```bash
docker compose up -d --build
```

Open a shell in the persistent `/home/wingman` environment and run the CLI login
flows from inside the container:

```bash
docker compose exec wingman bash
codex --login
claude
goose configure
opencode auth login
gemini
pi
```

The image installs Codex, Claude, Goose, OpenCode, Gemini, and Pi by default.
All agent CLI paths are pinned to `/usr/local/bin/*` so Wingman launches the
authenticated container tools rather than project-local binaries.

Set `WINGMAN_PRIV=nsec1...` in the Docker `.env` when you want this instance to
use a single shared Wingman bot identity. Admins can copy the nsec from the
identity panel; normal operators only see the public bot identity details.

Run the readiness checklist any time:

```bash
docker compose exec wingman bun run docker:check
```

The checklist reports installed tools, writable Docker volumes, configured
Wingman URLs/workspace values, required secrets, and whether CLI auth files are
detectable in `/home/wingman`.

For local HTTP testing, provisioning sets `WINGMAN_IDENTITY_COOKIE_SECURE=false`
so browsers accept the development session cookie. For HTTPS tunnel deployments,
the provisioning script sets secure cookies when `--base-url` starts with
`https://`.

Docker provisioning also pins agent CLI paths to `/usr/local/bin/*` so project
dependencies inside `/app/node_modules/.bin` cannot shadow the authenticated
container CLIs. The Files page, launch directory picker, and app file pickers
all use the configured Wingman workspace root, `/workspace` by default. That
path is a bind mount from `WINGMAN_WORKSPACE_HOST_PATH` on the base machine, so
the operator can inspect files directly outside Docker. Codex sessions trust
`/workspace` by default to avoid an interactive first-run trust prompt in the
web UI.

For hosted app subdomains, configure the base-machine Cloudflare Tunnel with
both `wmd.otherstuff.ai` and `*.wmd.otherstuff.ai` pointing to the Wingman host
port. Then set `WINGMAN_APP_ROUTING=subdomain` and
`WINGMAN_SUBDOMAIN_BASE_DOMAIN=wmd.otherstuff.ai` in the Docker `.env` file.
Settings -> Workspace shows the current routing mode and can generate the
matching Docker env snippet.

Cloudflare also needs an edge certificate that covers the nested wildcard app
hostnames, for example `*.wmd.otherstuff.ai`. A certificate for
`*.otherstuff.ai` does not cover `rare-zap-horn.wmd.otherstuff.ai`.

## Runtime Model

Wingmen is a long-running Bun server that:

1. serves the web UI and operational HTTP APIs
2. allocates ports and spawns agent runtimes
3. tracks sessions, logs, messages, and status
4. injects MCP config and per-session identity/env context
5. exposes higher-level app, git, job, memory, and Nostr tooling to agents and operators

## Jobs

The current Jobs subsystem is user-facing as “Jobs”, but internally still uses `autopilot-jobs` in API paths and some module names.

Examples:

- `/api/autopilot-jobs/definitions`
- `/api/autopilot-jobs/runs`
- `src/jobs-api.ts`

Treat this as a naming-compatibility layer rather than a separate product.

## App Lifecycle CLI (NIP-98)

Use `scripts/wingman-appctl.ts` to control registered apps over HTTP with NIP-98 auth headers.

```bash
export WINGMAN_NSEC=nsec1...

bun run appctl list
bun run appctl status <app-id>
bun run appctl start <app-id>
bun run appctl stop <app-id>
bun run appctl setup <app-id>
```

Options:

- `--base-url <url>` target Wingman base URL
- `--key <nsec|hex>` override signing key for this invocation
- `--json` print raw API responses

## Environment

| Variable | Description | Default |
|---|---|---|
| `PORT` | Primary Wingman UI/API port | `3600` |
| `AGENT_PORTS` | Starting port assigned to agent subprocesses | `3700` |
| `AGENT_MAX` | Total number of concurrent agent ports available | `10` |
| `HOST_URL_BASE` | Template for app links; `<port>` is replaced with the app's assigned port | `https://host.otherstuff.ai/<port>` |
| `DIRECTORY_DEF` | Working directory used when launching agent subprocesses | `~/code` |
| `FOLDERACCESS` | Comma-separated directories exposed to file browsers and pickers | `DIRECTORY_DEF` |
| `APP_ROUTING` | Hosted app routing mode: `path` or `subdomain` | `subdomain` |
| `SUBDOMAIN_BASE_DOMAIN` | Base domain for hosted app aliases, e.g. `wmd.otherstuff.ai` | unset |
| `SUBDOMAIN_PROXY_ENABLED` | Enables wildcard subdomain proxying when a base domain is set | `true` |
| `AGENT_SPAWN_MODE` | Primary spawn-mode setting: `bun` or `pm2` | `bun` |
| `AGENT_MODE` | Deprecated compatibility input only | unset |
| `AGENTAPI_BIN` | Primary binary path for the AgentAPI executable | `./out/agentapi` |
| `CLAUDE_CLI` | Executable invoked for Claude sessions | `claude` |
| `GLOVES` | Claude approval mode; `OFF` adds skip-permissions | unset |
| `GOOSE_CLI` | Executable invoked for Goose sessions | `goose` |
| `CODEX_CLI` | Executable invoked for Codex sessions | `codex` |
| `OPENCODE_CLI` | Executable invoked for OpenCode sessions | `opencode` |
| `GEMINI_CLI` | Executable invoked for Gemini sessions | `gemini` |
| `PI_CLI` | Executable invoked for Pi sessions | `pi` |
| `AGENTAPI_ALLOWED_ORIGINS` | Value passed to AgentAPI `--allowed-origins` | `*` |
| `AGENTAPI_ALLOWED_HOSTS` | Value passed to AgentAPI `--allowed-hosts` | `localhost,127.0.0.1,[::1]` |

## Workflow Overview

- `Home` lists sessions and lets operators start or stop agents.
- `Live` shows running sessions, conversation state, logs, and prompt dispatch.
- Jobs let operators define reusable manager/worker execution patterns.
- App management controls registered local apps.
- MCP tooling exposes memories, git, Nostr, image generation, SuperBased access, and more to agents.

Refer to [docs/architecture.md](/Users/mini/code/wingmen/docs/architecture.md) for the current technical split.

## Session Persistence

For persistence across Wingman restarts, use PM2-backed spawning:

```bash
AGENT_SPAWN_MODE=pm2 bun start
```

Legacy fallback also works:

```bash
AGENT_MODE=pm2 bun start
```

Active contract:

- use `AGENT_SPAWN_MODE` to choose `bun` or `pm2`
- use `AGENTAPI_BIN` to choose which `agentapi` binary Wingman launches
- `AGENT_MODE` is deprecated compatibility only

## Documentation Notes

- `docs/architecture.md` is the main current technical map
- `docs/asbuilt/` and `docs/as_built/` contain historical snapshots and implementation notes
- design docs may still mention older internal names such as `autopilot-jobs`; treat those as implementation compatibility unless they explicitly propose a new contract
