# Subscription Pickup: Shared Backend Onboarding

Status: pickup brief
Date: 2026-05-08

## Summary

The subscription-dispatch MVP now has backend connection records, availability
grants, Agent Connect imports, scoped subscriptions, local agent profiles, and
dispatch route wiring. A live two-user smoke check exposed one remaining setup
gap: a non-admin user who should be able to use an admin-managed backend
connection still sees the same "create connection" guided setup as if no shared
connection exists.

The target behavior is:

- one reusable backend connection per Tower/SuperBased host when an admin has
  made that connection available;
- one workspace subscription per user/agent profile, because each user still
  needs isolated manager ownership, bot identity, folder, route state, SSE/replay
  state, diagnostics, and dispatch history;
- a non-admin with an available backend connection should be guided to create
  their own subscription and local agent profile using that shared backend,
  without retyping the backend URL, workspace owner, or source app details.

## Observed Behavior

In a side-by-side browser check:

- admin user: existing subscription is shown as ready;
- non-admin user: no subscription is configured, and the setup page shows:
  - guided setup steps all marked "Needed";
  - "Shared Connection" says "No subscription is configured yet";
  - button copy says "Create Connection";
  - Agent Connect import is visible, but the page does not present an available
    admin-managed backend connection as a reusable setup option.

The admin subscription in the local DB is currently a legacy direct subscription:

```text
workspace_subscriptions.backend_connection_id = null
backend_base_url = https://sb4.otherstuff.studio
workspace_owner_npub = npub1jvj7txjsge62gmg7ar7kfu23zd95spw32nz5n0663eq4pzzyyjqsnlaz7e
source_app_npub = npub1hd37reqgfcnz3pvzj4grknd2nkzc94p9ercmunrxx22razr2rfxsw6dns5
bot_npub = npub1s4658awhcachmhzk5jhsg256gzdl7e4gh5a9zq8skjyt7g3k2axql224qz
```

That means there may be no `BackendConnectionRecord` for the non-admin to see
or use. Even when one exists, the current settings page only loads
`/api/agent-chat/subscriptions` and `/api/agent-chat/agents` for setup state; it
does not use `/api/agent-chat/backend-connections` to guide the no-subscription
path.

## Root Cause Hypothesis

There are two related issues:

1. Legacy direct subscriptions are not upgraded or mirrored into
   `BackendConnectionRecord` rows, so the existing admin setup cannot be shared
   through the new availability grant model.
2. The settings setup UI treats "no subscription for this viewer" as "no shared
   connection available", because it does not load available backend connections
   and does not provide a "use this shared connection" subscription creation
   path.

## Implementation Goals

Implement the narrow pickup needed to make the new shared-backend model testable
with a non-admin user.

### 1. Legacy Backend Connection Backfill

Provide a safe migration/backfill path for legacy direct subscriptions that have
`backend_connection_id = null`.

Acceptance:

- a legacy subscription can be converted or mirrored into a
  `BackendConnectionRecord` using its `managedByNpub`, `backendBaseUrl`, optional
  service identity if known, workspace owner, source app, and health data where
  practical;
- the legacy subscription is updated to reference the backend connection when
  safe, or the setup/API layer can otherwise expose a reusable backend record
  derived from it;
- the backfill is idempotent and does not duplicate backend rows for the same
  manager/backend/service tuple;
- no bot secret, connection token, workspace key, group key, or decrypted state
  is copied into backend records;
- tests cover idempotent backfill and legacy subscription compatibility.

Prefer an explicit store/runtime helper over ad hoc UI-only inference. If startup
migration is too broad for this pickup, add an operator-safe API/action that the
setup page can invoke and document the limitation.

### 2. Available Backend Setup UI

Update `/settings/agents` setup behavior so the no-subscription path checks for
available backend connections.

Acceptance:

- the setup state loads `/api/agent-chat/backend-connections` alongside
  subscriptions, agents, routes, and pipeline definitions;
- if the viewer has no subscription but has one or more available backend
  connections, the Guided Setup and Shared Connection cards show that a shared
  backend is available rather than telling the user to create a new connection;
- the user can create their own workspace subscription from an available backend
  connection without retyping backend URL, workspace owner, or source app if
  those values are known;
- the UI wording is clear that the shared backend is reused, while the user's
  subscription and local agent remain user-scoped;
- if no backend is available, the existing manual/Agent Connect path remains
  available.

### 3. API Shape For Reuse

Make sure the API returns enough information for the UI to build a subscription
from an available backend connection.

Acceptance:

- `GET /api/agent-chat/backend-connections` returns owned and explicitly granted
  backend records for the current viewer;
- the serialized backend connection includes safe setup fields needed by the UI,
  such as `backendConnectionId`, `backendBaseUrl`, `managedByNpub`,
  `sharePolicy`, health diagnostics, service NPUB, and any non-secret workspace
  setup hints available from the grant/import/backfill path;
- creating a subscription with a granted `backendConnectionId` succeeds only
  when the grant model allows it, and still rejects guessed/foreign IDs;
- selected-user and shared-service semantics remain explicit.

### 4. Validation

Run focused checks and tests. At minimum:

```bash
bun --check src/agent-chat/backend-connection-store.ts src/agent-chat/subscription-runtime.ts src/server/agent-chat-routes.ts src/ui/services/agent-chat.js src/ui/views/settings/agent-chat-section.js src/ui/views/settings/agent-chat-setup-cards.js
bun test src/agent-chat/backend-connection-store.test.ts src/agent-chat/subscription-runtime.test.ts src/server/agent-chat-routes.test.ts
```

If UI tests are available for settings cards, add or update focused coverage for
the "available backend, no subscription" state.

## Non-Goals

- Do not collapse all users into one shared workspace subscription.
- Do not share bot identities, bot secrets, Yoke state, group keys, replay
  cursors, dispatch history, or local agent folders across users.
- Do not remove the manual setup and Agent Connect import paths.
- Do not require final billing semantics.
- Do not push changes; leave commits local for review.

## Expected End State

After this pickup, a fair two-user test should look like this:

1. Admin has or creates one backend connection for the Tower/SuperBased host.
2. Admin grants availability to the non-admin user or explicit shared service
   agent.
3. Non-admin opens `/settings/agents` and sees that the shared backend is
   available.
4. Non-admin creates their own subscription and primary local agent profile from
   that shared backend without re-entering backend connection facts.
5. Both users have separate subscriptions, agents, route state, diagnostics, and
   dispatch history while reusing one managed backend connection.
