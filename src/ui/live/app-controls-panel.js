/**
 * App controls side panel for live sessions.
 * Renders app-card-style controls in the split sidebar.
 */

const APP_BUSY_STATUSES = new Set(["stopping", "restarting", "building", "setting-up"]);

const APP_ACTION_LABELS = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  setup: "Setup",
  build: "Build",
};

function createModeButton(mode, currentMode, title, icon, onModeChange) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `wm-webview-mode-btn${currentMode === mode ? " active" : ""}`;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = icon;
  button.addEventListener("click", () => onModeChange(mode));
  return button;
}

function isActionDisabled(app, action) {
  const status = app?.status;
  if (!status) return true;
  const available = Boolean(app?.availableScripts?.[action]);
  if (!available) return true;

  if (status.inProgressAction && status.inProgressAction !== action) {
    return true;
  }
  if (status.inProgressAction === action) {
    return true;
  }

  const statusValue = status.status;
  if (APP_BUSY_STATUSES.has(statusValue)) {
    return true;
  }

  if (action === "start") {
    return statusValue === "running";
  }
  if (action === "stop") {
    return statusValue !== "running";
  }
  if (action === "restart") {
    return false;
  }
  if (action === "setup" || action === "build") {
    return statusValue === "running";
  }

  return true;
}

function createStatusBadge(app) {
  const statusBadge = document.createElement("span");
  statusBadge.className = "wm-app-status";
  const statusValue = app?.status?.status ?? "idle";
  statusBadge.dataset.state = statusValue;
  statusBadge.textContent = statusValue;
  return statusBadge;
}

function createMetaRow(label, value) {
  const row = document.createElement("div");
  row.className = "wm-app-meta-row";

  const rowLabel = document.createElement("span");
  rowLabel.className = "wm-app-meta-label";
  rowLabel.textContent = label;

  const rowValue = document.createElement("span");
  rowValue.className = "wm-app-meta-value";
  rowValue.textContent = value;

  row.append(rowLabel, rowValue);
  return row;
}

export function createAppControlsToolbar(currentMode, onModeChange, onClose) {
  const toolbar = document.createElement("div");
  toolbar.className = "wm-webview-toolbar";

  const modeGroup = document.createElement("div");
  modeGroup.className = "wm-webview-toolbar-modes";

  const title = document.createElement("span");
  title.className = "wm-app-controls-toolbar-title";
  title.textContent = "App card";
  modeGroup.append(title);

  const chatNarrowBtn = createModeButton(
    "chat-narrow",
    currentMode,
    "Chat narrow, app card wide",
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="6" height="18" rx="1"/><rect x="10" y="3" width="12" height="18" rx="1"/></svg>',
    onModeChange,
  );

  const appNarrowBtn = createModeButton(
    "app-narrow",
    currentMode,
    "Chat wide, app card narrow",
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="12" height="18" rx="1"/><rect x="16" y="3" width="6" height="18" rx="1"/></svg>',
    onModeChange,
  );

  modeGroup.append(chatNarrowBtn, appNarrowBtn);

  const actionsGroup = document.createElement("div");
  actionsGroup.className = "wm-webview-toolbar-actions";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "wm-webview-close-btn";
  closeBtn.title = "Close app card";
  closeBtn.setAttribute("aria-label", "Close app card panel");
  closeBtn.dataset.testid = "app-card-panel-close";
  closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  closeBtn.addEventListener("click", onClose);

  actionsGroup.append(closeBtn);
  toolbar.append(modeGroup, actionsGroup);

  return toolbar;
}

export function createAppControlsPanel(app, options = {}) {
  const { onTriggerAction } = options;

  const panel = document.createElement("div");
  panel.className = "wm-app-controls-panel";
  panel.dataset.testid = "app-card-panel";

  const card = document.createElement("section");
  card.className = "wm-card wm-app-card wm-app-controls-card";

  const header = document.createElement("div");
  header.className = "wm-app-card__header";

  const title = document.createElement("h3");
  title.textContent = app.label ?? app.id;
  header.append(title, createStatusBadge(app));

  const meta = document.createElement("div");
  meta.className = "wm-app-meta";
  meta.append(createMetaRow("App ID", app.id ?? "Unknown"));
  meta.append(createMetaRow("Root", app.root ?? "Unknown"));

  if (typeof app.status?.message === "string" && app.status.message.trim().length > 0) {
    meta.append(createMetaRow("Message", app.status.message.trim()));
  }

  const actions = document.createElement("div");
  actions.className = "wm-app-controls-actions";
  let linkRow = null;

  const actionDefs = ["start", "stop", "restart", "setup", "build"];

  for (const action of actionDefs) {
    if (!app.availableScripts?.[action]) {
      continue;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = action === "stop" ? "wm-button secondary" : "wm-button";
    button.textContent = APP_ACTION_LABELS[action] ?? action;
    button.setAttribute("aria-label", `${APP_ACTION_LABELS[action] ?? action} ${app.label ?? app.id}`);
    button.dataset.testid = `app-card-action-${action}`;
    button.disabled = isActionDisabled(app, action);

    button.addEventListener("click", async () => {
      if (button.disabled || typeof onTriggerAction !== "function") {
        return;
      }

      const defaultLabel = APP_ACTION_LABELS[action] ?? action;
      button.disabled = true;
      button.textContent = `${defaultLabel}…`;
      const success = await onTriggerAction(app.id, action);
      if (!success && button.isConnected) {
        button.disabled = false;
        button.textContent = defaultLabel;
      }
    });

    actions.append(button);
  }

  if (app.subdomainUrl) {
    linkRow = document.createElement("div");
    linkRow.className = "wm-app-links wm-app-controls-links";

    const openSiteLink = document.createElement("a");
    openSiteLink.href = app.subdomainUrl;
    openSiteLink.target = "_blank";
    openSiteLink.rel = "noopener noreferrer";
    openSiteLink.textContent = "Open site";
    openSiteLink.setAttribute("aria-label", `Open ${app.label ?? app.id} site`);
    openSiteLink.dataset.testid = "app-card-open-site";
    linkRow.append(openSiteLink);

  }

  if (actions.children.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wm-apps-empty";
    empty.textContent = "No app actions are currently available for this app.";
    card.append(header, meta, empty);
    if (linkRow) {
      card.append(linkRow);
    }
    panel.append(card);
    return panel;
  }

  card.append(header, meta, actions);
  if (linkRow) {
    card.append(linkRow);
  }
  panel.append(card);
  return panel;
}
