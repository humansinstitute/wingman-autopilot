import { describe, expect, test } from "bun:test";

import {
  createCommandPaletteQuickItems,
  filterCommandPaletteItems,
  rememberRecentItem,
} from "./command-palette-utils.js";

describe("autopilot command palette helpers", () => {
  test("keeps recent items newest first and unique", () => {
    const items = rememberRecentItem(
      [
        { id: "a", title: "Alpha" },
        { id: "b", title: "Beta" },
      ],
      { id: "b", title: "Beta updated", updatedAt: "2026-05-30T00:00:00.000Z" },
    );

    expect(items.map((item) => item.id)).toEqual(["b", "a"]);
    expect(items[0].title).toBe("Beta updated");
  });

  test("filters commands across title subtitle group and search text", () => {
    const items = [
      { title: "New Session", subtitle: "Launch an agent", groupLabel: "Shortcuts" },
      { title: "App restart", subtitle: "Calendar", groupLabel: "Recent App Restarts" },
      { title: "Pipeline", subtitle: "Review", searchText: "workflow run" },
    ];

    expect(filterCommandPaletteItems(items, "agent").map((item) => item.title)).toEqual(["New Session"]);
    expect(filterCommandPaletteItems(items, "recent app").map((item) => item.title)).toEqual(["App restart"]);
    expect(filterCommandPaletteItems(items, "workflow").map((item) => item.title)).toEqual(["Pipeline"]);
  });

  test("keeps fixed shortcut keys stable and adds home", () => {
    expect(createCommandPaletteQuickItems().map((item) => `${item.shortcutKey}:${item.title}`)).toEqual([
      "1:New Session",
      "2:Running Apps",
      "3:Running Pipelines",
      "4:Home",
    ]);
  });
});
