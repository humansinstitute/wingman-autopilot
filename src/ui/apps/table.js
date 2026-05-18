export function getAppDisplayName(app) {
  const label = typeof app?.label === "string" ? app.label.trim() : "";
  if (label.length > 0) return label;
  return String(app?.id ?? "Untitled app");
}

export function getAppStatusValue(app) {
  const status = typeof app?.status?.status === "string" ? app.status.status.trim() : "";
  return status.length > 0 ? status : "idle";
}

export function getAppTypeLabel(app) {
  if (Boolean(app?.webApp)) return "Web";
  return "Process";
}

export function getAppOpenUrl(app) {
  if (typeof app?.subdomainUrl === "string" && app.subdomainUrl.length > 0) {
    return app.subdomainUrl;
  }
  if (typeof app?.webAppUrl === "string" && app.webAppUrl.length > 0) {
    return app.webAppUrl;
  }
  return null;
}

export function renderAppsTable({
  apps,
  appStatusLabels = {},
  formatAppTimestamp,
  onOpenAppDetails,
}) {
  const tableWrapper = document.createElement("div");
  tableWrapper.className = "wm-apps-table-wrapper wm-card";
  tableWrapper.dataset.testid = "apps-table-view";

  const table = document.createElement("table");
  table.className = "wm-apps-table";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  ["App", "Status", "Type", "Port", "Updated", "Root", ""].forEach((label) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    headerRow.append(th);
  });
  thead.append(headerRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  apps.forEach((app) => {
    tbody.append(renderAppsTableRow({
      app,
      appStatusLabels,
      formatAppTimestamp,
      onOpenAppDetails,
    }));
  });
  table.append(tbody);
  tableWrapper.append(table);

  return tableWrapper;
}

function renderAppsTableRow({
  app,
  appStatusLabels,
  formatAppTimestamp,
  onOpenAppDetails,
}) {
  const row = document.createElement("tr");
  row.className = "wm-apps-table-row";
  row.dataset.appId = String(app.id ?? "");
  row.tabIndex = 0;
  row.setAttribute("aria-label", `Open details for ${getAppDisplayName(app)}`);
  row.dataset.testid = "apps-table-row";

  row.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("a, button")) return;
    onOpenAppDetails(app);
  });
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target;
    if (target instanceof Element && target.closest("a, button")) return;
    event.preventDefault();
    onOpenAppDetails(app);
  });

  const nameCell = document.createElement("td");
  nameCell.className = "wm-apps-table__name-cell";
  const nameButton = document.createElement("button");
  nameButton.type = "button";
  nameButton.className = "wm-link-button wm-apps-table__name";
  nameButton.textContent = getAppDisplayName(app);
  nameButton.setAttribute("aria-label", `Open details for ${getAppDisplayName(app)}`);
  nameButton.dataset.testid = "apps-table-details";
  nameButton.addEventListener("click", () => onOpenAppDetails(app));
  const idLine = document.createElement("span");
  idLine.className = "wm-apps-table__id";
  idLine.textContent = String(app.id ?? "");
  nameCell.append(nameButton, idLine);
  row.append(nameCell);

  const statusCell = document.createElement("td");
  const statusValue = getAppStatusValue(app);
  const statusBadge = document.createElement("span");
  statusBadge.className = "wm-app-status";
  statusBadge.dataset.state = statusValue;
  statusBadge.textContent = appStatusLabels[statusValue] ?? statusValue;
  statusCell.append(statusBadge);
  row.append(statusCell);

  const typeCell = document.createElement("td");
  typeCell.textContent = getAppTypeLabel(app);
  row.append(typeCell);

  const portCell = document.createElement("td");
  const portValue = typeof app.webAppPort === "number" ? String(app.webAppPort) : "-";
  const openUrl = getAppOpenUrl(app);
  if (openUrl) {
    const link = document.createElement("a");
    link.href = openUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = portValue === "-" ? "Open" : portValue;
    link.setAttribute("aria-label", `Open ${getAppDisplayName(app)}`);
    portCell.append(link);
  } else {
    portCell.textContent = portValue;
  }
  row.append(portCell);

  const updatedCell = document.createElement("td");
  updatedCell.textContent = formatAppTimestamp(app.status?.updatedAt ?? null);
  row.append(updatedCell);

  const rootCell = document.createElement("td");
  rootCell.className = "wm-apps-table__root";
  rootCell.title = typeof app.root === "string" ? app.root : "";
  rootCell.textContent = typeof app.root === "string" && app.root.length > 0 ? app.root : "-";
  row.append(rootCell);

  const actionCell = document.createElement("td");
  actionCell.className = "wm-apps-table__actions";
  const detailsButton = document.createElement("button");
  detailsButton.type = "button";
  detailsButton.className = "wm-button secondary wm-button--small";
  detailsButton.textContent = "Details";
  detailsButton.setAttribute("aria-label", `Open details for ${getAppDisplayName(app)}`);
  detailsButton.addEventListener("click", () => onOpenAppDetails(app));
  actionCell.append(detailsButton);
  row.append(actionCell);

  return row;
}
