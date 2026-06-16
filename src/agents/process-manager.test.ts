import { describe, expect, test } from "bun:test";

import {
  ProcessManager,
  normalizeAgentModelOverride,
  shouldCleanupMcpFiles,
  pm2StopShouldMarkStopped,
} from "./process-manager";
import type { WingmanConfig } from "../config";

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

describe("normalizeAgentModelOverride", () => {
  test("treats default as no model override", () => {
    expect(normalizeAgentModelOverride(undefined)).toBe("");
    expect(normalizeAgentModelOverride("")).toBe("");
    expect(normalizeAgentModelOverride(" default ")).toBe("");
    expect(normalizeAgentModelOverride("Default")).toBe("");
  });

  test("keeps explicit model overrides", () => {
    expect(normalizeAgentModelOverride("gpt-5.5")).toBe("gpt-5.5");
  });
});

describe("ProcessManager pinned files", () => {
  test("keeps a session-scoped pinned file history", () => {
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agents: {
        codex: {
          label: "Codex",
          command: ({ port }) => ["agentapi", "--port", String(port), "--", "codex"],
        },
      },
    } as WingmanConfig);

    manager.rehydrateSession({
      id: "session-1",
      agent: "codex",
      port: 3700,
      name: "Session 1",
      startedAt: new Date("2026-06-01T00:00:00.000Z").toISOString(),
      workingDirectory: "/tmp",
      pinnedFile: "/tmp/old.md",
      metadata: { AGENT: true, pinnedFiles: ["/tmp/old.md"] },
    });

    manager.setPinnedFile("session-1", "/tmp/new.md");
    manager.setPinnedFile("session-1", " /tmp/old.md ");
    const snapshot = manager.removePinnedFile("session-1", "/tmp/old.md");

    expect(snapshot?.pinnedFile).toBe("/tmp/new.md");
    expect(snapshot?.metadata?.pinnedFiles).toEqual(["/tmp/new.md"]);
  });

  test("replaces pinned file history with the client ordered list", () => {
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agents: {
        codex: {
          label: "Codex",
          command: ({ port }) => ["agentapi", "--port", String(port), "--", "codex"],
        },
      },
    } as WingmanConfig);

    manager.rehydrateSession({
      id: "session-1",
      agent: "codex",
      port: 3700,
      name: "Session 1",
      startedAt: new Date("2026-06-01T00:00:00.000Z").toISOString(),
      workingDirectory: "/tmp",
      pinnedFile: "/tmp/two.md",
      metadata: { AGENT: true, pinnedFiles: ["/tmp/one.md", "/tmp/two.md", "/tmp/three.md"] },
    });

    const snapshot = manager.setPinnedFiles(
      "session-1",
      ["/tmp/one.md", "/tmp/three.md", "/tmp/one.md"],
      "/tmp/three.md",
    );

    expect(snapshot?.pinnedFile).toBe("/tmp/three.md");
    expect(snapshot?.metadata?.pinnedFiles).toEqual(["/tmp/one.md", "/tmp/three.md"]);
  });

  test("emits an artifact open intent when a file is pinned", () => {
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agents: {
        codex: {
          label: "Codex",
          command: ({ port }) => ["agentapi", "--port", String(port), "--", "codex"],
        },
      },
    } as WingmanConfig);

    manager.rehydrateSession({
      id: "session-1",
      agent: "codex",
      port: 3700,
      name: "Session 1",
      startedAt: new Date("2026-06-01T00:00:00.000Z").toISOString(),
      workingDirectory: "/tmp",
      pinnedFile: "/tmp/old.md",
      metadata: { AGENT: true, pinnedFiles: ["/tmp/old.md"] },
    });

    const events: unknown[] = [];
    manager.on((event) => {
      events.push(event);
    });

    manager.setPinnedFile("session-1", "/tmp/new.md");

    expect(events.at(-1)).toMatchObject({
      type: "session-updated",
      artifactIntent: {
        action: "open",
        filePath: "/tmp/new.md",
        pinnedFiles: ["/tmp/old.md", "/tmp/new.md"],
      },
    });
  });
});
