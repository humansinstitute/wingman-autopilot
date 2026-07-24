import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MessageStore } from "./message-store";

describe("MessageStore speech attachments", () => {
  let rootDir = "";
  let store: MessageStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "message-store-"));
    store = new MessageStore(join(rootDir, "wingman.db"));
    store.recordSession({
      id: "session-1",
      agent: "codex",
      startedAt: "2026-06-13T01:00:00.000Z",
      npub: "npub1speaker",
    });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("returns speech attachments with matching messages", () => {
    store.replaceMessages("session-1", [
      {
        role: "assistant",
        content: "Here is the result.",
        createdAt: "2026-06-13T01:01:00.000Z",
      },
    ]);

    store.saveMessageSpeechAttachment({
      sessionId: "session-1",
      messageRole: "assistant",
      messageCreatedAt: "2026-06-13T01:01:00.000Z",
      publicPath: "/uploads/files/speaker/codex/speech/result.mp3",
      relativePath: "speaker/codex/speech/result.mp3",
      mimeType: "audio/mpeg",
      voice: "alloy",
      model: "tts-1",
      summary: "Here is the result.",
    });

    expect(store.listSessionMessages("session-1")).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "Here is the result.",
        speech: expect.objectContaining({
          publicPath: "/uploads/files/speaker/codex/speech/result.mp3",
          mimeType: "audio/mpeg",
          voice: "alloy",
          model: "tts-1",
        }),
      }),
    ]);
  });
});

describe("MessageStore session last-updated projection", () => {
  let rootDir = "";
  let store: MessageStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "message-store-output-"));
    store = new MessageStore(join(rootDir, "wingman.db"));
    store.recordSession({
      id: "session-1",
      agent: "codex",
      startedAt: "2026-07-24T01:00:00.000Z",
    });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("is null before output and ignores user-only transcript changes", () => {
    expect(store.getSession("session-1")?.lastUpdatedAt).toBeNull();

    store.replaceMessages("session-1", [{
      role: "user",
      content: "Please investigate",
      createdAt: "2026-07-24T01:01:00.000Z",
    }]);

    expect(store.getSession("session-1")?.lastUpdatedAt).toBeNull();
  });

  test("uses the newest reasoning or assistant output and survives metadata writes", () => {
    store.replaceMessages("session-1", [
      { role: "user", content: "Start", createdAt: "2026-07-24T01:05:00.000Z" },
      { role: "agent-working", content: "Thinking", createdAt: "2026-07-24T01:02:00+00:00" },
      { role: "assistant", content: "Done", createdAt: "2026-07-24T01:03:00.000Z" },
    ]);
    expect(store.getSession("session-1")?.lastUpdatedAt).toBe("2026-07-24T01:03:00.000Z");

    store.recordSession({
      id: "session-1",
      agent: "codex",
      startedAt: "2026-07-24T01:00:00.000Z",
      name: "Renamed",
    });
    expect(store.getSession("session-1")?.lastUpdatedAt).toBe("2026-07-24T01:03:00.000Z");
  });
});
