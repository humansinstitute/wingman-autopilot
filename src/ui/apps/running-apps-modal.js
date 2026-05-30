import { getAppDisplayName, getAppOpenUrl, getAppStatusValue } from "./table.js";

export function isRunningApp(app) {
  return getAppStatusValue(app) === "running";
}

export function getRunningApps(apps) {
  return Array.isArray(apps)
    ? apps.filter((app) => app?.id !== "wingman-core" && isRunningApp(app))
    : [];
}

export function showRunningAppsModal({
  appsStore,
  renderAppCard,
  refreshApps,
  triggerAppAction,
  showToast,
}) {
  const existing = document.getElementById("running-apps-modal");
  if (typeof HTMLDialogElement === "function" && existing instanceof HTMLDialogElement && existing.open) {
    existing.close();
    existing.remove();
  } else {
    existing?.remove();
  }

  const dialog = document.createElement("dialog");
  dialog.id = "running-apps-modal";
  dialog.className = "wm-running-apps-modal";
  dialog.dataset.testid = "running-apps-modal";
  dialog.setAttribute("aria-labelledby", "running-apps-modal-title");

  const shell = document.createElement("div");
  shell.className = "wm-running-apps-modal__shell";

  const header = document.createElement("header");
  header.className = "wm-running-apps-modal__header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "wm-running-apps-modal__title";
  const title = document.createElement("h2");
  title.id = "running-apps-modal-title";
  title.textContent = "Running Apps";
  const subtitle = document.createElement("p");
  subtitle.setAttribute("aria-live", "polite");
  titleWrap.append(title, subtitle);

  const headerActions = document.createElement("div");
  headerActions.className = "wm-running-apps-modal__header-actions";

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "wm-button secondary wm-button--small";
  refreshButton.textContent = "Refresh";
  refreshButton.dataset.testid = "running-apps-modal-refresh";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "wm-button secondary wm-button--small";
  closeButton.textContent = "Close";
  closeButton.setAttribute("aria-label", "Close running apps");
  closeButton.dataset.testid = "running-apps-modal-close";
  closeButton.addEventListener("click", () => dialog.close());

  headerActions.append(refreshButton, closeButton);
  header.append(titleWrap, headerActions);

  const body = document.createElement("div");
  body.className = "wm-running-apps-modal__body";

  const status = document.createElement("p");
  status.className = "wm-running-apps-modal__status";
  status.setAttribute("aria-live", "polite");

  shell.append(header, body, status);
  dialog.append(shell);

  let selectedAppId = null;
  let loading = false;

  function setStatus(message, type = "") {
    status.textContent = message ?? "";
    status.dataset.state = type;
  }

  function getStoreApps() {
    const appState = typeof appsStore === "function" ? appsStore() : null;
    return Array.isArray(appState?.items) ? appState.items : [];
  }

  function findSelectedApp() {
    if (!selectedAppId) return null;
    return getStoreApps().find((app) => app?.id === selectedAppId) ?? null;
  }

  function renderAppStatusBadge(app) {
    const badge = document.createElement("span");
    badge.className = "wm-app-status";
    const statusValue = getAppStatusValue(app);
    badge.dataset.state = statusValue;
    badge.textContent = statusValue;
    return badge;
  }

  function renderOpenLink(app) {
    const openUrl = getAppOpenUrl(app);
    if (!openUrl) return null;
    const link = document.createElement("a");
    link.className = "wm-running-apps-modal__open-link";
    link.href = openUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open";
    link.setAttribute("aria-label", `Open ${getAppDisplayName(app)}`);
    return link;
  }

  async function refreshModalApps() {
    if (loading) return;
    loading = true;
    refreshButton.disabled = true;
    refreshButton.textContent = "Refreshing...";
    setStatus("Refreshing apps...");
    renderContent();
    try {
      if (typeof refreshApps === "function") {
        await refreshApps({ skipRender: true });
      } else {
        const appState = typeof appsStore === "function" ? appsStore() : null;
        if (typeof appState?.sync === "function") {
          await appState.sync();
        }
      }
      setStatus("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to refresh apps.";
      setStatus(message, "error");
      showToast?.(message, { type: "error" });
    } finally {
      loading = false;
      refreshButton.disabled = false;
      refreshButton.textContent = "Refresh";
      renderContent();
    }
  }

  async function restartApp(app, button) {
    if (!app?.id || button.disabled) return;
    button.disabled = true;
    button.textContent = "Restarting...";
    setStatus(`Restarting ${getAppDisplayName(app)}...`);
    try {
      const success = typeof triggerAppAction === "function"
        ? await triggerAppAction(app.id, "restart")
        : false;
      if (success) {
        showToast?.(`Restarting ${getAppDisplayName(app)}...`, { type: "success" });
        await refreshModalApps();
      } else if (button.isConnected) {
        button.disabled = false;
        button.textContent = "Restart";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to restart app.";
      setStatus(message, "error");
      showToast?.(message, { type: "error" });
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = "Restart";
      }
    }
  }

  function renderListView() {
    const runningApps = getRunningApps(getStoreApps());
    subtitle.textContent = loading
      ? "Refreshing..."
      : `${runningApps.length} running app${runningApps.length === 1 ? "" : "s"}`;

    if (loading && runningApps.length === 0) {
      const loadingEl = document.createElement("p");
      loadingEl.className = "wm-running-apps-modal__empty";
      loadingEl.textContent = "Loading apps...";
      body.append(loadingEl);
      return;
    }

    if (runningApps.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-running-apps-modal__empty";
      empty.textContent = "No apps are currently running.";
      body.append(empty);
      return;
    }

    const list = document.createElement("div");
    list.className = "wm-running-apps-list";
    list.dataset.testid = "running-apps-list";

    runningApps.forEach((app) => {
      const item = document.createElement("article");
      item.className = "wm-running-apps-list__item";
      item.dataset.appId = String(app.id ?? "");

      const mainButton = document.createElement("button");
      mainButton.type = "button";
      mainButton.className = "wm-running-apps-list__main";
      mainButton.dataset.testid = "running-app-details";
      mainButton.setAttribute("aria-label", `Show details for ${getAppDisplayName(app)}`);
      mainButton.addEventListener("click", () => {
        selectedAppId = app.id;
        renderContent();
      });

      const name = document.createElement("span");
      name.className = "wm-running-apps-list__name";
      name.textContent = getAppDisplayName(app);

      const root = document.createElement("code");
      root.className = "wm-running-apps-list__root";
      root.textContent = app.root ?? "";
      root.title = app.root ?? "";

      mainButton.append(name, root);

      const actions = document.createElement("div");
      actions.className = "wm-running-apps-list__actions";
      actions.append(renderAppStatusBadge(app));

      const openLink = renderOpenLink(app);
      if (openLink) {
        actions.append(openLink);
      }

      if (app.availableScripts?.restart) {
        const restartButton = document.createElement("button");
        restartButton.type = "button";
        restartButton.className = "wm-button secondary wm-button--small";
        restartButton.textContent = "Restart";
        restartButton.dataset.testid = "running-app-restart";
        restartButton.addEventListener("click", () => void restartApp(app, restartButton));
        actions.append(restartButton);
      }

      item.append(mainButton, actions);
      list.append(item);
    });

    body.append(list);
  }

  function renderDetailsView(app) {
    subtitle.textContent = getAppDisplayName(app);

    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.className = "wm-button secondary wm-button--small wm-running-apps-modal__back";
    backButton.textContent = "Back to apps";
    backButton.dataset.testid = "running-apps-back";
    backButton.addEventListener("click", () => {
      selectedAppId = null;
      renderContent();
    });
    body.append(backButton);

    if (typeof renderAppCard !== "function") {
      const unavailable = document.createElement("p");
      unavailable.className = "wm-running-apps-modal__empty";
      unavailable.textContent = "App details are unavailable.";
      body.append(unavailable);
      return;
    }

    const card = renderAppCard(app);
    if (card instanceof HTMLElement) {
      card.classList.add("wm-app-card--modal");
      body.append(card);
    }
  }

  function renderContent() {
    body.innerHTML = "";
    const selectedApp = findSelectedApp();
    if (selectedApp) {
      renderDetailsView(selectedApp);
      return;
    }
    selectedAppId = null;
    renderListView();
  }

  refreshButton.addEventListener("click", () => void refreshModalApps());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
  });

  document.body.append(dialog);
  renderContent();
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else if (typeof dialog.show === "function") {
    dialog.show();
  } else {
    dialog.setAttribute("open", "open");
  }

  void refreshModalApps();
}
