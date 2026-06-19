import { describe, expect, test } from "bun:test";

import {
  DOCS_ROUTE_PREFIX,
  buildFilesPreviewRoutePath,
  getFilesRoutePrefixForPath,
  getFilesSurfaceFromPath,
} from "./route-url.js";

describe("buildFilesPreviewRoutePath", () => {
  test("preserves absolute file paths for the Files preview route", () => {
    expect(buildFilesPreviewRoutePath("/Users/mini/code/report.md"))
      .toBe("/files/%2FUsers%2Fmini%2Fcode%2Freport.md");
  });

  test("builds a route for a relative file path", () => {
    expect(buildFilesPreviewRoutePath("notes/report.md")).toBe("/files/notes%2Freport.md");
  });

  test("can build Docs preview routes with the shared file browser", () => {
    expect(buildFilesPreviewRoutePath("notes/report.md", { routePrefix: DOCS_ROUTE_PREFIX }))
      .toBe("/docs/notes%2Freport.md");
  });
});

describe("files route surface helpers", () => {
  test("detects Docs paths", () => {
    expect(getFilesSurfaceFromPath("/docs")).toBe("docs");
    expect(getFilesSurfaceFromPath("/docs/guide.md")).toBe("docs");
    expect(getFilesRoutePrefixForPath("/docs/guide.md")).toBe("/docs");
  });

  test("defaults to Files paths", () => {
    expect(getFilesSurfaceFromPath("/files")).toBe("files");
    expect(getFilesSurfaceFromPath("/files/readme.md")).toBe("files");
    expect(getFilesRoutePrefixForPath("/files/readme.md")).toBe("/files");
  });
});
