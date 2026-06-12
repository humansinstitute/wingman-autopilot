import { beforeEach, describe, expect, mock, test } from "bun:test";

const syncMock = mock(async () => {});
const removeMock = mock(async () => {});
const stopSessionApiMock = mock(async () => ({ success: true }));
const deleteSessionApiMock = mock(async () => ({ success: true }));
const updateSessionNameApiMock = mock(async () => ({ id: "session-1", name: "Renamed" }));

mock.module("/vendor/alpinejs/module.esm.js", () => ({
  default: {
    store(name) {
      if (name !== "sessions") {
        throw new Error(`Unexpected store lookup: ${name}`);
      }
      return { sync: syncMock };
    },
  },
}));

mock.module("../live/db.js", () => ({
  ApiSessionStore: {
    remove: removeMock,
  },
}));

mock.module("../services/sessions.js", () => ({
  stopSessionApi: stopSessionApiMock,
  deleteSessionApi: deleteSessionApiMock,
  updateSessionNameApi: updateSessionNameApiMock,
  resumeNativeSessionApi: mock(async () => ({})),
  forkSessionToWorktreeApi: mock(async () => ({})),
}));

const {
  stopSession,
  deleteSession,
  renameSession,
} = await import("./actions.js");

describe("session actions", () => {
  beforeEach(() => {
    syncMock.mockClear();
    removeMock.mockClear();
    stopSessionApiMock.mockClear();
    deleteSessionApiMock.mockClear();
    updateSessionNameApiMock.mockClear();
  });

  test("stopSession syncs the sessions store after a successful stop", async () => {
    const result = await stopSession("session-1");

    expect(stopSessionApiMock).toHaveBeenCalledWith("session-1");
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true });
  });

  test("deleteSession removes cached session data and syncs after success", async () => {
    const result = await deleteSession("session-2");

    expect(deleteSessionApiMock).toHaveBeenCalledWith("session-2");
    expect(removeMock).toHaveBeenCalledWith("session-2");
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true });
  });

  test("renameSession syncs the sessions store after updating details", async () => {
    const result = await renameSession("session-1", "Renamed", 2);

    expect(updateSessionNameApiMock).toHaveBeenCalledWith("session-1", "Renamed", 2);
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: "session-1", name: "Renamed" });
  });
});
