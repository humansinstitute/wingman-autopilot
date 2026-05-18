import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { CaproverStore } from "./caprover-store";

let tempDir: string | null = null;

function createTempStore(): CaproverStore {
  tempDir = mkdtempSync(join(tmpdir(), "caprover-store-"));
  return new CaproverStore(join(tempDir, "store.sqlite"));
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("CaproverStore deployment targets", () => {
  test("records target name on deployments", () => {
    const store = createTempStore();
    const app = store.createApp({
      caproverName: "demo-app",
      appId: "local-demo",
    });

    const deployment = store.createDeployment({
      caproverAppId: app.id,
      targetName: "secondary",
      deployMethod: "tar_upload",
    });

    expect(deployment.targetName).toBe("secondary");
    expect(store.getDeployment(deployment.id)?.targetName).toBe("secondary");
  });
});
