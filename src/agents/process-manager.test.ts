import { describe, expect, test } from "bun:test";

import { shouldCleanupMcpFiles } from "./process-manager";

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
