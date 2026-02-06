# Redshift Secret Management Integration Plan

## Context

The ecosystem config generator was dumping all `.env` contents into plaintext `ecosystem.config.cjs` files. That immediate leak is patched (secrets now sourced at bash runtime), but `.env` files on disk remain a weak link. Redshift is a Nostr-native, self-hostable secret manager that encrypts secrets via NIP-59 Gift Wrap and stores them on configurable relays.

## Key Redshift Architecture Facts

- **Single-recipient encryption only** — `wrapSecrets(secrets, privateKey, dTag)` encrypts to one pubkey. No multi-recipient support in the current implementation.
- **NIP-46 bunker support** — `wrapSecretsWithSigner` / `unwrapGiftWrapWithSigner` exist, enabling remote signing via NIP-46 Nostr Connect.
- **TypeScript crypto package** — `@redshift/crypto` exports `wrapSecrets`, `unwrapSecrets`, `unwrapGiftWrap`, `createDTag`, `getRedshiftSecretsFilter`. Importable directly, no CLI dependency needed.
- **Secret storage** — Kind 30078 replaceable events on Nostr relays, keyed by d-tag (`project|environment`).
- **Relay configurable** — `redshift.yaml` has a `relays` field. Point at your own local relays, secrets never leave your infrastructure.
- **Auth methods** — nsec (direct key), bunker:// (NIP-46 remote signer), or `REDSHIFT_NSEC` / `REDSHIFT_BUNKER` env vars for CI/CD.

## The Identity Problem

Wingman doesn't hold user private keys — the browser has them (NIP-07 / device keystore). Redshift needs a private key to decrypt secrets. Three approaches:

### Option A: Wingman Server Key (Recommended for Phase 1)

User stores app secrets under the **Wingman server's pubkey** (derived from `KEYTELEPORT_PRIVKEY`). At app startup, Wingman decrypts with its own key. No browser needed.

- **Pro:** Simple, works offline, instant startup
- **Con:** User must target Wingman's pubkey when setting secrets, trusts server with plaintext at runtime
- **UX:** `redshift secrets set API_KEY xxx --identity <wingman-pubkey>` or Wingman UI wraps this

### Option B: Browser-Mediated Decrypt + Cache

When user starts an app, Wingman requests decryption via the existing Tier 2 SSE pipeline (browser signs). Decrypted secrets are cached in-memory (or encrypted in SQLite with server key) for the session lifetime.

- **Pro:** User's key stays in browser, no trust delegation
- **Con:** First start requires browser, adds latency, cache invalidation complexity
- **UX:** Transparent — browser auto-approves like Tier 2 NIP-98 signing

### Option C: NIP-46 Bunker Bridge

Wingman acts as a NIP-46 signer relay. User's browser is the bunker. Redshift crypto calls go through `unwrapGiftWrapWithSigner` which delegates signing to the browser.

- **Pro:** Uses Redshift's existing signer abstraction, most "Nostr-native"
- **Con:** Browser must be available, NIP-46 round-trips add latency, complex plumbing
- **UX:** User approves a "bunker connection" once, Wingman maintains the session

## Recommended Phased Approach

### Phase 1: CLI Integration (Quick Win)

**Goal:** Apps with `redshift.yaml` use `redshift run` instead of `source .env`.

**Changes:**
- `ecosystem-generator.ts` — detect `redshift.yaml` in app root
- If present, wrap start command: `redshift run -- <start script>` instead of `set -a; source .env; set +a; <start script>`
- Requires: Redshift CLI installed on host, user authenticated via `redshift login`
- Auth: Set `REDSHIFT_NSEC` from `KEYTELEPORT_PRIVKEY` so Wingman's server identity is used

**Files touched:**
- `src/agents/ecosystem-generator.ts` — command building logic
- `src/apps/app-detector.ts` — add `redshift.yaml` detection

**Effort:** Small. Mostly conditional logic in existing code.

### Phase 2: Native TypeScript Integration

**Goal:** Import `@redshift/crypto` directly. No CLI dependency. Wingman fetches and decrypts secrets programmatically.

**Changes:**
- Add `@redshift/crypto` as a dependency (or vendor the Gift Wrap functions since they use nostr-tools + @noble libs we already have)
- New module: `src/secrets/redshift-provider.ts`
  - Connects to configured relays
  - Fetches Gift Wrap events for project/environment
  - Decrypts with `KEYTELEPORT_PRIVKEY`
  - Returns `Record<string, string>` of secrets
- `src/secrets/secret-injector.ts` — orchestrates: check for redshift config, fetch secrets, merge with any local overrides, return env record
- `ecosystem-generator.ts` — calls secret injector, passes secrets as runtime env vars to the spawned process (in-memory only, never written to config file)
- New API route: `GET /api/apps/:id/secrets/status` — returns whether secrets are configured, last sync time, count (no values)

**Files touched:**
- `src/secrets/redshift-provider.ts` (new)
- `src/secrets/secret-injector.ts` (new)
- `src/agents/ecosystem-generator.ts`
- `src/apps/app-process-manager.ts`
- `package.json` (new dependency)

**Effort:** Medium. Core crypto is handled by the library, main work is relay connection management and wiring.

### Phase 3: User Secret Management UI

**Goal:** Users manage per-app secrets from the Wingman dashboard. No CLI needed.

**Changes:**
- **Secret editor UI** — per-app panel in the app card to add/edit/delete secrets
  - Key-value editor with masked values
  - Environment selector (dev/staging/prod)
  - "Sync to relays" button
- **Encryption flow:**
  1. User enters secret in browser
  2. Browser encrypts with user's NIP-07 key via `wrapSecrets` (runs client-side)
  3. Encrypted event posted to configured relays
  4. Separately, browser also wraps secrets to Wingman server pubkey (so server can decrypt at runtime without browser)
- **API routes:**
  - `POST /api/apps/:id/secrets` — store encrypted event (relay passthrough)
  - `GET /api/apps/:id/secrets` — fetch + decrypt with server key, return key names only (not values) for UI display
  - `POST /api/apps/:id/secrets/sync` — trigger re-encryption to server key (browser-mediated via Tier 2)
- **Per-app config** — store relay URLs and project/environment mapping in app registry

**Files touched:**
- `src/ui/apps/secret-editor.js` (new)
- `src/secrets/secrets-api.ts` (new)
- `src/apps/app-registry.ts` — extend AppRecord with relay config
- Existing app card UI

**Effort:** Large. Full feature with UI, API, and dual-encryption flow.

### Phase 4: Team Secret Sharing

**Goal:** Multiple Wingman users can share secrets for the same app.

**Changes:**
- Admin designates which users (by npub) can access an app's secrets
- When secrets are updated, they're re-wrapped to each authorized user's pubkey + server pubkey
- Each user can decrypt from their own identity
- Revocation: re-wrap without the revoked user's pubkey, publish new events

**This phase depends on upstream Redshift changes** — either multi-recipient Gift Wrap support or a Wingman-side wrapper that publishes multiple single-recipient wraps.

**Effort:** Large. Requires careful access control design.

## Configuration

### Per-App (`redshift.yaml` in app root)
```yaml
project: my-saas-app
environment: production
relays:
  - ws://localhost:7777
  - ws://relay.myinfra.lan:4848
```

### Wingman Server (`src/config.ts` or env)
```
KEYTELEPORT_PRIVKEY=<hex>          # existing — used as decrypt identity
REDSHIFT_DEFAULT_RELAYS=ws://localhost:7777  # fallback if app has no redshift.yaml
```

## Security Considerations

- Secrets are decrypted in-memory at app startup. They exist as plaintext in the process environment (same as Doppler, Infisical, or any env-based injection). This is unavoidable.
- `KEYTELEPORT_PRIVKEY` becomes a high-value target — it can decrypt all app secrets stored to the server pubkey. Protect it accordingly.
- Relay access control matters. Even though events are encrypted, a compromised relay could withhold events (denial of service). Use your own relays.
- NIP-59 Gift Wrap hides metadata (sender, recipient, timestamps) from relay operators. Even on your own relays, defense in depth.
- Never log decrypted secret values. The existing `log-sanitizer.ts` should be extended to catch common secret patterns.

## Open Questions

1. **Vendor or depend?** — `@redshift/crypto` uses nostr-tools + @noble libs we already have. Worth vendoring the Gift Wrap functions (~350 lines) to avoid version conflicts, or just add the dependency?
2. **Secret rotation UX** — when a user updates a secret, how do running apps pick it up? Restart required, or watch for relay events?
3. **Offline/relay-down fallback** — if relays are unreachable at app startup, should there be a local encrypted cache? What's the cache invalidation strategy?
4. **Redshift project maturity** — the project is young. We should evaluate stability before deep integration. Phase 1 (CLI wrapper) is low-risk regardless.
