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
