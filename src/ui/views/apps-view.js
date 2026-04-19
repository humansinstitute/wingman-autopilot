export function buildAppFilterOptions({
  isAdmin,
  viewerNpub,
  filterOptions,
  abbreviateNpub,
}) {
  if (!isAdmin) {
    return [];
  }

  const seen = new Set();
  const options = [];

  function appendOption(value, label) {
    if (seen.has(value)) return;
    seen.add(value);
    options.push({ value, label });
  }

  if (viewerNpub) {
    appendOption(viewerNpub, `My apps (${abbreviateNpub(viewerNpub)})`);
  }
  appendOption("all", "All apps");

  for (const option of filterOptions) {
    if (!option || typeof option !== "object") continue;
    const value = typeof option.value === "string" ? option.value : "__anonymous__";
    if (seen.has(value)) continue;
    const alias = typeof option.alias === "string" && option.alias.trim().length > 0 ? option.alias.trim() : null;
    const npub = typeof option.npub === "string" ? option.npub : null;
    const appCount = typeof option.appCount === "number" ? option.appCount : 0;
    const baseLabel = alias ?? (npub ? abbreviateNpub(npub) : value === "__anonymous__" ? "Shared" : "Unknown");
    const detail = appCount === 0 ? "No apps" : appCount === 1 ? "1 app" : `${appCount} apps`;
    appendOption(value, `${baseLabel} • ${detail}`);
  }

  return options;
}

export function initAppsView({
  state,
  appsStore,
  getCurrentRoute,
  render,
  openAppDialog,
  createWorkspaceTreeSidebar,
  renderAppCard,
  refreshApps,
  fetchApps,
  logPreviewLines,
  normaliseNpubValue,
  abbreviateNpub,
}) {
  function schedulePendingAppDialog() {
    if (appsStore().pendingOpenDialog === "create") {
      appsStore().pendingOpenDialog = null;
      requestAnimationFrame(() => {
        openAppDialog();
      });
    }
  }

  function focusPendingAppCard(grid) {
    if (!appsStore().pendingFocusId) {
      return;
    }
    const targetId = appsStore().pendingFocusId;
    appsStore().pendingFocusId = null;
    requestAnimationFrame(() => {
      const escape = typeof CSS?.escape === "function" ? CSS.escape : (value) => value.replace(/"/g, '\\"');
      const selector = `[data-app-id="${escape(targetId)}"]`;
      const card = grid.querySelector(selector);
      if (!card) {
        return;
      }
      card.classList.add("wm-app-card--highlight");
      card.scrollIntoView({ block: "center", behavior: "smooth" });
      window.setTimeout(() => {
        if (card.isConnected) {
          card.classList.remove("wm-app-card--highlight");
        }
      }, 1600);
    });
  }

  function renderApps() {
    const wrapper = document.createElement("div");
    wrapper.className = "wm-apps";

    const header = document.createElement("div");
    header.className = "wm-apps-header";

    const title = document.createElement("h2");
    title.textContent = "Apps";
    header.append(title);

    const headerActions = document.createElement("div");
    headerActions.className = "wm-apps-header-actions";

    if (state.identity.isAdmin) {
      const ownerFilterOptions = buildAppFilterOptions({
        isAdmin: true,
        viewerNpub: normaliseNpubValue(state.identity.npub),
        filterOptions: appsStore().filters.options,
        abbreviateNpub,
      });
      if (ownerFilterOptions.length > 0) {
        const filterContainer = document.createElement("div");
        filterContainer.className = "wm-session-filter";
        const filterLabel = document.createElement("label");
        filterLabel.textContent = "Owner";
        const filterSelect = document.createElement("select");
        filterSelect.className = "wm-select";
        ownerFilterOptions.forEach((option) => {
          const opt = document.createElement("option");
          opt.value = option.value;
          opt.textContent = option.label;
          const currentAppFilter = appsStore().filters.npub;
          if (option.value === currentAppFilter) {
            opt.selected = true;
          }
          filterSelect.append(opt);
        });
        filterSelect.addEventListener("change", (event) => {
          const target = event.target;
          const value = target instanceof HTMLSelectElement && target.value ? target.value : "all";
          const appState = appsStore();
          appState.filters.npub = value;
          appState.filters.initialized = true;
          void fetchApps({ tail: logPreviewLines }).then(() => {
            if (getCurrentRoute() === "apps") {
              render();
            }
          });
        });
        filterLabel.append(filterSelect);
        filterContainer.append(filterLabel);
        headerActions.append(filterContainer);
      }
    }

    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "wm-button secondary";
    refreshButton.textContent = appsStore().loading ? "Refreshing…" : "Refresh";
    refreshButton.disabled = appsStore().loading;
    refreshButton.addEventListener("click", () => {
      refreshButton.disabled = true;
      void refreshApps({ skipRender: false });
    });

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "wm-button";
    addButton.textContent = "Add App";
    addButton.addEventListener("click", () => openAppDialog());

    headerActions.append(refreshButton, addButton);
    header.append(headerActions);
    wrapper.append(header);

    if (!appsStore().initialized && !appsStore().loading) {
      void refreshApps({ skipRender: false });
    }

    const splitContainer = document.createElement("div");
    splitContainer.className = "wm-apps-split";

    const sidebar = createWorkspaceTreeSidebar();
    if (sidebar) {
      splitContainer.append(sidebar);
    }

    const mainArea = document.createElement("div");
    mainArea.className = "wm-apps-main";

    if (appsStore().error) {
      const errorBox = document.createElement("div");
      errorBox.className = "wm-apps-error";
      const errorText = document.createElement("p");
      errorText.textContent = appsStore().error;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "wm-button secondary";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        void refreshApps({ skipRender: false });
      });
      errorBox.append(errorText, retry);
      mainArea.append(errorBox);
    }

    const apps = Array.isArray(appsStore().items)
      ? appsStore().items.filter((app) => app?.id !== "wingman-core")
      : [];
    if (appsStore().loading && apps.length === 0) {
      const loading = document.createElement("p");
      loading.className = "wm-apps-empty";
      loading.textContent = "Loading apps…";
      mainArea.append(loading);
      splitContainer.append(mainArea);
      wrapper.append(splitContainer);
      schedulePendingAppDialog();
      return wrapper;
    }

    if (apps.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-apps-empty";
      empty.textContent = "No apps registered yet. Import from the sidebar or use 'Add App' to get started.";
      mainArea.append(empty);
      splitContainer.append(mainArea);
      wrapper.append(splitContainer);
      schedulePendingAppDialog();
      return wrapper;
    }

    const grid = document.createElement("div");
    grid.className = "wm-apps-grid";

    apps.forEach((app) => {
      grid.append(renderAppCard(app));
    });

    mainArea.append(grid);
    splitContainer.append(mainArea);
    wrapper.append(splitContainer);

    focusPendingAppCard(grid);
    schedulePendingAppDialog();

    return wrapper;
  }

  return {
    renderApps,
  };
}
