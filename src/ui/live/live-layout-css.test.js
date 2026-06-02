import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("live layout CSS", () => {
  test("keeps the session tab bar in normal flow when split panels lock the viewport", () => {
    const rule = styles.match(/\[data-webview-open="true"\] \.wm-tabs-bar\s*\{(?<body>[^}]+)\}/);

    expect(rule?.groups?.body).toContain("position: relative;");
    expect(rule?.groups?.body).toContain("top: auto;");
    expect(rule?.groups?.body).toContain("flex: 0 0 auto;");
  });
});
