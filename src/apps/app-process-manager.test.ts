import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

import type { AppRecord } from "./app-registry";
import { WappStore } from "../wapps/wapp-store";

const ecosystemCalls: string[] = [];
const pm2Starts: string[] = [];

mock.module("../agents/ecosystem-generator", () => ({
  addUserAppToEcosystem: async () => {
    ecosystemCalls.push("add");
    return {
      ecosystemPath: "/tmp/ecosystem.config.cjs",
      processName: "app-test-process",
      logsDir: "/tmp/app-logs",
    };
  },
  generateAppProcessName: () => "app-test-process",
  getEcosystemPath: () => "/tmp/ecosystem.config.cjs",
  getLogsDirectory: () => "/tmp/app-logs",
  removeAppFromEcosystem: async () => undefined,
}));

mock.module("../agents/pm2-wrapper", () => ({
  deleteProcess: async () => undefined,
  getProcessByName: async () => null,
  getProcessRuntimeInfo: async () => ({ pid: 1234, port: 4100, memory: 1024 }),
  startProcessFromConfig: async (_ecosystemPath: string, processName: string) => {
    pm2Starts.push(processName);
  },
  stopProcess: async () => undefined,
}));

const { AppProcessManager } = await import("./app-process-manager");
const { TowerWappRegistrationError } = await import("../wapps/tower-registration");

const app: AppRecord = {
  id: "app-1",
  label: "Ops Board",
  root: "/tmp/app",
  scripts: { start: "bun run start", setup: "bun run setup" },
  tmuxSession: "ops-board",
  ownerNpub: "npub1owner",
  createdAt: "2026-06-19T00:00:00.000Z",
  updatedAt: "2026-06-19T00:00:00.000Z",
  webApp: true,
  webAppPort: 4100,
};

function makeManager(input: {
  registrar: { register: (registration: any) => Promise<any> };
}): { manager: InstanceType<typeof AppProcessManager>; cleanup: () => void } {
  ecosystemCalls.length = 0;
  pm2Starts.length = 0;
  const dir = mkdtempSync(join(tmpdir(), "app-process-manager-"));
  const store = new WappStore(join(dir, "wapps.sqlite"));
  store.createTowerBinding({
    id: "tower-dev",
    label: "Tower Dev",
    towerUrl: "https://tower.example",
    workspaceOwnerNpub: "npub1workspace",
  });
  store.create({
    id: "wapp-1",
    appId: app.id,
    title: "Ops Board WApp",
    ownerNpub: "npub1owner",
    createdByNpub: "npub1owner",
    workspaceOwnerNpub: "npub1workspace",
    scopeId: "scope-1",
    allowedNpubs: ["npub1owner"],
    launchUrl: "https://apps.example/ops",
    towerBindingId: "tower-dev",
    appKeyMode: "generate",
  });
  const registry = {
    getApp: async (id: string) => id === app.id ? app : undefined,
    updateApp: async (_id: string, updates: Partial<AppRecord>) => ({ ...app, ...updates }),
    listApps: async () => [app],
  };
  const manager = new AppProcessManager(registry as any, [], store, {
    botNpub: "npub1bot",
    botPubkeyHex: "f".repeat(64),
    botSecret: new Uint8Array(32),
  }, input.registrar);
  return {
    manager,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("AppProcessManager Tower WApp lifecycle registration", () => {
  test("registers a pre-existing Tower-backed WApp before PM2 start", async () => {
    const registrations: any[] = [];
    const { manager, cleanup } = makeManager({
      registrar: {
        register: async (registration) => {
          registrations.push(registration);
          return {
            workspaceOwnerNpub: registration.workspaceOwnerNpub,
            appNpub: registration.appNpub,
            app: { app_npub: registration.appNpub },
          };
        },
      },
    });
    try {
      const status = await manager.start(app.id);

      expect(status.status).toBe("running");
      expect(registrations).toHaveLength(1);
      expect(registrations[0]).toMatchObject({
        towerUrl: "https://tower.example",
        workspaceOwnerNpub: "npub1workspace",
        appName: "Ops Board WApp",
      });
      expect(registrations[0].appNpub).toStartWith("npub1");
      expect(pm2Starts).toEqual(["app-test-process"]);
    } finally {
      cleanup();
    }
  });

  test("prevents launch success when Tower registration fails", async () => {
    const { manager, cleanup } = makeManager({
      registrar: {
        register: async () => {
          throw new TowerWappRegistrationError("Tower registration failed: Not authorized to manage this workspace", {
            status: 403,
            detailCode: "not_authorized",
          });
        },
      },
    });
    try {
      await expect(manager.start(app.id)).rejects.toThrow("Tower registration failed");
      expect(ecosystemCalls).toEqual([]);
      expect(pm2Starts).toEqual([]);
      const status = await manager.getStatus(app.id);
      expect(status.status).toBe("failed");
      expect(status.message).toContain("Tower registration failed");
    } finally {
      cleanup();
    }
  });

  test("prevents setup success when Tower registration fails", async () => {
    const { manager, cleanup } = makeManager({
      registrar: {
        register: async () => {
          throw new TowerWappRegistrationError("Tower registration failed: Missing workspace app authority", {
            status: 403,
            detailCode: "not_authorized",
          });
        },
      },
    });
    try {
      await expect(manager.setup(app.id)).rejects.toThrow("Tower registration failed");
      expect(ecosystemCalls).toEqual([]);
      expect(pm2Starts).toEqual([]);
      const status = await manager.getStatus(app.id);
      expect(status.status).toBe("failed");
      expect(status.message).toContain("Missing workspace app authority");
    } finally {
      cleanup();
    }
  });
});
