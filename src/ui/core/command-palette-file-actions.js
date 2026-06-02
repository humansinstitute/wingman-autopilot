import { addPinnedFileForSession } from "../live/writer-panel-state.js";

export function createCommandPaletteFileActions({
  state,
  sessionsStore,
  getCurrentRoute,
  getPathname,
  getSessionIdFromPath,
  setPinnedArtifact,
  setActiveSession,
  setCurrentRoute,
  render,
} = {}) {
  function getFileBrowserSession() {
    const ss = typeof sessionsStore === "function" ? sessionsStore() : null;
    const sessions = Array.isArray(ss?.items) ? ss.items : [];
    const pathname = typeof getPathname === "function" ? getPathname() : window.location.pathname;
    const routeSessionId = getCurrentRoute?.() === "live"
      ? getSessionIdFromPath?.(pathname)
      : null;
    const candidates = [
      routeSessionId,
      ss?.activeSessionId,
      ss?.lastActiveSessionId,
    ].filter(Boolean);

    for (const sessionId of candidates) {
      const session = sessions.find((entry) => entry?.id === sessionId);
      if (session) return session;
    }
    return null;
  }

  function getFileBrowserInitialPath() {
    const session = getFileBrowserSession();
    return session?.workingDirectory || state?.files?.currentPath || state?.config?.defaultDirectory || "";
  }

  async function pinFileToSession(filePath, { openArtifact = false } = {}) {
    const session = getFileBrowserSession();
    if (!session?.id) {
      throw new Error("No active session is available to pin this file.");
    }
    const result = await setPinnedArtifact?.(session.id, filePath);
    const pinnedFile = result?.pinnedFile ?? null;
    session.pinnedFile = pinnedFile;
    if (pinnedFile) {
      if (state) {
        addPinnedFileForSession(state, session.id, pinnedFile);
      }
    } else {
      state?.pinnedFiles?.delete(session.id);
    }
    if (openArtifact && pinnedFile) {
      setCurrentRoute?.("live");
      setActiveSession?.(session.id, { updateHistory: true, forceLog: true });
      if (state?.writerLayout) {
        state.writerLayout.open = true;
        state.writerLayout.mobileTab = "writer";
      }
      if (state?.appCardLayout) {
        state.appCardLayout.open = false;
      }
      if (state?.artifactsLayout) {
        state.artifactsLayout.open = false;
      }
      if (state?.webviewLayout) {
        state.webviewLayout.open = false;
      }
    }
    render?.();
    return pinnedFile;
  }

  return {
    getFileBrowserSession,
    getFileBrowserInitialPath,
    pinFileToSession,
  };
}
