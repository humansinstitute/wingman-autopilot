# Wingmen Subscription Improvements

Status: final design direction
Last updated: 2026-05-05

## Summary

Wingmen should make agent-to-Flight-Deck setup feel like connecting a workspace
app, not like manually wiring several local services.

The current setup path conflates backend transport, workspace authorization, bot
identity, SSE state, dispatch routing, and session ownership. Those concerns
need to split into two layers:

- a Wingmen instance has reusable backend connection records for
  SuperBased/Tower hosts;
- each user, bot, or explicit service agent has scoped workspace subscriptions
  for concrete workspace access, permissions, group-key visibility, dispatch
  history, audit, and session ownership.

Dispatch should move from bespoke session prompt routing into a reusable
pipeline backbone. SSE events remain advisory wake-up signals; dispatch code
pulls the authoritative record, decrypts and normalizes it, evaluates routes,
starts a declarative pipeline, and records diagnostics that explain what
happened.

## Source Context

This design is based on the Flight Deck chat thread identified by:

- channel: `97ae5c0d-f88c-41e7-9f7a-d64d27a4fd18`
- thread: `3cc8e1dd-0e2c-4706-b92c-8ec5efa6348e`
- workspace owner: `npub1jvj7txjsge62gmg7ar7kfu23zd95spw32nz5n0663eq4pzzyyjqsnlaz7e`
- backend: `https://sb4.otherstuff.studio`

The live `/wingmen/chat` route was not reachable from this finalization pass, so
this document does not add transcript-only claims beyond the existing draft and
review summaries. It also uses:

- `docs/dispatchpipeline.md`
- `docs/design/flight-deck-flow-dispatch-contract.md`
- the local Agent Connect reference exposed by the Flight Deck distribution.

The thread asked how to improve setup for local agents like `wm21`, duplicate
that setup for agents such as CoWorker, support multiple users on one Wingmen
instance, and move dispatch from session-level agent work into pipelines.

## Goals

- Configure a SuperBased/Tower host once per Wingmen instance.
- Let one Wingmen instance subscribe to multiple workspaces for multiple users.
- Keep workspace access user/agent-scoped by default.
- Allow shared service agents only when explicitly created as such.
- Make Agent Connect the setup surface for Flight Deck to Wingmen handoff.
- Treat SSE as advisory; fetch and decrypt authoritative records before routing.
- Convert chat, task, comment, flow, review, and approval dispatch onto
  declarative pipeline routes incrementally.
- Preserve clear audit, permissions, revocation, session attribution, and
  dispatch diagnostics.
- Make local agent cloning repeatable through `wm-fresh` without copying
  secrets, identities, Yoke state, or group-key caches.

## Non-Goals

- Do not make one global workspace connection implicitly shared by every user.
- Do not put connection source-of-truth fields only in prose files such as
  `llm.txt` or `llms.txt`.
- Do not treat SSE payloads as authoritative record state.
- Do not require every dispatch capability to migrate at once.
- Do not move pipeline logic into `src/server.ts` or `src/ui/app.js`.
- Do not copy local agent home directories, identities, workspace state, or
  decrypted group keys when creating a new agent.
- Do not define final billing semantics in this design. Keep attribution fields
  so a later billing decision has the data it needs.

## MVP Assumptions

- Backend connections are operator-managed instance records. Sharing a backend
  connection with another operator is explicit, not automatic.
- Workspace subscriptions are owned by `managedByNpub` and attached to one
  `botNpub`, one workspace owner, one source app, and one backend connection.
- Existing subscriptions remain valid during migration. The current
  `workspace_subscriptions` table and `WorkspaceSubscriptionRecord` shape are
  extended rather than replaced in one step.
- The existing unique index on `(workspace_owner_npub, bot_npub)` is too narrow
  for the target model. Migration should introduce a new uniqueness rule that
  includes backend/source app and manager ownership while preserving old rows.
- SSE never grants authority to dispatch by itself. It only tells the
  subscription runtime that a pull/decrypt/route cycle may be needed.
- `llms_url` and `llms.txt` are onboarding guidance. The Agent Connect package
  and its `connection_token` carry machine-readable connection facts.

## Core Concepts

### Backend Connection

A backend connection is reusable transport and service metadata for one
SuperBased/Tower host:

- `backendConnectionId`
- `backendBaseUrl`
- `serviceNpub`
- supported SuperBased/Tower API version
- default relay hints
- OpenAPI/docs/health URLs when supplied
- operator owner and sharing policy
- latest health status and compatibility diagnostic
- created/updated timestamps

This is not workspace authorization. It answers "how can this Wingmen instance
talk to that host?"

### Workspace Subscription

A workspace subscription grants a specific managed bot or service agent access
to a specific workspace stream through a backend connection.

Target identity fields:

```text
backendConnectionId
managedByNpub
workspaceOwnerNpub
sourceAppNpub
botNpub
```

Each subscription owns:

- workspace-key registration state
- encrypted workspace-key blob reference
- subscription-scoped group-key cache or runtime reference
- group-key decrypt diagnostics
- last SSE event id and recent advisory events
- reconnect/backoff state
- sync/catch-up state
- enabled capabilities and dispatch routes
- recent dispatch history
- latest health and failure diagnostics

This is the layer for permissions, audit, revocation, and session attribution.

### Agent Profile

An Agent Profile describes a local Wingmen-controlled agent before it is attached
to a workspace:

- `agentId`
- label
- bot identity reference
- encrypted secret reference
- working directory
- default runtime
- prompt or pipeline defaults
- capability toggles
- preferred repos or starter template

Current `AgentDefinitionRecord` rows combine local agent data with workspace and
bot binding fields. The target model can keep that table compatible while
extracting reusable profile fields for new setup flows.

### Agent Template Manifest

`wm-fresh` should expose a small manifest rather than relying on clone-time
convention:

- template name and version
- expected files, such as `AGENTS.md` and helper scripts
- supported runtimes
- default capability suggestions
- required post-clone setup steps
- healthcheck command
- Agent Connect import command
- explicit statement that identities, secrets, and workspace state are generated
  outside the repo.

## Data Model

This is the compact implementation target. Exact table names can follow current
storage conventions, but the records need these fields.

### `BackendConnectionRecord`

- `backendConnectionId`
- `managedByNpub`
- `backendBaseUrl`
- `serviceNpub`
- `relayUrls`
- `openapiUrl`
- `docsUrl`
- `healthUrl`
- `supportedVersion`
- `sharePolicy`
- `healthStatus`
- `lastHealthResult`
- `createdAt`
- `updatedAt`

Phase 1 can store this beside the current agent-chat subscription data. The
record should not contain workspace keys or bot secrets.

### `WorkspaceSubscriptionRecord`

Keep the existing fields and add:

- `backendConnectionId`
- `connectionTokenRef` or encrypted token reference when retention is needed
- `agentProfileId`
- `sourceAppNpub`
- `sourceAppSchemaNamespace` when available
- `capabilityDefaults`
- `dispatchRouteIds`
- `lastSyncCursor`
- `lastPipelineRunId`

The natural uniqueness rule should move toward:

```text
backendConnectionId + managedByNpub + workspaceOwnerNpub + sourceAppNpub + botNpub
```

If a shared service agent is desired, it gets an explicit service-owned
`managedByNpub` or service-owner marker. Two normal users connecting to the same
workspace get separate subscription rows by default.

### `AgentProfile`

- `agentProfileId`
- `managedByNpub`
- `agentId`
- `label`
- `botNpub`
- `botSecretRef`
- `workingDirectory`
- `defaultAgent`
- `templateId`
- `capabilities`
- `createdAt`
- `updatedAt`

The bot secret reference points to the existing encrypted key store boundary; it
is not copied into subscription, route, or pipeline records.

### `DispatchRoute`

Use the route model from `docs/dispatchpipeline.md`:

- `routeId`
- `managedByNpub`
- `subscriptionId`
- `workspaceOwnerNpub`
- `botNpub`
- `sourceAppNpub`
- `triggerKind`
- `capability`
- `pipelineDefinitionId`
- `enabled`
- `priority`
- `matchJson`
- `inputTemplateJson`
- `concurrencyKeyTemplate`
- `activePolicy`
- `dedupeWindowSeconds`
- timestamps

Route matching should stay intentionally small in the first version: group
filters, record family, task state, assignment, changed fields, and capability
kind. Add pipeline preflight functions later if matching needs more power.

### `DispatchHistory`

Extend `recentDispatches` or add a dedicated store with:

- `dispatchId`
- `subscriptionId`
- `routeId`
- `pipelineRunId`
- `triggerKind`
- `capability`
- `recordId`
- `recordVersion`
- `bindingType`
- `bindingId`
- `sessionIds`
- `status`
- `concurrencyKey`
- `dedupeKey`
- `dedupeReason`
- `suppressionReason`
- `diagnosticSummary`
- timestamps

History needs to record both matched and skipped decisions so the operator can
answer why an agent did or did not run.

## Agent Connect Package

Flight Deck should expose an Agent Connect package that Wingmen can import
without guessing required fields.

The package is versioned. Local references currently describe
`kind: coworker_agent_connect` and `version: 5`; related draft references may
name other versions. Wingmen should validate against an explicit supported
version policy rather than hardcoding one draft forever.

Target package shape:

```json
{
  "kind": "coworker_agent_connect",
  "version": 5,
  "generated_at": "2026-05-05T00:00:00.000Z",
  "llms_url": "https://example/llms.txt",
  "robots_url": "https://example/robots.txt",
  "service": {
    "direct_https_url": "https://sb4.otherstuff.studio",
    "openapi_url": "https://sb4.otherstuff.studio/openapi.json",
    "docs_url": "https://sb4.otherstuff.studio/docs",
    "health_url": "https://sb4.otherstuff.studio/health",
    "service_npub": "npub1...",
    "relay_urls": []
  },
  "workspace": {
    "owner_npub": "npub1...",
    "owner_pubkey": "hex..."
  },
  "app": {
    "app_npub": "npub1...",
    "app_pubkey": "hex..."
  },
  "connection_token": "base64-json-token",
  "groups": [],
  "capabilities": [],
  "template": {
    "repo_url": "https://github.com/humansinstitute/wm-fresh.git"
  },
  "notes": "short operational guidance"
}
```

Import validation:

- require `kind`, supported `version`, `generated_at`, `service.direct_https_url`,
  `workspace.owner_npub`, `app.app_npub`, and `connection_token`;
- parse `connection_token` and verify its backend URL, service identity,
  workspace owner, app identity, and relay hints are consistent with the outer
  package when both are present;
- create or reuse a `BackendConnectionRecord` from the `service` object;
- create a scoped `WorkspaceSubscriptionRecord` for the importing
  `managedByNpub` and selected bot;
- store secrets through existing encrypted key/token storage, not in route or
  pipeline definitions;
- run a dry healthcheck that validates backend health, workspace-key
  registration, group-key refresh, record pull, decrypt, route evaluation, and
  optional dry-run dispatch.

`llms_url` remains useful for semantics and commands, but it is not the
authority for connection state.

## Multi-User Model

One Wingmen installation can know about many backend hosts. Each backend host
can expose many workspace streams. Each workspace stream can have many scoped
subscriptions.

Supported examples:

- Pete bot to Pete workspace stream
- Pete bot to CoWorker workspace stream
- another user's bot to Pete workspace stream, if invited and authorized
- another user's bot to that user's own workspace stream
- an explicit workspace-owned service agent used by several operators

If two users on the same Wingmen instance connect to the same workspace, use
separate bot/workspace-key subscriptions by default. This keeps:

- permissions tied to bot/group membership;
- audit tied to the actual actor;
- session ownership attributable through `managedByNpub`, `agentId`, and
  `botNpub`;
- revocation isolated;
- SSE replay and dedupe state independent.

If two operators intentionally use the same service agent, the UI should label
that agent as shared and show who can manage it. Shared service agents must not
be created accidentally by reusing a backend connection.

## Subscription Health And Diagnostics

Wingmen should show one health panel per workspace subscription, with backend
health linked but not duplicated as the only signal.

Diagnostic ownership:

- backend host reachability and compatibility live on `BackendConnectionRecord`;
- workspace-key registration, group-key refresh, decrypt, sync, SSE, and
  subscription runtime failures live on `WorkspaceSubscriptionRecord`;
- route match, self-suppression, duplicate suppression, active-policy decisions,
  and dispatch status live on `DispatchHistory`;
- deterministic step status, agent step status, callback state, and final result
  live on the declarative pipeline run.

States should use the existing vocabulary where possible:

- workspace keys and group keys: `pending`, `active`, `refresh_required`,
  `revoked`, `failed`;
- SSE: `disconnected`, `connecting`, `connected`, `backoff`, `disabled`;
- health: `healthy`, `degraded`, `unhealthy`;
- dispatch: `matched`, `suppressed`, `queued`, `skipped`, `started`,
  `handled`, `ignored`, `blocked`, `failed`.

The operator should be able to answer "why did or did not this agent run?"
without reading logs. The panel should show the latest state plus recent bounded
history; exact retention can remain configurable.

## SSE Dispatch Pipeline

SSE should be a trigger, not the source of truth.

High-level flow:

```text
workspace SSE / record pull
  -> pull latest authoritative record
  -> decrypt and normalize record
  -> classify dispatch event
  -> evaluate dispatch routes
  -> build pipeline input envelope
  -> run declarative pipeline
  -> record dispatch outcome with pipelineRunId
```

The runtime should reuse existing pipeline infrastructure:

- `PipelineStore`
- `getPipelineDefinition`
- `loadPipelineFunctionRegistry`
- `runDeclarativePipeline`
- `generateIdentityAlias` for owner alias resolution.

Route evaluation builds the stable input envelope from `docs/dispatchpipeline.md`
and launches a pipeline using the route's `pipelineDefinitionId`. Dispatch
history stores `routeId`, `pipelineRunId`, `status`, `concurrencyKey`, dedupe
reason, and any agent session ids created by the run.

Active policy:

- `skip` records a skipped dispatch when a run with the same concurrency key is
  active;
- `queue` records the event and starts it after the active run completes;
- `start_new` launches immediately and relies on dedupe keys to prevent
  duplicate side effects.

MVP defaults should use `queue` for chat thread follow-ups and `skip` for task,
approval, review, and comment orchestration until replay behavior is proven.

## Dispatch Capabilities And Matchers

The route model should cover the current and planned capabilities without
hardcoding each capability as a separate runtime path.

| Trigger | Capability | First matcher contract |
| --- | --- | --- |
| `chat` | `chat_intercept` | chat message record, visible to subscribed groups, not self-authored, route key by channel/thread/agent |
| `task` | `task_dispatch` | task assigned to bot with `state = ready` |
| `task` | `flow_dispatch` | task assigned to bot, `state = new`, `flow_id != null`, `flow_run_id == null` |
| `task` | `task_review` | task assigned to bot, `state = review`, `flow_run_id != null` |
| `approval` | `approval_dispatch` | approval record transitions to `approved`, `flow_run_id != null` |
| `comment` | `comment_dispatch` | document or task comment visible to subscribed groups and matched to a live or route-created destination |

Flow Dispatch, Task Review, and Approval Dispatch should follow the contracts in
`docs/design/flight-deck-flow-dispatch-contract.md`: Flow Dispatch creates the
concrete run and child tasks, Task Review promotes newly unblocked child tasks,
and Approval Dispatch advances the run after an approval record is approved.

## Session Launch Contract

Every triggered pipeline that starts or resumes an agent session should include:

- workspace owner
- backend connection id and source app
- subscription id
- channel/thread, task, comment, approval, or flow id
- agent id and bot npub
- managed-by npub
- capability
- goal
- `nextAction=reflect` or another explicit completion action
- isolated Yoke state directory
- exact wrapper commands for reading and writing Flight Deck state.

Prompts should include commands to:

- read latest thread or task state;
- publish a chat reply;
- comment on a task or document;
- update task state;
- create flow child tasks or approvals when that capability owns the action;
- attach or reference artifacts.

Completion should set `nextAction=stop` after the reply, comment, or task update
is published, unless the route explicitly expects a long-running session.

## Agent Template And Cloning

`wm-fresh` should be the starter template for a new local Wingman.

The clone/import path:

1. clone template into a new working directory;
2. read template manifest;
3. generate a new bot identity outside git;
4. store bot secret in the encrypted Wingmen key store;
5. create an `AgentProfile`;
6. import the Agent Connect package;
7. create or reuse the backend connection;
8. create a scoped workspace subscription;
9. register workspace key and refresh group keys;
10. create default dispatch routes;
11. run healthcheck and dry-run dispatch.

Do not copy:

- `.wingmen` or Yoke runtime state;
- local agent home directories;
- bot private keys;
- workspace-key blobs;
- group-key caches;
- connection tokens into git-tracked files.

Yoke state should be per agent/profile and per workspace subscription. The exact
physical storage boundary between Wingmen and Yoke remains an implementation
detail to verify, but the healthcheck must prove that the new clone can connect,
read authorized state, decrypt visible records, and route without using another
agent's cached secrets.

## Implementation Phases

### Phase 1: Backend Connection And Agent Connect Import

Deliverables:

- add `BackendConnectionRecord` storage and API outside `src/server.ts`;
- extend `WorkspaceSubscriptionRecord` with `backendConnectionId` and import
  provenance fields;
- implement Agent Connect package validation and token consistency checks;
- create/reuse backend connections from package `service` data;
- keep legacy subscriptions readable and startable;
- show imported backend/subscription state in the setup UI.

Acceptance tests:

- valid Agent Connect package creates backend connection plus scoped
  subscription;
- package/token mismatch is rejected with a useful diagnostic;
- legacy subscriptions still start;
- two managers can import the same workspace without sharing replay or dedupe
  state;
- secrets are stored only through encrypted key/token storage.

### Phase 2: Subscription Health And Diagnostics

Deliverables:

- formalize latest diagnostic fields and recent bounded history;
- link backend health, subscription health, route decisions, and pipeline runs;
- expose duplicate and self-suppression decisions in the operator UI;
- add reconnect, refresh keys, and dry-run route actions.

Acceptance tests:

- group-key refresh failure marks only the affected subscription degraded;
- self-authored chat and duplicate messages are recorded as suppressions;
- SSE reconnect preserves per-subscription last event state;
- diagnostics identify record pull, decrypt, route, dispatch, and session
  failures separately.

### Phase 3: Chat And Task Pipeline MVP

Deliverables:

- add dispatch route storage, evaluator, input builder, runtime, and history
  modules under a dedicated agent-chat dispatch-pipeline area;
- generate default chat and task pipeline definitions;
- evaluate routes from normalized record envelopes;
- start `runDeclarativePipeline` with owner alias derived from `managedByNpub`;
- record `pipelineRunId` and any agent session ids in dispatch history;
- keep old prompt dispatch available behind legacy compatibility routes.

Acceptance tests:

- route matching handles group, record family, task state, assignment, and
  changed-field filters;
- input envelope contains stable `dispatch`, `workspace`, `agent`, `record`,
  `routing`, and `runtime` sections;
- active policy and dedupe behavior are deterministic;
- chat follow-ups queue according to policy;
- task dispatch uses `skip` when a matching run is already active.

### Phase 4: Flow, Review, Approval, And Comment Migration

Deliverables:

- add default routes and pipelines for `flow_dispatch`, `task_review`,
  `approval_dispatch`, and comments;
- preserve existing eligibility rules as deterministic preflight code steps;
- move current prompt contracts into generated default pipeline definitions;
- link flow/review/approval history to pipeline runs and board side effects.

Acceptance tests:

- flow kickoff matcher requires assigned bot, `state = new`, `flow_id != null`,
  and `flow_run_id == null`;
- task review matcher requires assigned bot, `state = review`, and
  `flow_run_id != null`;
- approval dispatch triggers on approved approval records with a flow run;
- comment dispatch does not run from invisible or self-authored comments;
- replay from recent history can run a selected route against a saved envelope
  with side effects disabled.

### Phase 5: `wm-fresh` Clone/Import/Healthcheck

Deliverables:

- define the template manifest;
- add clone/import command or script;
- generate identity outside git;
- create profile and subscription records;
- run Agent Connect import and healthcheck;
- document Yoke state directory convention.

Acceptance tests:

- cloned agent has a distinct bot identity;
- no private key, connection token, workspace-key blob, or group-key cache is
  written to git-tracked files;
- healthcheck fails clearly when backend, workspace key, group decrypt, record
  pull, or route evaluation fails;
- two clones can subscribe to the same workspace without sharing runtime state.

## Unsupported Or Deferred

- Exact billing behavior is not defined here. Keep attribution fields so it can
  be implemented later.
- Final Agent Connect version policy needs reconciliation across current Flight
  Deck references before it becomes a compatibility promise.
- Physical storage for subscription-scoped group-key cache should be verified in
  existing Wingmen/Yoke code before locking the boundary.
- Backend connection sharing policy may become richer than the MVP
  operator-managed model.
- A general route expression language is deferred. Use small `matchJson` plus
  optional pipeline preflight functions first.

## Open Questions

- Should backend connection sharing be limited to admins, or can ordinary users
  share a backend connection record they imported?
- How should the UI distinguish user-owned agents from shared service agents
  without making normal setup harder?
- Should dry-run dispatch create records in a test workspace/channel, or should
  it run against synthetic local route fixtures only?
- Which chat follow-up behavior is preferable for the first pipeline MVP:
  interrupt the active agent step, queue a second run, or merge turns into the
  active run's next input?
- Should dispatch route definitions stay in SQLite only, or become exportable
  JSON beside pipeline definitions later?

## Next Implementation Slice

Start with Agent Connect import plus backend connection records.

This slice is useful on its own because it gives Wingmen a stable setup contract
and gives later dispatch migration a concrete subscription envelope. It should
ship with package validation, backend health, scoped subscription creation,
legacy subscription compatibility, and tests proving that two users importing
the same workspace do not share secrets, replay state, or dispatch history.
