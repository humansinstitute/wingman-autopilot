/**
 * Night Watch Engine
 *
 * Core logic for the Night Watchman autonomous review system.
 * When a session goes stable with an empty prompt queue, NW calls an
 * OpenRouter-compatible model to decide: continue, request more history,
 * or stop and produce a report card.
 */

import type { SessionSnapshot } from "../agents/process-manager";
import type { NightWatchStore, NightWatchReport } from "./nightwatch-store";
import type { FeatureFlagRecord } from "../storage/feature-flag-store";
import type { PromptQueueStore } from "../storage/prompt-queue-store";

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
  listMessages(sessionId: string): StoredMessage[];
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
  getSession: (sessionId: string) => SessionSnapshot | null;
}

type NightWatchAction = "continue" | "morehistory" | "complete" | "error" | "humanInput";

interface NightWatchResponse {
  nextAction: NightWatchAction;
  content: string;
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

const SYSTEM_PROMPT = `You are Night Watchman, an autonomous review system for AI agent sessions.
Your job is to review the conversation history of an AI agent session and decide what to do next.

You MUST respond with valid JSON only. No markdown, no explanation outside the JSON.

Response format:
{
  "nextAction": "<action>",
  "content": "<your message>"
}

Available actions:
- "continue": The agent should continue working. Provide a clear, specific prompt in "content" that tells the agent what to do next.
- "morehistory": You need more context to decide. Set content to explain what you need.
- "complete": The task appears finished. Provide a brief summary of what was accomplished in "content".
- "error": The agent seems stuck in an error loop or broken state. Describe the problem in "content".
- "humanInput": The agent needs human guidance that you cannot provide. Explain what decision is needed in "content".

Guidelines:
- If the last messages show the agent completed its task successfully, use "complete".
- If the last messages show repeated errors or the agent is going in circles, use "error".
- If the agent is waiting for user input or a decision only a human can make, use "humanInput".
- If the agent is mid-task and just paused, use "continue" with a prompt to keep going.
- Only use "morehistory" if the recent messages alone are truly insufficient to judge.
- Be concise. Your "content" should be actionable and specific.`;

// ============================================================
// Core Functions
// ============================================================

function buildNightWatchPrompt(
  firstMessages: StoredMessage[],
  historyMessages: StoredMessage[],
): ChatMessage[] {
  const goalSection = firstMessages.length > 0
    ? firstMessages.map((m) => `[${m.role}]: ${m.content}`).join("\n")
    : "(no initial messages available)";

  const historySection = historyMessages.length > 0
    ? historyMessages.map((m) => `[${m.role}]: ${m.content}`).join("\n")
    : "(no messages available)";

  const userMessage = `What are we trying to achieve:\n${goalSection}\n\nMessage History (most recent):\n${historySection}`;

  return [
    { role: "system", content: SYSTEM_PROMPT },
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

  return { nextAction, content };
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

  const allMessages = deps.messageStore.listMessages(sessionId);
  if (allMessages.length === 0) {
    console.log(`[nightwatch] No messages for session ${sessionId}, skipping`);
    return;
  }

  // First 3 messages for goal context, last 30 for recent history
  const firstMessages = allMessages.slice(0, 3);
  const recentMessages = allMessages.slice(-30);
  const model = sessionState.model || NIGHTWATCH_DEFAULT_MODEL;

  console.log(
    `[nightwatch] Reviewing session ${sessionId} (cycle ${sessionState.cycleCount}/${sessionState.maxCycles}, model: ${model})`,
  );

  const prompt = buildNightWatchPrompt(firstMessages, recentMessages);
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

  // Handle morehistory — retry once with full context
  if (result.nextAction === "morehistory") {
    console.log(`[nightwatch] Retrying session ${sessionId} with full history`);
    const fullPrompt = buildNightWatchPrompt(firstMessages, allMessages);

    try {
      const retryRaw = await callOpenRouter(fullPrompt, model, apiKey, deps.openRouterBaseUrl);
      const retryResult = parseNightWatchResponse(retryRaw);

      if (retryResult.nextAction === "morehistory") {
        // Second morehistory → treat as complete
        result = { nextAction: "complete", content: retryResult.content };
      } else {
        result = retryResult;
      }
      console.log(`[nightwatch] Session ${sessionId} retry -> action: ${result.nextAction}`);
    } catch (err) {
      console.error(`[nightwatch] Retry failed for session ${sessionId}:`, err);
      return;
    }
  }

  // Act on the result
  if (result.nextAction === "continue") {
    deps.store.incrementCycle(sessionId);
    try {
      deps.promptQueueStore.addPrompt(sessionId, { content: result.content });
      console.log(`[nightwatch] Queued continuation prompt for session ${sessionId}`);
      // Trigger dispatch
      const session = deps.getSession(sessionId);
      if (session) {
        // The caller wired dispatchPrompt to maybeAutoDispatchQueuedPrompt
        // which will pick up the queued prompt on the next sweep
      }
    } catch (err) {
      console.error(`[nightwatch] Failed to queue prompt for session ${sessionId}:`, err);
    }
    return;
  }

  // Terminal actions: complete, error, humanInput
  const session = deps.getSession(sessionId);
  const sessionName = session?.name ?? null;
  const currentState = deps.store.getSessionState(sessionId);
  const cycleCount = currentState?.cycleCount ?? 0;

  deps.store.addReport({
    sessionId,
    sessionName,
    status: result.nextAction as NightWatchReport["status"],
    summary: result.content,
    cycleCount,
  });

  deps.store.disableSession(sessionId);
  console.log(
    `[nightwatch] Session ${sessionId} terminated with ${result.nextAction}: ${result.content.slice(0, 100)}`,
  );
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
  if (!flag || flag.state === "off") return;

  // Check session is enabled
  if (!deps.store.isEnabled(session.id)) return;

  // Prevent overlapping calls
  if (nightwatchInFlight.has(session.id)) return;

  // Check cycle limit
  const sessionState = deps.store.getSessionState(session.id);
  if (sessionState && sessionState.cycleCount >= sessionState.maxCycles) {
    console.log(
      `[nightwatch] Session ${session.id} reached max cycles (${sessionState.maxCycles}), auto-stopping`,
    );
    deps.store.addReport({
      sessionId: session.id,
      sessionName: session.name ?? null,
      status: "complete",
      summary: `Reached maximum cycle limit (${sessionState.maxCycles}).`,
      cycleCount: sessionState.cycleCount,
    });
    deps.store.disableSession(session.id);
    return;
  }

  nightwatchInFlight.add(session.id);
  try {
    await executeNightWatchReview(session.id, deps);
  } catch (err) {
    console.error(`[nightwatch] Unexpected error for session ${session.id}:`, err);
  } finally {
    nightwatchInFlight.delete(session.id);
  }
}
