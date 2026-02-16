/**
 * Night Watch Engine
 *
 * Core logic for the Night Watchman autonomous review system.
 * When a session goes stable with an empty prompt queue, NW calls an
 * OpenRouter-compatible model to decide: continue, request more history,
 * or stop and produce a report card.
 */

import { join } from "node:path";
import type { SessionSnapshot } from "../agents/process-manager";
import type { NightWatchStore, NightWatchReport } from "./nightwatch-store";
import type { FeatureFlagRecord } from "../storage/feature-flag-store";
import type { PromptQueueStore } from "../storage/prompt-queue-store";
import { getNtfyConfig, sendNtfyNotification } from "./ntfy-notify";

// ============================================================
// Constants & Configuration
// ============================================================

export const NIGHTWATCH_FEATURE_FLAG_KEY = "nightwatch_enabled";

export const NIGHTWATCH_DEFAULT_MODEL = "google/gemini-3-flash-preview";

export const NIGHTWATCH_MODELS = [
  "z-ai/glm-4.6v",
  "moonshotai/kimi-k2.5",
  "z-ai/glm-4.7-flash",
  "google/gemini-3-flash-preview",
  "x-ai/grok-4.1-fast",
  "anthropic/claude-sonnet-4.5",
] as const;

export const NIGHTWATCH_MAX_CYCLE_OPTIONS = [6, 21, 256] as const;

// ============================================================
// Types
// ============================================================

interface StoredMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
}

interface MessageStore {
  listSessionMessages(sessionId: string): StoredMessage[];
}

interface FeatureFlagStore {
  getFlag(key: string): FeatureFlagRecord | null;
}

export interface NightWatchDeps {
  store: NightWatchStore;
  featureFlagStore: FeatureFlagStore;
  messageStore: MessageStore;
  promptQueueStore: PromptQueueStore;
  openRouterApiKey: string | null;
  openRouterBaseUrl: string;
  /** Public base URL for this Wingman instance (used in notification links) */
  wingmanBaseUrl: string;
  getSession: (sessionId: string) => SessionSnapshot | null;
  /** Trigger prompt queue dispatch for a session (immediate, not waiting for sweep) */
  dispatchPrompt: (session: SessionSnapshot) => void;
  /** Send raw terminal input directly to the agent (bypasses prompt queue) */
  sendRawInput: (session: SessionSnapshot, content: string) => Promise<boolean>;
  /** Called when a session reaches a terminal state (complete/error/humanInput) */
  onSessionComplete?: (sessionId: string, report: NightWatchReport) => void;
}

type NightWatchAction = "continue" | "morehistory" | "complete" | "error" | "humanInput";

type NightWatchInputMode = "queue" | "raw";

const VALID_RAW_INPUTS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "y", "n"] as const;
type NightWatchRawInput = (typeof VALID_RAW_INPUTS)[number];

interface NightWatchResponse {
  nextAction: NightWatchAction;
  content: string;
  reasoning: string;
  inputMode: NightWatchInputMode;
  inputRaw: NightWatchRawInput | null;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ============================================================
// In-flight Guard
// ============================================================

const nightwatchInFlight = new Set<string>();

// ============================================================
// System Prompt
// ============================================================

export const NIGHTWATCH_DEFAULT_PROMPT = `You are Night Watchman, an autonomous supervisor for AI coding agent sessions.
Your job is to keep the agent productive and moving forward. You act on behalf of the human boss who is away.

You MUST respond with valid JSON only. No markdown, no explanation outside the JSON.

Response format:
{
  "nextAction": "<action>",
  "inputMode": "<queue or raw>",
  "inputRaw": "<1-9, y, or n — ONLY used when inputMode is raw>",
  "reasoning": "<brief explanation of why you chose this action>",
  "content": "<your message>"
}

Available actions:
- "continue": The agent should keep working. Provide a clear prompt in "content" telling it what to do next.
- "complete": The task is finished. Summarise what was accomplished in "content".
- "error": The agent is stuck in an error loop. Describe the problem in "content".
- "humanInput": You genuinely cannot proceed without specific human knowledge. Explain what is needed in "content".

Input modes (only applies when nextAction is "continue"):
- "queue" (default): Send content as a normal prompt via the message queue. Use this for regular continuation prompts.
- "raw": The agent is showing an INTERACTIVE PROMPT that requires direct terminal input. When using raw mode, you MUST set "inputRaw" to one of these exact values: "1", "2", "3", "4", "5", "6", "7", "8", "9", "y", or "n". The inputRaw value is sent directly to the terminal as a keystroke. The "content" field is still used for your reasoning/report but is NOT sent to the terminal. Use raw mode for:
  - A numbered menu (set inputRaw to the number, e.g. "1")
  - A yes/no confirmation prompt (set inputRaw to "y" or "n")
  - A permission dialog asking to allow/deny (set inputRaw to "y")
  - Any TUI (text user interface) selection that won't accept a normal message

CRITICAL RULES — read carefully:

1. YOUR DEFAULT ACTION IS "continue". Keep the agent working unless there is a clear reason to stop.

2. MAKE DECISIONS. When the agent asks questions, presents options, or wants confirmation:
   - Pick the most pragmatic, standard option and tell it to proceed.
   - If there are numbered options, choose the one that best fits the project context and conventions.
   - If the agent asks "should I proceed?", the answer is YES.
   - If the agent presents a plan and asks for approval, approve it.
   - Being wrong is fine. The human can fix it later. Blocked progress is worse than an imperfect choice.

3. ANSWER QUESTIONS. If the agent needs information to continue:
   - Use the project context provided to answer questions about conventions, tech stack, and preferences.
   - Make reasonable assumptions for anything not covered by the project context.
   - If the agent asks about implementation approach, pick the simplest one that works.

4. USE "humanInput" ONLY for things you truly cannot decide:
   - Credentials, API keys, passwords, or secrets the agent needs.
   - Business decisions that require domain knowledge you don't have (which client, what price, etc.).
   - Access permissions or deployments to production systems.
   - DO NOT use humanInput for technical choices, design decisions, or "which approach" questions — just pick one.

5. USE "error" only when the agent is clearly stuck in a loop (repeating the same failed action 3+ times).

6. USE "complete" when the agent has explicitly finished its task and summarised the results.

7. For "continue" prompts, be concise and direct. Examples:
   - "Go with option 1. Proceed with the implementation."
   - "Yes, that plan looks good. Continue."
   - "Use the existing pattern from the codebase. Proceed."
   - If the agent just needs a nudge, even just "Continue." or "Proceed with the next step." works.`;

// ============================================================
// Project Context
// ============================================================

async function loadProjectContext(workingDirectory: string): Promise<string | null> {
  const candidates = ["CLAUDE.md", "claude.md", "README.md"];
  for (const filename of candidates) {
    try {
      const filePath = join(workingDirectory, filename);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        const text = await file.text();
        // Cap at ~4000 chars to avoid blowing up the prompt
        const trimmed = text.length > 4000 ? text.slice(0, 4000) + "\n\n[...truncated]" : text;
        return `Project context from ${filename}:\n${trimmed}`;
      }
    } catch {
      // File not readable, skip
    }
  }
  return null;
}

async function loadAgentContext(workingDirectory: string): Promise<string | null> {
  const candidates = ["agents.md", "AGENTS.md", "CLAUDE.md", "claude.md"];
  for (const filename of candidates) {
    try {
      const filePath = join(workingDirectory, filename);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        const text = await file.text();
        const trimmed = text.length > 6000 ? text.slice(0, 6000) + "\n\n[...truncated]" : text;
        return `Decisions should bear in mind the project context, which can be read in the agents.md below\n\n========= AGENTS.md =========\n\n${trimmed}`;
      }
    } catch {
      // File not readable, skip
    }
  }
  return null;
}

// ============================================================
// Core Functions
// ============================================================

function buildNightWatchPrompt(
  systemPrompt: string,
  firstMessages: StoredMessage[],
  allMessages: StoredMessage[],
  projectContext: string | null,
  agentContext: string | null,
): ChatMessage[] {
  const goalSection = firstMessages.length > 0
    ? firstMessages.map((m) => `[${m.role}]: ${m.content}`).join("\n")
    : "(no initial messages available)";

  const historySection = allMessages.length > 0
    ? allMessages.map((m) => `[${m.role}]: ${m.content}`).join("\n")
    : "(no messages available)";

  let userMessage = "";
  if (projectContext) {
    userMessage += `${projectContext}\n\n---\n\n`;
  }
  userMessage += `What are we trying to achieve:\n${goalSection}\n\nFull Conversation History:\n${historySection}`;
  if (agentContext) {
    userMessage += `\n\n---\n\n${agentContext}`;
  }

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
}

async function callOpenRouter(
  messages: ChatMessage[],
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<string> {
  const url = `${baseUrl}/v1/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`OpenRouter error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("No content in OpenRouter response");
  }
  return content;
}

function parseNightWatchResponse(raw: string): NightWatchResponse {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    cleaned = cleaned.slice(firstNewline + 1);
    const lastFence = cleaned.lastIndexOf("```");
    if (lastFence >= 0) {
      cleaned = cleaned.slice(0, lastFence);
    }
    cleaned = cleaned.trim();
  }

  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  const validActions: NightWatchAction[] = [
    "continue",
    "morehistory",
    "complete",
    "error",
    "humanInput",
  ];
  const action = String(parsed.nextAction ?? "complete");
  const nextAction = validActions.includes(action as NightWatchAction)
    ? (action as NightWatchAction)
    : "complete";

  const content = String(parsed.content ?? "No details provided.");
  const reasoning = String(parsed.reasoning ?? "");
  const rawInputMode = String(parsed.inputMode ?? "queue").toLowerCase();

  // Validate inputRaw against the allowed enum
  const rawInputValue = parsed.inputRaw != null ? String(parsed.inputRaw).trim() : null;
  const inputRaw: NightWatchRawInput | null =
    rawInputValue && (VALID_RAW_INPUTS as readonly string[]).includes(rawInputValue)
      ? (rawInputValue as NightWatchRawInput)
      : null;

  // Only allow raw mode if inputRaw is valid — fall back to queue otherwise
  const inputMode: NightWatchInputMode = rawInputMode === "raw" && inputRaw ? "raw" : "queue";

  return { nextAction, content, reasoning, inputMode, inputRaw };
}

async function executeNightWatchReview(
  sessionId: string,
  deps: NightWatchDeps,
): Promise<void> {
  const sessionState = deps.store.getSessionState(sessionId);
  if (!sessionState || !sessionState.enabled) return;

  const apiKey = deps.openRouterApiKey;
  if (!apiKey) {
    console.warn("[nightwatch] No OPENROUTER_API key configured, skipping review");
    return;
  }

  const allMessages = deps.messageStore.listSessionMessages(sessionId);
  if (allMessages.length === 0) {
    console.log(`[nightwatch] No messages for session ${sessionId}, skipping`);
    return;
  }

  // Load project context from the session's working directory
  const session = deps.getSession(sessionId);
  let projectContext: string | null = null;
  let agentContext: string | null = null;
  if (session?.workingDirectory) {
    projectContext = await loadProjectContext(session.workingDirectory);
    agentContext = await loadAgentContext(session.workingDirectory);
  }

  const firstMessages = allMessages.slice(0, 3);
  const model = sessionState.model || NIGHTWATCH_DEFAULT_MODEL;
  const customPrompt = deps.store.getConfig("custom_prompt");
  const systemPrompt = customPrompt || NIGHTWATCH_DEFAULT_PROMPT;

  console.log(
    `[nightwatch] Reviewing session ${sessionId} (cycle ${sessionState.cycleCount}/${sessionState.maxCycles}, model: ${model}, messages: ${allMessages.length}${projectContext ? ", with project context" : ""}${agentContext ? ", with agent context" : ""}${customPrompt ? ", custom prompt" : ""})`,
  );

  const prompt = buildNightWatchPrompt(systemPrompt, firstMessages, allMessages, projectContext, agentContext);
  let rawResponse: string;

  try {
    rawResponse = await callOpenRouter(prompt, model, apiKey, deps.openRouterBaseUrl);
  } catch (err) {
    console.error(`[nightwatch] API call failed for session ${sessionId}:`, err);
    return;
  }

  let result: NightWatchResponse;
  try {
    result = parseNightWatchResponse(rawResponse);
  } catch (err) {
    console.error(`[nightwatch] Failed to parse response for session ${sessionId}:`, err);
    console.error(`[nightwatch] Raw response: ${rawResponse.slice(0, 500)}`);
    return;
  }

  console.log(`[nightwatch] Session ${sessionId} -> action: ${result.nextAction}`);

  // "morehistory" is no longer needed since we send full history,
  // but handle it gracefully by treating as "continue" with a nudge
  if (result.nextAction === "morehistory") {
    console.log(`[nightwatch] Got morehistory but full history was already sent, treating as continue`);
    result = { nextAction: "continue", content: "Continue with the current task.", reasoning: "Full history already provided, continuing.", inputMode: "queue", inputRaw: null };
  }

  // Create a report card for every cycle (including continue)
  const currentSession = deps.getSession(sessionId);
  const sessionName = currentSession?.name ?? null;
  const currentState = deps.store.getSessionState(sessionId);
  const cycleCount = currentState?.cycleCount ?? 0;

  deps.store.addReport({
    sessionId,
    sessionName,
    workingDirectory: currentSession?.workingDirectory ?? null,
    status: result.nextAction as NightWatchReport["status"],
    summary: result.content,
    reasoning: result.reasoning || null,
    inputMode: result.nextAction === "continue" ? result.inputMode : null,
    inputRaw: result.nextAction === "continue" ? result.inputRaw : null,
    cycleCount,
  });

  // Act on the result
  if (result.nextAction === "continue") {
    deps.store.incrementCycle(sessionId);

    if (result.inputMode === "raw" && result.inputRaw && currentSession) {
      // Raw mode: send the validated inputRaw keystroke directly to terminal
      try {
        const sent = await deps.sendRawInput(currentSession, result.inputRaw);
        if (sent) {
          console.log(`[nightwatch] Sent raw input to session ${sessionId}: "${result.inputRaw}" (reason: ${result.content.slice(0, 80)})`);
        } else {
          console.warn(`[nightwatch] Failed to send raw input to session ${sessionId}`);
        }
      } catch (err) {
        console.error(`[nightwatch] Raw input failed for session ${sessionId}:`, err);
      }
    } else {
      // Queue mode: standard prompt queue dispatch
      try {
        deps.promptQueueStore.addPrompt(sessionId, { content: result.content });
        console.log(`[nightwatch] Queued continuation prompt for session ${sessionId}: ${result.content.slice(0, 120)}`);
        if (currentSession) {
          deps.dispatchPrompt(currentSession);
        }
      } catch (err) {
        console.error(`[nightwatch] Failed to queue prompt for session ${sessionId}:`, err);
      }
    }
    return;
  }

  // Terminal actions: complete, error, humanInput — disable the session
  deps.store.disableSession(sessionId);
  console.log(
    `[nightwatch] Session ${sessionId} terminated with ${result.nextAction}: ${result.content.slice(0, 100)}`,
  );

  const terminalReport: NightWatchReport = {
    id: "",
    sessionId,
    sessionName,
    workingDirectory: currentSession?.workingDirectory ?? null,
    status: result.nextAction as NightWatchReport["status"],
    summary: result.content,
    reasoning: result.reasoning || null,
    inputMode: result.nextAction === "continue" ? result.inputMode : null,
    cycleCount,
    createdAt: new Date().toISOString(),
  };

  if (deps.onSessionComplete) {
    deps.onSessionComplete(sessionId, terminalReport);
  }

  // Send push notification via ntfy
  const ntfyConfig = getNtfyConfig(deps.wingmanBaseUrl);
  if (ntfyConfig) {
    sendNtfyNotification(terminalReport, ntfyConfig).catch((err) => {
      console.error("[nightwatch] ntfy notification failed:", err);
    });
  }
}

// ============================================================
// Main Entry Point
// ============================================================

export async function maybeTriggerNightWatch(
  session: SessionSnapshot | null,
  deps: NightWatchDeps,
): Promise<void> {
  if (!session) return;

  // Check feature flag
  const flag = deps.featureFlagStore.getFlag(NIGHTWATCH_FEATURE_FLAG_KEY);
  if (!flag || flag.state === "off") {
    console.log(`[nightwatch] Skipping session ${session.id}: feature flag is ${flag?.state ?? "missing"}`);
    return;
  }

  // Check session is enabled
  if (!deps.store.isEnabled(session.id)) {
    // This is high-frequency so only log at debug level (most sessions won't have NW)
    return;
  }

  // Grace period: let the agent fully start before issuing the first review.
  // Without this, NW tries to review an empty/starting session and hangs.
  const STARTUP_GRACE_MS = 21_000;
  const sessionAge = Date.now() - new Date(session.startedAt).getTime();
  if (sessionAge < STARTUP_GRACE_MS) {
    return;
  }

  // Prevent overlapping calls
  if (nightwatchInFlight.has(session.id)) {
    console.log(`[nightwatch] Skipping session ${session.id}: review already in flight`);
    return;
  }

  // Check cycle limit
  const sessionState = deps.store.getSessionState(session.id);
  if (sessionState && sessionState.cycleCount >= sessionState.maxCycles) {
    console.log(
      `[nightwatch] Session ${session.id} reached max cycles (${sessionState.maxCycles}), auto-stopping`,
    );
    deps.store.addReport({
      sessionId: session.id,
      sessionName: session.name ?? null,
      workingDirectory: session.workingDirectory ?? null,
      status: "complete",
      summary: `Reached maximum cycle limit (${sessionState.maxCycles}).`,
      reasoning: "Automatic stop: cycle limit reached.",
      cycleCount: sessionState.cycleCount,
    });
    deps.store.disableSession(session.id);

    const maxCycleReport: NightWatchReport = {
      id: "",
      sessionId: session.id,
      sessionName: session.name ?? null,
      workingDirectory: session.workingDirectory ?? null,
      status: "complete",
      summary: `Reached maximum cycle limit (${sessionState.maxCycles}).`,
      reasoning: "Automatic stop: cycle limit reached.",
      inputMode: null,
      cycleCount: sessionState.cycleCount,
      createdAt: new Date().toISOString(),
    };

    if (deps.onSessionComplete) {
      deps.onSessionComplete(session.id, maxCycleReport);
    }

    // Send push notification via ntfy
    const ntfyConfig = getNtfyConfig(deps.wingmanBaseUrl);
    if (ntfyConfig) {
      sendNtfyNotification(maxCycleReport, ntfyConfig).catch((err) => {
        console.error("[nightwatch] ntfy notification failed:", err);
      });
    }
    return;
  }

  console.log(`[nightwatch] Triggering review for session ${session.id} (${session.name ?? "unnamed"})`);
  nightwatchInFlight.add(session.id);
  try {
    await executeNightWatchReview(session.id, deps);
  } catch (err) {
    console.error(`[nightwatch] Unexpected error for session ${session.id}:`, err);
  } finally {
    nightwatchInFlight.delete(session.id);
  }
}
