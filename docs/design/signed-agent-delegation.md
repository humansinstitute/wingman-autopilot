# Signed Agent Delegation and Explicit Owner-Space Routes

## Summary

This document proposes a new internal authorization model for Wingman where:

- bots and agents always identify as themselves
- owner-space access is explicit in the route shape
- delegation is represented by a signed owner-approved record
- one owner can authorize many delegates
- delegates can act in their own account space by default and in the owner's space only when authorized

This replaces the current pattern where a bot signer is internally rewritten into the owner identity.

## Goals

1. Preserve signer identity at all times.
2. Support multiple delegate bots or external accounts per owner.
3. Allow delegates to act in their own Wingman account space by default.
4. Allow delegates to act in an owner's space only when a valid delegation exists.
5. Support owner-signed delegation approvals with expiry and scoped permissions.
6. Make route intent explicit so authorization decisions are easy to reason about and debug.

## Non-Goals

1. This is not a replacement for external NIP-98 browser grants used by MCP and third-party APIs.
2. This does not redesign the entire Wingman auth stack.
3. This does not require changing the core NIP-98 signing format for incoming API requests.

## Problem With The Current Model

Today internal auth resolution can map a bot signer into the owner identity:

- signer = bot
- effective `npub` = owner
- `actorNpub` = bot

That causes several problems:

1. The delegate does not remain a first-class Wingman user.
2. Session ownership and budget charging become ambiguous.
3. Delegated access is hidden inside auth rewriting instead of being explicit.
4. The model only naturally supports a single bot-owner binding, not many delegates.
5. Route behavior becomes hard for both humans and agents to predict.

## Desired Mental Model

Every request should answer three separate questions:

1. Who signed this request?
2. Which account space is the request targeting?
3. Does the signer have authority to operate in that target space?

These should not be collapsed into one field.

## Core Concepts

### Signer

The Nostr identity that signed the NIP-98 request.

Examples:

- human owner account
- agent account
- bot account

### Subject

The Wingman identity represented by the signer for self-scoped operations.

Normally:

- `subjectNpub = signerNpub`

### Target Owner

The owner account space the request wants to operate in.

Examples:

- self-space: `targetOwnerNpub = signerNpub`
- delegated owner-space: `targetOwnerNpub = owner_npub`

### Delegation

A durable authorization record proving that an owner has granted a delegate scoped access to the owner's account space.

## Recommended Route Model

### Self-Space Routes

These operate on the caller's own Wingman account space.

- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:id`
- `POST /api/sessions/:id/messages`
- `GET /api/apps`
- `POST /api/apps`

Behavior:

- if a bot signs, it accesses its own account
- if a human signs, they access their own account

### Delegated Owner-Space Routes

These operate on another owner's space and therefore require explicit delegation.

- `GET /api/owners/:ownerNpub/sessions`
- `POST /api/owners/:ownerNpub/sessions`
- `GET /api/owners/:ownerNpub/sessions/:id`
- `DELETE /api/owners/:ownerNpub/sessions/:id`
- `POST /api/owners/:ownerNpub/sessions/:id/messages`
- `GET /api/owners/:ownerNpub/sessions/:id/history`
- `GET /api/owners/:ownerNpub/apps`
- `POST /api/owners/:ownerNpub/apps`

Behavior:

- signer remains the delegate identity
- target owner is explicit in the path
- authorization requires a valid delegation record

### Why Route Separation Matters

This is preferable to implicit owner targeting in the body because:

1. it makes logs clearer
2. it makes authorization simpler
3. it avoids accidental cross-space operations
4. it makes agent tooling easier to implement correctly

## Delegation Data Model

Add a new durable table, separate from current bot-owner rewriting and separate from external `nip98_grants`.

Suggested table: `workspace_delegations`

Columns:

- `id TEXT PRIMARY KEY`
- `owner_npub TEXT NOT NULL`
- `delegate_npub TEXT NOT NULL`
- `scopes TEXT NOT NULL`
- `expires_at INTEGER NULL`
- `created_at INTEGER NOT NULL`
- `revoked_at INTEGER NULL`
- `billing_mode TEXT NOT NULL`
- `spend_limit_sats INTEGER NULL`
- `signed_payload TEXT NOT NULL`
- `signature TEXT NOT NULL`
- `created_by TEXT NOT NULL`

Suggested indexes:

- `(owner_npub)`
- `(delegate_npub)`
- `(owner_npub, delegate_npub)`
- `(expires_at)`
- `(revoked_at)`

## Signed Delegation Payload

The owner should sign a canonical delegation payload authorizing a delegate.

Example payload:

```json
{
  "kind": "wingman-delegation-v1",
  "ownerNpub": "npub1owner...",
  "delegateNpub": "npub1bot...",
  "scopes": [
    "sessions:read",
    "sessions:create",
    "sessions:manage",
    "apps:read"
  ],
  "billingMode": "delegate",
  "spendLimitSats": 50000,
  "createdAt": 1771000000000,
  "expiresAt": 1771604800000
}
```

### Signature Rules

1. The owner signs the payload with their own key.
2. The server verifies that the signature matches `ownerNpub`.
3. The payload is stored verbatim as `signed_payload`.
4. The server treats the delegation row as valid only if:
   - signature verifies
   - `revoked_at` is null
   - `expires_at` is null or in the future
   - requested scope is included

### Benefits

1. Delegation can be granted offline and later uploaded.
2. The record is cryptographically attributable to the owner.
3. Time-bounded approvals are natural.
4. Many delegates per owner are supported.

## Scope Model

Recommended initial scopes:

- `sessions:read`
- `sessions:create`
- `sessions:manage`
- `sessions:message`
- `apps:read`
- `apps:manage`
- `files:read`
- `files:write`
- `jobs:read`
- `jobs:manage`

Optional future scopes:

- `billing:sponsor`
- `admin:none`

`billing:sponsor` should be separate from session management. A delegate being allowed to manage sessions does not automatically mean the owner should pay for the delegate's work.

## Billing Model

Delegation should not imply owner-funded actions by default.

Recommended modes:

- `delegate`
  - charge the delegate's own balance
- `owner`
  - charge the owner's balance
- `shared`
  - reserved for future use

Recommended default:

- `delegate`

This makes first-class agent identities economically real.

## Request Auth Context Changes

The current context should be expanded conceptually to include:

- `signerNpub`
- `subjectNpub`
- `targetOwnerNpub`
- `delegatedOwnerNpub`
- `delegateScopes`
- `delegateRelationshipId`
- `authMethod`

Recommended semantics:

- `signerNpub`: actual NIP-98 signer
- `subjectNpub`: caller's own Wingman identity, usually same as signer
- `targetOwnerNpub`: workspace the request targets
- `delegatedOwnerNpub`: owner that has granted delegation to this subject, if any

Important rule:

- internal auth resolution must not silently replace `subjectNpub` with the owner

## Authorization Rules

### Self-Space

If:

- `targetOwnerNpub === subjectNpub`

Then:

- allow normal self-scoped access

### Delegated Owner-Space

If:

- `targetOwnerNpub !== subjectNpub`

Then:

- require an active delegation from `targetOwnerNpub` to `subjectNpub`
- require matching scope
- apply delegation billing rules

### Admin

Admin remains separate and should not rely on delegation mechanics.

## Session Ownership Model

Session records should distinguish:

- `ownerNpub`
- `createdByNpub`
- `lastManagedByNpub`

The current single ownership field is not expressive enough once delegates become first-class users.

### Proposed Meaning

- `ownerNpub`: the account space the session belongs to
- `createdByNpub`: who created it
- `lastManagedByNpub`: who last mutated it

Examples:

1. Bot creates a session in its own space:
   - `ownerNpub = bot`
   - `createdByNpub = bot`

2. Bot creates a session in the owner's delegated space:
   - `ownerNpub = owner`
   - `createdByNpub = bot`

This preserves both the resource owner and the actor.

## Compatibility With Existing Modes

### Current `owner-cli`

Closest to self-space semantics.

Needed changes:

- mostly route normalization
- no delegation required when accessing self-space

### Current `delegate-bot`

Closest to delegated owner-space semantics.

Needed changes:

- remove owner rewrite behavior
- require explicit owner target
- validate against delegation records instead of bot-owner mapping

### Current `in-session-agent`

Still useful as a signing transport for a live agent session.

Needed changes:

- bot-crypto should sign as the current agent identity
- authorization should still go through self-space or delegated owner-space checks

## API Examples

### Self-space session create

```http
POST /api/sessions
Authorization: Nostr <signed-by-bot>
Content-Type: application/json

{
  "agent": "codex",
  "name": "bot-owned worker"
}
```

Result:

- session belongs to bot account space

### Delegated owner-space session create

```http
POST /api/owners/npub1owner.../sessions
Authorization: Nostr <signed-by-bot>
Content-Type: application/json

{
  "agent": "codex",
  "name": "owner delegated worker"
}
```

Result:

- allowed only if owner delegated `sessions:create` to the bot
- session belongs to owner account space
- audit records still preserve bot as actor

## Delegation Management API

Suggested routes:

- `POST /api/delegations`
  - register a signed delegation payload
- `GET /api/delegations`
  - list delegations visible to the authenticated caller
- `GET /api/owners/:ownerNpub/delegations`
  - list delegations granted by an owner
- `DELETE /api/delegations/:id`
  - revoke delegation

### Create Delegation Request

```json
{
  "signedPayload": "{...canonical json...}",
  "signature": "<owner-signature>"
}
```

The server should:

1. parse and validate the payload
2. verify signature against `ownerNpub`
3. persist the delegation

## Migration Plan

### Phase 1

Add new delegation store and verification logic.

### Phase 2

Add explicit owner-space routes alongside existing routes.

### Phase 3

Update auth context so signer identity is preserved and target owner is resolved separately.

### Phase 4

Update session and app ownership records to preserve owner and actor distinctly.

### Phase 5

Deprecate rewrite-based delegated bot behavior.

## Recommended Defaults

1. Self-space uses `/api/sessions`.
2. Delegated owner-space uses `/api/owners/:ownerNpub/...`.
3. Delegations default to charging the delegate's balance.
4. Delegations require explicit scopes.
5. Delegations may be unlimited or time-bounded.
6. Delegations are always owner-signed.

## Why This Is More Reasonable

This model aligns with how users naturally think:

1. a bot is its own account
2. a bot may be trusted by one or more owners
3. trust is explicit, scoped, and revocable
4. operations against another owner's workspace are deliberate and visible

It also gives agents a cleaner rule:

- always sign as yourself
- use self-space routes for your own account
- use explicit owner-space routes only when you have a valid delegation

That is much easier for both humans and agents to execute correctly.
