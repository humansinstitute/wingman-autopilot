import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./chat-component.js", import.meta.url), "utf8");

describe("Alpine chat speech controls", () => {
  test("renders spoken summary playback beside copy controls", () => {
    expect(source).toContain("readMessageAloud");
    expect(source).toContain("autoReadLatestAssistantMessage");
    expect(source).toContain("ensureLatestAssistantSpeech");
    expect(source).toContain("getLatestAssistantSpeechKey");
    expect(source).toContain("hasMessageSpeech");
    expect(source).toContain("canReadMessage(message)");
    expect(source).toContain("isReadableAgentMessage(message) && hasMessageSpeech(message)");
    expect(source).toContain('class="wm-message-actions"');
    expect(source).toContain('class="wm-message-speech-play"');
    expect(source).toContain('data-testid="message-speech-play"');
    expect(source).toContain("$store.chat.playMessageSpeech(message, $el)");
  });

  test("keeps Alpine speech generation and auto-read wired to session details settings", () => {
    expect(source).toContain("isSessionSpeechGenerationEnabled(session)");
    expect(source).toContain("isSessionAlwaysReadEnabled(session)");
    expect(source).toContain("void ensureLatestAssistantSpeech");
    expect(source).toContain("_speechBaselineReady");
    expect(source).toContain("_lastSpeechCandidateKey");
    expect(source).toContain("window.Alpine?.store(\"sessions\")?.items");
  });

  test("syncs server messages on load so existing speech attachments show up", () => {
    expect(source).toContain('import { fetchSessionMessagesApi } from "../services/sessions.js";');
    expect(source).toContain("void this._syncMessagesFromServer(sessionId)");
    expect(source).toContain("MessageStore.syncFromServerIfChanged(sessionId, payload.messages)");
  });
});
