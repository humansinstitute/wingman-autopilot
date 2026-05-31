import { describe, expect, test } from "bun:test";

import {
  buildFilesRoutePath,
  sortFileBrowserEntries,
} from "./file-browser-modal.js";

describe("command file browser modal helpers", () => {
  test("builds encoded Files route paths from docs-relative paths", () => {
    expect(buildFilesRoutePath("notes/report.md")).toBe("/files/notes/report.md");
    expect(buildFilesRoutePath("Agent Work/final notes.md")).toBe("/files/Agent%20Work/final%20notes.md");
    expect(buildFilesRoutePath("")).toBe("/files");
  });

  test("sorts directories before files using natural names", () => {
    const entries = [
      { type: "file", name: "file-10.md" },
      { type: "directory", name: "zeta" },
      { type: "file", name: "file-2.md" },
      { type: "directory", name: "alpha" },
    ];

    expect(sortFileBrowserEntries(entries).map((entry) => entry.name)).toEqual([
      "alpha",
      "zeta",
      "file-2.md",
      "file-10.md",
    ]);
  });
});
