import { describe, expect, test } from "bun:test";

import {
  canResumeNativeAgentSession,
} from "./native-session-resume.js";
import {
  DEFAULT_LIVE_SESSION_SORT,
  formatSessionDirectoryDisplay,
  formatSessionStartedAt,
  sortSessions,
  toggleSessionSort,
} from "./session-table.js";

describe("live agents helpers", () => {
  const sessions = [
    {
      id: "session-1",
      name: "Bravo",
      agent: "codex",
      status: "running",
      port: 3701,
      pid: 1111,
      startedAt: "2026-04-09T09:30:00.000Z",
      workingDirectory: "/tmp/bravo",
    },
    {
      id: "session-2",
      name: "Alpha",
      agent: "claude",
      status: "starting",
      port: 3700,
      pid: 2222,
      startedAt: "2026-04-10T09:30:00.000Z",
      workingDirectory: "/tmp/alpha",
    },
    {
      id: "session-3",
      name: "Charlie",
      agent: "goose",
      status: "stopped",
      port: 3702,
      pid: null,
      startedAt: "2026-04-08T09:30:00.000Z",
      workingDirectory: "/tmp/charlie",
    },
  ];

  const deps = {
    getSessionDisplayName: (session) => session.name,
    isSessionActive: (session) => session.status === "running" || session.status === "starting",
    defaultDirectory: "/tmp/default",
  };

  test("defaults to started descending", () => {
    const ordered = sortSessions(sessions, DEFAULT_LIVE_SESSION_SORT, deps);
    expect(ordered.map((session) => session.id)).toEqual([
      "session-2",
      "session-1",
      "session-3",
    ]);
  });

  test("sorts by name when requested", () => {
    const ordered = sortSessions(
      sessions,
      { key: "name", direction: "asc" },
      deps,
    );
    expect(ordered.map((session) => session.id)).toEqual([
      "session-2",
      "session-1",
      "session-3",
    ]);
  });

  test("toggles sort direction for the active column", () => {
    expect(toggleSessionSort(DEFAULT_LIVE_SESSION_SORT, "started")).toEqual({
      key: "started",
      direction: "asc",
    });
    expect(toggleSessionSort(DEFAULT_LIVE_SESSION_SORT, "name")).toEqual({
      key: "name",
      direction: "asc",
    });
  });

  test("formats started timestamps with date and time", () => {
    expect(formatSessionStartedAt("2026-04-10T09:30:00.000Z")).not.toBe("-");
    expect(formatSessionStartedAt("")).toBe("-");
    expect(formatSessionStartedAt("not-a-date")).toBe("-");
  });

  test("formats long directories from the end of the path", () => {
    expect(formatSessionDirectoryDisplay("/tmp/project")).toBe("/tmp/project");
    expect(formatSessionDirectoryDisplay("/Users/mini/code/wingmanbefree/autopilot", 32)).toBe(
      ".../code/wingmanbefree/autopilot",
    );
    expect(formatSessionDirectoryDisplay("/Users/mini/code/projects/really-long-project-name", 30)).toBe(
      ".../really-long-project-name",
    );
    expect(formatSessionDirectoryDisplay("")).toBe("-");
  });

  test("detects sessions with native agent resume metadata", () => {
    expect(canResumeNativeAgentSession({
      metadata: {
        nativeAgentSession: {
          agent: "codex",
          sessionId: "codex-session",
          workingDirectory: "/tmp/project",
        },
      },
    })).toBe(true);
    expect(canResumeNativeAgentSession({ metadata: {} })).toBe(false);
  });
});
