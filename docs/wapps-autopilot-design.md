# Wingman Apps Autopilot Design

## Goal

Wingman Apps, or WApps, are single-purpose apps managed by Autopilot and surfaced in Flight Deck. A WApp is not a new runtime type. It is a published workspace assignment for an existing Autopilot managed web app.

The MVP should let an operator create a WApp from an existing app card, assign it to a known workspace and scope, publish a Flight Deck record containing the launch link, and run the app with a Nostr allowlist derived from that scope.

## Product Rules

- WApps are Nostr-authenticated apps.
- A WApp must be backed by a registered Wingman app. Register the runtime app through the Wingman CLI/API first, for example `bun clis/appctl.ts register "Hello World WApp" --directory /path/to/wapp --web-app`, then use the returned app id as `WappRecord.appId`.
- Do not create a WApp by hand-editing `data/apps.json`, `data/app-aliases.json`, or `data/wapps.sqlite`. Direct file edits do not update the live app registry, alias registry, runtime port registry, or process manager.
- No Flight Deck auth handoff is required for the MVP.
- No NIP-98 requirement is needed for the WApp browser login gate.
- Users authenticate in the WApp using a Nostr browser extension.
- WApp-to-Autopilot API calls and Autopilot-to-WApp agent API calls should use NIP-98.
- Bot read and edit access to a WApp must be explicit and separately granted.
- Keyteleport can be added later for users without a browser extension.
- A WApp is a Bun server with static frontend assets and a local SQLite database.
- The SQLite database lives inside the WApp directory, by convention `{wappRoot}/data/db.sqlite`.
- Autopilot stores WApp catalog and assignment metadata only. It does not centralize WApp operational SQLite databases.

For the general Business WApp pattern, see `docs/business-wapp-autopilot-pattern.md`.

## Existing Autopilot Primitives

Autopilot already has the right runtime building blocks:

- `src/apps/app-registry.ts` tracks app roots, labels, owners, web app status, and assigned ports.
- `src/apps/app-process-manager.ts` runs app scripts and injects runtime environment.
- `src/apps/app-alias-registry.ts` creates stable app aliases for hosted links.
- `src/server/apps-api-routes.ts` exposes app CRUD and lifecycle APIs.
- `src/server/subdomain-proxy.ts` routes hosted app aliases to app runtime ports.
- CapRover records can link live deployment URLs to local app IDs.

The WApp implementation should build beside these modules rather than adding more logic directly to `src/server.ts` or overloading `AppRecord`.

## Data Model

Add a WApp assignment/catalog layer with a local store, for example:

```ts
export interface WappRecord {
  id: string;
  appId: string;
  title: string;
  description?: string;
  ownerNpub: string;
  createdByNpub: string;
  workspaceOwnerNpub: string;
  scopeId: string;
  scopeLineage: {
    scopeId: string;
    l1Id: string | null;
    l2Id: string | null;
    l3Id: string | null;
    l4Id: string | null;
    l5Id: string | null;
  };
  allowedNpubs: string[];
  launchUrl: string;
  sourceWingmanUrl?: string;
  subdomainAlias?: string | null;
  recordState: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  lastPublishedAt?: string | null;
}
```

Store this in a dedicated module such as:

```txt
src/wapps/types.ts
src/wapps/wapp-store.ts
src/wapps/scope-access.ts
src/wapps/wapp-publisher.ts
src/wapps/wapp-template.ts
src/server/wapps-api-routes.ts
```

Do not add WApp fields to `AppRecord` beyond what is already needed for runtime apps.

`WappRecord.appId` must reference a real registered app from `src/apps/app-registry.ts`. The publish step should reject missing or stale app ids, because Flight Deck can show a WApp link even when the subdomain proxy cannot route it.

## Scope Allowlist Resolution

When creating or refreshing a WApp assignment, Autopilot should resolve a concrete list of allowed npubs:

1. Load the selected workspace.
2. Load the selected scope.
3. Read the scope access groups.
4. Resolve group membership to member npubs.
5. Add the WApp owner npub.
6. Deduplicate and normalize npubs.

The WApp server receives this allowlist at runtime. For MVP, it is acceptable for updates to require app restart or republish. A later iteration can write a refreshed allowlist file or expose an internal endpoint that the WApp server reloads.

## Runtime Environment

When Autopilot starts a WApp, inject these environment variables:

```txt
WAPP_ID=<wapp id>
WAPP_APP_ID=<app id>
WAPP_OWNER_NPUB=<owner npub>
WAPP_WORKSPACE_OWNER_NPUB=<workspace owner npub>
WAPP_SCOPE_ID=<scope id>
WAPP_ALLOWED_NPUBS_JSON=["npub1..."]
WAPP_DB_PATH=<wapp root>/data/db.sqlite
```

The app process manager should preserve existing app behavior and only inject these variables for registered WApp assignments.

## WApp Template

The generated template should be intentionally small:

```txt
public/
  index.html
  app.js
  styles.css
src/
  server.ts
  auth/nostr.ts
  auth/session.ts
  auth/allowlist.ts
  db.ts
  routes.ts
data/
  .gitkeep
package.json
README.md
```

Auth behavior:

1. Frontend asks a Nostr browser extension to sign a login challenge.
2. Backend verifies the signature and derives the npub.
3. Backend checks `npub === WAPP_OWNER_NPUB` or membership in `WAPP_ALLOWED_NPUBS_JSON`.
4. Backend creates a local WApp session cookie.
5. All WApp API routes require that local session.

The frontend must not be the security boundary. The Bun server must enforce the allowlist before returning data or accepting writes.

## API Shape

Add WApp routes under a new extracted server module:

```txt
GET    /api/wapps
POST   /api/wapps
GET    /api/wapps/:id
PUT    /api/wapps/:id
DELETE /api/wapps/:id
POST   /api/wapps/:id/publish
POST   /api/wapps/:id/refresh-allowlist
POST   /api/wapps/templates/create
```

The app card UI can call `POST /api/wapps` from a "Create WApp" flow.

## Flight Deck Publication Contract

Autopilot publishes a Flight Deck `wapp` record with launch metadata:

```ts
{
  app_namespace: '<Flight Deck app npub>',
  collection_space: 'wapp',
  schema_version: 1,
  record_id: '<wapp id>',
  data: {
    title,
    description,
    owner_npub,
    wapp_id,
    app_id,
    launch_url,
    source_wingman_url,
    workspace_owner_npub,
    scope_id,
    scope_l1_id,
    scope_l2_id,
    scope_l3_id,
    scope_l4_id,
    scope_l5_id,
    record_state
  }
}
```

The record should be encrypted to the groups that correspond to the selected scope, so Flight Deck users only see WApps they can decrypt.

## UI Flow

Add a "Create WApp" action to app cards:

```txt
App card -> Create WApp -> Select workspace -> Select scope -> Review allowed users -> Publish
```

The review step should show the derived npub allowlist before publishing.

For CLI-driven creation, the minimum operator flow is:

```txt
appctl register <label> --directory <wapp root> --web-app
appctl start <returned app id>
create/update WApp assignment with that app id
publish the Flight Deck wapp record
```

Use the CLI/API response app id, not a caller-invented id, so the app registry, alias registry, runtime port registry, and WApp metadata stay aligned.

## Acceptance Criteria

- Existing app registration and lifecycle behavior remains unchanged.
- WApp creation fails clearly unless the referenced app id exists in the live Wingman app registry.
- A WApp can be created from an existing web app.
- A WApp can be assigned to a workspace and scope.
- The allowed npub list is derived from the selected scope and owner.
- The app process receives WApp environment variables when run as a WApp.
- The generated WApp template enforces Nostr login server-side.
- The WApp SQLite DB path defaults to `{wappRoot}/data/db.sqlite`.
- Autopilot can publish or refresh a Flight Deck WApp record.
- New server code is extracted into WApp modules rather than added directly to `src/server.ts`.
- Tests cover the store, allowlist derivation, API validation, and publisher payload shape.

## Non-Goals

- Do not add Flight Deck auth handoff.
- Do not require NIP-98 for WApp login.
- Do not add mandatory Postgres for WApps.
- Do not centralize WApp SQLite databases under Autopilot data folders.
- Do not make WApps a separate process manager type.
