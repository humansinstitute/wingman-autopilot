const DEFAULT_LIVE_ROUTE_PREFIX = "/live";
const MOBILE_SESSION_LAUNCH_MEDIA_QUERY = "(max-width: 720px)";

const normalizeString = (value) => {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "";
};

const shouldLaunchSessionInCurrentTab = () => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia(MOBILE_SESSION_LAUNCH_MEDIA_QUERY).matches;
  } catch {
    return false;
  }
};

function openPendingSessionWindow() {
  try {
    const pendingWindow = window.open("about:blank", "_blank");
    if (!pendingWindow) {
      return null;
    }
    try {
      pendingWindow.document.title = "Launching session";
      if (pendingWindow.document.body) {
        pendingWindow.document.body.textContent = "Launching session...";
      }
    } catch {
      // Ignore DOM access failures for the placeholder window.
    }
    return pendingWindow;
  } catch {
    return null;
  }
}

function closePendingSessionWindow(pendingWindow) {
  if (!pendingWindow || pendingWindow.closed) {
    return;
  }
  try {
    pendingWindow.close();
  } catch {
    // Ignore close failures.
  }
}

function navigatePendingSessionWindow(pendingWindow, sessionUrl) {
  if (!pendingWindow || pendingWindow.closed) {
    return false;
  }
  try {
    pendingWindow.opener = null;
  } catch {
    // Ignore opener isolation failures.
  }
  try {
    pendingWindow.location.replace(sessionUrl);
    return true;
  } catch {
    return false;
  }
}

export const buildSessionOrigin = ({ type, id, url, label }) => {
  const normalizedType = normalizeString(type);
  const normalizedId = normalizeString(id);
  if (!normalizedType || !normalizedId) {
    return null;
  }
  const origin = { type: normalizedType, id: normalizedId };
  const normalizedUrl = normalizeString(url);
  const normalizedLabel = normalizeString(label);
  if (normalizedUrl) {
    origin.url = normalizedUrl;
  }
  if (normalizedLabel) {
    origin.label = normalizedLabel;
  }
  return origin;
};

export const createSessionLauncher = ({ handleSessionStart, liveRoutePrefix, notify } = {}) => {
  if (typeof handleSessionStart !== "function") {
    throw new Error("handleSessionStart callback is required to launch sessions.");
  }
  const routePrefix =
    typeof liveRoutePrefix === "string" && liveRoutePrefix.trim().length > 0
      ? liveRoutePrefix
      : DEFAULT_LIVE_ROUTE_PREFIX;

  return async (agentId, workingDirectory, name, workspace, options = {}) => {
    const normalizedAgent = typeof agentId === "string" ? agentId.trim() : "";
    if (!normalizedAgent) {
      if (typeof notify === "function") {
        notify("Select an agent before launching a session.", { type: "warning" });
      } else {
        window.alert("Select an agent before launching a session.");
      }
      return;
    }

    const {
      openInNewTab = false,
      origin = null,
      initialPrompt = null,
      targetFile = null,
      nightwatch = null,
      metadata = null,
    } = options ?? {};
    const payload = { agent: normalizedAgent };
    const trimmedName = typeof name === "string" ? name.trim() : "";
    if (trimmedName.length > 0) {
      payload.name = trimmedName.slice(0, 120);
    }
    if (typeof workingDirectory === "string" && workingDirectory.trim().length > 0) {
      payload.directory = workingDirectory.trim();
    }
    if (workspace && workspace.mode === "worktree" && workspace.name) {
      payload.workspace = { mode: "worktree", name: workspace.name };
    }
    if (origin && typeof origin === "object") {
      payload.origin = origin;
    }
    if (typeof initialPrompt === "string" && initialPrompt.trim().length > 0) {
      payload.initialPrompt = initialPrompt.trim();
    }
    if (typeof targetFile === "string" && targetFile.trim().length > 0) {
      payload.targetFile = targetFile.trim();
    }
    if (nightwatch && typeof nightwatch === "object") {
      payload.nightwatch = nightwatch;
    }
    if (metadata && typeof metadata === "object") {
      payload.metadata = metadata;
    }

    const canAttemptNewTab = openInNewTab && !shouldLaunchSessionInCurrentTab();
    const pendingWindow = canAttemptNewTab ? openPendingSessionWindow() : null;

    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      closePendingSessionWindow(pendingWindow);
      const data = await response.json().catch(() => ({}));
      const message = `Failed to start session: ${data.error ?? response.statusText}`;
      if (typeof notify === "function") {
        notify(message, { type: "error" });
      } else {
        window.alert(message);
      }
      return;
    }

    const session = await response.json();
    let openedInNewTab = false;
    if (session?.id) {
      // Keep the draft in localStorage so either tab mode can hydrate the composer.
      if (typeof initialPrompt === "string" && initialPrompt.trim().length > 0) {
        try {
          localStorage.setItem(`session-draft-${session.id}`, initialPrompt.trim());
        } catch {
          // Ignore localStorage errors
        }
      }

      if (canAttemptNewTab) {
        const sessionUrl = `${routePrefix}/${session.id}`;
        openedInNewTab = navigatePendingSessionWindow(pendingWindow, sessionUrl);
        if (!openedInNewTab) {
          closePendingSessionWindow(pendingWindow);
        }
      }
    } else {
      closePendingSessionWindow(pendingWindow);
    }
    await handleSessionStart(session, {
      suppressRouteChange: openedInNewTab,
      activateSessionInOriginWindow: !openedInNewTab,
    });
  };
};
