/**
 * Night Watch Engine
 *
 * Replaces the old OpenRouter supervisor loop with a simple recurring
 * check-in timer. While enabled, Night Watch sends "Any progress?"
 * every 5 minutes for the session.
 */

import { buildAgentUrl } from "../agents/agent-client";
import type { SessionSnapshot } from "../agents/process-manager";
import type { FeatureFlagRecord } from "../storage/feature-flag-store";
import { deliverSessionAgentMessage } from "../server/session-agent-message";
import type { NightWatchStore } from "./nightwatch-store";
import {
  NIGHTWATCH_CHECK_IN_PROMPT,
  NIGHTWATCH_DEFAULT_INTERVAL_MINUTES,
  NIGHTWATCH_DEFAULT_MODEL,
  NIGHTWATCH_DEFAULT_PROMPT,
  NIGHTWATCH_FEATURE_FLAG_KEY,
  NIGHTWATCH_MAX_INTERVAL_MINUTES,
  NIGHTWATCH_MAX_CYCLE_OPTIONS,
  NIGHTWATCH_MIN_INTERVAL_MINUTES,
  NIGHTWATCH_MODELS,
  getNightWatchRetryPromptAt,
} from "./nightwatch-constants";

export {
  NIGHTWATCH_CHECK_IN_PROMPT,
  NIGHTWATCH_DEFAULT_INTERVAL_MINUTES,
  NIGHTWATCH_DEFAULT_MODEL,
  NIGHTWATCH_DEFAULT_PROMPT,
  NIGHTWATCH_FEATURE_FLAG_KEY,
  NIGHTWATCH_MAX_INTERVAL_MINUTES,
  NIGHTWATCH_MAX_CYCLE_OPTIONS,
  NIGHTWATCH_MIN_INTERVAL_MINUTES,
  NIGHTWATCH_MODELS,
};

interface FeatureFlagStore {
  getFlag(key: string): FeatureFlagRecord | null;
}

export interface NightWatchDeps {
  store: NightWatchStore;
  featureFlagStore: FeatureFlagStore;
  agentHost: string;
  getSession: (sessionId: string) => SessionSnapshot | null;
}

const nightwatchInFlight = new Set<string>();

function isNightWatchFeatureEnabled(deps: NightWatchDeps): boolean {
  const flag = deps.featureFlagStore.getFlag(NIGHTWATCH_FEATURE_FLAG_KEY);
  return Boolean(flag && flag.state !== "off");
}

function getPromptAtMs(promptAt: string | null): number | null {
  if (!promptAt) return null;
  const promptAtMs = Date.parse(promptAt);
  return Number.isFinite(promptAtMs) ? promptAtMs : null;
}

function buildCheckInSummary(sessionName: string | null, cycleCount: number, prompt: string): string {
  const label = sessionName ?? "session";
  const compactPrompt = prompt.replace(/\s+/g, " ").trim();
  const preview =
    compactPrompt.length > 80 ? `${compactPrompt.slice(0, 77)}...` : compactPrompt;
  return `Sent "${preview}" to ${label} (${cycleCount} check-ins).`;
}

async function sendNightWatchPrompt(
  session: SessionSnapshot,
  prompt: string,
  deps: NightWatchDeps,
): Promise<{ ok: boolean; message: string }> {
  return deliverSessionAgentMessage({
    sessionId: session.id,
    agentHost: deps.agentHost,
    buildAgentUrl,
    agent: session.agent,
    port: session.port,
    content: prompt,
    type: "user",
    pm2Name: session.pm2Name,
  });
}

export async function maybeTriggerNightWatch(
  session: SessionSnapshot | null,
  deps: NightWatchDeps,
): Promise<void> {
  if (!session) return;
  if (!isNightWatchFeatureEnabled(deps)) return;

  const sessionState = deps.store.getSessionState(session.id);
  if (!sessionState?.enabled) return;
  if (session.status !== "running" || session.agentRuntimeStatus !== "stable") return;
  if (nightwatchInFlight.has(session.id)) return;

  if (!sessionState.promptAt) {
    deps.store.scheduleNextPrompt(session.id);
    return;
  }

  const promptAtMs = getPromptAtMs(sessionState.promptAt);
  if (promptAtMs == null) {
    deps.store.scheduleNextPrompt(session.id);
    return;
  }

  if (promptAtMs > Date.now()) {
    return;
  }

  nightwatchInFlight.add(session.id);
  try {
    const currentSession = deps.getSession(session.id) ?? session;
    const willContinue = sessionState.cycleCount + 1 < sessionState.maxCycles;
    const result = await sendNightWatchPrompt(currentSession, sessionState.prompt, deps);

    if (!result.ok) {
      deps.store.postponePrompt(session.id, getNightWatchRetryPromptAt());
      console.warn(
        `[nightwatch] Failed to send check-in for session ${session.id}: ${result.message}`,
      );
      return;
    }

    const cycleCount = deps.store.recordPromptSent(session.id, willContinue);
    deps.store.addReport({
      sessionId: session.id,
      sessionName: currentSession.name ?? null,
      workingDirectory: currentSession.workingDirectory ?? null,
      status: willContinue ? "continue" : "complete",
      summary: buildCheckInSummary(currentSession.name ?? null, cycleCount, sessionState.prompt),
      reasoning:
        `Night Watch timer fired after ${sessionState.intervalMinutes} minute` +
        `${sessionState.intervalMinutes === 1 ? "" : "s"}.`,
      cycleCount,
    });
  } finally {
    nightwatchInFlight.delete(session.id);
  }
}
