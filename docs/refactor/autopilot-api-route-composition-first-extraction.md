# Autopilot API Route Composition First Extraction

## Goal

Make `src/server.ts` and the central API router read as route composition rather than route implementation. The current server entrypoint already delegates `/api/*` traffic to `createApiRouteHandler` in `src/server/api-routes.ts`, and many route families already live in focused modules such as `auth-routes.ts`, `session-api-routes.ts`, `docs-routes.ts`, and `terminal-routes.ts`. The next low-risk step is to continue that pattern by moving a small inline family out of `api-routes.ts` before attempting larger API groups.

## Recommended First Family

Extract the user settings API:

- `GET /api/user/settings`
- `PUT /api/user/settings/:key`
- `DELETE /api/user/settings/:key`

This is the lowest-risk first extraction because it is already isolated inside one contiguous block near the end of `createApiRouteHandler`, depends on a small context surface, and has focused coverage in `src/server/api-routes.config.test.ts`. It does not touch process management, WebSocket upgrades, app proxying, file IO, NIP-98 fallback routing, pipeline callbacks, or static asset serving.

The extraction should preserve all current behavior:

- Same URL paths and methods.
- Same `SessionsManage` access check.
- Same `Authentication required` response when no viewer npub is present.
- Same setting-key parsing from `/api/user/settings/:key`.
- Same sensitive-value masking on `GET`.
- Same `default_agent` validation against configured agent IDs.
- Same JSON response shapes and status codes.

## Proposed Module Boundary

Create `src/server/user-settings-routes.ts` with a small context object and one exported handler:

```ts
import type { RequestAuthContext } from '../auth/request-context';
import type { AccessAction } from '../auth/access-control';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';

export interface UserSettingsRoutesContext {
  agents: Record<string, { label: string }>;
  userSettingsStore: {
    getAll: (npub: string) => Record<string, string>;
    set: (npub: string, key: string, value: string) => void;
    delete: (npub: string, key: string) => void;
  };
  ensureApiAccess: (
    action: AccessAction,
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ) => Promise<Response | null>;
  AccessActions: {
    SessionsManage: AccessAction;
  };
}

export async function handleUserSettingsApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: UserSettingsRoutesContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/user/settings')) return null;

  // Move the current implementation here without changing response bodies.
}
```

Keep parsing, masking, validation, and response construction in this module. Do not leave helper functions behind in `api-routes.ts`; otherwise the router still owns implementation details. Use function declarations for helpers such as `maskSensitiveSettings` or define constants before usage to avoid startup-time `ReferenceError` issues.

## Before And After

Current router shape:

```ts
if (pathname.startsWith('/api/user/settings')) {
  const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
  if (denied) return denied;

  const viewerNpub = authContext.npub;
  if (!viewerNpub) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  const settingsParts = pathname.split('/');
  const settingKey = settingsParts[4];

  // GET, PUT, DELETE implementation continues inline.
}
```

Target router shape:

```ts
if (pathname.startsWith('/api/user/settings')) {
  const userSettingsResponse = await handleUserSettingsApi(
    request,
    url,
    method,
    authContext,
    ctx.userSettingsRoutesContext,
  );
  if (userSettingsResponse) return userSettingsResponse;
}
```

The central router should only decide that `/api/user/settings*` belongs to the user settings module. The route module should own the access check and all response bodies so tests can exercise the moved contract directly.

Update `ApiRoutesContext` with a nested context:

```ts
userSettingsRoutesContext: UserSettingsRoutesContext;
```

Then build it in `src/server.ts` where other route contexts are assembled:

```ts
userSettingsRoutesContext: {
  agents: config.agents,
  userSettingsStore,
  ensureApiAccess,
  AccessActions,
},
```

This preserves the existing source of truth for dependencies while keeping `src/server.ts` as composition. Do not introduce a global registry or change the request flow in `Bun.serve`; this first extraction should match the current explicit route-order pattern.

## Test Plan

Add direct tests beside the new module in `src/server/user-settings-routes.test.ts` before removing the inline block from `api-routes.ts`.

Cover the existing contract:

- `GET /api/user/settings` returns `{ settings }` and masks keys containing `key`, `secret`, `token`, or `password`.
- `GET /api/user/settings` returns `401` with `{ error: 'Authentication required' }` when access passes but `authContext.npub` is missing.
- `PUT /api/user/settings/default_agent` trims and lowercases valid agent IDs, returns `{ success: true, key, value }`, and calls `userSettingsStore.set`.
- `PUT /api/user/settings/default_agent` rejects unknown agents with `400` and does not persist.
- `PUT /api/user/settings/:key` rejects invalid JSON with `400` and `{ error: 'Invalid JSON' }`.
- `PUT /api/user/settings/:key` rejects a blank `value` with `400` and `{ error: 'value is required' }`.
- `DELETE /api/user/settings/:key` returns `{ success: true, key, deleted: true }` and calls `userSettingsStore.delete`.
- Unsupported methods or missing keys return `404` with `{ error: 'Not found' }`.
- Access denial short-circuits before reading or writing settings.

Keep the existing `src/server/api-routes.config.test.ts` cases while extracting. They become integration coverage proving the composed router still reaches the same contract through `createApiRouteHandler`.

Recommended validation sequence:

```bash
bun test src/server/user-settings-routes.test.ts
bun test src/server/api-routes.config.test.ts
bun test src/server/user-settings-routes.test.ts src/server/api-routes.config.test.ts
bun --check src/server/user-settings-routes.ts src/server/api-routes.ts src/server.ts
```

If the focused tests pass, broader server tests can be run before the next extraction:

```bash
bun test src/server
```

## Extraction Sequence

1. Add `src/server/user-settings-routes.ts` and `src/server/user-settings-routes.test.ts` while leaving the inline block in `api-routes.ts`.
2. Copy the current user settings behavior into `handleUserSettingsApi` and make the direct module tests pass.
3. Add `userSettingsRoutesContext` to `ApiRoutesContext` and the test handler factory in `api-routes.config.test.ts`.
4. Replace the inline `/api/user/settings` block in `api-routes.ts` with a call to `handleUserSettingsApi`.
5. Build `userSettingsRoutesContext` in `src/server.ts` next to the existing pre-built route contexts.
6. Run the focused direct and router tests.
7. Commit only the user settings extraction before choosing the next route family.

## Follow-On Candidates

After user settings is extracted and reviewed, the next low-risk candidates are:

- `/api/artifacts/:id/raw`, because it is a small read-only leaf route with one store and one file existence check.
- `/api/directories`, because it is compact and file-access scoped, but it has NIP-98 fallback and workspace resolution behavior that makes it slightly riskier than user settings.
- `/api/config`, because it is read-only, but it overlaps with config defaults, feature flags, and per-user agent settings.

Avoid starting with session, apps, pipeline, MCP, or proxy routes. Those families have broader authentication, process, callback, or routing interactions and should wait until the extraction pattern is proven on a smaller contract.

## Current Validation

This documentation-only planning step can be validated by checking that the guide exists and by reviewing the referenced current route blocks in `src/server/api-routes.ts` and `src/server.ts`. Runtime validation is intentionally left for the implementation step because no executable code changed here.
