export const initAppDialogs = ({
  state,
  getCurrentRoute,
  render,
  refreshApps,
  getAppById,
  openDirectoryBrowser,
  formatWebAppUrl,
  linkAppToProject,
  deriveAppWindowName,
  sharedTmuxSession,
  showToast,
}) => {
  const appDialog = document.getElementById("app-dialog");
  const appForm = appDialog?.querySelector("form") ?? null;
  const appDialogTitle = document.getElementById("app-dialog-title");
  const appLabelInput = document.getElementById("app-label");
  const appRootInput = document.getElementById("app-root");
  const appRootBrowseButton = document.getElementById("app-root-browse");
  const appAdvancedSection = document.getElementById("app-advanced");
  const appTmuxInput = document.getElementById("app-tmux-session");
  const appTmuxWindowInput = document.getElementById("app-tmux-window");
  const appNotesInput = document.getElementById("app-notes");
  const appDiscoverToggle = document.getElementById("app-discover-enabled");
  const appDiscoverButton = document.getElementById("app-discover");
  const appWebAppToggle = document.getElementById("app-web-app");
  const appWebAppPortNote = document.getElementById("app-web-app-port");
  const appScriptInputs = {
    start: document.getElementById("app-script-start"),
    stop: document.getElementById("app-script-stop"),
    restart: document.getElementById("app-script-restart"),
    build: document.getElementById("app-script-build"),
    setup: document.getElementById("app-script-setup"),
  };
  const appLogsDialog = document.getElementById("app-logs-dialog");
  const appLogsTitle = document.getElementById("app-logs-title");
  const appLogsContent = document.getElementById("app-logs-content");
  const appLogsRefreshButton = document.getElementById("app-logs-refresh");
  const appLogsCloseButton = document.getElementById("app-logs-close");
  const appCloneButton = document.getElementById("app-clone");
  const appCloneDialog = document.getElementById("app-clone-dialog");
  const appCloneForm = appCloneDialog?.querySelector("form") ?? null;
  const appCloneUrlInput = document.getElementById("app-clone-url");
  const appCloneNameInput = document.getElementById("app-clone-name");
  const appCloneCancelButton = document.getElementById("app-clone-cancel");
  const appCloneConfirmButton = document.getElementById("app-clone-confirm");

  const appDialogState = {
    mode: "create",
    appId: null,
    webAppEnabled: false,
    webAppPort: null,
    projectContext: null,
  };

  const deriveRepositoryFolderName = (input) => {
    if (!input) return "";
    const trimmed = input.trim();
    if (!trimmed) return "";
    const normalized = trimmed.replace(/\\+/g, "/");
    const parts = normalized.split(/[/:]/).filter(Boolean);
    if (parts.length === 0) return "";
    const candidate = parts[parts.length - 1].replace(/\.git$/i, "");
    return candidate;
  };

  const humaniseFolderLabel = (value) => {
    if (!value) return "";
    const spaced = value.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    if (!spaced) return "";
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  };

  const updateAppWindowPreview = () => {
    if (!appTmuxWindowInput) return;
    if (appTmuxWindowInput.dataset.locked === "true") return;
    const label = appLabelInput?.value ?? "";
    const root = appRootInput?.value ?? "";
    appTmuxWindowInput.value = deriveAppWindowName(label, root);
  };

  const setAppDialogSubmitting = (submitting) => {
    if (!appForm) return;
    const elements = Array.from(appForm.elements);
    for (const element of elements) {
      if (
        element instanceof HTMLButtonElement ||
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
      ) {
        if (element.dataset.role === "cancel") continue;
        element.disabled = submitting;
      }
    }
    if (appDialog) {
      if (submitting) {
        appDialog.dataset.submitting = "true";
      } else {
        delete appDialog.dataset.submitting;
      }
    }
  };

  const syncAppWebAppPortNote = ({ enabled, port } = {}) => {
    if (!appWebAppPortNote) return;
    while (appWebAppPortNote.firstChild) {
      appWebAppPortNote.firstChild.remove();
    }
    const hasToggle = appWebAppToggle instanceof HTMLInputElement;
    const isEnabled = typeof enabled === "boolean" ? enabled : hasToggle ? appWebAppToggle.checked : false;
    const assignedPort =
      typeof port === "number"
        ? port
        : typeof appDialogState.webAppPort === "number"
          ? appDialogState.webAppPort
          : null;

    if (!isEnabled) {
      appWebAppPortNote.textContent = "Wingman will assign a dedicated port when you save.";
      return;
    }

    if (typeof assignedPort === "number") {
      appWebAppPortNote.textContent = "Reserved port: ";
      const code = document.createElement("code");
      code.textContent = String(assignedPort);
      appWebAppPortNote.append(code);
      const separator = document.createTextNode(" ");
      appWebAppPortNote.append(separator);
      const href = formatWebAppUrl(assignedPort);
      if (href) {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open";
        appWebAppPortNote.append(link);
      }
      return;
    }

    appWebAppPortNote.textContent = "A reserved port will be attached to this app after you save.";
  };

  const resetAppDialog = () => {
    if (appForm) {
      appForm.reset();
    }
    if (appDialogTitle) {
      appDialogTitle.textContent = "Add App";
    }
    if (appDiscoverToggle) {
      appDiscoverToggle.checked = true;
    }
    if (appAdvancedSection) {
      appAdvancedSection.open = false;
    }
    Object.values(appScriptInputs).forEach((input) => {
      if (input) {
        input.value = "";
      }
    });
    if (appTmuxInput) {
      appTmuxInput.value = sharedTmuxSession;
    }
    if (appTmuxWindowInput) {
      delete appTmuxWindowInput.dataset.locked;
      appTmuxWindowInput.value = deriveAppWindowName(appLabelInput?.value ?? "", appRootInput?.value ?? "");
    }
    if (appNotesInput) {
      appNotesInput.value = "";
    }
    if (appWebAppToggle) {
      appWebAppToggle.checked = false;
    }
    appDialogState.webAppEnabled = false;
    appDialogState.webAppPort = null;
    appDialogState.projectContext = null;
    syncAppWebAppPortNote({ enabled: false, port: null });
    appDialogState.mode = "create";
    appDialogState.appId = null;
  };

  const populateAppDialog = (app) => {
    if (!app) return;
    if (appDialogTitle) {
      appDialogTitle.textContent = "Edit App";
    }
    if (appLabelInput) {
      appLabelInput.value = app.label ?? "";
    }
    if (appRootInput) {
      appRootInput.value = app.root ?? "";
    }
    if (appTmuxInput) {
      appTmuxInput.value = sharedTmuxSession;
    }
    if (appTmuxWindowInput) {
      appTmuxWindowInput.dataset.locked = "true";
      appTmuxWindowInput.value =
        app.tmuxWindow ?? app.tmuxSession ?? deriveAppWindowName(app.label ?? "", app.root ?? "");
    }
    if (appNotesInput) {
      appNotesInput.value = app.notes ?? "";
    }
    Object.entries(appScriptInputs).forEach(([action, input]) => {
      if (!input) return;
      input.value = app.scripts?.[action] ?? "";
    });
    const webAppEnabled = Boolean(app.webApp);
    appDialogState.webAppEnabled = webAppEnabled;
    appDialogState.webAppPort = typeof app.webAppPort === "number" ? app.webAppPort : null;
    if (appWebAppToggle) {
      appWebAppToggle.checked = webAppEnabled;
    }
    syncAppWebAppPortNote({ enabled: webAppEnabled, port: appDialogState.webAppPort });
    if (appAdvancedSection) {
      const hasScript = Object.values(app.scripts ?? {}).some(
        (value) => typeof value === "string" && value.length > 0,
      );
      const inferredWindow = deriveAppWindowName(app.label ?? "", app.root ?? "");
      const hasCustomWindow = Boolean(app.tmuxWindow && app.tmuxWindow !== inferredWindow);
      appAdvancedSection.open = hasScript || hasCustomWindow;
    }
  };

  const collectAppFormValues = () => {
    const label = appLabelInput?.value?.trim() ?? "";
    const root = appRootInput?.value?.trim() ?? "";
    const notesRaw = appNotesInput?.value ?? "";
    const notesTrimmed = notesRaw.trim();
    const scripts = {};
    for (const [action, input] of Object.entries(appScriptInputs)) {
      if (!input) continue;
      const value = input.value.trim();
      if (value.length > 0) {
        scripts[action] = value;
      }
    }
    const discoverScripts = appDiscoverToggle ? appDiscoverToggle.checked : true;
    const webApp = appWebAppToggle ? appWebAppToggle.checked : false;
    return { label, root, notesRaw, notesTrimmed, scripts, discoverScripts, webApp };
  };

  const handleAppFormSubmit = async (event) => {
    event.preventDefault();
    const values = collectAppFormValues();
    if (!values.root) {
      window.alert("Provide a root directory for the app.");
      appRootInput?.focus();
      return;
    }

    const scriptsPayload = Object.keys(values.scripts).length > 0 ? values.scripts : undefined;
    const mode = appDialogState.mode;
    const appId = appDialogState.appId;
    const projectContext = appDialogState.projectContext;

    let url;
    let method;
    let body;

    if (mode === "edit" && appId) {
      url = `/api/apps/${encodeURIComponent(appId)}`;
      method = "PUT";
      body = {
        label: values.label ? values.label : undefined,
        root: values.root,
        scripts: scriptsPayload,
        notes:
          values.notesRaw.length === 0
            ? null
            : values.notesTrimmed.length > 0
              ? values.notesTrimmed
              : undefined,
        discoverScripts: values.discoverScripts,
        webApp: values.webApp,
      };
    } else {
      url = "/api/apps";
      method = "POST";
      body = {
        label: values.label,
        root: values.root,
        scripts: scriptsPayload,
        notes: values.notesTrimmed.length > 0 ? values.notesTrimmed : undefined,
        discoverScripts: values.discoverScripts,
        webApp: values.webApp,
      };
    }

    setAppDialogSubmitting(true);
    try {
      const response = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to save app";
        throw new Error(message);
      }
      const createdApp = mode === "create" ? payload?.app : null;
      closeAppDialog();
      await refreshApps({ skipRender: false });
      if (createdApp && projectContext) {
        await linkAppToProject(projectContext, createdApp);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save app";
      window.alert(message);
    } finally {
      setAppDialogSubmitting(false);
    }
  };

  const openAppDialog = (appId = null, options = {}) => {
    if (!appDialog) return;
    resetAppDialog();
    if (options?.projectContext) {
      appDialogState.projectContext = options.projectContext;
      if (appDialogTitle) {
        const projectName = options.projectContext.projectName?.trim();
        appDialogTitle.textContent = projectName ? `Add App · ${projectName}` : "Add App";
      }
      if (appRootInput && options.projectContext.rootPath) {
        appRootInput.value = options.projectContext.rootPath;
        updateAppWindowPreview();
      }
      if (appLabelInput && options.projectContext.defaultLabel && !appLabelInput.value) {
        appLabelInput.value = options.projectContext.defaultLabel;
        updateAppWindowPreview();
      }
    }
    if (appId) {
      const app = getAppById(appId);
      if (!app) return;
      appDialogState.mode = "edit";
      appDialogState.appId = appId;
      populateAppDialog(app);
    }
    if (appDialog.open) {
      appDialog.close();
    }
    appDialog.showModal();
    (appLabelInput ?? appRootInput)?.focus();
  };

  const closeAppDialog = () => {
    if (!appDialog) return;
    if (appDialog.open) {
      appDialog.close();
    }
    resetAppDialog();
  };

  const handleAppDiscover = async (event) => {
    event.preventDefault();
    if (!appRootInput) return;
    const root = appRootInput.value.trim();
    if (!root) {
      window.alert("Enter the app root directory before discovering scripts.");
      appRootInput.focus();
      return;
    }
    if (appDiscoverButton) {
      appDiscoverButton.disabled = true;
    }
    try {
      const response = await fetch(`/api/apps/discover?root=${encodeURIComponent(root)}`);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to discover scripts";
        throw new Error(message);
      }
      const scripts = payload && typeof payload === "object" ? (payload.scripts ?? {}) : {};
      let applied = 0;
      for (const [action, input] of Object.entries(appScriptInputs)) {
        if (!input) continue;
        const candidate = scripts?.[action];
        if (typeof candidate === "string" && candidate.trim().length > 0) {
          input.value = candidate;
          applied += 1;
        }
      }
      if (applied === 0) {
        window.alert("No scripts discovered. Enter commands manually.");
      } else if (appAdvancedSection) {
        appAdvancedSection.open = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to discover scripts";
      window.alert(message);
    } finally {
      if (appDiscoverButton) {
        appDiscoverButton.disabled = false;
      }
    }
  };

  const applyClonedAppDefaults = (payload) => {
    if (!payload || typeof payload !== "object") return;
    const root = typeof payload.root === "string" ? payload.root : "";
    if (root && appRootInput) {
      appRootInput.value = root;
      updateAppWindowPreview();
      state.lastWorkingDirectory = root;
    }
    const suggestedLabel = typeof payload.label === "string" ? payload.label : "";
    if (suggestedLabel && appLabelInput && appLabelInput.value.trim().length === 0) {
      appLabelInput.value = suggestedLabel;
      updateAppWindowPreview();
    }
    const scripts = payload.scripts;
    if (scripts && typeof scripts === "object") {
      let applied = 0;
      for (const [action, command] of Object.entries(scripts)) {
        const input = appScriptInputs[action];
        if (!input || typeof command !== "string") continue;
        if (input.value.trim().length === 0) {
          input.value = command;
          applied += 1;
        }
      }
      if (applied > 0 && appAdvancedSection) {
        appAdvancedSection.open = true;
      }
    }
    if (appDiscoverToggle) {
      appDiscoverToggle.checked = false;
    }
  };

  const closeAppCloneDialog = () => {
    if (!appCloneDialog) return;
    if (appCloneDialog.open) {
      appCloneDialog.close();
    }
    appCloneForm?.reset();
  };

  const openAppCloneDialog = () => {
    if (!appCloneDialog) return;
    appCloneForm?.reset();
    if (appCloneNameInput && appLabelInput && appLabelInput.value.trim().length > 0) {
      appCloneNameInput.value = appLabelInput.value.trim().toLowerCase().replace(/\s+/g, "-");
    }
    appCloneDialog.showModal();
    appCloneUrlInput?.focus();
  };

  const handleAppCloneSubmit = async (event) => {
    event.preventDefault();
    if (!appCloneUrlInput || !appCloneConfirmButton) return;
    const repoUrl = appCloneUrlInput.value.trim();
    let folderName = appCloneNameInput?.value.trim() ?? "";
    if (!repoUrl) {
      window.alert("Provide a repository URL to clone.");
      appCloneUrlInput.focus();
      return;
    }
    if (!folderName) {
      folderName = deriveRepositoryFolderName(repoUrl);
      if (appCloneNameInput) {
        appCloneNameInput.value = folderName;
      }
    }
    if (!folderName) {
      window.alert("Provide a folder name for the cloned repository.");
      appCloneNameInput?.focus();
      return;
    }

    appCloneConfirmButton.disabled = true;
    try {
      const response = await fetch("/api/apps/clone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: repoUrl, directory: folderName }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to clone repository";
        throw new Error(message);
      }
      applyClonedAppDefaults(payload ?? {});
      if (payload && typeof payload === "object" && typeof payload.root === "string" && appCloneNameInput) {
        const labelSuggestion =
          typeof payload.label === "string" && payload.label.trim().length > 0
            ? payload.label.trim()
            : humaniseFolderLabel(folderName);
        if (labelSuggestion && appLabelInput && appLabelInput.value.trim().length === 0) {
          appLabelInput.value = labelSuggestion;
          updateAppWindowPreview();
        }
      }
      closeAppCloneDialog();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to clone repository";
      window.alert(message);
    } finally {
      appCloneConfirmButton.disabled = false;
    }
  };

  const openAppLogsDialog = async (appId) => {
    if (!appLogsDialog) return;
    const app = getAppById(appId);
    if (appLogsTitle) {
      appLogsTitle.textContent = app?.label ?? appId;
    }
    state.appLogViewer.appId = appId;
    state.appLogViewer.title = app?.label ?? appId;
    state.appLogViewer.lines = [];
    state.appLogViewer.loading = true;
    if (appLogsContent) {
      appLogsContent.textContent = "Loading logs…";
    }
    if (appLogsDialog.open) {
      appLogsDialog.close();
    }
    appLogsDialog.showModal();
    await refreshAppLogs(appId);
  };

  const refreshAppLogs = async (appId, { tail } = {}) => {
    const targetId = appId ?? state.appLogViewer.appId;
    if (!targetId) return;
    const tailSize = typeof tail === "number" && tail > 0 ? tail : state.appLogViewer.tail;
    state.appLogViewer.loading = true;
    try {
      const response = await fetch(
        `/api/apps/${encodeURIComponent(targetId)}/logs?tail=${encodeURIComponent(String(tailSize))}`,
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to load logs";
        throw new Error(message);
      }
      const lines = Array.isArray(payload?.logs) ? payload.logs : [];
      state.appLogViewer.lines = lines;
      if (appLogsContent) {
        appLogsContent.textContent = lines.length > 0 ? lines.join("\n") : "No log output yet.";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load logs";
      if (appLogsContent) {
        appLogsContent.textContent = `Error: ${message}`;
      }
    } finally {
      state.appLogViewer.loading = false;
    }
  };

  const closeAppLogsDialog = () => {
    if (!appLogsDialog) return;
    if (appLogsDialog.open) {
      appLogsDialog.close();
      return;
    }
    state.appLogViewer.appId = null;
    state.appLogViewer.title = "";
    state.appLogViewer.lines = [];
    state.appLogViewer.loading = false;
  };

  if (appLabelInput) {
    appLabelInput.addEventListener("input", () => {
      if (appDialogState.mode === "edit" && appTmuxWindowInput?.dataset.locked === "true") {
        return;
      }
      updateAppWindowPreview();
    });
  }

  if (appRootInput) {
    appRootInput.addEventListener("input", () => {
      if (appDialogState.mode === "edit" && appTmuxWindowInput?.dataset.locked === "true") {
        return;
      }
      updateAppWindowPreview();
    });
  }

  if (appWebAppToggle) {
    appWebAppToggle.addEventListener("change", () => {
      const enabled = appWebAppToggle.checked;
      appDialogState.webAppEnabled = enabled;
      syncAppWebAppPortNote({ enabled, port: enabled ? appDialogState.webAppPort : null });
    });
  }

  appRootBrowseButton?.addEventListener("click", (event) => {
    event.preventDefault();
    const seed =
      appRootInput?.value?.trim() || state.lastWorkingDirectory || state.config?.defaultDirectory || "";
    void openDirectoryBrowser({
      initialPath: seed,
      title: "Select App Root",
      confirmLabel: "Use This Directory",
      allowCreate: true,
      onSelect: (path) => {
        if (appRootInput) {
          appRootInput.value = path;
          updateAppWindowPreview();
        }
        state.lastWorkingDirectory = path;
      },
    });
  });

  appCloneDialog?.addEventListener("close", () => {
    appCloneForm?.reset();
  });

  appCloneButton?.addEventListener("click", (event) => {
    event.preventDefault();
    openAppCloneDialog();
  });

  appCloneCancelButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeAppCloneDialog();
  });

  appCloneForm?.addEventListener("submit", handleAppCloneSubmit);

  appCloneDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAppCloneDialog();
  });

  appCloneUrlInput?.addEventListener("blur", () => {
    if (!appCloneNameInput || !appCloneUrlInput) return;
    if (appCloneNameInput.value.trim().length > 0) return;
    const derived = deriveRepositoryFolderName(appCloneUrlInput.value);
    if (derived) {
      appCloneNameInput.value = derived;
    }
  });

  appForm?.addEventListener("submit", handleAppFormSubmit);

  appDiscoverButton?.addEventListener("click", handleAppDiscover);

  appDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAppDialog();
  });

  appDialog?.addEventListener("close", () => {
    resetAppDialog();
  });

  appLogsRefreshButton?.addEventListener("click", (event) => {
    event.preventDefault();
    void refreshAppLogs();
  });

  appLogsCloseButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeAppLogsDialog();
  });

  appLogsDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAppLogsDialog();
  });

  appLogsDialog?.addEventListener("close", () => {
    closeAppLogsDialog();
  });

  return {
    openAppDialog,
    closeAppDialog,
    openAppLogsDialog,
    refreshAppLogs,
    resetAppDialog,
  };
};
