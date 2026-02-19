/**
 * Night Watch Engine
 *
 * Minimal supervisor for AI agent sessions. NW can only do three things:
 * 1. Send raw keystrokes (1-9, y, n) to answer interactive terminal prompts
 * 2. Monitor silently when the agent is working normally
 * 3. Escalate to the human for everything else
 */

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
  /** Mark a dispatch cooldown so the sweep skips this session briefly */
  markDispatchCooldown?: (sessionId: string) => void;
  /** Called when a session reaches a terminal state (complete/error/humanInput) */
  onSessionComplete?: (sessionId: string, report: NightWatchReport) => void;
}

type NightWatchAction = "raw" | "monitor" | "humanInput";

const VALID_RAW_INPUTS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "y", "n"] as const;
type NightWatchRawInput = (typeof VALID_RAW_INPUTS)[number];

interface NightWatchResponse {
  nextAction: NightWatchAction;
  content: string;
  reasoning: string;
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

// Cooldown after sending raw input — prevents re-triggering before the agent processes it
const RAW_INPUT_COOLDOWN_MS = 15_000;
const rawInputCooldowns = new Map<string, number>();

// Track consecutive raw inputs that produce no new messages — detect stuck loops
const lastRawMessageCounts = new Map<string, { count: number; attempts: number }>();
const MAX_STALE_RAW_ATTEMPTS = 3;

// ============================================================
// System Prompt
// ============================================================

export const NIGHTWATCH_DEFAULT_PROMPT = `You are Night Watchman, a minimal supervisor for AI coding agent sessions.
Your job is to keep agents unblocked by answering interactive terminal prompts (menus, yes/no, permission dialogs) with raw keystrokes, and to silently monitor when the agent is working normally.

You MUST respond with valid JSON only. No markdown, no explanation outside the JSON.

Response format:
{
  "nextAction": "<monitor, raw, or humanInput>",
  "inputRaw": "<1-9, y, or n — REQUIRED when nextAction is raw, null otherwise>",
  "reasoning": "<brief explanation of why you chose this action>",
  "content": "<description of what you observed>"
}

Available actions (in order of preference):

1. "raw": The agent is showing an INTERACTIVE PROMPT that requires a keystroke response. You MUST set "inputRaw" to one of: "1", "2", "3", "4", "5", "6", "7", "8", "9", "y", or "n". Use this for:
  - A numbered menu or list of options (e.g. "1. Yes  2. No", "1. Allow  2. Deny")
  - A yes/no or y/n confirmation prompt
  - A permission dialog asking to allow/deny/approve
  - Any TUI selection that needs a keystroke
  - Claude Code tool approval prompts (approve with "y")
  THIS IS YOUR MOST IMPORTANT ACTION. If the agent is waiting on a prompt, answer it immediately.

2. "monitor": The agent is working normally — writing code, reading files, thinking, running commands. Nothing needs your attention right now. Use this when:
  - The agent is actively working on its task
  - The agent just completed an action and is moving to the next step
  - The agent is running a command and waiting for output
  - There is no prompt or question visible in the recent messages
  - The agent appears to be making progress
  THIS IS YOUR DEFAULT ACTION. If nothing looks wrong and there's no prompt, use monitor.

3. "humanInput": The agent genuinely needs human intervention that you cannot provide. Use this ONLY when:
  - The agent has explicitly finished its task and is waiting for new instructions
  - The agent is stuck in an error loop (same error 3+ times)
  - The agent needs credentials, API keys, or secrets you don't have
  - The agent is asking a free-form question that needs a typed answer (not a menu/y/n)
  THIS IS YOUR LAST RESORT. Only use when the agent truly cannot proceed without human help.

CRITICAL RULES:

1. YOUR DEFAULT ACTION IS "monitor". When in doubt, choose monitor — you'll check again shortly.

2. ALWAYS use "raw" when you see ANY interactive prompt. Numbered lists, y/n questions, approve/deny dialogs — answer them immediately. Don't escalate a simple prompt to the human.

3. For numbered menus, pick the most pragmatic option. For y/n prompts, choose "y" to approve and keep things moving unless there's a clear reason not to (e.g. destructive action like deleting a branch).

4. IMPORTANT: Distinguish between INTERACTIVE PROMPTS and NUMBERED LISTS in agent output. An interactive prompt is something the agent is WAITING for input on — the conversation has STOPPED and the last message shows a menu or question. A numbered list in agent output (like "Here's my plan: 1. Read files 2. Fix bug") is NOT an interactive prompt — that's the agent explaining what it will do.

5. NEVER try to give the agent instructions or answer free-form questions. You can only press buttons or watch.

6. The "content" field is for YOUR report to the human. It is never sent to the agent.`;

// ============================================================
// Core Functions
// ============================================================

function buildNightWatchPrompt(
  systemPrompt: string,
  firstMessages: StoredMessage[],
  recentMessages: StoredMessage[],
): ChatMessage[] {
  const goalSection = firstMessages.length > 0
    ? firstMessages.map((m) => `[${m.role}]: ${m.content}`).join("\n")
    : "(no initial messages available)";

  const historySection = recentMessages.length > 0
    ? recentMessages.map((m) => `[${m.role}]: ${m.content}`).join("\n")
    : "(no messages available)";

  const userMessage = `What are we trying to achieve:\n${goalSection}\n\nRecent conversation (last ${recentMessages.length} messages):\n${historySection}`;

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

  const content = String(parsed.content ?? "No details provided.");
  const reasoning = String(parsed.reasoning ?? "");

  // Validate inputRaw against the allowed enum
  const rawInputValue = parsed.inputRaw != null ? String(parsed.inputRaw).trim() : null;
  const inputRaw: NightWatchRawInput | null =
    rawInputValue && (VALID_RAW_INPUTS as readonly string[]).includes(rawInputValue)
      ? (rawInputValue as NightWatchRawInput)
      : null;

  // Validate action: raw (with valid inputRaw), monitor, or humanInput
  const action = String(parsed.nextAction ?? "monitor").toLowerCase();
  let nextAction: NightWatchAction;
  if (action === "raw" && inputRaw) {
    nextAction = "raw";
  } else if (action === "monitor" || action === "continue") {
    // Accept "continue" as alias for "monitor" for backward compat with old custom prompts
    nextAction = "monitor";
  } else {
    nextAction = "humanInput";
  }

  return { nextAction, content, reasoning, inputRaw };
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

  const session = deps.getSession(sessionId);

  // Only send the first 3 messages (goal context) and the latest message
  const firstMessages = allMessages.slice(0, 3);
  const recentMessages = allMessages.slice(-1);
  const model = sessionState.model || NIGHTWATCH_DEFAULT_MODEL;
  const customPrompt = deps.store.getConfig("custom_prompt");
  const systemPrompt = customPrompt || NIGHTWATCH_DEFAULT_PROMPT;

  console.log(
    `[nightwatch] Reviewing session ${sessionId} (cycle ${sessionState.cycleCount}/${sessionState.maxCycles}, model: ${model}, messages: ${allMessages.length}, sending latest${customPrompt ? ", custom prompt" : ""})`,
  );

  const prompt = buildNightWatchPrompt(systemPrompt, firstMessages, recentMessages);
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

  // Stale raw input detection: if we're about to send raw input but the message
  // count hasn't changed since the last raw input, the agent isn't responding to
  // our keystrokes. After MAX_STALE_RAW_ATTEMPTS, force monitor instead.
  if (result.nextAction === "raw") {
    const staleState = lastRawMessageCounts.get(sessionId);
    if (staleState && staleState.count === allMessages.length) {
      staleState.attempts += 1;
      if (staleState.attempts >= MAX_STALE_RAW_ATTEMPTS) {
        console.log(
          `[nightwatch] Session ${sessionId}: raw input sent ${staleState.attempts} times with no new messages (${allMessages.length}), switching to monitor`,
        );
        result = {
          nextAction: "monitor",
          content: `Raw input not advancing session (${staleState.attempts} attempts, ${allMessages.length} messages). Switching to monitor.`,
          reasoning: "Stale raw input detection triggered.",
          inputRaw: null,
        };
        lastRawMessageCounts.delete(sessionId);
      }
    } else {
      lastRawMessageCounts.set(sessionId, { count: allMessages.length, attempts: 1 });
    }
  } else {
    // Non-raw action — reset stale tracking
    lastRawMessageCounts.delete(sessionId);
  }

  // Create a report card for every cycle
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
    inputMode: result.nextAction === "raw" ? "raw" : null,
    inputRaw: result.nextAction === "raw" ? result.inputRaw : null,
    cycleCount,
  });

  // Act on the result
  if (result.nextAction === "raw" && result.inputRaw && currentSession) {
    // Raw mode: send the validated inputRaw keystroke directly to terminal
    deps.store.incrementCycle(sessionId);
    try {
      const sent = await deps.sendRawInput(currentSession, result.inputRaw);
      if (sent) {
        console.log(`[nightwatch] Sent raw input to session ${sessionId}: "${result.inputRaw}" (reason: ${result.content.slice(0, 80)})`);
        rawInputCooldowns.set(sessionId, Date.now());
        if (deps.markDispatchCooldown) {
          deps.markDispatchCooldown(sessionId);
        }
      } else {
        console.warn(`[nightwatch] Failed to send raw input to session ${sessionId}`);
      }
    } catch (err) {
      console.error(`[nightwatch] Raw input failed for session ${sessionId}:`, err);
    }
    return;
  }

  if (result.nextAction === "monitor") {
    // Agent is working fine — increment cycle, do nothing, check again next sweep
    deps.store.incrementCycle(sessionId);
    console.log(`[nightwatch] Session ${sessionId} monitoring: ${result.content.slice(0, 100)}`);
    return;
  }

  // humanInput — disable nightwatch and notify the human
  rawInputCooldowns.delete(sessionId);
  lastRawMessageCounts.delete(sessionId);
  deps.store.disableSession(sessionId);
  console.log(
    `[nightwatch] Session ${sessionId} needs human input: ${result.content.slice(0, 100)}`,
  );

  const terminalReport: NightWatchReport = {
    id: "",
    sessionId,
    sessionName,
    workingDirectory: currentSession?.workingDirectory ?? null,
    status: "humanInput",
    summary: result.content,
    reasoning: result.reasoning || null,
    inputMode: null,
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

  // Cooldown after raw input — let the agent process before re-evaluating
  const lastRawInput = rawInputCooldowns.get(session.id);
  if (lastRawInput && Date.now() - lastRawInput < RAW_INPUT_COOLDOWN_MS) {
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
      status: "humanInput",
      summary: `Reached maximum cycle limit (${sessionState.maxCycles}). Human review needed.`,
      reasoning: "Automatic stop: cycle limit reached.",
      cycleCount: sessionState.cycleCount,
    });
    deps.store.disableSession(session.id);

    const maxCycleReport: NightWatchReport = {
      id: "",
      sessionId: session.id,
      sessionName: session.name ?? null,
      workingDirectory: session.workingDirectory ?? null,
      status: "humanInput",
      summary: `Reached maximum cycle limit (${sessionState.maxCycles}). Human review needed.`,
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
