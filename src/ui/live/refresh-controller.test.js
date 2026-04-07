import { describe, expect, test } from "bun:test";
import { createLiveRefreshController, LIVE_POLL_MODE, LIVE_STREAM_MODE } from "./refresh-controller.js";

function createFakeSseManager() {
  const connectionListeners = new Set();
  const streamModeListeners = new Set();
  const connectionState = new Map();
  const streamMode = new Map();

  return {
    connectCalls: [],
    disconnectCalls: [],
    connect(sessionId) {
      this.connectCalls.push(sessionId);
      connectionState.set(sessionId, "connecting");
    },
    disconnect(sessionId) {
      this.disconnectCalls.push(sessionId);
      connectionState.set(sessionId, "disconnected");
    },
    getConnectionState(sessionId) {
      return connectionState.get(sessionId) ?? "disconnected";
    },
    getStreamMode(sessionId) {
      return streamMode.get(sessionId) ?? LIVE_STREAM_MODE.unknown;
    },
    onConnectionChange(callback) {
      connectionListeners.add(callback);
      return () => connectionListeners.delete(callback);
    },
    onStreamModeChange(callback) {
      streamModeListeners.add(callback);
      return () => streamModeListeners.delete(callback);
    },
    emitConnection(sessionId, state) {
      connectionState.set(sessionId, state);
      connectionListeners.forEach((listener) => listener(sessionId, state));
    },
    emitStreamMode(sessionId, mode) {
      streamMode.set(sessionId, mode);
      streamModeListeners.forEach((listener) => listener(sessionId, mode));
    },
  };
}

function createTimerHarness() {
  const intervals = [];

  globalThis.window = {
    setInterval(callback, ms) {
      const id = intervals.length + 1;
      intervals.push({ id, callback, ms, cleared: false });
      return id;
    },
    clearInterval(id) {
      const entry = intervals.find((interval) => interval.id === id);
      if (entry) {
        entry.cleared = true;
      }
    },
  };

  return intervals;
}

describe("createLiveRefreshController", () => {
  test("keeps event-stream sessions off steady-state polling", async () => {
    const intervals = createTimerHarness();
    const sseManager = createFakeSseManager();
    const calls = [];

    const controller = createLiveRefreshController({
      sseManager,
      getCurrentRoute: () => "live",
      getActiveSessionId: () => "session-1",
      getSessionRuntimeStatus: () => "stable",
      fetchConversation: async (sessionId) => calls.push(["conversation", sessionId]),
      fetchLogs: async (sessionId) => calls.push(["logs", sessionId]),
      fetchSessionQueue: async (sessionId) => calls.push(["queue", sessionId]),
      fetchSessionDetails: async () => ({ agentRuntimeStatus: "stable" }),
      applySessionDetails: (sessionId) => calls.push(["status", sessionId]),
      isComposerInteractionActive: () => false,
      isMobileKeyboardOpen: () => false,
    });

    controller.activateSession("session-1");
    await Promise.resolve();
    expect(calls).toEqual([
      ["conversation", "session-1"],
      ["logs", "session-1"],
      ["queue", "session-1"],
      ["status", "session-1"],
    ]);

    sseManager.emitConnection("session-1", "connected");
    sseManager.emitStreamMode("session-1", LIVE_STREAM_MODE.eventStream);
    await Promise.resolve();

    expect(controller.getPollMode()).toBe(LIVE_POLL_MODE.off);
    expect(intervals.length).toBe(0);
  });

  test("starts compatibility polling for heartbeat-only streams", async () => {
    const intervals = createTimerHarness();
    const sseManager = createFakeSseManager();

    const controller = createLiveRefreshController({
      sseManager,
      getCurrentRoute: () => "live",
      getActiveSessionId: () => "session-2",
      getSessionRuntimeStatus: () => "stable",
      fetchConversation: async () => {},
      fetchLogs: async () => {},
      fetchSessionQueue: async () => {},
      fetchSessionDetails: async () => ({ agentRuntimeStatus: "running" }),
      applySessionDetails: () => {},
      isComposerInteractionActive: () => false,
      isMobileKeyboardOpen: () => false,
    });

    controller.activateSession("session-2");
    sseManager.emitConnection("session-2", "connected");
    sseManager.emitStreamMode("session-2", LIVE_STREAM_MODE.heartbeatOnly);
    await Promise.resolve();

    expect(controller.getPollMode()).toBe(LIVE_POLL_MODE.compatibility);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.ms).toBe(1000);
  });

  test("switches into recovery polling for degraded streams", async () => {
    const intervals = createTimerHarness();
    const sseManager = createFakeSseManager();

    const controller = createLiveRefreshController({
      sseManager,
      getCurrentRoute: () => "live",
      getActiveSessionId: () => "session-3",
      getSessionRuntimeStatus: () => "running",
      fetchConversation: async () => {},
      fetchLogs: async () => {},
      fetchSessionQueue: async () => {},
      fetchSessionDetails: async () => ({ agentRuntimeStatus: "running" }),
      applySessionDetails: () => {},
      isComposerInteractionActive: () => false,
      isMobileKeyboardOpen: () => false,
    });

    controller.activateSession("session-3");
    sseManager.emitConnection("session-3", "connected");
    expect(controller.getPollMode()).toBe(LIVE_POLL_MODE.off);
    expect(intervals).toHaveLength(0);

    sseManager.emitStreamMode("session-3", LIVE_STREAM_MODE.degraded);
    await Promise.resolve();

    expect(controller.getPollMode()).toBe(LIVE_POLL_MODE.recovery);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.ms).toBe(2000);

    sseManager.emitStreamMode("session-3", LIVE_STREAM_MODE.eventStream);
    await Promise.resolve();
    expect(controller.getPollMode()).toBe(LIVE_POLL_MODE.compatibility);
    expect(intervals[0]?.cleared).toBe(true);
    expect(intervals).toHaveLength(2);
    expect(intervals[1]?.ms).toBe(1000);
  });

  test("waits for a known transport mode before enabling busy-session compatibility polling", async () => {
    const intervals = createTimerHarness();
    const sseManager = createFakeSseManager();

    const controller = createLiveRefreshController({
      sseManager,
      getCurrentRoute: () => "live",
      getActiveSessionId: () => "session-4",
      getSessionRuntimeStatus: () => "running",
      fetchConversation: async () => {},
      fetchLogs: async () => {},
      fetchSessionQueue: async () => {},
      fetchSessionDetails: async () => ({ agentRuntimeStatus: "running" }),
      applySessionDetails: () => {},
      isComposerInteractionActive: () => false,
      isMobileKeyboardOpen: () => false,
    });

    controller.activateSession("session-4");
    sseManager.emitConnection("session-4", "connected");
    await Promise.resolve();

    expect(controller.getPollMode()).toBe(LIVE_POLL_MODE.off);
    expect(intervals).toHaveLength(0);

    sseManager.emitStreamMode("session-4", LIVE_STREAM_MODE.eventStream);
    await Promise.resolve();

    expect(controller.getPollMode()).toBe(LIVE_POLL_MODE.compatibility);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.ms).toBe(1000);
  });

  test("keeps a 1s compatibility poll running while the active session is busy", async () => {
    const intervals = createTimerHarness();
    const sseManager = createFakeSseManager();

    const controller = createLiveRefreshController({
      sseManager,
      getCurrentRoute: () => "live",
      getActiveSessionId: () => "session-5",
      getSessionRuntimeStatus: () => "running",
      fetchConversation: async () => {},
      fetchLogs: async () => {},
      fetchSessionQueue: async () => {},
      fetchSessionDetails: async () => ({ agentRuntimeStatus: "running" }),
      applySessionDetails: () => {},
      isComposerInteractionActive: () => false,
      isMobileKeyboardOpen: () => false,
    });

    controller.activateSession("session-5");
    sseManager.emitConnection("session-5", "connected");
    sseManager.emitStreamMode("session-5", LIVE_STREAM_MODE.eventStream);
    await Promise.resolve();

    expect(controller.getPollMode()).toBe(LIVE_POLL_MODE.compatibility);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.ms).toBe(1000);
  });
});
