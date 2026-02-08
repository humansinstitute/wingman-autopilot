---
description: Connect to Optikon using NIP-98 auth to read boards, elements, and export data
---

# Connect to Optikon

Optikon is a collaborative whiteboard at `https://optikon.otherstuff.ai`. It uses NIP-98 (Nostr HTTP Auth) for authentication. Use the Wingman MCP signing tools to authenticate and call its API.

## Authentication

Optikon supports two tiers of NIP-98 access:

- **Tier 1** (Wingman identity): Instant, no browser needed. Good for reading public boards or boards shared with the Wingman server npub.
- **Tier 2** (your identity): Requires browser approval via `request_api_access`. Use this to access your own private boards.

### Tier 1 — Quick Access

1. Call `sign_nip98` with the target URL, method, and `tier: "1"`
2. Use the returned Authorization header in your HTTP request

### Tier 2 — User Identity

1. Call `request_api_access` with `domain: "optikon.otherstuff.ai"` and a reason
2. Wait for browser approval (the user will see a consent modal)
3. Then call `sign_nip98` with `tier: "2"` for each request

## API Endpoints

Base URL: `https://optikon.otherstuff.ai/api`

### List Workspaces

```
GET /workspaces
```

Returns all workspaces you have access to.

### List Boards

```
GET /boards
GET /boards?workspace_id={id}
```

Returns boards, optionally filtered by workspace.

### Get a Board

```
GET /boards/{boardId}
```

Returns board metadata (title, description, privacy, members).

### Get Board Elements

```
GET /boards/{boardId}/elements
```

Returns `{ elements: [...] }` — the shapes, text, images, and objects on the board.

### Export Full Board

```
GET /boards/{boardId}/export
```

Returns the board metadata plus all elements in one response. This is the closest thing to a "screenshot" — it gives you the complete board state as JSON.

### Board Members

```
GET /boards/{boardId}/members
```

Returns members with their pubkeys and roles.

## Example: Export a Board

```
1. Sign:    sign_nip98(url="https://optikon.otherstuff.ai/api/boards/{boardId}/export", method="GET", tier="1")
2. Fetch:   Use the Authorization header to GET the export URL
3. Read:    Parse the JSON — board metadata + elements array
```

## Tips

- NIP-98 tokens are valid for ~60 seconds — reuse them for multiple requests to the same URL and method within that window
- Only request a new token when the URL, method, or body changes, or after 50+ seconds
- Use `check_nip98_support` with `base_url: "https://optikon.otherstuff.ai"` to verify connectivity
- Board elements contain position, size, type, and content data — interpret them to understand the board layout
