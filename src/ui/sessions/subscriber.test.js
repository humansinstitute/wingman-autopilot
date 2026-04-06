import { afterEach, describe, expect, test } from "bun:test";

import { startSessionSubscriber, stopSessionSubscriber } from "./subscriber.js";

class FakeEventSource {
  constructor() {
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }
}

FakeEventSource.instances = [];

describe("session subscriber", () => {
  const originalEventSource = globalThis.EventSource;

  afterEach(() => {
    stopSessionSubscriber();
    FakeEventSource.instances = [];
    globalThis.EventSource = originalEventSource;
  });

  test("calls onConnect when the SSE stream opens", () => {
    let connected = 0;
    globalThis.EventSource = FakeEventSource;

    startSessionSubscriber({
      onConnect: () => {
        connected += 1;
      },
    });

    const source = FakeEventSource.instances[0];
    expect(source).toBeDefined();
    source.onopen?.();

    expect(connected).toBe(1);
  });

  test("forwards parsed session lifecycle events", () => {
    const events = [];
    globalThis.EventSource = FakeEventSource;

    startSessionSubscriber({
      onEvent: (event) => {
        events.push(event);
      },
    });

    const source = FakeEventSource.instances[0];
    source.onmessage?.({
      data: JSON.stringify({ type: "session-started", sessionId: "session-1" }),
    });

    expect(events).toEqual([{ type: "session-started", sessionId: "session-1" }]);
  });
});
