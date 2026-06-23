export function getHomeRunningApps(apps) {
  return Array.isArray(apps)
    ? apps.filter((app) => app?.status?.status === "running")
    : [];
}

export function createRunningAppsSection({
  appsStore,
  navigateToApps,
  isAppActionDisabled,
  triggerAppAction,
  appStatusLabels = {},
  appActionLabels = {},
} = {}) {
  const card = document.createElement("section");
  card.className = "wm-card wm-home-apps wm-home-quadrant";
  card.dataset.testid = "home-running-apps";

  const header = document.createElement("button");
  header.type = "button";
  header.className = "wm-home-section-header wm-home-quadrant__header";
  header.setAttribute("aria-expanded", "true");
  header.dataset.testid = "home-running-apps-toggle";

  const titleWrap = document.createElement("span");
  titleWrap.className = "wm-home-quadrant__title";

  const title = document.createElement("h2");
  title.textContent = "Running Apps";

  const badge = document.createElement("span");
  badge.className = "wm-home-quadrant__badge";
  badge.textContent = "0";
  badge.setAttribute("aria-label", "0 running apps");

  titleWrap.append(title, badge);

  const collapseIcon = document.createElement("span");
  collapseIcon.className = "wm-home-quadrant__collapse";
  collapseIcon.setAttribute("aria-hidden", "true");
  collapseIcon.textContent = "▼";
  header.append(titleWrap, collapseIcon);

  const actions = document.createElement("div");
  actions.className = "wm-home-section-actions wm-home-quadrant__actions";

  const newAppButton = document.createElement("button");
  newAppButton.type = "button";
  newAppButton.className = "wm-button secondary";
  newAppButton.textContent = "New App";
  newAppButton.addEventListener("click", (event) => {
    event.preventDefault();
    navigateToApps?.({ openNewAppDialog: true });
  });
  actions.append(newAppButton);

  const content = document.createElement("div");
  content.className = "wm-home-apps-content wm-home-quadrant__content";

  header.addEventListener("click", () => {
    const collapsed = card.dataset.collapsed === "true";
    setCollapsed(!collapsed);
  });

  function setCollapsed(collapsed) {
    if (collapsed) {
      card.dataset.collapsed = "true";
      content.hidden = true;
      header.setAttribute("aria-expanded", "false");
      return;
    }
    delete card.dataset.collapsed;
    content.hidden = false;
    header.setAttribute("aria-expanded", "true");
  }

  function render() {
    const store = typeof appsStore === "function" ? appsStore() : {};
    const runningApps = getHomeRunningApps(store.items);
    badge.textContent = String(runningApps.length);
    badge.setAttribute("aria-label", `${runningApps.length} running app${runningApps.length === 1 ? "" : "s"}`);
    content.innerHTML = "";

    if (store.error) {
      content.append(createStatus(store.error));
    } else if (store.loading && !store.initialized) {
      content.append(createStatus("Loading apps..."));
    } else if (runningApps.length === 0) {
      content.append(createStatus("No apps are currently running."));
    } else {
      content.append(createAppsTable(runningApps));
    }
  }

  function createStatus(message) {
    const status = document.createElement("p");
    status.className = "wm-home-apps-status";
    status.textContent = message;
    return status;
  }

  function createAppsTable(runningApps) {
    const table = document.createElement("table");
    table.className = "wm-home-apps-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    ["App", "Status", "Root", "Actions"].forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      headerRow.append(th);
    });
    thead.append(headerRow);
    table.append(thead);

    const tbody = document.createElement("tbody");
    runningApps.forEach((app) => {
      tbody.append(createAppRow(app));
    });
    table.append(tbody);
    return table;
  }

  function createAppRow(app) {
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    const nameLink = document.createElement("a");
    nameLink.className = "wm-home-apps-link";
    nameLink.textContent = app.label ?? app.id;
    nameLink.href = "/apps";
    nameLink.addEventListener("click", (event) => {
      event.preventDefault();
      navigateToApps?.({ focusAppId: app.id });
    });
    nameCell.append(nameLink);
    row.append(nameCell);

    const statusCell = document.createElement("td");
    const statusValue = app?.status?.status ?? "unknown";
    statusCell.textContent = appStatusLabels[statusValue] ?? statusValue;
    row.append(statusCell);

    const rootCell = document.createElement("td");
    rootCell.textContent = app.root ?? "-";
    rootCell.title = app.root ?? "";
    row.append(rootCell);

    const actionsCell = document.createElement("td");
    actionsCell.className = "wm-home-apps-actions";
    addActionButton(actionsCell, app, "stop");
    addActionButton(actionsCell, app, "restart");
    if (!actionsCell.hasChildNodes()) {
      actionsCell.textContent = "-";
    }
    row.append(actionsCell);

    return row;
  }

  function addActionButton(target, app, action) {
    if (!app.availableScripts?.[action]) return;
    if (app.id === "wingman-core" && action === "stop") return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = action === "stop" ? "wm-button secondary" : "wm-button";
    button.textContent = appActionLabels[action] ?? action;
    button.disabled = isAppActionDisabled?.(app, action) ?? false;
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      const success = await triggerAppAction?.(app.id, action);
      if (!success && button.isConnected) {
        button.disabled = false;
      }
    });
    target.append(button);
  }

  card.append(header, actions, content);
  render();
  setCollapsed(false);
  return card;
}
