# Repository Guidelines

## Project Structure & Module Organization

Wingman V2 centers on Bun services in `src/`. `src/server.ts` exposes the HTTP API/UI, `src/agents/` directs session orchestration, and `src/ui/` serves the dashboard bundle. Persisted state lives in `data/`. Keep compiled binaries in `out/agentapi`; the Bun source should not write there at runtime. `Examples/` holds multi-session demos, with `Examples/Example Web Interface` showcasing a reference frontend. Static assets served directly go in `public/`. Review `docs/architecture.md` before reworking subsystems.

## Build, Test, and Development Commands

Run `bun install` after pulling dependencies. Start the orchestrator locally with `bun start` (alias `bun run src/index.ts`), which respects environment settings from `src/config.ts`. Use `bun run --watch src/index.ts` while iterating to reload on change. Execute `bun test` to run TypeScript tests; add focused runs with `bun test path/to/file.test.ts`.

## Coding Style & Naming Conventions

COMMIT ALL CHANGES with a descriptive BUT NEVER PUSH
TypeScript is the default; prefer ESM imports and explicit extensions when needed (`./foo.ts`). Use two-space indentation, trailing semicolons, and single quotes only inside template literals. Name files with kebab-case, classes/types with PascalCase, and functions or variables in camelCase. Co-locate agent helpers under `src/agents/` and UI utilities under `src/ui/` to keep files under 400 lines. Follow the strict TypeScript configuration in `tsconfig.json`; address compiler warnings before committing.

DONT RUN TESTS. THEY DONT HELP> WE TEST MANUALLY AROUND HERE.

Keep changes tightly scoped: satisfy the request with the smallest viable diff unless the user explicitly asks for broader refactors.

## Testing Guidelines

Place unit tests beside the code (`feature.test.ts`) or in a sibling `__tests__` folder. Mock subprocesses via lightweight stubs rather than spawning real CLIs. Keep coverage meaningful around session lifecycle code (`ProcessManager`), especially port allocation and cleanup. Add regression tests when modifying API contracts in `src/server.ts`.

## Commit & Pull Request Guidelines

Write imperative, present-tense commit subjects ≤72 characters (e.g., `Add process log streaming guard`). Separate logical changes into individual commits. PRs should describe scope, risks, and any configuration changes (env vars, ports). Link issues when relevant and include screenshots for UI tweaks (`/home`, `/live`). Ensure local `bun test` passes before requesting review.

## Agent & Configuration Tips

Confirm agent binaries (`out/agentapi`, `codex`, `claude`, `goose`, `opencode`) resolve on `$PATH` or override via environment variables listed in `README.md`. Update `DIRECTORY_DEF` when demos rely on alternate working directories. Document sensitive configuration changes in `docs/` so other agent operators can reproduce them.
