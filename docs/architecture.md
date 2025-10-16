# Wingman V2 Architecture Overview

## Directory Conventions

- `src/config.ts`: Centralises environment defaults (ports, working directory, agent catalog).
- `src/server.ts`: Bun HTTP server exposing REST APIs (`/api/*`) and serving the Home/Live UI.
- `src/agents/process-manager.ts`: Session lifecycle orchestration and subprocess management.
- `src/agents/runtime.ts`: Legacy placeholder agent runtime kept for testing; production sessions use `out/agentapi`.
- `src/ui/`: Static assets for the Home dashboard and Live tabbed interface.
- `data/`: Persistent databases, embeddings stores, or other on-disk state backing agents.
- `out/agentapi`: Future build artifact location for production binaries.
- `Examples/`: Reference compositions showing multi-session orchestration patterns.
- `Examples/Example Web Interface/`: Demo frontend that consumes agent APIs.

## Runtime Flow

1. `src/index.ts` boots the Bun server defined in `src/server.ts`.
2. API clients call `/api/sessions` to create, list, or stop agent sessions.
3. The `ProcessManager` allocates an available port (`AGENT_PORTS` … `AGENT_PORTS + AGENT_MAX`) and spawns `out/agentapi server` with the requested agent CLI inside the `DIRECTORY_DEF` working directory.
4. The AgentAPI subprocess exposes its own HTTP API (messages, events, status) on that port while streaming stdout/stderr back to Wingman for diagnostics.
5. The Wingman Home view lists sessions, while the Live view renders tabs, displays each agent conversation, lets users send prompts, and continues to poll `/api/sessions/:id/logs` for diagnostics.

## Extending the Platform

- **Agent Logic**: Adjust the command templates in `src/config.ts` to target different agent CLIs or wrap additional tooling before invoking `out/agentapi`.
- **Persistence**: Store datasets or embeddings in `data/`, ensuring agents mount that directory in their working context.
- **Process Scaling**: Adjust `AGENT_MAX`/`AGENT_PORTS` in the environment; augment `ProcessManager` to distribute across nodes if required.
- **Observability**: Enhance log streaming (e.g., WebSockets or SSE) and persist metrics for running sessions.
- **Frontend**: Evolve `src/ui` or integrate the `Examples/Example Web Interface/` assets for richer controls, including runtime directory selection.
