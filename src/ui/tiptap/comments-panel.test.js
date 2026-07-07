import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./comments-panel.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

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

  test("captures the selected anchor before the mobile comment form takes focus", () => {
    expect(source).toContain("onPrepareThread");
    expect(source).toContain("pendingThreadAnchor = onPrepareThread?.() ?? null;");
    expect(source).toContain("onAddThread?.(textarea.value, pendingThreadAnchor);");
  });

  test("renders mobile comments as a bounded bottom drawer", () => {
    const mobileRule = styles.match(/@media \(max-width: 768px\) \{[\s\S]+?\.wm-artifact-file-selector/);

    expect(mobileRule?.[0]).toContain("position: sticky;");
    expect(mobileRule?.[0]).toContain("bottom: 0;");
    expect(mobileRule?.[0]).toContain("max-height: min(46vh, 28rem);");
    expect(mobileRule?.[0]).toContain("max-height: 8rem;");
  });
});
