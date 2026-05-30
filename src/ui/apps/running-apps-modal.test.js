import { describe, expect, test } from "bun:test";

import { getRunningApps, isRunningApp } from "./running-apps-modal.js";

describe("running apps modal helpers", () => {
  test("identifies running apps from app status", () => {
    expect(isRunningApp({ status: { status: "running" } })).toBe(true);
    expect(isRunningApp({ status: { status: "idle" } })).toBe(false);
    expect(isRunningApp({})).toBe(false);
  });

  test("lists user apps that are currently running", () => {
    const apps = [
      { id: "wingman-core", status: { status: "running" } },
      { id: "web", status: { status: "running" } },
      { id: "worker", status: { status: "idle" } },
      { id: "deploy", status: { status: "running" } },
    ];

    expect(getRunningApps(apps).map((app) => app.id)).toEqual(["web", "deploy"]);
  });
});
