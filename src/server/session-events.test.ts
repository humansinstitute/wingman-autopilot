import { afterEach, describe, expect, test } from "bun:test";

import { createSessionEventsHandler } from "./session-events";

const decoder = new TextDecoder();

const runningSession = {
  id: "session-1",
  status: "running",
};

function createManager(getEventsUrl: URL | null) {
  return {
    getSession(id: string) {
      return id === "session-1" ? runningSession : null;
    },
    getAdapter() {
      return {
        getEventsUrl() {
          return getEventsUrl;
        },
      };
    },
  } as any;
}

async function readUntilTransport(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  let combined = "";
  for (let index = 0; index < 4; index += 1) {
    const { value, done } = await reader.read();
    if (value) {
      combined += decoder.decode(value);
    }
    if (combined.includes("event: transport") || done) {
      break;
    }
  }

  await reader.cancel();
  return combined;
}

describe("createSessionEventsHandler", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("announces event-stream transport for proxied SSE sessions", async () => {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start() {
            // Keep the upstream open; the test only cares about the initial transport event.
          },
        }),
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );

    const handler = createSessionEventsHandler({
      manager: createManager(new URL("http://127.0.0.1:3700/events")),
      agentHost: "127.0.0.1",
      sseKeepaliveIntervalMs: 1000,
    });

    const response = await handler("session-1", new Request("http://localhost/api/sessions/session-1/events"));
    const chunk = await readUntilTransport(response);

    expect(chunk).toContain("event: transport");
    expect(chunk).toContain('"mode":"event-stream"');
  });

  test("announces heartbeat-only transport for native adapter sessions", async () => {
    const handler = createSessionEventsHandler({
      manager: createManager(null),
      agentHost: "127.0.0.1",
      sseKeepaliveIntervalMs: 1000,
    });

    const response = await handler("session-1", new Request("http://localhost/api/sessions/session-1/events"));
    const chunk = await readUntilTransport(response);

    expect(chunk).toContain("event: transport");
    expect(chunk).toContain('"mode":"heartbeat-only"');
  });
});
