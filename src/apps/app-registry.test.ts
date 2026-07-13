if (!Bun.env.IDENTITY_SESSION_SECRET) {
  Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
}

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

let unavailablePorts = new Set<number>();
let ownerPorts = new Map<string, number[]>();

mock.module("../storage/identity-user-store", () => ({
  identityUserStore: {
    ensurePortsFor: (npub: string) => ownerPorts.get(npub) ?? [],
  },
}));

mock.module("../utils/port-utils", () => ({
  isPortAvailable: (port: number) => !unavailablePorts.has(port),
}));

mock.module("./app-alias-registry", () => ({
  appAliasRegistry: {
    registerAlias: async () => undefined,
    removeAlias: async () => undefined,
    getByAppId: async () => null,
  },
}));

mock.module("./app-domain-registry", () => ({
  appDomainRegistry: {
    removeByAppId: async () => 0,
  },
}));

const { AppRegistry } = await import("./app-registry");

async function withRegistry(fn: (registry: InstanceType<typeof AppRegistry>, filePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "app-registry-"));
  const filePath = join(dir, "apps.json");
  try {
    const registry = new AppRegistry(filePath);
    await fn(registry, filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
    unavailablePorts = new Set<number>();
    ownerPorts = new Map<string, number[]>();
  }
}

describe("AppRegistry web app port assignment", () => {
  test("stores managed app env encrypted at rest", async () => {
    await withRegistry(async (registry, filePath) => {
      await registry.registerApp({
        id: "app-1",
        label: "Secret App",
        root: "/tmp/secret-app",
        env: { API_TOKEN: "super-secret" },
      });

      const raw = await readFile(filePath, "utf8");
      expect(raw).not.toContain("super-secret");
      expect(raw).toContain("enc::");

      const hydrated = await registry.getApp("app-1");
      expect(hydrated?.env).toEqual({ API_TOKEN: "super-secret" });
    });
  });

  test("preserves the existing web app port for metadata-only updates even when the app is listening", async () => {
    await withRegistry(async (registry) => {
      ownerPorts.set("npub1owner", [41024, 41031]);
      const app = await registry.registerApp({
        id: "app-1",
        label: "Plantrite",
        root: "/tmp/plantrite",
        ownerNpub: "npub1owner",
        webApp: true,
        webAppPort: 41024,
      });
      expect(app.webAppPort).toBe(41024);

      unavailablePorts.add(41024);
      const updated = await registry.updateApp(app.id, {
        pm2Name: "owner-app-plantrite",
        logsDir: "/tmp/logs",
      });

      expect(updated.webAppPort).toBe(41024);
    });
  });

  test("reassigns a web app port when the owner changes", async () => {
    await withRegistry(async (registry) => {
      ownerPorts.set("npub1owner", [41024]);
      ownerPorts.set("npub1next", [42000]);
      const app = await registry.registerApp({
        id: "app-1",
        label: "Plantrite",
        root: "/tmp/plantrite",
        ownerNpub: "npub1owner",
        webApp: true,
        webAppPort: 41024,
      });

      const updated = await registry.updateApp(app.id, { ownerNpub: "npub1next" });

      expect(updated.webAppPort).toBe(42000);
    });
  });
});
