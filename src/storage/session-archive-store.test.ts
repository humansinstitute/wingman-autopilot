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

  test("filters archived sessions by UI and automated categories", () => {
    const store = createStore();
    const startedAt = new Date().toISOString();
    store.archiveSession({
      id: "ui-session",
      agent: "codex",
      name: "UI session",
      npub: "npub1user",
      workingDirectory: "/tmp/ui",
      startedAt,
      origin: null,
      metadata: { AGENT: false, billingMode: "subscription" },
      messages: [],
    });
    store.archiveSession({
      id: "task-session",
      agent: "codex",
      name: "Task dispatch",
      npub: "npub1user",
      workingDirectory: "/tmp/task",
      startedAt,
      origin: { type: "agent-work", id: "task-1" },
      metadata: { AGENT: true, billingMode: "subscription", role: "agent-work", bindingType: "task" },
      messages: [],
    });
    store.archiveSession({
      id: "chat-session",
      agent: "codex",
      name: "Chat dispatch",
      npub: "npub1user",
      workingDirectory: "/tmp/chat",
      startedAt,
      origin: { type: "agent-chat", id: "thread-1" },
      metadata: { AGENT: false, billingMode: "subscription", routedBy: "agent-chat" },
      messages: [],
    });
    store.archiveSession({
      id: "api-created-session",
      agent: "codex",
      name: "API created",
      npub: "npub1owner",
      workingDirectory: "/tmp/api",
      startedAt,
      origin: null,
      metadata: { AGENT: false, billingMode: "subscription", createdByNpub: "npub1agent" },
      messages: [],
    });

    expect(store.listArchivedSessions({ category: "my" }).map((session) => session.id)).toEqual(["ui-session"]);
    expect(store.listArchivedSessions({ category: "auto" }).map((session) => session.id).sort()).toEqual([
      "api-created-session",
      "chat-session",
      "task-session",
    ]);
    expect(store.getArchiveCount({ category: "my" })).toBe(1);
    expect(store.getArchiveCount({ category: "auto" })).toBe(3);
  });
});
