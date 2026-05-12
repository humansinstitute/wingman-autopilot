import { describe, expect, test } from "bun:test";
import { builtinPipelineFunctions } from "./functions";

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
    expect(result.childPipelineDefinitionId).toBe("software-implementation-manager-review");
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
            slug: "demo-declarative-pipeline",
            name: "demo-declarative-pipeline",
            scope: "shared",
            description: null,
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
    expect(JSON.stringify(result)).not.toContain("demo-declarative-pipeline");
    expect(JSON.stringify(result)).not.toContain("agent-dispatch-chat");
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
