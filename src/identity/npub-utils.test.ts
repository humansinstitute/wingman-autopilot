import { describe, expect, test } from "bun:test";

import { normaliseNpubList } from "./npub-utils";

describe("normaliseNpubList", () => {
  test("parses comma-separated npubs and removes duplicates", () => {
    expect(normaliseNpubList(" npub1admin , npub1second , npub1admin ")).toEqual([
      "npub1admin",
      "npub1second",
    ]);
  });
});
