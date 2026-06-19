# Ticket: Dispatch pipeline policies should resolve stable IDs to latest definitions

Date: 2026-06-19
Repo: `/Users/mini/code/wingmanbefree/autopilot`

## Problem

Flight Deck dispatch settings can store generated pipeline definition ids such as `shared:7df6cda5438c`. These ids are derived from the installed definition content/path. When a built-in dispatch pipeline is updated, existing settings may continue to resolve the old generated id instead of the current `fd-agent-dispatch-chat` definition.

This surfaced during quick chat dispatch tests:

- `fd-agent-dispatch-chat` run `1782d3fa-fa68-40ee-9e45-8edd32c3a04b`
- `fd-agent-dispatch-chat` run `94aea07b-1818-47a0-a929-c2eb907f20ca`

Both runs selected `shared:7df6cda5438c` and launched Codex for `analyse-intent` because the installed shared definition still had:

```json
"agent": "$.agent.defaultAgent"
```

The desired current behavior is for `fd-agent-dispatch-chat` to use the fast dispatch classifier:

```json
"agent": "opencode",
"model": "openrouter/deepseek/deepseek-v4-flash"
```

and to include the deterministic `prepare-short-lookup-answer` step before any classifier agent is launched.

## Desired Model

Dispatch policy settings should store a stable pipeline identifier and an explicit version policy.

Recommended current shape:

```json
{
  "pipelineDefinitionId": "fd-agent-dispatch-chat",
  "pipelineVersionPolicy": "latest"
}
```

Semantics:

- `pipelineDefinitionId` is the stable slug/name selected in Flight Deck or configured as the built-in default.
- `pipelineVersionPolicy: "latest"` means resolve the latest/current definition in that family at dispatch time.
- Future pinned support can add `pipelineVersionPolicy: "pinned"` plus a pinned generated id or version reference.
- Existing generated ids should be migrated or resolved compatibly for built-in dispatch pipelines so current settings do not keep running obsolete definitions.

For this ticket, implement latest semantics first. Do not implement a full pinned-version UI unless it is required to keep existing behavior working.

## Scope

Likely files:

- `src/agent-chat/agent-profile-policy-store.ts`
- `src/agent-chat/dispatch-pipelines/runtime.ts`
- `src/agent-chat/dispatch-pipelines/route-store.ts`
- `src/agent-chat/subscription-runtime.ts`
- `src/server/agent-chat-routes.ts`
- `src/ui/views/settings/flight-deck-section.js`
- `src/ui/views/settings/agent-chat-profile-workspace-card.js`
- `src/ui/views/settings/agent-chat-shared-ui.js`
- `src/pipelines/pipeline-loader.ts`
- related tests under `src/agent-chat`, `src/server`, `src/ui/views/settings`, and `src/pipelines`

## Requirements

1. Dispatch policies and route records should support a version policy field, defaulting to `latest`.
2. For built-in/default dispatch pipelines, persisted settings should use stable ids such as:
   - `fd-agent-dispatch-chat`
   - `fd-agent-dispatch-task-response`
   - `fd-agent-dispatch-comment-response`
3. Runtime dispatch should resolve stable ids with `latest` semantics to the current installed definition.
4. Existing generated ids for known built-in dispatch definitions should not keep the system on obsolete behavior. Either migrate them to stable ids or resolve them to the latest family at runtime.
5. The Flight Deck settings UI should not save generated shared ids for normal "latest" dispatch choices.
6. The pipeline list can still show generated ids for diagnostics, but user-facing dispatch configuration should prefer stable ids.
7. Do not reintroduce Yoke or legacy fallback behavior.
8. Do not restart Autopilot inside the implementation unless explicitly approved by Pete. If a restart is needed to activate server code, report that in the handoff.

## Acceptance Criteria

- A policy configured for chat dispatch with `fd-agent-dispatch-chat` resolves to the latest shared `fd-agent-dispatch-chat` definition at runtime.
- A policy that currently stores an old generated id for `fd-agent-dispatch-chat` is normalized or resolved to latest `fd-agent-dispatch-chat`.
- A regression test proves route/profile policy selection does not pin built-in dispatch to an obsolete generated id by default.
- A regression test proves the current `fd-agent-dispatch-chat` definition contains `prepare-short-lookup-answer`.
- A regression test proves `analyse-intent` in the current `fd-agent-dispatch-chat` definition uses:
  - `agent: "opencode"`
  - `model: "openrouter/deepseek/deepseek-v4-flash"`
- Existing explicit custom/user pipeline selections continue to work.
- Focused tests pass.

## Validation Suggestions

Run the smallest useful set first:

```bash
bun --check src/agent-chat/agent-profile-policy-store.ts src/agent-chat/dispatch-pipelines/runtime.ts src/agent-chat/dispatch-pipelines/route-store.ts src/server/agent-chat-routes.ts src/pipelines/pipeline-loader.ts
bun test src/pipelines/pipeline-loader.test.ts src/agent-chat/agent-profile-policy-store.test.ts src/agent-chat/subscription-runtime.agent-work.test.ts src/server/agent-chat-routes.test.ts
```

If UI code changes:

```bash
bun test src/ui/views/settings/flight-deck-section.test.js
```

If the implementation requires a live server restart for the changed TypeScript to take effect, state that plainly in the final report rather than restarting automatically.

## Reporting

Return a concise implementation summary with:

- changed files
- migration/runtime compatibility behavior
- tests run
- any restart or manual migration required
