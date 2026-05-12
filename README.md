# Wingman

Wingman is the orchestration and control-plane layer for the Wingman suite.

In the current stack:

- `wingman-tower` is the workspace authority for auth, groups, encrypted record sync, storage, and service discovery
- `wingman-fd` is Flight Deck, the human-first local-first browser workspace
- `@runwingman/flightdeck-cli` is the agent/operator CLI workspace client
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

Run the local orchestration server under PM2:

```bash
pm2 start ecosystem.config.cjs --only wm-ap
pm2 logs wm-ap
pm2 restart wm-ap --update-env
pm2 stop wm-ap
```

The PM2 ecosystem config loads `.env`, runs `bun run src/index.ts`, and sets the
local process-supervision defaults to `AGENT_SPAWN_MODE=tmux` with
`AGENT_TMUX_SESSION=wm-ap-agents`. Override those by passing environment
variables to `pm2 start` when needed. That keeps PM2 responsible for the Wingman
server while agent sessions live in tmux-backed windows.

Visit:

- `http://localhost:<PORT>/home` for the session dashboard
- `http://localhost:<PORT>/live` for the real-time live/session surface

## Docker-First Setup

On a fresh server with Docker and Docker Compose installed:

```bash
git clone https://github.com/humansinstitute/wingman-autopilot.git
cd wingman-autopilot
chmod +x setupwizard.sh
./setupwizard.sh
```

The setup wizard prompts for:

- admin npub
- instance name and host port on the base machine
- public base URL
- host workspace directory mounted at `/workspace`
- path or subdomain app routing
- optional `WINGMAN_PRIV`

It writes an instance Docker env file such as `.env.wingman-01`, creates the
host workspace directory, and can immediately run:

```bash
docker compose --env-file .env.wingman-01 up -d --build
```

The plain `.env` file is reserved for local `bun start` development. Docker
instances should use `.env.wingman-01`, `.env.wingman-02`, and so on so local
and container settings do not overlap.

Docker setup defaults to `REGISTER=false`: unknown users cannot self-register.
The configured admin npub can bootstrap the first login, then add approved users
from Settings -> Users.
It also defaults to `WINGMAN_SHARED_INSTANCE=true`, so whitelisted users see the
same apps, sessions, workspace connection, and dispatch activity for the single
Wingman bot.

The default instance is `wingman-01`; if Docker already has that Compose project,
the wizard moves to `wingman-02`, `wingman-03`, and so on. The first instance
mounts the base-machine directory `~/.wm-ap` at `/workspace`; later generated
instances use numbered directories such as `~/.wm-ap02` and `~/.wm-ap03`.
The generated `WINGMAN_HOST_PORT` is the base-machine port published by Docker.
The container keeps its internal Wingman port at `3600`, so a host value such as
`3321` maps `localhost:3321` on the base machine to `3600` inside the container.
Cloudflare should point at the host port, for example `http://localhost:3321`;
do not set a separate container port per instance.

Use the restart helper to operate local or Docker envs without remembering the
Compose incantation:

```bash
chmod +x restart_wingman.sh
./restart_wingman.sh
./restart_wingman.sh --env .env.wingman-01 --restart
./restart_wingman.sh --env .env.wingman-01 --reload-env
./restart_wingman.sh --env .env.wingman-01 --rebuild
./restart_wingman.sh .env.wingman-01 status
```

`restart` only restarts the existing container. `reload-env` recreates the
container from the selected `.env.<instance>` file. `rebuild` rebuilds the image
and recreates the container.

Open a shell in the persistent `/home/wingman` environment and run the CLI login
flows from inside the container:

```bash
docker compose --env-file .env.wingman-01 exec wingman bash
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

Set `WINGMAN_PRIV=nsec1...` in the instance Docker env file when you want this instance to
use a single shared Wingman bot identity. Admins can copy the nsec from the
identity panel; normal operators only see the public bot identity details.

Run the readiness checklist any time:

```bash
docker compose --env-file .env.wingman-01 exec wingman bun run docker:check
```

The checklist reports installed tools, writable Docker volumes, configured
Wingman URLs/workspace values, required secrets, and whether CLI auth files are
detectable in `/home/wingman`.

For local HTTP testing, setup sets `WINGMAN_IDENTITY_COOKIE_SECURE=false` so
browsers accept the development session cookie. For HTTPS tunnel deployments,
setup sets secure cookies when the public base URL starts with `https://`.

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
`WINGMAN_SUBDOMAIN_BASE_DOMAIN=wmd.otherstuff.ai` in the instance Docker env file.
Settings -> Workspace shows the current routing mode and can generate the
matching Docker env snippet.

Cloudflare also needs an edge certificate that covers the nested wildcard app
hostnames, for example `*.wmd.otherstuff.ai`. A certificate for
`*.otherstuff.ai` does not cover `rare-zap-horn.wmd.otherstuff.ai`.

For noninteractive provisioning, the underlying helper is still available:

```bash
bun run docker:provision --admin-npub npub1...
docker compose --env-file .env.wingman-01 up -d --build
```

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
| `AGENT_SPAWN_MODE` | Primary spawn-mode setting: `bun`, `pm2`, or `tmux` | `bun` |
| `AGENT_TMUX_SESSION` | Tmux session used for tmux-spawned agent windows | `wm-ap-agents` |
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

For persistence across Wingman restarts, use tmux-backed spawning or PM2-backed spawning:

```bash
AGENT_SPAWN_MODE=tmux AGENT_TMUX_SESSION=wm-ap-agents bun start
```

Tmux mode creates one tmux session and one window per Wingman agent session while still running the standard `AGENTAPI_BIN` binary.

```bash
AGENT_SPAWN_MODE=pm2 bun start
```

Legacy fallback also works:

```bash
AGENT_MODE=pm2 bun start
```

Active contract:

- use `AGENT_SPAWN_MODE` to choose `bun`, `pm2`, or `tmux`
- use `AGENTAPI_BIN` to choose which `agentapi` binary Wingman launches
- `AGENT_MODE` is deprecated compatibility only

## Documentation Notes

- `docs/architecture.md` is the main current technical map
- `docs/asbuilt/` and `docs/as_built/` contain historical snapshots and implementation notes
- design docs may still mention older internal names such as `autopilot-jobs`; treat those as implementation compatibility unless they explicitly propose a new contract
