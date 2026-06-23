import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("live layout CSS", () => {
  test("uses most of the viewport for wide content routes", () => {
    const rule = styles.match(/#app\[data-route="files"\],[\s\S]+?#app\[data-route="live"\]\s*\{(?<body>[^}]+)\}/);

    expect(rule?.groups?.body).toContain("max-width: 90vw;");
    expect(rule?.groups?.body).toContain("width: 90vw;");
    expect(rule?.[0]).toContain('#app[data-route="apps"]');
    expect(rule?.[0]).toContain('#app[data-route="scheduler"]');
    expect(rule?.[0]).toContain('#app[data-route="pipelines"]');
  });

  test("keeps the session tab bar in normal flow when split panels lock the viewport", () => {
    const rule = styles.match(/\[data-webview-open="true"\] \.wm-tabs-bar\s*\{(?<body>[^}]+)\}/);

    expect(rule?.groups?.body).toContain("position: relative;");
    expect(rule?.groups?.body).toContain("top: auto;");
    expect(rule?.groups?.body).toContain("flex: 0 0 auto;");
  });
});
