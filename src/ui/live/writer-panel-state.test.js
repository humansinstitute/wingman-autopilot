import { describe, expect, test } from "bun:test";

import {
  clearWriterDismissal,
  getPinnedFileForSession,
  markWriterDismissed,
  shouldAutoOpenWriter,
  syncPinnedFileForSession,
} from "./writer-panel-state.js";

function createState() {
  return {
    writerLayout: { open: false },
    pinnedFiles: new Map(),
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
});
