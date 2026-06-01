import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, nip19 } from "nostr-tools";
import type { DeclarativePipeline } from "./declarative";
import { builtinPipelineFunctions } from "./functions";
import type { PipelineDefinitionRecord } from "./pipeline-loader";
import { runDeclarativePipeline } from "./pipeline-runner";
import { PipelineStore, type JsonObject } from "./pipeline-store";

function loadSharedPipelineSpec(fileName: string): DeclarativePipeline {
  return JSON.parse(readFileSync(join(homedir(), ".wingmen", "pipelines", "shared", "definitions", fileName), "utf8"));
}

function executableChatDispatchSpec(agentDecision: JsonObject): DeclarativePipeline {
  const spec = structuredClone(loadSharedPipelineSpec("agent-dispatch-chat.json")) as DeclarativePipeline;
  spec.steps = spec.steps.map((step) => step.name === "analyse-intent"
    ? {
        name: step.name,
        description: step.description,
        type: "code",
        function: "test.agentDecision",
        assign: step.assign,
        when: step.when,
      }
    : step);
  return {
    ...spec,
    input: {
      ...spec.input,
      testAgentDecision: agentDecision,
    },
  };
}

async function runChatDispatchSpec(input: {
  agentDecision: JsonObject;
  latestMessage: string;
  referencedRecords?: unknown[];
}) {
  const definition: PipelineDefinitionRecord = {
    id: "shared:test-agent-dispatch-chat",
    slug: "agent-dispatch-chat",
    name: "agent-dispatch-chat",
    scope: "shared",
    ownerAlias: null,
    path: join(homedir(), ".wingmen", "pipelines", "shared", "definitions", "agent-dispatch-chat.json"),
    spec: executableChatDispatchSpec(input.agentDecision),
  };
  const store = new PipelineStore(join(tmpdir(), `wingmen-chat-dispatch-${randomUUID()}.sqlite`));
  const registry = {
    ...builtinPipelineFunctions,
    "test.agentDecision": async (selected: JsonObject) => selected.testAgentDecision as JsonObject,
    "dispatch.hydrateChatContext": async () => ({
      hydrated: true,
      status: "ok",
      shouldProceed: true,
      thread: {
        recent_messages: [
          {
            message_id: "message-1",
            sender_npub: "npub1requester",
            body: input.latestMessage,
          },
        ],
      },
      referencedRecords: input.referencedRecords ?? [],
      availablePipelines: [
        { id: "document-discussion", slug: "document-discussion", name: "document-discussion", scope: "shared" },
        { id: "discussion-chat-response", slug: "discussion-chat-response", name: "discussion-chat-response", scope: "shared" },
        { id: "do-and-review", slug: "do-and-review", name: "do-and-review", scope: "shared" },
      ],
      scopes: [],
    }),
    "dispatch.createChatTask": async (selected: JsonObject) => ({
      created: true,
      status: "ok",
      taskId: "task-created",
      pipelineDefinitionId: "do-and-review",
      workPlan: {
        ...(((selected.decision as JsonObject | undefined)?.workPlan as JsonObject | undefined) ?? {}),
        taskId: "task-created",
        pipelineDefinitionId: "do-and-review",
        childPipelineDefinitionId: "do-and-review",
      },
    }),
    "dispatch.startChildPipeline": async (selected: JsonObject) => ({
      started: true,
      status: "running",
      pipelineRunId: `run-${String(selected.pipelineDefinitionId)}`,
      pipelineDefinitionId: selected.pipelineDefinitionId,
      pipelineName: selected.pipelineDefinitionId,
    }),
    "dispatch.completeReviewTaskFromChat": async (selected: JsonObject) => ({
      completed: true,
      status: "done",
      taskId: (selected.reviewApproval as JsonObject)?.taskId,
      taskTitle: (selected.reviewApproval as JsonObject)?.taskTitle,
    }),
    "dispatch.reloadChatThread": async () => ({
      hydrated: true,
      status: "ok",
      operation: "chat.reload-thread",
    }),
    "dispatch.ensureDiscussionDocument": async () => ({
      ensured: true,
      status: "created",
      operation: "docs.ensure-discussion-document",
      documentId: "doc-created",
      documentMention: "@[Document discussion](mention:document:doc-created)",
    }),
    "dispatch.publishFlightDeckResponse": async (selected: JsonObject) => ({
      ...selected,
      published: true,
      status: "ok",
      agentResponse: selected.agentResponse,
    }),
  };

  const run = await runDeclarativePipeline({
    store,
    definition,
    registry,
    input: {
      testAgentDecision: input.agentDecision,
      dispatch: { triggerKind: "chat" },
      workspace: { workspaceOwnerNpub: "npub1owner", sourceAppNpub: "npub1source" },
      agent: { workingDirectory: "/repo", defaultAgent: "codex" },
      record: { recordId: "message-1", payload: { body: input.latestMessage, sender_npub: "npub1requester" } },
      chat: { messageText: input.latestMessage, senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
      routing: { channelId: "channel-1", threadId: "thread-1", bindingType: "thread" },
    },
    ownerNpub: "npub1owner",
    ownerAlias: "honest-ivory-thicket",
    callbackOrigin: "http://localhost",
    sessionApiContext: {} as never,
  });
  return {
    run,
    steps: store.listSteps(run.id),
  };
}

function currentAfterStep(runResult: Awaited<ReturnType<typeof runChatDispatchSpec>>, stepName: string): JsonObject {
  return (runResult.steps.find((step) => step.name === stepName)?.result ?? {}) as JsonObject;
}

describe("memory pipeline functions", () => {
  test("dispatch.publishFlightDeckResponse is a dry-run outside dispatch routes", async () => {
    const result = await builtinPipelineFunctions["dispatch.publishFlightDeckResponse"]!({
      agentResponse: { responseDraft: "hello" },
    });

    expect(result.published).toBe(false);
    expect(result.status).toBe("not_configured");
    expect(result.agentResponse).toEqual({ responseDraft: "hello" });
  });

  test("dispatch task state functions are dry-runs outside dispatch routes", async () => {
    await expect(builtinPipelineFunctions["dispatch.markTaskInProgress"]!({ taskId: "task-1" })).resolves.toMatchObject({
      published: false,
      status: "not_configured",
      operation: "tasks.move-to-in-progress",
      taskId: "task-1",
    });
    await expect(builtinPipelineFunctions["dispatch.markTaskReadyForReview"]!({ taskId: "task-1" })).resolves.toMatchObject({
      published: false,
      status: "not_configured",
      operation: "tasks.move-to-review",
      taskId: "task-1",
    });
    await expect(builtinPipelineFunctions["dispatch.ensureImplementationReviewTask"]!({ taskId: "task-1" })).resolves.toMatchObject({
      published: false,
      status: "not_configured",
      operation: "tasks.ensure-implementation-review-loop",
      taskId: "task-1",
    });
    await expect(builtinPipelineFunctions["dispatch.commentImplementationReviewProgress"]!({ taskId: "task-1" })).resolves.toMatchObject({
      published: false,
      status: "not_configured",
      operation: "tasks.comment-implementation-review-progress",
      taskId: "task-1",
    });
  });

  test("dispatch.normaliseTaskWorkPlan normalises list fields", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseTaskWorkPlan"]!({
      agentResponse: {
        accepted: true,
        workStyle: "do_and_review",
        taskSummary: "Research a booking option.",
        initialFindings: ["Context loaded", ""],
        executionPlan: ["Check availability", "Report options"],
        managerChecklist: "Confirm sources",
        taskUpdatePlan: ["Comment after launch"],
        risks: ["Availability may change"],
        confidence: 0.8,
      },
      record: {
        payload: {
          title: "Book Kyoto museum tickets",
          description: "Research and recommend options.",
        },
      },
    });

    expect(result.workStyle).toBe("do_and_review");
    expect(result.childPipelineDefinitionId).toBe("do-and-review");
    expect(result.initialFindings).toEqual(["Context loaded"]);
    expect(result.managerChecklist).toEqual(["Confirm sources"]);
    expect(result.executionPlan).toEqual(["Check availability", "Report options"]);
  });

  test("dispatch.normaliseTaskWorkPlan honors explicit software routing for nested task payloads", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseTaskWorkPlan"]!({
      agentResponse: {
        accepted: true,
        workStyle: "software_implementation",
        taskSummary: "Fix the rendered task links.",
        confidence: 0.9,
      },
      record: {
        payload: {
          data: {
            title: "Ensure links click through",
            description: "Please send this to an implementation pipeline.",
          },
        },
      },
    });

    expect(result.workStyle).toBe("software_implementation");
    expect(result.childPipelineDefinitionId).toBe("software-implementation-review-loop");
  });

  test("dispatch.prepareChatIntentInput compacts chat context for intent analysis", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatIntentInput"]!({
      dispatch: { routeId: "route-1", triggerKind: "chat" },
      workspace: {
        workspaceOwnerNpub: "npub1owner",
        sourceAppNpub: "npub1source",
        backendBaseUrl: "https://example.invalid",
      },
      agent: {
        botNpub: "npub1bot",
        workingDirectory: "/repo",
        defaultAgent: "codex",
      },
      chat: {
        senderNpub: "npub1requester",
        channelId: "channel-1",
        threadId: "thread-1",
      },
      record: {
        recordId: "message-1",
        payload: { sender_npub: "npub1payload" },
      },
      runtime: {
        commandPrefix: "do not pass this through",
        availablePipelines: [
          {
            id: "shared:63d40fd2a6c3",
            slug: "agent-dispatch-chat",
            name: "agent-dispatch-chat",
            description: "Dispatch pipeline",
          },
          {
            id: "shared:b7c038e9cf55",
            slug: "research-and-report",
            name: "research-and-report",
            scope: "shared",
            description: "Long-running research pipeline.",
          },
          {
            id: "shared:90e8752d9b94",
            slug: "agent-dispatch-comment-response",
            name: "agent-dispatch-comment-response",
            scope: "shared",
            description: "Comment dispatch pipeline.",
          },
        ],
      },
      chatContext: {
        shouldProceed: true,
        selfAuthored: false,
        thread: {
          recent_messages: [
            {
              message_id: "message-1",
              sender_npub: "npub1requester",
              body: "Please research this and write a report.",
              updated_at: "2026-05-12T00:00:00.000Z",
            },
          ],
        },
        scopes: [
          {
            record_id: "scope-1",
            title: "Marketing",
            level: "l1",
            group_ids: ["not-needed"],
            updated_at: "2026-05-12T00:00:00.000Z",
          },
        ],
        referencedRecords: [
          {
            recordId: "doc-1",
            recordFamily: "document",
            payload: {
              title: "Reference doc",
              body: "Useful context",
            },
          },
        ],
      },
    });

    expect(result).toMatchObject({
      source: {
        routeId: "route-1",
        requesterNpub: "npub1requester",
      },
      defaults: {
        workdir: "/repo",
        assignerNpub: "npub1requester",
        reviewerNpub: "npub1requester",
      },
      latestThread: [
        {
          messageId: "message-1",
          body: "Please research this and write a report.",
        },
      ],
      scopes: [
        {
          id: "scope-1",
          title: "Marketing",
          level: "l1",
        },
      ],
      validChildPipelines: [
        {
          id: "shared:b7c038e9cf55",
          slug: "research-and-report",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("commandPrefix");
    expect(JSON.stringify(result)).not.toContain("group_ids");
    expect(JSON.stringify(result)).not.toContain("l1_id");
    expect(JSON.stringify(result)).not.toContain("agent-dispatch-comment-response");
    expect(JSON.stringify(result)).not.toContain("agent-dispatch-chat");
  });

  test("dispatch.prepareChatIntentInput appends the triggering chat message when hydration is stale", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatIntentInput"]!({
      dispatch: { routeId: "route-1", triggerKind: "chat" },
      workspace: { workspaceOwnerNpub: "npub1owner", sourceAppNpub: "npub1source" },
      agent: {
        botNpub: "npub1bot",
        workingDirectory: "/repo",
        defaultAgent: "codex",
      },
      chat: {
        messageText: "Excellent that works consistently now",
        senderNpub: "npub1requester",
        channelId: "channel-1",
        threadId: "thread-1",
        parentMessageId: "thread-1",
      },
      record: {
        recordId: "message-3",
        updaterNpub: "npub1requester",
        payload: {
          record_id: "message-3",
          parent_message_id: "thread-1",
          body: "Excellent that works consistently now",
          sender_npub: "npub1requester",
          updated_at: "2026-06-01T11:58:06.893Z",
        },
      },
      runtime: {
        availablePipelines: [
          {
            id: "shared:12b50cd8ba58",
            slug: "do-and-review",
            name: "do-and-review",
            scope: "shared",
            description: "Generic delivery pipeline.",
          },
        ],
      },
      chatContext: {
        shouldProceed: true,
        thread: {
          recent_messages: [
            {
              message_id: "thread-1",
              sender_npub: "npub1requester",
              body: "Please fix the chat scroll behavior.",
              updated_at: "2026-06-01T09:20:26.675Z",
            },
            {
              message_id: "message-2",
              parent_message_id: "thread-1",
              sender_npub: "npub1bot",
              body: "Done: the pipeline work is ready for review.",
              updated_at: "2026-06-01T09:32:06.649Z",
            },
          ],
        },
      },
    });

    expect(result.source).toMatchObject({
      messageId: "message-3",
      requesterNpub: "npub1requester",
    });
    expect(result.latestThread).toEqual([
      {
        messageId: "thread-1",
        parentMessageId: null,
        senderNpub: "npub1requester",
        body: "Please fix the chat scroll behavior.",
        attachments: [],
        updatedAt: "2026-06-01T09:20:26.675Z",
      },
      {
        messageId: "message-2",
        parentMessageId: "thread-1",
        senderNpub: "npub1bot",
        body: "Done: the pipeline work is ready for review.",
        attachments: [],
        updatedAt: "2026-06-01T09:32:06.649Z",
      },
      {
        messageId: "message-3",
        parentMessageId: "thread-1",
        senderNpub: "npub1requester",
        body: "Excellent that works consistently now",
        attachments: [],
        updatedAt: "2026-06-01T11:58:06.893Z",
      },
    ]);
  });

  test("shared agent-dispatch-chat definition wires review, discussion, reload, and prepare inputs", () => {
    const spec = loadSharedPipelineSpec("agent-dispatch-chat.json");
    const names = spec.steps.map((step) => step.name);
    expect(names).toEqual([
      "hydrate-chat-context",
      "prepare-intent-input",
      "analyse-intent",
      "normalise-decision",
      "detect-review-approval",
      "complete-review-task-from-chat",
      "route-discussion-chat",
      "start-discussion-pipeline",
      "create-in-progress-task",
      "start-selected-pipeline",
      "block-task-on-launch-failure",
      "reload-chat-thread-before-reply",
      "prepare-chat-response",
      "publish-chat-response",
    ]);
    const functions = spec.steps.map((step) => step.type === "code" ? step.function : null).filter(Boolean);
    expect(functions).toContain("dispatch.detectChatReviewApproval");
    expect(functions).toContain("dispatch.completeReviewTaskFromChat");
    expect(functions).toContain("dispatch.routeDiscussionChat");
    expect(functions).toContain("dispatch.reloadChatThread");

    const prepare = spec.steps.find((step) => step.name === "prepare-chat-response");
    expect(prepare?.input).toEqual({
      pick: {
        decision: "$.decision",
        createdTask: "$.createdTask",
        childPipeline: "$.childPipeline",
        launchFailureUpdate: "$.launchFailureUpdate",
        reviewApproval: "$.reviewApproval",
        reviewCompletion: "$.reviewCompletion",
        closeoutContext: "$.closeoutContext",
      },
    });
  });

  test("shared document-discussion definition loads thread, document/comments, updates, reviews, asks, and publishes", () => {
    const spec = loadSharedPipelineSpec("document-discussion.json");
    expect(spec.name).toBe("document-discussion");
    expect(spec.steps.map((step) => step.name)).toEqual([
      "reload-thread",
      "load-document-and-comments",
      "ensure-discussion-document",
      "update-document",
      "review-document-against-goal",
      "draft-next-question",
      "publish-document-discussion-reply",
    ]);
  });

  test("dispatch.prepareChatDispatchResponse replies when task creation fails", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatDispatchResponse"]!({
      decision: {
        dispatchTask: true,
        responseDraft: "Starting work.",
        confidence: 0.8,
      },
      createdTask: {
        status: "failed",
        reason: "fetch failed",
        workPlan: {
          taskSummary: "Fix dispatch",
        },
      },
      childPipeline: {
        started: false,
        status: "failed",
        reason: "No child pipeline definition id was provided.",
      },
    });

    expect(result).toMatchObject({
      shouldRespond: true,
      reasoningSummary: "Task-backed dispatch was requested, but task creation failed; reporting the issue in chat.",
    });
    expect(result.responseDraft).toContain("could not create the Flight Deck task");
    expect(result.responseDraft).toContain("fetch failed");
    expect(result.actionsTaken).toContain("task creation failed: fetch failed");
  });

  test("dispatch.prepareChatIntentInput accepts wrapped scope list payloads", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatIntentInput"]!({
      dispatch: { routeId: "route-1", triggerKind: "chat" },
      workspace: { workspaceOwnerNpub: "npub1owner", sourceAppNpub: "npub1source" },
      agent: { workingDirectory: "/repo", defaultAgent: "codex" },
      chat: { senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
      record: { recordId: "message-1", payload: {} },
      runtime: {
        availablePipelines: [
          {
            id: "shared:12b50cd8ba58",
            slug: "do-and-review",
            name: "do-and-review",
            scope: "shared",
            description: "Generic delivery pipeline.",
          },
        ],
      },
      chatContext: {
        shouldProceed: true,
        thread: {
          recent_messages: [
            {
              message_id: "message-1",
              body: "Please handle this generic image task.",
            },
          ],
        },
        scopes: {
          scopes: [
            {
              id: "scope-1",
              title: "Big Dawgs",
              level: "workspace",
            },
          ],
        },
      },
    });

    expect(result.scopes).toEqual([
      {
        id: "scope-1",
        title: "Big Dawgs",
        level: "workspace",
        parentId: null,
      },
    ]);
    expect(result.validChildPipelines).toEqual([
      {
        id: "shared:12b50cd8ba58",
        slug: "do-and-review",
        name: "do-and-review",
        scope: "shared",
        description: "Generic delivery pipeline.",
      },
    ]);
    expect(result.notes).toContain("For generic or miscellaneous chat-created tasks, choose do-and-review.");
  });

  test("dispatch.normaliseChatDispatchDecision uses dispatchTask as the single routing switch", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseChatDispatchDecision"]!({
      agent: { workingDirectory: "/repo" },
      chat: { senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
      record: { recordId: "message-1", updaterNpub: "npub1requester", payload: {} },
      dispatch: { triggerKind: "chat" },
      chatContext: {
        thread: {
          recent_messages: [
            {
              message_id: "message-1",
              sender_npub: "npub1requester",
              body: "Please research the thing.",
            },
          ],
        },
        referencedRecords: [
          {
            recordId: "doc-1",
            recordFamily: "document",
            payload: { title: "Reference doc", body: "Useful background." },
          },
        ],
      },
      agentDecision: {
        dispatchTask: true,
        recommendedPipelineId: "do-and-review",
        scopeId: "scope-1",
        taskDraft: {
          title: "Research the thing",
          instructions: "Do the research.",
          acceptanceCriteria: ["Report the answer"],
        },
        chatResponse: { body: "Starting the research." },
        confidence: 0.9,
      },
    });

    expect(result.dispatchTask).toBe(true);
    expect(result.pipelineDefinitionId).toBe("do-and-review");
    expect(result.workPlan).toMatchObject({
      workdir: "/repo",
      reviewerNpub: "npub1requester",
      acceptanceCriteria: ["Report the answer"],
      originalPrompt: "Please research the thing.",
      originThread: [
        {
          messageId: "message-1",
          body: "Please research the thing.",
        },
      ],
      referencedRecords: [
        {
          recordId: "doc-1",
          title: "Reference doc",
          summary: "Useful background.",
        },
      ],
    });
    expect("responseOnly" in result).toBe(false);
  });

  test("dispatch.normaliseChatDispatchDecision allows chat task dispatch without a scope", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseChatDispatchDecision"]!({
      agent: { workingDirectory: "/repo" },
      chat: { senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
      record: { recordId: "message-1", updaterNpub: "npub1requester", payload: {} },
      dispatch: { triggerKind: "chat" },
      agentDecision: {
        dispatchTask: true,
        recommendedPipelineId: "do-and-review",
        scopeId: null,
        taskDraft: {
          title: "Handle the image task",
          instructions: "Complete the generic image task.",
          acceptanceCriteria: ["The requested image task is complete"],
        },
        chatResponse: { body: "Starting a generic task." },
        confidence: 0.8,
      },
    });

    expect(result).toMatchObject({
      dispatchTask: true,
      pipelineDefinitionId: "do-and-review",
      scopeId: null,
      missing: [],
      responseDraft: "Starting a generic task.",
    });
    expect(result.workPlan).toMatchObject({
      scopeId: null,
      workdir: "/repo",
      instructions: "Complete the generic image task.",
    });
  });

  test("dispatch.normaliseChatDispatchDecision suppresses self-authored chat dispatches", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseChatDispatchDecision"]!({
      chatContext: {
        shouldProceed: false,
        selfAuthored: true,
        suppressionReason: "trigger_thread_message_sender_is_self",
      },
      chat: { channelId: "channel-1", threadId: "thread-1" },
      record: { recordId: "message-1" },
      dispatch: { triggerKind: "chat" },
    });

    expect(result).toMatchObject({
      dispatchTask: false,
      shouldRespond: false,
      suppressed: true,
      suppressionReason: "trigger_thread_message_sender_is_self",
    });
  });

  test("shared chat dispatch execution starts document discussion without creating a task", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Let's discuss the accepted design document comments and decide the next question.",
      agentDecision: {
        intent: "design_discussion",
        dispatchTask: false,
        recommendedPipelineId: "document-discussion",
        chatResponse: { body: "" },
        confidence: 0.87,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    const run = execution.run;
    expect(run.status).toBe("ok");
    expect(result.createdTask).toBeUndefined();
    expect(result.decision).toMatchObject({
      dispatchTask: false,
      dispatchDiscussion: true,
      discussionPipelineDefinitionId: "document-discussion",
    });
    expect(result.childPipeline).toMatchObject({
      started: true,
      pipelineDefinitionId: "document-discussion",
    });
    expect(result.agentResponse).toMatchObject({
      shouldRespond: true,
      responseDraft: "I am looking into that and will respond in this thread.",
    });
  });

  test("shared chat dispatch execution preserves direct chat replies even when a discussion pipeline is selected", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Can you actually hear me>",
      agentDecision: {
        intent: "direct_chat_response",
        dispatchTask: false,
        recommendedPipelineId: "discussion-chat-response",
        chatResponse: { body: "Yes, I can hear you. What do you need?" },
        confidence: 0.96,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    const run = execution.run;
    expect(run.status).toBe("ok");
    expect(result.createdTask).toBeUndefined();
    expect(result.childPipeline).toBeUndefined();
    expect(result.decision).not.toHaveProperty("dispatchDiscussion");
    expect(result.agentResponse).toMatchObject({
      shouldRespond: true,
      responseDraft: "Yes, I can hear you. What do you need?",
    });
  });

  test("shared chat dispatch execution keeps task-backed handoff on task path", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Please research this and produce the answer.",
      agentDecision: {
        intent: "work",
        dispatchTask: true,
        recommendedPipelineId: "do-and-review",
        taskDraft: {
          title: "Research the answer",
          instructions: "Research this and produce the answer.",
          acceptanceCriteria: ["Answer is posted back"],
        },
        chatResponse: { body: "Starting the work." },
        confidence: 0.9,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    const run = execution.run;
    expect(run.status).toBe("ok");
    expect(result.createdTask).toMatchObject({ taskId: "task-created" });
    expect(result.childPipeline).toMatchObject({ pipelineDefinitionId: "do-and-review" });
    expect(result.decision).toMatchObject({ dispatchTask: true });
    expect(result.decision).not.toHaveProperty("dispatchDiscussion");
    expect(result.agentResponse).toMatchObject({ shouldRespond: true });
  });

  test("shared chat dispatch execution completes one linked review approval", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Looks good, please mark it done.",
      referencedRecords: [
        { recordId: "task-review", family: "task", state: "review", title: "Review natural chat dispatch" },
      ],
      agentDecision: {
        intent: "chat",
        dispatchTask: false,
        chatResponse: { body: "" },
        confidence: 0.7,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    const run = execution.run;
    expect(run.status).toBe("ok");
    expect(result.reviewApproval).toMatchObject({
      shouldComplete: true,
      taskId: "task-review",
    });
    expect(result.reviewCompletion).toMatchObject({
      completed: true,
      taskId: "task-review",
    });
    expect(result.agentResponse).toMatchObject({
      shouldRespond: true,
      actionsTaken: ["completed review task task-review"],
    });
  });

  test("shared chat dispatch execution asks when review approval is ambiguous", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Approved, this is done.",
      referencedRecords: [
        { recordId: "task-one", family: "task", state: "review", title: "First task" },
        { recordId: "task-two", family: "task", state: "review", title: "Second task" },
      ],
      agentDecision: {
        intent: "chat",
        dispatchTask: false,
        chatResponse: { body: "" },
        confidence: 0.7,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    const run = execution.run;
    expect(run.status).toBe("ok");
    expect(result.reviewApproval).toMatchObject({
      shouldComplete: false,
      status: "ambiguous_review_task",
    });
    expect(result.reviewCompletion).toBeUndefined();
    expect(result.createdTask).toBeUndefined();
    expect(result.agentResponse).toMatchObject({
      shouldRespond: true,
      responseDraft: "Which review task should I mark done?",
    });
  });

  test("dispatch.normaliseChatDispatchDecision honors ignore intent without a fallback reply", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseChatDispatchDecision"]!({
      chat: { channelId: "channel-1", threadId: "thread-1" },
      record: { recordId: "message-1" },
      dispatch: { triggerKind: "chat" },
      agentDecision: {
        intent: "ignore",
        dispatchTask: false,
        chatResponse: { body: "" },
        confidence: 1,
      },
    });

    expect(result).toMatchObject({
      dispatchTask: false,
      shouldRespond: false,
      suppressed: true,
      suppressionReason: "agent_intent_ignore",
      responseDraft: "",
    });
  });

  test("dispatch.prepareChatDispatchResponse skips suppressed chat dispatches", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatDispatchResponse"]!({
      decision: {
        shouldRespond: false,
        suppressed: true,
        suppressionReason: "trigger_sender_is_self",
      },
    });

    expect(result).toMatchObject({
      shouldRespond: false,
      responseDraft: "",
      actionsTaken: [],
    });
  });

  test("dispatch.prepareChatDispatchResponse links created tasks with Flight Deck mentions", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatDispatchResponse"]!({
      decision: {
        dispatchTask: true,
        pipelineDefinitionId: "research-and-report",
        confidence: 0.9,
      },
      createdTask: {
        taskId: "task-1",
        workPlan: {
          taskSummary: "Good Soccer Drills report",
        },
      },
      childPipeline: {
        started: true,
        pipelineName: "research-and-report",
        pipelineRunId: "run-1",
      },
    });

    expect(result.responseDraft).toContain(
      "I created task @[Good Soccer Drills report](mention:task:task-1) and started research-and-report (run-1).",
    );
    expect(result.actionsTaken).toEqual(["created task task-1", "started pipeline run run-1"]);
  });

  test("dispatch.prepareChatDispatchResponse suppresses duplicate reply when needs input was already posted", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatDispatchResponse"]!({
      decision: {
        dispatchTask: true,
        pipelineDefinitionId: "do-and-review",
        confidence: 0.9,
      },
      createdTask: {
        taskId: "task-1",
        workPlan: {
          taskSummary: "Create requested image asset",
        },
      },
      childPipeline: {
        started: true,
        status: "needs_input",
        pipelineName: "do-and-review",
        pipelineRunId: "run-1",
        needsInputUpdate: {
          chatNotified: true,
          question: "What should the image show?",
        },
      },
    });

    expect(result).toMatchObject({
      shouldRespond: false,
      reasoningSummary: "The child pipeline needs input; a clarification question was published.",
    });
    expect(result.responseDraft).toContain("Question: What should the image show?");
  });

  test("memory.searchEntities returns an empty graphContext source set when graph memory is not configured", async () => {
    const previous = {
      PIPELINE_MEMORY_NEO4J_HTTP_URL: process.env.PIPELINE_MEMORY_NEO4J_HTTP_URL,
      NEO4J_HTTP_URL: process.env.NEO4J_HTTP_URL,
      NEO4J_URI: process.env.NEO4J_URI,
      PIPELINE_MEMORY_EMBEDDING_API_KEY: process.env.PIPELINE_MEMORY_EMBEDDING_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    delete process.env.PIPELINE_MEMORY_NEO4J_HTTP_URL;
    delete process.env.NEO4J_HTTP_URL;
    delete process.env.NEO4J_URI;
    delete process.env.PIPELINE_MEMORY_EMBEDDING_API_KEY;
    delete process.env.OPENAI_API_KEY;
    let result: Record<string, unknown>;
    try {
      result = await builtinPipelineFunctions["memory.searchEntities"]!({
        entities: [
          { name: "Redshift", type: "system", reason: "secret management", query: "Redshift secret management" },
        ],
      });
    } finally {
      Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }

    expect(result.matches).toEqual([]);
    expect(result.graphMemoryAvailable).toBe(false);
    expect((result.warnings as string[])[0]).toContain("Neo4j graph memory is not configured");
  });

  test("tower.searchGraph signs NIP-98 requests and normalises Tower graph results", async () => {
    const previousWingmanPriv = process.env.WINGMAN_PRIV;
    const previousFetch = globalThis.fetch;
    const requested: { url?: string; authorization?: string } = {};
    process.env.WINGMAN_PRIV = nip19.nsecEncode(generateSecretKey());
    globalThis.fetch = (async (input, init) => {
      requested.url = String(input);
      requested.authorization = new Headers(init?.headers).get("authorization") || undefined;
      return Response.json({
        query: "Redshift",
        results: [
          {
            kind: "node",
            score: 0.91,
            id: "node-1",
            external_id: "project:redshift",
            source: "tower",
            labels: ["Project"],
            title: "Redshift",
            summary: "Redshift stores encrypted workspace context.",
            properties: { path: "docs/redshift.md" },
          },
        ],
        total: 1,
        limit: 4,
      });
    }) as typeof fetch;

    let result: Record<string, unknown>;
    try {
      result = await builtinPipelineFunctions["tower.searchGraph"]!({
        towerUrl: "http://tower.local",
        ownerNpub: "npub1owner",
        entities: [
          { name: "Redshift", type: "system", reason: "secret management", query: "Redshift" },
        ],
        topKPerEntity: 4,
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousWingmanPriv === undefined) delete process.env.WINGMAN_PRIV;
      else process.env.WINGMAN_PRIV = previousWingmanPriv;
    }

    expect(requested.url).toContain("http://tower.local/api/v4/graph/search");
    expect(requested.url).toContain("workspace_owner_npub=npub1owner");
    expect(requested.authorization).toStartWith("Nostr ");
    expect(result.graphMemoryAvailable).toBe(true);
    expect(result.source).toBe("tower-postgres-graph");
    expect(result.matches).toEqual([
      {
        id: "node-1",
        entity: "Redshift",
        entityType: "system",
        title: "Redshift",
        source: "tower",
        score: 0.91,
        excerpt: "Redshift stores encrypted workspace context.",
        labels: ["node", "Project"],
      },
    ]);
  });

  test("memory.consolidateGraphContext returns graphContext and source metadata", async () => {
    const result = await builtinPipelineFunctions["memory.consolidateGraphContext"]!({
      entities: [{ name: "Redshift", type: "system", query: "Redshift", reason: "secret manager" }],
      matches: [
        {
          id: "node-1",
          entity: "Redshift",
          entityType: "system",
          title: "Redshift Secret Plan",
          source: "docs/redshift-secrets-plan.md",
          score: 0.91,
          excerpt: "Redshift stores encrypted secrets as Nostr events.",
          labels: ["DocumentChunk"],
        },
      ],
      maxChars: 2000,
    });

    expect(result.graphContext).toContain("potential context from long-term memory");
    expect(result.graphContext).toContain("Redshift Secret Plan");
    expect(result.graphContextAvailable).toBe(true);
    expect(result.graphContextSources).toEqual([
      {
        id: "node-1",
        entity: "Redshift",
        entityType: "system",
        title: "Redshift Secret Plan",
        source: "docs/redshift-secrets-plan.md",
        score: 0.91,
        excerpt: "Redshift stores encrypted secrets as Nostr events.",
        labels: ["DocumentChunk"],
      },
    ]);
  });
});
