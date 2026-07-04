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
  test("seeds the WApp starter options by default", async () => {
    const { store } = await createStore();

    expect(store.list().map((starter) => starter.name)).toEqual([
      "WApp Starter with SQLite DB",
      "WApp Starter with Tower PG Backend",
    ]);
    expect(store.list().map((starter) => starter.gitUrl)).toEqual([
      "https://github.com/humansinstitute/wapp-starter.git",
      "https://github.com/humansinstitute/wapp-starter-tower.git",
    ]);
    expect(store.list().every((starter) => Boolean(starter.webApp))).toBe(true);
    expect(store.list().every((starter) => starter.setupCommand === "bun install")).toBe(true);
  });

  test("removes legacy Speedrun default starter records on startup", async () => {
    const { store, filePath } = await createStore();
    store.create({
      name: "Speedrun Lite Agent",
      gitUrl: "https://gitea.pages.otherstuff.ai/honest-ivory-thicket/speedrun-lite-agent-starter.git",
    });

    const restartedStore = new StarterProjectStore(filePath);

    expect(restartedStore.list().map((starter) => starter.name)).toEqual([
      "WApp Starter with SQLite DB",
      "WApp Starter with Tower PG Backend",
    ]);
  });
});
