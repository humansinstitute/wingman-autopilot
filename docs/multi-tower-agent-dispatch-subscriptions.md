# Multi-Tower Agent Dispatch Subscriptions

## Goal

Autopilot should let an operator connect one bot to more than one Wingman Tower workspace, keep each workspace subscription isolated, and dispatch chat/task/comment/pipeline work back to the exact source workspace that produced the event.

The first shipped UI should make it possible to add a secondary workspace subscription without replacing the existing one.

## Current Assessment

The backend already has most of the required model:

- `workspace_subscriptions` is scoped by `subscription_id`, backend connection, workspace owner, source app, bot, and manager.
- `backend_connections` supports more than one Tower connection.
- subscription runtime starts an SSE loop per subscription.
- dispatch routes are looked up by `subscriptionId`.
- dispatch pipeline event input includes `subscription`, `channelId`, `threadId`, `recordId`, and source payload.
- Flight Deck publisher code prepares a Yoke runtime from `eventInput.subscription`, so task updates, comments, and chat replies are published through the source workspace connection.

The important gap is chat session identity. `AgentChatRoutingEvaluator` builds the canonical routing key from workspace owner, source app, channel, thread, and agent id, but not `subscriptionId` or `backendBaseUrl`. That is fine for two distinct workspaces. It is not safe enough for two Towers that mirror the same workspace/source app/channel/thread ids, because chat session reuse could collide.

## Source Workspace Reply Behavior

Dispatch pipelines should reply to the source workspace today.

The path is:

1. An SSE advisory is processed in the context of one `WorkspaceSubscriptionRecord`.
2. `DispatchPipelineRuntime.dispatch()` lists routes for that `subscriptionId`.
3. The pipeline run input includes `eventInput.subscription`.
4. `prepareDispatchPipelineFlightDeckRuntime()` calls `prepareAgentWorkspaceYokeRuntime()` with that exact subscription.
5. Publisher functions such as chat reply, task update, task comment, and comment reply run Yoke commands against the subscription-specific Yoke state dir.
6. Chat replies use `eventInput.channelId` and `eventInput.threadId`.

So the intended behavior is source workspace in, source workspace out. The multi-tower hardening work is to make every session key, display affordance, and setup path preserve that invariant under duplicate IDs and multiple active subscriptions.

## Requirements

### Functional

- Operators can view all Agent Dispatch subscriptions, not only the first subscription.
- Operators can add a secondary subscription from AgentConnect import, an existing backend connection, or manual fields.
- Adding a subscription must not replace, disable, or mutate the primary subscription unless the operator explicitly edits that subscription.
- Each subscription shows Tower URL, workspace owner, source app, bot npub, health, SSE status, last event, candidate agents, and route status.
- Operators can create or select a local agent for the new workspace.
- Operators can enable capabilities per workspace: chat dispatch, task dispatch, comment dispatch, flow dispatch, task review, approval dispatch.
- Default dispatch routes are created per subscription based on the selected agent capabilities.
- Operators can edit dispatch routes per subscription.
- Operators can reconnect, refresh keys, disable, enable, or remove each subscription independently.
- Event logs, dispatch history, and active chat sessions are filterable or visually grouped by subscription.
- The UI warns when a second subscription points at the same workspace owner and source app on a different Tower until subscription-aware routing keys are deployed.

### Correctness

- Chat routing keys must include `subscriptionId`.
- Existing intercept records must keep working after migration.
- Deduplication keys for pipeline dispatch should include `subscriptionId` in addition to workspace/source app/record/version/route.
- Agent session metadata and logs should include `subscriptionId`, backend base URL, workspace owner, channel, and thread.
- All publish paths must use the event source subscription, never "first subscription" UI state.
- Agent definition selection must be scoped by workspace owner and bot npub. If the same physical bot serves two workspaces, each workspace still needs an eligible agent definition or an explicit shared-agent profile model.
- `agent_id` is currently globally unique. The UI should either generate unique ids per workspace, for example `wm21-rick` and `wm21-secondary`, or the backend should add a first-class `agent_profile_id`/workspace binding model before reusing one `agent_id`.

### Security And Isolation

- Connection tokens and workspace keys are stored per subscription/backend connection.
- A subscription may only be managed by its manager npub or the shared admin context.
- A shared backend connection can be reused only when a grant allows it.
- Disabling or removing one subscription does not remove agent definitions or routes for another subscription unless explicitly requested.
- Pipeline workers must receive source workspace context in the prompt/runtime payload so they do not infer reply targets from local default Yoke config.

## Backend Updates

### 1. Subscription-Aware Chat Routing Key

Update `buildCanonicalRoutingKey()` and all call sites to include `subscriptionId`.

Recommended v2 shape:

```txt
agent-chat:v2:<subscriptionId>:<workspaceOwnerNpub>:<sourceAppNpub>:<channelId>:<threadId>:<agentId>
```

Migration behavior:

- New intercepts use v2 keys.
- Existing v1 intercepts remain readable.
- When processing a new message, lookup should prefer v2 and only consult v1 for backward compatibility if the subscription id matches the stored row.
- Tests must cover two subscriptions with identical workspace/source app/channel/thread ids and prove they create different intercepts/sessions.

### 2. Dispatch Dedupe Key Hardening

Update `buildDedupeKey()` in `dispatch-pipelines/runtime.ts` to include `subscriptionId`.

Recommended shape:

```txt
<subscriptionId>:<workspaceOwnerNpub>:<sourceAppNpub>:<recordId>:<recordVersion>:<bindingId>:<routeId>
```

This prevents one Tower's record advisory from suppressing a matching advisory on another Tower.

### 3. Subscription-Centric API Payloads

Keep the existing endpoints, but make the UI consume them per subscription:

- `GET /api/agent-chat/subscriptions`
- `POST /api/agent-chat/subscriptions`
- `GET /api/agent-chat/subscriptions/:subscriptionId`
- `POST /api/agent-chat/subscriptions/:subscriptionId/actions/:action`
- `GET /api/agent-chat/dispatch-routes?subscriptionId=...`
- `POST /api/agent-chat/dispatch-routes`
- `POST /api/agent-chat/agent-connect/import`
- `POST /api/agent-chat/agents`

Add API coverage where it is missing:

- duplicate workspace/source app on separate backend connections is allowed.
- same backend/workspace/source app/bot remains idempotent.
- route CRUD is scoped to the requested subscription.
- subscriptions list serializes backend display info for every row, not just the first.

### 4. Agent Binding Model

MVP path:

- keep `agent_id` globally unique.
- generate a new agent id for secondary workspace setup.
- copy defaults from the primary agent when the operator chooses "clone local agent setup".

Future path:

- introduce `agent_profiles` for local runtime identity and `agent_workspace_bindings` for workspace/bot/capability routing.
- then one profile can be bound to multiple workspace subscriptions without duplicate agent ids.

The MVP is faster and lower risk.

### 5. Runtime Diagnostics

Extend diagnostics to expose:

- active SSE loop per subscription.
- last processed event per subscription.
- last pipeline run id per subscription.
- route count and enabled capability count per subscription.
- warning when routing key v1 rows still exist for a duplicated workspace/source app scope.

## UI Updates

### 1. Replace Primary-Only Setup State

`agent-chat-section.js` currently uses `subscriptions[0]` as `currentPrimarySubscription`, loads dispatch routes only for that subscription, and drives setup cards from the first subscription.

Change this to:

- maintain `selectedSubscriptionId`.
- default to the first subscription only when no explicit selection exists.
- load dispatch routes for the selected subscription.
- pass selected subscription into setup, agent, and route panels.
- render all subscription cards with a Select/Edit action.

### 2. Add Secondary Subscription Flow

Add a clear action in Agent Dispatch settings:

```txt
Add Workspace Subscription
```

The flow should support:

- paste AgentConnect package.
- choose an available backend connection.
- manual advanced fields: backend base URL, workspace owner npub, source app npub.
- choose bot identity: use existing bot where possible.
- choose agent setup: clone primary agent settings or create new local agent.
- choose capabilities.
- review and create subscription, agent, and default routes.

The UI should show a compact review before saving:

- Tower
- workspace owner
- source app
- bot npub
- agent id
- capabilities
- routes that will be created

### 3. Per-Subscription Route Management

The configured dispatch panel should be scoped to the selected subscription and label that scope clearly.

Required interactions:

- select subscription.
- create/edit route for selected subscription.
- show current pipeline definition per capability.
- show route enabled/disabled state.
- refresh route list after create/update.

### 4. Subscription Cards

Each subscription card should show:

- workspace label if available, otherwise shortened owner npub.
- backend base URL/Tower name.
- source app.
- bot npub.
- SSE and health status.
- candidate agent count.
- enabled route count.
- last event timestamp.
- last dispatch/pipeline status.

Actions:

- Select
- Edit Connection
- Refresh Keys
- Reconnect
- Disable/Enable
- Remove

### 5. Operator Safety Copy

Use concise UI labels, not long explanatory text. The important warnings are:

- "Same workspace/app on another Tower. Requires subscription-safe routing."
- "No eligible local agent for this workspace."
- "No dispatch routes enabled for this subscription."
- "Workspace keys need refresh."

## Deployment Plan

1. Add backend routing-key and dedupe-key hardening.
2. Add tests for two subscriptions with identical record identifiers.
3. Update Agent Dispatch UI state to support selected subscription instead of primary-only state.
4. Add Add Workspace Subscription flow.
5. Add per-subscription route management and diagnostics.
6. Run Autopilot tests.
7. Deploy/rebuild Autopilot.
8. Smoke test with current workspace subscription.
9. Add a secondary subscription from UI.
10. Send a test chat message in each workspace and verify replies land in the correct source thread.
11. Trigger task/comment dispatch in each workspace and verify updates land on the source records.

## Test Plan

Backend:

- `routing-evaluator.test.ts`: two subscriptions with identical channel/thread ids create separate v2 routing keys.
- `subscription-runtime.agent-work.test.ts`: dispatch route selection remains per subscription.
- `dispatch-pipelines/runtime` tests: dedupe includes subscription id.
- `flightdeck-publisher.test.ts`: publisher prepares Yoke runtime from event subscription.
- `agent-chat-routes.test.ts`: add secondary subscription without mutating existing subscription.

UI:

- Agent Dispatch settings renders all subscriptions.
- Selecting a subscription reloads routes for that subscription.
- Add Workspace Subscription creates subscription, agent, and default routes.
- Secondary subscription card actions call APIs with the selected subscription id.
- No UI path falls back to `subscriptions[0]` when a selected subscription exists.

Smoke:

- Current primary workspace still receives chat replies.
- Secondary workspace receives chat replies.
- Primary and secondary workspace messages with same thread id do not share a local session.
- Disabling secondary subscription does not affect primary SSE or dispatch routes.

## Acceptance Criteria

- A user can add a secondary workspace subscription from the Agent Dispatch UI.
- Both subscriptions can be connected at the same time.
- Each subscription has independent status, actions, routes, and diagnostics.
- Chat dispatch replies to the source channel/thread for both workspaces.
- Task/comment dispatch updates the source task/comment for both workspaces.
- Duplicate workspace/source app/channel/thread ids across two Towers do not collide.
- Existing single-subscription setups continue to work without manual migration.

## Non-Goals

- Building a full multi-tenant Tower admin console.
- Sharing one global `agent_id` across many workspace bindings in the MVP.
- Automatically migrating every old v1 chat session into v2 form.
- Cross-posting replies between workspaces.
- Treating `app_npub` as the workspace differentiator. Workspace identity remains `owner_npub`; app npub is the schema/source app namespace.
