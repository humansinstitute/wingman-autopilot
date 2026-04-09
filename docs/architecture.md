# Wingman Architecture Overview

Status: active working document
Last updated: 2026-04-07

This document describes Wingmen as it exists today: the orchestration and control-plane layer around the wider Wingman suite.

## Role In The Suite

Wingmen sits beside the workspace stack:

- `wingman-tower` owns the workspace contract, auth, groups, encrypted sync, storage, and service discovery
- `wingman-fd` is the human-facing local-first Flight Deck
- `wingman-yoke` is the agent/operator CLI against that same workspace contract
- `wingman-flightlog` is the optional memory/history subsystem
- `wingmen` launches and manages agents that use those systems

Wingmen is not the source of truth for workspace state. It is the runtime harness and operational control plane for agent sessions.

## Main Responsibilities

- session lifecycle orchestration
- browser control surfaces (`/home`, `/live`)
- MCP server/tool brokering
- per-user bot-key management and export
- delegated NIP-98 flows
- jobs, scheduler, app runtime management, and memory tooling
- git/Gitea and Nostr helper surfaces
- SuperBased/Flux HTTP tooling for agent-side operations

## Runtime Shape

### Core Server

- `src/index.ts` boots the Bun server
- `src/server.ts` exposes the HTTP API and serves the browser UI
- `src/config.ts` centralizes environment defaults and command construction

### Session And Agent Runtime

- `src/agents/process-manager.ts` manages session start/stop and subprocess lifecycle
- `src/agents/` contains runtime adapters, MCP injection, env shaping, log handling, and polling
- spawned agent runtimes expose their own APIs on allocated ports and stream messages/logs back to Wingman

### Auth And Identity

- `src/auth/` handles cookie-backed auth, NIP-98 auth, access control, and request context
- bot-key provisioning/export and related identity flows live across `src/auth/`, `src/identity/`, and `src/agents/`
- `AGENT_NSEC` injection is part of the current session runtime model when the bot key is available

### MCP Control Plane

- `src/mcp/stdio-server.ts` provides the per-agent stdio MCP server
- `src/mcp/tools/` contains the tool implementations surfaced to agents
- the MCP plane calls back into Wingman’s HTTP APIs rather than mutating server state directly in-process

### Browser UI

- `src/ui/` contains the browser-side modules for Home, Live, Jobs, and related surfaces
- `/home` is the operator dashboard
- `/live` is the real-time session surface
- Jobs is the reusable execution-pattern UI for manager/worker runs

### Persistent State

- `data/` holds persistent databases and local state
- storage modules under `src/storage/` manage artifacts, settings, file watchers, archives, billing state, and related records

## Jobs Terminology

The current product surface is “Jobs”, but the implementation still uses legacy `autopilot-jobs` names in several places:

- HTTP routes: `/api/autopilot-jobs/*`
- modules such as `src/jobs-api.ts`
- frontend stores such as `autopilotJobs`

This should be treated as an internal compatibility layer, not as a separate product. When updating docs or UI copy, prefer “Jobs” unless the exact route/module name matters.

## Runtime Flow

1. Wingmen boots the Bun server.
2. Operators or APIs create/list/stop sessions via the server APIs.
3. The process manager allocates a port and spawns the requested agent runtime.
4. Wingmen injects env and MCP config, including identity-related values when available.
5. The browser UI consumes Wingmen APIs for live status, logs, jobs, apps, and session interaction.
6. Agent-side MCP tool calls route back through Wingmen APIs for controlled access to local and remote capabilities.

## Adjacent Integrations

### Wingman Workspace Stack

Wingmen-managed agents commonly interact with:

- Tower for workspace authority and encrypted sync
- Yoke for CLI-based workspace operations
- Flight Deck indirectly as the human-facing counterpart to the same workspace

### Gitea And Git Workflow

- `src/gitea/` and `src/git/` provide repository, credential, and workflow helpers
- these support both operator UX and agent-accessible tooling

### Nostr

- `src/nostr/` and several MCP tools expose Nostr-related capabilities
- bot keys are central to the current delegated/agent automation model

### SuperBased / Flux

- MCP tools and HTTP routes provide app-less SuperBased/Flux fetch/sync/history/storage operations for agents
- this is an operational integration surface, not the authority contract itself

## Documentation Boundaries

- `README.md` is the product/runtime overview
- this file is the current technical map
- `docs/asbuilt/` and `docs/as_built/` are historical/as-built snapshots and may retain older internal naming
- design docs should be explicit when they refer to a literal API/module name versus current product terminology

## Current Review Notes

As of 2026-04-07:

- the main drift is documentation/naming, not top-level product direction
- “Autopilot Jobs” is still a real internal/API name, but it reads as legacy terminology
- older docs that describe Wingmen in isolation can miss its current role beside Tower, Flight Deck, and Yoke
- current runtime behavior also includes bot-key export, AGENT_NSEC injection, app control, and richer MCP tooling than older architecture summaries describe
