export function getPinnedFileForSession(state, sessionId, serverPinnedFile = null) {
  return state.pinnedFiles.get(sessionId) ?? serverPinnedFile ?? null;
}

export function syncPinnedFileForSession(state, sessionId, serverPinnedFile = null) {
  const currentPinnedFile = state.pinnedFiles.get(sessionId) ?? null;
  if (serverPinnedFile) {
    if (currentPinnedFile !== serverPinnedFile) {
      state.pinnedFiles.set(sessionId, serverPinnedFile);
    }
    return;
  }
  if (currentPinnedFile) {
    state.pinnedFiles.delete(sessionId);
  }
}

export function clearWriterDismissal(state, sessionId) {
  state.writerDismissedFiles.delete(sessionId);
}

export function markWriterDismissed(state, sessionId, effectiveFile = null) {
  if (!effectiveFile) {
    state.writerDismissedFiles.delete(sessionId);
    return;
  }
  state.writerDismissedFiles.set(sessionId, effectiveFile);
}

export function isWriterDismissed(state, sessionId, effectiveFile = null) {
  if (!effectiveFile) return false;
  return state.writerDismissedFiles.get(sessionId) === effectiveFile;
}

export function shouldAutoOpenWriter(state, sessionId, effectiveFile = null) {
  if (!effectiveFile) return false;
  if (state.writerLayout.open) return false;
  return !isWriterDismissed(state, sessionId, effectiveFile);
}
