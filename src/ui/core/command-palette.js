import { showRunningAppsModal } from "../apps/running-apps-modal.js";
import { showRunningPipelinesModal } from "../pipelines/running-pipelines-modal.js";
import { getSessionDisplayName } from "./icons.js";
import {
  escapeAttribute,
  escapeHtml,
  filterCommandPaletteItems,
  rememberRecentItem,
} from "./command-palette-utils.js";

const RECENT_SESSION_STORAGE_KEY = "wingman:command-palette:recent-sessions";
const RECENT_APP_RESTART_STORAGE_KEY = "wingman:command-palette:recent-app-restarts";
function readStoredArray(key) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredArray(key, items) {
  try {
    window.localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // Storage can fail in private mode or when quota is exhausted.
  }
}

function createCommandItem(input) {
  return {
    group: input.group,
    groupLabel: input.groupLabel,
    id: input.id,
    title: input.title,
    subtitle: input.subtitle ?? "",
    action: input.action,
    shortcutKey: input.shortcutKey ?? "",
    targetId: input.targetId ?? "",
    searchText: input.searchText ?? "",
  };
}

function normalizeStoredRecentSession(entry, sessions) {
  const id = typeof entry?.id === "string" ? entry.id : "";
  if (!id) return null;
  const session = sessions.find((candidate) => candidate?.id === id);
  if (!session) return null;
  return {
    id,
    title: getSessionDisplayName(session),
    subtitle: session.workingDirectory ?? session.directory ?? "Session",
  };
}

function normalizeStoredRecentApp(entry, apps) {
  const id = typeof entry?.id === "string" ? entry.id : "";
  if (!id) return null;
  const app = apps.find((candidate) => candidate?.id === id);
  if (!app) return null;
  return {
    id,
    title: app.label ?? app.id,
    subtitle: app.root ?? "Restart app",
  };
}

export function createAutopilotCommandPalette({
  brandButton,
  appsStore,
  sessionsStore,
  openDialog,
  openIdentityLoginDialog,
  isAuthenticated,
  openSession,
  renderAppCard,
  refreshApps,
  triggerAppAction,
  showToast,
}) {
  let overlay = null;
  let query = "";
  let activeId = "";

  function getQuickItems() {
    return [
      createCommandItem({
        group: "shortcut",
        groupLabel: "Shortcuts",
        id: "quick:new-session",
        title: "New Session",
        subtitle: "Launch an agent session",
        action: "new-session",
        shortcutKey: "1",
        searchText: "agent launch start new session",
      }),
      createCommandItem({
        group: "shortcut",
        groupLabel: "Shortcuts",
        id: "quick:running-apps",
        title: "Running Apps",
        subtitle: "Manage running app processes",
        action: "running-apps",
        shortcutKey: "2",
        searchText: "apps processes restart",
      }),
      createCommandItem({
        group: "shortcut",
        groupLabel: "Shortcuts",
        id: "quick:running-pipelines",
        title: "Running Pipelines",
        subtitle: "Inspect active pipeline runs",
        action: "running-pipelines",
        shortcutKey: "3",
        searchText: "pipelines runs workflows restart",
      }),
    ];
  }

  function getRecentSessionItems() {
    const sessions = Array.isArray(sessionsStore?.().items) ? sessionsStore().items : [];
    return readStoredArray(RECENT_SESSION_STORAGE_KEY)
      .map((entry) => normalizeStoredRecentSession(entry, sessions))
      .filter(Boolean)
      .map((entry) => createCommandItem({
        group: "recent-session",
        groupLabel: "Recent Sessions",
        id: `session:${entry.id}`,
        title: entry.title,
        subtitle: entry.subtitle,
        action: "open-session",
        targetId: entry.id,
        searchText: entry.id,
      }));
  }

  function getRecentAppItems() {
    const apps = Array.isArray(appsStore?.().items) ? appsStore().items : [];
    return readStoredArray(RECENT_APP_RESTART_STORAGE_KEY)
      .map((entry) => normalizeStoredRecentApp(entry, apps))
      .filter(Boolean)
      .map((entry) => createCommandItem({
        group: "recent-app",
        groupLabel: "Recent App Restarts",
        id: `app-restart:${entry.id}`,
        title: entry.title,
        subtitle: entry.subtitle,
        action: "restart-app",
        targetId: entry.id,
        searchText: entry.id,
      }));
  }

  function getItems() {
    return [...getQuickItems(), ...getRecentSessionItems(), ...getRecentAppItems()];
  }

  function getFilteredItems() {
    return filterCommandPaletteItems(getItems(), query);
  }

  function getGroupedItems(items) {
    const groups = [];
    for (const item of items) {
      let group = groups.find((entry) => entry.id === item.group);
      if (!group) {
        group = { id: item.group, label: item.groupLabel, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    }
    return groups;
  }

  function recordSessionVisit(session) {
    const id = typeof session?.id === "string" ? session.id : "";
    if (!id) return;
    const items = rememberRecentItem(readStoredArray(RECENT_SESSION_STORAGE_KEY), {
      id,
      title: getSessionDisplayName(session),
      subtitle: session.workingDirectory ?? session.directory ?? "",
    });
    writeStoredArray(RECENT_SESSION_STORAGE_KEY, items);
  }

  function recordAppRestart(app) {
    const id = typeof app?.id === "string" ? app.id : "";
    if (!id) return;
    const items = rememberRecentItem(readStoredArray(RECENT_APP_RESTART_STORAGE_KEY), {
      id,
      title: app.label ?? app.id,
      subtitle: app.root ?? "",
    });
    writeStoredArray(RECENT_APP_RESTART_STORAGE_KEY, items);
  }

  function close() {
    overlay?.remove();
    overlay = null;
    query = "";
    activeId = "";
  }

  function open() {
    if (!isAuthenticated?.()) {
      openIdentityLoginDialog?.();
      return;
    }
    close();
    overlay = document.createElement("div");
    overlay.className = "wm-command-palette-overlay";
    overlay.dataset.testid = "autopilot-command-palette";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "autopilot-command-palette-title");
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    document.body.append(overlay);
    render();
    requestAnimationFrame(() => {
      overlay?.querySelector("[data-command-palette-input]")?.focus();
    });
  }

  async function execute(item) {
    if (!item) return;
    close();
    if (item.action === "new-session") {
      openDialog?.();
      return;
    }
    if (item.action === "running-apps") {
      showRunningAppsModal({ appsStore, renderAppCard, refreshApps, triggerAppAction, showToast });
      return;
    }
    if (item.action === "running-pipelines") {
      showRunningPipelinesModal({ showToast });
      return;
    }
    if (item.action === "open-session") {
      const session = sessionsStore?.().items?.find((entry) => entry?.id === item.targetId);
      if (session) {
        recordSessionVisit(session);
        openSession?.(session);
      }
      return;
    }
    if (item.action === "restart-app") {
      const app = appsStore?.().items?.find((entry) => entry?.id === item.targetId);
      const success = item.targetId && typeof triggerAppAction === "function"
        ? await triggerAppAction(item.targetId, "restart")
        : false;
      if (success) {
        recordAppRestart(app ?? { id: item.targetId, label: item.title, root: item.subtitle });
        showToast?.(`Restarting ${item.title}...`, { type: "success" });
      }
    }
  }

  function setActive(nextId) {
    activeId = nextId;
    overlay?.querySelectorAll("[data-command-palette-item]").forEach((button) => {
      const selected = button.dataset.itemId === activeId;
      button.classList.toggle("wm-command-palette-result-active", selected);
      button.setAttribute("aria-selected", selected ? "true" : "false");
    });
  }

  function moveActive(delta) {
    const items = getFilteredItems();
    if (items.length === 0) return;
    const currentIndex = Math.max(0, items.findIndex((item) => item.id === activeId));
    const nextIndex = (currentIndex + delta + items.length) % items.length;
    setActive(items[nextIndex].id);
  }

  function render() {
    if (!overlay) return;
    const items = getFilteredItems();
    activeId = activeId && items.some((item) => item.id === activeId) ? activeId : items[0]?.id ?? "";
    const groups = getGroupedItems(items);
    overlay.innerHTML = `
      <section class="wm-command-palette" aria-labelledby="autopilot-command-palette-title">
        <h2 id="autopilot-command-palette-title" class="wm-sr-only">Command palette</h2>
        <div class="wm-command-palette-search">
          <input
            type="search"
            value="${escapeAttribute(query)}"
            placeholder="Search sessions, apps, and commands"
            data-command-palette-input
            aria-label="Search commands"
            autocomplete="off"
          />
          <kbd>Cmd K</kbd>
        </div>
        <div class="wm-command-palette-results" role="listbox" aria-label="Command results">
          ${groups.length ? groups.map(renderGroup).join("") : '<p class="wm-command-palette-empty">No commands match.</p>'}
        </div>
      </section>
    `;
    overlay.querySelector("[data-command-palette-input]")?.addEventListener("input", (event) => {
      query = event.target?.value ?? "";
      activeId = "";
      render();
      requestAnimationFrame(() => overlay?.querySelector("[data-command-palette-input]")?.focus());
    });
    overlay.querySelectorAll("[data-command-palette-item]").forEach((button) => {
      button.addEventListener("mouseenter", () => setActive(button.dataset.itemId ?? ""));
      button.addEventListener("click", () => {
        const item = getFilteredItems().find((entry) => entry.id === button.dataset.itemId);
        void execute(item);
      });
    });
  }

  function renderGroup(group) {
    const quickClass = group.id === "shortcut" ? " wm-command-palette-group-quick" : "";
    return `
      <section class="wm-command-palette-group${quickClass}">
        <h3>${escapeHtml(group.label)}</h3>
        <div class="wm-command-palette-group-items">
          ${group.items.map(renderItem).join("")}
        </div>
      </section>
    `;
  }

  function renderItem(item) {
    const isActive = item.id === activeId;
    return `
      <button
        type="button"
        class="wm-command-palette-result${isActive ? " wm-command-palette-result-active" : ""}"
        data-command-palette-item
        data-item-id="${escapeAttribute(item.id)}"
        role="option"
        aria-selected="${isActive ? "true" : "false"}"
      >
        <span class="wm-command-palette-result-key">${item.shortcutKey ? escapeHtml(item.shortcutKey) : ""}</span>
        <span class="wm-command-palette-result-main">
          <span class="wm-command-palette-result-title">${escapeHtml(item.title)}</span>
          <span class="wm-command-palette-result-subtitle">${escapeHtml(item.subtitle)}</span>
        </span>
        <span class="wm-command-palette-result-type">${escapeHtml(item.groupLabel)}</span>
      </button>
    `;
  }

  function handleKeydown(event) {
    const key = String(event.key || "").toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === "k") {
      event.preventDefault();
      open();
      return;
    }
    if (!overlay) return;
    if (key === "escape") {
      event.preventDefault();
      close();
      return;
    }
    if (key === "arrowdown") {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (key === "arrowup") {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (key === "enter") {
      event.preventDefault();
      const item = getFilteredItems().find((entry) => entry.id === activeId);
      void execute(item);
      return;
    }
    if (!query && /^[1-3]$/.test(key)) {
      event.preventDefault();
      void execute(getQuickItems()[Number(key) - 1]);
    }
  }

  brandButton?.addEventListener("click", (event) => {
    event.preventDefault();
    open();
  });
  window.addEventListener("keydown", handleKeydown, true);

  return {
    open,
    close,
    recordSessionVisit,
    recordAppRestart,
  };
}
