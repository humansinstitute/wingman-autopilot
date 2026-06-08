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

  test("renders fenced code blocks separately from plain response text", () => {
    const html = renderChatMessageHtml([
      "Use this:",
      "```js",
      "const answer = 42;",
      "```",
      "Done.",
    ].join("\n"));

    expect(html).toContain('class="wm-message-code-block wm-message-code-block-javascript"');
    expect(html).toContain('class="language-javascript"');
    expect(html).toContain("const answer = 42;");
    expect(html).toContain('<pre class="wm-message-plain">Use this:</pre>');
    expect(html).toContain('<pre class="wm-message-plain">Done.</pre>');
  });

  test("renders fenced diffs with add and remove line classes", () => {
    const html = renderChatMessageHtml([
      "```diff",
      "-const oldValue = true;",
      "+const newValue = true;",
      "```",
    ].join("\n"));

    expect(html).toContain("wm-message-code-block-diff");
    expect(html).toContain("wm-diff-line-remove");
    expect(html).toContain("wm-diff-line-add");
  });

  test("detects bare edited diff summaries from agent output", () => {
    const html = renderChatMessageHtml([
      "\u2022 Edited ~/code/example.js (+1 -1)",
      "4 -const oldValue = true;",
      "4 +const newValue = true;",
      "",
      "Next step is testing.",
    ].join("\n"));

    expect(html).toContain("wm-message-code-block-diff");
    expect(html).toContain("wm-diff-line-remove");
    expect(html).toContain("wm-diff-line-add");
    expect(html).toContain('<pre class="wm-message-plain">Next step is testing.</pre>');
  });

  test("does not treat plain plus-list text as a diff block", () => {
    const html = renderChatMessageHtml([
      "+ first item",
      "+ second item",
    ].join("\n"));

    expect(html).not.toContain("wm-message-code-block-diff");
    expect(html).toContain("+ first item\n+ second item");
  });
});
