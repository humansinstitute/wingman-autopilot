# Chat Thread Dispatch To Flow From The Message Menu

Status: step-3 review artifact
Last updated: 2026-04-22
Primary artifact for flow run `4ce96e09-fc64-47a7-971b-f59e9cec7dd0`

## Artifact Resolution

- The original step text referred to `/Users/mini/code/wingmen/docs/design/chat-thread-dispatch-to-flow.md`.
- That path does not exist in the live repo.
- The run contract and downstream tasks consistently consume `/Users/mini/code/wingmen/docs/feature-chat-thread-dispatch-to-flow.md`.
- This file is therefore the canonical design and handoff artifact for the design-review flow.

## Review Outcome

The earlier draft was no longer implementation-ready. It assumed new work in
`src/app.js`, proposed helper placement that does not match the live Flight
Deck tree, and stopped mid-section before closing the fallback guidance.

This revised document reflects the code that already exists in
`/Users/mini/code/wingmanbefree/wingman-fd` and turns the brief into the
contract that downstream implementation, validation, and approval work should
use.

Core decision:

- Flight Deck owns the chat UI entry points, canonical-thread resolution,
  deterministic kickoff-preview generation, scope resolution, and kickoff-task
  creation.
- Wingmen owns runtime orchestration after the kickoff task exists.
- The feature remains valid only if Flight Deck emits a normal kickoff task
  that the existing Wingmen `Flow Dispatch` matcher already understands.

## Cross-Repo Responsibility Split

### Flight Deck responsibilities

- Expose `Dispatch to flow` from all three chat message action surfaces:
  main-feed message, thread parent, and thread reply.
- Resolve the canonical thread from the full channel message set, not from
  visible slices.
- Generate the kickoff description locally and deterministically.
- Let the operator choose a flow, optionally override scope, edit launch notes,
  and manually edit the generated preview.
- Preserve dirty/stale preview semantics so metadata changes do not silently
  overwrite manual edits.
- Materialize a single kickoff task with consistent scope, share, and
  write-group metadata.
- Keep the existing plain `Start Flow Run` path intact.

### Wingmen responsibilities

- Continue matching kickoff tasks with:
  - `flow_id != null`
  - `flow_run_id == null`
  - `state = new`
  - assignment to the dispatch bot
- Treat the kickoff description body as the source of truth for chat
  provenance in v1.
- Convert the kickoff task into the flow parent, stamp `flow_run_id`, append
  run-graph context after the existing description, and create child tasks.
- Use predecessor-aware orchestration for downstream promotion.
- Avoid introducing a new record family or special runtime pathway for this
  feature.

## Live Implementation Inventory

The relevant Flight Deck implementation is already split across focused files.
That structure should be preserved.

### `/Users/mini/code/wingmanbefree/wingman-fd/index.html`

Already contains:

- `Dispatch to flow` actions on:
  - main-feed message actions
  - thread parent actions
  - thread reply actions
- a dedicated modal at `data-testid="chat-thread-flow-dispatch-modal"`
- explicit controls for:
  - flow selection
  - manual scope override
  - source provenance summary
  - launch notes
  - preview regeneration
  - stale-preview warning
  - editable kickoff preview

### `/Users/mini/code/wingmanbefree/wingman-fd/src/chat-message-manager.js`

Already owns the UI orchestration methods:

- `openChatThreadFlowDispatch(recordId, sourceSurface)`
- `closeChatThreadFlowDispatch()`
- `resolveDispatchThread(recordId)`
- `syncChatThreadFlowDispatchScopeResolution()`
- `handleChatThreadFlowDispatchInputsChanged()`
- `regenerateChatThreadFlowDispatchPreview()`
- `markChatThreadFlowDispatchPreviewEdited()`
- `submitChatThreadFlowDispatch()`

This is the correct place for Alpine-facing state mutation and modal lifecycle
work. Do not move this feature into `app.js`.

### `/Users/mini/code/wingmanbefree/wingman-fd/src/chat-thread-flow-dispatch.js`

Already contains the pure helpers and dedicated state factory:

- `createChatThreadFlowDispatchState()`
- `resolveChatThreadFlowDispatchThread(messages, recordId)`
- `resolveChatThreadFlowDispatchScope(...)`
- `normalizeChatThreadFlowDispatchScopeAssignment(...)`
- `buildChatThreadFlowDispatchPreview(...)`
- `getChatThreadFlowDispatchScopeSourceLabel(...)`

This file is the correct home for pure preview-formatting and
chat-thread-dispatch-specific state helpers.

### `/Users/mini/code/wingmanbefree/wingman-fd/src/flows-manager.js`

Already keeps plain flow start intact through `startFlowRun(...)` and adds the
dedicated kickoff wrapper:

- `startChatThreadFlowDispatch({ ... })`

This wrapper is the correct boundary between chat-origin UI state and task
record creation.

### `/Users/mini/code/wingmanbefree/wingman-fd/src/task-flow-helpers.js`

Still provides shared kickoff-task helpers that the chat-origin path should
continue to reuse:

- `resolveFlowKickoffAssignee(...)`
- `buildStoredFlowKickoffScopeAssignment(...)`
- `buildFlowKickoffTaskRecord(...)`

### `/Users/mini/code/wingmanbefree/wingman-fd/src/task-board-state.js`

Still provides `buildTaskBoardAssignment(scopeId, fallbackTask)`, which remains
the right way to rebuild a complete scoped payload for manual-override,
channel-scope, and unscoped paths.

## Flight Deck Contract

### User-visible flow

1. User opens the message action menu from a main-feed message, thread parent,
   or thread reply.
2. User selects `Dispatch to flow`.
3. Flight Deck resolves the canonical thread and source channel.
4. Flight Deck opens the dedicated dispatch modal.
5. User selects a flow and can optionally override scope.
6. Flight Deck derives the effective scope and generates the kickoff preview.
7. User can edit launch notes and can manually edit the preview body.
8. Confirming dispatch creates exactly one kickoff task and stops.
9. Wingmen later picks up that kickoff task through existing flow dispatch.

### Canonical thread rules

Flight Deck must:

- read from the full `this.messages` collection
- exclude `record_state === 'deleted'`
- resolve the thread root from `parent_message_id`
- include the root message plus all direct replies to that root
- sort transcript messages oldest to newest by timestamp
- preserve literal message bodies
- preserve attachments only as a count suffix on the transcript header line

The modal must show:

- clicked message id
- canonical thread root id
- thread message count
- source surface
- selected flow
- resolved scope

### Preview lifecycle rules

- If the preview is not dirty, metadata changes regenerate the preview.
- Metadata changes include flow selection, manual scope override, and launch
  notes edits.
- After a manual preview edit, Flight Deck must set the preview dirty flag.
- If metadata changes after the preview becomes dirty, Flight Deck must mark
  the preview stale and warn the operator instead of silently overwriting the
  text.
- `Regenerate preview` must clear dirty/stale state by replacing the preview
  with a fresh deterministic render.

## Kickoff Task Contract

The record Flight Deck writes must remain a normal kickoff task.

Required stored fields:

- `title = selected flow title`
- `description = generated or manually edited preview`
- `state = new`
- `priority = rock`
- `parent_task_id = null`
- `assigned_to_npub = defaultAgentNpub || botNpub`
- `flow_id = selected flow id`
- `flow_run_id = null`
- `flow_step = null`
- `tags` includes `flow_kickoff`
- `references` includes `{ type: 'flow', id: <flowId> }`
- `scope_id` through `scope_l5_id` come from the resolved scope assignment
- `scope_policy_group_ids`, `group_ids`, `shares`, and `board_group_id` remain
  self-consistent with that assignment

Current wrapper shape in `flows-manager.js`:

```ts
startChatThreadFlowDispatch({
  flowId,
  resolvedScopeId,
  scopeSource,
  resolvedScopeAssignment,
  kickoffDescription,
})
```

V1 does not add structured task references for clicked message id, thread root
id, or channel id. Those values live inside the kickoff description body.

## Kickoff Description Contract

Preview generation lives in
`/Users/mini/code/wingmanbefree/wingman-fd/src/chat-thread-flow-dispatch.js`.
The output must remain deterministic and locally generated.

Required top-level sections, in this order:

1. `## Dispatch Request`
2. `## Source Provenance`
3. `## Launch Notes`
4. `## Dispatch Brief`
5. `## Thread Transcript`

Required `Dispatch Request` fields:

- `dispatch_type`
- `dispatched_from`
- `dispatched_at`
- `selected_flow_id`
- `selected_flow_title`
- `source_surface`
- `scope_resolution`
- `resolved_scope_id`
- `transcript_truncated`
- `omitted_message_count`

Required `Source Provenance` fields:

- `workspace_owner_npub`
- `channel_id`
- `thread_id`
- `clicked_message_id`
- `thread_message_count`
- `channel_scope_id`
- `flow_scope_id`

Launch-notes rules:

- render operator text literally
- render `None.` when blank after trimming

Dispatch-brief rules:

- keep the boilerplate stable
- explicitly say that preserved provenance and the literal transcript are the
  source of truth
- explicitly instruct downstream work to preserve repo paths, artifact paths,
  constraints, and acceptance criteria already present in the source thread

Transcript rules:

- fence transcript output with `~~~text`
- render one header line per message containing:
  - ISO timestamp
  - sender label
  - message id
  - optional attachment-count suffix
- render the literal body immediately below that header line
- if truncation is needed, always preserve:
  - the canonical root message
  - the clicked message
  - then add as many most-recent remaining messages as fit

The current implementation uses a maximum description length of `20000`
characters.

## Scope Resolution Contract

Effective scope precedence:

1. manual override from the modal
2. scope attached to the selected flow
3. scope attached to the source channel
4. unscoped fallback

Displayed labels:

- `Manual override`
- `Flow scope`
- `Channel scope`
- `No scope`

Materialization rules:

- If the effective source is `flow`, reuse the flow-scoped payload through
  `buildStoredFlowKickoffScopeAssignment(flow)`.
- If the effective source is `override` or `channel`, rebuild the full scope
  payload via `buildTaskBoardAssignment(...)` and normalize it before writing
  the task.
- If the effective source is `none`, use the unscoped assignment path and do
  not leak stale flow group ids or shares into the kickoff task.
- Never combine a new `scope_id` with stale `group_ids`, `shares`,
  `scope_policy_group_ids`, or `board_group_id`.

## Wingmen Runtime Contract

No Wingmen production change is required for the feature itself if Flight Deck
continues emitting the kickoff task shape above.

The feature is only correct if Wingmen continues to:

- match the kickoff task as standard `Flow Dispatch`
- preserve the kickoff description when converting the task into the flow
  parent
- append run-graph detail after the existing kickoff description
- create child tasks and approval tasks normally
- use predecessor-aware promotion rather than step-number guesses

The governing runtime contract remains:

- `/Users/mini/code/wingmen/docs/design/flight-deck-flow-dispatch-contract.md`

## Validation And Tests

The test plan is no longer hypothetical. The following Flight Deck suites
already cover the feature and should be treated as the minimum regression set:

- `tests/chat-thread-flow-dispatch.test.js`
- `tests/chat-message-manager.test.js`
- `tests/flows-chat-thread-dispatch.test.js`
- `tests/flows-step-types.test.js`
- `tests/flow-run-task-ux.test.js`
- `tests/flow-reference-linkage.test.js`

Recommended commands from
`/Users/mini/code/wingmanbefree/wingman-fd`:

- `bun test tests/chat-thread-flow-dispatch.test.js`
- `bun test tests/chat-message-manager.test.js`
- `bun test tests/flows-chat-thread-dispatch.test.js`
- `bun test tests/flows-step-types.test.js`
- `bun test tests/flow-run-task-ux.test.js`
- `bun test tests/flow-reference-linkage.test.js`
- `bun run test`
- `bun run build`

Manual validation still required:

- dispatch from a main-feed message
- dispatch from a thread parent
- dispatch from a thread reply
- confirm the same canonical thread is used from all three entry points
- confirm scope precedence works for manual, flow, channel, and unscoped paths
- manually edit the preview, then change flow or scope and confirm stale state
  is shown instead of silent overwrite
- confirm the resulting kickoff task is consumed by the existing Wingmen flow
  dispatch path

## Remaining Risks

- Description-body provenance is acceptable for v1 but is not query-friendly
  for later operator tooling.
- Cross-scope dispatch remains the sharpest correctness risk because it changes
  scope lineage, group ids, shares, and write-group selection together.
- If future work moves this logic back into `app.js`, the codebase will regress
  on the repo guidance to keep long files split into feature-focused modules.
- Transcript truncation is deterministic today, but unusually large threads can
  still force omission of older context; operators need the warning fields in
  the preview body to stay accurate.

## Handoff Guidance

Downstream work should treat this feature as an integration and validation task,
not as a greenfield design. The UI entry points, preview builder, modal state,
and kickoff wrapper already exist in Flight Deck. Remaining work, if any,
should be limited to:

- tightening regressions
- correcting runtime mismatches discovered in manual validation
- copying the finalised brief into the expected Flight Deck-side doc location if
  that remains part of the later flow step
