# Nightwatchman - Autonomous Task Delivery System

## Overview

Nightwatchman is a delivery orchestration system that enables wingmen to reliably execute tasks from external systems (initially Marginalgains) with guaranteed completion reporting. It introduces two key concepts:

1. **Delivery** - A first-class orchestration unit that owns an entire task workflow
2. **Nightwatchman** - A supervisor session that reviews work and decides whether to continue or complete

## Problem Statement

When an external system (Marginalgains) sends a task to wingmen:
- The working agent may forget to report completion
- The agent may stop prematurely without finishing
- There's no visibility into progress or decision-making
- Hung sessions create orphaned tasks

## Solution

The Delivery abstraction guarantees completion reporting by:
1. Tracking all sessions associated with a task
2. Automatically triggering Nightwatchman review when work sessions stop
3. Parsing Nightwatchman decisions and acting on them
4. Always calling back to the source system with status updates

---

## Concepts

### Delivery

A Delivery is the orchestration unit for an external task. It:
- Owns the work session and all nightwatchman review sessions
- Tracks state, review count, and enforces limits
- Guarantees callback to the source system
- Handles errors and edge cases

### Nightwatchman

A Nightwatchman is a supervisor session that:
- Reviews the transcript of a stopped work session
- Decides: CONTINUE (with instruction) or COMPLETE (with summary)
- Has a single, focused job - making reliable decisions
- Runs in the **same working directory** as the work session (can read code, check git, verify changes)

### Work Session

The session that performs the actual task work. May stop and resume multiple times based on Nightwatchman decisions.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                        MARGINALGAINS                            │
│                                                                 │
│  Task: "Fix login bug"                                         │
│  ├── State: in_progress                                        │
│  ├── Assigned: wingman_npub                                    │
│  └── Notes:                                                    │
│      ├── Session started [link]                                │
│      ├── Review 1: CONTINUE "run tests" [link]                 │
│      ├── Review 2: COMPLETE "bug fixed" [link]                 │
│      └── → moved to review                                     │
│                                                                 │
└─────────────────────────┬──────────────────────────────────────┘
                          │
         POST /api/deliveries (start)
         POST /api/wingman/callback (updates)
                          │
┌─────────────────────────▼──────────────────────────────────────┐
│                         WINGMEN                                 │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                      DELIVERY                            │   │
│  │                                                          │   │
│  │  id: "del_abc123"                                       │   │
│  │  status: working → reviewing → working → delivered       │   │
│  │                                                          │   │
│  │  ┌────────────┐    ┌──────────────┐                     │   │
│  │  │   Work     │───▶│ Nightwatch 1 │                     │   │
│  │  │  Session   │    │   (review)   │                     │   │
│  │  └────────────┘    └──────┬───────┘                     │   │
│  │        ▲                  │ CONTINUE                    │   │
│  │        │                  │                             │   │
│  │        └──────────────────┘                             │   │
│  │        │                                                │   │
│  │        ▼                                                │   │
│  │  ┌────────────┐    ┌──────────────┐                     │   │
│  │  │   Work     │───▶│ Nightwatch 2 │                     │   │
│  │  │  (resumed) │    │   (review)   │                     │   │
│  │  └────────────┘    └──────┬───────┘                     │   │
│  │                           │ COMPLETE                    │   │
│  │                           ▼                             │   │
│  │                    [Callback to MG]                     │   │
│  │                                                          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Models

### Delivery

```typescript
interface Delivery {
  id: string;                     // "del_" + uuid

  // Source system details
  source: {
    type: "marginalgains";        // extensible for other systems
    taskId: string;
    callbackUrl: string;          // https://mg.otherstuff.ai/api/wingman/callback
    callbackSecret: string;
    taskLabel: string;
    taskDescription: string;
  };

  // Execution config
  agent: AgentType;               // "claude" | "goose" | etc
  workingDirectory: string;

  // Session tracking
  workSessionId: string;
  nightwatchSessions: string[];   // ordered list of review session IDs

  // State machine
  status: DeliveryStatus;
  reviewCount: number;
  maxReviews: number;             // default: 3

  // Outcome
  finalDecision?: "complete" | "max_reviews" | "error";
  finalSummary?: string;

  // Timestamps
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
}

type DeliveryStatus =
  | "working"      // work session is running
  | "reviewing"    // nightwatchman is reviewing
  | "continuing"   // sending continue instruction to work session
  | "delivered"    // callback sent, workflow complete
  | "failed";      // unrecoverable error
```

### Delivery Store

```typescript
// Storage: data/deliveries.db (SQLite)

interface DeliveryStore {
  create(input: CreateDeliveryInput): Delivery;
  get(id: string): Delivery | null;
  getByWorkSession(sessionId: string): Delivery | null;
  update(id: string, updates: Partial<Delivery>): Delivery;
  list(filters?: { status?: DeliveryStatus }): Delivery[];
  addNightwatchSession(deliveryId: string, sessionId: string): void;
}
```

---

## API Design

### Create Delivery

**Endpoint:** `POST /api/deliveries`

**Request:**
```typescript
{
  source: {
    type: "marginalgains",
    taskId: string,
    callbackUrl: string,
    callbackSecret: string,
    taskLabel: string,
    taskDescription: string
  },
  agent: "claude" | "goose" | "codex" | "opencode",
  workingDirectory: string,
  maxReviews?: number              // default: 3
}
```

**Response:**
```typescript
{
  delivery: {
    id: string,
    status: "working",
    workSessionId: string,
    workSessionLink: string        // /live/{sessionId}
  }
}
```

**Behavior:**
1. Creates Delivery record
2. Starts work session with task prompt
3. Returns immediately (async workflow)

### Get Delivery

**Endpoint:** `GET /api/deliveries/:id`

**Response:**
```typescript
{
  delivery: Delivery,
  sessions: {
    work: SessionSnapshot,
    nightwatch: SessionSnapshot[]
  }
}
```

### List Deliveries

**Endpoint:** `GET /api/deliveries`

**Query params:** `?status=working|reviewing|delivered|failed`

**Response:**
```typescript
{
  deliveries: Delivery[]
}
```

### Cancel Delivery

**Endpoint:** `DELETE /api/deliveries/:id`

**Behavior:**
1. Stops any running sessions
2. Sends callback with `decision: "cancelled"`
3. Sets status to `failed`

---

## Callback Protocol

### Marginalgains Callback Endpoint

**Endpoint:** `POST {callbackUrl}` (e.g., `https://mg.otherstuff.ai/api/wingman/callback`)

**Request:**
```typescript
{
  // Authentication
  secret: string,

  // Task reference
  taskId: string,
  deliveryId: string,

  // Decision
  decision: "continue" | "complete" | "error" | "max_reviews" | "cancelled",
  summary: string,                 // instruction if continue, summary if complete

  // Session links
  workSessionId: string,
  workSessionLink: string,
  decisionSessionId?: string,      // nightwatch session that made this decision
  decisionSessionLink?: string,

  // Progress
  reviewNumber: number,
  maxReviews: number
}
```

**Expected Response:** `200 OK`

### Callback Triggers

| Event | Decision | Summary |
|-------|----------|---------|
| Nightwatch reports CONTINUE | `continue` | The nextStep instruction |
| Nightwatch reports COMPLETE | `complete` | Work summary from agent |
| Review count exceeds max | `max_reviews` | "{summary}. Unfinished: {nextStep}" |
| Work session error | `error` | Error description |
| Work session unresumable | `error` | "Could not resume work session" |
| Delivery cancelled | `cancelled` | "Delivery cancelled by user" |
| Nightwatch timeout (no report) | `error` | "Nightwatch session ended without reporting decision" |
| MCP validation failure | `error` | Validation error message |

---

## Nightwatchman MCP Tool

Rather than parsing free-form text output, Nightwatchman reports decisions via an MCP tool exposed by Wingman. This provides:

- **Schema-enforced structure** - Agent must provide required fields or the call fails
- **Local call** - No network complexity for the agent, just a tool call
- **Centralized callback handling** - Wingman owns API keys, retries, error handling
- **Confirmation loop** - Tool returns success/failure, agent knows it's done

### MCP Tool Endpoint

**Endpoint:** `POST /api/nightwatch/report`

This endpoint is exposed to Nightwatchman sessions as an MCP tool.

### Tool Schema

```typescript
{
  name: "report_decision",
  description: "Report your review decision for this task. You MUST call this tool to complete your review.",
  inputSchema: {
    type: "object",
    required: ["decision", "summary"],
    properties: {
      decision: {
        type: "string",
        enum: ["continue", "complete"],
        description: "Whether the task needs more work or is complete"
      },
      summary: {
        type: "string",
        description: "What was accomplished so far in the work session"
      },
      nextStep: {
        type: "string",
        description: "Specific instruction for what to do next. Required if decision=continue"
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "How confident you are in this assessment"
      },
      blockers: {
        type: "array",
        items: { type: "string" },
        description: "Any issues or blockers identified during review"
      }
    }
  }
}
```

### Request Payload

```typescript
interface NightwatchReport {
  // Injected by Wingman (not from agent)
  deliveryId: string;
  sessionId: string;

  // From agent via MCP tool
  decision: "continue" | "complete";
  summary: string;
  nextStep?: string;           // required if decision=continue
  confidence?: "high" | "medium" | "low";
  blockers?: string[];
}
```

### Response

```typescript
// Success
{
  success: true,
  message: "Decision recorded. You may end your session."
}

// Validation error
{
  success: false,
  error: "nextStep is required when decision is 'continue'"
}
```

### Nightwatchman Prompt

```markdown
You are a Nightwatchman reviewing a work session.

## Task
**{taskLabel}**

{taskDescription}

## Session Transcript
{formatted messages from work session}

---

## Your Job

Review the transcript and decide if the task is complete.

You have access to the `report_decision` tool. You MUST call this tool to submit your decision.

**If work is incomplete or stopped prematurely:**
- decision: "continue"
- summary: What was accomplished so far
- nextStep: Specific instruction for what to do next (required)
- confidence: Your confidence level

**If work is complete:**
- decision: "complete"
- summary: What was accomplished (2-3 sentences)
- confidence: Your confidence level

Call the tool now with your decision.
```

### Decision Flow

```
Nightwatchman Session
        │
        │ reviews transcript
        │
        ▼
   calls MCP tool: report_decision({
     decision: "continue",
     summary: "Implemented auth flow, tests not yet run",
     nextStep: "Run the test suite and fix any failures",
     confidence: "high"
   })
        │
        ▼
   POST /api/nightwatch/report
        │
        ├── validates payload (nextStep required for continue)
        ├── updates delivery state
        ├── sends callback to Marginalgains (with retries)
        └── returns { success: true } to agent
        │
        ▼
   Agent session ends cleanly
```

---

## Workflow State Machine

```
                    ┌─────────────────────────────────────┐
                    │                                     │
                    ▼                                     │
┌─────────┐    ┌─────────┐    ┌───────────┐    ┌─────────┴───┐
│ created │───▶│ working │───▶│ reviewing │───▶│ continuing  │
└─────────┘    └─────────┘    └───────────┘    └─────────────┘
                    │              │
                    │              │ COMPLETE or max_reviews
                    │              ▼
                    │         ┌───────────┐
                    │         │ delivered │
                    │         └───────────┘
                    │
                    │ error
                    ▼
               ┌─────────┐
               │ failed  │
               └─────────┘
```

### State Transitions

| Current State | Event | Next State | Action |
|---------------|-------|------------|--------|
| created | work session starts | working | - |
| working | work session stops | reviewing | start nightwatch |
| working | work session errors | failed | callback with error |
| reviewing | MCP report: continue | continuing | callback, send instruction |
| reviewing | MCP report: complete | delivered | callback with summary |
| reviewing | nightwatch ends without report | failed | callback with error |
| reviewing | MCP validation fails | failed | callback with error |
| reviewing | review count > max | delivered | callback with max_reviews |
| reviewing | nightwatch session errors | failed | callback with error |
| continuing | instruction sent | working | - |
| continuing | work session unresumable | failed | callback with error |
| continuing | send fails | failed | callback with error |

---

## Implementation Plan

### Phase 1: Delivery Store

**Files:**
- `src/storage/delivery-store.ts` - SQLite store for deliveries

**Tasks:**
1. Define Delivery interface and types
2. Create DeliveryStore class with CRUD operations
3. Add SQLite schema for deliveries table
4. Add index on workSessionId for lookup

### Phase 2: Delivery API

**Files:**
- `src/deliveries/delivery-api.ts` - API handlers
- `src/server.ts` - Route registration

**Tasks:**
1. POST /api/deliveries - create delivery + start work session
2. GET /api/deliveries/:id - get delivery with sessions
3. GET /api/deliveries - list deliveries
4. DELETE /api/deliveries/:id - cancel delivery

### Phase 3: Nightwatch MCP Endpoint

**Files:**
- `src/deliveries/nightwatch-handler.ts` - Core orchestration logic
- `src/server.ts` - Route registration for MCP endpoint

**Tasks:**
1. Implement `POST /api/nightwatch/report` endpoint
2. Validate incoming report (require nextStep for continue)
3. Hook into session-stopped event (for timeout detection)
4. Check if session belongs to a delivery
5. Start nightwatch session with MCP tool configured
6. Handle report reception and execute decision

### Phase 4: Callback System

**Files:**
- `src/deliveries/callback-service.ts` - Callback execution

**Tasks:**
1. Build callback payload
2. Send HTTP POST to callback URL
3. Handle callback failures (retry? log?)
4. Update delivery status on callback success

### Phase 5: Continuation Logic

**Files:**
- `src/deliveries/continuation-service.ts` - Resume work sessions

**Tasks:**
1. Send message to stopped work session
2. Handle "session can't be resumed" case
3. Update delivery state

### Phase 6: Error Handling & Edge Cases

**Tasks:**
1. Nightwatch timeout (session ends without calling report_decision)
2. MCP validation errors (missing nextStep, invalid decision)
3. Work session exits with error code
4. Callback URL unreachable
5. Max reviews enforcement
6. Delivery cancellation

---

## Marginalgains Integration

### Required Changes in Marginalgains

1. **Wingman npub configuration**
   - Store wingman's npub in config/env
   - Used when assigning tasks to wingman

2. **"Send to Wingman" action**
   - UI button or API endpoint
   - Calls wingmen POST /api/deliveries
   - Updates task: adds note, moves to in_progress, assigns to wingman

3. **Callback endpoint**
   - POST /api/wingman/callback
   - Validates secret
   - Appends note to task with decision details
   - If CONTINUE: just record (wingmen handles continuation)
   - If COMPLETE/MAX_REVIEWS: move task to review

4. **Task notes structure**
   - Append structured notes for each callback
   - Include session links for traceability

### Example Task Lifecycle

```
1. User clicks "Send to Wingman" on task "Fix login bug"

2. Marginalgains:
   - POST wingmen/api/deliveries
   - Receives: { deliveryId, workSessionId, workSessionLink }
   - Updates task:
     - State: in_progress
     - Assigned: wingman_npub
     - Note: "Sent to Wingman - Session: [link]"

3. Work session runs, stops

4. Wingmen starts Nightwatch, reviews, decides CONTINUE

5. Wingmen callbacks Marginalgains:
   - { decision: "continue", summary: "Need to run tests", ... }

6. Marginalgains:
   - Appends note: "Review 1: CONTINUE - Need to run tests [decision link]"

7. Wingmen sends continue instruction to work session

8. Work session resumes, runs, stops

9. Wingmen starts Nightwatch, reviews, decides COMPLETE

10. Wingmen callbacks Marginalgains:
    - { decision: "complete", summary: "Fixed auth bug, tests passing", ... }

11. Marginalgains:
    - Appends note: "Review 2: COMPLETE - Fixed auth bug, tests passing [link]"
    - Moves task to: review
```

---

## Configuration

### Environment Variables

```bash
# Nightwatch settings
NIGHTWATCH_AGENT=claude              # Agent to use for nightwatch reviews
NIGHTWATCH_MAX_REVIEWS=3             # Default max reviews per delivery
NIGHTWATCH_TIMEOUT_MS=300000         # 5 min timeout for nightwatch sessions

# Callback settings
CALLBACK_RETRY_ATTEMPTS=3            # Retry failed callbacks
CALLBACK_RETRY_DELAY_MS=5000         # Delay between retries
```

### Shared Secret

The callback secret should be configured in both systems:
- Wingmen: passed in delivery creation
- Marginalgains: stored in env, validated on callback

---

## Security Considerations

1. **Callback authentication**
   - Shared secret in callback payload
   - Consider HMAC signature for additional security

2. **Localhost assumption**
   - Initial design assumes same-host deployment
   - For remote deployment, add HTTPS requirement

3. **Session access**
   - Delivery sessions inherit user permissions
   - Nightwatch sessions should be internal/system-owned

---

## Future Enhancements

1. **Multiple source systems**
   - Generalize beyond Marginalgains
   - Plugin architecture for different callback protocols

2. **Custom nightwatch prompts**
   - Allow source system to provide custom review criteria
   - Task-specific completion definitions

3. **Progress callbacks**
   - Periodic updates during long-running work sessions
   - Not just on session stop

4. **Parallel work sessions**
   - Multiple workers on same delivery
   - Nightwatch coordinates/merges results

5. **Learning from reviews**
   - Track which agents need more continues
   - Optimize agent selection based on task type
