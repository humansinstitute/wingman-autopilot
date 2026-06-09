import { describe, expect, test } from "bun:test";

import { renderCodeToHtml } from "./markdown.js";

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
