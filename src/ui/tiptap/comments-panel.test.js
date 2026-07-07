import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./comments-panel.js", import.meta.url), "utf8");

describe("comments-panel mobile ergonomics", () => {
  test("keeps comment and reply textareas collapsed until explicitly opened", () => {
    expect(source).toContain("body.hidden = !defaultOpen;");
    expect(source).toContain("form.hidden = true;");
    expect(source).toContain("replyForm.hidden = true;");
  });

  test("does not auto-focus textareas when disclosure buttons are tapped", () => {
    expect(source).not.toContain(".focus()");
  });

  test("supports image upload and markdown rendering for comment bodies", () => {
    expect(source).toContain("uploadPastedImage");
    expect(source).toContain("renderMarkdownToHtml");
    expect(source).toContain("![${savedName}](${savedName})");
  });
});
