import { describe, expect, test } from "bun:test";

import { createCommandPaletteFileActions } from "./command-palette-file-actions.js";

function createState() {
  return {
    config: { defaultDirectory: "/workspace" },
    files: { currentPath: "/workspace/current" },
    pinnedFiles: new Map(),
    writerLayout: { open: false, mobileTab: "conversation" },
    appCardLayout: { open: true },
    artifactsLayout: { open: true },
    webviewLayout: { open: true },
  };
}

describe("command palette file actions", () => {
  test("prefers the current live route session for the browser root", () => {
    const state = createState();
    const actions = createCommandPaletteFileActions({
      state,
      sessionsStore: () => ({
        activeSessionId: "active",
        lastActiveSessionId: "last",
        items: [
          { id: "route", workingDirectory: "/workspace/route" },
          { id: "active", workingDirectory: "/workspace/active" },
        ],
      }),
      getCurrentRoute: () => "live",
      getPathname: () => "/live/route",
      getSessionIdFromPath: () => "route",
    });

    expect(actions.getFileBrowserInitialPath()).toBe("/workspace/route");
  });

  test("pins a file and opens the artifact split when requested", async () => {
    const state = createState();
    let route = "home";
    let activated = null;
    const session = { id: "session-1", workingDirectory: "/workspace/session" };
    const actions = createCommandPaletteFileActions({
      state,
      sessionsStore: () => ({ activeSessionId: "session-1", items: [session] }),
      getCurrentRoute: () => route,
      getPathname: () => "/home",
      getSessionIdFromPath: () => null,
      setCurrentRoute: (nextRoute) => {
        route = nextRoute;
      },
      setActiveSession: (sessionId, options) => {
        activated = { sessionId, options };
      },
      setPinnedArtifact: async () => ({ pinnedFile: "/workspace/session/report.md" }),
    });

    const pinnedFile = await actions.pinFileToSession("/workspace/session/report.md", {
      openArtifact: true,
    });

    expect(pinnedFile).toBe("/workspace/session/report.md");
    expect(session.pinnedFile).toBe("/workspace/session/report.md");
    expect(state.pinnedFiles.get("session-1")).toBe("/workspace/session/report.md");
    expect(route).toBe("live");
    expect(activated).toEqual({
      sessionId: "session-1",
      options: { updateHistory: true, forceLog: true },
    });
    expect(state.writerLayout).toEqual({ open: true, mobileTab: "writer" });
    expect(state.appCardLayout.open).toBe(false);
    expect(state.artifactsLayout.open).toBe(false);
    expect(state.webviewLayout.open).toBe(false);
  });

  test("pins to the route session instead of another active session", async () => {
    const state = createState();
    let pinnedSessionId = null;
    const routeSession = { id: "route", workingDirectory: "/workspace/route" };
    const activeSession = { id: "active", workingDirectory: "/workspace/active" };
    const actions = createCommandPaletteFileActions({
      state,
      sessionsStore: () => ({
        activeSessionId: "active",
        items: [routeSession, activeSession],
      }),
      getCurrentRoute: () => "live",
      getPathname: () => "/live/route",
      getSessionIdFromPath: () => "route",
      setPinnedArtifact: async (sessionId, filePath) => {
        pinnedSessionId = sessionId;
        return { pinnedFile: filePath };
      },
    });

    await actions.pinFileToSession("/workspace/route/spec.md");

    expect(pinnedSessionId).toBe("route");
    expect(routeSession.pinnedFile).toBe("/workspace/route/spec.md");
    expect(activeSession.pinnedFile).toBeUndefined();
    expect(state.pinnedFiles.get("route")).toBe("/workspace/route/spec.md");
    expect(state.pinnedFiles.has("active")).toBe(false);
  });

  test("uses an explicit modal session snapshot when pinning", async () => {
    const state = createState();
    let pinnedSessionId = null;
    const modalSession = { id: "modal-session", workingDirectory: "/workspace/modal" };
    const activeSession = { id: "active", workingDirectory: "/workspace/active" };
    const actions = createCommandPaletteFileActions({
      state,
      sessionsStore: () => ({
        activeSessionId: "active",
        items: [activeSession],
      }),
      getCurrentRoute: () => "live",
      getPathname: () => "/live/active",
      getSessionIdFromPath: () => "active",
      setPinnedArtifact: async (sessionId, filePath) => {
        pinnedSessionId = sessionId;
        return { pinnedFile: filePath };
      },
    });

    await actions.pinFileToSession("/workspace/modal/spec.md", { session: modalSession });

    expect(pinnedSessionId).toBe("modal-session");
    expect(modalSession.pinnedFile).toBe("/workspace/modal/spec.md");
    expect(activeSession.pinnedFile).toBeUndefined();
    expect(state.pinnedFiles.get("modal-session")).toBe("/workspace/modal/spec.md");
  });
});
