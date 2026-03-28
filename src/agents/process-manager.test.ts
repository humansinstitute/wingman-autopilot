import { describe, expect, test } from "bun:test";

import { shouldCleanupMcpFiles, pm2StopShouldMarkStopped } from "./process-manager";

describe("pm2StopShouldMarkStopped", () => {
  test("returns true when PM2 process was successfully deleted", () => {
    expect(pm2StopShouldMarkStopped({ deletedFromPm2: true })).toBe(true);
  });

  test("returns false when PM2 delete failed and process is still present", () => {
    expect(pm2StopShouldMarkStopped({ deletedFromPm2: false })).toBe(false);
  });
});

describe("shouldCleanupMcpFiles", () => {
  test("skips cleanup while another active session shares the same file", () => {
    const sessions = [
      {
        id: "stopping-session",
        status: "running" as const,
        mcpCleanupFiles: ["/tmp/shared/.mcp.json"],
      },
      {
        id: "other-active-session",
        status: "running" as const,
        mcpCleanupFiles: ["/tmp/shared/.mcp.json"],
      },
    ];

    expect(
      shouldCleanupMcpFiles(sessions, "stopping-session", ["/tmp/shared/.mcp.json"]),
    ).toBe(false);
  });

  test("allows cleanup once only stopped sessions still reference the file", () => {
    const sessions = [
      {
        id: "stopping-session",
        status: "running" as const,
        mcpCleanupFiles: ["/tmp/shared/.mcp.json"],
      },
      {
        id: "already-stopped-session",
        status: "stopped" as const,
        mcpCleanupFiles: ["/tmp/shared/.mcp.json"],
      },
    ];

    expect(
      shouldCleanupMcpFiles(sessions, "stopping-session", ["/tmp/shared/.mcp.json"]),
    ).toBe(true);
  });
});
