# Wingman V2

**NOTE: CURRENTLY THIS WILL RUN AUTOMATICALLY ON MAC. FOR LINUX YOU NEED TO COMPILE AN AGENT API BINARY AND COPY TO out/agentapi THIS SHOULD BE SCRIPTED BY THIS WEEKEND FOR ALL MAC AND LINUX PLATFORMS** 

Wingman: Every Computer Becomes a Ten-Person Team

Wingman is an open-source Agent Management system that brings AI automation to small businesses, without the technical complexity or vendor lock-in.

The Problem:

The cost of hiring employees has become prohibitively expensive for small businesses and individuals. Whether you need developers, administrators, marketers, or support staff, the next marginal employee often costs more than small operations can afford.

AI Agents offer a compelling alternative, but today's tools are built for technically capable users locked in terminals, expecting users to be present at their machines. This doesn't fit the reality of stressed business owners managing operations from their phones or in the field.

The Vision:

Wingman empowers Business Owners, Staff, Entrepreneurs, and Developers to deploy AI Agents into their businesses while retaining complete control over their data and processes.

Core Capabilities:
- Web-First Interface: Escape the terminal. Manage agents through intuitive web interfaces accessible from any device. Start automation on your desktop, monitor progress from your laptop, review results from your phone.
- Multi-Agent Orchestration: Access powerful agents (Goose, Claude, Codex, OpenCode) with full MCP tool support. No model restrictions, no vendor lock-in. Hot-swap agents as better models emerge without rewriting your business logic.
- Templates & Community Library: Pre-built agent profiles and orchestration workflows for common business tasks: MicroSaaS software development, content production, customer support, marketing automation. Community-driven marketplace for sharing and discovering proven patterns.
- BYO SaaS ("Build Your Own Micro SaaS"): Create and host custom micro-apps directly in Wingman. Need adjustments? Click "Edit with AI" and reshape the app to your exact needs. Own your tools, don't rent them.
- Visual Process Orchestration: Define business processes in human-readable workflows with simple understandable file based triggers and handoffs. Integrate APIs, scheduled jobs all in natural language without writing code. Build once, automate forever.
- Self-Hosted First: Deploy on your infrastructure (Mac Mini, Raspberry Pi, VPS, or cloud). Control your data, you can run entirely local models via Ollama for complete privacy. Full control, zero compromises.

The Impact:

Wingman shortens the distance between having an idea and making a living from it. Democratising access to AI automation, we enable anyone to compete in the modern economy without being chained to their desk, their budget or locked in to SaaS middlemen.

Small businesses deserve the same AI capabilities as Fortune 500 companies. Wingman makes that possible, open source.

Solivtur Ambulando!

## Getting Started

Install dependencies:

```bash
bun install
```

Launch the orchestration server (defaults to port `3600` unless `PORT` is set):

```bash
bun start
```

Visit `http://localhost:<PORT>/home` for the session dashboard or `/live` for the tabbed, real-time view.

## Environment

| Variable         | Description                                                                    | Default                 |
|------------------|--------------------------------------------------------------------------------|-------------------------|
| `PORT`           | Primary Wingman UI/API port                                                    | `3600`                  |
| `AGENT_PORTS`    | Starting port assigned to agent subprocesses                                   | `3700`                  |
| `AGENT_MAX`      | Total number of concurrent agent ports available                               | `10`                    |
| `DIRECTORY_DEF`  | Working directory used when launching agent subprocesses                       | `~/code`                |
| `FOLDERACCESS`   | Comma-separated directories exposed to file browsers and pickers               | `DIRECTORY_DEF`         |
| `AGENT_MODE`     | Switch orchestration mode; set to `tmux` to launch via `agentapi-tmux`         | `standard`              |
| `AGENTAPI_BIN`   | Absolute path to the AgentAPI binary used to host each agent                   | `./out/agentapi` or `./out/agentapi-tmux` when `AGENT_MODE=tmux` |
| `CLAUDE_CLI`     | Executable invoked for Claude sessions (override if not simply `claude`)       | `claude`                |
| `GOOSE_CLI`      | Executable invoked for Goose sessions                                          | `goose`                 |
| `CODEX_CLI`      | Executable invoked for Codex sessions (Wingman passes `--type=codex` as well)  | `codex`                 |
| `OPENCODE_CLI`   | Executable invoked for OpenCode sessions                                       | `opencode`              |
| `AGENTAPI_ALLOWED_ORIGINS` | Value passed to AgentAPI `--allowed-origins`                         | `*`                     |
| `AGENTAPI_ALLOWED_HOSTS`   | Value passed to AgentAPI `--allowed-hosts`                           | `localhost,127.0.0.1,[::1]` |

## Workflow Overview

- `Home` view lists active sessions and lets you start or stop agents.
- `Live` view shows each running session in tabs, streams logs, displays the agent conversation transcript, and lets you send new prompts directly to the active agent.
- All agents launch as subprocesses with dedicated ports allocated from the configured range.

Refer to `docs/architecture.md` for a deeper dive into directory responsibilities and runtime flow.
