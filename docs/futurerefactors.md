# Future Refactors

## Agent Dispatch Profile Workspace Cleanup

The Agents settings UI no longer exposes the older Profile Workspace Settings
panel or the configured capability/pipeline dispatch cards. Flight Deck
workspace connection status now belongs on `/settings/flightdeck`, while
`/settings/agents` keeps the active Agent Dispatch setup controls.

The UI removal is complete, but the related runtime and storage code should not
be deleted until the current dispatch path is confirmed to no longer depend on
it.

Older code elements to review:

- `src/agent-chat/agent-profile-policy-store.ts`
  - Stores profile workspaces, event policies, scope/channel pipeline overrides,
    and appended contexts.
  - Still has direct test coverage in `agent-profile-policy-store.test.ts`.
- `src/agent-chat/subscription-runtime.ts`
  - Creates and returns `profileWorkspace` bundles for subscriptions.
  - Saves profile workspace policy input via `saveProfileWorkspaceForManager`.
  - Seeds profile workspace data during AgentConnect and 33357 onboarding flows.
- `src/agent-chat/dispatch-pipelines/runtime.ts`
  - Reads profile runtime decisions to select pipelines and context while
    handling Flight Deck events.
  - Uses profile workspace policy data in dispatch decisions.
- `src/server/agent-chat-routes.ts`
  - Still exposes `/api/agent-chat/subscriptions/:id/profile-workspace`.
  - Serialises `profileWorkspace` data in subscription API responses.
- `src/ui/services/agent-chat.js`
  - Still contains client helpers for profile workspace reads/writes.
- `src/ui/views/settings/agent-chat-profile-workspace-card.js`
  - UI component is no longer mounted from the Agents tab and can be deleted
    after any remaining imports/tests are removed.
- `src/ui/views/settings/agent-chat-shared-ui.js`
  - `createConfiguredDispatchesPanel` and related capability route controls are
    no longer mounted from the Agents tab.
  - The component still has isolated tests and should be deleted only after the
    replacement Agent Dispatch state design is in place.
- `src/ui/services/agent-chat.js`
  - Dispatch route client helpers are no longer used by the Agents tab after the
    old capability/pipeline card removal, but may still be used by other
    settings or future redesign code.

Before removing the logic, confirm and/or migrate:

1. Current Flight Deck 33357 workspace onboarding does not need profile
   workspace event policies for routing decisions.
2. Dispatch route selection no longer depends on profile workspace
   `pipelineOverrides`, default event policies, or appended context.
3. Any replacement source for scope/channel visibility, context, and routing
   lives in the current Tower/Postgres/Yoke workspace model.
4. `/api/agent-chat/subscriptions` consumers do not rely on the
   `profileWorkspace` payload.
5. `/api/agent-chat/subscriptions/:id/profile-workspace` has no active UI,
   CLI, WApp, or automation consumers.
6. Default dispatch route seeding from AgentConnect capability defaults remains
   covered by the current dispatch route store, without profile workspace
   policy fallback.
7. Existing dispatch routes and pipeline definition selection have a replacement
   state surface, or the runtime no longer supports editing them locally.
8. Tests around `AgentProfilePolicyStore`, profile workspace serialization,
   configured dispatch cards, and profile-based dispatch decisions are either
   removed or rewritten around the replacement path.
9. SQLite migrations/tables can be left as inert historical data, or a deliberate
   data migration/drop plan is created for deployments that already have these
   tables.

Suggested cleanup order:

1. Remove dead UI component and client helper exports once no tests import them.
2. Stop serialising `profileWorkspace` in subscription list/detail responses.
3. Remove the profile workspace API route.
4. Remove profile policy reads from `DispatchPipelineRuntime`.
5. Remove profile workspace creation/save logic from `WorkspaceSubscriptionManager`.
6. Delete `AgentProfilePolicyStore` only after runtime tests prove dispatch
   still works from current workspace subscriptions and dispatch routes alone.
