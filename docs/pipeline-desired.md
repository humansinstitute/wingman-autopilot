# Pipeline Desired State

This document captures the desired direction for Flight Deck Dispatch pipelines. It starts with chat only.

## Chat Pipelines Desired State

Chat dispatch should feel like a conversation first. The user sends a message, the bot quickly acknowledges receipt, then either answers in the thread or creates a task only when the request requires durable output.

### Intent Model

The initial chat intent should be obvious and small:

| Intent | Meaning | Task? |
| --- | --- | --- |
| `answer_now` | The message can be answered directly from current context. | No |
| `think_then_answer` | The response needs more reasoning, research, context loading, or multiple internal steps, but the final output is still a chat answer. | No |
| `create_task` | The user wants durable/physical output such as code, docs, files, WApp changes, migrations, or other concrete artifacts. | Yes |

Longer thinking is not special from the user's point of view. All chat pipeline responses are effectively async. The immediate acknowledgement tells the user the bot got the message and is thinking.

### Receipt Acknowledgement

The first visible action should be fast:

1. Receive chat advisory.
2. Suppress if self-authored or duplicate.
3. Send a quick thumbs-up reaction.
4. Continue with hydration and intent classification.

The acknowledgement should not wait for thread hydration, pipeline selection, or agent reasoning.

### Desired Flow

1. Receive chat advisory.
2. Apply route, self-authored, active-run, and dedupe guards.
3. Send quick receipt acknowledgement.
4. Hydrate the Flight Deck PG thread.
5. Build a compact intent prompt from:
   - latest message
   - relevant thread context
   - referenced records
   - immediate workspace/task/doc references
6. Classify into `answer_now`, `think_then_answer`, or `create_task`.
7. For `answer_now`, draft and publish the reply.
8. For `think_then_answer`, run a chat-only thinking pipeline and publish the reply.
9. For `create_task`, load/select task-capable pipelines, create the task, start the task workflow, and reply with a concise "I've started a task" message.

### What Should Not Be In Initial Chat

Initial chat dispatch should not contain task lifecycle management beyond creating a task when the intent is `create_task`.

Remove or move out of the initial chat pipeline:

- Review approval detection.
- Marking review tasks done from chat.
- Blocking created tasks after child launch failure as a chat concern.
- Broad task state transitions.
- Loading every available pipeline before the intent classifier knows work routing is needed.
- Yoke/encrypted-record fallback behavior for Flight Deck PG chat.
- Legacy fallback dispatch definitions that make it unclear which behavior is active.

Task and review lifecycle behaviors should live in task/review pipelines. If a chat references a task and the user wants task work, chat can route into a task workflow.

### Task Creation Rule

Tasks should only be created for durable output.

Create a task for:

- Writing or changing code.
- Writing, editing, or creating durable docs.
- Creating files or artifacts.
- Updating a WApp or system configuration.
- Performing migrations or operational changes.
- Multi-step work where the durable result needs task tracking and review.

Do not create a task for:

- Discussion.
- Planning conversation.
- Design thinking with no document or artifact change.
- Explanations.
- Summaries.
- Opinions or recommendations.
- Research that only needs a chat answer.
- A response that takes several minutes but still ends as a chat reply.

### Thinking Pipeline Behavior

`think_then_answer` can still be a real pipeline. It should stay chat-only and may use multiple steps, graph memory, repo/docs context, or bounded internet lookup when useful.

Because these responses can take time, the thinking pipeline should include guidance for user-visible progress updates. A good thinking pipeline should:

- Decide early whether the answer may take long enough to warrant an update.
- Make a short internal todo list.
- Decide what progress updates would be useful to the user.
- Send one or more intermediate chat updates using the approved Flight Deck CLI/API command for chat messages.
- Keep updates conversational, not pipeline telemetry.
- Avoid creating tasks unless the pipeline discovers the user actually needs durable output.

Example intermediate update:

> I'm going to trace the current dispatch path and compare it against the intended chat-only flow before I answer.

### Pipeline Selection

The initial intent classifier should not receive the full pipeline catalog. It should only decide whether task routing is needed.

If intent is `create_task`, a later routing step should load task-capable pipeline candidates and choose the appropriate workflow. That keeps the common chat path compact and makes task routing easier to debug.

### Route Matching

`matchJson: {}` means "match every advisory for this route's subscription, trigger, and capability." For chat routes that is usually acceptable because most filtering happens through self-authorship, dedupe, and intent classification.

`matchJson` is more useful for task routes. Example task route filter:

```json
{
  "taskStates": ["ready"],
  "assignedTo": "bot"
}
```

That means the task dispatch route only fires when the task is in `ready` state and assigned to the subscription bot. This avoids launching task pipelines for drafts, already-running tasks, completed tasks, or tasks assigned to a person.

Other useful task route filters:

```json
{
  "changedFields": ["state"],
  "taskStates": ["ready"]
}
```

This only reacts when the task state changes into `ready`.

```json
{
  "groupNpubs": ["npub1..."]
}
```

This only reacts for advisories associated with a specific group.

### Desired Branch Summary

| Cause | Desired result |
| --- | --- |
| Self-authored or duplicate message | Suppress before acknowledgement/reply |
| Valid user chat message | Quick thumbs-up acknowledgement |
| Intent is `answer_now` | Reply in chat |
| Intent is `think_then_answer` | Run chat-only thinking pipeline, optionally send progress updates, reply in chat |
| Intent is `create_task` | Load task pipeline candidates, create task, start task workflow, reply that task was started |
| Missing information for chat answer | Ask a focused follow-up question in chat |
| Missing information for durable output | Ask a focused follow-up question before creating a task |
| Referenced task needs lifecycle action | Route to task/review workflow, not initial chat lifecycle code |
