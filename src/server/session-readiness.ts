import type { AgentAdapter } from "../agents/agent-adapter";
import type { SessionSnapshot } from "../agents/process-manager";

export interface WaitForSessionPromptReadinessOptions {
  getSession: (sessionId: string) => SessionSnapshot | null;
  getAdapter: (sessionId: string) => AgentAdapter | null;
  sessionId: string;
  host: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  requiredStablePolls?: number;
  requestTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

    const adapter = options.getAdapter(options.sessionId);
    let runtimeStatus: string | null = null;
    if (adapter) {
      try {
        runtimeStatus = await adapter.fetchStatus(requestTimeoutMs);
      } catch {
        runtimeStatus = null;
      }
    }

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
