import { describe, expect, test } from "bun:test";

import { getConversationScrollElement } from "./icons.js";

describe("getConversationScrollElement", () => {
  test("uses the split-mode live scroll container when present", () => {
    const splitScroll = { nodeName: "scroll" };
    const conversation = {
      closest: (selector) => selector === ".wm-live-scroll" ? splitScroll : null,
    };
    const messageContainer = {
      closest: (selector) => selector === ".wm-live-conversation" ? conversation : null,
    };

    expect(getConversationScrollElement("session-1", new Map([["session-1", messageContainer]]))).toBe(splitScroll);
  });

  test("falls back to the conversation element outside split mode", () => {
    const conversation = {
      closest: () => null,
    };
    const messageContainer = {
      closest: (selector) => selector === ".wm-live-conversation" ? conversation : null,
    };

    expect(getConversationScrollElement("session-1", new Map([["session-1", messageContainer]]))).toBe(conversation);
  });
});
