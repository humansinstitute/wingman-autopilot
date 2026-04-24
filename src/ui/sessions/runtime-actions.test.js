import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createSessionRuntimeActions } from "./runtime-actions.js";

describe("session runtime actions", () => {
  let getSessionById;
  let fetchSessions;
  let fetchSessionApi;
  let fetchConversation;
  let fetchLogs;
  let setCurrentRoute;
  let setActiveSession;
  let render;
  let showToast;
  let state;
  let sessions;
  let postSessionMessageApi;
  let addToPromptQueue;
  let updateAgentStatusIndicators;
  let isSessionBusy;
  let sessionMessageSendInFlight;

  const buildActions = () =>
    createSessionRuntimeActions({
      state,
      sessionsStore: () => ({ items: sessions }),
      getSessionById,
      getSessionDisplayName: (session) => session?.name ?? session?.id ?? "session",
      fetchSessions,
      fetchSessionApi,
      fetchConversation,
      fetchLogs,
      render,
      setCurrentRoute,
      setActiveSession,
      stopSessionAction: mock(async () => ({ success: true })),
      deleteSessionAction: mock(async () => ({ success: true })),
      renameSessionAction: mock(async () => ({})),
      openTextPromptDialog: mock(async () => null),
      showToast,
      postSessionMessageApi,
      updateIdentityState: mock(() => {}),
      isSessionBusy,
      addToPromptQueue,
      updateAgentStatusIndicators,
      renderConversationForSession: mock(async () => {}),
      scrollPillHide: mock(() => {}),
      scrollConversationAreaToBottom: mock(() => {}),
      sessionMessageSendInFlight,
      focusComposerTextarea: mock(() => {}),
      isAlpineChatEnabled: () => false,
      MessageStore: { syncFromServer: mock(async () => {}), syncFromServerIfChanged: mock(async () => ({ changed: false })) },
      prepareVoiceNoteDraftForSend: mock(async (_sessionId, value) => value),
    });

  beforeEach(() => {
    getSessionById = mock(() => null);
    fetchSessions = mock(async () => {});
    fetchSessionApi = mock(async () => null);
    fetchConversation = mock(async () => {});
    fetchLogs = mock(async () => {});
    setCurrentRoute = mock(() => {});
    setActiveSession = mock(() => true);
    render = mock(() => {});
    showToast = mock(() => {});
    state = { messageDrafts: new Map() };
    sessions = [];
    postSessionMessageApi = mock(async () => ({}));
    addToPromptQueue = mock(async () => false);
    updateAgentStatusIndicators = mock(() => {});
    isSessionBusy = mock(() => false);
    sessionMessageSendInFlight = new Set();
  });

  test("resumeSession falls back to API lookup when local cache is stale", async () => {
    fetchSessionApi.mockResolvedValue({
      id: "session-1",
      name: "Recovered session",
    });

    const actions = buildActions();
    await actions.resumeSession("session-1");

    expect(fetchSessions).toHaveBeenCalledTimes(2);
    expect(fetchSessionApi).toHaveBeenCalledWith("session-1");
    expect(setCurrentRoute).toHaveBeenCalledWith("live");
    expect(setActiveSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ updateHistory: true, forceLog: true, allowPending: true }),
    );
    expect(fetchConversation).toHaveBeenCalledWith("session-1");
    expect(fetchLogs).toHaveBeenCalledWith("session-1");
    expect(showToast).not.toHaveBeenCalled();
  });

  test("resumeSession renders live view without waiting for conversation and logs", async () => {
    getSessionById = mock(() => ({ id: "session-1", name: "Ready session" }));
    let releaseConversation;
    let releaseLogs;
    fetchConversation = mock(
      () =>
        new Promise((resolve) => {
          releaseConversation = resolve;
        }),
    );
    fetchLogs = mock(
      () =>
        new Promise((resolve) => {
          releaseLogs = resolve;
        }),
    );

    const actions = buildActions();
    await actions.resumeSession("session-1");

    expect(setCurrentRoute).toHaveBeenCalledWith("live");
    expect(setActiveSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ updateHistory: true, forceLog: true, allowPending: false }),
    );
    expect(render).toHaveBeenCalled();

    releaseConversation?.();
    releaseLogs?.();
  });

  test("sendMessage queues the prompt after a busy direct-send rejection", async () => {
    sessions = [{ id: "session-1", status: "running", agentRuntimeStatus: "stable" }];
    state.messageDrafts.set("session-1", "Follow up");

    const busyError = new Error("Agent working");
    busyError.status = 409;
    postSessionMessageApi = mock(async () => {
      throw busyError;
    });
    addToPromptQueue = mock(async () => true);

    const actions = buildActions();
    const result = await actions.sendMessage("session-1", "Follow up");

    expect(postSessionMessageApi).toHaveBeenCalledWith("session-1", "Follow up", "user");
    expect(addToPromptQueue).toHaveBeenCalledWith("session-1", "Follow up");
    expect(updateAgentStatusIndicators).toHaveBeenCalled();
    expect(state.messageDrafts.get("session-1")).toBe("");
    expect(result).toEqual({ sent: false, queued: true, busy: true });
    expect(showToast).not.toHaveBeenCalledWith("Agent working", expect.anything());
  });

  test("sendMessage queues immediately when the session is already busy", async () => {
    sessions = [{ id: "session-1", status: "running", agentRuntimeStatus: "running" }];
    state.messageDrafts.set("session-1", "Queue this");
    isSessionBusy = mock(() => true);
    addToPromptQueue = mock(async () => true);

    const actions = buildActions();
    const result = await actions.sendMessage("session-1", "Queue this");

    expect(postSessionMessageApi).not.toHaveBeenCalled();
    expect(addToPromptQueue).toHaveBeenCalledWith("session-1", "Queue this");
    expect(updateAgentStatusIndicators).toHaveBeenCalled();
    expect(state.messageDrafts.get("session-1")).toBe("");
    expect(result).toEqual({ sent: false, queued: true, busy: true });
    expect(showToast).not.toHaveBeenCalledWith("Agent working", expect.anything());
  });

  test("sendMessage queues when another send is already in flight", async () => {
    sessions = [{ id: "session-1", status: "running", agentRuntimeStatus: "stable" }];
    state.messageDrafts.set("session-1", "Queue while pending");
    sessionMessageSendInFlight.add("session-1");
    addToPromptQueue = mock(async () => true);

    const actions = buildActions();
    const result = await actions.sendMessage("session-1", "Queue while pending");

    expect(postSessionMessageApi).not.toHaveBeenCalled();
    expect(addToPromptQueue).toHaveBeenCalledWith("session-1", "Queue while pending");
    expect(updateAgentStatusIndicators).toHaveBeenCalled();
    expect(state.messageDrafts.get("session-1")).toBe("");
    expect(result).toEqual({ sent: false, queued: true, busy: true });
    expect(showToast).not.toHaveBeenCalledWith("Agent working", expect.anything());
  });
});
