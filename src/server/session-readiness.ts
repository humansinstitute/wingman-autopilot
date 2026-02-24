import { buildAgentUrl } from "../agents/agent-client";
import type { SessionSnapshot } from "../agents/process-manager";

export interface WaitForSessionPromptReadinessOptions {
  getSession: (sessionId: string) => SessionSnapshot | null;
  sessionId: string;
  host: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  requiredStablePolls?: number;
  requestTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchRuntimeStatus(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<string | null> {
  const url = buildAgentUrl(host, port, "/status");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }

    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const status = (payload as Record<string, unknown>).status;
    return typeof status === "string" ? status : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function waitForSessionPromptReadiness(
  options: WaitForSessionPromptReadinessOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 60000;
  const pollIntervalMs = options.pollIntervalMs && options.pollIntervalMs > 0 ? options.pollIntervalMs : 500;
  const requiredStablePolls =
    options.requiredStablePolls && options.requiredStablePolls > 0 ? options.requiredStablePolls : 3;
  const requestTimeoutMs = options.requestTimeoutMs && options.requestTimeoutMs > 0 ? options.requestTimeoutMs : 2500;

  const deadline = Date.now() + timeoutMs;
  let stablePolls = 0;

  while (Date.now() < deadline) {
    const session = options.getSession(options.sessionId);
    if (!session) {
      throw new Error(`Session ${options.sessionId} no longer exists`);
    }

    if (session.status !== "running") {
      throw new Error(`Session ${options.sessionId} is not running`);
    }

    const runtimeStatus = await fetchRuntimeStatus(options.host, session.port, requestTimeoutMs);
    if (runtimeStatus === "stable") {
      stablePolls += 1;
      if (stablePolls >= requiredStablePolls) {
        return;
      }
    } else {
      stablePolls = 0;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for session ${options.sessionId} to reach steady stable status`);
}
