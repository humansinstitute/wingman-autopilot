import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { DeclarativePipeline } from "./declarative";
import type { PipelineScope } from "./pipeline-store";

export interface PipelineDefinitionRecord {
  id: string;
  slug: string;
  name: string;
  scope: PipelineScope;
  ownerAlias: string | null;
  path: string;
  spec: DeclarativePipeline;
}

const DEMO_DEFINITION = {
  name: "demo-declarative-pipeline",
  input: {
    text: "Pete wants declarative JSON pipelines where each step takes an object and returns an object.",
  },
  steps: [
    {
      name: "normalise",
      type: "code",
      function: "text.normalise",
      input: { pick: { text: "$.text" } },
      assign: "$.normalised",
    },
    {
      name: "extract-features",
      type: "code",
      function: "text.features",
      input: { pick: { text: "$.normalised.text", words: "$.normalised.words" } },
      assign: "$.features",
    },
    {
      name: "classify",
      type: "agent",
      input: {
        pick: {
          text: "$.normalised.text",
          features: "$.features",
          allowedKinds: "$.normalised.allowedKinds",
        },
      },
      prompt: "Classify this pipeline input for the next software step. Return result.kind as one of allowedKinds, result.reason as a short sentence, and result.confidence as a number from 0 to 1.",
      assign: "$.agentRaw",
    },
    {
      name: "parse-agent-output",
      type: "code",
      function: "agent.parseClassification",
      input: { pick: { raw: "$.agentRaw", allowedKinds: "$.normalised.allowedKinds" } },
      assign: "$.classification",
    },
    {
      name: "route",
      type: "code",
      function: "route.byKind",
      input: { pick: { kind: "$.classification.kind" } },
      assign: "$.route",
    },
    {
      name: "finalise",
      type: "code",
      function: "object.finalise",
    },
  ],
};

const PARAGRAPH_ANALYSIS_DEMO_DEFINITION = {
  name: "demo-paragraph-two-agent-analysis",
  input: {
    targetParagraphNumber: 2,
    text: [
      "The first paragraph introduces the pipeline idea. It explains that most of the work should happen in deterministic TypeScript steps before an agent is asked to help.",
      "The second paragraph is the one we want the Wingman agent to analyse. It contains a decision point: should the pipeline continue automatically, ask for clarification, or hand structured context to another job?",
      "The third paragraph closes the example. It exists so the paragraph splitter has more than one surrounding paragraph and the UI can show how the selected paragraph moved through the run.",
    ].join("\n\n"),
  },
  steps: [
    {
      name: "split-paragraphs",
      type: "code",
      function: "text.paragraphs",
      input: {
        pick: {
          text: "$.text",
          targetParagraphNumber: "$.targetParagraphNumber",
        },
      },
      assign: "$.document",
    },
    {
      name: "analyse-paragraph-two",
      type: "agent",
      agent: "codex",
      directory: "/Users/mini/wingmen/wingman21",
      input: {
        pick: {
          paragraphNumber: "$.document.selectedParagraph.number",
          paragraph: "$.document.selectedParagraph.text",
          paragraphCount: "$.document.paragraphCount",
        },
      },
      prompt: "Analyse the selected paragraph for a software pipeline handoff. Post the webhook result object with these fields: summary as a short sentence, sentiment as one of positive/neutral/negative/mixed, keyPoints as an array of short strings, actionRequired as a boolean, and confidence as a number from 0 to 1.",
      assign: "$.agentRaw",
    },
    {
      name: "parse-analysis",
      type: "code",
      function: "agent.parseParagraphAnalysis",
      input: {
        pick: {
          raw: "$.agentRaw",
          paragraph: "$.document.selectedParagraph",
        },
      },
      assign: "$.analysis",
    },
    {
      name: "finalise-paragraph-analysis",
      type: "code",
      function: "object.finaliseParagraphAnalysis",
    },
  ],
};

const GRAPH_CONTEXT_MEMORY_DEMO_DEFINITION = {
  name: "demo-memory-graph-context",
  description: "Extracts searchable entities from a prompt, searches graph memory, and returns graphContext for later agent steps.",
  input: {
    prompt: "How should Wingmen declarative pipelines use Redshift context when reviewing a design?",
    topKPerEntity: 3,
    maxEntities: 8,
    maxMatches: 12,
    graphContextMaxChars: 4000,
    memoryAgent: "codex",
    workingDirectory: "/Users/mini/wingmen/wingman21",
  },
  steps: [
    {
      name: "recall-graph-memory",
      description: "Reusable memory recall block: extract entities, search graph memory, consolidate graphContext.",
      type: "block",
      block: "memory.graphContext",
      input: {
        pick: {
          prompt: "$.prompt",
          topKPerEntity: "$.topKPerEntity",
          maxEntities: "$.maxEntities",
          maxMatches: "$.maxMatches",
          maxChars: "$.graphContextMaxChars",
          agent: "$.memoryAgent",
          directory: "$.workingDirectory",
        },
      },
      assign: "$.memory.graph",
    },
  ],
};

const AGENT_DISPATCH_CHAT_DEFINITION = {
  name: "agent-dispatch-chat",
  description: "Default dispatch pipeline for chat advisories. It hydrates the source thread, classifies whether task-backed work is needed, optionally creates an in-progress task and starts the selected pipeline, then replies to the source Flight Deck thread.",
  input: {
    dispatch: { triggerKind: "chat" },
    workspace: { workspaceOwnerNpub: "npub1workspace", sourceAppNpub: "npub1source" },
    agent: { agentId: "primary", label: "Primary Wingman", workingDirectory: "/workspace", defaultAgent: "codex" },
    record: {
      recordId: "chat-message-demo",
      recordFamily: "chat",
      payload: {
        body: "Can you give me the current status and next action?",
        sender_npub: "npub1user",
      },
    },
    chat: {
      messageText: "Can you give me the current status and next action?",
      senderNpub: "npub1user",
      channelId: "channel-demo",
      threadId: "thread-demo",
    },
    routing: { channelId: "channel-demo", threadId: "thread-demo", bindingType: "thread" },
  },
  steps: [
    {
      name: "hydrate-chat-context",
      description: "Fetch the latest thread, referenced Flight Deck records, visible scopes, and available pipeline definitions before asking the agent to classify intent.",
      type: "code",
      function: "dispatch.hydrateChatContext",
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          chat: "$.chat",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          availablePipelines: "$.runtime.availablePipelines",
        },
      },
      assign: "$.chatContext",
    },
    {
      name: "prepare-intent-input",
      description: "Compact the hydrated chat context into the decision packet the intent agent needs, without passing duplicated runtime machinery.",
      type: "code",
      function: "dispatch.prepareChatIntentInput",
      when: { path: "$.chatContext.shouldProceed", equals: true },
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          chat: "$.chat",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          chatContext: "$.chatContext",
        },
      },
      assign: "$.chatDispatchInput",
    },
    {
      name: "analyse-intent",
      type: "agent",
      when: { path: "$.chatContext.shouldProceed", equals: true },
      agent: "$.agent.defaultAgent",
      directory: "$.agent.workingDirectory",
      input: {
        pick: {
          chatDispatchInput: "$.chatDispatchInput",
        },
      },
      prompt: "You are stage 1 of agent-dispatch-chat: Analyse Intent. The selected input contains chatDispatchInput, a compact decision packet. Use chatDispatchInput.latestThread as the authoritative latest conversation, referencedRecords as supporting Flight Deck context, scopes for scope selection, defaults for workdir/assigner/reviewer defaults, and validChildPipelines as the only allowed child pipeline choices. Do not invent pipeline names and do not choose any dispatch/intake pipeline. One valid intent is ignore: if selfCheck says this is self-authored, set intent ignore, dispatchTask false, and chatResponse.body to an empty string. Decide whether this chat needs extended task-backed work. If it can be answered directly or needs clarification before work starts, set dispatchTask false. If it needs research, implementation, document generation, graph-memory review, or an explicitly requested pipeline, set dispatchTask true only when you can select the pipeline, scope, workdir, task title, instructions, and acceptance criteria. Return JSON only with: intent string, dispatchTask boolean, recommendedPipelineId string|null, scopeId string|null, workdir string|null, taskDraft object with title string, instructions string, acceptanceCriteria array, executionPlan array, managerChecklist array, assignerNpub string|null, reviewerNpub string|null, chatResponse object with body string, clarifyingQuestion string|null, confidence number from 0 to 1. There is always a chat response; for ignore use intent ignore, an empty body, and confidence 1. Do not include responseOnly.",
      assign: "$.agentDecision",
    },
    {
      name: "normalise-decision",
      type: "code",
      function: "dispatch.normaliseChatDispatchDecision",
      when: { path: "$.chatContext.shouldProceed", equals: true },
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          chat: "$.chat",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          chatContext: "$.chatContext",
          agentDecision: "$.agentDecision",
        },
      },
      assign: "$.decision",
    },
    {
      name: "create-in-progress-task",
      type: "code",
      function: "dispatch.createChatTask",
      when: { path: "$.decision.dispatchTask", equals: true },
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          chat: "$.chat",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          decision: "$.decision",
          chatContext: "$.chatContext",
        },
      },
      assign: "$.createdTask",
    },
    {
      name: "start-selected-pipeline",
      type: "code",
      function: "dispatch.startChildPipeline",
      when: { path: "$.decision.dispatchTask", equals: true },
      input: {
        pick: {
          pipelineDefinitionId: "$.createdTask.pipelineDefinitionId",
          workPlan: "$.createdTask.workPlan",
          childInput: "$",
        },
      },
      assign: "$.childPipeline",
    },
    {
      name: "block-task-on-launch-failure",
      type: "code",
      function: "dispatch.blockTaskIfPipelineLaunchFailed",
      when: { path: "$.childPipeline.started", equals: false },
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          workPlan: "$.createdTask.workPlan",
          createdTask: "$.createdTask",
          childPipeline: "$.childPipeline",
        },
      },
      assign: "$.launchFailureUpdate",
    },
    {
      name: "prepare-chat-response",
      type: "code",
      function: "dispatch.prepareChatDispatchResponse",
      when: { path: "$.chatContext.shouldProceed", equals: true },
      input: {
        pick: {
          decision: "$.decision",
          createdTask: "$.createdTask",
          childPipeline: "$.childPipeline",
          launchFailureUpdate: "$.launchFailureUpdate",
        },
      },
      assign: "$.agentResponse",
    },
    {
      name: "publish-chat-response",
      type: "code",
      function: "dispatch.publishFlightDeckResponse",
      when: { path: "$.chatContext.shouldProceed", equals: true },
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          agentResponse: "$.agentResponse",
        },
      },
    },
  ],
};

const AGENT_DISPATCH_TASK_DEMO_DEFINITION = {
  name: "demo-agent-dispatch-task-response",
  description: "Task intake dispatch pipeline. It investigates the task, chooses a longer-running software implementation or generic do-and-review child pipeline, starts it, then comments back with the launched work plan.",
  input: {
    dispatch: { triggerKind: "task" },
    workspace: { workspaceOwnerNpub: "npub1workspace", sourceAppNpub: "npub1source" },
    agent: { agentId: "primary", label: "Primary Wingman", workingDirectory: "/workspace", defaultAgent: "codex" },
    record: {
      recordId: "task-demo",
      recordFamily: "task",
      recordState: "ready",
      payload: {
        task_id: "task-demo",
        title: "Implement a small UI fix",
        description: "Review the request, make the smallest viable change, test it, and report back.",
        state: "ready",
        assigned_to: "npub1bot",
      },
    },
    routing: { bindingId: "task-demo", bindingType: "task", changedFields: ["state"] },
  },
  steps: [
    {
      name: "investigate-and-route-task",
      type: "agent",
      agent: "$.agent.defaultAgent",
      directory: "$.agent.workingDirectory",
      input: {
        pick: {
          workspace: "$.workspace",
          agent: "$.agent",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
        },
      },
      prompt: "You are stage 1 of a Wingman task intake pipeline. Do an initial investigation from the task payload and available runtime commands, then choose how the longer work should run. Choose workStyle as either software_implementation for repo/code/build/test work, or do_and_review for generic work such as internet research, planning, writing, booking research, or operational tasks. Return JSON fields: accepted boolean, workStyle string, taskSummary string, initialFindings array, executionPlan array, managerChecklist array, taskUpdatePlan array, risks array, confidence number from 0 to 1. The executionPlan must explicitly say when the child worker and manager should update the Flight Deck task.",
      assign: "$.agentResponse",
    },
    {
      name: "normalise-work-plan",
      type: "code",
      function: "dispatch.normaliseTaskWorkPlan",
      input: {
        pick: {
          agentResponse: "$.agentResponse",
          record: "$.record",
          routing: "$.routing",
          agent: "$.agent",
        },
      },
      assign: "$.workPlan",
    },
    {
      name: "move-task-to-in-progress",
      description: "Persist the Ready -> In progress transition before any child work is dispatched.",
      type: "code",
      function: "dispatch.markTaskInProgress",
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          workPlan: "$.workPlan",
        },
      },
      assign: "$.taskStartUpdate",
    },
    {
      name: "start-follow-up-pipeline",
      type: "code",
      function: "dispatch.startChildPipeline",
      input: {
        pick: {
          pipelineDefinitionId: "$.workPlan.childPipelineDefinitionId",
          workPlan: "$.workPlan",
          childInput: "$",
        },
      },
      assign: "$.childPipeline",
    },
    {
      name: "publish-task-update",
      type: "code",
      function: "dispatch.publishFlightDeckResponse",
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          agentResponse: "$.workPlan",
          childPipeline: "$.childPipeline",
        },
      },
    },
  ],
};

const SOFTWARE_IMPLEMENTATION_MANAGER_REVIEW_DEFINITION = {
  name: "software-implementation-manager-review",
  description: "Long-running task-backed software work pipeline. A worker implements the task, then a manager reviews the result and the final step moves the originating task to review.",
  input: {
    taskId: "task-demo",
    scopeId: "scope-demo",
    workdir: "/workspace",
    assignerNpub: "npub1requester",
    reviewerNpub: "npub1requester",
    workPlan: {
      taskSummary: "Implement the requested software change.",
      instructions: "Use the task and chat context to make the requested change.",
      acceptanceCriteria: ["The requested behavior is implemented", "Focused verification has been run"],
      executionPlan: ["Inspect the repo", "Implement", "Run focused tests", "Report evidence"],
      managerChecklist: ["Diff is scoped", "Tests or verification are present", "Task status was updated"],
    },
  },
  steps: [
    {
      name: "implementation-worker",
      type: "agent",
      agent: "$.agent.defaultAgent",
      directory: "$.workPlan.workdir",
      timeoutMs: 1800000,
      input: {
        pick: {
          createdTask: "$.createdTask",
          workPlan: "$.workPlan",
        },
      },
      prompt: "You are the worker in a Wingman software implementation pipeline. Use only the selected input: createdTask and workPlan. workPlan includes the task plan, workdir, assigner/reviewer npubs, originalPrompt, originThread, referencedRecords, instructions, acceptanceCriteria, executionPlan, and managerChecklist. Make the required code changes in the working directory and run focused verification. The task is already in_progress; the final deterministic pipeline step will move it to review and publish any Flight Deck task comment or chat handoff. Do not run Flight Deck task update, task comment, chat reply, chat reply-current, docs comment, or any command that changes task state, task comments, document comments, or chat messages. Do not stop at analysis. Return JSON fields: completed boolean, summary string, changedFiles array, testsRun array, evidence array, blockers array, taskUpdateComment string, confidence number.",
      assign: "$.workerResult",
    },
    {
      name: "manager-review",
      type: "agent",
      agent: "$.agent.defaultAgent",
      directory: "$.workPlan.workdir",
      timeoutMs: 1200000,
      input: {
        pick: {
          createdTask: "$.createdTask",
          workPlan: "$.workPlan",
          workerResult: "$.workerResult",
        },
      },
      prompt: "You are the manager reviewer in a Wingman software implementation pipeline. Use only the selected input: createdTask, workPlan, and workerResult. Review workerResult against workPlan.instructions, workPlan.acceptanceCriteria, workPlan.executionPlan, workPlan.managerChecklist, originalPrompt, originThread, and referencedRecords. Inspect changed files and evidence where relevant. Be strict about missing tests, unscoped diffs, and unverifiable claims. The final pipeline step will update the Flight Deck task to review and assign it to the requester. Return JSON fields: accepted boolean, taskSummary string, reviewSummary string, executionPlan array, managerChecklist array, requiredChanges array, risks array, confidence number.",
      assign: "$.agentResponse",
    },
    {
      name: "move-task-to-review",
      description: "Move the originating Flight Deck task to Review and assign it back to the requester.",
      type: "code",
      function: "dispatch.markTaskReadyForReview",
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          createdTask: "$.createdTask",
          workPlan: "$.workPlan",
          workerResult: "$.workerResult",
          agentResponse: "$.agentResponse",
        },
      },
      assign: "$.taskReviewUpdate",
    },
  ],
};

const DO_AND_REVIEW_DEFINITION = {
  name: "do-and-review",
  description: "Long-running task-backed generic delivery pipeline. A worker completes non-code work such as research, planning, writing, or operations, then a manager reviews evidence and the final step moves the originating task to review.",
  input: {
    taskId: "task-demo",
    scopeId: "scope-demo",
    workdir: "/workspace",
    assignerNpub: "npub1requester",
    reviewerNpub: "npub1requester",
    workPlan: {
      taskSummary: "Complete the requested task.",
      instructions: "Use the task and chat context to complete the requested non-code work.",
      acceptanceCriteria: ["The requested outcome is complete", "Evidence or sources are recorded"],
      executionPlan: ["Investigate", "Do the work", "Review evidence", "Report result"],
      managerChecklist: ["Sources or evidence are recorded", "The answer matches the task", "Task status was updated"],
    },
  },
  steps: [
    {
      name: "do-work",
      type: "agent",
      agent: "$.agent.defaultAgent",
      directory: "$.workPlan.workdir",
      timeoutMs: 1800000,
      input: {
        pick: {
          createdTask: "$.createdTask",
          workPlan: "$.workPlan",
        },
      },
      prompt: "You are the worker in a Wingman do-and-review pipeline. Use only the selected input: createdTask and workPlan. workPlan includes the task plan, originalPrompt, originThread, referencedRecords, instructions, acceptanceCriteria, executionPlan, and managerChecklist. For current-world facts, use internet research and record sources. The task is already in_progress; the final deterministic pipeline step will move it to review and publish any Flight Deck task comment or chat handoff. Do not run Flight Deck task update, task comment, chat reply, chat reply-current, docs comment, or any command that changes task state, task comments, document comments, or chat messages. Return JSON fields: completed boolean, summary string, sources array, evidence array, result string, blockers array, taskUpdateComment string, confidence number.",
      assign: "$.workerResult",
    },
    {
      name: "manager-review",
      type: "agent",
      agent: "$.agent.defaultAgent",
      directory: "$.workPlan.workdir",
      timeoutMs: 1200000,
      input: {
        pick: {
          createdTask: "$.createdTask",
          workPlan: "$.workPlan",
          workerResult: "$.workerResult",
        },
      },
      prompt: "You are the manager reviewer in a Wingman do-and-review pipeline. Use only the selected input: createdTask, workPlan, and workerResult. Check workerResult against workPlan.instructions, workPlan.acceptanceCriteria, workPlan.executionPlan, workPlan.managerChecklist, originalPrompt, originThread, and referencedRecords. Verify sources/evidence are sufficient and decide whether the work is complete. The final pipeline step will update the Flight Deck task to review and assign it to the requester. Return JSON fields: accepted boolean, taskSummary string, reviewSummary string, executionPlan array, managerChecklist array, requiredChanges array, risks array, confidence number.",
      assign: "$.agentResponse",
    },
    {
      name: "move-task-to-review",
      description: "Move the originating Flight Deck task to Review and assign it back to the requester.",
      type: "code",
      function: "dispatch.markTaskReadyForReview",
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          createdTask: "$.createdTask",
          workPlan: "$.workPlan",
          workerResult: "$.workerResult",
          agentResponse: "$.agentResponse",
        },
      },
      assign: "$.taskReviewUpdate",
    },
  ],
};

const RESEARCH_AND_REPORT_DEFINITION = {
  name: "research-and-report",
  description: "Long-running task-backed research pipeline. A researcher gathers evidence, a report writer creates a Flight Deck document when possible, then a manager reviews and moves the originating task to review.",
  input: {
    taskId: "task-demo",
    scopeId: "scope-demo",
    workdir: "/workspace",
    assignerNpub: "npub1requester",
    reviewerNpub: "npub1requester",
    workPlan: {
      taskSummary: "Research the requested subject and produce a report.",
      instructions: "Research the subject from the task and chat context, then write a concise report.",
      acceptanceCriteria: ["The report answers the research question", "Sources are cited", "Open questions are clearly listed"],
      executionPlan: ["Clarify research questions from the thread", "Gather sources and evidence", "Write a report document", "Review the result"],
      managerChecklist: ["Sources are credible and cited", "The report matches the task scope", "Limitations and open questions are stated"],
    },
  },
  steps: [
    {
      name: "research-worker",
      type: "agent",
      agent: "$.agent.defaultAgent",
      directory: "$.workPlan.workdir",
      timeoutMs: 2400000,
      input: {
        pick: {
          createdTask: "$.createdTask",
          workPlan: "$.workPlan",
        },
      },
      prompt: "You are the researcher in a Wingman research-and-report pipeline. Use only the selected input: createdTask and workPlan. workPlan includes the task plan, originalPrompt, originThread, referencedRecords, instructions, acceptanceCriteria, executionPlan, and managerChecklist. For current-world facts, use internet research and cite sources. Produce structured research notes, not a polished final report. Return JSON fields: completed boolean, researchQuestion string, findings array, sources array of objects or strings, contradictions array, openQuestions array, evidence array, blockers array, confidence number.",
      assign: "$.researchResult",
    },
    {
      name: "report-writer",
      type: "agent",
      agent: "$.agent.defaultAgent",
      directory: "$.workPlan.workdir",
      timeoutMs: 1800000,
      input: {
        pick: {
          commandPrefix: "$.runtime.commandPrefix",
          createdTask: "$.createdTask",
          workPlan: "$.workPlan",
          researchResult: "$.researchResult",
        },
      },
      prompt: "You are the report writer in a Wingman research-and-report pipeline. Use only the selected input: commandPrefix, createdTask, workPlan, and researchResult. Turn researchResult into a concise Flight Deck report. If commandPrefix is available, use it only for yoke docs create/show commands needed to create or verify the report document in the selected scope. Do not run task update, task comment, chat reply, chat reply-current, docs comment, or any command that changes task state, task comments, document comments, or chat messages. The final deterministic pipeline step owns all Flight Deck task state, task comment, and chat handoff publishing. Include source links/citations and limitations. Do not hide uncertainty. Return JSON fields: completed boolean, reportTitle string, reportSummary string, reportBody string, documentId string|null, sources array, blockers array, taskUpdateComment string, confidence number.",
      assign: "$.workerResult",
    },
    {
      name: "manager-review",
      type: "agent",
      agent: "$.agent.defaultAgent",
      directory: "$.workPlan.workdir",
      timeoutMs: 1200000,
      input: {
        pick: {
          createdTask: "$.createdTask",
          workPlan: "$.workPlan",
          researchResult: "$.researchResult",
          workerResult: "$.workerResult",
        },
      },
      prompt: "You are the manager reviewer in a Wingman research-and-report pipeline. Use only the selected input: createdTask, workPlan, researchResult, and workerResult. Check the research notes and report against workPlan.instructions, workPlan.acceptanceCriteria, workPlan.managerChecklist, originalPrompt, originThread, and referencedRecords. Verify that sources, limitations, and open questions are represented. The final pipeline step will update the Flight Deck task to review and assign it to the requester. Return JSON fields: accepted boolean, taskSummary string, reviewSummary string, requiredChanges array, risks array, confidence number.",
      assign: "$.agentResponse",
    },
    {
      name: "move-task-to-review",
      description: "Move the originating Flight Deck task to Review and assign it back to the requester.",
      type: "code",
      function: "dispatch.markTaskReadyForReview",
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          createdTask: "$.createdTask",
          workPlan: "$.workPlan",
          researchResult: "$.researchResult",
          workerResult: "$.workerResult",
          agentResponse: "$.agentResponse",
        },
      },
      assign: "$.taskReviewUpdate",
    },
  ],
};

const AGENT_DISPATCH_COMMENT_DEMO_DEFINITION = {
  name: "demo-agent-dispatch-comment-response",
  description: "Demo dispatch pipeline for task/document comment advisories. It asks one agent step to draft a reply, then publishes it to the source Flight Deck comment thread.",
  input: {
    dispatch: { triggerKind: "comment" },
    workspace: { workspaceOwnerNpub: "npub1workspace", sourceAppNpub: "npub1source" },
    agent: { agentId: "primary", label: "Primary Wingman", workingDirectory: "/workspace", defaultAgent: "codex" },
    record: {
      recordId: "comment-demo",
      recordFamily: "comment",
      payload: {
        commentId: "comment-demo",
        targetRecordId: "task-demo",
        targetRecordFamilyHash: "npub1source:task",
        body: "Can you clarify whether this is blocked?",
        senderNpub: "npub1user",
      },
    },
    routing: { bindingId: "task-demo", bindingType: "task" },
  },
  steps: [
    {
      name: "draft-comment-response",
      type: "agent",
      agent: "$.agent.defaultAgent",
      directory: "$.agent.workingDirectory",
      input: {
        pick: {
          workspace: "$.workspace",
          agent: "$.agent",
          record: "$.record",
          routing: "$.routing",
        },
      },
      prompt: "You are handling a Wingman comment dispatch. Read the comment payload and draft a reply for the existing comment thread. Do not run any Flight Deck/Yoke CLI commands yourself; the next deterministic pipeline step will publish the reply. Return JSON fields: replyDraft string, targetNeedsWork boolean, blockers array, nextAction string, confidence number from 0 to 1.",
      assign: "$.agentResponse",
    },
    {
      name: "publish-comment-reply",
      type: "code",
      function: "dispatch.publishFlightDeckResponse",
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          agentResponse: "$.agentResponse",
        },
      },
    },
  ],
};

const AGENT_DISPATCH_TASK_REVIEW_DEMO_DEFINITION = {
  name: "demo-agent-dispatch-task-review-response",
  description: "Demo dispatch pipeline for task review advisories. It asks one agent step to review completion evidence, then updates the source Flight Deck task record.",
  input: {
    dispatch: { triggerKind: "task_review" },
    workspace: { workspaceOwnerNpub: "npub1workspace", sourceAppNpub: "npub1source" },
    agent: { agentId: "primary", label: "Primary Wingman", workingDirectory: "/workspace", defaultAgent: "codex" },
    record: {
      recordId: "task-review-demo",
      recordFamily: "task",
      recordState: "review",
      payload: {
        task_id: "task-review-demo",
        title: "Review completed UI fix",
        description: "Check the implementation and decide whether it is ready to accept.",
        state: "review",
        assigned_to: "npub1bot",
      },
    },
    routing: { bindingId: "task-review-demo", bindingType: "task", changedFields: ["state"] },
  },
  steps: [
    {
      name: "draft-task-review-response",
      type: "agent",
      agent: "$.agent.defaultAgent",
      directory: "$.agent.workingDirectory",
      input: {
        pick: {
          workspace: "$.workspace",
          agent: "$.agent",
          record: "$.record",
          routing: "$.routing",
        },
      },
      prompt: "You are handling a Wingman task review dispatch. Review the task payload and decide whether the work should be accepted, rejected, or sent back for changes. Do not run any Flight Deck/Yoke CLI commands yourself; the next deterministic pipeline step will update the task. Return JSON fields: decision as accept/reject/changes_requested, reviewSummary string, evidenceChecked array, requiredChanges array, replyDraft string, confidence number from 0 to 1.",
      assign: "$.agentResponse",
    },
    {
      name: "publish-task-review",
      type: "code",
      function: "dispatch.publishFlightDeckResponse",
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          agentResponse: "$.agentResponse",
        },
      },
    },
  ],
};

const LOOPED_DESIGN_REVIEW_DEMO_DEFINITION = {
  name: "demo-looped-design-review",
  description: "Runs Critic and Response agents in a loop over a design document, then a Tidy Up agent makes final judgement calls.",
  input: {
    documentUrl: "https://example.com/design-document.md",
    reviewIterations: 5,
    criticAgent: "codex",
    responseAgent: "codex",
    tidyAgent: "codex",
    workingDirectory: "/Users/mini/wingmen/wingman21",
    reviewLoop: {
      iteration: 1,
      index: 0,
      completed: 0,
      total: 5,
      done: false,
    },
  },
  steps: [
    {
      id: "critic-pass",
      name: "critic-pass",
      description: "Agent 1 Critic reviews the current design document and leaves critical inline comments.",
      type: "agent",
      agent: "$.criticAgent",
      directory: "$.workingDirectory",
      input: {
        pick: {
          documentUrl: "$.documentUrl",
          loopIndex: "$.reviewLoop.index",
          passNumber: "$.reviewLoop.iteration",
          previousConversation: "$.reviewHistory.items",
          latestResponse: "$.iteration.response",
        },
      },
      prompt: "You are Agent 1: Critic. Use documentUrl to locate and read the current design document. Edit the referenced document directly with inline comment tags using the exact format {{COMMENT_001: ...}}, {{COMMENT_002: ...}} and so on. Be critical where required to improve the design only. Consider the previous Critic/Response conversation when present. Do not include the full document text in the callback JSON. In your JSON result include inlineComments as an array of comment IDs and short excerpts, changedSections as an array of section headings or line references, summary as a detailed feedback summary for the Response agent, keyCriticisms as an array, suggestedImprovements as an array, and confidence as a number from 0 to 1.",
      assign: "$.iteration.critic",
    },
    {
      id: "response-pass",
      name: "response-pass",
      description: "Agent 2 Response reviews the design document and Critic feedback, then responds inline.",
      type: "agent",
      agent: "$.responseAgent",
      directory: "$.workingDirectory",
      input: {
        pick: {
          documentUrl: "$.documentUrl",
          loopIndex: "$.reviewLoop.index",
          passNumber: "$.reviewLoop.iteration",
          criticFeedback: "$.iteration.critic",
          previousConversation: "$.reviewHistory.items",
        },
      },
      prompt: "You are Agent 2: Response. Use documentUrl to locate and read the current design document, including Critic tags already written into it. Edit the referenced document directly with inline response tags using the exact format {{RESPONSE_001: ...}}, {{RESPONSE_002: ...}} and so on. Consider criticism carefully; do not immediately take it as valid. Push for your point if it is a better design, and concede where the criticism is valid. The goal is to improve the design only. Do not include the full document text in the callback JSON. In your JSON result include inlineResponses as an array of response IDs and short excerpts, changedSections as an array of section headings or line references, summary as a detailed response summary for the next Critic pass, acceptedCriticism as an array, rejectedCriticism as an array, proposedDesignAdjustments as an array, and confidence as a number from 0 to 1.",
      assign: "$.iteration.response",
    },
    {
      id: "loop-to-critic",
      name: "loop-to-critic",
      description: "Append this Critic/Response exchange and jump back to critic-pass until the configured pass count is complete.",
      type: "loop",
      target: "critic-pass",
      iterations: "$.reviewIterations",
      counter: "$.reviewLoop",
      history: "$.reviewHistory",
      capture: {
        critic: "$.iteration.critic",
        response: "$.iteration.response",
      },
    },
    {
      id: "tidy-up",
      name: "tidy-up",
      description: "Final agent reviews the full conversation and makes design judgement calls.",
      type: "agent",
      agent: "$.tidyAgent",
      directory: "$.workingDirectory",
      input: {
        pick: {
          documentUrl: "$.documentUrl",
          reviewHistory: "$.reviewHistory.items",
          finalCriticFeedback: "$.iteration.critic",
          finalResponseFeedback: "$.iteration.response",
        },
      },
      prompt: "You are Agent 3: Tidy Up. Use documentUrl to locate and read the current design document, including all {{COMMENT_001: }} and {{RESPONSE_001: }} tags. Review the conversation outputs from the loop between Critic and Response. Make judgement calls on each issue to improve the design, then edit the referenced document directly with the resolved design text. Do not include the full document text in the callback JSON. Return summary, acceptedChanges as an array, rejectedChanges as an array, finalInlineNotes as an array, cleanedDesignPlan as an array of concise changes made, changedSections as an array of section headings or line references, and confidence as a number from 0 to 1.",
      assign: "$.tidyUp",
    },
    {
      id: "finalise-design-review",
      name: "finalise-design-review",
      description: "Return the full repeated review conversation and final tidy-up judgement.",
      type: "code",
      function: "review.finaliseDesignReview",
      input: {
        pick: {
          documentUrl: "$.documentUrl",
          iterations: "$.reviewIterations",
          reviewHistory: "$.reviewHistory",
          critic: "$.iteration.critic",
          response: "$.iteration.response",
          tidyUp: "$.tidyUp",
        },
      },
    },
  ],
};

export function getPipelineRoot(): string {
  if (process.env.WINGMEN_PIPELINES_ROOT?.trim()) {
    return process.env.WINGMEN_PIPELINES_ROOT.trim();
  }
  return join(homedir(), ".wingmen", "pipelines");
}

export function getSharedPipelineDefinitionsDirectory(): string {
  return join(getPipelineRoot(), "shared", "definitions");
}

export function getSharedPipelineFunctionsDirectory(): string {
  return join(getPipelineRoot(), "shared", "functions");
}

export function getUserPipelineDefinitionsDirectory(ownerAlias: string): string {
  return join(getPipelineRoot(), "users", ownerAlias, "definitions");
}

export function getUserPipelineFunctionsDirectory(ownerAlias: string): string {
  return join(getPipelineRoot(), "users", ownerAlias, "functions");
}

export async function ensurePipelineDirectories(ownerAlias: string | null): Promise<void> {
  await mkdir(getSharedPipelineDefinitionsDirectory(), { recursive: true });
  await mkdir(getSharedPipelineFunctionsDirectory(), { recursive: true });
  if (ownerAlias) {
    await mkdir(getUserPipelineDefinitionsDirectory(ownerAlias), { recursive: true });
    await mkdir(getUserPipelineFunctionsDirectory(ownerAlias), { recursive: true });
  }
  await ensurePipelineGitRepository();
  const demoPath = join(getSharedPipelineDefinitionsDirectory(), "demo-declarative-pipeline.json");
  if (!existsSync(demoPath)) {
    await writeFile(demoPath, `${JSON.stringify(DEMO_DEFINITION, null, 2)}\n`);
  }
  const paragraphDemoPath = join(getSharedPipelineDefinitionsDirectory(), "demo-paragraph-two-agent-analysis.json");
  if (!existsSync(paragraphDemoPath)) {
    await writeFile(paragraphDemoPath, `${JSON.stringify(PARAGRAPH_ANALYSIS_DEMO_DEFINITION, null, 2)}\n`);
  }
  const graphContextDemoPath = join(getSharedPipelineDefinitionsDirectory(), "demo-memory-graph-context.json");
  if (!existsSync(graphContextDemoPath)) {
    await writeFile(graphContextDemoPath, `${JSON.stringify(GRAPH_CONTEXT_MEMORY_DEMO_DEFINITION, null, 2)}\n`);
  }
  const loopedReviewDemoPath = join(getSharedPipelineDefinitionsDirectory(), "demo-looped-design-review.json");
  if (!existsSync(loopedReviewDemoPath)) {
    await writeFile(loopedReviewDemoPath, `${JSON.stringify(LOOPED_DESIGN_REVIEW_DEMO_DEFINITION, null, 2)}\n`);
  }
  const dispatchDemos = [
    ["agent-dispatch-chat.json", AGENT_DISPATCH_CHAT_DEFINITION],
    ["demo-agent-dispatch-task-response.json", AGENT_DISPATCH_TASK_DEMO_DEFINITION],
    ["demo-agent-dispatch-comment-response.json", AGENT_DISPATCH_COMMENT_DEMO_DEFINITION],
    ["demo-agent-dispatch-task-review-response.json", AGENT_DISPATCH_TASK_REVIEW_DEMO_DEFINITION],
    ["software-implementation-manager-review.json", SOFTWARE_IMPLEMENTATION_MANAGER_REVIEW_DEFINITION],
    ["do-and-review.json", DO_AND_REVIEW_DEFINITION],
    ["research-and-report.json", RESEARCH_AND_REPORT_DEFINITION],
  ] as const;
  const renamedBuiltIns = [
    "demo-agent-dispatch-chat-response.json",
    "demo-software-implementation-manager-review.json",
    "demo-do-and-review.json",
  ];
  for (const fileName of renamedBuiltIns) {
    await rm(join(getSharedPipelineDefinitionsDirectory(), fileName), { force: true }).catch(() => undefined);
  }
  for (const [fileName, definition] of dispatchDemos) {
    const demoPath = join(getSharedPipelineDefinitionsDirectory(), fileName);
    const nextJson = `${JSON.stringify(definition, null, 2)}\n`;
    if (!existsSync(demoPath) || await readFile(demoPath, "utf8").catch(() => "") !== nextJson) {
      await writeFile(demoPath, nextJson);
    }
  }
}

export async function listPipelineDefinitions(ownerAlias: string | null): Promise<PipelineDefinitionRecord[]> {
  await ensurePipelineDirectories(ownerAlias);
  const records: PipelineDefinitionRecord[] = [];
  records.push(...await readDefinitionDirectory(getSharedPipelineDefinitionsDirectory(), "shared", null));
  if (ownerAlias) {
    records.push(...await readDefinitionDirectory(join(getPipelineRoot(), "users", ownerAlias, "definitions"), "user", ownerAlias));
  }
  return records.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listLatestPipelineDefinitions(ownerAlias: string | null): Promise<PipelineDefinitionRecord[]> {
  return selectLatestPipelineDefinitions(await listPipelineDefinitions(ownerAlias));
}

export function selectLatestPipelineDefinitions(records: PipelineDefinitionRecord[]): PipelineDefinitionRecord[] {
  const latestByFamily = new Map<string, PipelineDefinitionRecord>();
  for (const record of records) {
    const key = [
      record.scope,
      record.ownerAlias ?? "",
      stripVersionSuffix(record.slug),
    ].join(":");
    const existing = latestByFamily.get(key);
    if (!existing || compareDefinitionVersions(record, existing) > 0) {
      latestByFamily.set(key, record);
    }
  }
  return Array.from(latestByFamily.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function ensurePipelineGitRepository(): Promise<void> {
  const root = getPipelineRoot();
  const ignorePath = join(root, ".gitignore");
  if (!existsSync(ignorePath)) {
    await writeFile(ignorePath, [
      ".DS_Store",
      "*.tmp",
      "*.log",
      "*.sqlite",
      "*.sqlite-shm",
      "*.sqlite-wal",
      "runs/",
      "cache/",
      "node_modules/",
      "",
    ].join("\n"));
  }
  if (existsSync(join(root, ".git"))) return;
  Bun.spawnSync(["git", "-C", root, "init"], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

export async function getPipelineDefinition(id: string, ownerAlias: string | null): Promise<PipelineDefinitionRecord | null> {
  const requestedId = id.trim();
  if (!requestedId) return null;
  const definitions = await listPipelineDefinitions(ownerAlias);
  return definitions.find((definition) => definition.id === requestedId)
    ?? definitions.find((definition) => pipelineDefinitionAliases(definition).includes(requestedId))
    ?? null;
}

function pipelineDefinitionAliases(definition: PipelineDefinitionRecord): string[] {
  const fileName = basename(definition.path);
  return [
    definition.slug,
    definition.name,
    definition.path,
    fileName,
    basename(fileName, ".json"),
  ];
}

async function readDefinitionDirectory(
  directory: string,
  scope: PipelineScope,
  ownerAlias: string | null,
): Promise<PipelineDefinitionRecord[]> {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const records: PipelineDefinitionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    const raw = await readFile(path, "utf8");
    const spec = JSON.parse(raw) as DeclarativePipeline;
    const slug = basename(entry.name, ".json");
    records.push({
      id: buildDefinitionId(scope, ownerAlias, path),
      slug,
      name: spec.name || slug,
      scope,
      ownerAlias,
      path,
      spec,
    });
  }
  return records;
}

function buildDefinitionId(scope: PipelineScope, ownerAlias: string | null, path: string): string {
  const hash = createHash("sha256").update(path).digest("hex").slice(0, 12);
  return scope === "shared" ? `shared:${hash}` : `user:${ownerAlias ?? "unknown"}:${hash}`;
}

export function makePipelineSlug(input: string): string {
  const words = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  const slug = words.join("-");
  return slug || `pipeline-${new Date().toISOString().slice(0, 10)}`;
}

export async function nextVersionedDefinitionPath(directory: string, slug: string): Promise<string> {
  return nextVersionedPath(directory, slug, "json");
}

export async function nextVersionedFunctionPath(directory: string, slug: string): Promise<string> {
  return nextVersionedPath(directory, slug, "ts");
}

async function nextVersionedPath(directory: string, slug: string, extension: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const baseSlug = stripVersionSuffix(makePipelineSlug(slug));
  const entries = existsSync(directory) ? await readdir(directory, { withFileTypes: true }) : [];
  const versions = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name.match(new RegExp(`^${escapeRegExp(baseSlug)}\\.v(\\d+)\\.${escapeRegExp(extension)}$`)))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isInteger(value) && value > 0);
  const next = versions.length ? Math.max(...versions) + 1 : 1;
  return join(directory, `${baseSlug}.v${next}.${extension}`);
}

export async function nextVersionedDefinitionPathForSource(sourcePath: string): Promise<string> {
  const sourceSlug = basename(sourcePath, ".json");
  return nextVersionedDefinitionPath(dirname(sourcePath), stripVersionSuffix(sourceSlug));
}

function stripVersionSuffix(value: string): string {
  return value.replace(/\.v\d+$/i, "");
}

function compareDefinitionVersions(a: PipelineDefinitionRecord, b: PipelineDefinitionRecord): number {
  const versionDelta = definitionVersionNumber(a) - definitionVersionNumber(b);
  if (versionDelta !== 0) return versionDelta;
  return a.path.localeCompare(b.path);
}

function definitionVersionNumber(record: PipelineDefinitionRecord): number {
  const specVersion = Number(record.spec.version);
  if (Number.isFinite(specVersion)) return specVersion;
  const slugVersion = record.slug.match(/\.v(\d+)$/i);
  return slugVersion ? Number(slugVersion[1]) : 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
