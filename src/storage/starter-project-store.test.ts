import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { StarterProjectStore } from "./starter-project-store";

const tempDirs: string[] = [];

async function createStore(): Promise<{ store: StarterProjectStore; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "starter-project-store-"));
  tempDirs.push(dir);
  const filePath = join(dir, "wingman.db");
  return { store: new StarterProjectStore(filePath), filePath };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("StarterProjectStore", () => {
  test("seeds only the WApp SQLite starter by default", async () => {
    const { store } = await createStore();

    expect(store.list().map((starter) => starter.name)).toEqual(["WApp Starter with SQLite DB"]);
    expect(store.list()[0]?.gitUrl).toBe("https://github.com/humansinstitute/wapp-starter.git");
    expect(Boolean(store.list()[0]?.webApp)).toBe(true);
  });

  test("removes legacy Speedrun default starter records on startup", async () => {
    const { store, filePath } = await createStore();
    store.create({
      name: "Speedrun Lite Agent",
      gitUrl: "https://gitea.pages.otherstuff.ai/honest-ivory-thicket/speedrun-lite-agent-starter.git",
    });

    const restartedStore = new StarterProjectStore(filePath);

    expect(restartedStore.list().map((starter) => starter.name)).toEqual(["WApp Starter with SQLite DB"]);
  });
});
