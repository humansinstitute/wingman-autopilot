# Wingman V2 Architecture Overview

## Directory Conventions

- `src/`: Bun-based TypeScript services that orchestrate and serve AI agents.
- `data/`: Persistent databases, embeddings stores, and other on-disk state backing the agents.
- `out/agentapi`: Build artifact (binary) that exposes agent capabilities over an HTTP API layer.
- `Examples/`: Reference compositions showing how to run multiple agent sessions on distinct ports.
- `Examples/Example Web Interface/`: Demo client that consumes the agent APIs for interactive exploration.

## Runtime Flow

1. Source in `src/` is bundled and compiled with Bun, producing the `out/agentapi` executable.
2. The binary loads configuration and persistent state from `data/` at startup.
3. Each API instance can be launched on its own port, following the multi-session patterns in `Examples/`.
4. The example web UI connects to one or more running agent API instances to issue tasks, display results, and manage sessions.

## Extending the Platform

- **Agent Logic**: Add new handlers or services under `src/`, using Bun-native APIs whenever possible.
- **Persistence**: Store new datasets or schema migrations in `data/`, ensuring the runtime has read/write access.
- **Deployment**: Update build scripts to recreate `out/agentapi` after code changes; distribute that binary for deployment.
- **Multi-session**: Use `Examples/` as a blueprint for orchestrating multiple agents or tenants, keeping port assignments isolated.
- **Frontend**: Prototype additional UX features in `Examples/Example Web Interface/`, consuming the same HTTP endpoints exposed by the binary.
