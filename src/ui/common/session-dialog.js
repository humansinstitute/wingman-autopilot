/**
 * @param {string} root
 * @param {string} name
 */
const buildWorktreePathPreview = (root, name) => {
  const safeRoot = root.trim().replace(/\/+$/, "");
  const suffix = name.trim() || "<name>";
  if (!safeRoot) {
    return `/.worktrees/${suffix}`;
  }
  return `${safeRoot}/.worktrees/${suffix}`;
};

const FILES_FAVORITES_STORAGE_KEY = "wingman-files-favorites";

export const createSessionDialogController = (options) => {
  const {
    dialog,
    agentSelect,
    sessionNameInput,
    directoryInput: providedDirectoryInput,
    directoryFavoritesSelect: providedDirectoryFavoritesSelect,
    advancedToggle,
    advancedPanel,
    workspaceSelect,
    worktreeField,
    worktreeNameInput,
    worktreeHint,
    writerModeCheckbox,
    targetFileInput,
    targetFileField,
    isAuthenticated,
    getConfig,
    getFavouriteDirectories,
    getFallbackDirectory,
    onRequireAuth,
    onDirectoryPrefill,
    onSubmit,
  } = options;
  const directoryInput = providedDirectoryInput ?? document.getElementById("working-directory");
  const directoryFavoritesSelect =
    providedDirectoryFavoritesSelect ?? document.getElementById("working-directory-favourites");

  const readFavouriteDirectoriesFromStorage = () => {
    try {
      const raw = localStorage.getItem(FILES_FAVORITES_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const setAdvancedOpen = (open) => {
    if (advancedToggle) {
      advancedToggle.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (advancedPanel) {
      advancedPanel.hidden = !open;
    }
  };

  const syncWorktreeHint = () => {
    if (!worktreeHint) return;
    const root = directoryInput?.value ?? "";
    const branch = worktreeNameInput?.value ?? "";
    worktreeHint.textContent = `New worktree path: ${buildWorktreePathPreview(root, branch)}`;
  };

  const deriveFavouriteLabel = (entry) => {
    const label = typeof entry?.name === "string" ? entry.name.trim() : "";
    const path = typeof entry?.path === "string" ? entry.path.trim() : "";
    if (label.length > 0) return label;
    if (!path) return "Untitled";
    const normalized = path.replace(/[\\/]+$/, "");
    const separators = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
    if (separators >= 0 && separators < normalized.length - 1) {
      return normalized.slice(separators + 1);
    }
    return normalized || path;
  };

  const getFavouriteDirectoryEntries = () => {
    let raw = typeof getFavouriteDirectories === "function" ? getFavouriteDirectories() : null;
    if (!Array.isArray(raw)) {
      raw = readFavouriteDirectoriesFromStorage();
    }
    if (!Array.isArray(raw)) return [];
    const uniquePaths = new Set();
    const favourites = [];
    raw.forEach((entry) => {
      const path = typeof entry?.path === "string" ? entry.path.trim() : "";
      if (!path || uniquePaths.has(path)) return;
      uniquePaths.add(path);
      favourites.push({ path, name: deriveFavouriteLabel(entry) });
    });
    return favourites;
  };

  const syncFavouriteDirectorySelection = () => {
    if (!directoryFavoritesSelect || !directoryInput) return;
    const currentPath = directoryInput.value.trim();
    if (!currentPath) {
      directoryFavoritesSelect.value = "";
      return;
    }
    const hasExactMatch = Array.from(directoryFavoritesSelect.options).some((option) => option.value === currentPath);
    directoryFavoritesSelect.value = hasExactMatch ? currentPath : "";
  };

  const renderFavouriteDirectoryOptions = () => {
    if (!directoryFavoritesSelect) return;
    const favourites = getFavouriteDirectoryEntries();
    const emptyLabel = "No file favourites yet";
    const promptLabel = "Select a favourite folder";
    directoryFavoritesSelect.innerHTML = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = favourites.length > 0 ? promptLabel : emptyLabel;
    directoryFavoritesSelect.append(placeholder);

    favourites.forEach((favourite) => {
      const option = document.createElement("option");
      option.value = favourite.path;
      option.textContent = `${favourite.name} — ${favourite.path}`;
      directoryFavoritesSelect.append(option);
    });

    directoryFavoritesSelect.disabled = favourites.length === 0;
    if (directoryFavoritesSelect.parentElement) {
      if (favourites.length === 0) {
        directoryFavoritesSelect.parentElement.dataset.empty = "true";
      } else {
        delete directoryFavoritesSelect.parentElement.dataset.empty;
      }
    }
    syncFavouriteDirectorySelection();
  };

  const syncWorkspaceFields = () => {
    const mode = workspaceSelect?.value ?? "";
    const showWorktree = mode === "worktree";
    if (worktreeField) {
      worktreeField.hidden = !showWorktree;
    }
    if (worktreeNameInput) {
      worktreeNameInput.setCustomValidity("");
    }
    syncWorktreeHint();
  };

  const resetFormState = () => {
    setAdvancedOpen(false);
    if (workspaceSelect) {
      workspaceSelect.value = "";
    }
    if (worktreeNameInput) {
      worktreeNameInput.value = "";
      worktreeNameInput.setCustomValidity("");
    }
    if (writerModeCheckbox) {
      writerModeCheckbox.checked = false;
    }
    if (targetFileInput) {
      targetFileInput.value = "";
    }
    if (targetFileField) {
      targetFileField.hidden = true;
    }
    if (directoryFavoritesSelect) {
      directoryFavoritesSelect.value = "";
    }
    syncWorkspaceFields();
  };

  const close = () => {
    if (dialog?.open) {
      dialog.close();
    }
    if (sessionNameInput) {
      sessionNameInput.value = "";
    }
  };

  const collectValues = () => {
    const agentId = agentSelect?.value ?? "";
    const workingDirectory = directoryInput?.value ?? "";
    const sessionName = sessionNameInput?.value ?? "";
    const workspace =
      workspaceSelect?.value === "worktree"
        ? { mode: "worktree", name: (worktreeNameInput?.value ?? "").trim() }
        : null;
    const writerMode = writerModeCheckbox?.checked ?? false;
    const targetFile = writerMode ? (targetFileInput?.value?.trim() || null) : null;
    return { agentId, workingDirectory, sessionName, workspace, targetFile };
  };

  const handleSubmit = () => {
    const values = collectValues();
    if (values.workspace?.mode === "worktree" && !values.workspace.name) {
      if (worktreeNameInput) {
        worktreeNameInput.setCustomValidity("Enter a worktree name");
        worktreeNameInput.reportValidity();
        worktreeNameInput.focus();
      }
      return;
    }
    if (worktreeNameInput) {
      worktreeNameInput.setCustomValidity("");
    }
    close();
    onSubmit(values);
  };

  const open = () => {
    if (!isAuthenticated()) {
      onRequireAuth();
      return;
    }
    const config = getConfig();
    if (!config) return;

    resetFormState();
    const fallbackDirectory = getFallbackDirectory();
    if (directoryInput) {
      directoryInput.value = fallbackDirectory;
      onDirectoryPrefill?.(fallbackDirectory);
    }
    renderFavouriteDirectoryOptions();
    if (sessionNameInput) {
      sessionNameInput.value = "";
    }

    if (typeof dialog?.showModal === "function") {
      dialog.showModal();
      if (sessionNameInput) {
        sessionNameInput.focus();
        sessionNameInput.select();
      } else {
        directoryInput?.focus();
        directoryInput?.select();
      }
      syncWorktreeHint();
      return;
    }

    const agent = window.prompt(
      `Select agent (${config.agents.map((a) => a.id).join(", ")}):`,
      config.agents[0]?.id ?? "",
    );
    if (agent) {
      const directory = window.prompt("Working directory:", fallbackDirectory) ?? fallbackDirectory;
      const name = window.prompt("Session name (optional):", "") ?? "";
      onSubmit({ agentId: agent, workingDirectory: directory, sessionName: name, workspace: null });
    }
  };

  writerModeCheckbox?.addEventListener("change", () => {
    if (targetFileField) {
      targetFileField.hidden = !writerModeCheckbox.checked;
    }
    if (writerModeCheckbox.checked && targetFileInput) {
      targetFileInput.focus();
    }
  });

  advancedToggle?.addEventListener("click", () => {
    const expanded = advancedToggle.getAttribute("aria-expanded") === "true";
    setAdvancedOpen(!expanded);
  });

  workspaceSelect?.addEventListener("change", () => {
    syncWorkspaceFields();
  });

  worktreeNameInput?.addEventListener("input", () => {
    if (worktreeNameInput.value.trim().length > 0) {
      worktreeNameInput.setCustomValidity("");
    }
    syncWorktreeHint();
  });

  directoryFavoritesSelect?.addEventListener("focus", () => {
    renderFavouriteDirectoryOptions();
  });

  directoryFavoritesSelect?.addEventListener("change", () => {
    const selectedPath = directoryFavoritesSelect.value;
    if (!selectedPath || !directoryInput) return;
    directoryInput.value = selectedPath;
    onDirectoryPrefill?.(selectedPath);
    syncWorktreeHint();
    directoryInput.focus();
  });

  directoryInput?.addEventListener("input", () => {
    syncWorktreeHint();
    syncFavouriteDirectorySelection();
  });

  return {
    open,
    close,
    handleSubmit,
    syncWorktreeHint,
    collectValues,
    resetFormState,
  };
};
