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

const AGENT_DISPATCH_CHAT_DEFINITION = {
  name: "agent-dispatch-chat",
  description: "Default dispatch pipeline for chat advisories. It hydrates the source thread, classifies whether task-backed work is needed, optionally creates an in-progress task and starts the selected pipeline, then replies to the source Flight Deck thread.",
  default: true,
  tags: ["default", "dispatch", "chat", "flight-deck"],
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
      prompt: "You are stage 1 of agent-dispatch-chat: Analyse Intent. The selected input contains chatDispatchInput, a compact decision packet. Use chatDispatchInput.latestThread as the authoritative latest conversation, referencedRecords as supporting Flight Deck context, scopes for optional scope selection, defaults for workdir/assigner/reviewer defaults, and validChildPipelines as the only allowed child pipeline choices. Do not invent pipeline names and do not choose any dispatch/intake pipeline. One valid intent is ignore: if selfCheck says this is self-authored, set intent ignore, dispatchTask false, and chatResponse.body to an empty string. Decide whether this chat needs extended task-backed work. If it can be answered directly or needs clarification before work starts, set dispatchTask false. Discussion, planning, design thinking, term clarification, document-centred planning, and document comment discussion must be no-task discussion work: set dispatchTask false and choose document-discussion when the thread is about a plan, design, document, spec, proposal, or document comments; choose discussion-chat-response for non-document discussion. If it is generic, miscellaneous, image-based, operational, writing, planning, or otherwise not clearly code/research-report/design discussion work, choose do-and-review. Choose software-implementation-review-loop only for code, repository, build, test, deployment, or implementation work. Choose research-and-report when the requested output is explicitly research with a report or document. If it needs research, implementation, document generation, graph-memory review, or an explicitly requested task-backed pipeline, set dispatchTask true only when you can select the pipeline, workdir, task title, instructions, and acceptance criteria. Never set dispatchTask true for document-discussion or discussion-chat-response. When dispatching a task, write taskDraft.instructions with the concrete request details already visible in latestThread and referencedRecords; do not merely tell the downstream worker to inspect the thread. Choose scopeId from scopes when one fits; if scopes is empty or no scope fits, set scopeId null and continue. Return JSON only with: intent string, dispatchTask boolean, recommendedPipelineId string|null, scopeId string|null, workdir string|null, taskDraft object with title string, instructions string, acceptanceCriteria array, executionPlan array, managerChecklist array, assignerNpub string|null, reviewerNpub string|null, chatResponse object with body string, clarifyingQuestion string|null, confidence number from 0 to 1. There is always a chat response; for ignore use intent ignore, an empty body, and confidence 1. Do not include responseOnly.",
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
      name: "detect-review-approval",
      type: "code",
      function: "dispatch.detectChatReviewApproval",
      when: { path: "$.chatContext.shouldProceed", equals: true },
      input: {
        pick: {
          chat: "$.chat",
          record: "$.record",
          chatContext: "$.chatContext",
        },
      },
      assign: "$.reviewApproval",
    },
    {
      name: "complete-review-task-from-chat",
      type: "code",
      function: "dispatch.completeReviewTaskFromChat",
      when: { path: "$.reviewApproval.shouldComplete", equals: true },
      input: {
        pick: {
          reviewApproval: "$.reviewApproval",
        },
      },
      assign: "$.reviewCompletion",
    },
    {
      name: "route-discussion-chat",
      type: "code",
      function: "dispatch.routeDiscussionChat",
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
          chatDispatchInput: "$.chatDispatchInput",
          agentDecision: "$.agentDecision",
          decision: "$.decision",
        },
      },
      assign: "$.decision",
    },
    {
      name: "start-discussion-pipeline",
      type: "code",
      function: "dispatch.startChildPipeline",
      when: { path: "$.decision.dispatchDiscussion", equals: true },
      input: {
        pick: {
          pipelineDefinitionId: "$.decision.discussionPipelineDefinitionId",
          workPlan: "$.decision.discussionWorkPlan",
          childInput: "$",
        },
      },
      assign: "$.childPipeline",
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
      name: "reload-chat-thread-before-reply",
      type: "code",
      function: "dispatch.reloadChatThread",
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
      assign: "$.closeoutContext",
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
          reviewApproval: "$.reviewApproval",
          reviewCompletion: "$.reviewCompletion",
          closeoutContext: "$.closeoutContext",
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

const AGENT_DISPATCH_TASK_DEFINITION = {
  name: "agent-dispatch-task-response",
  description: "Task intake dispatch pipeline. It investigates the task, chooses a longer-running software implementation or generic do-and-review child pipeline, starts it, then comments back with the launched work plan.",
  default: true,
  tags: ["default", "dispatch", "task", "intake", "flight-deck"],
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

const FINAL_THREAD_RESPONSE_PROMPT = `You are the final response agent for a Wingman pipeline.

Your job is to write the message that will be posted back into the originating Flight Deck thread. Review the original thread, any refreshed thread context, the task/work plan, new worker output, manager review, and any artifacts created by the pipeline.

Rules:
- Be conversational. Write as a direct reply in the thread, not as pipeline telemetry.
- Be complete. Answer the user's actual question/request using the work that was just completed.
- If there is a Flight Deck document, WApp, file, or other user-accessible artifact, include the mention/link. Do not make Pete hunt through internal task records.
- Do not make an internal task the main artifact unless it is the only durable place the result exists.
- Do not say only that work is "ready for review"; summarise or present the useful output.
- Do not prefix the body with labels like "Summary:", "Task:", "Assigned back to:", or "Pipeline handoff:".
- If the work is incomplete or assumptions matter, say that plainly.
- If a follow-up question would materially improve the outcome, ask one focused question. If there is an obvious next step, suggest it.

Return JSON only:
{
  "body": "the exact chat reply to post",
  "summary": "short internal summary",
  "artifacts": [{"type":"document|wapp|file|task|other", "label":"", "mentionOrUrl":""}],
  "followUpQuestion": "question or null",
  "confidence": 0.0
}`;

const DO_AND_REVIEW_DEFINITION = {
  name: "do-and-review",
  description: "Long-running task-backed generic delivery pipeline. A worker completes non-code work such as research, planning, writing, or operations, then a manager reviews evidence and the final step moves the originating task to review.",
  default: true,
  tags: ["default", "generic", "delivery", "review", "task-backed"],
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
      prompt: "You are the worker in a Wingman do-and-review pipeline. Use only the selected input: createdTask and workPlan. workPlan includes the task plan, originalPrompt, originThread, referencedRecords, instructions, acceptanceCriteria, executionPlan, and managerChecklist. For current-world facts, use internet research and record sources. The task is already in_progress; the final deterministic pipeline step will move it to review and publish any Flight Deck task comment or chat handoff. Always make the best effort possible from the available context. If required information is missing, do not return callback status needs_input; return callback status ok with completed false, state what you could and could not complete, list blockers, and write a concrete taskUpdateComment that asks for the missing information or states the limitation for the final chat/task feedback. Do not fabricate requirements. Do not run Flight Deck task update, task comment, chat reply, chat reply-current, or any command that changes task state, task comments, or chat messages. Document comment replies are allowed only when workPlan explicitly asks to answer or respond to existing document comments; in that case use the document comment thread surface, such as `bun mycode/yoke.js docs reply <comment-id> --body \"...\"`, and include evidence that child comments were created with parent_comment_id set to the original comment ids. Updating the document body does not satisfy an 'answer comments' request unless workPlan explicitly asks for a document-body response section. Return JSON fields: completed boolean, summary string, sources array, evidence array, result string, blockers array, taskUpdateComment string, confidence number.",
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
      prompt: "You are the manager reviewer in a Wingman do-and-review pipeline. Use only the selected input: createdTask, workPlan, and workerResult. Check workerResult against workPlan.instructions, workPlan.acceptanceCriteria, workPlan.executionPlan, workPlan.managerChecklist, originalPrompt, originThread, and referencedRecords. Verify sources/evidence are sufficient and decide whether the work is complete. If workPlan asks to answer or respond to Flight Deck document comments, require evidence that actual comment-thread replies were created with parent_comment_id pointing at the original comment ids; a document-body section alone is not sufficient unless workPlan explicitly requested that instead. If workerResult.completed is false because information is missing, review the best-effort result as a handoffable partial outcome: set accepted according to whether the worker honestly used available context, put missing information or limitations in requiredChanges/risks, and rely on workerResult.taskUpdateComment for the final chat/task feedback. The final pipeline step will update the Flight Deck task to review and assign it to the requester. Return JSON fields: accepted boolean, taskSummary string, reviewSummary string, executionPlan array, managerChecklist array, requiredChanges array, risks array, confidence number.",
      assign: "$.agentResponse",
    },
    {
      name: "reload-final-thread",
      description: "Refresh the originating thread before composing the final user-facing response.",
      type: "code",
      function: "dispatch.reloadChatThread",
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
      assign: "$.finalThreadContext",
    },
    {
      name: "final-thread-response",
      description: "Compose the final conversational answer for the source thread.",
      type: "agent",
      agent: "$.agent.defaultAgent",
      directory: "$.workPlan.workdir",
      timeoutMs: 600000,
      input: {
        pick: {
          createdTask: "$.createdTask",
          workPlan: "$.workPlan",
          finalThreadContext: "$.finalThreadContext",
          workerResult: "$.workerResult",
          agentResponse: "$.agentResponse",
        },
      },
      prompt: FINAL_THREAD_RESPONSE_PROMPT,
      assign: "$.finalThreadResponse",
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
          finalThreadContext: "$.finalThreadContext",
          finalThreadResponse: "$.finalThreadResponse",
        },
      },
      assign: "$.taskReviewUpdate",
    },
  ],
};

const RESEARCH_AND_REPORT_DEFINITION = {
  name: "research-and-report",
  description: "Long-running task-backed research pipeline. A researcher gathers evidence, a report writer creates a Flight Deck document when possible, then a manager reviews and moves the originating task to review.",
  default: true,
  tags: ["default", "research", "report", "review", "task-backed"],
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
      name: "reload-final-thread",
      description: "Refresh the originating thread before composing the final user-facing response.",
      type: "code",
      function: "dispatch.reloadChatThread",
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
      assign: "$.finalThreadContext",
    },
    {
      name: "final-thread-response",
      description: "Compose the final conversational answer for the source thread.",
      type: "agent",
      agent: "$.agent.defaultAgent",
      directory: "$.workPlan.workdir",
      timeoutMs: 600000,
      input: {
        pick: {
          createdTask: "$.createdTask",
          workPlan: "$.workPlan",
          finalThreadContext: "$.finalThreadContext",
          researchResult: "$.researchResult",
          workerResult: "$.workerResult",
          agentResponse: "$.agentResponse",
        },
      },
      prompt: FINAL_THREAD_RESPONSE_PROMPT,
      assign: "$.finalThreadResponse",
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
          finalThreadContext: "$.finalThreadContext",
          finalThreadResponse: "$.finalThreadResponse",
        },
      },
      assign: "$.taskReviewUpdate",
    },
  ],
};

const AGENT_DISPATCH_COMMENT_DEFINITION = {
  name: "agent-dispatch-comment-response",
  description: "Default dispatch pipeline for task/document comment advisories. It asks one agent step to draft a reply, then publishes it to the source Flight Deck comment thread.",
  default: true,
  tags: ["default", "dispatch", "comment", "flight-deck"],
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

const DESIGN_REVIEW_DEFINITION = {
  name: "design-review",
  description: "Runs Critic and Response agents in a loop over a design document, then a Tidy Up agent makes final judgement calls.",
  default: true,
  tags: ["default", "design", "review", "loop"],
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
  const documentDiscussionDefinition = await readBundledDefaultDefinition("document-discussion.json");
  const softwareImplementationReviewLoopDefinition = await readBundledDefaultDefinition("software-implementation-review-loop.json");
  const defaultDefinitions = [
    ["agent-dispatch-chat.json", AGENT_DISPATCH_CHAT_DEFINITION],
    ["agent-dispatch-task-response.json", AGENT_DISPATCH_TASK_DEFINITION],
    ["agent-dispatch-comment-response.json", AGENT_DISPATCH_COMMENT_DEFINITION],
    ["design-review.json", DESIGN_REVIEW_DEFINITION],
    ["document-discussion.json", documentDiscussionDefinition],
    ["do-and-review.json", DO_AND_REVIEW_DEFINITION],
    ["research-and-report.json", RESEARCH_AND_REPORT_DEFINITION],
    ["software-implementation-review-loop.json", softwareImplementationReviewLoopDefinition],
  ] as const;
  const renamedBuiltIns = [
    "demo-agent-dispatch-chat-response.json",
    "demo-agent-dispatch-comment-response.json",
    "demo-agent-dispatch-task-response.json",
    "demo-agent-dispatch-task-review-response.json",
    "demo-declarative-pipeline.json",
    "demo-looped-design-review.json",
    "demo-memory-graph-context.json",
    "demo-paragraph-two-agent-analysis.json",
    "demo-software-implementation-manager-review.json",
    "demo-do-and-review.json",
    "implementation-review-loop.v1.json",
    "implementation-review-loop.v2.json",
    "software-implementation-manager-review.json",
  ];
  for (const fileName of renamedBuiltIns) {
    await rm(join(getSharedPipelineDefinitionsDirectory(), fileName), { force: true }).catch(() => undefined);
  }
  for (const [fileName, definition] of defaultDefinitions) {
    const demoPath = join(getSharedPipelineDefinitionsDirectory(), fileName);
    const nextJson = `${JSON.stringify(definition, null, 2)}\n`;
    if (!existsSync(demoPath) || await readFile(demoPath, "utf8").catch(() => "") !== nextJson) {
      await writeFile(demoPath, nextJson);
    }
  }
}

async function readBundledDefaultDefinition(fileName: string): Promise<DeclarativePipeline> {
  const url = new URL(`./default-definitions/${fileName}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as DeclarativePipeline;
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
    typeof definition.spec.supersedes === "string" ? definition.spec.supersedes : "",
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
    let spec: DeclarativePipeline;
    try {
      spec = JSON.parse(raw) as DeclarativePipeline;
    } catch (error) {
      console.warn("[pipelines] skipping invalid pipeline definition", path, error instanceof Error ? error.message : String(error));
      continue;
    }
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
