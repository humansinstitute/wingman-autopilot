# WApp Tower DB Runtime

## Purpose

See Tower spec: ~/code/wingmanbefree/wingman-tower/docs/API-Wap-Access.md for context. 

This doc sets out the requirement for Autopilot to support WApps. 

Autopilot manages WApp lifecycle. Tower owns app registration, workspace authority, and generic WApp database execution. This document defines the Autopilot side of the Tower-backed WApp DB pattern.

The intended runtime is:

```txt
Autopilot app card/process manager
  -> generates/loads WApp app key
  -> injects runtime env
  -> starts WApp backend
WApp backend
  -> signs Tower WApp DB API requests with APP_NSEC
Tower
  -> validates app identity
  -> provisions namespace, runs migrations, performs CRUD/query
  -> keeps Postgres credentials internal
```

The WApp process does not receive a Postgres URL in the normal Tower-backed path. It receives an app key and Tower/workspace context.

## Locked Decisions

- Runtime env name for the WApp private key is `APP_NSEC`.
- Autopilot generates a Nostr key for each WApp assignment that does not already have one.
- Autopilot may also import a user-provided `APP_NSEC` for shared dev, recovery, or intentionally shared WApp instances.
- Generated and imported app keys are stored encrypted in Autopilot's database against the app assignment.
- Autopilot injects `APP_NSEC` into the WApp process.
- Autopilot injects `APP_NPUB`, derived from `APP_NSEC`.
- Tower stores/registers `APP_NPUB`, not `APP_NSEC`.
- WApp backends sign Tower provision, migration, CRUD, and query requests with `APP_NSEC`.
- Tower keeps Postgres credentials internal and exposes generic WApp DB APIs.
- User-level permissions remain in the WApp backend. The WApp backend uses the app key for backend-to-DB operations.
- Same WApp Tower workspace plus same `APP_NPUB` means the same WApp instance and DB namespace.
- Different WApp Tower workspace with the same `APP_NPUB` means a different WApp instance and DB namespace.
- Key rotation is not a v1 feature.

## Runtime Environment

Autopilot should provide these env vars to WApp processes that use Tower-backed DB access:

```txt
APP_ID=
APP_LABEL=
APP_NPUB=
APP_NSEC=
TOWER_URL=
WORKSPACE_OWNER_NPUB=
USER_ALIAS=
PORT=
```

Optional future env vars:

```txt
WAPP_DB_NAMESPACE=
WAPP_DB_MODE=tower-api
WAPP_PUBLIC_ORIGIN=
```

`WAPP_DB_NAMESPACE` is optional because the WApp can ask Tower for its descriptor. If provided, it is informational and should match Tower's registered namespace.

## Install Flow

1. User installs or assigns a WApp in Autopilot.
2. Autopilot creates or loads the WApp assignment record.
3. User selects a WApp Tower binding. There is no implicit fallback binding.
4. Autopilot generates a Nostr keypair for the assignment if missing, or imports a user-provided `APP_NSEC`.
5. Autopilot stores the app key encrypted against the assignment.
6. Autopilot derives `APP_NPUB`.
7. Autopilot registers the WApp `APP_NPUB` in Tower for the selected workspace using owner/admin/service authority.
8. If the same selected workspace already has the same `APP_NPUB` registered, Autopilot treats this as attaching to the existing WApp instance/namespace.
9. Autopilot starts the WApp with `APP_NSEC`, `APP_NPUB`, `TOWER_URL`, and `WORKSPACE_OWNER_NPUB`.
10. The WApp backend calls Tower's WApp DB provision endpoint.
11. The WApp backend sends app-signed migrations to Tower.
12. The WApp backend serves its frontend and domain API.

The WApp owns migration files and domain logic. Autopilot should not need to understand WApp table schemas.

## BYO App Key

Autopilot should support importing an existing `APP_NSEC` when installing a WApp, especially from GitHub/dev flows.

Use cases:

- two developers intentionally share one WApp backend namespace in a shared dev/staging WApp Tower workspace;
- a developer runs a local app process against a shared staging database;
- recovery of an existing WApp instance after moving or recreating an Autopilot assignment;
- staging/live separation by using different app keys, different WApp Tower workspaces, or both.

Recommended install UI:

```txt
App key
  - Generate new app key
  - Use existing APP_NSEC
```

Default is generate new app key. Importing an existing key should be explicit.

Attach behavior:

- same WApp Tower workspace plus same derived `APP_NPUB` attaches to the existing WApp instance/namespace;
- different WApp Tower workspace plus same derived `APP_NPUB` creates or attaches to a separate instance in that workspace;
- same app package/template with a different generated key creates a separate instance even in the same workspace.

Autopilot should clearly show the selected WApp Tower binding and derived `APP_NPUB` before install/start. Anyone with the same `APP_NSEC` has full app-level DB authority for that WApp instance.

## Startup Flow

On every app start:

1. Autopilot resolves the assignment.
2. Autopilot injects the same `APP_NSEC` for that assignment.
3. WApp backend checks Tower descriptor/state.
4. WApp backend runs pending migrations if needed.
5. WApp backend reports readiness only after required migrations succeed.

If migration fails, the app process may stay up to expose diagnostics, but the app card should show setup failure or degraded readiness.

## App Key Persistence

The target model is:

- Autopilot owns app key generation.
- Autopilot supports explicit app key import.
- Autopilot should preserve the key across restarts for the same WApp assignment.
- Autopilot stores generated and imported app keys encrypted in its own database against the app assignment.
- Encryption should use the existing Autopilot session/key material if suitable.
- Autopilot should avoid writing raw `APP_NSEC` into plain app registry JSON.

Open implementation detail:

- which existing Autopilot key/session material should encrypt app keys;
- how encrypted app keys are backed up and restored.

Regenerating the key for an existing assignment breaks Tower app identity unless Tower app key rotation is performed. Autopilot should not silently regenerate an existing app key.

Key rotation is not a v1 feature. Recovery should use backed up/imported `APP_NSEC`.

## Workspace Selection

This is the main unresolved product model.

Known facts:

- A human has an `npub` and may own multiple Tower workspaces.
- An Autopilot/bot/service identity may be a member of multiple Tower workspaces.
- A WApp installation needs one owning workspace for namespace, storage, billing, and visibility.
- A WApp may need to operate in more than one workspace, but the first implementation should avoid one namespace spanning multiple workspaces.

Working recommendation:

- Autopilot supports multiple explicit WApp Tower bindings.
- One binding can be selected as the default for new WApp installs.
- A WApp install always selects one WApp Tower binding.
- No fallback binding is created or used implicitly.
- A human/organization workspace is the billing and data ownership container.
- The Autopilot service/bot identity is a member or service actor in each workspace binding it can use.
- Each workspace plus app npub gets a separate Tower app namespace.
- Billing/storage is attributed to the workspace that owns the WApp namespace.
- A developer may run a local WApp against a shared dev/staging WApp Tower binding by importing the shared `APP_NSEC`.

Open questions:

- Does a centrally hosted Flight Deck show WApps by workspace, by Autopilot machine, or both?
- If a WApp needs a unified view across multiple workspaces, does Autopilot install it once per workspace and let the app aggregate?
- How should WApp Tower bindings be named and surfaced for dev/staging/live use?

## WApp Backend Responsibilities

The WApp backend should:

- expose its own frontend/domain API;
- verify user/agent NIP-98 requests where the WApp requires user-level access;
- treat agents as users/actors, not DB principals;
- sign Tower DB requests with `APP_NSEC`;
- run migrations through Tower;
- make migrations idempotent;
- use constrained Tower CRUD/query APIs rather than arbitrary SQL at runtime;
- store provenance fields for anonymous, app-created, user-created, and agent-created records when relevant.

## Autopilot Non-Goals

Autopilot should not:

- inspect or generate WApp table schemas;
- give agents direct database credentials;
- call Tower DB APIs as a replacement for the WApp backend's domain API;
- bypass WApp access checks for normal app operations;
- expose `APP_NSEC` to browser clients.

## Agents

Agents are NIP-98 actors from the WApp perspective. They call the WApp API. The WApp backend validates the agent/user request, applies domain authorization, and then performs app-owned Tower DB operations with `APP_NSEC`.

This keeps the Tower DB API as the backend-to-DB connection rather than a general agent data API.

## Related Tower Contract

Tower's companion contract is documented in:

```txt
~/code/wingmanbefree/wingman-tower/docs/API-Wap-Access.md
```

Autopilot should align its runtime env, app key generation, and workspace assignment behavior with that contract.
