function normalizeFilePath(filePath) {
  return typeof filePath === "string" && filePath.trim().length > 0
    ? filePath.trim()
    : null;
}

function normalizePinnedFileInputs(value) {
  const rawValues = Array.isArray(value) ? value : [value];
  const pinnedFiles = [];
  for (const rawValue of rawValues) {
    const normalized = normalizeFilePath(rawValue);
    if (normalized && !pinnedFiles.includes(normalized)) {
      pinnedFiles.push(normalized);
    }
  }
  return pinnedFiles;
}

function getPinnedFileList(state, sessionId) {
  if (!state) return [];
  if (!state.pinnedFileLists) {
    state.pinnedFileLists = new Map();
  }
  const existing = state.pinnedFileLists.get(sessionId);
  if (Array.isArray(existing)) {
    return existing;
  }
  const legacyPinnedFile = normalizeFilePath(state.pinnedFiles?.get(sessionId));
  const list = legacyPinnedFile ? [legacyPinnedFile] : [];
  state.pinnedFileLists.set(sessionId, list);
  return list;
}

function setActivePinnedFileIndex(state, sessionId, index) {
  if (!state.pinnedFileIndexes) {
    state.pinnedFileIndexes = new Map();
  }
  const list = getPinnedFileList(state, sessionId);
  if (list.length === 0) {
    state.pinnedFileIndexes.delete(sessionId);
    state.pinnedFiles?.delete(sessionId);
    return null;
  }
  const boundedIndex = Math.min(Math.max(index, 0), list.length - 1);
  state.pinnedFileIndexes.set(sessionId, boundedIndex);
  state.pinnedFiles?.set(sessionId, list[boundedIndex]);
  return list[boundedIndex];
}

export function getPinnedFilesForSession(state, sessionId, serverPinnedFile = null) {
  const serverPinnedFiles = normalizePinnedFileInputs(serverPinnedFile);
  const list = getPinnedFileList(state, sessionId);
  for (const serverPinnedFilePath of serverPinnedFiles) {
    if (!list.includes(serverPinnedFilePath)) {
      list.push(serverPinnedFilePath);
    }
  }
  if (list.length > 0) {
    const activeIndex = state.pinnedFileIndexes?.get(sessionId) ?? list.length - 1;
    setActivePinnedFileIndex(state, sessionId, activeIndex);
  }
  return [...list];
}

export function getPinnedFileForSession(state, sessionId, serverPinnedFile = null) {
  const files = getPinnedFilesForSession(state, sessionId, serverPinnedFile);
  const activeIndex = state.pinnedFileIndexes?.get(sessionId) ?? 0;
  return files[activeIndex] ?? null;
}

export function addPinnedFileForSession(state, sessionId, filePath) {
  if (!state) return null;
  const normalizedFilePath = normalizeFilePath(filePath);
  if (!normalizedFilePath) return null;
  const list = getPinnedFileList(state, sessionId);
  const existingIndex = list.indexOf(normalizedFilePath);
  const activeIndex = existingIndex >= 0 ? existingIndex : list.push(normalizedFilePath) - 1;
  return setActivePinnedFileIndex(state, sessionId, activeIndex);
}

export function setPinnedFilePageForSession(state, sessionId, index) {
  if (!state) return null;
  return setActivePinnedFileIndex(state, sessionId, index);
}

export function getPinnedFilePageForSession(state, sessionId, serverPinnedFile = null) {
  const files = getPinnedFilesForSession(state, sessionId, serverPinnedFile);
  const activeIndex = state.pinnedFileIndexes?.get(sessionId) ?? 0;
  return {
    files,
    activeIndex: files.length === 0 ? -1 : Math.min(Math.max(activeIndex, 0), files.length - 1),
    activeFile: files[Math.min(Math.max(activeIndex, 0), Math.max(files.length - 1, 0))] ?? null,
  };
}

export function syncPinnedFileForSession(state, sessionId, serverPinnedFile = null) {
  if (!state) return;
  const serverPinnedFiles = normalizePinnedFileInputs(serverPinnedFile);
  if (serverPinnedFiles.length > 0) {
    const list = getPinnedFileList(state, sessionId);
    for (const serverPinnedFilePath of serverPinnedFiles) {
      if (!list.includes(serverPinnedFilePath)) {
        list.push(serverPinnedFilePath);
      }
    }
    const activeIndex = state.pinnedFileIndexes?.get(sessionId);
    setActivePinnedFileIndex(
      state,
      sessionId,
      typeof activeIndex === "number" ? activeIndex : list.indexOf(serverPinnedFiles[serverPinnedFiles.length - 1]),
    );
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
