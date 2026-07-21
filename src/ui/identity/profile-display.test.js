import { describe, expect, test } from "bun:test";

import { getIdentityDisplayName } from "./profile-display.js";

describe("identity profile display", () => {
  test("prefers the Nostr profile name over the three-word alias", () => {
    expect(getIdentityDisplayName({ profileName: "Pete", alias: "honest-ivory-thicket" })).toBe("Pete");
  });

  test("uses the three-word alias when the Nostr profile has no name", () => {
    expect(getIdentityDisplayName({ profileName: null, alias: "honest-ivory-thicket" })).toBe("honest-ivory-thicket");
  });
});
