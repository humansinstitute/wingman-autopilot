import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./live-view.js", import.meta.url), "utf8");

describe("live-view drawer integration", () => {
  test("relies on the drawer overlay and composer command menu instead of a dedicated header bar", () => {
    expect(source).toContain("createLiveSessionDrawer");
    expect(source).not.toContain("createLiveSessionToolbar");
    expect(source).toContain("main.append(scrollRegion);");
  });

  test("keeps the transcript stack intact while the drawer overlays from the left", () => {
    expect(source).toContain("wrapper.append(main, composerEl);");
    expect(source).toContain("if (drawer.visible) {");
    expect(source).toContain("wrapper.append(drawer.aside);");
  });

  test("uses overlay composition on mobile so the drawer can be dismissed without replacing the transcript", () => {
    expect(source).toContain("wrapper.append(main, composerEl);");
    expect(source).toContain("if (drawer.visible && drawer.backdrop) {");
    expect(source).toContain("wrapper.append(drawer.backdrop);");
    expect(source).toContain("wrapper.append(drawer.aside);");
    expect(source).toContain("if (drawer.modal) {");
    expect(source).toContain("wrapper.append(drawer.modal);");
  });

  test("offers native resume from archived transcripts", () => {
    expect(source).toContain("canResumeNativeAgentSession(state.archivedSession.session)");
    expect(source).toContain("resume-native-archived-live-session");
    expect(source).toContain("await resumeNativeSession(routeSessionId);");
  });

  test("renders live sessions as one unfiltered tab list", () => {
    expect(source).toContain('tabs.setAttribute("role", "tablist")');
    expect(source).toContain('panel.append(renderTabs({ sessions: getActiveSessions() }))');
    expect(source).not.toContain("wm-live-tab-groups");
    expect(source).not.toContain("filterSessionsForLiveTabGroup");
  });

  test("shows session context above the composer", () => {
    expect(source).toContain("wm-composer-context");
    expect(source).toContain("wm-composer-input-column");
    expect(source).toContain("renderComposerContext(sessionId)");
    expect(source).toContain("resolveSessionAgentLabel(session)");
  });
});
