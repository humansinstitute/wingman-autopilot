import { describe, expect, test } from "bun:test";

import {
  addPinnedFileForSession,
  clearWriterDismissal,
  getPinnedFilePageForSession,
  getPinnedFileForSession,
  markWriterDismissed,
  setPinnedFilePageForSession,
  shouldAutoOpenWriter,
  syncPinnedFileForSession,
} from "./writer-panel-state.js";

function createState() {
  return {
    writerLayout: { open: false },
    pinnedFiles: new Map(),
    pinnedFileLists: new Map(),
    pinnedFileIndexes: new Map(),
    writerDismissedFiles: new Map(),
  };
}

describe("writer-panel-state", () => {
  test("keeps a server-pinned artifact available while the panel is closed", () => {
    const state = createState();

    syncPinnedFileForSession(state, "session-1", "/tmp/spec.md");
    markWriterDismissed(state, "session-1", "/tmp/spec.md");

    expect(getPinnedFileForSession(state, "session-1", "/tmp/spec.md")).toBe("/tmp/spec.md");
    expect(shouldAutoOpenWriter(state, "session-1", "/tmp/spec.md")).toBe(false);
  });

  test("auto-opens again when the effective file changes", () => {
    const state = createState();

    markWriterDismissed(state, "session-1", "/tmp/spec.md");

    expect(shouldAutoOpenWriter(state, "session-1", "/tmp/updated-spec.md")).toBe(true);
  });

  test("clears dismissal state when the user explicitly reopens the writer", () => {
    const state = createState();

    markWriterDismissed(state, "session-1", "/tmp/spec.md");
    clearWriterDismissal(state, "session-1");

    expect(shouldAutoOpenWriter(state, "session-1", "/tmp/spec.md")).toBe(true);
  });

  test("keeps multiple pinned files scoped to a session and exposes the active page", () => {
    const state = createState();

    addPinnedFileForSession(state, "session-1", "/tmp/spec.md");
    addPinnedFileForSession(state, "session-1", "/tmp/notes.md");
    addPinnedFileForSession(state, "session-2", "/tmp/other.md");

    expect(getPinnedFilePageForSession(state, "session-1")).toEqual({
      files: ["/tmp/spec.md", "/tmp/notes.md"],
      activeIndex: 1,
      activeFile: "/tmp/notes.md",
    });
    expect(getPinnedFileForSession(state, "session-2")).toBe("/tmp/other.md");

    setPinnedFilePageForSession(state, "session-1", 0);

    expect(getPinnedFilePageForSession(state, "session-1")).toEqual({
      files: ["/tmp/spec.md", "/tmp/notes.md"],
      activeIndex: 0,
      activeFile: "/tmp/spec.md",
    });
    expect(state.pinnedFiles.get("session-1")).toBe("/tmp/spec.md");
  });

  test("server sync does not reset the active pinned page after paging", () => {
    const state = createState();

    addPinnedFileForSession(state, "session-1", "/tmp/spec.md");
    addPinnedFileForSession(state, "session-1", "/tmp/notes.md");
    setPinnedFilePageForSession(state, "session-1", 0);
    syncPinnedFileForSession(state, "session-1", "/tmp/notes.md");

    expect(getPinnedFilePageForSession(state, "session-1")).toEqual({
      files: ["/tmp/spec.md", "/tmp/notes.md"],
      activeIndex: 0,
      activeFile: "/tmp/spec.md",
    });
  });
});
