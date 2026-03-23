import { fetchStarterProjectsApi, launchStarterProjectApi } from "../services/starter-projects.js";

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
  const appTmuxSessionLabel = document.getElementById("app-tmux-session-label");
  const appTmuxSessionNote = document.getElementById("app-tmux-session-note");
  const appTmuxWindowLabel = document.getElementById("app-tmux-window-label");
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
  const appLogsClearButton = document.getElementById("app-logs-clear");
  const appLogsCloseButton = document.getElementById("app-logs-close");
  const appCancelButton = document.getElementById("app-cancel");
  const appCloneButton = document.getElementById("app-clone");
  const appCloneDialog = document.getElementById("app-clone-dialog");
  const appCloneForm = appCloneDialog?.querySelector("form") ?? null;
  const appCloneUrlInput = document.getElementById("app-clone-url");
  const appCloneNameInput = document.getElementById("app-clone-name");
  const appCloneCancelButton = document.getElementById("app-clone-cancel");
  const appCloneConfirmButton = document.getElementById("app-clone-confirm");
  const appNewModeDialog = document.getElementById("app-new-mode-dialog");
  const appNewModeQuickButton = document.getElementById("app-new-mode-quick");
  const appNewModeManualButton = document.getElementById("app-new-mode-manual");
  const appNewModeCancelButton = document.getElementById("app-new-mode-cancel");
  const appStarterDialog = document.getElementById("app-starter-dialog");
  const appStarterForm = appStarterDialog?.querySelector("form") ?? null;
  const appStarterList = document.getElementById("app-starter-list");
  const appStarterNameInput = document.getElementById("app-starter-name");
  const appStarterNotes = document.getElementById("app-starter-notes");
  const appStarterCancelButton = document.getElementById("app-starter-cancel");
  const appStarterConfirmButton = document.getElementById("app-starter-confirm");

  const appDialogState = {
    mode: "create",
    appId: null,
    webAppEnabled: false,
    webAppPort: null,
    projectContext: null,
  };
  const starterDialogState = {
    loading: false,
    launching: false,
    projects: [],
    selectedId: null,
  };

  const shouldShowAdvancedSection = () => Boolean(state.identity.isAdmin) || appDialogState.mode === "edit";

  const syncAppAdvancedVisibility = () => {
    if (!appAdvancedSection) return;
    const visible = shouldShowAdvancedSection();
    appAdvancedSection.hidden = !visible;
    if (!visible) {
      appAdvancedSection.open = false;
    }
  };

  const syncTmuxVisibility = () => {
    const isAdmin = Boolean(state.identity.isAdmin);
    const targets = [
      appTmuxSessionLabel,
      appTmuxInput,
      appTmuxSessionNote,
      appTmuxWindowLabel,
      appTmuxWindowInput,
    ];
    targets.forEach((element) => {
      if (!element) return;
      element.hidden = !isAdmin;
    });
  };

  syncAppAdvancedVisibility();
  syncTmuxVisibility();

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

  const getSelectedStarterProject = () => {
    if (!starterDialogState.selectedId) return null;
    return starterDialogState.projects.find((item) => item?.id === starterDialogState.selectedId) ?? null;
  };

  const setStarterDialogSubmitting = (submitting) => {
    starterDialogState.launching = submitting;
    if (appStarterConfirmButton) {
      appStarterConfirmButton.disabled = submitting || !starterDialogState.selectedId;
      appStarterConfirmButton.textContent = submitting ? "Creating..." : "Create App";
    }
    if (appStarterNameInput) {
      appStarterNameInput.disabled = submitting;
    }
  };

  const renderStarterProjectButtons = () => {
    if (!appStarterList) return;
    while (appStarterList.firstChild) {
      appStarterList.firstChild.remove();
    }
    if (starterDialogState.loading) {
      const loading = document.createElement("p");
      loading.className = "wm-field-note";
      loading.textContent = "Loading starter projects...";
      appStarterList.append(loading);
      return;
    }
    if (!Array.isArray(starterDialogState.projects) || starterDialogState.projects.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-field-note";
      empty.textContent = "No quick starters are configured yet.";
      appStarterList.append(empty);
      return;
    }
    starterDialogState.projects.forEach((project) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wm-button secondary wm-starter-grid__item";
      if (project?.id === starterDialogState.selectedId) {
        button.classList.add("is-active");
      }
      button.textContent = project?.name ?? "Starter";
      button.addEventListener("click", () => {
        starterDialogState.selectedId = project?.id ?? null;
        const selected = getSelectedStarterProject();
        if (appStarterNotes) {
          appStarterNotes.textContent =
            typeof selected?.notes === "string" && selected.notes.trim().length > 0
              ? selected.notes
              : "Starter selected. Enter an app name to continue.";
        }
        if (appStarterConfirmButton) {
          appStarterConfirmButton.disabled = starterDialogState.launching || !starterDialogState.selectedId;
        }
        renderStarterProjectButtons();
      });
      appStarterList.append(button);
    });
  };

  const loadStarterProjects = async () => {
    starterDialogState.loading = true;
    renderStarterProjectButtons();
    try {
      const projects = await fetchStarterProjectsApi();
      starterDialogState.projects = Array.isArray(projects) ? projects : [];
      if (!starterDialogState.projects.some((item) => item?.id === starterDialogState.selectedId)) {
        starterDialogState.selectedId = starterDialogState.projects[0]?.id ?? null;
      }
      const selected = getSelectedStarterProject();
      if (appStarterNotes) {
        appStarterNotes.textContent =
          typeof selected?.notes === "string" && selected.notes.trim().length > 0
            ? selected.notes
            : starterDialogState.selectedId
              ? "Starter selected. Enter an app name to continue."
              : "Select a starter project to continue.";
      }
      if (appStarterConfirmButton) {
        appStarterConfirmButton.disabled = starterDialogState.launching || !starterDialogState.selectedId;
      }
    } catch (error) {
      starterDialogState.projects = [];
      starterDialogState.selectedId = null;
      if (appStarterNotes) {
        appStarterNotes.textContent = error instanceof Error ? error.message : "Failed to load starter projects";
      }
      if (appStarterConfirmButton) {
        appStarterConfirmButton.disabled = true;
      }
    } finally {
      starterDialogState.loading = false;
      renderStarterProjectButtons();
    }
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
    syncAppAdvancedVisibility();
    syncTmuxVisibility();
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
    if (appAdvancedSection && !appAdvancedSection.hidden) {
      const hasScript = Object.values(app.scripts ?? {}).some(
        (value) => typeof value === "string" && value.length > 0,
      );
      const inferredWindow = deriveAppWindowName(app.label ?? "", app.root ?? "");
      const hasCustomWindow = Boolean(app.tmuxWindow && app.tmuxWindow !== inferredWindow);
      appAdvancedSection.open = hasScript || hasCustomWindow;
    }
    syncAppAdvancedVisibility();
    syncTmuxVisibility();
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

  const closeAppDialog = () => {
    closeAppNewModeDialog();
    closeAppStarterDialog();
    if (!appDialog) return;
    if (appDialog.open) {
      appDialog.close();
    }
    resetAppDialog();
  };

  const closeAppNewModeDialog = () => {
    if (!appNewModeDialog) return;
    if (appNewModeDialog.open) {
      appNewModeDialog.close();
    }
  };

  const openAppNewModeDialog = () => {
    if (!appNewModeDialog) {
      openManualAppDialog();
      return;
    }
    if (appNewModeDialog.open) {
      appNewModeDialog.close();
    }
    appNewModeDialog.showModal();
  };

  const closeAppStarterDialog = () => {
    if (!appStarterDialog) return;
    if (appStarterDialog.open) {
      appStarterDialog.close();
    }
    appStarterForm?.reset();
    starterDialogState.selectedId = null;
    starterDialogState.projects = [];
    starterDialogState.loading = false;
    starterDialogState.launching = false;
    if (appStarterNotes) {
      appStarterNotes.textContent = "Select a starter project to continue.";
    }
  };

  const openAppStarterDialog = async () => {
    closeAppNewModeDialog();
    if (!appStarterDialog) {
      openManualAppDialog();
      return;
    }
    appStarterForm?.reset();
    if (appStarterNameInput && appLabelInput && appLabelInput.value.trim().length > 0) {
      appStarterNameInput.value = appLabelInput.value.trim();
    }
    if (appStarterNotes) {
      appStarterNotes.textContent = "Loading starter projects...";
    }
    if (appStarterDialog.open) {
      appStarterDialog.close();
    }
    appStarterDialog.showModal();
    appStarterNameInput?.focus();
    await loadStarterProjects();
  };

  const openManualAppDialog = (appId = null, options = {}) => {
    if (!appDialog) return;
    closeAppNewModeDialog();
    closeAppStarterDialog();
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

  const openAppDialog = (appId = null, options = {}) => {
    if (appId) {
      openManualAppDialog(appId, options);
      return;
    }
    if (options?.manual === true || options?.projectContext) {
      openManualAppDialog(null, options);
      return;
    }
    openAppNewModeDialog();
  };

  const applyDiscoveredScripts = (scripts, { revealAdvanced = true } = {}) => {
    if (!scripts || typeof scripts !== "object") {
      return 0;
    }
    let applied = 0;
    for (const [action, input] of Object.entries(appScriptInputs)) {
      if (!input) continue;
      const candidate = scripts?.[action];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        input.value = candidate;
        applied += 1;
      }
    }
    if (applied > 0 && revealAdvanced && appAdvancedSection && !appAdvancedSection.hidden) {
      appAdvancedSection.open = true;
    }
    return applied;
  };

  const runScriptDiscovery = async ({ root, silent = false, revealAdvanced = true } = {}) => {
    const targetRoot = typeof root === "string" ? root.trim() : appRootInput?.value?.trim() ?? "";
    if (!targetRoot) {
      if (!silent) {
        window.alert("Enter the app root directory before discovering scripts.");
        appRootInput?.focus();
      }
      return { applied: 0, success: false };
    }
    try {
      const response = await fetch(`/api/apps/discover?root=${encodeURIComponent(targetRoot)}`);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to discover scripts";
        throw new Error(message);
      }
      const scripts = payload && typeof payload === "object" ? (payload.scripts ?? {}) : {};
      const applied = applyDiscoveredScripts(scripts, { revealAdvanced });
      if (!silent && applied === 0) {
        window.alert("No scripts discovered. Enter commands manually.");
      }
      return { applied, success: true };
    } catch (error) {
      if (!silent) {
        const message = error instanceof Error ? error.message : "Failed to discover scripts";
        window.alert(message);
      } else {
        console.warn("[apps] Script discovery failed", error);
      }
      return { applied: 0, success: false };
    }
  };

  const handleAppDiscover = async (event) => {
    event.preventDefault();
    if (appDiscoverButton) {
      appDiscoverButton.disabled = true;
    }
    try {
      await runScriptDiscovery({ silent: false, revealAdvanced: true });
    } finally {
      if (appDiscoverButton) {
        appDiscoverButton.disabled = false;
      }
    }
  };

  const applyClonedAppDefaults = (payload) => {
    if (!payload || typeof payload !== "object") return "";
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
      if (applied > 0 && appAdvancedSection && !appAdvancedSection.hidden) {
        appAdvancedSection.open = true;
      }
    }
    if (appDiscoverToggle) {
      appDiscoverToggle.checked = false;
    }
    return root;
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
      const appliedRoot = applyClonedAppDefaults(payload ?? {}) ?? "";
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
      if (appliedRoot) {
        void runScriptDiscovery({ root: appliedRoot, silent: true, revealAdvanced: false });
      }
      closeAppCloneDialog();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to clone repository";
      window.alert(message);
    } finally {
      appCloneConfirmButton.disabled = false;
    }
  };

  const handleStarterSubmit = async (event) => {
    event.preventDefault();
    if (starterDialogState.launching) return;
    const selected = getSelectedStarterProject();
    if (!selected?.id) {
      window.alert("Select a starter project.");
      return;
    }
    const name = appStarterNameInput?.value?.trim() ?? "";
    if (!name) {
      window.alert("Provide a name for the starter app.");
      appStarterNameInput?.focus();
      return;
    }
    setStarterDialogSubmitting(true);
    try {
      const payload = await launchStarterProjectApi({
        starterId: selected.id,
        name,
      });
      closeAppStarterDialog();
      await refreshApps({ skipRender: false });
      const setupStatus = payload?.setup?.status;
      const setupAttempted = Boolean(payload?.setup?.attempted);
      if (setupAttempted) {
        const exitCode = typeof setupStatus?.lastExitCode === "number" ? setupStatus.lastExitCode : null;
        if (exitCode === 0) {
          showToast("Starter project created and setup completed", { type: "success" });
        } else {
          showToast("Starter project created, but setup command reported an issue", { type: "error" });
        }
      } else {
        showToast("Starter project created", { type: "success" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to launch starter project";
      window.alert(message);
    } finally {
      setStarterDialogSubmitting(false);
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

  const clearAppLogs = async (appId) => {
    const targetId = appId ?? state.appLogViewer.appId;
    if (!targetId) return;
    const app = getAppById(targetId);
    const appName = app?.label ?? targetId;
    const confirmed = window.confirm(`Clear logs for "${appName}"?`);
    if (!confirmed) return;

    if (appLogsClearButton) {
      appLogsClearButton.disabled = true;
      appLogsClearButton.textContent = "Clearing…";
    }
    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(targetId)}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "clear-logs" }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to clear logs";
        throw new Error(message);
      }
      state.appLogViewer.lines = [];
      if (appLogsContent) {
        appLogsContent.textContent = "No log output yet.";
      }
      showToast("Logs cleared", { type: "success" });
      await refreshAppLogs(targetId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to clear logs";
      showToast(message, { type: "error" });
    } finally {
      if (appLogsClearButton) {
        appLogsClearButton.disabled = false;
        appLogsClearButton.textContent = "Clear logs";
      }
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

  appNewModeQuickButton?.addEventListener("click", (event) => {
    event.preventDefault();
    void openAppStarterDialog();
  });

  appNewModeManualButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeAppNewModeDialog();
    openManualAppDialog();
  });

  appNewModeCancelButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeAppNewModeDialog();
  });

  appNewModeDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAppNewModeDialog();
  });

  appStarterCancelButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeAppStarterDialog();
  });

  appStarterDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAppStarterDialog();
  });

  appStarterDialog?.addEventListener("close", () => {
    appStarterForm?.reset();
  });

  appStarterForm?.addEventListener("submit", (event) => {
    void handleStarterSubmit(event);
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

  if (typeof window !== "undefined") {
    window.addEventListener("wingman:identity-ui-state", () => {
      syncAppAdvancedVisibility();
      syncTmuxVisibility();
    });
  }

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

  appCancelButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeAppDialog();
  });

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

  appLogsClearButton?.addEventListener("click", (event) => {
    event.preventDefault();
    void clearAppLogs();
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

  // ============================================================
  // Deploy Dialog
  // ============================================================

  const appDeployDialog = document.getElementById("app-deploy-dialog");
  const appDeployForm = appDeployDialog?.querySelector("form") ?? null;
  const appDeployTitle = document.getElementById("app-deploy-title");
  const appDeployNameInput = document.getElementById("app-deploy-name");
  const appDeployStatus = document.getElementById("app-deploy-status");
  const appDeployMessage = document.getElementById("app-deploy-message");
  const appDeployUrl = document.getElementById("app-deploy-url");
  const appDeployCancelButton = document.getElementById("app-deploy-cancel");
  const appDeployConfirmButton = document.getElementById("app-deploy-confirm");

  const deployDialogState = {
    appId: null,
    deploying: false,
    completed: false,
  };

  const setDeployConfirmButtonState = (label, disabled) => {
    if (!appDeployConfirmButton) return;
    appDeployConfirmButton.disabled = disabled;
    appDeployConfirmButton.textContent = label;
  };

  const setDeployDialogCompletionState = (completed) => {
    deployDialogState.completed = completed;
    if (appDeployNameInput) {
      appDeployNameInput.disabled = completed;
    }
    if (appDeployCancelButton) {
      appDeployCancelButton.hidden = completed;
    }
  };

  const resolveInitialCaproverName = (app) => {
    if (typeof app?.caproverName === "string" && app.caproverName.trim().length > 0) {
      return app.caproverName.trim();
    }
    if (typeof app?.subdomainAlias === "string" && app.subdomainAlias.trim().length > 0) {
      return app.subdomainAlias.trim();
    }
    if (typeof app?.label === "string") {
      return deriveCaproverNameFromLabel(app.label);
    }
    return "";
  };

  const syncDeployedAppDetails = (appId, deployment) => {
    const app = getAppById(appId);
    if (!app || !deployment || typeof deployment !== "object") return;
    if (typeof deployment.caproverName === "string" && deployment.caproverName.length > 0) {
      app.caproverName = deployment.caproverName;
    }
    if (typeof deployment.liveUrl === "string" && deployment.liveUrl.length > 0) {
      app.caproverLiveUrl = deployment.liveUrl;
    }
    if (typeof deployment.deployedVersion === "number") {
      app.caproverDeployedVersion = deployment.deployedVersion;
    }
  };

  const resetDeployDialog = () => {
    if (appDeployForm) {
      appDeployForm.reset();
    }
    if (appDeployTitle) {
      appDeployTitle.textContent = "Deploy to CapRover";
    }
    if (appDeployStatus) {
      appDeployStatus.hidden = true;
    }
    if (appDeployMessage) {
      appDeployMessage.textContent = "";
      appDeployMessage.className = "";
    }
    if (appDeployUrl) {
      appDeployUrl.hidden = true;
      appDeployUrl.href = "#";
    }
    setDeployConfirmButtonState("Deploy", false);
    deployDialogState.appId = null;
    deployDialogState.deploying = false;
    setDeployDialogCompletionState(false);
  };

  const closeDeployDialog = () => {
    if (!appDeployDialog) return;
    if (appDeployDialog.open) {
      appDeployDialog.close();
    }
    resetDeployDialog();
  };

  const openDeployDialog = async (appId) => {
    if (!appDeployDialog) return;

    const app = getAppById(appId);
    if (!app) {
      showToast("App not found", { type: "error" });
      return;
    }

    if (!app.webApp) {
      showToast("Only web apps can be deployed to CapRover", { type: "error" });
      return;
    }

    resetDeployDialog();
    deployDialogState.appId = appId;

    // Set dialog title with app name
    if (appDeployTitle) {
      const appName = app.label?.trim() || String(appId);
      appDeployTitle.textContent = `Deploy ${appName}`;
    }

    if (appDeployNameInput) {
      appDeployNameInput.value = resolveInitialCaproverName(app);
    }

    if (appDeployDialog.open) {
      appDeployDialog.close();
    }
    appDeployDialog.showModal();
    appDeployNameInput?.focus();
  };

  const deriveCaproverNameFromLabel = (label) => {
    if (!label || typeof label !== "string") return "";
    return label
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 50);
  };

  const handleDeploySubmit = async (event) => {
    event.preventDefault();
    if (deployDialogState.deploying) return;
    if (deployDialogState.completed) {
      closeDeployDialog();
      return;
    }

    const appId = deployDialogState.appId;
    if (!appId) {
      showToast("No app selected for deployment", { type: "error" });
      return;
    }

    const caproverName = appDeployNameInput?.value?.trim() ?? "";
    if (!caproverName) {
      showToast("CapRover app name is required", { type: "error" });
      appDeployNameInput?.focus();
      return;
    }

    // Validate format
    if (!/^[a-z][a-z0-9-]*$/.test(caproverName)) {
      showToast("Invalid CapRover name format", { type: "error" });
      appDeployNameInput?.focus();
      return;
    }

    deployDialogState.deploying = true;
    setDeployConfirmButtonState("Deploying…", true);
    if (appDeployStatus) {
      appDeployStatus.hidden = false;
    }
    if (appDeployMessage) {
      appDeployMessage.textContent = "Deploying to CapRover…";
      appDeployMessage.className = "wm-deploy-pending";
    }
    if (appDeployUrl) {
      appDeployUrl.hidden = true;
    }

    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(appId)}/deploy-to-caprover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caproverName }),
      });

      let data;
      try {
        data = await response.json();
      } catch {
        // Response wasn't valid JSON
        throw new Error(response.ok ? "Invalid server response" : `Deployment failed: ${response.statusText || response.status}`);
      }

      if (!response.ok) {
        throw new Error(data.error || response.statusText || "Deployment failed");
      }

      // Success
      syncDeployedAppDetails(appId, data);
      void refreshApps({ skipRender: true });
      if (appDeployMessage) {
        appDeployMessage.textContent = "Deployment successful!";
        appDeployMessage.className = "wm-deploy-success";
      }
      if (appDeployUrl && data.liveUrl) {
        appDeployUrl.href = data.liveUrl;
        appDeployUrl.textContent = data.liveUrl;
        appDeployUrl.hidden = false;
      }
      setDeployDialogCompletionState(true);
      setDeployConfirmButtonState("Close", false);
      showToast("Deployed to CapRover", { type: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Deployment failed";
      if (appDeployMessage) {
        appDeployMessage.textContent = message;
        appDeployMessage.className = "wm-deploy-error";
      }
      setDeployConfirmButtonState("Retry", false);
      showToast(message, { type: "error" });
    } finally {
      deployDialogState.deploying = false;
    }
  };

  appDeployForm?.addEventListener("submit", handleDeploySubmit);

  appDeployCancelButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeDeployDialog();
  });

  appDeployDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDeployDialog();
  });

  appDeployDialog?.addEventListener("close", () => {
    resetDeployDialog();
  });

  return {
    openAppDialog,
    closeAppDialog,
    openAppLogsDialog,
    refreshAppLogs,
    resetAppDialog,
    openDeployDialog,
  };
};
