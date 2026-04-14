import { describe, expect, test } from "bun:test";

import {
  createLiveSessionDrawer,
  filterNightWatchReportsForSession,
  getLiveDrawerMode,
  getSessionDrawerRelatedRecords,
  isLiveDrawerVisible,
} from "./session-drawer.js";

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || "").toLowerCase();
    this.className = "";
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.rows = 0;
    this.disabled = false;
    this.spellcheck = true;
    this.type = "";
  }

  append(...children) {
    this.children.push(...children.filter(Boolean));
  }

  addEventListener(type, callback) {
    const existing = this.listeners.get(type) || [];
    existing.push(callback);
    this.listeners.set(type, existing);
  }

  setAttribute(name, value) {
    const normalized = String(name || "");
    const stringValue = String(value ?? "");
    this.attributes[normalized] = stringValue;
    if (normalized === "data-testid") {
      this.dataset.testid = stringValue;
    }
  }

  get childElementCount() {
    return this.children.filter((child) => child instanceof FakeElement).length;
  }
}

function withFakeDocument(run) {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement(tagName) {
      return new FakeElement(tagName);
    },
  };

  try {
    return run();
  } finally {
    globalThis.document = originalDocument;
  }
}

function collectText(node) {
  if (!node) return "";
  const parts = [];
  if (typeof node.innerHTML === "string" && node.innerHTML) {
    parts.push(node.innerHTML);
  }
  if (typeof node.textContent === "string" && node.textContent) {
    parts.push(node.textContent);
  }
  if (Array.isArray(node.children)) {
    node.children.forEach((child) => {
      if (child instanceof FakeElement) {
        parts.push(collectText(child));
      } else if (typeof child === "string") {
        parts.push(child);
      }
    });
  }
  return parts.join(" ");
}

function queryAllByClass(node, className) {
  const matches = [];
  if (!node) return matches;
  const classes = String(node.className || "").split(/\s+/).filter(Boolean);
  if (classes.includes(className)) {
    matches.push(node);
  }
  if (Array.isArray(node.children)) {
    node.children.forEach((child) => {
      if (child instanceof FakeElement) {
        matches.push(...queryAllByClass(child, className));
      }
    });
  }
  return matches;
}

function queryByTestId(node, testId) {
  if (!node) return null;
  if (node instanceof FakeElement && node.dataset?.testid === testId) {
    return node;
  }
  if (!Array.isArray(node.children)) return null;
  for (const child of node.children) {
    if (child instanceof FakeElement) {
      const match = queryByTestId(child, testId);
      if (match) return match;
    }
  }
  return null;
}

function createDrawerState({ enabled = false, reports = [], reportsError = null } = {}) {
  return {
    liveDrawer: {
      open: true,
      userToggled: true,
      reportModalOpen: false,
      selectedReportId: "",
      reportsError,
      saving: false,
      goalDrafts: new Map(),
      nextActionPayloadDrafts: new Map(),
    },
    nightwatch: {
      reportsLoading: false,
      reportsInitialized: true,
      reports,
      sessionToggles: new Map([["session-1", { enabled }]]),
    },
  };
}

describe("session-drawer", () => {
  test("uses desktop mode above the mobile breakpoint", () => {
    expect(getLiveDrawerMode(1024)).toBe("desktop");
    expect(getLiveDrawerMode(640)).toBe("mobile");
  });

  test("shows the drawer only when explicitly opened", () => {
    expect(isLiveDrawerVisible({}, 1280)).toBe(false);
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

  test("renders desktop drawer metadata, related records, and a bounded Night Watch history preview", () => {
    withFakeDocument(() => {
      const state = {
        liveDrawer: {
          open: true,
          userToggled: false,
          reportModalOpen: false,
          selectedReportId: "",
          reportsError: null,
          saving: false,
          goalDrafts: new Map(),
          nextActionPayloadDrafts: new Map(),
        },
        nightwatch: {
          reportsLoading: false,
          reportsInitialized: true,
          reports: [
            { id: "report-1", sessionId: "session-1", createdAt: "2026-04-11T03:00:00.000Z", status: "ok", summary: "summary one" },
            { id: "report-2", sessionId: "session-1", createdAt: "2026-04-11T03:01:00.000Z", status: "ok", summary: "summary two" },
            { id: "report-3", sessionId: "session-1", createdAt: "2026-04-11T03:02:00.000Z", status: "ok", summary: "summary three" },
            { id: "report-4", sessionId: "session-1", createdAt: "2026-04-11T03:03:00.000Z", status: "ok", summary: "summary four" },
            { id: "report-5", sessionId: "session-1", createdAt: "2026-04-11T03:04:00.000Z", status: "ok", summary: "summary five" },
            { id: "report-6", sessionId: "session-1", createdAt: "2026-04-11T03:05:00.000Z", status: "ok", summary: "summary six" },
            { id: "report-other", sessionId: "session-2", createdAt: "2026-04-11T03:06:00.000Z", status: "ok", summary: "other session" },
          ],
          sessionToggles: new Map([["session-1", { enabled: true }]]),
        },
      };
      const session = {
        id: "session-1",
        name: "Drawer Test",
        metadata: {
          goal: "Ship the drawer",
          nextActionPayload: "Prepare review note",
          project: "wingmen",
          bindingType: "task",
          bindingId: "task-1",
          flowId: "flow-1",
          flowRunId: "run-1",
          taskIds: ["task-1", "task-2"],
        },
      };

      const result = createLiveSessionDrawer({
        session,
        state,
        showToast: () => {},
        render: () => {},
        viewportWidth: 1280,
      });

      expect(result.mode).toBe("desktop");
      expect(result.visible).toBe(true);
      expect(result.backdrop).toBeNull();
      expect(result.modal).toBeNull();
      expect(queryByTestId(result.aside, "live-session-drawer")).not.toBeNull();
      expect(queryByTestId(result.aside, "live-drawer-goal-input")?.value).toBe("Ship the drawer");
      expect(queryByTestId(result.aside, "live-drawer-next-action-input")?.value).toBe("Prepare review note");
      expect(collectText(result.aside)).toContain("Disable Night Watch");
      expect(collectText(result.aside)).toContain("Binding (task)");
      expect(collectText(result.aside)).toContain("flow-1");
      const reportRows = queryAllByClass(result.aside, "wm-live-drawer__report-row").map(collectText);
      expect(reportRows).toHaveLength(5);
      expect(reportRows.join(" ")).toContain("summary six");
      expect(reportRows.join(" ")).toContain("summary two");
      expect(reportRows.join(" ")).not.toContain("summary one");
      expect(reportRows.join(" ")).not.toContain("other session");
    });
  });

  test("renders distinct unavailable and empty history states", () => {
    withFakeDocument(() => {
      const session = { id: "session-1", name: "Drawer Test", metadata: {} };

      const emptyResult = createLiveSessionDrawer({
        session,
        state: createDrawerState(),
        showToast: () => {},
        render: () => {},
        viewportWidth: 640,
      });
      expect(emptyResult.mode).toBe("mobile");
      expect(emptyResult.backdrop).not.toBeNull();
      expect(collectText(emptyResult.aside)).toContain("No Night Watch reports for this session yet.");

      const unavailableResult = createLiveSessionDrawer({
        session,
        state: createDrawerState({ reportsError: "boom" }),
        showToast: () => {},
        render: () => {},
        viewportWidth: 640,
      });
      expect(collectText(unavailableResult.aside)).toContain("Night Watch history is currently unavailable.");
    });
  });

  test("renders a report modal with reasoning and input details when selected", () => {
    withFakeDocument(() => {
      const state = {
        liveDrawer: {
          open: true,
          userToggled: true,
          reportModalOpen: true,
          selectedReportId: "report-1",
          reportsError: null,
          saving: false,
          goalDrafts: new Map(),
          nextActionPayloadDrafts: new Map(),
        },
        nightwatch: {
          reportsLoading: false,
          reportsInitialized: true,
          reports: [{
            id: "report-1",
            sessionId: "session-1",
            sessionName: "Drawer Test",
            createdAt: "2026-04-11T03:00:00.000Z",
            status: "warning",
            summary: "Needs review",
            reasoning: "Because context drifted.",
            inputRaw: "What changed?",
            cycleCount: 7,
          }],
          sessionToggles: new Map([["session-1", { enabled: true }]]),
        },
      };

      const result = createLiveSessionDrawer({
        session: { id: "session-1", name: "Drawer Test", metadata: {} },
        state,
        showToast: () => {},
        render: () => {},
        viewportWidth: 640,
      });

      expect(result.modal).not.toBeNull();
      expect(collectText(result.modal)).toContain("Drawer Test");
      expect(collectText(result.modal)).toContain("Summary");
      expect(collectText(result.modal)).toContain("Reasoning");
      expect(collectText(result.modal)).toContain("Because context drifted.");
      expect(collectText(result.modal)).toContain("Input");
      expect(collectText(result.modal)).toContain("What changed?");
      expect(collectText(result.modal)).toContain("Cycle 7");
    });
  });
});
