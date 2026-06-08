# Autopilot 33357 Onboarding Consumer

Status: design draft
Last updated: 2026-06-08

## Purpose

Autopilot should be able to consume Flight Deck kind `33357` onboarding events
before the full Flight Deck publishing UI is complete.

The shared contract lives in:

```text
/Users/mini/code/wingmanbefree/wm-fd-2/docs/33357-onboard.md
```

Autopilot's role is to notice onboarding events addressed to an agent npub,
decrypt them, verify the current workspace state with Tower, import active
Agent Connect grants, and then hydrate the workspace context through Yoke/Tower.

## Semantic Model

Kind `33357` active grants mean:

> This agent npub has been onboarded to a Flight Deck-compatible app. Decrypt
> the payload, verify with Tower, then sync current workspace context.

It does not mean:

- trust the relay as an access grant;
- trust embedded scope/channel state;
- skip Tower verification;
- create dispatch routes before workspace import succeeds.

Tower remains the source of truth for access. Nostr is only the announcement
transport.

Kind `33357` revoked or deleted lifecycle messages are also advisory. Autopilot
must verify the current workspace state with Tower before changing local
connection state, suppressing workspace events, or refreshing its local
kind `33356` self-index equivalent.

## Event Filter

Autopilot should watch or poll configured relays for events matching:

```text
kind: 33357
#p: <agent pubkey>
#app_pub: <Flight Deck app pubkey>
#protocol: onboarding
```

The event content is encrypted to the agent pubkey from the `p` tag.

Events that fail tag validation, decrypt, JSON parse, payload validation, or
Tower verification should be recorded as diagnostics and ignored for import or
revocation.

## Payload Handling

After decrypting, Autopilot expects:

- `type: "flightdeck_onboarding"`
- `version: 1`
- `protocol: "onboarding"`
- `recipient_npub` matching the agent identity;
- `app.app_pubkey` matching the cleartext `app_pub` tag;
- `agent_connect.kind: "coworker_agent_connect"`;
- `agent_connect.version` supported by the existing import path;
- `agent_connect.connection_token`;
- `agent_connect.llms_url`;
- `service.direct_https_url`;
- `workspace.owner_npub`;
- `app.app_npub`.

Autopilot should reuse the current Agent Connect import validation rather than
creating a second workspace credential model.

The lifecycle `action` may be:

- `grant`: active onboarding. A missing action is treated as `grant` for
  compatibility with existing onboarding events.
- `revoked`: recipient workspace access was removed.
- `deleted`: workspace deletion. Autopilot normalizes this to a verified deleted
  local state after Tower confirmation.

Revoked or deleted lifecycle payloads do not need an Agent Connect package
because they must not create or update workspace credentials.

## Import Flow

Recommended flow:

1. Receive or poll `33357`.
2. Validate cleartext tags.
3. Decrypt content with the agent key.
4. Validate payload and expiration.
5. Verify Tower access with NIP-98.
6. Run Agent Connect import using the encrypted `agent_connect` package.
7. Create or update the backend connection/workspace subscription.
8. Create or update an Autopilot agent profile for this connection.
9. Sync the workspace through Yoke or the subscription runtime.
10. Fetch `llms_url` and store it as workspace guidance.
11. Mark the onboarding event handled by idempotency key.

The import must be idempotent. A repeated relay event should update or confirm
the same backend connection/subscription, not create duplicate workspaces.

## Revocation Flow

Recommended flow for `action: revoked` or `action: deleted`:

1. Receive or poll `33357`.
2. Validate cleartext tags and decrypt content with the agent key.
3. Validate the lifecycle payload and workspace identity.
4. Verify with Tower using the recipient's current NIP-98 identity.
5. Confirm revocation only when Tower reports deleted, not found, no membership,
   or denied access for that workspace.
6. If Tower still confirms access, keep the subscription active and record an
   unconfirmed revocation diagnostic.
7. If Tower confirms revocation, mark the local subscription/profile workspace
   `revoked` or `deleted`, disable SSE for that subscription, and ignore any
   stale events already in flight.
8. Refresh Autopilot's local kind `33356` self-index equivalent as a tombstone
   diagnostic with the source `33357` event id and Tower verification result.

A relay revocation by itself must not disconnect a workspace.

## Agent Profile Creation

When a new `33357` connection is accepted, Autopilot should create or update an
agent profile for the receiving agent identity.

The profile is the operator-facing place where Autopilot answers:

> I have access to this workspace. How should this agent behave there?

The profile should show the connected workspaces, for example:

```text
Profile: Leon
Workspaces:
- Wingman Be Free
- Other Stuff Ops
```

Each workspace row should link to a management screen for that workspace
subscription. This is separate from the raw backend connection. The backend
connection stores how to talk to Tower; the profile workspace settings store how
this agent should respond to work in that workspace.

Profile workspace settings should be per agent. Rick, Leon, and a software
development agent may all connect to the same Flight Deck workspace but need
different context, dispatch policies, and default pipelines.

## Workspace Management UI

Clicking a workspace from the profile should open a management view with:

- workspace title and Tower URL;
- workspace owner npub and app pubkey;
- connection health;
- Yoke/sync status;
- relay onboarding status;
- enabled event-handling policies;
- default pipeline selections;
- scope management.

The view should make the current defaults visible before the operator changes
anything. A fresh onboarding should not require detailed setup to be useful, but
it should be obvious how Autopilot will behave.

## Event Handling Policies

For each workspace, Autopilot should let the operator configure how the agent
handles common Flight Deck events.

Initial policy rows:

| Event | Default | Configurable Pipeline |
| --- | --- | --- |
| Direct message to agent | Respond | Yes |
| Chat mention | Respond | Yes |
| Chat message in joined channel, not mentioned | Ignore or observe | Yes |
| New document in visible scope/channel | Ignore or index | Yes |
| Tagged in document comment | Respond | Yes |
| New document comment, not tagged | Ignore or observe | Yes |
| Assigned task | Work or acknowledge | Yes |
| Comment on assigned task | Respond or update task | Yes |
| Approval assigned/requested | Notify or process | Yes |
| Flow step assigned | Run configured flow handler | Yes |

Each row should support:

- enabled/disabled;
- default action;
- selected pipeline definition;
- optional prompt/context override;
- quiet/observe mode where the event is indexed but does not create a reply;
- diagnostics for the last handled event.

This keeps onboarding separate from behaviour. The `33357` event tells Autopilot
that a workspace is available. The profile workspace settings decide what
Autopilot does with events from that workspace.

## Pipeline Overrides

Autopilot should support a global default pipeline and workspace-specific
overrides.

Recommended lookup order:

1. Explicit event policy pipeline.
2. Scope/channel override.
3. Workspace default pipeline.
4. Agent profile default pipeline.
5. Autopilot built-in default.

The UI should let an operator change the selected pipeline for any event policy
without editing code. Pipeline changes should apply to future events only unless
the operator explicitly replays an event.

## Context Hydration

Autopilot should fetch current context after Tower verification:

- groups the agent belongs to;
- visible scopes;
- visible channels;
- scope and channel descriptions;
- linked docs and workspace guidance;
- current task/chat/doc records allowed by Tower;
- dispatch route defaults if available in the Agent Connect package or Tower
  metadata.

This is the part that makes onboarding useful. When Pete later chats in an
Autopilot scope, the agent should already know that the channel is about the
Autopilot project because it synced the current Flight Deck scope/channel model.

Do not read scope/channel/group lists from the `33357` payload. Those must come
from Tower because they are live access-controlled records.

## Scope Management And Appended Context

The workspace management view should include a scope manager for every scope the
agent can see.

For each scope, the operator should be able to append agent-specific context.
This context is not a Flight Deck record grant. It is local Autopilot guidance
used when handling events inside that scope or its channels.

Example:

```text
Workspace: Wingman Be Free
Scope: Autopilot
Appended context:
Autopilot code repo is at ~/code/wingmanbefree/autopilot.
Use this repo when answering Autopilot / Design or Autopilot / Bugs questions.
```

If the agent receives a chat mention in:

```text
Autopilot / Design
Autopilot / Bugs
Autopilot / Pipelines
```

then the runtime should include:

- the live Flight Deck scope/channel context fetched from Tower;
- the workspace `llms.txt` guidance;
- the agent profile defaults;
- the local appended context for the Autopilot scope;
- any event-policy or pipeline-specific prompt context.

Appended context should be scoped and composable:

- workspace-level context applies to all events in the workspace;
- scope-level context applies to events in that scope and its channels;
- channel-level context applies only to that channel;
- event-policy context applies only to the matching event type.

This is especially important because context differs per agent. Rick may have
personal or strategic context. Leon may have general office context. A software
development agent may only need repo paths, test commands, and engineering
policies for specific scopes.

Appended context should be editable from Autopilot settings and should not be
published back to Flight Deck unless the operator explicitly creates a document
or record for it.

## Dispatch Route Binding

After import, Autopilot can map the synced workspace context to runtime
behaviour:

- default chat pipeline for unconfigured channels;
- custom chat pipeline per scope, group, channel, or record family where a
  route exists;
- task/comment/approval dispatch routes scoped to the workspace subscription;
- graph recall scoped by workspace, scope, channel, and agent policy.

The first implementation should only seed safe defaults. Custom route binding
can come after the onboarding import is reliable.

## Diagnostics

Autopilot should expose enough detail to debug onboarding without inspecting
relay traffic manually:

- last relay poll/check time;
- number of matching `33357` events;
- decrypt failures;
- invalid payload failures;
- expired payload count;
- Tower verification failures;
- imported/updated subscription id;
- Yoke sync status;
- `llms_url` fetch status;
- idempotency key for handled grants.
- unconfirmed revocation events where Tower still reports access;
- confirmed revoked/deleted workspaces hidden from the normal connection list;
- local self-index tombstone refresh state after confirmed removal.

Do not log decrypted connection tokens.

## Admin And Configuration

Autopilot needs configuration for:

- agent npub/private key used for decrypting onboarding events;
- relay URLs to check;
- accepted Flight Deck `app_pub` values;
- whether auto-import is enabled;
- whether imported workspaces should automatically enable default dispatch
  routes.

Auto-import should be opt-in until the flow is proven.

## Deferred Kind 33355

Kind `33355` is the deferred direct endpoint announcement. It is useful later
when Autopilot has an admin-configured public endpoint that Flight Deck apps can
ping directly for message/sync triggers instead of relying only on SSE.

For now, Autopilot should not depend on `33355`.

When implemented later:

- the endpoint URL must come from Autopilot admin options;
- endpoint details and capabilities must be encrypted to the Flight Deck app
  pubkey;
- cleartext should contain only a `p` tag for the Flight Deck app pubkey;
- direct endpoint calls must still verify NIP-98.
