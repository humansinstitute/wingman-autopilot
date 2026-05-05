# Dispatch Pipelines

This document captures the design for moving Wingmen Agent Dispatch from
single prompt delivery into declarative pipeline runs.

## Problem

Agent Dispatch currently treats incoming workspace events as prompts for a
matching local agent session. Chat messages, task records, flow kickoff tasks,
task review records, approval records, and document comments each have routing
logic that eventually creates or reuses a session and sends one prompt template.

That model is hard to make reliable because the important workflow is hidden in
one unstructured prompt:

- routing, eligibility, prompt construction, session creation, and side effects
  are coupled;
- runtime history says a dispatch happened, but not which sub-decisions were
  made;
- failures are tied to a session prompt rather than a resumable workflow step;
- changing behavior means editing prompt templates instead of composing
  deterministic and agent steps;
- chat, task, comment, and approval dispatch drift into separate code paths.

The scheduler already supports `actionType: "pipeline"` for cron, file watcher,
and Nostr triggers. Workspace Agent Dispatch should use the same pipeline runner
instead of having its own prompt-only runtime.

## Goal

Incoming workspace records should be normalized into a dispatch event, matched
against dispatch routes, and launched as one or more pipeline runs.

The high-level flow should be:

```text
workspace SSE / record pull
  -> decrypt and normalize record
  -> classify dispatch event
  -> evaluate dispatch routes
  -> build pipeline input envelope
  -> run declarative pipeline
  -> record dispatch outcome with pipelineRunId
```

The user-facing settings should shift from "which prompt do we send to this
agent?" to "when records arrive, which pipeline should handle them?"

## Non-Goals

- Do not remove the existing session prompt dispatch path in the first pass.
- Do not put pipeline execution logic into `src/server.ts` or `src/ui/app.js`.
- Do not require every existing dispatch mode to migrate at once.
- Do not store raw decrypted secrets in pipeline definitions. Runtime inputs may
  contain record payloads that were already decrypted for dispatch, but
  reusable credentials stay in existing key stores and runtime state dirs.

## Dispatch Route Model

Add a dispatch route as the durable configuration object behind Agent Dispatch.
A route connects a kind of incoming record to a pipeline definition.

Suggested shape:

```ts
interface DispatchPipelineRoute {
  id: string;
  managedByNpub: string;
  workspaceOwnerNpub: string;
  botNpub: string;
  sourceAppNpub: string;
  name: string;
  triggerKind: 'chat' | 'task' | 'flow' | 'task_review' | 'approval' | 'comment';
  capability: 'chat_intercept' | 'task_dispatch' | 'flow_dispatch' | 'task_review' | 'approval_dispatch';
  pipelineDefinitionId: string;
  enabled: boolean;
  priority: number;
  matchJson: Record<string, unknown>;
  inputTemplateJson: Record<string, unknown>;
  concurrencyKeyTemplate: string;
  activePolicy: 'skip' | 'queue' | 'start_new';
  dedupeWindowSeconds: number;
  createdAt: string;
  updatedAt: string;
}
```

`matchJson` should stay intentionally small in the first version:

- group npubs or "any group";
- record family, such as task, document comment, or chat message;
- task state filters, such as `new`, `ready`, `review`, or `approved`;
- assignment filters, such as assigned to the local bot, assigned to any, or
  unassigned;
- changed-field filters, such as only dispatch when `state`, `assigned_to`, or
  `approval_state` changed.

The first route match should not need a general expression language. If we need
more power later, add a built-in pipeline preflight function instead of making
route matching complex.

## Pipeline Input Envelope

Every dispatch pipeline should receive a stable JSON object. The route can add
defaults through `inputTemplateJson`, but the runtime should always provide the
same core envelope.

```json
{
  "dispatch": {
    "dispatchId": "dispatch-history-entry-id",
    "routeId": "dispatch-route-id",
    "triggerKind": "chat",
    "receivedAt": "2026-05-05T00:00:00.000Z",
    "dedupeKey": "workspace:thread:agent:record"
  },
  "workspace": {
    "workspaceOwnerNpub": "npub...",
    "sourceAppNpub": "npub...",
    "backendBaseUrl": "https://...",
    "subscriptionId": "sub-id"
  },
  "agent": {
    "agentId": "agent_main",
    "label": "Main Agent",
    "botNpub": "npub...",
    "workingDirectory": "/Users/mini/code/example",
    "defaultAgent": "codex"
  },
  "record": {
    "recordId": "record-id",
    "recordFamily": "chat",
    "recordState": "active",
    "version": 12,
    "updaterNpub": "npub...",
    "payload": {}
  },
  "routing": {
    "bindingId": "thread-or-task-id",
    "bindingType": "thread",
    "channelId": "channel-id",
    "threadId": "thread-id",
    "changedFields": []
  },
  "runtime": {
    "yokeStateDir": "/path/to/state",
    "commands": {
      "context": "bun ...",
      "history": "bun ...",
      "search": "bun ...",
      "replyCurrent": "bun ..."
    }
  }
}
```

Record payloads should be normalized per trigger kind before they enter the
pipeline. Pipelines should not have to know every legacy Tower record spelling.

## Pipeline Responsibilities

Pipelines should keep each decision visible:

- code steps normalize, validate, diff, and route deterministic state;
- agent steps make judgment calls, write responses, inspect repositories, or
  prepare board changes;
- code steps parse agent output and perform auditable side effects;
- final steps return structured dispatch status.

A pipeline result should include:

```json
{
  "status": "handled",
  "decision": "respond",
  "summary": "Published a chat reply.",
  "externalIds": {
    "replyRecordId": "record-id"
  }
}
```

Suggested statuses:

- `handled`: the dispatch did the intended work;
- `ignored`: the route matched but the pipeline decided no action was needed;
- `blocked`: the pipeline needs human input or a missing prerequisite;
- `failed`: the pipeline hit an error.

## Example Chat Pipeline

A generated chat pipeline can replace the current chat prompt template with
structured steps:

```json
{
  "name": "chat-dispatch.v1",
  "description": "Decide whether the local bot should respond to a chat thread and publish when needed.",
  "version": 1,
  "input": {},
  "steps": [
    {
      "name": "prepare-chat-context",
      "type": "code",
      "function": "dispatch.chat.prepareContext",
      "assign": "$.chat"
    },
    {
      "name": "decide-response",
      "type": "agent",
      "agent": "$.agent.defaultAgent",
      "directory": "$.agent.workingDirectory",
      "input": {
        "pick": {
          "thread": "$.chat.thread",
          "recentTurns": "$.chat.recentTurns",
          "commands": "$.runtime.commands"
        }
      },
      "prompt": "Decide whether to respond. If responding, publish through replyCurrent or return a reply body plus rationale.",
      "assign": "$.decision"
    },
    {
      "name": "apply-chat-decision",
      "type": "code",
      "function": "dispatch.chat.applyDecision",
      "input": {
        "pick": {
          "decision": "$.decision",
          "runtime": "$.runtime",
          "record": "$.record"
        }
      },
      "assign": "$.result"
    },
    {
      "name": "finalise",
      "type": "code",
      "function": "dispatch.finalise"
    }
  ]
}
```

The generated defaults for task, flow, review, approval, and comment dispatch
should follow the same pattern: prepare context, decide or act, apply side
effects, finalise.

## Runtime Behavior

1. The subscription runtime receives an SSE record change and pulls the latest
   record versions.
2. Existing decrypt and normalizer code produces an inbound dispatch event.
3. A new dispatch route evaluator loads enabled routes for the subscription and
   returns ordered matches.
4. For each match, the runtime builds the pipeline input envelope and derives a
   concurrency key.
5. The dispatch pipeline runtime starts `runDeclarativePipeline` with the
   matching owner alias and records `pipelineRunId` in recent dispatch history.
6. The pipeline runner owns agent session creation, callback waiting, restart
   recovery, step history, and final status.
7. Dispatch history links back to the pipeline run instead of only a session id.

For active-policy handling:

- `skip` records a skipped dispatch when a run with the same concurrency key is
  already active;
- `queue` records the event and starts it after the active run completes;
- `start_new` launches immediately and relies on dedupe keys to avoid duplicate
  side effects.

MVP should use `skip` for task, approval, and comments, and `queue` for chat
threads where follow-up messages are expected.

## Storage and API

Create a dedicated dispatch pipeline store instead of extending unrelated
stores:

```text
src/agent-chat/dispatch-pipelines/
  types.ts
  route-store.ts
  route-evaluator.ts
  input-builders.ts
  runtime.ts
  history.ts
```

Suggested tables in the existing Agent Dispatch database area:

- `agent_dispatch_pipeline_routes`
- `agent_dispatch_pipeline_runs`
- optionally `agent_dispatch_pipeline_queue` for `activePolicy: "queue"`

`WorkspaceSubscriptionRecord.recentDispatches` should gain:

- `pipelineRunId`;
- `routeId`;
- `status`;
- `concurrencyKey`;
- `details` for skip or failure reasons.

Add API routes outside `server.ts`, for example
`src/server/dispatch-pipeline-routes.ts`:

- `GET /api/agent-chat/dispatch-routes`
- `POST /api/agent-chat/dispatch-routes`
- `PATCH /api/agent-chat/dispatch-routes/:id`
- `DELETE /api/agent-chat/dispatch-routes/:id`
- `POST /api/agent-chat/dispatch-routes/:id/test`

The test endpoint should accept a sample record envelope, run route evaluation,
and optionally start a dry-run pipeline with side-effect functions disabled.

## Settings UI

The Agent Dispatch settings page should move from prompt cards to route cards:

- Workspace connection remains the top-level setup.
- Local agent identity remains, but dispatch behavior is configured as routes.
- Each route shows trigger kind, match summary, pipeline definition, priority,
  active policy, enabled state, and latest run status.
- "Generate Pipeline" starts the existing pipeline wizard with a seed prompt for
  the selected dispatch kind.
- "Use Existing Pipeline" selects a pipeline definition from
  `/api/pipelines/definitions`.
- "Test Route" evaluates a sample incoming record and shows the exact pipeline
  input envelope.

Keep UI code out of `src/ui/app.js`. Add focused modules under a new directory,
for example:

```text
src/ui/views/settings/agent-dispatch-pipelines/
  api.js
  route-cards.js
  editor.js
  state.js
```

If new files are added under `src/ui`, confirm the static asset service serves
them as `application/javascript`.

## Migration Plan

Phase 1: route storage and read-only UI

- Add dispatch route store and API.
- List existing agent capabilities as generated legacy routes.
- Show which prompt-template path is still active.

Phase 2: chat pipeline MVP

- Generate a default chat dispatch pipeline per user.
- Add a route that maps chat records to that pipeline.
- Keep the old `AgentChatSessionRuntime` available behind a legacy route.
- Record both `pipelineRunId` and any agent step session ids in dispatch history.

Phase 3: work dispatch pipelines

- Migrate `task_dispatch`, `flow_dispatch`, `task_review`, and
  `approval_dispatch` to pipeline routes.
- Move current prompt templates into generated default pipeline definitions.
- Preserve existing eligibility checks as deterministic preflight code steps.

Phase 4: comments and replay

- Migrate document comment dispatch.
- Add replay from recent dispatch history into a selected pipeline route.
- Add route test fixtures for chat, task, approval, and comment records.

Phase 5: retire prompt-template editing

- Keep prompt templates as compatibility fields for old routes only.
- New dispatch behavior is pipeline-only.
- Remove direct session prompt dispatch once existing routes have migration
  affordances.

## Implementation Notes

- Reuse `PipelineStore`, `getPipelineDefinition`,
  `loadPipelineFunctionRegistry`, and `runDeclarativePipeline`.
- Keep owner resolution the same as scheduler pipeline triggers:
  `generateIdentityAlias(ownerNpub)`.
- Put dispatch-specific built-in functions in pipeline function modules, not in
  subscription runtime methods.
- Store compact references in route config. Runtime can fetch fresh records,
  context, and Yoke state before launching the pipeline.
- Preserve object-in/object-out step contracts.
- Make every route launch idempotent with a dedupe key built from workspace,
  record id, record version, route id, and binding id.
- Add tests around route matching, input envelope building, active-policy
  behavior, and dispatch history updates.

## Open Questions

- Should chat follow-up messages interrupt an active pipeline agent step, or
  queue a second pipeline run with a merged turn package?
- Should route matching allow multiple pipelines per trigger kind by default, or
  should the UI default to first-match wins?
- Which side effects should be code functions versus agent instructions for the
  first chat pipeline?
- Should route definitions live only in SQLite, or should they eventually become
  exportable JSON beside pipeline definitions?
