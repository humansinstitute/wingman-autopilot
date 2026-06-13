import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./db.js", import.meta.url), "utf8");

describe("live message speech persistence", () => {
  test("can update an existing Dexie message with generated speech audio", () => {
    expect(source).toContain("async updateMessageSpeech(sessionId, message, speech)");
    expect(source).toContain("normalizeConversationMessage(message)");
    expect(source).toContain("entry.messageId === normalized.messageId");
    expect(source).toContain("speech,");
  });
});
