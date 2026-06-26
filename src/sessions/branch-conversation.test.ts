import { describe, expect, test } from "bun:test";

import {
  formatBranchConversationPrompt,
  normalizeBranchConversationMessages,
  selectBranchConversationMessages,
  validateBranchConversationInput,
} from "./branch-conversation";

describe("branch conversation helpers", () => {
  test("defaults to a full branch context", () => {
    const input = validateBranchConversationInput({});

    expect(input.mode).toBe("full");
    expect(input.messageCount).toBe(40);
  });

  test("normalizes and selects recent messages", () => {
    const messages = normalizeBranchConversationMessages([
      { role: "user", content: "one", createdAt: "2026-06-26T01:00:00.000Z" },
      { role: "assistant", content: "two" },
      { role: "user", content: "" },
      { type: "agent", message: "three" },
    ]);

    expect(messages).toHaveLength(3);
    expect(selectBranchConversationMessages(messages, {
      sourceSessionId: "session-1",
      mode: "recent",
      messageCount: 2,
    }).map((message) => message.content)).toEqual(["two", "three"]);
  });

  test("formats an independent branch prompt", () => {
    const prompt = formatBranchConversationPrompt({
      sourceSessionId: "session-1",
      sourceName: "Implementation",
      mode: "full",
      messages: [
        { role: "user", content: "What happened?", createdAt: "2026-06-26T01:00:00.000Z" },
        { role: "assistant", content: "We changed the route." },
      ],
    });

    expect(prompt).toContain("new, independent Codex session");
    expect(prompt).toContain("Source session: Implementation");
    expect(prompt).toContain("[User 2026-06-26T01:00:00.000Z]");
    expect(prompt).toContain("We changed the route.");
  });
});
