import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./live-view.js", import.meta.url), "utf8");
const toolbarSource = readFileSync(new URL("../live/session-toolbar.js", import.meta.url), "utf8");

describe("live-view drawer integration", () => {
  test("wires a left drawer entry point into the live view header", () => {
    expect(source).toContain("createLiveSessionDrawer");
    expect(source).toContain("createLiveSessionToolbar");
    expect(source).toContain("main.append(liveToolbar, scrollRegion);");
    expect(toolbarSource).toContain('toolbar.dataset.testid = "live-session-toolbar"');
    expect(toolbarSource).toContain('drawerButton.dataset.testid = "live-session-drawer-toggle"');
  });

  test("keeps the transcript stack intact in desktop side-panel mode", () => {
    expect(source).toContain('layout.className = "wm-live-drawer-layout"');
    expect(source).toContain('chatStack.className = "wm-live-drawer-layout__main"');
    expect(source).toContain("chatStack.append(main, composerEl);");
    expect(source).toContain("layout.append(drawer.aside, chatStack);");
  });

  test("uses overlay composition on mobile so the drawer can be dismissed without replacing the transcript", () => {
    expect(source).toContain("wrapper.append(main, composerEl);");
    expect(source).toContain("if (drawer.visible && drawer.backdrop) {");
    expect(source).toContain("wrapper.append(drawer.backdrop);");
    expect(source).toContain("wrapper.append(drawer.aside);");
    expect(source).toContain("if (drawer.modal) {");
    expect(source).toContain("wrapper.append(drawer.modal);");
  });
});
