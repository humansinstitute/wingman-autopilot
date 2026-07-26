# Flight Deck PG agent routing and editor

## Goal

Make the current Flight Deck integration in Autopilot PG-native end to end. Tower groups and permission grants are authoritative. Operators should not set or edit legacy Nostr group bindings in Autopilot.

Flight Deck task: `b2f3a964-f373-4cb6-9c22-94f2434793f1`, now titled **Fix Athena PG routing and Edit Agent**.

Originating request: Pete's message `68925dd0-c901-490e-b291-0e56c7d30e8d` in workspace `2e5caefd-dd65-45d2-b747-ee874e8e5fc9`, channel `6c89191a-69d6-460a-97d3-f937bd40cfeb`, thread `4daad68a-0ad9-4cc1-b3e3-1152298176a8`.

Pete clarified the intended model:

- Flight Deck Autopilot uses PG groups and permissions only.
- Groups are managed in Tower and should not be manually configured in Autopilot.
- Remove legacy Agent Connect/group requirements from the current agent workflow.
- Edit Agent should configure a specific agent npub, working directory, harness (Codex, Claude, Goose, etc.), and behavior/capabilities/pipeline.

Interpret “remove legacy Agent Connect” as removing version 5 / legacy encrypted-group assumptions from the current Flight Deck agent path. Preserve the current version 6 `flightdeck_pg` Agent Connect onboarding/manual import because it is the PG connection package implemented in commits `3cd8bc6` and `5f3b874`.

## Confirmed current failure

Athena successfully imported a v6 kind `33357` workspace connection and Tower verifies it as a member with permissions. Autopilot created an enabled PG agent with chat/task/comment capabilities. However:

- the agent has `groupNpubs: []`;
- the PG subscription has no legacy `wrappedGroupKeysJson`;
- `src/agent-chat/routing-evaluator.ts` still requires `agent.groupNpubs` to intersect message group npubs;
- no intercept, dispatch, pipeline run, or Athena session is created;
- `src/agent-chat/subscription-runtime.ts::saveAgentForManager` still resolves legacy groups and rejects Edit Agent when none exist.

The diagnostic evidence is in the Flight Deck task comment dated 2026-07-26 03:21 UTC.

## Required product model

### Tower-owned access and routing eligibility

For a `flightdeck_pg` subscription:

- Tower workspace membership, scope/channel visibility, typed permissions and explicit message mentions are authoritative.
- Autopilot must not require or expose editable legacy `groupNpubs` or wrapped group keys.
- A PG agent is eligible only inside the workspace connection/profile it belongs to, and only where current Tower context indicates access.
- Routing must not broaden an agent to every channel merely because it has workspace membership. Use the typed event/message workspace, scope and channel identities plus the agent's PG subscription/profile binding and current Tower access result.
- Explicit mentions should select the intended agent npub where it has access.
- Channel participation/pipeline policy should use stable PG workspace/scope/channel identities, not group npubs.

### Agent-owned runtime configuration

The Edit Agent surface should allow the operator to configure:

- agent/bot npub identity (or clearly show the immutable identity if changing identity would create a different agent);
- label/profile name;
- harness/agent runtime such as Codex, Claude Code or Goose, using the existing available agent type registry;
- absolute working directory;
- capabilities, enabled state, pipeline/route/behavior policy and other runtime settings already supported.

It should not ask for Flight Deck groups. Saving a valid PG agent with no legacy group npubs must work.

## Implementation scope

Primary repo: `/Users/mini/code/wingmanbefree/autopilot`, branch `main`.

Investigate and update at least:

- `src/agent-chat/routing-evaluator.ts`
- `src/agent-chat/subscription-runtime.ts`
- agent profile/types/storage where PG workspace/scope/channel binding must be explicit
- `src/server/agent-chat-routes.ts`
- the Edit Agent UI and services under `src/ui/views/settings/` and `src/ui/services/agent-chat.js`
- relevant serialization so legacy group fields are not required/exposed for PG agents
- docs describing v6 PG Agent Connect and agent configuration

Remove or isolate obsolete v5/legacy group-based Agent Connect behavior only after checking current call sites and tests. Do not weaken Tower/NIP-98 verification. Do not remove v6 `flightdeck_pg` onboarding/manual import.

## Acceptance tests

1. A v6 PG-onboarded agent with empty `groupNpubs` is eligible for a message that explicitly mentions its npub in an accessible PG channel.
2. A PG agent is not eligible for a different workspace, inaccessible channel, or another agent's explicit mention.
3. Channel participation/pipeline routing works from stable PG workspace/scope/channel policy without legacy groups.
4. Edit Agent loads and saves a valid PG agent with no legacy groups.
5. Edit Agent persists harness, working directory, label, capabilities/pipeline/behavior settings correctly.
6. Current v6 manual Agent Connect import and kind `33357` onboarding remain green.
7. Legacy v5/group configuration is removed from the current UI/API path or cleanly isolated if a non-Flight-Deck compatibility path still requires it; document the decision.
8. Focused routing, subscription runtime, server route, UI and onboarding tests pass.

## Git and operational constraints

- Work directly on `main`.
- Preserve concurrent changes and inspect the full worktree before committing.
- Commit all nonignored tested state, including this handoff document.
- Do not restart local or remote Autopilot, deploy, push deployment branches, or modify Athena runtime state.
- Report commit hash, changed files, tests, architectural decisions, migration implications and the exact restart/deployment required for Athena.

## Reporting

Return the implementation handoff through the supervised dispatch callback. Do not post directly to Flight Deck. Rick will review the code and evidence, update the task, and reply in the originating thread.

## Implementation outcome

- PG subscriptions are identified by stable Tower workspace and workspace-service
  identities, covering both v6 manual import and kind `33357` onboarding.
- Tower-authenticated channel reads remain the access gate. Structured npub
  mentions select the intended bot; non-mention chat requires an explicit stable
  scope/channel pipeline override.
- PG agent saves no longer resolve or require legacy group npubs. Legacy v5
  encrypted-record subscriptions retain their existing derived-group behavior.
- Current agent and PG subscription API responses omit legacy group/wrapped-key
  fields. The settings editor exposes label, immutable binding identity, harness,
  absolute directory, capabilities, enabled state, and prompt behavior.
- No persisted-data migration is required. Existing PG agent rows with empty
  `group_npubs_json` become valid immediately after the updated server starts.
