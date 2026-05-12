import type { FunctionRegistry } from "./declarative";
import type { JsonObject } from "./pipeline-store";

interface MemoryEntity {
  name: string;
  type: string;
  reason: string;
  query: string;
}

interface GraphMemoryMatch {
  id: string;
  entity: string;
  entityType: string;
  title: string;
  source: string;
  score: number;
  excerpt: string;
  labels: string[];
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => typeof item === "string" ? item.trim() : "")
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function isDispatchPipelineIdentifier(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "agent-dispatch-chat"
    || normalized.startsWith("demo-agent-dispatch-")
    || normalized.includes("/agent-dispatch-chat.json")
    || normalized.includes("/demo-agent-dispatch-");
}

export const builtinPipelineFunctions: FunctionRegistry = {
  async "text.normalise"(input) {
    const text = String(input.text ?? "").trim();
    return {
      text,
      words: wordCount(text),
      allowedKinds: ["decision", "clarification", "summary"],
    };
  },

  async "text.paragraphs"(input) {
    const text = String(input.text ?? "").trim();
    const targetParagraphNumber = Math.max(1, Math.floor(Number(input.targetParagraphNumber ?? 2) || 2));
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((paragraph, index) => ({
        number: index + 1,
        text: paragraph,
        words: wordCount(paragraph),
      }));
    const selectedParagraph = paragraphs[targetParagraphNumber - 1] ?? null;
    return {
      paragraphCount: paragraphs.length,
      targetParagraphNumber,
      paragraphs,
      selectedParagraph,
    };
  },

  async "text.features"(input) {
    const text = String(input.text ?? "");
    const lower = text.toLowerCase();
    return {
      words: Number(input.words ?? 0),
      mentionsJson: lower.includes("json"),
      mentionsPipeline: lower.includes("pipeline"),
      asksForStructure: lower.includes("declarative") || lower.includes("object"),
    };
  },

  async "agent.parseClassification"(input) {
    const raw = objectValue(input.raw);
    const allowedKinds = Array.isArray(input.allowedKinds) ? input.allowedKinds.map(String) : [];
    const kind = typeof raw.kind === "string" && allowedKinds.includes(raw.kind) ? raw.kind : "summary";
    return {
      kind,
      reason: typeof raw.reason === "string" ? raw.reason : "No reason supplied.",
      confidence: clampConfidence(raw.confidence),
      parsedAt: new Date().toISOString(),
    };
  },

  async "agent.parseParagraphAnalysis"(input) {
    const raw = objectValue(input.raw);
    const paragraph = objectValue(input.paragraph);
    const keyPoints = Array.isArray(raw.keyPoints)
      ? raw.keyPoints.map(String).filter(Boolean)
      : [];
    return {
      paragraphNumber: Number(paragraph.number ?? input.paragraphNumber ?? 2),
      paragraphText: typeof paragraph.text === "string" ? paragraph.text : "",
      summary: typeof raw.summary === "string" ? raw.summary : "No summary supplied.",
      sentiment: typeof raw.sentiment === "string" ? raw.sentiment : "unknown",
      keyPoints,
      actionRequired: Boolean(raw.actionRequired),
      confidence: clampConfidence(raw.confidence),
      parsedAt: new Date().toISOString(),
    };
  },

  async "route.byKind"(input) {
    const kind = String(input.kind ?? "");
    return {
      routedTo: kind === "clarification" ? "ask-user" : "continue",
      priority: kind === "decision" ? "normal" : "low",
    };
  },

  async "dispatch.publishFlightDeckResponse"(input) {
    return {
      published: false,
      status: "not_configured",
      operation: "flightdeck_publish",
      reason: "This function only publishes when the pipeline is launched by a Wingman dispatch route.",
      agentResponse: input.agentResponse ?? null,
    };
  },

  async "dispatch.hydrateChatContext"(input) {
    return {
      hydrated: false,
      status: "not_configured",
      operation: "chat.hydrate-context",
      reason: "This function only hydrates chat context when the pipeline is launched by a Wingman dispatch route.",
      chat: input.chat ?? null,
    };
  },

  async "dispatch.createChatTask"(input) {
    return {
      created: false,
      status: "not_configured",
      operation: "tasks.create-from-chat",
      reason: "This function only creates Flight Deck tasks when the pipeline is launched by a Wingman dispatch route.",
      decision: input.decision ?? null,
    };
  },

  async "dispatch.blockTaskIfPipelineLaunchFailed"(input) {
    return {
      updated: false,
      status: "not_configured",
      operation: "tasks.block-on-pipeline-launch-failure",
      reason: "This function only updates Flight Deck tasks when the pipeline is launched by a Wingman dispatch route.",
      childPipeline: input.childPipeline ?? null,
    };
  },

  async "dispatch.markTaskInProgress"(input) {
    return {
      published: false,
      status: "not_configured",
      operation: "tasks.move-to-in-progress",
      reason: "This function only updates Flight Deck tasks when the pipeline is launched by a Wingman dispatch route.",
      taskId: input.taskId ?? null,
    };
  },

  async "dispatch.markTaskReadyForReview"(input) {
    return {
      published: false,
      status: "not_configured",
      operation: "tasks.move-to-review",
      reason: "This function only updates Flight Deck tasks when the pipeline is launched by a Wingman dispatch route.",
      taskId: input.taskId ?? null,
    };
  },

  async "dispatch.normaliseTaskWorkPlan"(input) {
    const response = objectValue(input.agentResponse ?? input.workPlan ?? input);
    const record = objectValue(input.record);
    const agent = objectValue(input.agent);
    const payload = objectValue(record.payload ?? input.payload);
    const payloadData = objectValue(payload.data);
    const title = String(payload.title ?? payloadData.title ?? response.title ?? "").toLowerCase();
    const description = String(payload.description ?? payloadData.description ?? response.description ?? "").toLowerCase();
    const requestedStyle = String(
      response.workStyle
        ?? response.pipelineStyle
        ?? response.recommendedPipeline
        ?? response.childPipelineDefinitionId
        ?? "",
    ).toLowerCase();
    const combined = `${requestedStyle} ${title} ${description}`;
    const softwareLikely = /\b(code|software|implementation|bug|fix|repo|repository|test|typescript|javascript|frontend|backend|api|database|migration|build|deploy|ui|server)\b/.test(combined);
    const workStyle = requestedStyle.includes("do_and_review") || requestedStyle.includes("generic")
      ? "do_and_review"
      : requestedStyle.includes("software") || requestedStyle.includes("implementation") || softwareLikely
        ? "software_implementation"
        : "do_and_review";
    const childPipelineDefinitionId = workStyle === "software_implementation"
      ? "software-implementation-manager-review"
      : "do-and-review";
    const executionPlan = getStringArray(response.executionPlan);
    const managerChecklist = getStringArray(response.managerChecklist);
    const taskUpdatePlan = getStringArray(response.taskUpdatePlan);
    return {
      accepted: response.accepted !== false,
      workStyle,
      childPipelineDefinitionId,
      taskSummary: typeof response.taskSummary === "string"
        ? response.taskSummary
        : typeof response.summary === "string"
          ? response.summary
          : String(payload.title ?? "Task accepted for dispatch."),
      initialFindings: getStringArray(response.initialFindings),
      executionPlan: executionPlan.length > 0 ? executionPlan : [
        "Confirm the latest task context and constraints.",
        "Complete the worker pass using the selected child pipeline.",
        "Run manager review against the task requirements and evidence.",
        "Update the task with progress, result, and any remaining blockers.",
      ],
      managerChecklist: managerChecklist.length > 0 ? managerChecklist : [
        "The worker used the full task context.",
        "The result addresses the requested outcome.",
        "Evidence and sources or verification steps are recorded.",
        "The task has been updated at appropriate milestones.",
      ],
      taskUpdatePlan: taskUpdatePlan.length > 0 ? taskUpdatePlan : [
        "Comment when the child pipeline is launched.",
        "Comment after worker completion with evidence.",
        "Move the task to review or done only after manager review.",
      ],
      workdir: getText(response.workdir ?? response.workingDirectory ?? agent.workingDirectory),
      suggestedStatus: "in_progress",
      confidence: clampConfidence(response.confidence),
    };
  },

  async "dispatch.normaliseChatDispatchDecision"(input) {
    const chatContext = objectValue(input.chatContext);
    if (chatContext.shouldProceed === false) {
      const reason = getText(chatContext.suppressionReason) ?? "chat_dispatch_suppressed";
      return {
        dispatchTask: false,
        requestedDispatchTask: false,
        pipelineDefinitionId: null,
        scopeId: null,
        workdir: null,
        missing: [],
        clarifyingQuestion: null,
        responseDraft: "",
        shouldRespond: false,
        suppressed: true,
        suppressionReason: reason,
        taskDraft: {
          title: "",
          instructions: "",
          acceptanceCriteria: [],
          executionPlan: [],
          managerChecklist: [],
          assignerNpub: null,
          reviewerNpub: null,
        },
        workPlan: {
          childPipelineDefinitionId: null,
          pipelineDefinitionId: null,
          taskSummary: "",
          instructions: "",
          acceptanceCriteria: [],
          executionPlan: [],
          managerChecklist: [],
          scopeId: null,
          workdir: null,
          assignerNpub: null,
          reviewerNpub: null,
          origin: {
            triggerKind: getText(objectValue(input.dispatch).triggerKind) ?? "chat",
            channelId: getText(objectValue(input.chat).channelId),
            threadId: getText(objectValue(input.chat).threadId),
            messageId: getText(objectValue(input.record).recordId),
          },
        },
        confidence: 1,
      };
    }
    const raw = objectValue(input.agentDecision ?? input.decision ?? input.agentResponse ?? input);
    const intent = getText(raw.intent ?? raw.classification ?? raw.action)?.toLowerCase();
    if (intent === "ignore") {
      return {
        dispatchTask: false,
        requestedDispatchTask: false,
        pipelineDefinitionId: null,
        scopeId: null,
        workdir: null,
        missing: [],
        clarifyingQuestion: null,
        responseDraft: "",
        shouldRespond: false,
        suppressed: true,
        suppressionReason: "agent_intent_ignore",
        taskDraft: {
          title: "",
          instructions: "",
          acceptanceCriteria: [],
          executionPlan: [],
          managerChecklist: [],
          assignerNpub: null,
          reviewerNpub: null,
        },
        workPlan: {
          childPipelineDefinitionId: null,
          pipelineDefinitionId: null,
          taskSummary: "",
          instructions: "",
          acceptanceCriteria: [],
          executionPlan: [],
          managerChecklist: [],
          scopeId: null,
          workdir: null,
          assignerNpub: null,
          reviewerNpub: null,
          origin: {
            triggerKind: getText(objectValue(input.dispatch).triggerKind) ?? "chat",
            channelId: getText(objectValue(input.chat).channelId),
            threadId: getText(objectValue(input.chat).threadId),
            messageId: getText(objectValue(input.record).recordId),
          },
        },
        confidence: clampConfidence(raw.confidence),
      };
    }
    const chat = objectValue(input.chat);
    const record = objectValue(input.record);
    const payload = objectValue(record.payload);
    const agent = objectValue(input.agent);
    const dispatchTask = raw.dispatchTask === true;
    const pipelineDefinitionId = getText(
      raw.recommendedPipelineId
        ?? raw.recommendedPipelineDefinitionId
        ?? raw.pipelineDefinitionId
        ?? raw.recommendedPipeline,
    );
    const taskDraft = objectValue(raw.taskDraft);
    const scopeId = getText(raw.scopeId ?? taskDraft.scopeId);
    const workdir = getText(raw.workdir ?? taskDraft.workdir ?? agent.workingDirectory);
    const assignerNpub = getText(raw.assignerNpub ?? taskDraft.assignerNpub ?? chat.senderNpub ?? payload.sender_npub ?? record.updaterNpub);
    const reviewerNpub = getText(raw.reviewerNpub ?? taskDraft.reviewerNpub ?? assignerNpub);
    const title = getText(taskDraft.title ?? raw.title) ?? "Chat-requested Wingman task";
    const instructions = getText(taskDraft.instructions ?? raw.instructions ?? raw.taskInstructions ?? raw.messageSummary);
    const acceptanceCriteria = getStringArray(taskDraft.acceptanceCriteria ?? raw.acceptanceCriteria);
    const executionPlan = getStringArray(taskDraft.executionPlan ?? raw.executionPlan);
    const managerChecklist = getStringArray(taskDraft.managerChecklist ?? raw.managerChecklist);
    const clarifyingQuestion = getText(raw.clarifyingQuestion);
    const selectedDispatchPipeline = isDispatchPipelineIdentifier(pipelineDefinitionId);
    const chatResponseBody = getText(objectValue(raw.chatResponse).body)
      ?? getText(raw.responseDraft)
      ?? getText(raw.replyDraft)
      ?? getText(raw.answer);
    const missing = dispatchTask
      ? [
          !pipelineDefinitionId ? "pipeline" : "",
          selectedDispatchPipeline ? "downstream work pipeline" : "",
          !scopeId ? "scope" : "",
          !workdir ? "workdir" : "",
          !instructions ? "instructions" : "",
        ].filter(Boolean)
      : [];
    const shouldDispatchTask = dispatchTask && missing.length === 0 && !clarifyingQuestion;
    const responseDraft = shouldDispatchTask
      ? (chatResponseBody ?? "I have the request and am starting the right pipeline-backed task now.")
      : clarifyingQuestion
        ?? chatResponseBody
        ?? (missing.length > 0
          ? `I need one clarification before starting work: ${missing.join(", ")}.`
          : "I can handle this directly in chat.");
    return {
      dispatchTask: shouldDispatchTask,
      requestedDispatchTask: dispatchTask,
      pipelineDefinitionId: shouldDispatchTask ? pipelineDefinitionId : null,
      scopeId: shouldDispatchTask ? scopeId : null,
      workdir: shouldDispatchTask ? workdir : null,
      missing,
      clarifyingQuestion,
      responseDraft,
      taskDraft: {
        title,
        instructions: instructions ?? "",
        acceptanceCriteria,
        executionPlan,
        managerChecklist,
        assignerNpub,
        reviewerNpub,
      },
      workPlan: {
        childPipelineDefinitionId: shouldDispatchTask ? pipelineDefinitionId : null,
        pipelineDefinitionId: shouldDispatchTask ? pipelineDefinitionId : null,
        taskSummary: title,
        instructions: instructions ?? "",
        acceptanceCriteria,
        executionPlan,
        managerChecklist,
        scopeId: shouldDispatchTask ? scopeId : null,
        workdir: shouldDispatchTask ? workdir : null,
        assignerNpub,
        reviewerNpub,
        origin: {
          triggerKind: getText(objectValue(input.dispatch).triggerKind) ?? "chat",
          channelId: getText(chat.channelId),
          threadId: getText(chat.threadId),
          messageId: getText(record.recordId),
        },
      },
      confidence: clampConfidence(raw.confidence),
    };
  },

  async "dispatch.prepareChatDispatchResponse"(input) {
    const decision = objectValue(input.decision);
    if (decision.shouldRespond === false || decision.suppressed === true) {
      return {
        shouldRespond: false,
        responseDraft: "",
        reasoningSummary: getText(decision.suppressionReason) ?? "Chat dispatch was suppressed.",
        actionsTaken: [],
        confidence: clampConfidence(decision.confidence),
      };
    }
    const createdTask = objectValue(input.createdTask);
    const childPipeline = objectValue(input.childPipeline);
    const taskId = getText(createdTask.taskId);
    const pipelineName = getText(childPipeline.pipelineName) ?? getText(decision.pipelineDefinitionId);
    const pipelineRunId = getText(childPipeline.pipelineRunId);
    const launchFailed = childPipeline.started === false || getText(childPipeline.status) === "failed";
    let responseDraft = getText(decision.responseDraft) ?? "Done.";
    if (decision.dispatchTask === true && taskId) {
      responseDraft = launchFailed
        ? `I created task ${taskId}, but the selected pipeline did not start: ${getText(childPipeline.reason) ?? "unknown error"}. I marked the task blocked for review.`
        : `I created task ${taskId} and started ${pipelineName ?? "the selected pipeline"}${pipelineRunId ? ` (${pipelineRunId})` : ""}. I will hand it back for review when the pipeline finishes.`;
    }
    return {
      shouldRespond: true,
      responseDraft,
      reasoningSummary: getText(decision.clarifyingQuestion)
        ? "Asked a clarifying question instead of dispatching work."
        : decision.dispatchTask === true
          ? "Created a task and started the selected pipeline."
          : "Responded directly without dispatching task-backed work.",
      actionsTaken: [
        ...(taskId ? [`created task ${taskId}`] : []),
        ...(pipelineRunId ? [`started pipeline run ${pipelineRunId}`] : []),
      ],
      confidence: clampConfidence(decision.confidence),
    };
  },

  async "object.finalise"(input) {
    return {
      text: input.normalised,
      features: input.features,
      agentRaw: input.agentRaw,
      classification: input.classification,
      route: input.route,
    };
  },

  async "object.finaliseParagraphAnalysis"(input) {
    const document = objectValue(input.document);
    return {
      paragraphCount: document.paragraphCount ?? 0,
      selectedParagraph: document.selectedParagraph ?? null,
      analysis: input.analysis ?? null,
    };
  },

  async "review.appendIteration"(input) {
    const existing = Array.isArray(input.history) ? input.history : [];
    const loop = objectValue(input.loop);
    return {
      items: [
        ...existing,
        {
          iteration: Number(loop.iteration ?? existing.length + 1),
          critic: objectValue(input.critic),
          response: objectValue(input.response),
        },
      ],
    };
  },

  async "review.finaliseDesignReview"(input) {
    return {
      documentUrl: typeof input.documentUrl === "string" ? input.documentUrl : "",
      iterations: Number(input.iterations ?? 0),
      reviewHistory: input.reviewHistory,
      finalCriticNotes: input.critic,
      finalResponseNotes: input.response,
      tidyUp: input.tidyUp,
    };
  },

  async "memory.searchEntities"(input) {
    const entities = normaliseMemoryEntities(input.entities).slice(0, positiveInteger(input.maxEntities, 8));
    const topKPerEntity = positiveInteger(input.topKPerEntity, 5);
    const maxMatches = positiveInteger(input.maxMatches, 20);
    const warnings: string[] = [];
    if (entities.length === 0) {
      return {
        matches: [],
        entities,
        warnings: ["No memory entities were provided for graph search."],
        graphMemoryAvailable: false,
      };
    }

    const config = getGraphMemoryConfig(input);
    if (!config.ok) {
      return {
        matches: [],
        entities,
        warnings: [config.warning],
        graphMemoryAvailable: false,
      };
    }

    const settled = await Promise.all(entities.map(async (entity) => {
      try {
        const embedding = await embedGraphMemoryQuery(entity.query || entity.name, config.value);
        return await queryNeo4jVectorMemory({
          embedding,
          entity,
          topK: topKPerEntity,
          ownerNpub: typeof input.ownerNpub === "string" ? input.ownerNpub : null,
          config: config.value,
        });
      } catch (error) {
        warnings.push(`${entity.name}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }));

    return {
      matches: dedupeGraphMemoryMatches(settled.flat()).slice(0, maxMatches),
      entities,
      warnings,
      graphMemoryAvailable: true,
      searchedAt: new Date().toISOString(),
    };
  },

  async "memory.consolidateGraphContext"(input) {
    const matches = normaliseGraphMemoryMatches(input.matches);
    const entities = normaliseMemoryEntities(input.entities);
    const warnings = Array.isArray(input.warnings) ? input.warnings.map(String).filter(Boolean) : [];
    const maxChars = positiveInteger(input.maxChars, 6000, 50_000);
    const sources = matches.map((match) => ({
      id: match.id,
      entity: match.entity,
      entityType: match.entityType,
      title: match.title,
      source: match.source,
      score: match.score,
      excerpt: match.excerpt,
      labels: match.labels,
    }));
    const header = [
      "graphContext is potential context from long-term memory.",
      "Treat it as a guide, not authoritative truth.",
      "Consider it where relevant, and verify against current files, records, or user input before relying on it.",
    ].join(" ");
    const entityLine = entities.length
      ? `Searched entities: ${entities.map((entity) => `${entity.name} (${entity.type})`).join(", ")}.`
      : "No extracted entities were available.";
    const body = matches.length
      ? matches.map((match, index) => {
        const title = match.title || match.source || match.id;
        const source = match.source ? ` | source: ${match.source}` : "";
        const entity = match.entity ? ` | entity: ${match.entity}` : "";
        return `[${index + 1}] ${title}${entity}${source} | score: ${match.score.toFixed(3)}\n${match.excerpt}`;
      }).join("\n\n")
      : "No graph memory matches were found.";
    const warningText = warnings.length ? `\n\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : "";
    return {
      graphContext: truncateText(`${header}\n\n${entityLine}\n\n${body}${warningText}`, maxChars),
      graphContextSources: sources,
      graphContextEntities: entities,
      graphContextWarnings: warnings,
      graphContextAvailable: matches.length > 0,
    };
  },
};

function positiveInteger(value: unknown, fallback: number, max = 100): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function normaliseMemoryEntities(value: unknown): MemoryEntity[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => objectValue(item))
    .map((item) => {
      const name = String(item.name ?? "").trim();
      const query = String(item.query ?? name).trim();
      if (!name && !query) return null;
      return {
        name: name || query,
        type: String(item.type ?? "other").trim() || "other",
        reason: String(item.reason ?? "").trim(),
        query: query || name,
      };
    })
    .filter((item): item is MemoryEntity => Boolean(item));
}

function normaliseGraphMemoryMatches(value: unknown): GraphMemoryMatch[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => objectValue(item))
    .map((item) => ({
      id: String(item.id ?? item.source ?? item.title ?? crypto.randomUUID()),
      entity: String(item.entity ?? ""),
      entityType: String(item.entityType ?? "other"),
      title: String(item.title ?? ""),
      source: String(item.source ?? ""),
      score: Number.isFinite(Number(item.score)) ? Number(item.score) : 0,
      excerpt: String(item.excerpt ?? item.text ?? ""),
      labels: Array.isArray(item.labels) ? item.labels.map(String) : [],
    }))
    .filter((item) => item.excerpt || item.title || item.source);
}

function dedupeGraphMemoryMatches(matches: GraphMemoryMatch[]): GraphMemoryMatch[] {
  const byKey = new Map<string, GraphMemoryMatch>();
  for (const match of matches.sort((a, b) => b.score - a.score)) {
    const key = match.id || `${match.source}:${match.title}:${match.excerpt.slice(0, 80)}`;
    if (!byKey.has(key)) byKey.set(key, match);
  }
  return Array.from(byKey.values()).sort((a, b) => b.score - a.score);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n\n[truncated]`;
}

type GraphMemoryConfig =
  | { ok: true; value: {
      neo4jHttpUrl: string;
      neo4jDatabase: string;
      neo4jUsername: string;
      neo4jPassword: string;
      neo4jVectorIndex: string;
      embeddingBaseUrl: string;
      embeddingApiKey: string;
      embeddingModel: string;
    } }
  | { ok: false; warning: string };

function getGraphMemoryConfig(input: JsonObject): GraphMemoryConfig {
  const neo4jHttpUrl = envString("PIPELINE_MEMORY_NEO4J_HTTP_URL")
    || envString("NEO4J_HTTP_URL")
    || neo4jUriAsHttp(envString("NEO4J_URI"));
  const neo4jUsername = envString("PIPELINE_MEMORY_NEO4J_USERNAME") || envString("NEO4J_USERNAME");
  const neo4jPassword = envString("PIPELINE_MEMORY_NEO4J_PASSWORD") || envString("NEO4J_PASSWORD");
  const neo4jVectorIndex = typeof input.index === "string" && input.index.trim()
    ? input.index.trim()
    : envString("PIPELINE_MEMORY_NEO4J_VECTOR_INDEX") || envString("NEO4J_VECTOR_INDEX") || "wingmen_context_embedding";
  const embeddingApiKey = envString("PIPELINE_MEMORY_EMBEDDING_API_KEY") || envString("OPENAI_API_KEY");
  if (!neo4jHttpUrl || !neo4jUsername || !neo4jPassword) {
    return { ok: false, warning: "Neo4j graph memory is not configured. Set NEO4J_HTTP_URL, NEO4J_USERNAME, and NEO4J_PASSWORD." };
  }
  if (!embeddingApiKey) {
    return { ok: false, warning: "Graph memory embeddings are not configured. Set OPENAI_API_KEY or PIPELINE_MEMORY_EMBEDDING_API_KEY." };
  }
  return {
    ok: true,
    value: {
      neo4jHttpUrl,
      neo4jDatabase: envString("PIPELINE_MEMORY_NEO4J_DATABASE") || envString("NEO4J_DATABASE") || "neo4j",
      neo4jUsername,
      neo4jPassword,
      neo4jVectorIndex,
      embeddingBaseUrl: envString("PIPELINE_MEMORY_EMBEDDING_BASE_URL") || envString("OPENAI_BASE_URL") || "https://api.openai.com/v1",
      embeddingApiKey,
      embeddingModel: envString("PIPELINE_MEMORY_EMBEDDING_MODEL") || "text-embedding-3-small",
    },
  };
}

function envString(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function neo4jUriAsHttp(uri: string | null): string | null {
  if (!uri) return null;
  if (uri.startsWith("http://") || uri.startsWith("https://")) return uri;
  return null;
}

async function embedGraphMemoryQuery(query: string, config: Extract<GraphMemoryConfig, { ok: true }>["value"]): Promise<number[]> {
  const response = await fetch(`${config.embeddingBaseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.embeddingApiKey}`,
    },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: query,
    }),
  });
  if (!response.ok) {
    throw new Error(`embedding request failed: HTTP ${response.status}`);
  }
  const payload = await response.json() as { data?: Array<{ embedding?: unknown }> };
  const embedding = payload.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== "number")) {
    throw new Error("embedding response did not include a numeric embedding");
  }
  return embedding as number[];
}

async function queryNeo4jVectorMemory(input: {
  embedding: number[];
  entity: MemoryEntity;
  topK: number;
  ownerNpub: string | null;
  config: Extract<GraphMemoryConfig, { ok: true }>["value"];
}): Promise<GraphMemoryMatch[]> {
  const statement = `
CALL db.index.vector.queryNodes($index, $topK, $embedding)
YIELD node, score
WITH node, score
WHERE $ownerNpub IS NULL OR node.owner_npub = $ownerNpub OR node.ownerNpub = $ownerNpub
RETURN
  elementId(node) AS id,
  labels(node) AS labels,
  coalesce(node.title, node.name, node.path, node.source, "") AS title,
  coalesce(node.source, node.path, node.url, node.file, "") AS source,
  coalesce(node.text, node.content, node.summary, node.description, "") AS excerpt,
  score
ORDER BY score DESC
`;
  const response = await fetch(`${input.config.neo4jHttpUrl.replace(/\/$/, "")}/db/${encodeURIComponent(input.config.neo4jDatabase)}/tx/commit`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${btoa(`${input.config.neo4jUsername}:${input.config.neo4jPassword}`)}`,
    },
    body: JSON.stringify({
      statements: [{
        statement,
        parameters: {
          index: input.config.neo4jVectorIndex,
          topK: input.topK,
          embedding: input.embedding,
          ownerNpub: input.ownerNpub,
        },
      }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Neo4j vector query failed: HTTP ${response.status}`);
  }
  const payload = await response.json() as {
    errors?: Array<{ message?: string }>;
    results?: Array<{ data?: Array<{ row?: unknown[] }> }>;
  };
  const error = payload.errors?.find((item) => item.message);
  if (error?.message) throw new Error(`Neo4j vector query failed: ${error.message}`);
  const rows = payload.results?.[0]?.data ?? [];
  return rows.map((row) => {
    const values = Array.isArray(row.row) ? row.row : [];
    return {
      id: String(values[0] ?? ""),
      labels: Array.isArray(values[1]) ? values[1].map(String) : [],
      title: String(values[2] ?? ""),
      source: String(values[3] ?? ""),
      excerpt: truncateText(String(values[4] ?? ""), 1200),
      score: Number.isFinite(Number(values[5])) ? Number(values[5]) : 0,
      entity: input.entity.name,
      entityType: input.entity.type,
    };
  }).filter((match) => match.id || match.excerpt || match.title);
}
