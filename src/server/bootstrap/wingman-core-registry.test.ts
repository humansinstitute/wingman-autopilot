import { describe, expect, test } from "bun:test";

import type {
  AppRecord,
  RegisterAppInput,
  UpdateAppInput,
} from "../../apps/app-registry";
import {
  cleanupLegacyWingmanRootApps,
  ensureWingmanCoreRegistration,
  WINGMAN_CORE_APP_ID,
} from "./wingman-core-registry";

const PROJECT_ROOT = "/Users/mini/code/wingmen";

class InMemoryAppRegistry {
  private readonly records = new Map<string, AppRecord>();

  constructor(initialApps: AppRecord[] = []) {
    for (const app of initialApps) {
      this.records.set(app.id, { ...app });
    }
  }

  async listApps(): Promise<AppRecord[]> {
    return Array.from(this.records.values()).sort((a, b) => a.label.localeCompare(b.label));
  }

  async getApp(id: string): Promise<AppRecord | undefined> {
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  async registerApp(input: RegisterAppInput): Promise<AppRecord> {
    const id = input.id?.trim() ?? crypto.randomUUID();
    if (this.records.has(id)) {
      throw new Error(`App with id "${id}" already exists`);
    }
    const root = input.root;
    const conflict = Array.from(this.records.values()).find((app) => app.root === root);
    if (conflict) {
      throw new Error(`An app is already registered for root "${root}"`);
    }
    const now = new Date().toISOString();
    const record: AppRecord = {
      id,
      label: input.label,
      root,
      scripts: input.scripts ?? {},
      tmuxSession: input.tmuxSession ?? "",
      pm2Name: input.pm2Name,
      logsDir: input.logsDir,
      notes: input.notes,
      ownerNpub: input.ownerNpub ?? null,
      createdAt: now,
      updatedAt: now,
      webApp: Boolean(input.webApp),
      webAppPort: input.webAppPort ?? null,
    };
    this.records.set(record.id, record);
    return { ...record };
  }

  async updateApp(id: string, input: UpdateAppInput): Promise<AppRecord> {
    const existing = this.records.get(id);
    if (!existing) {
      throw new Error(`Unknown app: ${id}`);
    }
    const nextRoot = input.root ?? existing.root;
    if (nextRoot !== existing.root) {
      const conflict = Array.from(this.records.values()).find((app) => app.id !== id && app.root === nextRoot);
      if (conflict) {
        throw new Error(`Another app is already registered for root "${nextRoot}"`);
      }
    }
    const next: AppRecord = {
      ...existing,
      label: input.label ?? existing.label,
      root: nextRoot,
      scripts: input.scripts ?? existing.scripts,
      tmuxSession: input.tmuxSession ?? existing.tmuxSession,
      pm2Name: input.pm2Name !== undefined ? input.pm2Name : existing.pm2Name,
      logsDir: input.logsDir !== undefined ? input.logsDir : existing.logsDir,
      notes: input.notes === null ? undefined : input.notes ?? existing.notes,
      ownerNpub: input.ownerNpub !== undefined ? input.ownerNpub : existing.ownerNpub,
      updatedAt: new Date().toISOString(),
      webApp: input.webApp !== undefined ? input.webApp : existing.webApp,
      webAppPort: input.webAppPort !== undefined ? input.webAppPort : existing.webAppPort,
    };
    this.records.set(id, next);
    return { ...next };
  }

  async removeApp(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

function buildApp(overrides: Partial<AppRecord> & Pick<AppRecord, "id" | "label" | "root">): AppRecord {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    label: overrides.label,
    root: overrides.root,
    scripts: overrides.scripts ?? {},
    tmuxSession: overrides.tmuxSession ?? `${overrides.id}-tmux`,
    pm2Name: overrides.pm2Name,
    logsDir: overrides.logsDir,
    notes: overrides.notes,
    ownerNpub: overrides.ownerNpub ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    webApp: overrides.webApp ?? false,
    webAppPort: overrides.webAppPort ?? null,
  };
}

function createLogger() {
  const logger = {
    log: [] as string[],
    warn: [] as string[],
    error: [] as string[],
  };

  return {
    log: logger.log,
    warn: logger.warn,
    error: logger.error,
    sink: {
      log(message: string) {
        logger.log.push(message);
      },
      warn(message: string) {
        logger.warn.push(message);
      },
      error(message: string) {
        logger.error.push(message);
      },
    },
  };
}

describe("wingman-core registry bootstrap", () => {
  test("startup updates wingman-core without deleting legacy same-root records", async () => {
    const registry = new InMemoryAppRegistry([
      buildApp({
        id: WINGMAN_CORE_APP_ID,
        label: "Wingman Server",
        root: PROJECT_ROOT,
        scripts: { restart: "bun run old-restart.ts" },
        tmuxSession: "legacy-window",
      }),
      buildApp({
        id: "legacy-wingman",
        label: "Wingman Server Legacy",
        root: PROJECT_ROOT,
      }),
      buildApp({
        id: "valid-app",
        label: "Valid App",
        root: "/Users/mini/code/another-app",
      }),
    ]);
    const logger = createLogger();

    const result = await ensureWingmanCoreRegistration(registry as any, {
      projectRoot: PROJECT_ROOT,
      logger: logger.sink,
    });

    expect(result.action).toBe("updated");
    expect(result.legacyConflictIds).toEqual(["legacy-wingman"]);

    const apps = await registry.listApps();
    expect(apps.map((app) => app.id).sort()).toEqual([
      "legacy-wingman",
      "valid-app",
      WINGMAN_CORE_APP_ID,
    ]);

    const coreApp = await registry.getApp(WINGMAN_CORE_APP_ID);
    expect(coreApp?.scripts.restart).toBe("bun run scripts/restart-wingman.ts");
    expect(coreApp?.tmuxSession).toBe("wingman-core");
    expect(logger.warn[0]).toContain("preserving 1 legacy Wingman app entry during startup");
  });

  test("startup surfaces a legacy root conflict instead of deleting records when wingman-core is missing", async () => {
    const registry = new InMemoryAppRegistry([
      buildApp({
        id: "legacy-wingman",
        label: "Wingman Server Legacy",
        root: PROJECT_ROOT,
      }),
      buildApp({
        id: "valid-app",
        label: "Valid App",
        root: "/Users/mini/code/another-app",
      }),
    ]);
    const logger = createLogger();

    const result = await ensureWingmanCoreRegistration(registry as any, {
      projectRoot: PROJECT_ROOT,
      logger: logger.sink,
    });

    expect(result.action).toBe("blocked");
    expect(result.legacyConflictIds).toEqual(["legacy-wingman"]);
    expect((await registry.listApps()).map((app) => app.id).sort()).toEqual([
      "legacy-wingman",
      "valid-app",
    ]);
    expect(logger.warn[0]).toContain("wingman-core registration is blocked");
  });

  test("explicit cleanup removes only legacy same-root records and stays idempotent", async () => {
    const registry = new InMemoryAppRegistry([
      buildApp({
        id: WINGMAN_CORE_APP_ID,
        label: "Wingman Server",
        root: PROJECT_ROOT,
      }),
      buildApp({
        id: "legacy-a",
        label: "Legacy A",
        root: PROJECT_ROOT,
      }),
      buildApp({
        id: "legacy-b",
        label: "Legacy B",
        root: PROJECT_ROOT,
      }),
      buildApp({
        id: "valid-app",
        label: "Valid App",
        root: "/Users/mini/code/another-app",
      }),
    ]);
    const logger = createLogger();

    const firstPass = await cleanupLegacyWingmanRootApps(registry as any, {
      projectRoot: PROJECT_ROOT,
      logger: logger.sink,
    });

    expect(firstPass.matchedIds).toEqual(["legacy-a", "legacy-b"]);
    expect(firstPass.removedIds).toEqual(["legacy-a", "legacy-b"]);
    expect(firstPass.failedIds).toEqual([]);
    expect((await registry.listApps()).map((app) => app.id).sort()).toEqual([
      "valid-app",
      WINGMAN_CORE_APP_ID,
    ]);

    const secondPass = await cleanupLegacyWingmanRootApps(registry as any, {
      projectRoot: PROJECT_ROOT,
      logger: logger.sink,
    });

    expect(secondPass).toEqual({
      matchedIds: [],
      removedIds: [],
      failedIds: [],
    });
  });

  test("startup registration is idempotent when the registry is already clean", async () => {
    const registry = new InMemoryAppRegistry();

    const firstRun = await ensureWingmanCoreRegistration(registry as any, {
      projectRoot: PROJECT_ROOT,
    });
    const secondRun = await ensureWingmanCoreRegistration(registry as any, {
      projectRoot: PROJECT_ROOT,
    });

    expect(firstRun.action).toBe("registered");
    expect(secondRun.action).toBe("unchanged");

    const apps = await registry.listApps();
    expect(apps).toHaveLength(1);
    expect(apps[0]?.id).toBe(WINGMAN_CORE_APP_ID);
  });
});
