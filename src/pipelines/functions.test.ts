import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, nip19 } from "nostr-tools";
import type { DeclarativePipeline } from "./declarative";
import { builtinPipelineFunctions } from "./functions";
import { getPipelineDefinition, type PipelineDefinitionRecord } from "./pipeline-loader";
import { runDeclarativePipeline } from "./pipeline-runner";
import { PipelineStore, type JsonObject } from "./pipeline-store";

const seededPipelineSpecs = new Map<string, DeclarativePipeline>();
let tempPipelineRoot: string | null = null;
let previousPipelineRoot: string | undefined;

beforeAll(async () => {
  previousPipelineRoot = process.env.WINGMEN_PIPELINES_ROOT;
  tempPipelineRoot = mkdtempSync(join(tmpdir(), "wingmen-functions-pipeline-root-"));
  process.env.WINGMEN_PIPELINES_ROOT = tempPipelineRoot;

  const seededDefinitions = [
    ["agent-dispatch-chat.json", "agent-dispatch-chat"],
    ["agent-dispatch-task-response.json", "agent-dispatch-task-response"],
    ["document-discussion.json", "document-discussion"],
  ] as const;
  for (const [fileName, slug] of seededDefinitions) {
    const definition = await getPipelineDefinition(slug, "functions-test");
    if (!definition) {
      throw new Error(`Seeded pipeline definition missing: ${slug}`);
    }
    seededPipelineSpecs.set(fileName, structuredClone(definition.spec) as DeclarativePipeline);
  }
});

afterAll(() => {
  if (previousPipelineRoot === undefined) {
    delete process.env.WINGMEN_PIPELINES_ROOT;
  } else {
    process.env.WINGMEN_PIPELINES_ROOT = previousPipelineRoot;
  }
  if (tempPipelineRoot) {
    rmSync(tempPipelineRoot, { recursive: true, force: true });
  }
});

function loadSharedPipelineSpec(fileName: string): DeclarativePipeline {
  const spec = seededPipelineSpecs.get(fileName);
  if (!spec) {
    throw new Error(`Seeded pipeline definition not loaded: ${fileName}`);
  }
  return structuredClone(spec) as DeclarativePipeline;
}

test("chat intent input includes Flight Deck channel context", async () => {
  const result = await builtinPipelineFunctions["dispatch.prepareChatIntentInput"]({
    dispatch: { routeId: "route-1", triggerKind: "chat" },
    workspace: { workspaceOwnerNpub: "npub1owner", sourceAppNpub: "npub1source" },
    agent: { workingDirectory: "/repo", defaultAgent: "codex" },
    record: { recordId: "message-1", payload: { body: "Please update the feature doc.", sender_npub: "npub1requester" } },
    chat: { messageText: "Please update the feature doc.", senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
    routing: { channelId: "channel-1", threadId: "thread-1" },
    chatContext: {
      shouldProceed: true,
      thread: {
        recent_messages: [
          { message_id: "message-1", sender_npub: "npub1requester", body: "Please update the feature doc." },
        ],
      },
      channelContext: {
        channelId: "channel-1",
        scopeId: "scope-1",
        name: "Features",
        contextPrompt: "Iterate on the Flight Deck feature document before implementing.",
        hasSpecificContext: true,
      },
    },
  });

  expect(result.channelContext).toEqual({
    channelId: "channel-1",
    scopeId: "scope-1",
    name: "Features",
    contextPrompt: "Iterate on the Flight Deck feature document before implementing.",
    hasSpecificContext: true,
  });
  expect(result.notes).toContain("Use channelContext.contextPrompt as channel-specific instructions for how this work should be handled.");
});

test("channel context sentinel is not treated as specific context", async () => {
  const result = await builtinPipelineFunctions["dispatch.prepareChatIntentInput"]({
    dispatch: { routeId: "route-1", triggerKind: "chat" },
    workspace: { workspaceOwnerNpub: "npub1owner", sourceAppNpub: "npub1source" },
    agent: { workingDirectory: "/repo", defaultAgent: "codex" },
    record: { recordId: "message-1", payload: { body: "Hello", sender_npub: "npub1requester" } },
    chat: { messageText: "Hello", senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
    routing: { channelId: "channel-1", threadId: "thread-1" },
    chatContext: {
      shouldProceed: true,
      channelContext: {
        channelId: "channel-1",
        contextPrompt: "No Specific Channel Context",
        hasSpecificContext: true,
      },
    },
  });

  expect(result.channelContext).toMatchObject({
    contextPrompt: "No Specific Channel Context",
    hasSpecificContext: false,
  });
});

test("task work plans preserve Flight Deck channel context for child sessions", async () => {
  const result = await builtinPipelineFunctions["dispatch.normaliseTaskWorkPlan"]({
    agentResponse: {
      accepted: true,
      workStyle: "do_and_review",
      taskSummary: "Clarify the document request.",
      confidence: 0.8,
    },
    record: {
      payload: {
        title: "Clarify docs",
        description: "Review the latest document request.",
      },
    },
    agent: { workingDirectory: "/repo" },
    flightDeckContext: {
      channel: {
        id: "channel-1",
        scopeId: "scope-1",
        name: "Docs",
        contextPrompt: "Use docs for iteration; do not create tasks for document-only work.",
        hasSpecificContext: true,
      },
    },
  });

  expect(result.channelContext).toEqual({
    channelId: "channel-1",
    scopeId: "scope-1",
    name: "Docs",
    contextPrompt: "Use docs for iteration; do not create tasks for document-only work.",
    hasSpecificContext: true,
  });
});

function executableChatDispatchSpec(agentDecision: JsonObject, taskPipelineDecision: JsonObject): DeclarativePipeline {
  const spec = structuredClone(loadSharedPipelineSpec("agent-dispatch-chat.json")) as DeclarativePipeline;
  spec.steps = spec.steps.map((step) => {
    if (step.name === "analyse-intent") {
      return {
        name: step.name,
        description: step.description,
        type: "code",
        function: "test.agentDecision",
        assign: step.assign,
        when: step.when,
      };
    }
    if (step.name === "select-task-pipeline") {
      return {
        name: step.name,
        description: step.description,
        type: "code",
        function: "test.taskPipelineDecision",
        assign: step.assign,
        when: step.when,
      };
    }
    return step;
  });
  return {
    ...spec,
    input: {
      ...spec.input,
      testAgentDecision: agentDecision,
      testTaskPipelineDecision: taskPipelineDecision,
    },
  };
}

async function runChatDispatchSpec(input: {
  agentDecision: JsonObject;
  taskPipelineDecision?: JsonObject;
  latestMessage: string;
  referencedRecords?: unknown[];
}) {
  const taskPipelineDecision = input.taskPipelineDecision ?? {
    recommendedPipelineId: "do-and-review",
    workdir: "/repo",
    chatResponse: { body: "Starting the work." },
    confidence: 0.9,
  };
  const definition: PipelineDefinitionRecord = {
    id: "shared:test-agent-dispatch-chat",
    slug: "agent-dispatch-chat",
    name: "agent-dispatch-chat",
    scope: "shared",
    ownerAlias: null,
    path: join(tempPipelineRoot ?? tmpdir(), "shared", "definitions", "agent-dispatch-chat.json"),
    spec: executableChatDispatchSpec(input.agentDecision, taskPipelineDecision),
  };
  const store = new PipelineStore(join(tmpdir(), `wingmen-chat-dispatch-${randomUUID()}.sqlite`));
  const registry = {
    ...builtinPipelineFunctions,
    "test.agentDecision": async (selected: JsonObject) => selected.testAgentDecision as JsonObject,
    "test.taskPipelineDecision": async (selected: JsonObject) => selected.testTaskPipelineDecision as JsonObject,
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
      testTaskPipelineDecision: taskPipelineDecision,
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

function executableTaskDispatchSpec(agentResponse: JsonObject): DeclarativePipeline {
  const spec = structuredClone(loadSharedPipelineSpec("agent-dispatch-task-response.json")) as DeclarativePipeline;
  spec.steps = spec.steps.map((step) => step.name === "investigate-and-route-task"
    ? {
        name: step.name,
        description: step.description,
        type: "code",
        function: "test.agentResponse",
        input: {
          pick: {
            testAgentResponse: "$.testAgentResponse",
          },
        },
        assign: step.assign,
      }
    : step);
  return {
    ...spec,
    input: {
      ...spec.input,
      testAgentResponse: agentResponse,
    },
  };
}

async function runTaskDispatchSpec(input: {
  agentResponse: JsonObject;
  taskDescription: string;
  taskId?: string;
}) {
  const taskId = input.taskId ?? "task-demo";
  const definition: PipelineDefinitionRecord = {
    id: "shared:test-agent-dispatch-task-response",
    slug: "agent-dispatch-task-response",
    name: "agent-dispatch-task-response",
    scope: "shared",
    ownerAlias: null,
    path: join(tempPipelineRoot ?? tmpdir(), "shared", "definitions", "agent-dispatch-task-response.json"),
    spec: executableTaskDispatchSpec(input.agentResponse),
  };
  const store = new PipelineStore(join(tmpdir(), `wingmen-task-dispatch-${randomUUID()}.sqlite`));
  const registry = {
    ...builtinPipelineFunctions,
    "test.agentResponse": async (selected: JsonObject) => selected.testAgentResponse as JsonObject,
    "dispatch.markTaskInProgress": async (selected: JsonObject) => ({
      published: true,
      status: "ok",
      workPlan: selected.workPlan,
    }),
    "dispatch.startChildPipeline": async (selected: JsonObject) => ({
      started: true,
      status: "running",
      pipelineDefinitionId: selected.pipelineDefinitionId,
      workPlan: selected.workPlan,
      childInputWorkPlan: (selected.childInput as JsonObject | undefined)?.workPlan,
    }),
    "dispatch.publishFlightDeckResponse": async (selected: JsonObject) => ({
      published: true,
      status: "ok",
      agentResponse: selected.agentResponse,
      childPipeline: selected.childPipeline,
    }),
  };

  const run = await runDeclarativePipeline({
    store,
    definition,
    registry,
    input: {
      testAgentResponse: input.agentResponse,
      dispatch: { triggerKind: "task" },
      workspace: { workspaceOwnerNpub: "npub1owner", sourceAppNpub: "npub1source" },
      agent: { workingDirectory: "/repo", defaultAgent: "codex" },
      record: {
        recordId: taskId,
        payload: {
          task_id: taskId,
          title: "Implement PH1 task",
          description: input.taskDescription,
          state: "ready",
          assigned_to: "npub1bot",
        },
      },
      routing: { bindingId: taskId, bindingType: "task", changedFields: ["state"] },
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

function taskAfterStep(runResult: Awaited<ReturnType<typeof runTaskDispatchSpec>>, stepName: string): JsonObject {
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

  test("dispatch.normaliseTaskWorkPlan extracts PH1 ticket paths into software work plans", async () => {
    const ticketPath = "/Users/mini/code/wingmanbefree/flightdeck-pg/implementation/phase1/ticket_ph1_2_typed_api_contract_fixtures.md";
    const result = await builtinPipelineFunctions["dispatch.normaliseTaskWorkPlan"]!({
      agentResponse: {
        accepted: true,
        workStyle: "software_implementation",
        taskSummary: "Implement PH1 typed API fixtures.",
      },
      record: {
        recordId: "task-ph1-2",
        payload: {
          task_id: "task-ph1-2",
          title: "PH1-2 typed API contract fixtures",
          description: `Implement this task.\nTicket: ${ticketPath}\nRun focused tests.`,
        },
      },
    });

    expect(result.childPipelineDefinitionId).toBe("software-implementation-review-loop");
    expect(result.designDocumentUrl).toBe(ticketPath);
    expect(result.designDocumentSource).toBe("task_description");
    expect(result.designDocumentUnavailableReason).toBeUndefined();
  });

  test("dispatch.normaliseTaskWorkPlan extracts primary design artifact paths", async () => {
    const designPath = "/Users/mini/code/wingmanbefree/autopilot/docs/design/pipeline-design-document-url-propagation.md";
    const result = await builtinPipelineFunctions["dispatch.normaliseTaskWorkPlan"]!({
      agentResponse: {
        accepted: true,
        workStyle: "software_implementation",
        taskSummary: "Fix pipeline propagation.",
      },
      record: {
        recordId: "task-design",
        payload: {
          title: "Pipeline propagation fix",
          description: `Primary design/ticket artifact: ${designPath}`,
        },
      },
    });

    expect(result.designDocumentUrl).toBe(designPath);
    expect(result.designDocumentSource).toBe("task_description");
  });

  test("dispatch.normaliseTaskWorkPlan uses a task-context fallback when no artifact exists", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseTaskWorkPlan"]!({
      agentResponse: {
        accepted: true,
        workStyle: "software_implementation",
        taskSummary: "Fix the API bug.",
      },
      record: {
        recordId: "task-without-design",
        payload: {
          title: "Fix the API bug",
          description: "There is no separate design document for this small implementation task.",
        },
      },
    });

    expect(result.designDocumentUrl).toBe("flightdeck-task://task-without-design");
    expect(result.designDocumentSource).toBe("task_context_fallback");
    expect(result.designDocumentUnavailableReason).toBe("no_separate_design_or_ticket_artifact");
  });

  test("task intake propagates design references into child pipeline work plan input", async () => {
    const ticketPath = "/Users/mini/code/wingmanbefree/flightdeck-pg/implementation/phase1/ticket_ph1_2_typed_api_contract_fixtures.md";
    const result = await runTaskDispatchSpec({
      taskDescription: `Implement PH1 work.\nTicket: ${ticketPath}`,
      agentResponse: {
        accepted: true,
        workStyle: "software_implementation",
        taskSummary: "Implement PH1 typed API fixtures.",
        confidence: 0.9,
      },
      taskId: "task-ph1-2",
    });
    const startStep = taskAfterStep(result, "start-follow-up-pipeline");
    const childPipeline = startStep.childPipeline as JsonObject;
    const workPlan = childPipeline.workPlan as JsonObject;
    const childInputWorkPlan = childPipeline.childInputWorkPlan as JsonObject;

    expect(childPipeline.pipelineDefinitionId).toBe("software-implementation-review-loop");
    expect(workPlan.designDocumentUrl).toBe(ticketPath);
    expect(childInputWorkPlan.designDocumentUrl).toBe(ticketPath);
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
    });
    expect(result).not.toHaveProperty("validChildPipelines");
    expect(result.notes).toContain("Classify as answer_now or create_task.");
    expect(JSON.stringify(result)).not.toContain("commandPrefix");
    expect(JSON.stringify(result)).not.toContain("group_ids");
    expect(JSON.stringify(result)).not.toContain("l1_id");
    expect(JSON.stringify(result)).not.toContain("research-and-report");
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
    expect(result).not.toHaveProperty("validChildPipelines");
    expect(result.notes).toContain("Use create_task for durable output or any answer that requires inspecting sessions, logs, pipelines, files, projects, Tower/Yoke state, or Autopilot runtime state before reporting back.");
  });

  test("dispatch.prepareChatTaskPipelineInput loads task pipeline candidates after create_task", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatTaskPipelineInput"]!({
      dispatch: { routeId: "route-1", triggerKind: "chat" },
      workspace: { workspaceOwnerNpub: "npub1owner", sourceAppNpub: "npub1source" },
      agent: { workingDirectory: "/repo", defaultAgent: "codex" },
      chat: { senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
      record: { recordId: "message-1", payload: { body: "Please implement the fix." } },
      runtime: {
        availablePipelines: [
          {
            id: "shared:agent-dispatch-chat",
            slug: "agent-dispatch-chat",
            name: "agent-dispatch-chat",
            scope: "shared",
          },
          {
            id: "shared:12b50cd8ba58",
            slug: "do-and-review",
            name: "do-and-review",
            scope: "shared",
            description: "Generic delivery pipeline.",
          },
          {
            id: "shared:impl",
            slug: "software-implementation-review-loop",
            name: "software-implementation-review-loop",
            scope: "shared",
            description: "Implementation review pipeline.",
          },
        ],
      },
      chatContext: {
        shouldProceed: true,
        thread: {
          recent_messages: [
            {
              message_id: "message-1",
              body: "Please implement the fix.",
            },
          ],
        },
      },
      decision: {
        intent: "create_task",
        taskDraft: {
          title: "Implement fix",
          instructions: "Change code and run tests.",
        },
      },
    });

    expect(result.validChildPipelines).toEqual([
      {
        id: "shared:12b50cd8ba58",
        slug: "do-and-review",
        name: "do-and-review",
        scope: "shared",
        description: "Generic delivery pipeline.",
      },
      {
        id: "shared:impl",
        slug: "software-implementation-review-loop",
        name: "software-implementation-review-loop",
        scope: "shared",
        description: "Implementation review pipeline.",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("agent-dispatch-chat");
  });

  test("dispatch.normaliseChatTaskPipelineSelection enables create_task after task pipeline selection", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseChatTaskPipelineSelection"]!({
      decision: {
        requestedDispatchTask: true,
        taskRoutingPending: true,
        taskDraft: {
          title: "Handle the image task",
          instructions: "Complete the generic image task.",
          acceptanceCriteria: ["The requested image task is complete"],
        },
        workPlan: {
          taskSummary: "Handle the image task",
          instructions: "Complete the generic image task.",
          workdir: "/repo",
        },
        responseDraft: "Starting a generic task.",
      },
      taskPipelineInput: {
        validChildPipelines: [
          {
            id: "shared:12b50cd8ba58",
            slug: "do-and-review",
            name: "do-and-review",
            scope: "shared",
            description: "Generic delivery pipeline.",
          },
        ],
      },
      taskPipelineDecision: {
        recommendedPipelineId: "do-and-review",
        workdir: "/repo",
        confidence: 0.8,
      },
    });

    expect(result).toMatchObject({
      dispatchTask: true,
      pipelineDefinitionId: "shared:12b50cd8ba58",
      taskRoutingPending: false,
      missing: [],
      responseDraft: "Starting a generic task.",
    });
    expect(result.workPlan).toMatchObject({
      pipelineDefinitionId: "shared:12b50cd8ba58",
      childPipelineDefinitionId: "shared:12b50cd8ba58",
      workdir: "/repo",
    });
  });

  test("legacy dispatchTask decisions without pipeline stay pending for task selection", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseChatDispatchDecision"]!({
      agent: { workingDirectory: "/repo" },
      chat: { senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
      record: { recordId: "message-1", updaterNpub: "npub1requester", payload: {} },
      dispatch: { triggerKind: "chat" },
      agentDecision: {
        intent: "create_task",
        dispatchTask: true,
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
      dispatchTask: false,
      requestedDispatchTask: true,
      intent: "create_task",
      pipelineDefinitionId: null,
      taskRoutingPending: true,
      responseDraft: "Starting a generic task.",
    });
  });

  test("create_task decisions with concreteInstructions stay pending for task selection", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseChatDispatchDecision"]!({
      agent: { workingDirectory: "/repo" },
      chat: { senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
      record: { recordId: "message-1", updaterNpub: "npub1requester", payload: {} },
      dispatch: { triggerKind: "chat" },
      agentDecision: {
        intent: "create_task",
        dispatchTask: true,
        taskDraft: {
          title: "Create planning threads",
          concreteInstructions: "Create one Flight Deck thread per refactor area.",
          acceptanceCriteria: ["The planning threads are created"],
        },
        chatResponse: { body: "" },
        confidence: 0.94,
      },
    });

    expect(result).toMatchObject({
      dispatchTask: false,
      requestedDispatchTask: true,
      intent: "create_task",
      taskRoutingPending: true,
      taskDraft: {
        instructions: "Create one Flight Deck thread per refactor area.",
      },
      workPlan: {
        instructions: "Create one Flight Deck thread per refactor area.",
      },
    });
  });

  test("shared agent-dispatch-chat definition keeps initial chat lifecycle narrow", () => {
    const spec = loadSharedPipelineSpec("agent-dispatch-chat.json");
    const names = spec.steps.map((step) => step.name);
    expect(names).toEqual([
      "hydrate-chat-context",
      "prepare-intent-input",
      "analyse-intent",
      "normalise-decision",
      "prepare-task-pipeline-input",
      "select-task-pipeline",
      "normalise-task-pipeline-selection",
      "create-in-progress-task",
      "start-selected-pipeline",
      "reload-chat-thread-before-reply",
      "prepare-chat-response",
      "publish-chat-response",
    ]);
    const functions = spec.steps.map((step) => step.type === "code" ? step.function : null).filter(Boolean);
    expect(functions).not.toContain("dispatch.detectChatReviewApproval");
    expect(functions).not.toContain("dispatch.completeReviewTaskFromChat");
    expect(functions).not.toContain("dispatch.routeDiscussionChat");
    expect(functions).not.toContain("dispatch.blockTaskIfPipelineLaunchFailed");
    expect(functions).toContain("dispatch.prepareChatTaskPipelineInput");
    expect(functions).toContain("dispatch.normaliseChatTaskPipelineSelection");

    const prepare = spec.steps.find((step) => step.name === "prepare-chat-response");
    expect(prepare?.input).toEqual({
      pick: {
        decision: "$.decision",
        createdTask: "$.createdTask",
        childPipeline: "$.childPipeline",
        closeoutContext: "$.closeoutContext",
      },
    });
  });

  test("shared chat dispatch execution answer_now stays chat-only", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Can you hear me?",
      agentDecision: {
        intent: "answer_now",
        dispatchTask: false,
        chatResponse: { body: "Yes, I can hear you." },
        confidence: 0.96,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(execution.run.status).toBe("ok");
    expect(currentAfterStep(execution, "normalise-decision").taskPipelineInput).toBeUndefined();
    expect(result.createdTask).toBeUndefined();
    expect(result.childPipeline).toBeUndefined();
    expect(result.agentResponse).toMatchObject({
      shouldRespond: true,
      responseDraft: "Yes, I can hear you.",
    });
  });

  test("shared chat dispatch execution think_then_answer stays chat-only", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Think through the tradeoffs and answer here.",
      agentDecision: {
        intent: "think_then_answer",
        dispatchTask: false,
        chatResponse: { body: "The main tradeoff is speed versus durability." },
        confidence: 0.86,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(execution.run.status).toBe("ok");
    expect(result.createdTask).toBeUndefined();
    expect(result.childPipeline).toBeUndefined();
    expect(result.agentResponse).toMatchObject({
      shouldRespond: true,
      responseDraft: "The main tradeoff is speed versus durability.",
    });
  });

  test("shared chat dispatch promotes promissory think_then_answer to task routing", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Please can you review all the Autopilot sessions from today and give me an update on where we're at with our projects?",
      agentDecision: {
        intent: "think_then_answer",
        dispatchTask: false,
        taskDraft: null,
        chatResponse: { body: "I'll review today's Autopilot sessions and then give you a concise project status update in this thread." },
        confidence: 0.93,
      },
      taskPipelineDecision: {
        recommendedPipelineId: "do-and-review",
        workdir: "/repo",
        chatResponse: { body: "Starting the session review task." },
        confidence: 0.91,
      },
    });

    const decision = currentAfterStep(execution, "normalise-decision").decision as JsonObject;
    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(execution.run.status).toBe("ok");
    expect(decision).toMatchObject({
      requestedDispatchTask: true,
      taskRoutingPending: true,
      intent: "create_task",
      originalIntent: "think_then_answer",
    });
    expect(result.createdTask).toMatchObject({
      workPlan: {
        taskSummary: "Review today's Autopilot sessions and project status",
      },
    });
    expect(JSON.stringify(result.createdTask)).toContain("Original request: Please can you review all the Autopilot sessions from today");
    expect(result.childPipeline).toMatchObject({
      pipelineDefinitionId: "do-and-review",
    });
  });

  test("shared chat dispatch execution create_task loads pipelines after intent", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Please update the repo and add tests.",
      agentDecision: {
        intent: "create_task",
        dispatchTask: true,
        taskDraft: {
          title: "Update repo and tests",
          instructions: "Update the repo and add tests.",
          acceptanceCriteria: ["Tests cover the change"],
        },
        chatResponse: { body: "Starting the implementation task." },
        confidence: 0.9,
      },
      taskPipelineDecision: {
        recommendedPipelineId: "do-and-review",
        workdir: "/repo",
        chatResponse: { body: "Starting the implementation task." },
        confidence: 0.9,
      },
    });

    const taskInput = currentAfterStep(execution, "prepare-task-pipeline-input").taskPipelineInput as JsonObject;
    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(execution.run.status).toBe("ok");
    expect(taskInput.validChildPipelines).toEqual([
      {
        id: "do-and-review",
        slug: "do-and-review",
        name: "do-and-review",
        scope: "shared",
        description: null,
      },
    ]);
    expect(result.createdTask).toMatchObject({ taskId: "task-created" });
    expect(result.childPipeline).toMatchObject({ pipelineDefinitionId: "do-and-review" });
    expect(result.decision).toMatchObject({ dispatchTask: true, taskRoutingPending: false });
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

  test("shared chat dispatch execution approval-like text does not complete review tasks", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Approved, this is done.",
      referencedRecords: [
        { recordId: "task-review", family: "task", state: "review", title: "Review natural chat dispatch" },
      ],
      agentDecision: {
        intent: "answer_now",
        dispatchTask: false,
        chatResponse: { body: "I see the approval. Task/review workflow will handle any lifecycle transition." },
        confidence: 0.8,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(execution.run.status).toBe("ok");
    expect(result.createdTask).toBeUndefined();
    expect(result.childPipeline).toBeUndefined();
    expect(result.reviewApproval).toBeUndefined();
    expect(result.reviewCompletion).toBeUndefined();
    expect(result.agentResponse).toMatchObject({
      shouldRespond: true,
      responseDraft: "I see the approval. Task/review workflow will handle any lifecycle transition.",
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

  test("dispatch.prepareChatDispatchResponse describes reused tasks distinctly", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatDispatchResponse"]!({
      decision: {
        dispatchTask: true,
        pipelineDefinitionId: "software-implementation-review-loop",
        confidence: 0.9,
      },
      createdTask: {
        reused: true,
        taskId: "task-1",
        workPlan: {
          taskSummary: "Existing setup permissions bug",
        },
      },
      childPipeline: {
        started: true,
        pipelineName: "software-implementation-review-loop",
        pipelineRunId: "run-1",
      },
    });

    expect(result.responseDraft).toContain(
      "I reopened task @[Existing setup permissions bug](mention:task:task-1) and started software-implementation-review-loop (run-1).",
    );
    expect(result.reasoningSummary).toBe("Reused an existing task and started the selected pipeline.");
    expect(result.actionsTaken).toEqual(["reused task task-1", "started pipeline run run-1"]);
  });

  test("dispatch.prepareChatDispatchResponse reports immediate child pipeline errors", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatDispatchResponse"]!({
      decision: {
        dispatchTask: true,
        pipelineDefinitionId: "research-and-report",
        confidence: 0.9,
      },
      createdTask: {
        taskId: "task-1",
        workPlan: {
          taskSummary: "Session review",
        },
      },
      childPipeline: {
        started: true,
        status: "error",
        pipelineName: "research-and-report",
        pipelineRunId: "run-1",
        reason: "agent callback timed out",
      },
    });

    expect(result.responseDraft).toContain(
      "I created task @[Session review](mention:task:task-1), but the selected pipeline did not start: agent callback timed out.",
    );
    expect(result.reasoningSummary).toBe("Task-backed dispatch created a task, but the selected child pipeline failed to start or errored immediately.");
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
