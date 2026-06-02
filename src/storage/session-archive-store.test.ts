import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { SessionArchiveStore } from "./session-archive-store";

let tempRoot: string | null = null;

const createStore = () => {
  tempRoot = mkdtempSync(join(tmpdir(), "wingman-archive-store-"));
  return new SessionArchiveStore(join(tempRoot, "archive.db"));
};

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe("SessionArchiveStore", () => {
  test("filters archived sessions by metadata tags", () => {
    const store = createStore();
    store.archiveSession({
      id: "session-1",
      agent: "codex",
      name: "Archive tags",
      npub: "npub1user",
      workingDirectory: "/tmp/wingmen",
      startedAt: new Date().toISOString(),
      origin: null,
      metadata: { AGENT: true, billingMode: "subscription", tags: ["flight-deck", "nip98"] },
      messages: [],
    });
    store.archiveSession({
      id: "session-2",
      agent: "codex",
      name: "Other work",
      npub: "npub1user",
      workingDirectory: "/tmp/other",
      startedAt: new Date().toISOString(),
      origin: null,
      metadata: { AGENT: true, billingMode: "subscription", tags: ["billing"] },
      messages: [],
    });

    expect(store.listArchivedSessions({ filter: "nip98" }).map((session) => session.id)).toEqual(["session-1"]);
    expect(store.getArchiveCount({ filter: "flight-deck" })).toBe(1);
  });

  test("updates archived session metadata tags", () => {
    const store = createStore();
    store.archiveSession({
      id: "session-1",
      agent: "codex",
      name: "Archive tags",
      npub: "npub1user",
      workingDirectory: "/tmp/wingmen",
      startedAt: new Date().toISOString(),
      origin: null,
      metadata: { AGENT: true, billingMode: "subscription" },
      messages: [],
    });

    const updated = store.updateArchivedSessionMetadata("session-1", { tags: "flight-deck, NIP98" });
    expect(updated?.metadata.tags).toEqual(["flight-deck", "nip98"]);
  });
});
