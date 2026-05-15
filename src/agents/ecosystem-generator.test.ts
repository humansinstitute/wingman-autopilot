import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import type { AppRecord } from "../apps/app-registry";
import { WappStore } from "../wapps/wapp-store";
import { createUserAppEcosystemConfig } from "./ecosystem-generator";

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
