const THEME_STORAGE_KEY = "wingman-theme";

const state = {
  config: null,
  sessions: [],
  logs: new Map(),
  conversations: new Map(),
  messageDrafts: new Map(),
  activeSessionId: null,
  lastWorkingDirectory: null,
};

const dialog = document.getElementById("session-dialog");
const agentSelect = document.getElementById("agent-select");
const confirmButton = document.getElementById("confirm-session");
const cancelButton = document.getElementById("cancel-session");
const appRoot = document.getElementById("app");
const navLinks = Array.from(document.querySelectorAll("nav a[data-route]"));
const themeToggle = document.getElementById("theme-toggle");
const directoryInput = document.getElementById("working-directory");
const directorySuggestions = document.getElementById("directory-suggestions");
const browseDirectoryButton = document.getElementById("browse-directory");
const directoryDialog = document.getElementById("directory-dialog");
const directoryList = document.getElementById("directory-list");
const directoryCurrent = document.getElementById("directory-current");
const directoryUpButton = document.getElementById("directory-up");
const directoryUseButton = document.getElementById("directory-use");

const getRouteFromPath = (pathname) => {
  if (pathname === "/live") return "live";
  return "home";
};

let currentRoute = getRouteFromPath(window.location.pathname);
let currentTheme = "dark";

const applyTheme = (theme, persist = true) => {
  currentTheme = theme;
  document.body.dataset.theme = theme;
  themeToggle?.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (error) {
      console.warn("Failed to persist theme preference", error);
    }
  }
};

const detectPreferredTheme = () => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // ignore storage failures
  }
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
};

const toggleTheme = () => {
  const nextTheme = currentTheme === "dark" ? "light" : "dark";
  applyTheme(nextTheme);
};

const initTheme = () => {
  const preferred = detectPreferredTheme();
  applyTheme(preferred, false);
  if (themeToggle) {
    themeToggle.addEventListener("click", toggleTheme);
  }
  if (window.matchMedia) {
    const listener = (event) => {
      const stored = (() => {
        try {
          return localStorage.getItem(THEME_STORAGE_KEY);
        } catch {
          return null;
        }
      })();
      if (stored !== "light" && stored !== "dark") {
        applyTheme(event.matches ? "dark" : "light", false);
      }
    };
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", listener);
  }
};

const setActiveNav = () => {
  navLinks.forEach((link) => {
    const route = link.dataset.route;
    if (route === currentRoute) {
      link.classList.add("active");
    } else {
      link.classList.remove("active");
    }
  });
};

const DIRECTORY_SUGGESTION_DELAY = 160;
let directorySuggestionTimer = null;
let directorySuggestionRequestId = 0;

const directoryBrowserState = {
  currentPath: "",
  parent: null,
  requestId: 0,
};

const parseDirectoryLookup = (rawValue) => {
  const defaultPath = state.config?.defaultDirectory ?? "";
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) {
    return { basePath: defaultPath, term: "" };
  }

  const hasTrailingSeparator = /[\\/]$/.test(value);
  if (hasTrailingSeparator) {
    return { basePath: value, term: "" };
  }

  const lastForward = value.lastIndexOf("/");
  const lastBackward = value.lastIndexOf("\\");
  const separatorIndex = Math.max(lastForward, lastBackward);

  if (separatorIndex === -1) {
    return { basePath: defaultPath, term: value };
  }

  return {
    basePath: value.slice(0, separatorIndex + 1),
    term: value.slice(separatorIndex + 1),
  };
};

const requestDirectoryData = async (path, query) => {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (query) params.set("query", query);
  const search = params.toString();
  const url = search ? `/api/directories?${search}` : "/api/directories";
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error("Failed to request directory data", error);
    return null;
  }
};

const populateDirectorySuggestions = (data) => {
  if (!directorySuggestions) return;
  directorySuggestions.innerHTML = "";
  if (!data) return;

  const seen = new Set();
  const addOption = (value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    const option = document.createElement("option");
    option.value = value;
    directorySuggestions.append(option);
  };

  addOption(data.path);
  data.entries.forEach((entry) => addOption(entry.path));
};

const fetchDirectorySuggestions = async (value) => {
  if (!state.config) return;
  const requestId = ++directorySuggestionRequestId;
  const { basePath, term } = parseDirectoryLookup(value);
  let data = await requestDirectoryData(basePath, term);
  if (!data && basePath !== state.config.defaultDirectory) {
    data = await requestDirectoryData(state.config.defaultDirectory, term);
  }
  if (directorySuggestionRequestId !== requestId) return;
  populateDirectorySuggestions(data);
};

const scheduleDirectorySuggestions = (value) => {
  if (!directorySuggestions) return;
  if (directorySuggestionTimer) {
    clearTimeout(directorySuggestionTimer);
  }
  directorySuggestionTimer = setTimeout(() => {
    fetchDirectorySuggestions(value);
  }, DIRECTORY_SUGGESTION_DELAY);
};

const chooseDirectory = (path) => {
  if (!directoryInput) return;
  if (typeof path !== "string" || path.length === 0) return;
  directoryInput.value = path;
  state.lastWorkingDirectory = path;
  scheduleDirectorySuggestions(path);
  if (directoryDialog?.open) {
    directoryDialog.close();
  }
};

const renderDirectoryBrowser = (data) => {
  if (!data) return;
  if (directoryCurrent) {
    directoryCurrent.textContent = data.path;
  }
  if (directoryUpButton) {
    directoryUpButton.disabled = !data.parent;
  }
  if (!directoryList) return;
  directoryList.innerHTML = "";
  if (!Array.isArray(data.entries) || data.entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "directory-browser__empty";
    empty.textContent = "No subdirectories";
    directoryList.append(empty);
    return;
  }
  data.entries.forEach((entry) => {
    const item = document.createElement("li");
    item.className = "directory-browser__item";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "directory-browser__folder";
    openButton.textContent = entry.name;
    openButton.addEventListener("click", () => {
      updateDirectoryBrowser(entry.path);
    });

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "directory-browser__choose wm-button secondary";
    selectButton.textContent = "Select";
    selectButton.addEventListener("click", () => {
      chooseDirectory(entry.path);
    });

    item.append(openButton, selectButton);
    directoryList.append(item);
  });
};

const updateDirectoryBrowser = async (path) => {
  if (!state.config) return false;
  const requestId = ++directoryBrowserState.requestId;
  let data = await requestDirectoryData(path, undefined);
  if (!data && path && path !== state.config.defaultDirectory) {
    data = await requestDirectoryData(state.config.defaultDirectory, undefined);
  }
  if (directoryBrowserState.requestId !== requestId || !data) {
    return false;
  }
  directoryBrowserState.currentPath = data.path;
  directoryBrowserState.parent = data.parent;
  renderDirectoryBrowser(data);
  return true;
};

const openDirectoryBrowser = async () => {
  if (!state.config) return;
  if (!directoryDialog || typeof directoryDialog.showModal !== "function") {
    const fallback = window.prompt(
      "Enter working directory",
      directoryInput?.value ||
        state.lastWorkingDirectory ||
        state.config.defaultDirectory ||
        "",
    );
    if (fallback) {
      chooseDirectory(fallback);
    }
    return;
  }
  const seed =
    directoryInput?.value?.trim() ||
    state.lastWorkingDirectory ||
    state.config.defaultDirectory ||
    "";
  const loaded = await updateDirectoryBrowser(seed);
  if (!loaded) {
    window.alert("Unable to open directory browser for the requested path.");
    return;
  }
  directoryDialog.showModal();
};

const fetchConfig = async () => {
  const response = await fetch("/api/config");
  state.config = await response.json();
  agentSelect.innerHTML = "";
  state.config.agents.forEach((agent) => {
    const option = document.createElement("option");
    option.value = agent.id;
    option.textContent = agent.label;
    agentSelect.append(option);
  });
  if (directoryInput) {
    const initial =
      state.lastWorkingDirectory ??
      state.config.defaultDirectory ??
      "";
    directoryInput.value = initial;
    directoryInput.placeholder = state.config.defaultDirectory ?? "";
    scheduleDirectorySuggestions(initial);
  }
};

const fetchSessions = async () => {
  const response = await fetch("/api/sessions");
  const data = await response.json();
  state.sessions = data.sessions ?? [];

  const sessionIds = new Set(state.sessions.map((session) => session.id));
  for (const key of Array.from(state.logs.keys())) {
    if (!sessionIds.has(key)) state.logs.delete(key);
  }
  for (const key of Array.from(state.conversations.keys())) {
    if (!sessionIds.has(key)) state.conversations.delete(key);
  }
  for (const key of Array.from(state.messageDrafts.keys())) {
    if (!sessionIds.has(key)) state.messageDrafts.delete(key);
  }

  if (!state.activeSessionId && state.sessions.length > 0) {
    state.activeSessionId = state.sessions[0].id;
  }

  if (currentRoute === "live" && state.activeSessionId) {
    await Promise.all([
      fetchLogs(state.activeSessionId),
      fetchConversation(state.activeSessionId),
    ]);
  }
};

const fetchLogs = async (sessionId) => {
  const response = await fetch(`/api/sessions/${sessionId}/logs`);
  if (!response.ok) return;
  const data = await response.json();
  state.logs.set(sessionId, data.logs);
};

const fetchConversation = async (sessionId) => {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/messages?refresh=true`);
    if (!response.ok) return;
    const data = await response.json();
    const items = Array.isArray(data?.messages) ? data.messages : [];
    state.conversations.set(sessionId, items);
  } catch (error) {
    console.error("Failed to load conversation", error);
  }
};

const pollSessions = async () => {
  try {
    await fetchSessions();
    render();
  } catch (error) {
    console.error("Failed to refresh sessions", error);
  } finally {
    setTimeout(pollSessions, 5000);
  }
};

const openDialog = () => {
  if (!state.config) return;
  const fallbackDirectory =
    directoryInput?.value?.trim() ||
    state.lastWorkingDirectory ||
    state.config.defaultDirectory ||
    "";
  if (directoryInput) {
    directoryInput.value = fallbackDirectory;
    scheduleDirectorySuggestions(fallbackDirectory);
  }
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    directoryInput?.focus();
    directoryInput?.select();
  } else {
    // Fallback: use prompt if dialog unsupported.
    const agent = window.prompt(
      `Select agent (${state.config.agents.map((a) => a.id).join(", ")}):`,
      state.config.agents[0]?.id ?? "",
    );
    if (agent) {
      const directory = window.prompt("Working directory:", fallbackDirectory) ?? fallbackDirectory;
      launchSession(agent, directory);
    }
  }
};

const closeDialog = () => {
  if (dialog.open) {
    dialog.close();
  }
};

const launchSession = async (agentId, workingDirectory) => {
  if (!agentId) {
    window.alert("Select an agent before launching a session.");
    return;
  }

  const payload = { agent: agentId };
  if (typeof workingDirectory === "string" && workingDirectory.trim().length > 0) {
    payload.directory = workingDirectory.trim();
  }

  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    window.alert(`Failed to start session: ${data.error ?? response.statusText}`);
    return;
  }

  const session = await response.json();
  state.activeSessionId = session.id;
  if (typeof session.workingDirectory === "string" && session.workingDirectory.length > 0) {
    state.lastWorkingDirectory = session.workingDirectory;
    if (directoryInput) {
      directoryInput.value = session.workingDirectory;
      scheduleDirectorySuggestions(session.workingDirectory);
    }
  }
  await fetchSessions();
  await Promise.all([fetchConversation(session.id), fetchLogs(session.id)]);
  render();
};

const stopSession = async (sessionId) => {
  const response = await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    window.alert(`Failed to stop session: ${data.error ?? response.statusText}`);
    return;
  }
  await fetchSessions();
  if (state.activeSessionId === sessionId) {
    state.activeSessionId = state.sessions[0]?.id ?? null;
  }
  render();
};

const sendMessage = async (sessionId, content) => {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  if (!content?.trim()) {
    window.alert("Enter a message before sending.");
    return;
  }

  try {
    const response = await fetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      window.alert(`Agent request failed: ${data.error ?? response.statusText}`);
      return;
    }
    const payload = await response.json();
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    state.conversations.set(sessionId, messages);
    state.messageDrafts.set(sessionId, "");
    await fetchLogs(sessionId);
    render();
  } catch (error) {
    console.error("Failed to send agent message", error);
    window.alert("Failed to send message to agent. Check console for details.");
  }
};

const renderHome = () => {
  const container = document.createElement("section");
  container.className = "wm-card";

  const actions = document.createElement("div");
  actions.className = "wm-actions";

  const launchBtn = document.createElement("button");
  launchBtn.className = "wm-button";
  launchBtn.textContent = "Launch Agent Session";
  launchBtn.addEventListener("click", openDialog);
  actions.append(launchBtn);

  container.append(actions);

  const table = document.createElement("table");
  table.className = "session-table";

  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr><th>Agent</th><th>Status</th><th>Port</th><th>PID</th><th>Started</th><th>Directory</th><th></th></tr>";
  table.append(thead);

  const tbody = document.createElement("tbody");
  if (state.sessions.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.textContent = "No active sessions";
    row.append(cell);
    tbody.append(row);
  } else {
    state.sessions.forEach((session) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${session.agent}</td>
        <td>${session.status}</td>
        <td>${session.port}</td>
        <td>${session.pid ?? "-"}</td>
        <td>${new Date(session.startedAt).toLocaleTimeString()}</td>
        <td class="directory-cell"></td>
        <td></td>
      `;
      const directoryCell = row.querySelector(".directory-cell");
      if (directoryCell) {
        const directoryValue =
          session.workingDirectory ??
          state.config?.defaultDirectory ??
          "-";
        directoryCell.textContent = directoryValue;
        if (typeof session.workingDirectory === "string") {
          directoryCell.title = session.workingDirectory;
        } else {
          directoryCell.removeAttribute("title");
        }
      }
      const actionsCell = row.lastElementChild;
      const stopBtn = document.createElement("button");
      stopBtn.className = "wm-button secondary";
      stopBtn.textContent = "Stop";
      stopBtn.addEventListener("click", () => stopSession(session.id));
      actionsCell.append(stopBtn);
      tbody.append(row);
    });
  }

  table.append(tbody);
  container.append(table);
  return container;
};

const renderTabs = () => {
  const tabs = document.createElement("div");
  tabs.className = "wm-tabs";

  state.sessions.forEach((session) => {
    const tab = document.createElement("div");
    tab.className = "wm-tab";
    if (session.id === state.activeSessionId) {
      tab.classList.add("active");
    }

    tab.innerHTML = `
      <span>${session.agent} :${session.port}</span>
      <span class="close" title="Stop session">×</span>
    `;

    tab.addEventListener("click", () => {
      state.activeSessionId = session.id;
      fetchLogs(session.id);
      fetchConversation(session.id).finally(render);
    });

    const closeButton = tab.querySelector(".close");
    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      stopSession(session.id);
    });

    tabs.append(tab);
  });

  const newTab = document.createElement("div");
  newTab.className = "wm-tab new";
  newTab.textContent = "+";
  newTab.title = "Start new session";
  newTab.addEventListener("click", openDialog);
  tabs.append(newTab);

  return tabs;
};

const renderLogs = (sessionId) => {
  const logs = state.logs.get(sessionId) ?? ["No logs yet"];
  const container = document.createElement("div");
  container.className = "log-viewer";
  container.textContent = logs.join("\n");
  return container;
};

const renderConversation = (sessionId) => {
  const conversation = state.conversations.get(sessionId) ?? [];
  const wrapper = document.createElement("div");
  wrapper.className = "wm-conversation";

  if (conversation.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "Conversation has no messages yet.";
    wrapper.append(empty);
    return wrapper;
  }

  conversation.forEach((message) => {
    const bubble = document.createElement("article");
    bubble.className = `wm-message ${message.type ?? message.role ?? "assistant"}`;
    const header = document.createElement("header");
    header.textContent = (message.type ?? message.role ?? "assistant").toUpperCase();
    const body = document.createElement("pre");
    body.textContent = message.content ?? message.message ?? "";
    bubble.append(header, body);
    wrapper.append(bubble);
  });

  return wrapper;
};

const renderLive = () => {
  const container = document.createElement("section");
  container.className = "wm-card";

  container.append(renderTabs());

  if (state.sessions.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No live sessions. Launch a new agent to begin.";
    container.append(empty);
    return container;
  }

  if (!state.activeSessionId) {
    state.activeSessionId = state.sessions[0].id;
  }

  const sessionId = state.activeSessionId;
  const logSection = renderLogs(sessionId);
  logSection.style.marginTop = "1.5rem";

  container.append(renderConversation(sessionId));
  container.append(logSection);

  const composer = document.createElement("form");
  composer.className = "wm-composer";
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const draft = state.messageDrafts.get(sessionId) ?? "";
    sendMessage(sessionId, draft);
  });

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Ask the agent something...";
  textarea.value = state.messageDrafts.get(sessionId) ?? "";
  textarea.addEventListener("input", (event) => {
    state.messageDrafts.set(sessionId, event.target.value);
  });

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "wm-button";
  submit.textContent = "Send";

  composer.append(textarea, submit);
  container.append(composer);
  return container;
};

const render = () => {
  appRoot.innerHTML = "";
  const view = currentRoute === "live" ? renderLive() : renderHome();
  appRoot.append(view);
  setActiveNav();
};

navLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const targetRoute = link.dataset.route;
    if (!targetRoute || targetRoute === currentRoute) return;
    currentRoute = targetRoute;
    const path = targetRoute === "live" ? "/live" : "/home";
    window.history.pushState({ route: targetRoute }, "", path);
    render();
  });
});

if (directoryInput) {
  directoryInput.addEventListener("input", (event) => {
    scheduleDirectorySuggestions(event.target.value);
  });
  directoryInput.addEventListener("focus", () => {
    scheduleDirectorySuggestions(directoryInput.value);
  });
}

browseDirectoryButton?.addEventListener("click", (event) => {
  event.preventDefault();
  openDirectoryBrowser();
});

directoryUpButton?.addEventListener("click", (event) => {
  event.preventDefault();
  if (directoryBrowserState.parent) {
    updateDirectoryBrowser(directoryBrowserState.parent);
  }
});

directoryUseButton?.addEventListener("click", (event) => {
  event.preventDefault();
  if (directoryBrowserState.currentPath) {
    chooseDirectory(directoryBrowserState.currentPath);
  }
});

if (directoryDialog) {
  directoryDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    directoryDialog.close();
  });
  directoryDialog.addEventListener("close", () => {
    directoryBrowserState.requestId += 1;
  });
}

window.addEventListener("popstate", () => {
  currentRoute = getRouteFromPath(window.location.pathname);
  render();
});

confirmButton.addEventListener("click", (event) => {
  event.preventDefault();
  const agentId = agentSelect.value;
  const workingDirectory = directoryInput?.value ?? "";
  closeDialog();
  launchSession(agentId, workingDirectory);
});

cancelButton.addEventListener("click", (event) => {
  event.preventDefault();
  closeDialog();
});

dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog();
});

(async () => {
  initTheme();
  await fetchConfig();
  await fetchSessions();
  render();
  pollSessions();
})();
