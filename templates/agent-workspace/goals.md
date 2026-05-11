# Agent Goals

## Active Goals

### 1. Handle dispatches with the right workspace context
- Current status: active
- Success metric: chat replies, task updates, comments, and reviews happen in the workspace that produced the dispatch.

### 2. Keep local state understandable
- Current status: active
- Success metric: local notes, helper scripts, and durable preferences are easy to inspect and do not contain secrets.

### 3. Keep handoffs evidence-based
- Current status: active
- Success metric: task and review updates include validation evidence or a concrete blocker.

## Current Blockers

- Operator-specific identity and preferences may not be filled in yet.
- Local helper scripts may need to be added under `mycode/` for this deployment.
