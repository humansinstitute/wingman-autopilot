function describeSession(sessionId, getSessionById, getSessionDisplayName) {
  const session = getSessionById(sessionId);
  const displayName = session ? getSessionDisplayName(session) : "this session";
  return { session, displayName };
}

function confirmStop(displayName) {
  return window.confirm(
    `Are you sure you want to stop "${displayName}"?\n\nThe session will be archived after 5 seconds.`
  );
}

function getErrorMessage(error, fallback) {
  if (error instanceof Error && typeof error.message === "string" && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return fallback;
}

export function createSessionStopFeedback({
  getSessionById,
  getSessionDisplayName,
  stopSession,
  showToast,
}) {
  const pendingSessionIds = new Set();

  async function requestStopSession(sessionId, options = {}) {
    if (!sessionId || pendingSessionIds.has(sessionId)) {
      return { success: false, pending: true };
    }

    const { displayName } = describeSession(sessionId, getSessionById, getSessionDisplayName);
    const shouldConfirm = options.confirm === true;
    if (shouldConfirm && !confirmStop(displayName)) {
      return { success: false, cancelled: true };
    }

    pendingSessionIds.add(sessionId);
    showToast(`Stopping ${displayName}...`, { type: "info" });

    try {
      const result = await stopSession(sessionId);
      if (!result?.success) {
        const message = result?.error || "Unknown error";
        showToast(`Failed to stop ${displayName}: ${message}`, { type: "error", duration: 5000 });
        return { success: false, error: message };
      }

      showToast(`Stopped ${displayName}`, { type: "success" });
      return { success: true };
    } catch (error) {
      const message = getErrorMessage(error, "Unknown error");
      showToast(`Failed to stop ${displayName}: ${message}`, { type: "error", duration: 5000 });
      return { success: false, error: message };
    } finally {
      pendingSessionIds.delete(sessionId);
    }
  }

  function isStopPending(sessionId) {
    return pendingSessionIds.has(sessionId);
  }

  return {
    isStopPending,
    requestStopSession,
  };
}
