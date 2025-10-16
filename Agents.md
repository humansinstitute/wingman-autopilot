---
description: Bun-first AI agent workspace layout
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

## Project Layout Precedents

- `data/` stores all persistent databases used by Wingman V2 agents.
- `src/` contains the TypeScript source for the Bun runtime services.
- `out/agentapi` is the compiled binary that exposes agent capabilities over HTTP.
- `Examples/` demonstrates multi-session agent orchestration across distinct ports.
- `Examples/Example Web Interface/` contains a reference frontend that consumes the agent APIs.

## Bun Usage Guidelines

Default to Bun for runtime, bundling, and testing.

- Use `bun run` for executing TypeScript entry points.
- Use `bun install` for dependency management.
- Use `bun test` for automated testing.
- Prefer Bun-provided APIs (`Bun.serve`, `bun:sqlite`, `Bun.redis`, etc.) over Node-specific libraries.

## Helpful References

- `docs/architecture.md` describes how the directories interact to deliver the agent platform.
- `tsconfig.json` is configured for Bun’s bundler resolution and strict TypeScript options.
