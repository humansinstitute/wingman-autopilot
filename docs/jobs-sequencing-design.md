# Jobs Sequencing Design

Terminology note:

- This document uses the current product term `Jobs`.
- The implementation still uses legacy internal names such as `autopilot-jobs` in API routes and some modules.
- Treat those names as compatibility details, not as separate product concepts.

## Summary

Wingman's current jobs system is good at dispatching one worker and one manager for a single run, but sequencing is external. In practice that forced us to use a shell poller to chain work packages, which is not reliable enough for real delivery.

This design adds first-class sequencing to Wingman so a manager can finish one run, attach a handoff, and let Wingman dispatch the next work automatically. The design supports:

- linear chains
- manager-approved handoffs
- fan-out into parallel streams
- fan-in where downstream work waits for multiple predecessors
- per-node directory overrides
- visibility into why a downstream job has not started yet

The key model decision is unchanged: a job definition is a template, while sequencing belongs to runs and pipelines.

## Current State

Today the model is intentionally small:

- [`src/jobs-db.ts`](/Users/mini/code/wingmen/src/jobs-db.ts) stores `job_definitions` and `job_runs`
- [`clis/jobs-dispatch.ts`](/Users/mini/code/wingmen/clis/jobs-dispatch.ts) starts a worker + manager pair for one run
- [`clis/jobs-manager.ts`](/Users/mini/code/wingmen/clis/jobs-manager.ts) can read worker output, message the worker, and mark a run `complete` or `failed`

Current limitations:

- no native `next job`
- no dependency graph
- no persisted handoff between runs
- no branch/fan-out support
- no native visibility into blocked downstream work
- completed sessions are not automatically cleaned up

## Design Goals

- Keep the current single-run model intact.
- Make manager approval the normal trigger for downstream work.
- Support both simple linear chains and DAG-style execution.
- Persist sequencing state in SQLite so restart/resume is possible.
- Allow different directories per downstream node.
- Keep job status and pipeline status separate.

## Non-Goals

- Replacing the existing scheduler in this phase
- Building a generic workflow engine for arbitrary non-job tasks
- Hiding manager approval behind automatic polling

## Core Concepts

### 1. Job Definition

A reusable template for worker and manager prompts.

This remains the same conceptual object as today.

### 2. Job Run

A single dispatched execution of a job definition with one worker and one manager.

This remains the unit that becomes `running`, `complete`, `failed`, or `stopped`.

### 3. Pipeline Definition

A reusable graph of job nodes and dependency edges.

A pipeline definition answers:

- which jobs exist in the sequence
- which node depends on which predecessor
- whether downstream dispatch is automatic or manual
- which directory overrides apply per node

### 4. Pipeline Run

A concrete execution of a pipeline definition.

This is the object the user starts when they want a whole ordered set of work packages to progress under manager control.

### 5. Pipeline Node Run

The per-node runtime state inside a pipeline run.

Each node run points at a concrete `job_run` once dispatched, and tracks dependency satisfaction separately from the job run's own status.

### 6. Proceed State

This addresses the "don't trigger too early" problem.

The important distinction:

- `job_run.status = complete` means the worker/manager finished that run
- `pipeline_node_run.proceed_state = proceeding` means the completed output has been accepted into the pipeline handoff flow, but downstream work is not necessarily ready to start yet

This avoids overloading `job_runs.status` with DAG semantics it should not own.

Suggested `proceed_state` values:

- `none`
- `pending`
- `proceeding`
- `applied`

Example:

1. Node `A` completes
2. Manager approves it and records handoff
3. `A` becomes `job_run.status = complete`
4. `A`'s `pipeline_node_run.proceed_state = proceeding`
5. If downstream node `D` still waits on `B` and `C`, `D` stays blocked
6. Once all inbound gates are satisfied, `D` becomes ready and dispatches
7. `A` can move to `proceed_state = applied`

## Proposed Data Model

### Extend `job_definitions`

Add a simple linear convenience field:

- `next_job_id TEXT NULL`

This is useful for the MVP and for trivial linear chains. It should not be the only sequencing model.

### Extend `job_runs`

Add lineage and handoff fields:

- `parent_run_id TEXT NULL`
- `root_run_id TEXT NULL`
- `triggered_by_run_id TEXT NULL`
- `pipeline_run_id TEXT NULL`
- `pipeline_node_id TEXT NULL`
- `handoff_json TEXT NULL`
- `completed_at TEXT NULL`

Purpose:

- make linear chaining inspectable
- allow downstream runs to know their origin
- preserve structured handoff data

### New `job_pipeline_definitions`

Suggested fields:

- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `description TEXT NOT NULL DEFAULT ''`
- `enabled INTEGER NOT NULL DEFAULT 1`
- `max_parallelism INTEGER NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

### New `job_pipeline_nodes`

Each row represents one step in the graph.

Suggested fields:

- `pipeline_id TEXT NOT NULL`
- `node_id TEXT NOT NULL`
- `job_id TEXT NOT NULL`
- `label TEXT NOT NULL`
- `worker_dir TEXT NULL`
- `manager_dir TEXT NULL`
- `goal TEXT NULL`
- `prompt_append TEXT NULL`
- `manager_goal_override TEXT NULL`
- `refs_json TEXT NULL`
- `dispatch_mode TEXT NOT NULL DEFAULT 'auto'`
- `PRIMARY KEY (pipeline_id, node_id)`

`dispatch_mode` values:

- `auto`
- `manual`

### New `job_pipeline_edges`

Suggested fields:

- `pipeline_id TEXT NOT NULL`
- `from_node_id TEXT NOT NULL`
- `to_node_id TEXT NOT NULL`
- `on_status TEXT NOT NULL DEFAULT 'complete'`
- `required INTEGER NOT NULL DEFAULT 1`
- `PRIMARY KEY (pipeline_id, from_node_id, to_node_id, on_status)`

This gives fan-out and fan-in naturally.

### New `job_pipeline_runs`

Suggested fields:

- `id TEXT PRIMARY KEY`
- `pipeline_id TEXT NOT NULL`
- `status TEXT NOT NULL DEFAULT 'new'`
- `context_json TEXT NULL`
- `started_at TEXT NULL`
- `completed_at TEXT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

### New `job_pipeline_node_runs`

Suggested fields:

- `id TEXT PRIMARY KEY`
- `pipeline_run_id TEXT NOT NULL`
- `pipeline_id TEXT NOT NULL`
- `node_id TEXT NOT NULL`
- `job_run_id TEXT NULL`
- `status TEXT NOT NULL DEFAULT 'blocked'`
- `proceed_state TEXT NOT NULL DEFAULT 'none'`
- `waiting_on_json TEXT NULL`
- `handoff_json TEXT NULL`
- `ready_at TEXT NULL`
- `started_at TEXT NULL`
- `completed_at TEXT NULL`
- `updated_at TEXT NOT NULL`

Suggested `status` values:

- `blocked`
- `ready`
- `dispatching`
- `running`
- `complete`
- `failed`
- `stopped`
- `skipped`

`waiting_on_json` should contain unsatisfied parent node ids for explainability.

## CLI Design

## MVP: Linear Manager-Triggered Handoff

Extend [`clis/jobs-manager.ts`](/Users/mini/code/wingmen/clis/jobs-manager.ts):

```bash
bun clis/jobs-manager.ts complete <run-id> \
  --summary "..." \
  --dispatch-next \
  --handoff "..." \
  --next-job <job-id>
```

Behavior:

1. Mark current `job_run` complete
2. Save `handoff_json`
3. Resolve next job from `--next-job` or `job_definitions.next_job_id`
4. Dispatch next run via the existing dispatch path
5. Set lineage fields on the new run
6. Print both the completed run and the newly created run

This replaces the shell sequencer for linear chains.

## Full DAG Mode

Add a dedicated CLI:

```bash
bun clis/jobs-pipelines.ts create --file pipeline.json
bun clis/jobs-pipelines.ts show <pipeline-id>
bun clis/jobs-pipelines.ts start <pipeline-id> --context-file context.json
bun clis/jobs-pipelines.ts run-status <pipeline-run-id>
bun clis/jobs-pipelines.ts cancel <pipeline-run-id>
bun clis/jobs-pipelines.ts resume <pipeline-run-id>
```

Then extend manager completion:

```bash
bun clis/jobs-manager.ts complete <run-id> \
  --summary "..." \
  --proceed \
  --handoff-file handoff.json
```

`--proceed` means:

- mark the job run complete
- persist the handoff on the corresponding pipeline node run
- evaluate all outgoing edges
- mark dependent nodes `ready` only when their inbound requirements are satisfied
- dispatch all newly ready nodes subject to pipeline concurrency rules

## Dispatch Semantics

### Linear

If a run has one next step:

- manager completes the run
- Wingman immediately starts the next run

### Fan-Out

If a node has multiple downstream edges:

- completing the upstream node can dispatch several downstream nodes
- each downstream node gets its own worker and manager sessions
- each node can use a different directory override

Example:

- `A -> B`
- `A -> C`
- `A -> D`

When `A` proceeds successfully, `B`, `C`, and `D` can all dispatch in parallel.

### Fan-In

If a node has multiple required predecessors:

- it must not dispatch after only one predecessor completes
- each completed parent only satisfies part of the gate
- node remains `blocked` with `waiting_on_json` listing missing parents

Example:

- `B -> E`
- `C -> E`
- `D -> E`

If `B` completes first:

- `E` stays blocked
- `E.waiting_on_json = ["C", "D"]`

This is where `proceed_state` matters. `B` has proceeded, but `E` is not ready yet.

## Example Pipeline

For the group architecture rollout:

```text
WP1 -> WP2 -> WP3
WP3 -> WP4
WP3 -> WP5
WP3 -> WP6
WP4 -> WP8
WP5 -> WP8
WP6 -> WP8
WP3 -> WP7
WP7 -> WP8
```

This expresses:

- a linear early chain
- a branch after foundational signer work
- a final validation package that waits on multiple predecessor streams

## Runtime Algorithm

When a manager calls `complete --proceed`:

1. Load the `job_run`
2. Mark the `job_run` complete
3. Persist the manager summary and handoff
4. If not attached to a pipeline, optionally use `next_job_id`
5. If attached to a pipeline:
6. Mark the current node run `status = complete`
7. Mark `proceed_state = proceeding`
8. Evaluate outgoing edges
9. For each downstream node, recompute inbound dependency satisfaction
10. If a node is fully satisfied, mark it `ready`
11. Dispatch all ready nodes within `max_parallelism`
12. Set each dispatched node to `dispatching`, then `running`
13. Set the completed node's `proceed_state = applied`

This should happen in one SQLite transaction for state mutation, with dispatch happening immediately after commit.

## Failure Semantics

Default behavior:

- `failed` or `stopped` nodes block downstream required edges
- downstream nodes remain blocked
- pipeline run becomes `degraded` or `failed` depending on policy

Optional later feature:

- allow an edge to proceed on `failed`
- allow a node to be marked `optional`
- allow a manager override to skip a node and satisfy a dependency manually

These should not be in the first implementation.

## Observability

This design must be inspectable without reading shell logs.

Needed views:

- pipeline definition graph
- pipeline run graph with per-node state
- why a node is blocked
- which handoff unlocked a node
- which worker and manager sessions belong to each node run

CLI examples:

```bash
bun clis/jobs-pipelines.ts run-status pipe-run-123
bun clis/jobs-pipelines.ts explain pipe-run-123 WP8
```

`explain` should print something like:

```text
Node WP8 is blocked.
Satisfied parents: WP4, WP7
Waiting on: WP5, WP6
```

## Session Cleanup

When a run is terminal:

- manager can stop the worker session automatically
- manager session can stop once the handoff is recorded
- pipeline state should remain even after sessions are cleaned up

This should be opt-out rather than opt-in for pipeline-triggered runs.

## Directory Model

Per-node directory override is required.

Reasons:

- parallel streams may run in different repos
- validation work may need a top-level mono-repo root
- design/docs work may intentionally run in a docs repo while code work runs elsewhere

Priority order:

1. pipeline node override
2. dispatch CLI override
3. job definition default

## Recommended Implementation Phases

### Phase 1

Linear native sequencing:

- add `next_job_id`
- add run lineage fields
- add `handoff_json`
- add `complete --dispatch-next`

### Phase 2

Pipeline persistence:

- add pipeline definition/run tables
- add `jobs-pipelines.ts`
- add `complete --proceed`

### Phase 3

Observability and cleanup:

- explain blocked nodes
- auto-stop sessions on terminal runs
- resume and cancel flows

### Phase 4

Advanced policies:

- optional edges
- skip/override commands
- concurrency caps per branch
- manual gates

## Recommendation

Build this in two layers:

1. ship linear manager-triggered `next_job_id` first
2. then add pipeline DAG support with node-level `proceed_state`

That gives an immediate replacement for shell sequencing while leaving room for the larger model you described: one start, then multiple parallel streams of work packages across different directories, all still controlled by manager approval and explicit dependency gates.
