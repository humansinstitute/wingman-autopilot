# Agent Connect v6 importer compatibility

## Goal

Update Autopilot so an operator can copy the current Agent Connect token directly from Flight Deck and paste it into Autopilot to connect the workspace successfully.

Flight Deck task: `cd2c8fbc-1e8a-40bb-8b8e-0d9aee560ce0` — **Accept Flight Deck v6 Agent Connect tokens in Autopilot**.

Originating Flight Deck thread/message:

- workspace: `2e5caefd-dd65-45d2-b747-ee874e8e5fc9`
- channel: `6c89191a-69d6-460a-97d3-f937bd40cfeb`
- thread: `4daad68a-0ad9-4cc1-b3e3-1152298176a8`
- request message: `741be7a0-f658-443a-8b2f-c0e7f5bd2746`

## Confirmed failure

Pasting the current Flight Deck token into Athena Autopilot fails in the browser before import with:

> AgentConnect token is missing service.direct_https_url, workspace.owner_npub, app.app_npub, or connection_token.

The current Flight Deck exporter in `wm-fd-2/src/agent-connect.js` emits version 6 with:

- `kind: "coworker_agent_connect"`
- `version: 6`
- `protocol: "flightdeck_pg"`
- `service.direct_https_url`
- `auth.app_npub`
- `workspace_descriptor` using the current PG descriptor shape, including `identity.workspace_owner_npub`, `identity.workspace_id`, `identity.workspace_service_npub`, `identity.tower_service_npub`, and `identity.app_npub`
- no legacy `connection_token`

Autopilot currently rejects this in both layers:

- `src/ui/views/settings/agent-chat-connect-import-card.js` requires legacy `workspace.owner_npub`, `app.app_npub`, and `connection_token`.
- `src/agent-chat/agent-connect-import.ts` supports only version 5 and requires the same legacy shape/token.

The kind `33357` consumer also ultimately imports its embedded current Flight Deck package through this importer, so the compatibility change must work for both manual paste and verified Nostr onboarding.

## Required behavior

1. Accept untouched current Flight Deck version 6 `flightdeck_pg` packages.
2. Parse and normalize the PG workspace descriptor using the established descriptor contract rather than duplicating a loose, incompatible shape.
3. Take app identity from the current package (`auth.app_npub` and/or descriptor identity as appropriate) and require consistent values when both are present.
4. Do not require a legacy `connection_token` for v6. The package is a locator/descriptor; current access remains authoritative in Tower and must be verified with NIP-98 using the importing Autopilot/bot identity through the existing subscription verification path.
5. Preserve existing version 5 import compatibility and its connection-token consistency checks.
6. Update the browser-side preflight validation so it accepts the same shapes as the server importer and does not block valid v6 tokens.
7. Ensure kind `33357` onboarding can import its current embedded v6 package after Tower verification.
8. Reject malformed v6 packages with clear errors (missing Tower URL, workspace owner/id, app npub, or invalid descriptor identity).

## Tests and validation

Add or update tests for:

- a representative untouched version 6 token built in the same shape as `wm-fd-2/src/agent-connect.js`;
- browser paste/preflight acceptance of v6;
- server import normalization of v6 without `connection_token`;
- legacy version 5 acceptance and token consistency checks;
- malformed v6 rejection;
- the kind `33357` path importing a v6 package after successful Tower verification.

Run targeted Bun tests for the importer, settings UI, subscription runtime, and SBIP-0009 onboarding. Run the broader relevant test command if practical.

## Repo and Git rules

- Work in `/Users/mini/code/wingmanbefree/autopilot` on `main`.
- Preserve concurrent changes and inspect the full worktree before committing.
- Commit all nonignored tested state unless there is a clear safety reason to pause.
- Do not restart Autopilot or any managed app; Pete has not approved a restart.
- Report changed files, commit hash, tests, remaining limitations, and whether a restart/deploy will be required before Athena can use the fix.

## Reporting

Do not post directly to Flight Deck. Return the full implementation handoff through the supervised dispatch callback so Rick can review it, update the task, and reply in the originating thread.
