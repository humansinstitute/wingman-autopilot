import { describe, expect, test } from "bun:test";

import { buildSessionFilterOptions } from "./runtime-sync.js";

describe("buildSessionFilterOptions", () => {
  test("prepends the viewer option for admins and preserves session metadata", () => {
    const options = buildSessionFilterOptions({
      isAdmin: true,
      viewerNpub: "npub1viewer",
      filterOptions: [
        { value: "npub1viewer", npub: "npub1viewer", label: "Viewer", sessionCount: 2, activeCount: 1 },
        { value: "npub1other", npub: "npub1other", label: "Alice", sessionCount: 5, activeCount: 0 },
      ],
      abbreviateNpub: (value) => `abbr:${value.slice(0, 8)}`,
    });

    expect(options).toEqual([
      { value: "npub1viewer", label: "My identity (abbr:npub1vie)", npub: "npub1viewer" },
      { value: "all", label: "All identities" },
      {
        value: "npub1other",
        label: "Alice • 5 sessions",
        npub: "npub1other",
        sessionCount: 5,
        activeCount: 0,
      },
    ]);
  });

  test("falls back to anonymous labels when option metadata is sparse", () => {
    const options = buildSessionFilterOptions({
      isAdmin: false,
      viewerNpub: null,
      filterOptions: [{ value: "__anonymous__", sessionCount: 1, activeCount: 1 }],
      abbreviateNpub: (value) => value,
    });

    expect(options).toEqual([
      { value: "all", label: "All identities" },
      {
        value: "__anonymous__",
        label: "Anonymous • 1 sessions (1 active)",
        npub: null,
        sessionCount: 1,
        activeCount: 1,
      },
    ]);
  });
});
