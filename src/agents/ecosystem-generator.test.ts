import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import type { AppRecord } from "../apps/app-registry";
import type { WingmanConfig } from "../config";
import { WappStore } from "../wapps/wapp-store";
import {
  addAppToEcosystem,
  createAgentPm2StartOptions,
  createUserAppEcosystemConfig,
  getEcosystemPath,
  readEcosystemConfig,
  withEcosystemConfigLock,
  type SessionConfig,
} from "./ecosystem-generator";

function makeApp(id: string, root: string): AppRecord {
  return {
    id,
    label: id === "wapp-app" ? "WApp App" : "Plain App",
    root,
    scripts: { start: "bun src/server.ts" },
    tmuxSession: id,
    ownerNpub: "npub1owner",
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    webApp: true,
    webAppPort: id === "wapp-app" ? 4010 : 4011,
  };
}

function makeSessionConfig(root: string, index: number): SessionConfig {
  const port = 4700 + index;
  return {
    sessionId: `session-${index}`,
    sessionName: `[sched] Concurrent ${index}`,
    agent: "codex",
    port,
    workingDirectory: root,
    userAlias: "tester",
    isAdmin: false,
    config: {
      agents: {
        codex: {
          label: "Codex",
          command: () => ["agentapi", "server", "--port", String(port), "--", "codex"],
        },
      },
    } as unknown as WingmanConfig,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createUserAppEcosystemConfig WApp env injection", () => {
  test("injects WAPP vars only for active WApp assignments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ecosystem-wapp-"));
    try {
      const store = new WappStore(join(dir, "wapps.sqlite"));
      const wappRoot = join(dir, "wapp-root");
      const plainRoot = join(dir, "plain-root");
      store.create({
        id: "wapp-1",
        appId: "wapp-app",
        title: "WApp App",
        ownerNpub: "npub1owner",
        createdByNpub: "npub1owner",
        workspaceOwnerNpub: "npub1workspace",
        scopeId: "scope-1",
        allowedNpubs: ["npub1member", "npub1owner"],
        launchUrl: "https://apps.example/wapp",
      });

      const wappConfig = await createUserAppEcosystemConfig({
        app: makeApp("wapp-app", wappRoot),
        userAlias: "tester",
        userRootDir: dir,
        isAdmin: false,
        wappStore: store,
      });
      const plainConfig = await createUserAppEcosystemConfig({
        app: makeApp("plain-app", plainRoot),
        userAlias: "tester",
        userRootDir: dir,
        isAdmin: false,
        wappStore: store,
      });

      const wappCommand = wappConfig.args[1] ?? "";
      expect(wappCommand).toContain("WAPP_ID='wapp-1'");
      expect(wappCommand).toContain("WAPP_APP_ID='wapp-app'");
      expect(wappCommand).toContain(`WAPP_DB_PATH='${join(wappRoot, "data", "db.sqlite")}'`);
      expect(wappCommand).toContain("WAPP_ALLOWED_NPUBS_JSON='[\"npub1member\",\"npub1owner\"]'");

      const plainCommand = plainConfig.args[1] ?? "";
      expect(plainCommand).not.toContain("WAPP_ID=");
      expect(plainCommand).not.toContain("WAPP_DB_PATH=");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agent ecosystem config concurrency", () => {
  test("builds inline PM2 options for agent sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-pm2-options-"));
    try {
      const options = createAgentPm2StartOptions(makeSessionConfig(dir, 3));

      expect(options.name).toBe("tester-sched-concurrent-3-session3");
      expect(options.namespace).toBe("wingman-agents");
      expect(options.script).toBe("bash");
      expect(options.args[0]).toBe("-lc");
      expect(options.args[1]).toContain("agentapi");
      expect(options.args[1]).toContain("--port");
      expect(options.args[1]).toContain("4703");
      expect(options.cwd).toBe(dir);
      expect(options.env?.SESSION_ID).toBe("session-3");
      expect(options.output).toContain("tester-sched-concurrent-3-session3-out.log");
      expect(options.error).toContain("tester-sched-concurrent-3-session3-error.log");
      expect(options.autorestart).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serializes operations for the same ecosystem path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ecosystem-lock-"));
    try {
      const ecosystemPath = getEcosystemPath(dir, false);
      const events: string[] = [];

      await Promise.all([
        withEcosystemConfigLock(ecosystemPath, async () => {
          events.push("first:start");
          await sleep(20);
          events.push("first:end");
        }),
        withEcosystemConfigLock(ecosystemPath, async () => {
          events.push("second:start");
          events.push("second:end");
        }),
      ]);

      expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves all app entries across concurrent session additions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ecosystem-concurrent-"));
    try {
      const sessions = Array.from({ length: 8 }, (_, index) => makeSessionConfig(dir, index));

      await Promise.all(sessions.map((sessionConfig) => addAppToEcosystem(sessionConfig)));

      const config = await readEcosystemConfig(getEcosystemPath(dir, false));
      const sessionIds = config.apps.map((app) => app.env?.SESSION_ID).sort();
      expect(sessionIds).toEqual(sessions.map((session) => session.sessionId).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
