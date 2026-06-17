# Daily Scope Update - Autopilot Tickets

## Product Decision

Autopilot agents should interact with a human's Daily Scope through direct Flight Deck PG / Tower APIs. Do not use Yoke for this workflow.

Daily Scope is:

- one active note per human, workspace, and date
- readable/editable by the human and explicitly enabled agents only
- composed of a checklist of up to five focus items plus a narrative summary

The target morning flow:

1. Human records or sends a morning planning note.
2. Agent summarizes the narrative.
3. Agent extracts three to five daily focus items.
4. Agent writes the human's Daily Scope for the date.
5. Flight Deck updates through PG hydration/SSE.

## Ticket AP-DS-1: Daily Scope Agent Tooling

### Goal

Expose clean Autopilot-side tools/helpers for agents to read and write their human's Daily Scope.

### Required Capabilities

- Resolve the active workspace and human owner for an agent session.
- Read Daily Scope by:
  - workspace
  - owner human
  - date
- Upsert Daily Scope by:
  - workspace
  - owner human
  - date
  - checklist items
  - narrative body
  - optional focus string
  - source metadata
- Use NIP-98 signed requests to the Flight Deck PG / Tower API.
- Do not use Yoke or local Yoke caches.

### Suggested Tool Names

- `flightdeck_daily_scope_get`
- `flightdeck_daily_scope_upsert`

If current tool naming follows another convention, match the existing helper family but keep "daily scope" explicit.

### Acceptance Criteria

- An authorized agent can read the human's Daily Scope for a given date.
- An authorized agent can update narrative and checklist items.
- Unauthorized access returns a clear permission error from Tower and is surfaced to the agent.
- Tool responses include note id, owner, date, items, body, updated_by, and row version.

## Ticket AP-DS-2: Morning Note Extraction Prompt/Helper

### Goal

Provide a reusable agent workflow for converting a morning voice/text note into Daily Scope content.

### Required Behavior

- Input:
  - transcript or user text
  - optional existing Daily Scope
  - date
  - human owner
- Output:
  - narrative summary suitable for Daily Scope body
  - three to five checklist items
  - optional confidence and dropped/parked items
- Keep items concrete and checkable.
- Do not include every business task; choose what the human should focus on today.

### Acceptance Criteria

- Extraction returns no more than five checklist items.
- Existing completed items are not silently discarded.
- The helper can merge with an existing Daily Scope when the human adds more context later in the day.

## Ticket AP-DS-3: Agent Permission Awareness

### Goal

Make agents understand whether they are allowed to read/edit a human's Daily Scope.

### Required Behavior

- When a tool receives `daily_scope_forbidden` or equivalent, report that the human must enable Daily Scope access for this agent.
- Do not ask the agent to create groups or grants directly unless Tower exposes that as the intended admin/settings API.
- Avoid broad fallback behavior that writes a channel note or task instead of Daily Scope.

### Acceptance Criteria

- DevOps/background agents without access fail clearly.
- User-facing agents with the toggle enabled can operate normally.
- Error messages name Daily Scope access specifically.

## Ticket AP-DS-4: Pipeline/Session Integration

### Goal

Wire the Daily Scope tools into Autopilot sessions and any relevant pipeline prompts.

### Required Changes

- Add Daily Scope tools to the tool registry available to user-facing Flight Deck agents.
- Update relevant agent instructions to say:
  - Daily Scope is personal to the human
  - use direct Flight Deck PG APIs
  - do not use Yoke
  - keep checklist to five items or fewer
- Add or update pipeline examples only if the current pipeline system needs an explicit route for morning-note processing.

### Acceptance Criteria

- A normal agent session can call the Daily Scope get/upsert helpers.
- Pipeline-driven processing can update Daily Scope without manual browser interaction.
- Tests or smoke checks cover helper request construction and permission-error handling.

## Validation

- `bun --check` on touched TypeScript files
- focused `bun test` for helper/tool modules
- no server restart from inside an agent session unless explicitly requested

