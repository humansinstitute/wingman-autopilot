import { describe, expect, test } from "bun:test";

import { shouldFullRenderOnSessionUpdate } from "./app-renderer.js";

describe("shouldFullRenderOnSessionUpdate", () => {
  test("skips full rerenders for files, live, and terminal routes", () => {
    expect(shouldFullRenderOnSessionUpdate("files")).toBe(false);
    expect(shouldFullRenderOnSessionUpdate("live")).toBe(false);
    expect(shouldFullRenderOnSessionUpdate("terminal")).toBe(false);
  });

  test("keeps full rerenders for other routes", () => {
    expect(shouldFullRenderOnSessionUpdate("home")).toBe(true);
    expect(shouldFullRenderOnSessionUpdate("settings")).toBe(true);
    expect(shouldFullRenderOnSessionUpdate("jobs")).toBe(true);
  });
});
