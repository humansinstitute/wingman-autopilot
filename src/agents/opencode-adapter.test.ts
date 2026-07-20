import { afterEach, describe, expect, test } from "bun:test";

import { OpenCodeAdapter } from "./opencode-adapter";

const context = {
  id: "wingman-session",
  port: 4096,
  agent: "opencode" as const,
  host: "127.0.0.1",
  workingDirectory: "/tmp/project",
  model: "openrouter/kimi-k3",
  opencodeSdkSessionId: "opencode-session",
};

describe("OpenCodeAdapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("reads structured message history from OpenCode", async () => {
    globalThis.fetch = (async (input) => {
      const requestUrl = typeof input === "string" ? input : input.url;
      expect(new URL(requestUrl).pathname).toBe("/session/opencode-session/message");
      return Response.json([
        {
          info: {
            id: "message-1",
            sessionID: "opencode-session",
            role: "assistant",
            time: { created: 1_750_000_000_000 },
          },
          parts: [
            { id: "part-1", sessionID: "opencode-session", messageID: "message-1", type: "text", text: "Structured response" },
          ],
        },
      ]);
    }) as typeof fetch;

    const adapter = new OpenCodeAdapter(context);

    await expect(adapter.fetchMessages()).resolves.toEqual([
      {
        role: "assistant",
        content: "Structured response",
        createdAt: "2025-06-15T15:06:40.000Z",
      },
    ]);
  });

  test("sends the selected model through the prompt API and supports abort", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> | null }> = [];
    let releasePrompt: (() => void) | null = null;
    globalThis.fetch = (async (input, init) => {
      const requestUrl = typeof input === "string" ? input : input.url;
      const url = new URL(requestUrl);
      const bodyText = typeof init?.body === "string"
        ? init.body
        : typeof input === "string"
          ? null
          : await input.clone().text();
      const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : null;
      requests.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/abort")) return Response.json(true);
      if (url.pathname.endsWith("/message")) {
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      }
      return Response.json({});
    }) as typeof fetch;

    const adapter = new OpenCodeAdapter(context);
    expect(adapter.deliversPromptsDirectly()).toBe(true);
    const sendPromise = adapter.sendMessage("Inspect the project");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests.find((request) => request.path.endsWith("/message"))?.body).toMatchObject({
      model: { providerID: "openrouter", modelID: "kimi-k3" },
      parts: [{ type: "text", text: "Inspect the project" }],
    });

    const interrupted = await adapter.interruptCurrentTurn();
    expect(interrupted).toBe(true);
    releasePrompt?.();
    await sendPromise;
  });
});
