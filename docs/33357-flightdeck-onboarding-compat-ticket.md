# Implementation Ticket: Align Autopilot 33357 Consumer With Flight Deck Onboarding

## Context

Flight Deck now has a working kind `33357` onboarding flow for browser users. The current Flight Deck event shape is intentionally simple:

- cleartext tags are only `p`, `app_pub`, and `protocol`
- all service, workspace, Agent Connect, and grant details are inside the encrypted NIP-44 payload
- the encrypted payload uses `type: "flightdeck_onboarding"`, `protocol: "onboarding"`, and `action: "grant"`
- the Agent Connect package is under `agent_connect`
- the grant id is under `grant.grant_id`
- there is no cleartext `d` tag and no cleartext `grant` tag

Autopilot still has older SBIP-0009 assumptions in its 33357 consumer. It can subscribe by recipient `#p`, but active grant decoding still requires top-level `grant_id`, top-level `dedupe_key`, and cleartext `d`/`grant` tags. This means an Autopilot bot added to a Flight Deck workspace may see and decrypt the current Flight Deck 33357 event, then reject it before importing the workspace.

## Goal

Bring Autopilot's 33357 onboarding consumer up to the same practical spec as the current working Flight Deck 33357 flow, so adding an Autopilot bot to a Flight Deck workspace can automatically verify and attach to that workspace.

## Workdir

`/Users/mini/code/wingmanbefree/autopilot`

Work on `main` unless the repo is already on another branch. Preserve concurrent work. Commit all nonignored tested state when complete. Do not restart Autopilot, Tower, or Flight Deck unless Pete explicitly asks in the current conversation.

## Required Behavior

### Grant Events

Autopilot must accept current Flight Deck 33357 grant events with:

- `kind: 33357`
- cleartext `p` tag matching the recipient bot pubkey
- cleartext `app_pub` tag matching `payload.app.app_pubkey`
- cleartext `protocol` tag equal to `onboarding`
- no cleartext `d` tag required
- no cleartext `grant` tag required
- no cleartext service/workspace tags required

The encrypted payload is authoritative for:

- `recipient_npub`
- `issued_by_npub`
- `app.app_npub`
- `app.app_pubkey`
- `service.direct_https_url`
- `service.service_npub`
- `service.openapi_url`
- `service.docs_url`
- `service.health_url`
- `workspace.owner_npub`
- `workspace.workspace_service_npub`
- `workspace.workspace_id`
- `workspace.app_npub`
- `workspace.label`
- `workspace.descriptor_url`
- `workspace.me_url`
- `agent_connect`
- `grant.grant_id`

Normalize `agent_connect` internally to the existing `agent_connect_package` field if existing downstream code expects that name.

Normalize `grant.grant_id` internally to `grant_id` if existing downstream code expects that name.

Derive an internal idempotency/dedupe key from service npub, workspace service npub, app npub, and recipient npub. Do not require Flight Deck to publish this as a cleartext `d` tag or encrypted top-level `dedupe_key`.

Do not require the older `sha256:<hash>` grant id shape. Flight Deck currently uses `fd-onboard:<hash>`. Treat the grant id as a payload identifier and use the derived dedupe key for idempotency.

### Verification

After decrypting and normalizing a grant event, Autopilot must verify the workspace with Tower before importing:

- descriptor exists
- Tower confirms the recipient currently has access
- descriptor app npub matches the payload app npub
- workspace/service identity matches the payload where Tower exposes it
- workspace is not deleted or revoked

Only after successful Tower verification should Autopilot import `payload.agent_connect` and create or update local subscription/profile state with `onboardingSource: "nostr_33357"`.

### Runtime Conditions

The listener should continue subscribing by recipient `#p`, not by relay-specific unindexed custom tags. App validation should happen client-side after decrypting the payload.

Autopilot must subscribe using the bot identity that receives the grant. If a bot key is unlocked after startup, the existing unlocked-key hook should subscribe that bot for 33357 onboarding events.

### Revoked Or Deleted Events

Keep the existing revoked/deleted semantics aligned with the simplified payload shape:

- no cleartext `d`/`grant` tags required
- verify with Tower before marking local state deleted/revoked
- if Tower still confirms access, keep the connection active and record diagnostics only
- if Tower confirms deletion or lost access, update local connection/profile state and trigger the 33356/self-index refresh behavior already implemented

### UI Outcome

The Autopilot Settings > Flight Deck tab should show only explicit workspace connections imported from verified `nostr_33357` onboarding. Successfully imported bot workspace connections should be visible there.

## Suggested Files To Inspect

- `src/nostr/access-grant-listener.ts`
- `src/access-grants/sbip0009.ts`
- `src/access-grants/sbip0009.test.ts`
- `src/agent-chat/subscription-runtime.ts`
- `src/agent-chat/subscription-runtime.test.ts`
- `src/ui/views/settings/flight-deck-section.js`
- `docs/33357-onboard-consumer.md`
- Flight Deck producer reference: `/Users/mini/code/wingmanbefree/wm-fd-2/src/nostr-onboarding-announcements.js`
- Flight Deck tests: `/Users/mini/code/wingmanbefree/wm-fd-2/tests/nostr-onboarding-announcements.test.js`

## Acceptance Tests

Add focused tests proving:

1. Autopilot accepts and imports a current Flight Deck 33357 grant event that has only `p`, `app_pub`, and `protocol` cleartext tags.
2. The same event does not require top-level `grant_id`, top-level `dedupe_key`, cleartext `d`, or cleartext `grant`.
3. `payload.agent_connect` is imported successfully as the Agent Connect package.
4. `payload.grant.grant_id` is accepted and does not need to match the old `sha256:<hash>` format.
5. Duplicate relay delivery is idempotent using an internally derived dedupe key.
6. Mismatched `app_pub`, recipient, service, workspace, or Tower descriptor identity is rejected.
7. Confirmed revoked/deleted events using the simplified payload shape still mark local state deleted/revoked and trigger self-index refresh.
8. Unconfirmed revoked/deleted events remain diagnostic-only and do not disable an active workspace.
9. Existing older-compatible tests still pass unless they conflict with the new documented Flight Deck spec.

Run targeted tests at minimum:

```bash
bun test src/access-grants/sbip0009.test.ts src/nostr/access-grant-listener.test.ts src/agent-chat/subscription-runtime.test.ts
```

Run broader validation when practical:

```bash
bun test
```

If full-suite failures are unrelated and pre-existing, report them clearly with the failing test name.

## Completion Criteria

- Autopilot consumes the current Flight Deck 33357 grant shape.
- Bot workspace import is Tower-verified before local attach.
- Revocation/delete handling still verifies before local removal.
- Tests cover grant, duplicate import, mismatches, confirmed revocation, and unconfirmed revocation.
- `docs/33357-onboard-consumer.md` reflects the final consumer semantics.
- The repo has a clean or intentionally explained git state.
- Changes are committed on `main` with a clear commit message.
