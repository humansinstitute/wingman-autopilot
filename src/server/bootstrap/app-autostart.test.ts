import { describe, expect, test } from "bun:test";

import type { AppRecord } from "../../apps/app-registry";
import type { AppProcessStatus } from "../../apps/app-process-manager";
import { autostartApps } from "./app-autostart";

function app(overrides: Partial<AppRecord>): AppRecord {
  return {
    id: overrides.id ?? "app-1",
    label: overrides.label ?? "Test App",
    root: overrides.root ?? "/tmp/test-app",
    scripts: overrides.scripts ?? { start: "bun run start" },
    tmuxSession: overrides.tmuxSession ?? "test-app",
    pm2Name: overrides.pm2Name,
    logsDir: overrides.logsDir,
    notes: overrides.notes,
    ownerNpub: overrides.ownerNpub ?? null,
    autoStart: overrides.autoStart ?? false,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    webApp: overrides.webApp ?? false,
    webAppPort: overrides.webAppPort ?? null,
  };
}

function status(overrides: Partial<AppProcessStatus>): AppProcessStatus {
  return {
    appId: overrides.appId ?? "app-1",
    status: overrides.status ?? "idle",
    lastAction: overrides.lastAction ?? null,
    lastExitCode: overrides.lastExitCode ?? null,
    message: overrides.message,
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    lastSuccessAt: overrides.lastSuccessAt,
    lastFailureAt: overrides.lastFailureAt,
    running: overrides.running ?? false,
    inProgressAction: overrides.inProgressAction ?? null,
    runtimePort: overrides.runtimePort,
    pid: overrides.pid,
    memory: overrides.memory,
  };
}

describe("autostartApps", () => {
  test("restarts stopped apps marked for autostart", async () => {
    const restarted: string[] = [];
    const result = await autostartApps(
      {
        listApps: async () => [
          app({ id: "auto", label: "Auto", autoStart: true }),
          app({ id: "manual", label: "Manual", autoStart: false }),
        ],
      },
      {
        getStatus: async (appId) => status({ appId, running: false }),
        restart: async (appId) => {
          restarted.push(appId);
          return status({ appId, status: "running", running: true });
        },
      },
      { log: () => undefined, warn: () => undefined },
    );

    expect(restarted).toEqual(["auto"]);
    expect(result.started).toBe(1);
    expect(result.checked).toBe(1);
  });

  test("skips apps that are already running or missing a start script", async () => {
    const restarted: string[] = [];
    const result = await autostartApps(
      {
        listApps: async () => [
          app({ id: "running", label: "Running", autoStart: true }),
          app({ id: "missing", label: "Missing", autoStart: true, scripts: {} }),
        ],
      },
      {
        getStatus: async (appId) => status({ appId, status: "running", running: true }),
        restart: async (appId) => {
          restarted.push(appId);
          return status({ appId, status: "running", running: true });
        },
      },
      { log: () => undefined, warn: () => undefined },
    );

    expect(restarted).toEqual([]);
    expect(result.skippedRunning).toBe(1);
    expect(result.skippedMissingStartScript).toBe(1);
  });
});
