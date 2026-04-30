import { describe, expect, test } from "bun:test";

import { renderJsonBlock } from "./view-utils.js";

describe("pipeline JSON rendering", () => {
  test("renders objects as expandable tree nodes", () => {
    const html = renderJsonBlock("Input", {
      prompt: "Review this",
      nested: { status: "ok" },
      items: [1, 2],
    });

    expect(html).toContain('data-testid="pipeline-json-tree"');
    expect(html).toContain("wm-pipeline-json-branch");
    expect(html).toContain("nested");
    expect(html).toContain("2 items");
    expect(html).not.toContain("<pre>");
  });

  test("renders multiline strings as numbered text lines", () => {
    const html = renderJsonBlock("Output", {
      content: "first line\nsecond line",
    });

    expect(html).toContain("wm-pipeline-json-text");
    expect(html).toContain('data-lines="2"');
    expect(html).toContain("first line");
    expect(html).toContain("second line");
  });
});
