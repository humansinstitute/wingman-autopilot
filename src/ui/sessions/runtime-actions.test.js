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

  const buildActions = () =>
    createSessionRuntimeActions({
      state: { messageDrafts: new Map() },
      sessionsStore: () => ({ items: [] }),
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
      postSessionMessageApi: mock(async () => ({})),
      updateIdentityState: mock(() => {}),
      isSessionBusy: () => false,
      addToPromptQueue: mock(async () => false),
      updateAgentStatusIndicators: mock(() => {}),
      renderConversationForSession: mock(async () => {}),
      scrollPillHide: mock(() => {}),
      scrollConversationAreaToBottom: mock(() => {}),
      sessionMessageSendInFlight: new Set(),
      focusComposerTextarea: mock(() => {}),
      isAlpineChatEnabled: () => false,
      MessageStore: { syncFromServer: mock(async () => {}), syncFromServerIfChanged: mock(async () => ({ changed: false })) },
      prepareVoiceNoteDraftForSend: mock(async (value) => value),
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
});
