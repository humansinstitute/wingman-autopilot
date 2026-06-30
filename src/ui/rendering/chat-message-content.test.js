import { describe, expect, test } from "bun:test";

import { countWorkingNoteRows, renderChatMessageHtml, renderWorkingNotesHtml } from "./chat-message-content.js";

describe("chat message content rendering", () => {
  test("renders markdown blocks for chat messages", () => {
    const html = renderChatMessageHtml([
      "## Plan",
      "",
      "- **Render** user messages",
      "- Render `agent` messages",
    ].join("\n"));

    expect(html).toContain("<h2>Plan</h2>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>Render</strong> user messages");
    expect(html).toContain("<code>agent</code>");
  });

  test("cleans agent session text before rendering markdown when requested", () => {
    const html = renderChatMessageHtml("Cleartext should be\n  only relay-safe classification.", {
      cleanAgentText: true,
    });

    expect(html).toContain("<p>Cleartext should be only relay-safe classification.</p>");
  });

  test("renders image markdown while cleaning text blocks", () => {
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

  test("escapes unsafe html and blocks unsafe markdown links", () => {
    const html = renderChatMessageHtml('<img src=x onerror=alert(1)> [bad](javascript:alert(1))');

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain('<a href="#" target="_blank" rel="noopener noreferrer">bad</a>');
    expect(html).not.toContain("javascript:alert");
  });

  test("maps same-origin workspace links from chat config", () => {
    const html = renderChatMessageHtml(
      "[styles](http://localhost/Users/mini/code/wingmanbefree/autopilot/src/ui/styles.css)",
      { config: { defaultDirectory: "/Users/mini" } },
    );

    expect(html).toContain('href="/files/code/wingmanbefree/autopilot/src/ui/styles.css"');
  });

  test("renders working notes as a collapsible details block", () => {
    const html = renderWorkingNotesHtml("Checking files.\n\nRunning tests.");

    expect(html).toContain('class="wm-message-working-notes"');
    expect(html).toContain('data-testid="message-working-notes"');
    expect(html).toContain("data-working-notes-panel");
    expect(html).toContain('data-testid="message-working-notes-summary"');
    expect(html).toContain('aria-label="Toggle working notes"');
    expect(html).toContain("Show thinking 2 thinking messages are collapsed");
    expect(html).toContain("Hide thinking 2 thinking messages");
    expect(html).toContain("Checking files.");
    expect(html).toContain("Running tests.");
  });

  test("counts collapsed working note rows from commentary blocks", () => {
    expect(countWorkingNoteRows("One update.\n\nSecond update.\n\nThird update.")).toBe(3);
    expect(countWorkingNoteRows("One update.\nSecond line.")).toBe(2);
    expect(countWorkingNoteRows("")).toBe(0);
  });

  test("uses singular collapsed working note labels", () => {
    const html = renderWorkingNotesHtml("Only one update.");

    expect(html).toContain("Show thinking 1 thinking message is collapsed");
    expect(html).toContain("Hide thinking 1 thinking message");
  });

  test("renders remembered working note open state", () => {
    const html = renderWorkingNotesHtml("Reviewing files.", {
      workingNotesKey: "session-1:message-1",
      workingNotesOpen: true,
    });

    expect(html).toContain('data-working-notes-key="session-1:message-1"');
    expect(html).toContain("data-working-notes-panel");
    expect(html).toContain(" open>");
  });
});
