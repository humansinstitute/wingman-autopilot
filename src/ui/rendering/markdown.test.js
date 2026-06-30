import { describe, expect, test } from "bun:test";

import { renderCodeToHtml, renderMarkdownToHtml, sanitizeImageSrc } from "./markdown.js";

describe("renderCodeToHtml", () => {
  test("highlights TypeScript code tokens", () => {
    const html = renderCodeToHtml('const count = 42; const name = "Wingman"; // artifact', "typescript");

    expect(html).toContain('class="language-typescript"');
    expect(html).toContain('<span class="token keyword">const</span>');
    expect(html).toContain('<span class="token number">42</span>');
    expect(html).toContain('<span class="token string">&quot;Wingman&quot;</span>');
    expect(html).toContain('<span class="token comment">// artifact</span>');
    expect(html).not.toContain('token <span class="token keyword">number</span>');
  });

  test("highlights uppercase SQL keywords and comments", () => {
    const html = renderCodeToHtml("SELECT * FROM sessions -- active", "sql");

    expect(html).toContain('class="language-sql"');
    expect(html).toContain('<span class="token keyword">SELECT</span>');
    expect(html).toContain('<span class="token keyword">FROM</span>');
    expect(html).toContain('<span class="token comment">-- active</span>');
  });

  test("falls back to escaped plaintext for unknown languages", () => {
    const html = renderCodeToHtml("<unsafe>", "made-up");

    expect(html).toContain('class="language-plaintext"');
    expect(html).toContain("&lt;unsafe&gt;");
  });
});

describe("renderMarkdownToHtml", () => {
  test("renders Mermaid code fences as diagram placeholders", () => {
    const html = renderMarkdownToHtml("```mermaid\ngraph TD\n  A-->B\n```");

    expect(html).toContain('class="wm-mermaid"');
    expect(html).toContain('data-testid="markdown-mermaid-diagram"');
    expect(html).toContain("graph TD");
    expect(html).not.toContain('class="language-mermaid"');
  });

  test("rewrites scoped uploaded file image URLs for browser preview", () => {
    const url = "file:///Users/mini/code/wingmanbefree/autopilot/tmp/uploads/images/npub1abc/codex/example.png";

    expect(sanitizeImageSrc(url)).toBe("/uploads/images/npub1abc/codex/example.png");
  });

  test("renders escaped uploaded image markdown", () => {
    const html = renderMarkdownToHtml("\\![uploaded image]\\(file:///tmp/uploads/images/npub1abc/codex/example.png\\)");

    expect(html).toContain('class="wm-inline-image-link"');
    expect(html).toContain('href="/uploads/images/npub1abc/codex/example.png"');
    expect(html).toContain('src="/uploads/images/npub1abc/codex/example.png"');
    expect(html).toContain('alt="uploaded image"');
  });

  test("maps same-origin workspace markdown links to the files browser", () => {
    const html = renderMarkdownToHtml(
      "[styles](https://rick.runwingman.com/Users/mini/code/wingmanbefree/autopilot/src/ui/styles.css)",
      {
        workspaceLinks: {
          baseUrl: "https://rick.runwingman.com",
          defaultDirectory: "/Users/mini",
        },
      },
    );

    expect(html).toContain('href="/files/code/wingmanbefree/autopilot/src/ui/styles.css"');
    expect(html).toContain(">styles</a>");
  });

  test("maps same-origin bare workspace URLs to the files browser", () => {
    const html = renderMarkdownToHtml(
      "Open https://rick.runwingman.com/Users/mini/code/wingmanbefree/autopilot/src/ui/styles.css",
      {
        workspaceLinks: {
          baseUrl: "https://rick.runwingman.com",
          defaultDirectory: "/Users/mini",
        },
      },
    );

    expect(html).toContain('href="/files/code/wingmanbefree/autopilot/src/ui/styles.css"');
    expect(html).toContain(">https://rick.runwingman.com/Users/mini/code/wingmanbefree/autopilot/src/ui/styles.css</a>");
  });

  test("does not autolink URLs inside inline code", () => {
    const html = renderMarkdownToHtml("`https://rick.runwingman.com/Users/mini/code/app.ts`", {
      workspaceLinks: {
        baseUrl: "https://rick.runwingman.com",
        defaultDirectory: "/Users/mini",
      },
    });

    expect(html).toContain("<code>https://rick.runwingman.com/Users/mini/code/app.ts</code>");
    expect(html).not.toContain("<a ");
  });
});
