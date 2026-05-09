# Wingmen Subscription Improvements

Status: final design direction
Last updated: 2026-05-06
Review pass: v6 feedback incorporated

## Summary

Wingmen should make agent-to-Flight-Deck setup feel like connecting a workspace
app, not like manually wiring several local services.

The current setup path conflates backend transport, workspace authorization, bot
identity, SSE state, dispatch routing, and session ownership. Those concerns
need to split into two layers:

- a Wingmen instance has reusable backend connection records for
  SuperBased/Tower hosts;
- Wingmen creates scoped subscription records that bind local agent profiles to
  workspace streams; the bot NPUB is a Flight Deck workspace user with explicit
  group access.

The admin setup surface should let an operator paste or import the Agent Connect
JSON from Flight Deck, then create or reuse the backend connection and provision
the workspace subscriptions that should be available on the Wingmen instance.

For the normal user path, the human is logged into Wingmen and Flight Deck with
the same user NPUB. Wingmen connects that user's default agent by its bot NPUB;
Flight Deck grants that bot group access as a normal workspace user. The bot does
not own the workspace and is separate from Tower's workspace creator/managed-by
metadata. Wingmen uses the bot keys to validate group visibility, refresh keys,
and subscribe to relevant group and user updates.

Dispatch should move from bespoke session prompt routing into a reusable
pipeline backbone. SSE events remain advisory wake-up signals; dispatch code
pulls the authoritative record, decrypts and normalizes it, evaluates routes,
starts a declarative pipeline, and records diagnostics that explain what
happened.

## Source Context

This design is based on Flight Deck thread
`97ae5c0d-f88c-41e7-9f7a-d64d27a4fd18` /
`3cc8e1dd-0e2c-4706-b92c-8ec5efa6348e`, local Agent Connect references,
`docs/dispatchpipeline.md`, and
`docs/design/flight-deck-flow-dispatch-contract.md`.

The thread asked how to improve setup for local agents like `wm21`, duplicate
that setup for agents such as CoWorker, support multiple users on one Wingmen
instance, and move dispatch from session-level agent work into pipelines.

## Review Feedback Addressed

The v6 comments are folded into the design here so they stay visible after line
anchors move.

| Feedback                                                     | Response                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| Admin imports Agent Connect JSON and chooses workspace availability. | Admin Connect Workspace creates/reuses the backend and makes the workspace available to selected users or an explicit shared service agent. |
| User's human NPUB already matches; default bot NPUB needs group access. | The user selects an Agent Profile; bot keys validate groups, refresh keys, and subscribe to group/user updates. |
| Do not confuse Wingmen `managedByNpub`, Tower metadata, workspace owner, source app, backend, and bot user. | `managedByNpub` is the Wingmen manager/operator. The bot NPUB is a Flight Deck workspace user, not the Tower owner/creator. |
| Agent Profile means folder, harness, inherited instructions/access, and encrypted bot secret. | Agent Profile is working directory, runtime harness, and Wingmen-managed bot identity/secret. |
| Move dispatch smarts out of hardcoded session dispatch.      | Dispatch routes normalized events to pipelines; pipeline steps own reuse, queue, merge, interrupt, and start decisions. |
| Setup UX needs admin/user screens, route selection, per-user folders, templates, and compact history. | Setup UX includes text mockups for admin connect, user setup, route templates, dry run, and recent dispatches. |

## Goals

- Configure a SuperBased/Tower host once per Wingmen instance.
- Let one Wingmen instance subscribe to multiple workspaces for multiple users.
- Keep workspace access user/agent-scoped by default.
- Allow shared service agents only when explicitly created as such.
- Make Agent Connect the setup surface for Flight Deck to Wingmen handoff.
- Let admins provision workspace subscriptions from pasted/imported Agent
  Connect JSON while keeping shared access explicit.
- Support the logged-in user's default Wingmen agent as the normal connection
  path: the human user NPUB matches across apps, and the bot NPUB is granted
  workspace group access in Flight Deck.
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
- Workspace subscriptions are Wingmen-side runtime records. `managedByNpub` is
  the Wingmen user/operator managing the local agent binding, not Tower's
  workspace owner or creator metadata.
- A subscription binds one Wingmen-managed agent profile to one workspace stream
  through one backend connection. The profile's `botNpub` is the workspace user
  that Flight Deck must add to the groups the agent should see.
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

A workspace subscription is Wingmen runtime state binding a local agent profile
to a Flight Deck workspace stream through a backend connection. Tower/Flight Deck
still owns workspace membership and permissions; the bot NPUB must be a workspace
user with the needed group access.

Target identity fields:

```text
backendConnectionId
managedByNpub      # Wingmen manager/operator for the local agent binding
agentProfileId
workspaceOwnerNpub # Tower/Flight Deck workspace owner/service namespace
sourceAppNpub
botNpub            # workspace user identity used by the agent
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

This is the Wingmen layer for runtime state, diagnostics, dispatch history, and
session attribution. Tower/Flight Deck remains authoritative for bot membership,
group permissions, and revocation.

### Agent Profile

An Agent Profile describes a runnable local Wingmen agent. In practice, an agent
is not only a bot NPUB. It is the combination of:

- a local working directory, such as `/Users/mini/wingmen/wingman21`, with notes, helper
  scripts, repo access, and instruction files;
- an agent harness/runtime launched in that directory, such as Codex, Claude
  Code, Goose, or another compatible runner;
- a Wingmen-managed bot identity, with bot NPUB plus encrypted NSEC, that can act
  as a Flight Deck workspace user once that bot has group access.

The folder matters because the runtime inherits local instructions from files
such as `AGENTS.md` or `CLAUDE.md`. Those files define working style, tools,
skills, and workspace focus. When a person logs into Wingmen with their user
NPUB, Wingmen attaches or generates the profile's bot secret, stores it
encrypted, and releases it only to the launched runtime in the form it can use.

Current `AgentDefinitionRecord` rows combine local agent data with workspace and
bot binding fields. The target model can keep that table compatible while
extracting reusable profile fields for new setup flows.

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
backendConnectionId + managedByNpub + agentProfileId + workspaceOwnerNpub + sourceAppNpub
```

`botNpub` is part of the referenced agent profile and runtime actor context, not
Tower workspace ownership. Bot identity rotation should be an explicit migration
or replacement subscription decision.

If a shared service agent is desired, it gets an explicit service-owned
`managedByNpub` or service-owner marker in Wingmen. Two normal users connecting
to the same Tower workspace get separate Wingmen subscription rows by default.

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
kind. A route chooses the pipeline for a normalized event; it should not contain
the old session-dispatch smarts.

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
without guessing required fields. The Wingmen admin/setup UI should accept this
package as pasted JSON or an imported file, validate it, then create or reuse the
backend connection and subscribe the selected agent or shared service profile to
the workspace. For the default user setup, the selected agent is the user's
existing default Wingmen bot identity rather than a new shared credential.

The package is versioned. Local references currently describe
`kind: coworker_agent_connect` and `version: 5`; related draft references may
name other versions. Wingmen should validate against an explicit supported
version policy rather than hardcoding one draft forever.

Target package fields:

- identity: `kind`, supported `version`, `generated_at`;
- service: direct HTTPS URL, service NPUB, optional OpenAPI/docs/health URLs, and
  relay hints;
- workspace: owner NPUB and optional owner pubkey;
- app: app NPUB and optional app pubkey;
- authorization: `connection_token`;
- optional setup hints: groups, capabilities, template repo, robots/llms URLs,
  and short operational notes.

Import validation:

- require `kind`, supported `version`, `generated_at`, `service.direct_https_url`,
  `workspace.owner_npub`, `app.app_npub`, and `connection_token`;
- parse `connection_token` and verify its backend URL, service identity,
  workspace owner, app identity, and relay hints are consistent with the outer
  package when both are present;
- create or reuse a `BackendConnectionRecord` from the `service` object;
- create a scoped `WorkspaceSubscriptionRecord` for the current Wingmen
  manager/operator and selected agent profile;
- verify the selected bot NPUB has Flight Deck group access before marking the
  subscription healthy;
- store secrets through existing encrypted key/token storage, not in route or
  pipeline definitions;
- run a dry healthcheck that validates backend health, bot identity auth,
  workspace-key registration, group-key refresh, record pull, decrypt, route
  evaluation, relevant group/user update subscription, and optional dry-run
  dispatch.

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

If two users on the same Wingmen instance connect agents to the same Tower
workspace, use separate Wingmen subscription rows by default. Each bot is still a
Flight Deck workspace user. Separate Wingmen rows keep:

- permissions tied to Flight Deck bot/group membership;
- audit tied to the actual bot actor;
- local session ownership attributable through Wingmen `managedByNpub`,
  `agentId`, and `botNpub`;
- revocation isolated;
- SSE replay and dedupe state independent.

If two operators intentionally use the same service agent, the UI should label
that agent as shared and show who can manage it. Shared service agents must not
be created accidentally by reusing a backend connection.

## Setup UX And Mockups

The setup UI has three jobs: admins connect workspace availability, each user
chooses their own Agent Profile, and routes select pipeline templates. Admin
setup must not silently bind every user to one shared bot.

```text
Admin / Connect Workspace

[ Paste/import Agent Connect JSON ]
Detected: backend, workspace owner, app namespace, package version
Availability: (x) selected Wingmen users  ( ) explicit shared service agent
Users: [ Pete ] [ Andy ]  Defaults: shared route templates
[ Validate package ] [ Check backend health ] [ Connect workspace ]
```

Admin validation shows package version, token consistency, backend health,
workspace owner, app NPUB, and which selected users still need their bot NPUB
added to a Flight Deck group.

```text
User / Workspace Agent Setup

Workspace: Pete workspace      Human NPUB: Pete Winn      Status: available
Agent: wm21
Folder: /Users/mini/wingmen/wingman21
Runtime: Codex                 Bot access: ok

Dispatch families:
[x] Chat messages       -> Chat Response v1
[x] Assigned tasks      -> Task Execution v1
[ ] Document comments   -> Comment Triage v1
[ ] Approvals           -> Approval Dispatch v1

Templates: (x) shared defaults  ( ) duplicate before editing
[ Dry-run dispatch ]  [ Save setup ]
```

Pete and Andy can share one Wingmen machine and Flight Deck workspace while
routing to different folders and bot identities. The folder determines inherited
instructions, skills, repo access, and runtime environment. The bot identity
determines the Flight Deck actor and group permissions. The pipeline template
determines orchestration.

```text
Route Template Library

Family            Template                Agent folder
Chat              Chat Response v1         /Users/mini/wingmen/wingman21
Task              Task Execution v1        /Users/mini/wingmen/wingman21
Document comment  Comment Triage v1        Not enabled

Template actions: [ Use ] [ Duplicate ] [ View policy ]
```

```text
Dry-run dispatch
Backend reachable: ok
Bot auth/group decrypt: ok
Route found: Chat -> Chat Response v1
Pipeline envelope: ok
Side effects: disabled
```

Recent Dispatches should be compact on the main screen and detailed only in a
drawer. The main table should show time, family, source, pipeline, result, and
agent profile. The drawer can show route id, concurrency key, dedupe reason,
pipeline run id, session ids, and the normalized envelope.

```text
Recent Dispatches

Time    Family   Source              Pipeline             Result    Agent
09:12   Chat     #general / thread   Chat Response v1     handled   wm21
09:18   Task     Agent Onboard       Task Execution v1    started   wm21
09:19   Chat     self-authored       Chat Response v1     skipped   wm21

[ Open details drawer ]
```

Shared service agents should be visually distinct from user-owned Agent
Profiles. A shared service agent needs an explicit owner/manager marker and a
visible list of users allowed to manage it. Reusing a backend connection must
never imply that several users are sharing one bot.

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
  -> run the selected dispatch pipeline
  -> pipeline decides reuse, queue, merge, or start behavior
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

The dispatch function boundary is intentionally thin. It should not decide
whether an existing chat/task/comment session should be reused, which context to
load into that session, or whether a follow-up should merge, queue, interrupt, or
start a new run. Those decisions move into the selected pipeline so they can be
iterated in pipeline definitions and deterministic pipeline functions rather than
hardcoded in Wingmen dispatch code.

Pipeline-owned active policy examples:

- chat pipeline: inspect active runs/sessions for the channel/thread/agent,
  decide whether to append context to the active session, queue a turn, or start
  a new session;
- task/review/approval/comment pipelines: inspect the current run and board state
  before choosing skip, queue, resume, or start behavior;
- all pipelines: record matched, suppressed, queued, started, resumed, and failed
  decisions in dispatch history.

## Dispatch Capabilities And Matchers

The route model should cover the current and planned capabilities without
hardcoding each capability as a separate session-dispatch path. The route selects
a pipeline; the pipeline owns capability-specific orchestration.

| Trigger    | Capability          | First matcher contract                                       |
| ---------- | ------------------- | ------------------------------------------------------------ |
| `chat`     | `chat_intercept`    | chat message record, visible to subscribed groups, not self-authored, route key by channel/thread/agent |
| `task`     | `task_dispatch`     | task assigned to bot with `state = ready`                    |
| `task`     | `flow_dispatch`     | task assigned to bot, `state = new`, `flow_id != null`, `flow_run_id == null` |
| `task`     | `task_review`       | task assigned to bot, `state = review`, `flow_run_id != null` |
| `approval` | `approval_dispatch` | approval record transitions to `approved`, `flow_run_id != null` |
| `comment`  | `comment_dispatch`  | document or task comment visible to subscribed groups and matched to a live or route-created destination |

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

`wm-fresh` should be the starter template for a new local Wingman. Clone into a
new working directory, read the manifest, generate a distinct bot identity
outside git, store the secret in Wingmen's encrypted key store, create the
`AgentProfile`, import Agent Connect, create/reuse backend and subscription
records, register workspace keys, refresh group keys, create default routes, and
run healthcheck plus dry-run dispatch.

Do not copy `.wingmen` or Yoke runtime state, local agent homes, private keys,
workspace-key blobs, group-key caches, or connection tokens into git-tracked
files. Yoke state should be per agent/profile and per workspace subscription, and
the healthcheck must prove the clone connects, decrypts visible records, and
routes without another agent's cached secrets.

## Implementation Phases

1. Backend Connection And Agent Connect Import: add backend records, extend
   workspace subscriptions, validate packages, create/reuse backend connections,
   keep legacy subscriptions readable, and prove two managers do not share
   secrets, replay state, or dispatch history.
2. Subscription Health And Diagnostics: link backend health, subscription
   health, route decisions, and pipeline runs, with isolated failures and clear
   pull/decrypt/route/dispatch/session diagnostics.
3. Chat And Task Pipeline MVP: add route storage/evaluation, stable input
   envelopes, default chat/task pipelines, dispatch history, deterministic
   dedupe, and legacy compatibility routes.
4. Flow, Review, Approval, And Comment Migration: move existing eligibility
   rules into deterministic preflight steps and route those capabilities through
   declarative pipelines.
5. `wm-fresh` Clone/Import/Healthcheck: create distinct bot identities,
   profiles, subscriptions, Agent Connect import, healthcheck, and isolated Yoke
   state without writing secrets or cached workspace state to git.

## Unsupported Or Deferred

- Billing behavior is deferred; keep attribution fields for later.
- Final Agent Connect version policy still needs reconciliation across current
  Flight Deck references.
- Subscription-scoped group-key storage and backend sharing policy should be
  verified against existing Wingmen/Yoke code before locking the boundary.
- A general route expression language is deferred; start with small
  `matchJson` plus optional pipeline preflight functions.

## Open Questions

- Who may share backend connection records: admins only or ordinary users too?
- How should the UI label user-owned agents versus explicit shared service
  agents without making normal setup harder?
- Should dry-run dispatch use synthetic local fixtures or a test workspace?
- Should first chat follow-up policy interrupt, queue, or merge into the active
  run?
- Should route definitions stay in SQLite only or become exportable JSON beside
  pipeline definitions?

## Next Implementation Slice

Start with Agent Connect import and backend connection records. This gives
Wingmen a stable setup contract and gives later dispatch migration a concrete
subscription envelope. Ship package validation, backend health, scoped
subscription creation, legacy subscription compatibility, and tests proving that
two users importing the same workspace do not share secrets, replay state, or
dispatch history.