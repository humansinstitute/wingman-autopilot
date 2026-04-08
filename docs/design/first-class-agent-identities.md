# First-Class Agent Identities and Delegated Workspace Access

## Goal

Change Wingman's agent identity model so that:

1. an agent always signs requests as itself
2. the agent is a first-class Wingman user with its own `npub`, ports, balance, and session space
3. the agent can still read and manage sessions in an owner's space when that owner has explicitly registered the agent as a delegate
4. delegation does not require identity rewriting

This is a remediation proposal for the current overlap between owner-signed, bot-signed, and in-session bot-crypto execution paths.

## The Desired Behavior

### Agent-native behavior

When an agent signs a request:

- the signer remains the agent identity
- the effective account for self-scoped operations is the agent's own `npub`
- new sessions created by that agent live in the agent's own account space by default
- the agent's own budget is charged for its own actions

### Delegated behavior

When the same agent accesses the owner's workspace:

- it still signs as itself
- the system checks whether it is a registered delegate of that owner
- access is granted or denied by explicit delegation rules
- audit logs preserve both identities: signer and resource owner

The key distinction is:

- **identity** = who signed the request
- **authority** = what account space or resources that identity may act on

Today those are partially collapsed together.

## What Happens Today

The closest current behavior is split across two modes:

### Closest mode for "act in my own space"

An agent signing with its own nsec as a normal NIP-98 caller is closest to `owner-cli`.

If the signer does **not** map through the bot-owner lookup, Wingman keeps the signer as the resolved `npub` in [`src/auth/nip98-auth.ts`](/Users/mini/code/wingmen/src/auth/nip98-auth.ts#L41).

That means the agent can behave as its own Wingman identity.

### Closest mode for "act in my space as my delegate"

`delegate-bot` is the closest current behavior for delegated access.

But it works by rewriting the effective identity from the bot signer to the owner in [`src/auth/nip98-auth.ts`](/Users/mini/code/wingmen/src/auth/nip98-auth.ts#L29) and [`src/server.ts`](/Users/mini/code/wingmen/src/server.ts#L2106).

That means:

- the signer is the bot
- the effective account becomes the owner
- balances, session ownership, and routing all behave as if the caller is the owner

### Why no current mode matches the target

No current mode supports both of these at once:

- keep the agent's own identity
- allow delegated access into the owner's space

Today, once the signer is recognized as a bot for an owner, the request is rewritten into the owner's account space. That is the exact opposite of "always sign as itself and sometimes act as a delegate."

## Root Cause

The current internal NIP-98 path uses bot ownership lookup during auth resolution:

```ts
resolveNip98AuthContext(request, url, authContext, {
  verifyNip98AuthHeader,
  lookupBotOwnerNpub: (botNpub) => botKeyStore.getActiveKeyForBotNpub(botNpub)?.userNpub ?? null,
});
```

Source: [`src/server.ts`](/Users/mini/code/wingmen/src/server.ts#L2106)

That produces an auth context where:

- `npub` becomes the owner
- `actorNpub` remains the bot signer
- `delegatedByBot` becomes `true`

That model is good for "bot stands in for owner", but not for "agent is its own account with optional delegated rights."

## What Must Change

This is not just a route cleanup. It requires separating signer identity from delegated authority.

## 1. Stop Rewriting The Caller Into The Owner

For internal Wingman APIs, a bot or agent signer should remain the resolved caller identity.

Instead of:

- signer bot -> effective `npub = owner`

the model should become:

- signer bot/agent -> effective `npub = signer`
- optional `delegatedForNpub = owner` or equivalent authorization context

In other words:

- preserve self identity
- attach delegation metadata separately

The auth layer should answer:

- who signed?
- which owner, if any, has delegated authority to this signer?

It should not answer by replacing the signer with the owner.

## 2. Introduce Explicit Delegate Relationships

Wingman needs a durable store for internal delegation, separate from bot-key ownership lookup.

A simple starting model:

- `delegateNpub`
- `ownerNpub`
- `scopes`
- `createdAt`
- `revokedAt`
- optional `budgetMode`
- optional `sessionRestrictions`

Suggested scopes:

- `sessions:read`
- `sessions:create`
- `sessions:manage`
- `apps:read`
- `apps:manage`
- `files:read`
- `files:write`

This is a different problem from external NIP-98 grants in `nip98_grants`. Those are domain/signing grants for MCP and browser-mediated signing. This remediation needs internal workspace delegation for Wingman-owned resources.

## 3. Separate Self-Space Routes From Delegated Access

The cleanest route model is:

### Self-space

- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:id`
- etc.

These operate on the caller's own account space only.

If an agent signs as `npub_agent`, these routes should create and manage sessions owned by `npub_agent`.

### Delegated space

Add explicit owner-targeted routes, for example:

- `GET /api/delegates/:ownerNpub/sessions`
- `POST /api/delegates/:ownerNpub/sessions`
- `GET /api/delegates/:ownerNpub/sessions/:id`
- `POST /api/delegates/:ownerNpub/sessions/:id/messages`

or equivalently a query/body target such as:

- `POST /api/sessions` with `workspaceOwnerNpub`

The first option is clearer and easier to audit.

The critical rule is:

- self-space is implicit
- delegated owner-space is explicit

That removes ambiguity.

## 4. Make Session Ownership Mean The Actual Account Space

Today session ownership is tied to `session.npub`, and many checks depend on `sessionBelongsToViewer(...)`.

For the target model:

- sessions created in self-space should store `session.npub = signerNpub`
- delegated operations against owner space should store `session.npub = ownerNpub`
- audit fields should still record the actual actor that created or modified the session

That implies session records need stronger actor metadata, for example:

- `ownerNpub`
- `createdByNpub`
- `lastManagedByNpub`
- `origin.type`

The current `origin` support is useful, but it is not enough by itself for the new model.

## 5. Charge The Correct Budget

The current billing path charges `authContext.npub`, for example in [`src/server/session-api-routes.ts`](/Users/mini/code/wingmen/src/server/session-api-routes.ts#L845).

Under the new model:

- self-space actions should charge the agent's own balance
- delegated actions should either:
  - charge the agent's own balance, or
  - charge the owner's balance, but only if the delegation explicitly permits sponsor billing

Recommended default:

- charge the acting agent unless the delegate relationship explicitly says otherwise

That keeps agency and limits clearer.

## 6. Make In-Session Bot-Crypto Preserve Agent Identity

`in-session-agent` currently signs through `/api/mcp/bot-crypto/sign-event` using `SESSION_ID`, but the downstream route semantics still collapse into the current rewrite model.

That mode should continue to exist, but its meaning should become:

- "sign as the current agent identity using session-bound signing material"

not:

- "be treated as the owner because the signer is one of the owner's bots"

In other words, bot-crypto remains a signing transport, not an authorization shortcut.

## Recommended Request Context Shape

The current `RequestAuthContext` is close, but the semantics need to change.

A better target model:

- `signerNpub`: the actual request signer
- `subjectNpub`: the caller's own Wingman identity, normally equal to `signerNpub`
- `delegatedOwnerNpub`: owner whose workspace this caller may access, if any
- `authMethod`
- `delegateRelationshipId`
- `delegateScopes`

The important distinction is:

- `subjectNpub` should not silently become the owner

## Recommended Authorization Model

Authorization should answer two questions independently:

### 1. Who is the caller?

- owner
- agent
- browser user
- admin

### 2. What space are they trying to operate in?

- self
- delegated owner workspace
- admin-wide

Then access control becomes explicit:

- self-space: allowed if authenticated
- delegated owner-space: allowed only if a live delegate relationship grants that scope
- admin-space: allowed only for admin

This is much easier to reason about than today’s mixed route and auth predicates.

## How Different Is This From Today

It is a meaningful architectural change, but not a full rewrite.

### What can stay

- NIP-98 signing
- bot-crypto session signing
- `identityUserStore` as the source of balances and per-identity ports
- existing session/app ownership patterns based on `npub`
- current route modularization

### What must change

- internal auth resolution must stop rewriting bot signers into owners
- a new delegate relationship store must exist
- delegated access must be explicit in routing or request shape
- session metadata must distinguish owner from actor more clearly
- balance charging must choose between actor and owner intentionally

## Which Current Mode Is Closest

### For first-class agent self-identity

The closest current mode is:

- direct NIP-98 with the agent's own key, without bot-owner remapping

This already behaves like a first-class user in the limited sense that `identityUserStore` can allocate ports and balance to any `npub`.

### For delegated access into the owner's space

The closest current mode is:

- `delegate-bot`

But it only works by erasing the agent as the effective identity and replacing it with the owner.

### Bottom line

No current mode is correct for the target design.

One mode gives self identity.
The other gives delegated owner access.
Neither gives both together.

## Suggested Migration Path

### Phase 1

- add a delegate relationship store
- add explicit auth-context fields for signer and delegated owner
- stop rewriting the signer into the owner for new internal APIs

### Phase 2

- add explicit delegated workspace routes
- keep existing `/api/delegate-sessions` as compatibility routes
- implement new authorization checks based on delegate relationships

### Phase 3

- update billing rules
- update session records to preserve owner and actor separately
- migrate agents and CLIs to the new explicit self-vs-delegated model

### Phase 4

- deprecate the old rewrite-based delegate-session behavior

## Recommendation

If the desired product behavior is:

- agents are first-class Wingman users
- agents keep their own identity
- delegation is explicit and auditable

then Wingman should move away from "bot signer resolves to owner" and toward "agent signer remains itself, with scoped delegate rights into owner workspaces."

That is the core remediation.
