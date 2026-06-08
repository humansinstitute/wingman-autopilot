import { describe, expect, test } from "bun:test";

import { buildFilesPreviewRoutePath } from "./route-url.js";

describe("buildFilesPreviewRoutePath", () => {
  test("preserves absolute file paths for the Files preview route", () => {
    expect(buildFilesPreviewRoutePath("/Users/mini/code/report.md"))
      .toBe("/files/%2FUsers%2Fmini%2Fcode%2Freport.md");
  });

  test("builds a route for a relative file path", () => {
    expect(buildFilesPreviewRoutePath("notes/report.md")).toBe("/files/notes%2Freport.md");
  });
});
