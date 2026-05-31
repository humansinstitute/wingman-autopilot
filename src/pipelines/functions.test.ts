import { describe, expect, test } from "bun:test";
import { generateSecretKey, nip19 } from "nostr-tools";
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
