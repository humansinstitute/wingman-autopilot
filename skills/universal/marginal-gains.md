---
description: Connect to Marginal Gains task board to read tasks, update state, and report progress
---

# Connect to Marginal Gains

Marginal Gains is a task management board at `https://mg.otherstuff.ai`. It uses NIP-98 (Nostr HTTP Auth) for API authentication. Tasks can be assigned to Wingman agents via Nostr events, and agents report back via the API.

## Authentication

Marginal Gains uses NIP-98 auth. The swagger docs don't advertise it, but the API validates NIP-98 tokens on every request.

### Tier 1 — Wingman Identity

1. Call `sign_nip98` with the target URL, method `"GET"` or `"POST"`, and `tier: "1"`
2. Use the returned Authorization header in your HTTP request
3. This signs as the Wingman server — use for tasks assigned to Wingman

### Tier 2 — User Identity

1. Call `request_api_access` with `domain: "mg.otherstuff.ai"` and a reason
2. Wait for browser approval
3. Call `sign_nip98` with `tier: "2"` to sign as the logged-in user

## API Endpoints

Base URL: `https://mg.otherstuff.ai` (configurable via `MG_BASE_URL` env var)

All task endpoints are scoped to a team:

```
{baseUrl}/t/{teamSlug}/api/todos/{taskId}
```

### Fetch a Task

```
GET /t/{teamSlug}/api/todos/{taskId}
```

Returns the full task object including title, description, state, assignee, and notes.

### Update Task State

```
POST /t/{teamSlug}/api/todos/{taskId}/state
Content-Type: application/json

{ "state": "in_progress" }
```

Valid states: `in_progress`, `review`, and others defined by the board.

### Working with the Task Board

1. **Get assigned tasks**: Fetch tasks where the assignee matches the Wingman npub or the user's npub
2. **Start work**: Move the task to `in_progress` via the state endpoint
3. **Read the brief**: Fetch the full task to get the description and any notes
4. **Do the work**: Execute the task in the specified working directory
5. **Report completion**: Move the task to `review` when done

## Example: Pick Up and Complete a Task

```
1. Sign:     sign_nip98(url="https://mg.otherstuff.ai/t/my-team/api/todos/42", method="GET", tier="1")
2. Fetch:    GET the task URL with the Authorization header — read the task description
3. Sign:     sign_nip98(url="https://mg.otherstuff.ai/t/my-team/api/todos/42/state", method="POST", tier="1")
4. Update:   POST { "state": "in_progress" } to mark the task as started
5. Work:     Execute the task (write code, fix bugs, etc.)
6. Sign:     sign_nip98(url="https://mg.otherstuff.ai/t/my-team/api/todos/42/state", method="POST", tier="1")
7. Complete: POST { "state": "review" } to move the task to review
```

## Nightwatch Integration

When Wingman receives a task via Nostr (kind 9802 event), the Nightwatch system automatically:

1. Starts a work session with the task prompt
2. When the work session stops, starts a Nightwatch review session
3. The reviewer reads the work session transcript and decides: **CONTINUE** or **COMPLETE**
4. On COMPLETE, the task is moved to `review` in Marginal Gains
5. On CONTINUE, a new instruction is sent and work resumes

This happens automatically — you don't need to manage the Nightwatch cycle manually.

## Tips

- The `teamSlug` and `taskId` come from the task assignment (Nostr event or task URL)
- NIP-98 tokens are valid ~60 seconds — reuse for multiple requests to the same URL/method
- If you don't know the team slug, ask the user or check the task URL format
- Tasks assigned via Nostr arrive as encrypted kind 9802 events with `taskUrl`, `taskId`, `teamSlug`, and `title`
- The task listener only activates when `KEYTELEPORT_PRIVKEY` and `CONNECT_RELAYS` are configured
