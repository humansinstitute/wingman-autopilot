import { describe, expect, test } from "bun:test";

import type { AgentAdapter } from "../agents/agent-adapter";
import { deliverSessionAgentMessage, type SessionAgentMessageInput } from "./session-agent-message";

function buildAdapter(overrides: Partial<AgentAdapter>): AgentAdapter {
  return {
    fetchStatus: async () => "stable",
    sendMessage: async () => {},
    fetchMessages: async () => [],
    interruptCurrentTurn: async () => false,
    getEventsUrl: () => null,
    waitForReady: async () => {},
    dispose: async () => {},
    ...overrides,
  };
}

const baseInput: Omit<SessionAgentMessageInput, "adapter" | "agent"> = {
  agentHost: "127.0.0.1",
  buildAgentUrl: (host, port, path) => `http://${host}:${port}${path}`,
  port: 3700,
  content: "hello",
  type: "user",
};

describe("deliverSessionAgentMessage adapter routing", () => {
  test("routes prompts to the adapter when it delivers prompts directly", async () => {
    const sent: string[] = [];
    let httpCalled = false;
    const adapter = buildAdapter({
      deliversPromptsDirectly: () => true,
      sendMessage: async (content) => {
        sent.push(content);
      },
    });

    const result = await deliverSessionAgentMessage({
      ...baseInput,
      agent: "codex",
      adapter,
      // Any fetch here would indicate the HTTP path was taken.
      buildAgentUrl: () => {
        httpCalled = true;
        return "http://unused";
      },
    });

    expect(result.ok).toBe(true);
    expect(sent).toEqual(["hello"]);
    expect(httpCalled).toBe(false);
  });

  test("does not use the adapter for raw delivery even when it delivers directly", async () => {
    let adapterSendCalled = false;
    const adapter = buildAdapter({
      deliversPromptsDirectly: () => true,
      sendMessage: async () => {
        adapterSendCalled = true;
      },
    });

    // Raw delivery must fall through to the HTTP path; point buildAgentUrl at a
    // closed port so the request fails fast without the adapter being used.
    const result = await deliverSessionAgentMessage({
      ...baseInput,
      agent: "codex",
      type: "raw",
      adapter,
      port: 1,
    });

    expect(adapterSendCalled).toBe(false);
    expect(result.ok).toBe(false);
  });

  test("surfaces adapter delivery failures as 502", async () => {
    const adapter = buildAdapter({
      deliversPromptsDirectly: () => true,
      sendMessage: async () => {
        throw new Error("thread crashed");
      },
    });

    const result = await deliverSessionAgentMessage({
      ...baseInput,
      agent: "codex",
      adapter,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.message).toContain("thread crashed");
  });
});
