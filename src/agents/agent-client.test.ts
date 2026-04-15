import { afterEach, describe, expect, test } from "bun:test";

import { matchesReadyAgentType, waitForAgentReady } from "./agent-client";

describe("matchesReadyAgentType", () => {
  test("accepts exact agent type matches", () => {
    expect(matchesReadyAgentType("codex", "codex")).toBe(true);
    expect(matchesReadyAgentType("pi", "pi")).toBe(true);
  });

  test("accepts agentapi custom status for pi", () => {
    expect(matchesReadyAgentType("pi", "custom")).toBe(true);
  });

  test("rejects custom status for non-pi agents", () => {
    expect(matchesReadyAgentType("codex", "custom")).toBe(false);
    expect(matchesReadyAgentType("claude", "custom")).toBe(false);
  });
});

describe("waitForAgentReady", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("treats pi sessions reporting custom as ready", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          status: "stable",
          agent_type: "custom",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );

    await expect(
      waitForAgentReady("127.0.0.1", 3700, "pi", {
        timeoutMs: 100,
        pollIntervalMs: 10,
      }),
    ).resolves.toBeUndefined();
  });

  test("still times out when a non-pi custom session never matches", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          status: "stable",
          agent_type: "custom",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );

    await expect(
      waitForAgentReady("127.0.0.1", 3700, "codex", {
        timeoutMs: 30,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow("Timed out waiting for codex agent to become ready");
  });
});
