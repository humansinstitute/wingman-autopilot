# Redshift Secret Management Integration Plan

## Context and Current State

Wingman previously generated `ecosystem.config.cjs` files that embedded all `.env` values in plaintext. That immediate leak has been patched: local `.env` values are sourced at bash runtime instead of serialized into the ecosystem config, and `createUserAppEcosystemConfig` already detects `redshift.yaml` and emits a `redshift run -- ...` command path for matching apps.

Redshift remains attractive because it is a Nostr-native, self-hostable secret manager that encrypts secrets via NIP-59 Gift Wrap and stores encrypted events on configurable relays. The integration goal is not just to call Redshift; it is to keep app secrets and Wingman root key material out of generated config, logs, routine API responses, and avoidable PM2 metadata.

## Non-Negotiable Decisions

1. `KEYTELEPORT_PRIVKEY` is not the Redshift decrypt identity for app secrets.
2. Wingman must not populate PM2 child environment with `KEYTELEPORT_PRIVKEY`, a derivative of it, or `REDSHIFT_NSEC` derived from it.
3. Phase 1 is hardening of the already-present `redshift run` path, not greenfield detection work.
4. Any fallback from Redshift to local `.env` must be explicit app-owner opt-in, logged, and tested; silent fallback is rejected.
5. Generated ecosystem config must not contain decrypted secrets, `.env` values, `KEYTELEPORT_PRIVKEY`, or root-key-equivalent Redshift credentials.

## Redshift Architecture Facts That Drive the Design

- **Single-recipient encryption only.** Current `wrapSecrets(secrets, privateKey, dTag)` behavior encrypts to one recipient. Team sharing can still be built with multiple single-recipient wraps, but only after Wingman defines event addressing, version matching, deletion, and revocation.
- **NIP-46 bunker support exists.** `wrapSecretsWithSigner` and `unwrapGiftWrapWithSigner` may enable remote signer flows, but the browser path must prove it supports the private-key decryption operations Redshift needs, not only event signing.
- **TypeScript crypto package exists.** `@redshift/crypto` exports `wrapSecrets`, `unwrapSecrets`, `unwrapGiftWrap`, `createDTag`, and `getRedshiftSecretsFilter`. Native integration can avoid the CLI, subject to dependency review.
- **Secret storage uses kind 30078 replaceable events keyed by d-tag.** Wingman must not use a bare human project name as the durable namespace in a multi-owner system. The canonical namespace should be `wingman:<owner_npub>:<app_id>:<environment>` or a stable hash of that tuple; the app registry stores the canonical namespace plus optional human aliases used for UI display or Redshift compatibility.
- **Relay configuration is app-specific.** `redshift.yaml` can define `relays`, but native/UI phases can also use app registry configuration.
- **CLI auth methods are host concerns.** Redshift supports direct key, bunker, and environment-based auth modes, but Wingman must verify how those modes behave for the actual PM2 runtime user before depending on them.

## Identity Model

### Phase 1 Identity: Host-Configured Redshift CLI Identity

Phase 1 uses whatever Redshift CLI identity is already configured for the runtime user that launches the app. Wingman does not inject Redshift private key material into the PM2 app environment. The Phase 1 contract is: if an app has `redshift.yaml`, generated startup uses `redshift run -- ...`; Redshift CLI is responsible for decrypting and injecting secrets according to its own configured identity.

The old idea of using the Wingman server pubkey derived from `KEYTELEPORT_PRIVKEY` is rejected for the default path. Any user-facing provisioning command such as `redshift secrets set API_KEY xxx --identity <runtime-pubkey>` is illustrative until verified against the actual Redshift CLI. If recipient targeting is not supported, users must pre-provision secrets with supported Redshift tooling or Wingman must provide a small wrapper/UI flow that publishes a runtime-recipient wrap.

### Phase 2+ Identity: Dedicated Wingman Redshift Runtime/App Key

Native integration uses a dedicated Redshift key, not `KEYTELEPORT_PRIVKEY`.

- Initial key name: `REDSHIFT_RUNTIME_NSEC` for one host-wide runtime identity, with a path to app-scoped keys later.
- Storage: host environment or a local secrets store owned by the Wingman runtime process, never serialized into app config or passed to PM2 child env.
- Public-key discovery: Flight Deck displays the runtime Redshift pubkey for each app/namespace so users can provision or verify wraps.
- Rotation: generate a new runtime key, publish new runtime-recipient wraps at a higher version, mark the old runtime pubkey deprecated, then retire it after all active namespaces have matching new wraps.
- Recovery: if the runtime key is lost and no user-authoritative wrap remains decryptable, secrets must be re-entered by an authorized user. Wingman should not imply it can recover plaintext from relays.

### Browser-Mediated Decrypt Is a Separate Research Track

Browser-mediated decrypt remains useful but is not the Phase 1 or Phase 2 default. It must first prove that the existing Tier 2 browser/SSE path can perform the NIP-44/NIP-59 decryption operations needed by Redshift, not just NIP-98/event signing. Persisting a browser-decrypted cache encrypted with a server-held key is not part of this option unless a separate threat model is accepted, because that would reintroduce server trust.

NIP-46 bunker bridging is also a research track. It may be the cleanest Nostr-native delegation model, but it requires connection management, browser availability handling, and latency/failure UX before it can sit on the app startup path.

## Configuration and Namespace Model

### Repo Configuration

`redshift.yaml` remains the Phase 1 opt-in signal because the current generator can observe it:

```yaml
project: my-saas-app
environment: production
relays:
  - ws://localhost:7777
  - ws://relay.myinfra.lan:4848
```

For native phases, the app registry stores a normalized secrets config:

```json
{
  "enabled": true,
  "environment": "production",
  "namespace": "wingman:<owner_npub>:<app_id>:production",
  "projectAlias": "my-saas-app",
  "relays": ["ws://localhost:7777"]
}
```

Precedence:

1. Explicit app registry secrets config.
2. Repo `redshift.yaml`.
3. Wingman environment defaults such as `REDSHIFT_DEFAULT_RELAYS`.
4. Redshift CLI config only for Phase 1 CLI execution, never as a silent override of registry settings.

Wingman server configuration should use dedicated Redshift names:

```dotenv
REDSHIFT_RUNTIME_NSEC=<hex-or-nsec>         # dedicated Redshift runtime identity, not KeyTeleport
REDSHIFT_DEFAULT_RELAYS=ws://localhost:7777 # fallback relay list for native/UI phases
REDSHIFT_ALLOW_ENV_FALLBACK=false           # default false; explicit opt-in only
```

## Phase 1: Harden Existing CLI Integration

**Goal:** Keep the existing `redshift.yaml` -> `redshift run -- ...` behavior, but make it safe, diagnosable, and tested.

Work items:

- In `src/agents/ecosystem-generator.ts`, quote every generated shell metadata value with the existing `shellQuote` helper. Add tests for spaces, apostrophes, quotes, semicolons, command substitution characters, and shell metacharacters in app labels, aliases, ids, and paths.
- Decide metadata scope deliberately. Preferred command shape is `redshift run -- env APP_ID=... APP_LABEL=... <start command>` so app metadata is visible to the child app but not to Redshift unless Redshift specifically needs it.
- Add preflight diagnostics for the same runtime user/environment that PM2 will use: `redshift` executable exists, `redshift.yaml` parses, working directory is correct, HOME/config path is the one Redshift will use, and the configured identity can access the target namespace.
- Remove any plan or code path that sets `REDSHIFT_NSEC` from `KEYTELEPORT_PRIVKEY` for child apps.
- Fail closed for Redshift-enabled apps by default. Missing CLI, unauthenticated CLI, relay timeout, malformed `redshift.yaml`, no matching event, and decryption failure must stop startup with actionable logs. Fallback to `.env` requires explicit app-owner opt-in.
- Add assertions that generated ecosystem config does not contain `.env` values, decrypted Redshift values, `KEYTELEPORT_PRIVKEY`, or any `REDSHIFT_NSEC` derived from it.

## Phase 2: Native Runtime Integration

**Goal:** Fetch and decrypt Redshift secrets in Wingman code without requiring the Redshift CLI, while keeping decrypted values and runtime private keys out of generated PM2 config.

Proposed modules:

- `src/secrets/redshift-provider.ts`: parse normalized config, connect to relays, fetch candidate events, select the accepted version, decrypt with the dedicated runtime key, and return a secret record.
- `src/secrets/secret-injector.ts`: prepare the app startup environment through a wrapper boundary, apply explicit override policy, register known secret values with redaction, and produce structured failure diagnostics.
- `src/secrets/redshift-runtime-key.ts`: load `REDSHIFT_RUNTIME_NSEC`, derive/display pubkey, validate key format, support rotation state, and reject `KEYTELEPORT_PRIVKEY` unless an explicit development/migration flag is set.

Relay fetch policy:

- Startup blocks on secret fetch for Redshift-enabled apps.
- Default timeout budget: short and bounded, for example 5 seconds total with per-relay deadlines. The exact values should be codified with config knobs.
- Retry transient relay/network errors within the budget, but do not retry decryption or authorization failures as transient.
- If multiple relays return events, choose the highest valid version for the expected namespace, recipient, and manifest hash. Relay disagreement is logged as a warning with event ids, not plaintext.
- Reject stale runtime-recipient wraps whose version/hash does not match the current user-authoritative manifest.
- Fail closed by default on timeout, no event, stale event, decrypt failure, or manifest mismatch.

Injection boundary:

- Preferred first native implementation is a wrapper process that fetches/decrypts immediately before `exec` and keeps secrets out of ecosystem `env`.
- The final application may still receive secrets as environment variables for compatibility. That residual exposure must be documented: same OS user, PM2 tooling, and process inspection may observe app env.
- Alternatives to evaluate before locking the first native implementation: stdin, inherited file descriptor, temporary file on tmpfs with strict permissions, and app-specific config handoff. Env remains acceptable only as an explicit compatibility tradeoff.

Local override policy:

- Local `.env` overrides are disabled by default for Redshift-enabled apps.
- If enabled, precedence is explicit and visible: app owner chooses either "Redshift wins" or "local override wins" per app/environment.
- Every local override startup emits an audit log entry with key names only, never values.
- Redshift failures cannot be masked by local overrides unless the app owner enables a separate "allow startup without Redshift" policy.

Status endpoint:

- `GET /api/apps/:id/secrets/status` is owner/app-authorized through the existing app API authorization path.
- Response fields are minimal: configured boolean, active namespace, relay health/error class, latest accepted event id/version/hash if known, and runtime pubkey fingerprint.
- Secret count is omitted unless product UX later proves it is needed.
- Persisted metadata lives in app registry secrets status or a dedicated secrets status table; it stores event ids, versions, hashes, timestamps, and error classes, never values.

## Phase 3: User Secret Management UI and API

**Goal:** Let authorized users manage per-app secrets from Flight Deck without relying on the Redshift CLI.

Browser flow:

1. User enters or edits secrets in the browser.
2. Browser produces the user-authoritative encrypted payload using the user's key.
3. Browser or Wingman publishes encrypted events only to configured/allowed relays.
4. Browser also produces a runtime-recipient wrap for the dedicated Wingman Redshift runtime/app pubkey, not the KeyTeleport pubkey.
5. Both user and runtime wraps carry the same logical `secretSetId`, namespace, environment, version, and content hash.

Deletion and stale-wrap handling:

- Whole-set replacement is preferred for v1 to avoid partial-delete ambiguity.
- Deletions produce a higher version/hash and, where needed, tombstone metadata.
- Wingman runtime only accepts a runtime-recipient wrap whose version/hash matches the user-authoritative manifest.

API boundaries:

- `POST /api/apps/:id/secrets/events` may act as a relay write helper, not a generic event proxy. It verifies owner/app authorization, expected namespace/d-tag, event kind, tags, recipient set, runtime pubkey, relay allowlist, payload size, and rate limits before publishing or forwarding.
- `GET /api/apps/:id/secrets/status` returns status only, not values.
- UI key-name display should prefer browser-side decrypt. If server-side key-name metadata is needed, cache only names keyed to a verified event hash/version and treat names as sensitive metadata. Routine dashboard reads must not decrypt full secret payloads on the server.

## Phase 4: Team Secret Sharing

**Goal:** Support multiple authorized users for one app secret set.

This phase has two independent design tracks:

- **Cryptographic distribution:** likely possible today with multiple single-recipient wraps if event addressing is defined. Candidate layouts are recipient-specific d-tags or a manifest event that references per-recipient wrap event ids.
- **Team authorization product design:** membership source of truth, who can add recipients, who can rotate runtime recipients, audit log, stale wrap cleanup, and revocation behavior.

Revocation means publishing a higher-version secret set re-wrapped to the remaining recipients and runtime pubkey. It cannot erase ciphertext already seen by a revoked user; it only prevents future updates from being decryptable by that user.

## Logging and Redaction Requirements

- Never log decrypted secret values.
- Native integration registers known decrypted values for exact redaction before starting app processes or serializing errors.
- Phase 1 CLI cannot know secret values, so it must avoid echoing Redshift output that may contain values and must apply generic token-pattern redaction to captured stdout/stderr and diagnostics.
- Extend `log-sanitizer.ts`; it currently strips ANSI/control characters and must gain tested secret redaction behavior.
- Tests cover known values, key names where appropriate, token-like strings, PM2 stdout/stderr capture, generated ecosystem files, and API error serialization.

## Acceptance Criteria

Phase 1 is complete when:

- Generated command snapshots show `redshift run -- ...` for `redshift.yaml` apps and no `.env` serialization.
- All app metadata shell values are quoted safely.
- CLI missing, unauthenticated CLI, wrong runtime HOME/config, malformed `redshift.yaml`, relay timeout, no matching event, and decryption failure produce actionable fail-closed diagnostics.
- No generated ecosystem config contains `.env` values, decrypted Redshift values, `KEYTELEPORT_PRIVKEY`, `REDSHIFT_NSEC` derived from it, or other root-key-equivalent material.
- Explicit `.env` fallback policy is covered by tests and is off by default.

Phase 2 is complete when:

- `KEYTELEPORT_PRIVKEY` is not accepted as the default runtime decrypt identity.
- Dedicated runtime key loading, pubkey display, and rotation metadata exist.
- Relay fetch has bounded timeout/retry behavior and deterministic version/hash selection.
- Runtime wrapper keeps decrypted values out of ecosystem `env`; any final app env exposure is documented and tested as the chosen compatibility boundary.
- Local override and startup-without-Redshift policies are explicit, audited, and covered by tests.

Phase 3 is complete when:

- Secret events are accepted only after owner/app authorization, namespace validation, expected recipient checks, kind/tag validation, relay allowlist checks, size limits, and rate limits.
- User and runtime wraps share `secretSetId`, version, and content hash.
- UI reads do not decrypt full server-side payloads merely to list names.
- Deletion and stale runtime wrap rejection are tested.

## Open Questions

1. **Dependency choice:** Add `@redshift/crypto` or vendor only the needed Gift Wrap functions?
2. **Runtime key scope:** Start with one `REDSHIFT_RUNTIME_NSEC` per host or generate app-scoped runtime keys immediately?
3. **Secret rotation UX:** Require app restart for new secrets first, or watch relay events and restart/reload apps automatically?
4. **Offline cache:** Should native integration support a local encrypted cache? If yes, what key encrypts it, what is the TTL, and can it ever start an app after relay failure?
5. **Browser decrypt:** Can the current Tier 2 browser/SSE path safely expose NIP-44/NIP-59 decrypt operations, or is NIP-46 the better delegation boundary?
6. **Team sharing layout:** Recipient-specific d-tags or manifest event with referenced per-recipient wrap event ids?
7. **Redshift CLI verification:** Which exact CLI commands support identity discovery, recipient targeting, config path inspection, and noninteractive preflight?
