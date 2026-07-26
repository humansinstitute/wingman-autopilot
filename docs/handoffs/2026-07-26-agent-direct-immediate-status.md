# Agent Direct immediate lifecycle status

Implement immediate user-visible status for Agent Direct chat dispatches.

## Requested sequence

1. `Message received` when Autopilot accepts the inbound Agent Direct message.
2. `Thinking` when the agent session has been opened.
3. Existing streamed thinking/activity messages when the agent runtime starts reacting.

These states should appear as one continuous lifecycle in the same Flight Deck thinking/activity component. They are transient activity, not ordinary persisted chat messages.

## Source and reporting

- Workspace: Wingman Autopilot project
- Scope: current features scope
- Task: `@[Show immediate Agent Direct receipt and thinking status](mention:task:e7d52920-96c0-42da-a679-7c38cfb13bc5)`
- Origin: `@[Message](mention:message:1cc2181d-6351-4674-abc1-dbf92c4debe7)`
- Thread: `ebe0b589-fc1f-4cbe-8bfa-ae6411093699`
- Report implementation evidence on the Flight Deck task created for this request. Do not reply to the chat directly; Rick owns thread updates.

## Acceptance criteria

- Receipt status is observable immediately after Autopilot accepts the dispatch, before session startup completes.
- Session-open status advances to `Thinking` without creating a second unrelated UI row.
- Existing streamed thinking naturally supersedes the placeholder status.
- Retry, SSE reconnect, and event replay do not produce duplicate status rows or regress lifecycle order.
- Session-create/dispatch failure clears or replaces the transient state with an accurate failure signal; it cannot remain stuck on `Thinking`.
- Existing final reply delivery remains unchanged.
- Focused tests cover ordering, deduplication/replay, and failure cleanup.

## Work rules

- Work in `/Users/mini/code/wingmanbefree/autopilot` on `main` unless live evidence requires otherwise.
- Inspect the full worktree first. Preserve concurrent changes and do not discard anything you do not understand.
- Commit all nonignored tested state in the Autopilot worktree when complete.
- Stay in Autopilot unless evidence proves `wm-fd-2` needs a companion consumer change. If so, report that scope expansion on the task before editing the second repo.
- Do not deploy, restart Autopilot, or restart any managed app.
- Run focused tests plus relevant broader tests/typechecks.
