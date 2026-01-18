export const initOrchestratorUI = ({ state, getCurrentRoute, setCurrentRoute, render, handleSessionStart }) => {
  let orchestratorPrefixDirty = false;
  let orchestratorDialogSubmitting = false;
  const orchestratorDirectoryState = {
    target: null,
    requestId: 0,
    currentPath: null,
    parent: null,
    selection: null,
  };

  const orchestratorDialog = document.getElementById("orchestrator-dialog");
  const orchestratorForm = orchestratorDialog?.querySelector("form");
  const orchestratorLabelInput = document.getElementById("orchestrator-label");
  const orchestratorAgentSelect = document.getElementById("orchestrator-agent");
  const orchestratorTemplateInput = document.getElementById("orchestrator-template");
  const orchestratorActiveRootInput = document.getElementById("orchestrator-active-root");
  const orchestratorTemplateBrowseButton = document.getElementById("orchestrator-template-browse");
  const orchestratorActiveRootBrowseButton = document.getElementById("orchestrator-active-root-browse");
  const orchestratorDirectoryPrefixInput = document.getElementById("orchestrator-directory-prefix");
  const orchestratorWorkingDirectoryInput = document.getElementById("orchestrator-working-directory");
  const orchestratorIntroTextarea = document.getElementById("orchestrator-intro");
  const orchestratorPollTimeoutInput = document.getElementById("orchestrator-timeout");
  const orchestratorPollIntervalInput = document.getElementById("orchestrator-interval");
  const orchestratorRetryAttemptsInput = document.getElementById("orchestrator-retries");
  const orchestratorRetryDelayInput = document.getElementById("orchestrator-retry-delay");
  const orchestratorCancelButton = document.getElementById("orchestrator-cancel");
  const orchestratorSaveButton = document.getElementById("orchestrator-save");
  const orchestratorDirectoryDialog = document.getElementById("orchestrator-directory-dialog");
  const orchestratorDirectoryList = document.getElementById("orchestrator-directory-list");
  const orchestratorDirectoryCurrent = document.getElementById("orchestrator-directory-current");
  const orchestratorDirectoryUpButton = document.getElementById("orchestrator-directory-up");
  const orchestratorDirectoryUseButton = document.getElementById("orchestrator-directory-use");

  const normaliseOrchestratorPresetSummary = (item) => {
    if (!item || typeof item !== "object") return null;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) return null;
    const label = typeof item.label === "string" ? item.label : "";
    const agent = typeof item.agent === "string" ? item.agent : "";
    return { id, label, agent };
  };

  const refreshOrchestratorPresets = async () => {
    if (state.orchestratorPresetsLoading) return;
    state.orchestratorPresetsLoading = true;
    state.orchestratorPresetsError = null;
    // Don't render on home route to prevent performance issues
    // The home component will update itself when needed

    try {
      const response = await fetch("/api/orchestrators");
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error ?? response.statusText ?? "Failed to load orchestrators");
      }

      const payload = await response.json().catch(() => ({}));
      const candidates = Array.isArray(payload?.presets) ? payload.presets : [];
      state.orchestratorPresets = candidates
        .map((item) => normaliseOrchestratorPresetSummary(item))
        .filter((item) => item !== null);
      state.orchestratorPresetsError = null;
    } catch (error) {
      console.error("Failed to load orchestrator presets", error);
      state.orchestratorPresets = [];
      state.orchestratorPresetsError = error instanceof Error ? error.message : String(error);
    } finally {
      state.orchestratorPresetsLoading = false;
      state.orchestratorPresetsLoaded = true;
      // Don't render on home route - let the home component handle its own updates
    }
  };

  const ensureOrchestratorPresetsLoaded = () => {
    if (!state.orchestratorPresetsLoaded && !state.orchestratorPresetsLoading) {
      refreshOrchestratorPresets().catch((error) => {
        console.error("Failed to load orchestrators", error);
      });
    }
  };

  const launchOrchestratorPreset = async (presetId) => {
    const response = await fetch(`/api/orchestrators/${encodeURIComponent(presetId)}/launch`, {
      method: "POST",
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error ?? response.statusText ?? "Failed to launch orchestrator");
    }
    return response.json();
  };

  const createOrchestratorPreset = async (payload) => {
    const response = await fetch("/api/orchestrators", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error ?? response.statusText ?? "Failed to create orchestrator");
    }
    return response.json();
  };

  const renderOrchestratorPresetButtons = (container) => {
    if (!container) return;
    container.textContent = "";

    if (state.orchestratorPresetsLoading && !state.orchestratorPresetsLoaded) {
      container.textContent = "Loading orchestrators...";
      return;
    }

    if (state.orchestratorPresetsError) {
      container.textContent = `Failed to load orchestrator presets: ${state.orchestratorPresetsError}`;
      return;
    }

    if (state.orchestratorPresets.length === 0) {
      container.textContent = "No orchestrator presets configured.";
      return;
    }

    for (const preset of state.orchestratorPresets) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wm-button secondary";
      const label = preset.label && preset.label.length > 0 ? preset.label : preset.id;
      button.textContent = label;

      const setPending = (pending) => {
        if (pending) {
          button.disabled = true;
          button.dataset.pending = "true";
          button.textContent = "Launching...";
        } else {
          button.disabled = false;
          delete button.dataset.pending;
          button.textContent = label;
        }
      };

      button.addEventListener("click", async () => {
        if (button.dataset.pending === "true") return;
        setPending(true);
        try {
          const result = await launchOrchestratorPreset(preset.id);
          if (!result?.session) {
            window.alert("Orchestrator launched, but no session information was returned.");
            return;
          }
          await handleSessionStart(result.session);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          window.alert(`Failed to launch ${label}: ${message}`);
        } finally {
          if (button.isConnected) {
            setPending(false);
          }
        }
      });

      container.append(button);
    }
  };

  const formatDirectoryPrefix = (value) => {
    const trimmed = value?.trim() ?? "";
    if (!trimmed) return "";
    return trimmed
      .replace(/[^a-zA-Z0-9/_-]+/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_{2,}/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
  };

  const getDefaultOrchestratorPath = (target) => {
    return target === "templates" ? "orchestrator/templates" : "orchestrator/active";
  };

  const fetchOrchestratorDirectoryData = async (target, path) => {
    const params = new URLSearchParams({ target });
    if (path) {
      params.set("path", path);
    }
    const response = await fetch(`/api/orchestrators/directories?${params.toString()}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error ?? response.statusText ?? "Failed to load directories");
    }
    return response.json();
  };

  const refreshOrchestratorDirectoryHighlights = () => {
    if (!orchestratorDirectoryList) return;
    const selected = orchestratorDirectoryState.selection;
    orchestratorDirectoryList.querySelectorAll(".directory-browser__item").forEach((item) => {
      if (!(item instanceof HTMLElement)) return;
      const path = item.dataset.path;
      if (selected && path === selected) {
        item.dataset.selected = "true";
      } else {
        delete item.dataset.selected;
      }
    });
  };

  const renderOrchestratorDirectoryBrowser = (data) => {
    if (!orchestratorDirectoryCurrent || !orchestratorDirectoryList) return;
    orchestratorDirectoryCurrent.textContent = data.path;
    orchestratorDirectoryList.textContent = "";
    if (orchestratorDirectoryUpButton) {
      orchestratorDirectoryUpButton.disabled = !data.parent;
    }

    if (Array.isArray(data.entries) && data.entries.length > 0) {
      data.entries.forEach((entry) => {
        const item = document.createElement("li");
        item.className = "directory-browser__item";
        item.dataset.path = entry.path;

        const folderButton = document.createElement("button");
        folderButton.type = "button";
        folderButton.className = "directory-browser__folder";
        folderButton.textContent = entry.name;
        folderButton.dataset.path = entry.path;

        const chooseButton = document.createElement("button");
        chooseButton.type = "button";
        chooseButton.className = "wm-button secondary directory-browser__choose";
        chooseButton.textContent = "Choose";
        chooseButton.dataset.path = entry.path;

        item.append(folderButton, chooseButton);
        orchestratorDirectoryList.append(item);
      });
    } else {
      const empty = document.createElement("li");
      empty.className = "directory-browser__empty";
      empty.textContent = "No subdirectories";
      orchestratorDirectoryList.append(empty);
    }

    refreshOrchestratorDirectoryHighlights();
  };

  const setOrchestratorDirectorySelection = (path) => {
    orchestratorDirectoryState.selection = path;
    refreshOrchestratorDirectoryHighlights();
  };

  const updateOrchestratorDirectoryBrowser = async (target, path) => {
    orchestratorDirectoryState.target = target;
    orchestratorDirectoryState.requestId += 1;
    const requestId = orchestratorDirectoryState.requestId;
    orchestratorDirectoryState.selection = null;

    let data;
    try {
      data = await fetchOrchestratorDirectoryData(target, path ?? undefined);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
      return false;
    }

    if (orchestratorDirectoryState.requestId !== requestId) {
      return false;
    }

    orchestratorDirectoryState.currentPath = data.path ?? null;
    orchestratorDirectoryState.parent = data.parent ?? null;
    orchestratorDirectoryState.selection = data.path ?? null;
    renderOrchestratorDirectoryBrowser(data);
    return true;
  };

  const openOrchestratorDirectoryDialog = async (target, initialPath) => {
    if (!orchestratorDirectoryDialog || typeof orchestratorDirectoryDialog.showModal !== "function") {
      window.alert("Your browser does not support the directory picker.");
      return;
    }

    const seed = initialPath && initialPath.trim().length > 0 ? initialPath : getDefaultOrchestratorPath(target);
    const loaded = await updateOrchestratorDirectoryBrowser(target, seed ?? null);
    if (!loaded) {
      return;
    }
    orchestratorDirectoryDialog.showModal();
  };

  const setOrchestratorDialogPending = (pending) => {
    orchestratorDialogSubmitting = pending;
    if (orchestratorSaveButton) {
      orchestratorSaveButton.disabled = pending;
      orchestratorSaveButton.textContent = pending ? "Saving..." : "Save";
    }
  };

  const syncOrchestratorAgentOptions = () => {
    if (!orchestratorAgentSelect) return;
    orchestratorAgentSelect.innerHTML = "";
    (state.config?.agents ?? []).forEach((agent) => {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = agent.label;
      orchestratorAgentSelect.append(option);
    });
  };

  const applyOrchestratorTemplateState = () => {
    const hasTemplate = Boolean(orchestratorTemplateInput?.value.trim().length);
    if (orchestratorActiveRootInput) {
      orchestratorActiveRootInput.disabled = !hasTemplate;
      if (!hasTemplate) {
        orchestratorActiveRootInput.value = getDefaultOrchestratorPath("active");
      }
    }
    if (orchestratorActiveRootBrowseButton) {
      orchestratorActiveRootBrowseButton.disabled = !hasTemplate;
    }
  };

  const resetOrchestratorForm = () => {
    orchestratorPrefixDirty = false;
    const defaultDir = state.lastWorkingDirectory ?? state.config?.defaultDirectory ?? "";
    if (orchestratorLabelInput) {
      orchestratorLabelInput.value = "";
    }
    if (orchestratorTemplateInput) {
      orchestratorTemplateInput.value = "";
    }
    if (orchestratorActiveRootInput) {
      orchestratorActiveRootInput.value = "orchestrator/active";
      orchestratorActiveRootInput.disabled = true;
    }
    if (orchestratorTemplateBrowseButton) {
      orchestratorTemplateBrowseButton.disabled = false;
    }
    if (orchestratorActiveRootBrowseButton) {
      orchestratorActiveRootBrowseButton.disabled = true;
    }
    if (orchestratorDirectoryPrefixInput) {
      orchestratorDirectoryPrefixInput.value = "";
      orchestratorDirectoryPrefixInput.placeholder = "Security_Review";
    }
    if (orchestratorWorkingDirectoryInput) {
      orchestratorWorkingDirectoryInput.value = defaultDir;
    }
    if (orchestratorIntroTextarea) {
      orchestratorIntroTextarea.value = "";
    }
    if (orchestratorPollTimeoutInput) {
      orchestratorPollTimeoutInput.value = "30000";
    }
    if (orchestratorPollIntervalInput) {
      orchestratorPollIntervalInput.value = "250";
    }
    if (orchestratorRetryAttemptsInput) {
      orchestratorRetryAttemptsInput.value = "10";
    }
    if (orchestratorRetryDelayInput) {
      orchestratorRetryDelayInput.value = "1000";
    }

    syncOrchestratorAgentOptions();
    if (state.config?.agents && orchestratorAgentSelect) {
      orchestratorAgentSelect.value = state.config.agents[0]?.id ?? "";
    }
    applyOrchestratorTemplateState();
  };

  const closeOrchestratorDialog = () => {
    setOrchestratorDialogPending(false);
    if (orchestratorDialog && typeof orchestratorDialog.close === "function" && orchestratorDialog.open) {
      orchestratorDialog.close();
    }
  };

  const openOrchestratorDialog = () => {
    if (!state.config) {
      window.alert("Configuration is still loading. Try again shortly.");
      return;
    }
    if (!orchestratorDialog || typeof orchestratorDialog.showModal !== "function") {
      window.alert("Your browser does not support the orchestrator dialog.");
      return;
    }
    resetOrchestratorForm();
    orchestratorDialog.showModal();
    orchestratorLabelInput?.focus();
  };

  const readIntegerInput = (input, fallback, minimum) => {
    if (!input) return fallback;
    const value = Number.parseInt(input.value, 10);
    if (Number.isFinite(value) && (!Number.isFinite(minimum) || value >= minimum)) {
      return value;
    }
    return fallback;
  };

  const handleOrchestratorFormSubmit = async (event) => {
    event.preventDefault();
    if (orchestratorDialogSubmitting) return;

    const label = orchestratorLabelInput?.value.trim() ?? "";
    if (!label) {
      window.alert("Enter a button label for the orchestrator.");
      orchestratorLabelInput?.focus();
      return;
    }

    const agent = orchestratorAgentSelect?.value ?? "";
    if (!agent) {
      window.alert("Select an agent for the orchestrator.");
      orchestratorAgentSelect?.focus();
      return;
    }

    const templateDirRaw = orchestratorTemplateInput?.value.trim() ?? "";
    const workingDirectoryRaw = orchestratorWorkingDirectoryInput?.value.trim() ?? "";
    const useTemplate = templateDirRaw.length > 0;
    if (!useTemplate && !workingDirectoryRaw) {
      window.alert("Provide either a template directory or a working directory.");
      orchestratorTemplateInput?.focus();
      return;
    }

    const directoryPrefixRaw = orchestratorDirectoryPrefixInput?.value.trim() ?? "";
    const introMessageRaw = orchestratorIntroTextarea?.value ?? "";
    const introMessageTrimmed = introMessageRaw.trim();
    const pollTimeout = readIntegerInput(orchestratorPollTimeoutInput, 30000, 1000);
    const pollInterval = readIntegerInput(orchestratorPollIntervalInput, 250, 50);
    const retryAttempts = readIntegerInput(orchestratorRetryAttemptsInput, 10, 1);
    const retryDelay = readIntegerInput(orchestratorRetryDelayInput, 1000, 0);

    const payload = {
      label,
      agent,
      templateDir: useTemplate ? templateDirRaw : undefined,
      activeRoot: useTemplate ? (orchestratorActiveRootInput?.value.trim() || "orchestrator/active") : undefined,
      directoryPrefix: useTemplate ? directoryPrefixRaw || formatDirectoryPrefix(label) : directoryPrefixRaw || undefined,
      workingDirectory: useTemplate ? undefined : workingDirectoryRaw || undefined,
      introMessage: introMessageTrimmed ? introMessageTrimmed : undefined,
      pollTimeoutMs: pollTimeout,
      pollIntervalMs: pollInterval,
      retryAttempts,
      retryDelayMs: retryDelay,
    };

    setOrchestratorDialogPending(true);
    try {
      await createOrchestratorPreset(payload);
      closeOrchestratorDialog();
      await refreshOrchestratorPresets();
      if (getCurrentRoute() !== "home") {
        setCurrentRoute("home");
        render();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(`Failed to create orchestrator: ${message}`);
    } finally {
      if (orchestratorDialog?.open) {
        setOrchestratorDialogPending(false);
      }
    }
  };

  orchestratorForm?.addEventListener("submit", handleOrchestratorFormSubmit);

  orchestratorCancelButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeOrchestratorDialog();
  });

  orchestratorDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeOrchestratorDialog();
  });

  orchestratorDialog?.addEventListener("close", () => {
    setOrchestratorDialogPending(false);
  });

  orchestratorDirectoryDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    orchestratorDirectoryDialog.close();
  });

  orchestratorDirectoryDialog?.addEventListener("close", () => {
    orchestratorDirectoryState.target = null;
    orchestratorDirectoryState.selection = null;
    orchestratorDirectoryState.currentPath = null;
    orchestratorDirectoryState.parent = null;
  });

  orchestratorDirectoryUpButton?.addEventListener("click", (event) => {
    event.preventDefault();
    if (orchestratorDirectoryState.parent && orchestratorDirectoryState.target) {
      updateOrchestratorDirectoryBrowser(orchestratorDirectoryState.target, orchestratorDirectoryState.parent);
    }
  });

  orchestratorDirectoryList?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const path = target.dataset.path;
    if (!path || !orchestratorDirectoryState.target) return;

    if (target.classList.contains("directory-browser__folder")) {
      updateOrchestratorDirectoryBrowser(orchestratorDirectoryState.target, path);
    }

    if (target.classList.contains("directory-browser__choose")) {
      setOrchestratorDirectorySelection(path);
    }
  });

  orchestratorDirectoryUseButton?.addEventListener("click", (event) => {
    event.preventDefault();
    const target = orchestratorDirectoryState.target;
    if (!target) return;
    const selected = orchestratorDirectoryState.selection ?? orchestratorDirectoryState.currentPath;
    if (!selected) {
      window.alert("Select a directory first.");
      return;
    }

    if (target === "templates") {
      if (orchestratorTemplateInput) {
        orchestratorTemplateInput.value = selected;
        orchestratorTemplateInput.dispatchEvent(new Event("input"));
      }
      if (!orchestratorPrefixDirty && orchestratorDirectoryPrefixInput) {
        const lastSegment = selected.split("/").filter(Boolean).pop() ?? "";
        const suggestion = formatDirectoryPrefix(lastSegment);
        if (suggestion) {
          orchestratorDirectoryPrefixInput.value = suggestion;
        }
        orchestratorDirectoryPrefixInput.placeholder = suggestion || "Security_Review";
      }
    } else if (target === "active") {
      if (orchestratorActiveRootInput) {
        orchestratorActiveRootInput.value = selected;
      }
    }

    if (orchestratorDirectoryDialog.open) {
      orchestratorDirectoryDialog.close();
    }
  });

  orchestratorLabelInput?.addEventListener("input", () => {
    const suggestion = formatDirectoryPrefix(orchestratorLabelInput.value);
    if (!orchestratorPrefixDirty && orchestratorDirectoryPrefixInput) {
      orchestratorDirectoryPrefixInput.value = suggestion;
    }
    if (orchestratorDirectoryPrefixInput) {
      orchestratorDirectoryPrefixInput.placeholder = suggestion || "Security_Review";
    }
  });

  orchestratorDirectoryPrefixInput?.addEventListener("input", () => {
    orchestratorPrefixDirty = true;
  });

  orchestratorTemplateInput?.addEventListener("input", () => {
    applyOrchestratorTemplateState();
  });

  orchestratorTemplateBrowseButton?.addEventListener("click", (event) => {
    event.preventDefault();
    if (orchestratorTemplateBrowseButton.disabled) return;
    const seed = orchestratorTemplateInput?.value ?? getDefaultOrchestratorPath("templates");
    openOrchestratorDirectoryDialog("templates", seed);
  });

  orchestratorActiveRootBrowseButton?.addEventListener("click", (event) => {
    event.preventDefault();
    if (orchestratorActiveRootBrowseButton.disabled) return;
    const seed = orchestratorActiveRootInput?.value ?? getDefaultOrchestratorPath("active");
    openOrchestratorDirectoryDialog("active", seed);
  });

  return {
    renderPresetButtons: renderOrchestratorPresetButtons,
    ensurePresetsLoaded: ensureOrchestratorPresetsLoaded,
    refreshPresets: refreshOrchestratorPresets,
    openDialog: openOrchestratorDialog,
    syncAgents: syncOrchestratorAgentOptions,
  };
};
