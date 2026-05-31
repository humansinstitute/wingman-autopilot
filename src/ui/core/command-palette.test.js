import { describe, expect, test } from "bun:test";

import {
  createCommandPaletteLaunchItems,
  createCommandPaletteQuickItems,
  filterCommandPaletteItems,
  getNextCommandPaletteActiveId,
  getRecentLaunchProjects,
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
      "0:Home",
      "1:Sessions",
      "2:Apps",
      "3:Pipelines",
      "4:Files",
    ]);
  });

  test("builds launch items with modal on 0 and recent projects on 1-9", () => {
    const projects = Array.from({ length: 11 }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      directoryPath: `/workspace/project-${index + 1}`,
    }));

    const items = createCommandPaletteLaunchItems(projects);

    expect(items.map((item) => `${item.shortcutKey}:${item.title}`)).toEqual([
      "0:New Session",
      "1:Project 1",
      "2:Project 2",
      "3:Project 3",
      "4:Project 4",
      "5:Project 5",
      "6:Project 6",
      "7:Project 7",
      "8:Project 8",
      "9:Project 9",
    ]);
    expect(items[0].action).toBe("open-session-modal");
    expect(items[1].action).toBe("launch-project-session");
    expect(items[9].targetId).toBe("project-9");
  });

  test("launch projects require an id and directory", () => {
    const projects = [
      { id: "missing-directory", name: "Missing Directory" },
      { directoryPath: "/workspace/missing-id", name: "Missing Id" },
      { id: "valid", name: "Valid", directoryPath: "/workspace/valid" },
    ];

    expect(getRecentLaunchProjects(projects)).toEqual([
      { id: "valid", name: "Valid", directoryPath: "/workspace/valid" },
    ]);
  });

  test("cycles active command ids with arrow navigation semantics", () => {
    const items = [
      { id: "home" },
      { id: "sessions" },
      { id: "apps" },
    ];

    expect(getNextCommandPaletteActiveId(items, "", 1)).toBe("home");
    expect(getNextCommandPaletteActiveId(items, "home", 1)).toBe("sessions");
    expect(getNextCommandPaletteActiveId(items, "apps", 1)).toBe("home");
    expect(getNextCommandPaletteActiveId(items, "", -1)).toBe("apps");
    expect(getNextCommandPaletteActiveId(items, "home", -1)).toBe("apps");
  });
});
