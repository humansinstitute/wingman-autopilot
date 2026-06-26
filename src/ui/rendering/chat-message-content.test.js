import { describe, expect, test } from "bun:test";

import { renderChatMessageHtml, renderWorkingNotesHtml } from "./chat-message-content.js";

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
    expect(html).toContain('data-testid="inline-image-preview-link"');
    expect(html).toContain('aria-label="Open upload preview"');
  });

  test("renders working notes as a collapsible details block", () => {
    const html = renderWorkingNotesHtml("Checking files.\n\nRunning tests.");

    expect(html).toContain('class="wm-message-working-notes"');
    expect(html).toContain('data-testid="message-working-notes"');
    expect(html).toContain("data-working-notes-panel");
    expect(html).toContain('data-testid="message-working-notes-summary"');
    expect(html).toContain('aria-label="Toggle working notes"');
    expect(html).toContain(">Working notes</summary>");
    expect(html).toContain("Checking files.");
    expect(html).toContain("Running tests.");
  });
});
