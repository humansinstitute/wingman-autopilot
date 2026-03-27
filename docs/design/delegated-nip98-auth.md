# Delegated NIP-98 Authentication for CLI-Accessed APIs

## Problem Statement

Wingman's API surface has an inconsistent authentication model for CLI callers. The system supports two NIP-98 signing identities — the workspace owner's npub (direct) and their bot pubkey (delegated) — but route-level authorization treats them differently:

1. **`/api/delegate-sessions/*`** — Requires `delegatedByBot === true`, meaning _only_ the bot key can access these routes. The owner signing directly with their own nsec is rejected with `403: delegated-bot-auth-required`.

2. **`/api/sessions/*`** — Accepts both owner and bot NIP-98, but the `DELETE` route has a guard: non-session, non-bot callers can only stop sessions with `metadata.AGENT=true`. An owner signing directly via NIP-98 cannot stop a non-agent session they own.

3. **`/api/sessions` POST** — Sets `metadata.AGENT` based on `isDelegatedBotAuth()`. If the owner signs directly, the session is created with `AGENT: false` even when they intend CLI/programmatic management.

4. **No unified "known caller" concept** — The auth layer resolves _who_ is calling but each route independently decides what callers are allowed. There is no shared vocabulary for "this caller is a trusted identity of this workspace" that routes can query.

The net effect: CLI tools that use the owner's nsec directly (e.g. `clis/sessions.ts --key $NSEC`) and CLI tools that use the bot key (e.g. `clis/delegate-sessions.ts`) operate under different permission regimes against largely equivalent API functionality. This forces users to choose the right CLI and the right key for each operation, and forces new routes to re-derive authorization logic.

## Root Cause Analysis

The current `isDelegatedBotAuth()` check conflates two concerns:

```
isDelegatedBotAuth = authMethod === "nip98" && delegatedByBot && npub && actorNpub
```

- **Identity resolution**: "Who is this caller, and do they map to a workspace owner?" — handled well by `resolveNip98AuthContext()`.
- **Caller trust level**: "Is this caller allowed to perform programmatic/agent operations?" — currently inferred from `delegatedByBot`, which is really just "did the signer happen to be a bot key".

The owner signing directly with NIP-98 produces `{ npub: owner, actorNpub: owner, delegatedByBot: false }` — a fully authenticated workspace owner, but one that fails `isDelegatedBotAuth()`. This is a false negative: the owner _is_ trusted, they just didn't use their bot key.

## Proposed Solution

### Core Concept: `isAuthorizedCaller`

Replace the scattered `isDelegatedBotAuth()` checks with a unified authorization predicate that recognizes all trusted callers:

```typescript
function isAuthorizedCaller(authContext: RequestAuthContext): boolean {
  // Has a browser session — always trusted
  if (authContext.session) return true;

  // NIP-98 with resolved identity (either owner direct or bot-delegated)
  if (authContext.authMethod === "nip98" && authContext.npub) return true;

  return false;
}
```

And a narrower predicate for when we specifically need to know the call is programmatic (no browser session):

```typescript
function isProgrammaticCaller(authContext: RequestAuthContext): boolean {
  return authContext.authMethod === "nip98" && !!authContext.npub;
}
```

### Changes by Route Group

#### 1. `/api/delegate-sessions/*` — Accept owner NIP-98

**Current**: `isDelegatedBotAuth(authContext)` gate on every handler.

**Proposed**: Replace with `isProgrammaticCaller(authContext)`.

The delegate-sessions API is designed for programmatic session management. Both the bot key and the owner's nsec should work. The route already resolves `authContext.npub` to the correct owner via `resolveNip98AuthContext()`, so ownership scoping is already correct.

```diff
- if (!isDelegatedBotAuth(authContext)) {
-   return Response.json({ error: "delegated-bot-auth-required" }, { status: 403 });
- }
+ if (!isProgrammaticCaller(authContext)) {
+   return Response.json({ error: "nip98-auth-required" }, { status: 403 });
+ }
```

**Impact**: `delegate-sessions.ts` CLI works with either `--key $OWNER_NSEC` or `--key $BOT_NSEC`.

#### 2. `/api/sessions` POST — Correct `metadata.AGENT` assignment

**Current**: `{ AGENT: isDelegatedBotAuth(authContext) }` — only true for bot-signed requests.

**Proposed**: Two options.

**Option A (recommended)**: Let the caller declare intent via the request body.

```typescript
const isAgent = payload?.metadata?.AGENT === true || isDelegatedBotAuth(authContext);
{ AGENT: isAgent }
```

This preserves backwards compatibility (bot-signed requests always get `AGENT: true`) while letting owner-signed CLI callers opt in. The delegate-sessions POST already hardcodes `AGENT: true` so no change needed there.

**Option B**: Infer from auth method — any NIP-98 caller gets `AGENT: true`.

```typescript
{ AGENT: isProgrammaticCaller(authContext) }
```

This is simpler but may be too broad. A user might use NIP-98 from the CLI to create a session they intend to manage from the browser later. Option A is safer because it's explicit.

#### 3. `/api/sessions/:id` DELETE — Unify stop permission

**Current guard** (line 689):
```typescript
if (!authContext.session && !isDelegatedBotAuth(authContext) && !isAgentManagedByMetadataOrOrigin(...)) {
  return 403;
}
```

This means: browser can stop anything, bot can stop anything it owns, but owner-NIP-98 can only stop agent-managed sessions.

**Proposed**:
```typescript
if (!isAuthorizedCaller(authContext) && !isAgentManagedByMetadataOrOrigin(...)) {
  return 403;
}
```

An authenticated owner (whether via session cookie, direct NIP-98, or bot NIP-98) should be able to stop any session they own. The ownership check (`resolveOwnedLiveSession`) already restricts visibility to owned sessions.

#### 4. `buildDelegatedBotOrigin` — Preserve audit trail

When the owner signs directly, `actorNpub === npub` (no delegation). The origin should reflect this:

```typescript
function buildProgrammaticOrigin(authContext: RequestAuthContext): SessionOrigin {
  if (authContext.delegatedByBot) {
    return { type: "delegate-bot", id: authContext.actorNpub, label: authContext.actorNpub };
  }
  return { type: "cli", id: authContext.npub, label: authContext.npub };
}
```

This preserves the audit distinction between "bot created this" and "owner created this via CLI" without affecting authorization.

## Data Model Changes

### `RequestAuthContext` — No schema changes needed

The existing fields are sufficient:
- `npub` — effective owner identity (already resolved for bot keys)
- `actorNpub` — actual signer (owner or bot)
- `delegatedByBot` — whether the signer was a bot key
- `authMethod` — "session" | "nip98"

### `SessionOrigin` — Add `"cli"` type

```typescript
type SessionOriginType = "user" | "delegate-bot" | "cli" | "scheduler" | "nostr" | ...;
```

New origin type `"cli"` for owner-signed programmatic session creation, distinct from `"delegate-bot"`.

### `SessionMetadata` — No schema changes

`AGENT` field semantics remain: `true` means "this session is managed programmatically and can be stopped by non-browser callers without the agent-managed check". The change is _how_ it gets set, not what it means.

## API Contract Changes

### Before

| Route | Owner NIP-98 | Bot NIP-98 | Browser Session |
|-------|-------------|-----------|-----------------|
| `GET /api/delegate-sessions` | 403 | 200 | N/A (not used) |
| `POST /api/delegate-sessions` | 403 | 201 | N/A |
| `DELETE /api/delegate-sessions/:id` | 403 | 200 | N/A |
| `POST /api/sessions` | 201 (AGENT=false) | 201 (AGENT=true) | 201 (AGENT=false) |
| `DELETE /api/sessions/:id` | 403 (if !AGENT) | 200 | 200 |

### After

| Route | Owner NIP-98 | Bot NIP-98 | Browser Session |
|-------|-------------|-----------|-----------------|
| `GET /api/delegate-sessions` | 200 | 200 | N/A |
| `POST /api/delegate-sessions` | 201 (AGENT=true) | 201 (AGENT=true) | N/A |
| `DELETE /api/delegate-sessions/:id` | 200 | 200 | N/A |
| `POST /api/sessions` | 201 (AGENT=caller choice) | 201 (AGENT=true) | 201 (AGENT=false) |
| `DELETE /api/sessions/:id` | 200 | 200 | 200 |

## Component Interactions

```
┌──────────────┐   NIP-98 (owner nsec)   ┌─────────────────────┐
│  CLI Tools   │ ───────────────────────► │ resolveNip98Auth()  │
│  sessions.ts │                          │                     │
│  delegate-   │   NIP-98 (bot nsec)      │ • verify signature  │
│  sessions.ts │ ───────────────────────► │ • map bot→owner     │
└──────────────┘                          │ • set delegatedByBot│
                                          └────────┬────────────┘
                                                   │
                                          RequestAuthContext
                                          { npub, actorNpub,
                                            delegatedByBot,
                                            authMethod }
                                                   │
                              ┌─────────────────────┼─────────────────────┐
                              ▼                     ▼                     ▼
                    isAuthorizedCaller()   isProgrammaticCaller()  isDelegatedBotAuth()
                    (any trusted caller)   (NIP-98 callers only)   (bot key only, kept
                                                                    for audit/origin)
                              │                     │
                    ┌─────────┴────────┐   ┌────────┴─────────┐
                    │ DELETE sessions   │   │ delegate-sessions │
                    │ (stop permission) │   │ (all routes)      │
                    └──────────────────┘   └──────────────────┘
```

## Implementation Plan

### Phase 1: Add shared predicates (non-breaking)

1. Add `isAuthorizedCaller()` and `isProgrammaticCaller()` to `session-api-routes.ts` alongside existing `isDelegatedBotAuth()`.
2. Keep `isDelegatedBotAuth()` — it's still useful for origin tagging and backward-compatible bot detection.
3. Add `"cli"` to the `SessionOrigin` type union.

### Phase 2: Update route guards

4. Replace `isDelegatedBotAuth()` gate on `/api/delegate-sessions/*` routes with `isProgrammaticCaller()`.
5. Update DELETE `/api/sessions/:id` guard to use `isAuthorizedCaller()`.
6. Update `buildDelegatedBotOrigin()` → `buildProgrammaticOrigin()` to emit correct origin type.

### Phase 3: Session creation metadata

7. Update `/api/sessions` POST to accept `metadata.AGENT` from the request body (Option A).
8. Update `/api/delegate-sessions` POST origin to use `buildProgrammaticOrigin()`.

### Phase 4: CLI unification (optional, future)

9. Consider merging `delegate-sessions.ts` and `sessions.ts` CLIs since the auth distinction is gone.
10. Or keep them separate for UX clarity (delegate = "I'm acting as a bot manager" vs sessions = "I'm managing my own sessions").

## Edge Cases

### 1. Owner has no bot key yet
Owner signs with their nsec directly. `resolveNip98AuthContext()` finds no bot record → `delegatedByBot: false`, `npub: owner`. With the new predicates, this works everywhere. No bot key creation needed for CLI access.

### 2. Multiple owners on same Wingman instance
Each owner's NIP-98 resolves to their own npub. Session ownership scoping (`sessionBelongsToViewer`) already prevents cross-owner access. No change needed.

### 3. Revoked/rotated bot key
If a bot key is deactivated, NIP-98 signed by the old bot key will fail `lookupBotOwnerNpub()` (returns null) → `delegatedByBot: false`, `npub: old_bot_npub`. This is correct: the old bot is no longer recognized. The owner can still use their nsec directly.

### 4. Admin npub via NIP-98
Admin detection currently checks `viewerNormalizedNpub === adminNpub`. This already works for both direct owner NIP-98 and bot-delegated NIP-98 (since `npub` resolves to the owner in both cases). No change needed.

### 5. `stop-self` from within a session
The `stop-self` command in `sessions.ts` uses `--bot-crypto` to sign via the server's bot key. This produces `delegatedByBot: true`, which satisfies both old and new predicates. No regression.

### 6. Session created via browser, stopped via CLI
Currently fails if the session has `AGENT: false`. With `isAuthorizedCaller()` on the DELETE route, owner-NIP-98 can stop it. This is the correct behavior — the owner should be able to stop their own sessions regardless of how they were created.

## Open Questions

1. **Should `/api/delegate-sessions` accept browser session auth?** Currently it's programmatic-only. There's no strong reason to exclude browser callers, but the UI doesn't use these routes today. Recommend: keep `isProgrammaticCaller()` for now, relax later if needed.

2. **Should we rename `delegate-sessions` routes?** The name implies bot delegation, but with owner nsec also accepted, it's really "programmatic session management". A rename to `/api/managed-sessions` would be clearer but is a breaking change. Recommend: keep the name, update docs.

3. **Should `isDelegatedBotAuth()` be removed entirely?** It's still useful for audit (origin tagging) and for the specific case where we need to know the _bot_ signed (not just any NIP-98 caller). Recommend: keep it, but stop using it as a gate.

4. **Rate limiting for NIP-98 callers?** With owner nsec now accepted everywhere, there's no additional rate limiting concern beyond what exists today. Both owner and bot NIP-98 resolve to the same owner identity for balance checks.

5. **Should the `sessions.ts` CLI gain delegate-session commands?** Merging the CLIs would simplify the UX. But the two CLIs serve different mental models (interactive management vs automated orchestration). Recommend: defer to user preference.
