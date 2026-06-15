import { describe, expect, test } from "bun:test";

import { getSettingsPathForTab, getSettingsTabIdFromPath } from "./settings-routes.js";

const tabDefs = [
  { id: "profile" },
  { id: "workspace" },
  { id: "flightdeck" },
  { id: "agents" },
];

describe("settings route helpers", () => {
  test("resolves refreshable settings tab routes", () => {
    expect(getSettingsTabIdFromPath("/settings/workspace", tabDefs)).toBe("workspace");
    expect(getSettingsTabIdFromPath("/settings/flightdeck", tabDefs)).toBe("flightdeck");
    expect(getSettingsTabIdFromPath("/settings/flightdeck/sub-wingmen", tabDefs)).toBe("flightdeck");
    expect(getSettingsTabIdFromPath("/settings/agents", tabDefs)).toBe("agents");
  });

  test("keeps the old flight-deck route as a compatibility alias", () => {
    expect(getSettingsTabIdFromPath("/settings/flight-deck", tabDefs)).toBe("flightdeck");
  });

  test("builds canonical tab paths", () => {
    expect(getSettingsPathForTab("profile")).toBe("/settings");
    expect(getSettingsPathForTab("workspace")).toBe("/settings/workspace");
    expect(getSettingsPathForTab("flightdeck")).toBe("/settings/flightdeck");
    expect(getSettingsPathForTab("agents")).toBe("/settings/agents");
  });
});
