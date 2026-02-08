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

export const createSessionDialogController = (options) => {
  const {
    dialog,
    agentSelect,
    sessionNameInput,
    directoryInput,
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
    getFallbackDirectory,
    onRequireAuth,
    onDirectoryPrefill,
    onSubmit,
  } = options;

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

  directoryInput?.addEventListener("input", () => {
    syncWorktreeHint();
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
