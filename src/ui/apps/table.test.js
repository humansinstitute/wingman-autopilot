import { describe, expect, test } from "bun:test";

import {
  getAppDisplayName,
  getAppOpenUrl,
  getAppStatusValue,
  getAppTypeLabel,
} from "./table.js";

describe("apps table helpers", () => {
  test("summarizes app identity and state for table rows", () => {
    const app = {
      id: "demo-app",
      label: "Demo App",
      webApp: true,
      subdomainUrl: "/host/demo",
      status: { status: "running" },
    };

    expect(getAppDisplayName(app)).toBe("Demo App");
    expect(getAppStatusValue(app)).toBe("running");
    expect(getAppTypeLabel(app)).toBe("Web");
    expect(getAppOpenUrl(app)).toBe("/host/demo");
  });

  test("falls back when optional app fields are missing", () => {
    expect(getAppDisplayName({ id: "worker" })).toBe("worker");
    expect(getAppStatusValue({})).toBe("idle");
    expect(getAppTypeLabel({ webApp: false })).toBe("Process");
    expect(getAppOpenUrl({ webAppUrl: "http://localhost:3700" })).toBe("http://localhost:3700");
  });
});
