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

function mention(type: string, id: string, label: string): string {
  const safeLabel = label.replace(/[\[\]\n\r]+/g, " ").replace(/\s+/g, " ").trim() || type;
  return `@[${safeLabel}](mention:${type}:${id})`;
}

function isDispatchPipelineIdentifier(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "agent-dispatch-chat"
    || normalized.startsWith("agent-dispatch-")
    || normalized.startsWith("demo-agent-dispatch-")
    || normalized.includes("/agent-dispatch-chat.json")
    || normalized.includes("/agent-dispatch-")
    || normalized.includes("/demo-agent-dispatch-");
}

const coreChatChildPipelineSlugs = new Set([
  "do-and-review",
  "software-implementation-review-loop",
  "research-and-report",
]);

function compactText(value: unknown, maxLength: number): string | null {
  const text = getText(value);
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function tokenizeForMatch(value: unknown): Set<string> {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  const ignored = new Set([
    "about", "after", "again", "also", "and", "are", "can", "for", "from", "has", "into", "please", "report", "run", "runs",
    "send", "that", "the", "this", "was", "will", "with", "work", "you",
  ]);
  return new Set(
    text
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !ignored.has(token)),
  );
}

function scorePipelineRelevance(pipeline: Record<string, unknown>, promptTokens: Set<string>): number {
  if (promptTokens.size === 0) return 0;
  const text = [
    getText(pipeline.slug),
    getText(pipeline.name),
    getText(pipeline.description),
  ].filter(Boolean).join(" ");
  const pipelineTokens = tokenizeForMatch(text);
  let score = 0;
  for (const token of promptTokens) {
    if (pipelineTokens.has(token)) score += 1;
  }
  return score;
}

function compactPipelineDefinition(value: unknown, promptTokens: Set<string>): JsonObject | null {
  const pipeline = objectValue(value);
  const id = getText(pipeline.id);
  const slug = getText(pipeline.slug);
  const name = getText(pipeline.name);
  if (isDispatchPipelineIdentifier(id) || isDispatchPipelineIdentifier(slug) || isDispatchPipelineIdentifier(name)) {
    return null;
  }
  const normalizedSlug = slug?.toLowerCase() ?? "";
  const relevance = scorePipelineRelevance(pipeline, promptTokens);
  const isCorePipeline = coreChatChildPipelineSlugs.has(normalizedSlug);
  if (!isCorePipeline && relevance < 2) {
    return null;
  }
  return {
    id,
    slug,
    name,
    scope: getText(pipeline.scope),
    description: compactText(pipeline.description, isCorePipeline ? 220 : 160),
  };
}

function compactScope(value: unknown): JsonObject {
  const scope = objectValue(value);
  return {
    id: getText(scope.record_id ?? scope.id),
    title: getText(scope.title),
    level: getText(scope.level),
    parentId: getText(scope.parent_id),
  };
}

function extractScopeRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const object = objectValue(value);
  const candidates = [
    object.scopes,
    object.records,
    object.items,
    object.data,
    object.results,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  const nestedData = objectValue(object.data);
  const nestedCandidates = [
    nestedData.scopes,
    nestedData.records,
    nestedData.items,
    nestedData.results,
  ];
  for (const candidate of nestedCandidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function compactThreadMessage(value: unknown): JsonObject {
  const message = objectValue(value);
  return {
    messageId: getText(message.message_id ?? message.record_id),
    parentMessageId: getText(message.parent_message_id),
    senderNpub: getText(message.sender_npub ?? message.senderNpub),
    body: compactText(message.body ?? message.messageText, 3000) ?? "",
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    updatedAt: getText(message.updated_at ?? message.updatedAt),
  };
}

function compactReferencedRecord(value: unknown): JsonObject {
  const record = objectValue(value);
  const payload = objectValue(record.payload);
  const data = objectValue(payload.data);
  return {
    recordId: getText(record.record_id ?? record.recordId ?? payload.record_id),
    family: getText(record.record_family ?? record.recordFamily ?? record.family),
    state: getText(record.record_state ?? record.recordState ?? payload.record_state),
    title: compactText(record.title ?? payload.title ?? data.title, 240),
    summary: compactText(record.summary ?? payload.summary ?? data.summary ?? payload.description ?? data.description ?? payload.body, 900),
    url: getText(record.url ?? payload.url ?? data.url),
    updatedAt: getText(record.updated_at ?? record.updatedAt ?? payload.updated_at),
  };
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

  async "dispatch.prepareChatIntentInput"(input) {
    const dispatch = objectValue(input.dispatch);
    const workspace = objectValue(input.workspace);
    const agent = objectValue(input.agent);
    const chat = objectValue(input.chat);
    const record = objectValue(input.record);
    const routing = objectValue(input.routing);
    const runtime = objectValue(input.runtime);
    const chatContext = objectValue(input.chatContext);
    const thread = objectValue(chatContext.thread);
    const recentMessages = Array.isArray(thread.recent_messages)
      ? thread.recent_messages
      : Array.isArray(thread.recentMessages)
        ? thread.recentMessages
        : [];
    const latestThread = recentMessages.slice(-8).map(compactThreadMessage);
    const promptTokens = tokenizeForMatch(latestThread.map((message) => getText(message.body)).filter(Boolean).join(" "));
    const rawPipelines = Array.isArray(runtime.availablePipelines)
      ? runtime.availablePipelines
      : Array.isArray(chatContext.availablePipelines)
        ? chatContext.availablePipelines
        : [];
    const validChildPipelines = rawPipelines
      .map((pipeline) => compactPipelineDefinition(pipeline, promptTokens))
      .filter((pipeline): pipeline is JsonObject => Boolean(pipeline))
      .sort((a, b) => {
        const aSlug = getText(a.slug)?.toLowerCase() ?? "";
        const bSlug = getText(b.slug)?.toLowerCase() ?? "";
        const aCore = coreChatChildPipelineSlugs.has(aSlug) ? 0 : 1;
        const bCore = coreChatChildPipelineSlugs.has(bSlug) ? 0 : 1;
        return aCore - bCore || aSlug.localeCompare(bSlug);
      })
      .slice(0, 8);
    const scopes = extractScopeRecords(chatContext.scopes)
      .map(compactScope)
      .filter((scope) => Boolean(scope.id));
    const referencedRecords = Array.isArray(chatContext.referencedRecords)
      ? chatContext.referencedRecords.slice(0, 12).map(compactReferencedRecord)
      : [];
    const requesterNpub = getText(chat.senderNpub)
      ?? getText(objectValue(record.payload).sender_npub)
      ?? getText(record.updaterNpub);

    return {
      objective: "Classify the latest chat request and decide whether to start a downstream work pipeline.",
      source: {
        routeId: getText(dispatch.routeId),
        triggerKind: getText(dispatch.triggerKind) ?? "chat",
        channelId: getText(chat.channelId ?? routing.channelId ?? chatContext.channelId),
        threadId: getText(chat.threadId ?? routing.threadId ?? chatContext.threadId),
        messageId: getText(record.recordId),
        requesterNpub,
      },
      selfCheck: {
        shouldProceed: chatContext.shouldProceed !== false,
        selfAuthored: chatContext.selfAuthored === true,
        suppressionReason: getText(chatContext.suppressionReason),
        matchedSelfNpub: getText(chatContext.matchedSelfNpub),
        botNpub: getText(agent.botNpub),
        workspaceOwnerNpub: getText(workspace.workspaceOwnerNpub),
        sourceAppNpub: getText(workspace.sourceAppNpub),
      },
      defaults: {
        workdir: getText(agent.workingDirectory),
        defaultAgent: getText(agent.defaultAgent),
        assignerNpub: requesterNpub,
        reviewerNpub: requesterNpub,
      },
      latestThread,
      referencedRecords,
      scopes,
      validChildPipelines,
      notes: [
        "Use latestThread as the authoritative current conversation.",
        "Use referencedRecords only as supporting Flight Deck context.",
        "Choose only a pipeline listed in validChildPipelines.",
        "For generic or miscellaneous chat-created tasks, choose do-and-review.",
        "Use software-implementation-review-loop only for code, repository, build, test, deployment, or implementation work.",
        "Use research-and-report when the requested output is explicitly research with a report or document.",
        "Choose a scope from scopes when one fits; if scopes is empty or no scope fits, set scopeId to null and continue.",
      ],
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

  async "dispatch.ensureImplementationReviewTask"(input) {
    return {
      published: false,
      status: "not_configured",
      operation: "tasks.ensure-implementation-review-loop",
      reason: "This function only creates or updates Flight Deck tasks when the pipeline is launched by a Wingman dispatch route.",
      taskId: input.taskId ?? null,
    };
  },

  async "dispatch.commentImplementationReviewProgress"(input) {
    return {
      published: false,
      status: "not_configured",
      operation: "tasks.comment-implementation-review-progress",
      reason: "This function only comments on Flight Deck tasks when the pipeline is launched by a Wingman dispatch route.",
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
      ? "software-implementation-review-loop"
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
    const thread = objectValue(chatContext.thread);
    const recentMessages = Array.isArray(thread.recent_messages)
      ? thread.recent_messages
      : Array.isArray(thread.recentMessages)
        ? thread.recentMessages
        : [];
    const originThread = recentMessages.slice(-8).map(compactThreadMessage);
    const latestOriginMessage = originThread[originThread.length - 1] ?? {};
    const originalPrompt = getText(latestOriginMessage.body)
      ?? getText(chat.messageText)
      ?? getText(payload.body);
    const referencedRecords = Array.isArray(chatContext.referencedRecords)
      ? chatContext.referencedRecords.slice(0, 12).map(compactReferencedRecord)
      : [];
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
        originalPrompt,
        originThread,
        referencedRecords,
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
    const createdTaskWorkPlan = objectValue(createdTask.workPlan);
    const taskLabel = getText(createdTaskWorkPlan.taskSummary)
      ?? getText(createdTask.title)
      ?? "created task";
    const taskMention = taskId ? mention("task", taskId, taskLabel) : null;
    const pipelineName = getText(childPipeline.pipelineName) ?? getText(decision.pipelineDefinitionId);
    const pipelineRunId = getText(childPipeline.pipelineRunId);
    const launchFailed = childPipeline.started === false || getText(childPipeline.status) === "failed";
    let responseDraft = getText(decision.responseDraft) ?? "Done.";
    if (decision.dispatchTask === true && taskId) {
      responseDraft = launchFailed
        ? `I created task ${taskMention}, but the selected pipeline did not start: ${getText(childPipeline.reason) ?? "unknown error"}. I marked the task blocked for review.`
        : `I created task ${taskMention} and started ${pipelineName ?? "the selected pipeline"}${pipelineRunId ? ` (${pipelineRunId})` : ""}. I will hand it back for review when the pipeline finishes.`;
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
