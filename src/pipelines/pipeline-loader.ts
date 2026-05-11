import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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

const AGENT_DISPATCH_CHAT_DEMO_DEFINITION = {
  name: "demo-agent-dispatch-chat-response",
  description: "Demo dispatch pipeline for chat advisories. It first determines intent and needed context, then drafts the response or action result, then publishes back to the source Flight Deck thread.",
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
      name: "intent-and-information",
      type: "agent",
      agent: "$.agent.defaultAgent",
      directory: "$.agent.workingDirectory",
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          chat: "$.chat",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
        },
      },
      prompt: "You are stage 1 of a Wingman chat dispatch pipeline: Intent and Information. Read chat.messageText and the dispatch envelope. If runtime.commands.context or runtime.commands.history is available, use it to inspect the thread before deciding. Decide whether the message asks for: a direct chat reply, task creation/update in Flight Deck, local pipeline dispatch, implementation work, or no response. Do not publish a reply. Return JSON with: intent string, messageSummary string, threadSummary string, relevantFacts array, requiredActions array, recommendedPipeline string|null, shouldRespond boolean, responseDirection string, confidence number from 0 to 1.",
      assign: "$.intentAndInformation",
    },
    {
      name: "chat-response",
      type: "agent",
      agent: "$.agent.defaultAgent",
      directory: "$.agent.workingDirectory",
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          chat: "$.chat",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          intentAndInformation: "$.intentAndInformation",
        },
      },
      prompt: "You are stage 2 of a Wingman chat dispatch pipeline: Chat Response. Follow intentAndInformation.responseDirection. If requiredActions says to create/update Flight Deck records or dispatch another local pipeline and runtime commands make that possible, take the action before drafting the response; otherwise explain the intended action clearly. Do not publish the chat yourself; the next deterministic step will publish. Return JSON fields: shouldRespond boolean, responseDraft string, reasoningSummary string, actionsTaken array of short strings, followUpActions array of short strings, confidence number from 0 to 1.",
      assign: "$.agentResponse",
    },
    {
      name: "publish-chat-response",
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

const AGENT_DISPATCH_TASK_DEMO_DEFINITION = {
  name: "demo-agent-dispatch-task-response",
  description: "Demo dispatch pipeline for task advisories. It asks one agent step to acknowledge the task, then updates the source Flight Deck task record.",
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
      name: "draft-task-response",
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
      prompt: "You are handling a Wingman task dispatch. Read the task payload and produce the response the primary Wingman should use to start work. Do not run any Flight Deck/Yoke CLI commands yourself; the next deterministic pipeline step will update the task. Return JSON fields: accepted boolean, taskSummary string, executionPlan array of short steps, firstAction string, risks array, suggestedStatus string, confidence number from 0 to 1.",
      assign: "$.agentResponse",
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
          agentResponse: "$.agentResponse",
        },
      },
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
    ["demo-agent-dispatch-chat-response.json", AGENT_DISPATCH_CHAT_DEMO_DEFINITION],
    ["demo-agent-dispatch-task-response.json", AGENT_DISPATCH_TASK_DEMO_DEFINITION],
    ["demo-agent-dispatch-comment-response.json", AGENT_DISPATCH_COMMENT_DEMO_DEFINITION],
    ["demo-agent-dispatch-task-review-response.json", AGENT_DISPATCH_TASK_REVIEW_DEMO_DEFINITION],
  ] as const;
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
