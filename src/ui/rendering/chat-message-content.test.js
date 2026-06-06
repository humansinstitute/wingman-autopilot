import { describe, expect, test } from "bun:test";

import { renderChatMessageHtml } from "./chat-message-content.js";

describe("chat message content rendering", () => {
  test("keeps captured session text raw by default", () => {
    const html = renderChatMessageHtml("Cleartext should be\n  only relay-safe classification.");

    expect(html).toContain("Cleartext should be\n  only relay-safe classification.");
  });

  test("cleans agent session text when requested", () => {
    const html = renderChatMessageHtml("Cleartext should be\n  only relay-safe classification.", {
      cleanAgentText: true,
    });

    expect(html).toContain("Cleartext should be only relay-safe classification.");
  });

  test("preserves image markdown while cleaning text blocks", () => {
    const html = renderChatMessageHtml([
      "Here is the thing",
      "  you asked for.",
      "![upload](/uploads/images/example.png)",
    ].join("\n"), {
      cleanAgentText: true,
    });

    expect(html).toContain("Here is the thing you asked for.");
    expect(html).toContain("wm-inline-image");
  });
});
