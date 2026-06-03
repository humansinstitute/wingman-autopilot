# Pipeline Design Document URL Propagation Fix

## Problem

During the Flight Deck PG PH1-2 run, the software implementation review loop reached the manager step with `designDocumentUrl: null`.

The manager still completed the review by using the task work plan and worker handoff, but this weakens the pipeline contract. Implementation workers and reviewers should receive explicit supporting design/ticket artifact references whenever a task-backed implementation pipeline is dispatched.

Observed PH1-2 evidence:

- Parent task-intake run: `c6934dde-6c43-4354-b996-a53c410dd472`
- Child implementation-review run: `4ddda477-91a3-48f8-9b9b-b5607b93a73d`
- In that child run, `createdTask.workPlan.designDocumentUrl` was `null`
- Manager log noted: `The design reference is null in the selected input`

## Goal

Ensure task-backed software implementation pipelines preserve and pass an explicit design document or ticket reference into worker, manager, closeout, and final response steps.

## Expected Behavior

When a task-intake pipeline starts a `software-implementation-review-loop` child run:

1. If the originating task description includes a ticket/design artifact path, that path is passed as `designDocumentUrl`.
2. If the task has structured references to a document, ticket, or local artifact, the strongest artifact reference is passed as `designDocumentUrl`.
3. If no separate artifact exists, the pipeline should pass a deterministic fallback reference to the Flight Deck task itself or a generated task-context reference, rather than `null`.
4. Worker and manager selected input should show a non-empty `designDocumentUrl` or an explicit `designDocumentUnavailableReason`.
5. Final reporting should mention when review used a fallback task-context reference rather than a separate design document.

## Constraints

- Work in `/Users/mini/code/wingmanbefree/autopilot`.
- Do not change Tower, Flight Deck, Yoke, or Flight Deck PG implementation docs for this ticket unless required to verify the fix.
- Preserve backwards compatibility for existing pipeline definitions.
- Do not break no-task pipelines, discussion pipelines, or generic `do-and-review` runs.
- Keep task state/comment publication owned by existing deterministic pipeline steps.

## Likely Areas To Inspect

- `src/pipelines/default-definitions/agent-dispatch-task-response.json`
- `src/pipelines/default-definitions/software-implementation-review-loop.json`
- `src/pipelines/functions.ts`
- `src/pipelines/functions.test.ts`
- `src/pipelines/pipeline-loader.ts`
- `src/pipelines/pipeline-runner.ts`

## Acceptance Criteria

- A regression test proves task-intake to software-implementation-review child input includes a non-empty design/ticket reference when the task description contains a ticket path.
- A regression test proves worker/manager work plan data does not silently collapse to `designDocumentUrl: null`; if no artifact is available, an explicit unavailable reason or fallback task reference is present.
- The PH1-style task description format is covered, including a line like `Ticket: /Users/mini/code/wingmanbefree/flightdeck-pg/implementation/phase1/ticket_ph1_2_typed_api_contract_fixtures.md`.
- Focused pipeline tests pass.
- The implementation handoff clearly states whether the fix changes pipeline input shape, workPlan shape, or both.

## Suggested Validation

Run the smallest useful tests first:

```bash
cd /Users/mini/code/wingmanbefree/autopilot
bun --check src/pipelines/functions.ts src/pipelines/pipeline-loader.ts src/pipelines/pipeline-runner.ts
bun test src/pipelines/functions.test.ts src/pipelines/pipeline-loader.test.ts src/pipelines/pipeline-runner.test.ts
```

