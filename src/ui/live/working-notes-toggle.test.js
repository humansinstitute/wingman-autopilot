import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

describe("working notes toggle integration", () => {
  test("exports and attaches the working notes double-click handler", () => {
    const indexSource = readFileSync(new URL("./index.js", import.meta.url), "utf8");
    const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    const toggleSource = readFileSync(new URL("./working-notes-toggle.js", import.meta.url), "utf8");

    expect(indexSource).toContain('export { attachWorkingNotesToggle } from "./working-notes-toggle.js";');
    expect(appSource).toContain("attachWorkingNotesToggle,");
    expect(appSource).toContain("attachWorkingNotesToggle();");
    expect(toggleSource).toContain("root.addEventListener('dblclick'");
    expect(toggleSource).toContain('.wm-message[data-role="agent-working"]');
  });
});
