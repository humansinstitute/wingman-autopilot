import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const speechSource = readFileSync(new URL("./message-speech.js", import.meta.url), "utf8");
const conversationSource = readFileSync(new URL("./conversation-window.js", import.meta.url), "utf8");
const clipboardSource = readFileSync(new URL("../utils/clipboard.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("live message speech controls", () => {
  test("renders speech playback in the shared message action group", () => {
    expect(conversationSource).toContain("attachCopyButton(bubble);");
    expect(conversationSource).toContain("attachMessageSpeechButton(bubble");
    expect(clipboardSource).toContain('bubble.querySelector(".wm-message-actions")');
    expect(speechSource).toContain('bubble.querySelector(".wm-message-actions")');
    expect(speechSource).toContain('button.className = "wm-message-speech-play"');
  });

  test("uses the server message id preserved beside the Dexie primary key", () => {
    expect(speechSource).toContain('import { fetchSessionMessagesApi } from "../services/sessions.js";');
    expect(speechSource).toContain("message?.messageId");
    expect(speechSource).toContain("message?.message_id");
    expect(speechSource).toContain("resolveServerMessage(sessionId, message)");
    expect(speechSource).toContain("fetchSessionMessagesApi(sessionId, { refresh: true })");
  });

  test("hides play controls until audio exists", () => {
    expect(speechSource).toContain("export function hasMessageSpeech(message)");
    expect(speechSource).toContain("!isAssistantRole(message) || !getMessageText(message) || !hasMessageSpeech(message)");
    expect(speechSource).not.toContain("!isAssistantRole(message) || !getMessageId(message) || !getMessageText(message)");
  });

  test("writes generated audio back to Dexie so playback controls can appear", () => {
    expect(speechSource).toContain('import { MessageStore } from "./db.js";');
    expect(speechSource).toContain("MessageStore.updateMessageSpeech(sessionId, serverMessage, speech)");
    expect(speechSource).toContain("MessageStore.updateMessageSpeech(sessionId, serverMessage, serverSpeech)");
  });

  test("uses server-generated summary audio instead of browser speech for read aloud", () => {
    expect(speechSource).toContain("summary: true");
    expect(speechSource).not.toContain("new SpeechSynthesisUtterance");
    expect(speechSource).not.toContain("readWithBrowserSpeech");
  });

  test("styles message actions as bottom-right icon controls", () => {
    expect(styles).toContain(".wm-message-actions");
    expect(styles).toContain(".wm-message-copy,\n.wm-message-speech-play");
    expect(styles).toContain("bottom: 0.65rem;");
    expect(styles).toContain("right: 0.85rem;");
  });
});
