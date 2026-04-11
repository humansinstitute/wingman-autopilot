import { describe, expect, test } from "bun:test";

import {
  filterNightWatchReportsForSession,
  getLiveDrawerMode,
  getSessionDrawerRelatedRecords,
  isLiveDrawerVisible,
} from "./session-drawer.js";

describe("session-drawer", () => {
  test("uses desktop mode above the mobile breakpoint", () => {
    expect(getLiveDrawerMode(1024)).toBe("desktop");
    expect(getLiveDrawerMode(640)).toBe("mobile");
  });

  test("shows the drawer by default on desktop until the user toggles it", () => {
    expect(isLiveDrawerVisible({}, 1280)).toBe(true);
    expect(isLiveDrawerVisible({ userToggled: true, open: false }, 1280)).toBe(false);
    expect(isLiveDrawerVisible({ userToggled: true, open: true }, 1280)).toBe(true);
    expect(isLiveDrawerVisible({ open: false }, 640)).toBe(false);
    expect(isLiveDrawerVisible({ open: true }, 640)).toBe(true);
  });

  test("extracts related record ids from session metadata", () => {
    expect(getSessionDrawerRelatedRecords({
      metadata: {
        project: "wingman-fd",
        bindingType: "task",
        bindingId: "task-1",
        flowId: "flow-1",
        flowRunId: "run-1",
        taskIds: ["task-1", "task-2"],
      },
    })).toEqual({
      project: "wingman-fd",
      bindingType: "task",
      bindingId: "task-1",
      flowId: "flow-1",
      flowRunId: "run-1",
      taskIds: ["task-1", "task-2"],
    });
  });

  test("filters Night Watch reports to the current session and sorts newest first", () => {
    expect(filterNightWatchReportsForSession([
      { id: "report-1", sessionId: "session-1", createdAt: "2025-01-01T00:00:00.000Z" },
      { id: "report-2", session_id: "session-1", created_at: "2025-01-02T00:00:00.000Z" },
      { id: "report-3", session: { id: "session-2" }, createdAt: "2025-01-03T00:00:00.000Z" },
    ], "session-1").map((report) => report.id)).toEqual(["report-2", "report-1"]);
  });
});
