# Flight Deck PG CLI Missing Routes

The CLI uses existing Tower PG routes directly where available. Remaining coverage gaps are explicit:

## Workspace Task Rollup

- Method/path: `GET /api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks`
- Auth: NIP-98 actor must be a workspace member; response should include only tasks visible through `task.read`.
- Request: query `{ limit?: number, cursor?: string }`
- Response: `{ identity, tasks: FlightDeckPgTask[], next_cursor: string | null }`
- Current behavior: CLI requires `--channel` for `GET /channels/{channelId}/tasks` or `--scope` for `GET /scopes/{scopeId}/tasks`.

## Single Scope Read

- Method/path: `GET /api/v4/flightdeck-pg/workspaces/{workspaceId}/scopes/{scopeId}`
- Auth: NIP-98 actor must have `scope.read` or a readable channel grant within the scope.
- Request: path `{ workspaceId, scopeId }`
- Response: `{ identity, scope: FlightDeckPgScope }`
- Current behavior: CLI filters `GET /workspaces/{workspaceId}/scopes` output and returns a route-gap error when the requested scope is not present.

## Flow And Approval Commands

- Desired methods:
  - `GET /api/v4/flightdeck-pg/workspaces/{workspaceId}/flows`
  - `GET /api/v4/flightdeck-pg/workspaces/{workspaceId}/flows/{flowId}`
  - `POST /api/v4/flightdeck-pg/workspaces/{workspaceId}/flows/{flowId}/actions`
  - `GET /api/v4/flightdeck-pg/workspaces/{workspaceId}/approvals`
  - `GET /api/v4/flightdeck-pg/workspaces/{workspaceId}/approvals/{approvalId}`
  - `POST /api/v4/flightdeck-pg/workspaces/{workspaceId}/approvals/{approvalId}/decision`
- Auth: NIP-98 actor with workspace membership and route-specific flow/approval permissions.
- Request/response: typed PG flow and approval records with row-versioned mutation results and outbox events.
- Current behavior: CLI does not expose flow/approval commands until Tower typed routes exist.
