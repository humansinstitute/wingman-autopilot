import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./tiptap-file-panel.js", import.meta.url), "utf8");

describe("tiptap-file-panel comments", () => {
  test("wires selected comment threads to document highlighting", () => {
    expect(source).toContain("highlightCommentAnchor");
    expect(source).toContain("markActiveCommentThread");
    expect(source).toContain("onSelectThread: selectCommentThread");
    expect(source).toContain("activeThreadId: activeCommentThreadId");
  });
});
