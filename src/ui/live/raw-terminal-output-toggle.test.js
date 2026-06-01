import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./raw-terminal-output-toggle.js", import.meta.url), "utf8");

describe("raw terminal output toggle", () => {
  test("uses accessible labels for visible and hidden states", () => {
    expect(source).toContain('visible ? "Hide raw terminal output" : "Show raw terminal output"');
    expect(source).toContain('button.setAttribute("aria-pressed", visible ? "true" : "false")');
    expect(source).toContain('button.setAttribute("data-testid", "live-raw-terminal-output-toggle")');
  });

  test("renders a terminal-style icon", () => {
    expect(source).toContain('shape.setAttribute("stroke", "currentColor")');
    expect(source).toContain('["path", { d: "M8 10l3 2-3 2" }]');
  });
});
