import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./terminal-view.js", import.meta.url), "utf8");

describe("terminal-view composition", () => {
  test("masks the PIN placeholder instead of showing the default PIN", () => {
    expect(source).toContain('pinInput.placeholder = "*****";');
    expect(source).not.toContain('pinInput.placeholder = "44444";');
  });
});
