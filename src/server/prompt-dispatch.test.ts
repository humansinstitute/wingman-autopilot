import { afterEach, describe, expect, mock, test } from "bun:test";

import type { AgentAdapter, PromptReadiness } from "../agents/agent-adapter";
import type { SessionSnapshot } from "../agents/process-manager";
import { createPromptDispatchEngine } from "./prompt-dispatch";

const baseSession: SessionSnapshot = {
  id: "session-1",
  agent: "codex",
  status: "running",
  npub: "npub1owner",
  port: 3700,
  pid: 1234,
  name: "test session",
  startedAt: new Date().toISOString(),
  command: ["codex"],
  workingDirectory: "/tmp/project",
  logs: [],
  agentRuntimeStatus: "running",
  origin: undefined,
  pm2Name: undefined,
  targetFile: undefined,
  metadata: { AGENT: false, billingMode: "subscription" },
};

function createQueue(prompts: string[]) {
  return {
    prompts: prompts.map((content, index) => ({
      id: `prompt-${index + 1}`,
      sessionId: "session-1",
      content,
      timestamp: new Date().toISOString(),
      order: index + 1,
    })),
    getNextQueuedPrompt(sessionId: string) {
      return sessionId === "session-1" ? this.prompts[0] ?? null : null;
    },
    removeNextPrompt(sessionId: string) {
      if (sessionId === "session-1") {
        this.prompts.shift();
      }
    },
    getQueueCount(sessionId: string) {
      return sessionId === "session-1" ? this.prompts.length : 0;
    },
  };
}

function buildEngine(overrides: Record<string, unknown> = {}) {
  const session = { ...baseSession };
  const queue = createQueue(["queued prompt"]);
  const waitForSessionPromptReadiness = mock(async () => undefined);
  const syncSessionMessages = mock(async () => [{ role: "user", content: "queued prompt" }]);
  const maybeTriggerNightWatch = mock(() => undefined);
  const getPromptReadiness = mock(async (): Promise<PromptReadiness> => ({
    state: "ready",
    reason: "test-ready",
    retryAfterMs: 250,
    observedAt: Date.now(),
  }));
  const adapter = {
    getPromptReadiness,
    fetchStatus: mock(async () => "stable" as const),
    sendMessage: mock(async () => {}),
    fetchMessages: mock(async () => []),
    interruptCurrentTurn: mock(async () => false),
    getEventsUrl: () => null,
    waitForReady: mock(async () => {}),
    dispose: mock(async () => {}),
  } satisfies AgentAdapter;

  const engine = createPromptDispatchEngine({
    manager: {
      getSession: (id: string) => (id === session.id ? session : undefined),
      listSessions: () => [],
      getAdapter: () => adapter,
    },
    agentHost: "127.0.0.1",
    messageStore: {
      listSessionMessages: () => [],
    },
    promptQueueStore: queue,
    buildAgentUrl: () => "http://127.0.0.1:3700/message",
    waitForSessionPromptReadiness,
    syncSessionMessages,
    maybeTriggerNightWatch,
    nightWatchDeps: {},
    ...overrides,
  });

  return {
    engine,
    session,
    queue,
    adapter,
    getPromptReadiness,
    waitForSessionPromptReadiness,
    syncSessionMessages,
    maybeTriggerNightWatch,
  };
}

describe("prompt dispatch engine", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("auto-dispatch attempts queued prompts for running sessions even before cached status is stable", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { engine, session, queue, waitForSessionPromptReadiness } = buildEngine();

    await engine.maybeAutoDispatchQueuedPrompt(session);

    expect(waitForSessionPromptReadiness).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queue.getQueueCount(session.id)).toBe(0);
  });

  test("auto-dispatch defers when adapter readiness says busy even if cached status is stable", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { engine, session, queue, getPromptReadiness, waitForSessionPromptReadiness } = buildEngine();
    session.agentRuntimeStatus = "stable";
    getPromptReadiness.mockResolvedValue({
      state: "busy",
      reason: "test-active-turn",
      retryAfterMs: 250,
      observedAt: Date.now(),
    });

    await engine.maybeAutoDispatchQueuedPrompt(session);

    expect(waitForSessionPromptReadiness).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queue.getQueueCount(session.id)).toBe(1);
  });

  test("auto-dispatch does not send queued prompts for unapproved users", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { engine, session, queue, waitForSessionPromptReadiness } = buildEngine({
      isUserApprovedForWork: () => false,
    });

    await engine.maybeAutoDispatchQueuedPrompt(session);

    expect(waitForSessionPromptReadiness).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queue.getQueueCount(session.id)).toBe(1);
  });

  test("cached startup readiness does not skip per-turn readiness while a session is busy", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { engine, session, queue, waitForSessionPromptReadiness } = buildEngine();

    session.agentRuntimeStatus = "stable";
    await engine.maybeAutoDispatchQueuedPrompt(session);

    queue.prompts.push({
      id: "prompt-2",
      sessionId: session.id,
      content: "second prompt",
      timestamp: new Date().toISOString(),
      order: 1,
    });
    session.agentRuntimeStatus = "running";

    await engine.maybeAutoDispatchQueuedPrompt(session);

    expect(waitForSessionPromptReadiness).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(queue.getQueueCount(session.id)).toBe(0);
  });
});
