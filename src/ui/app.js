const THEME_STORAGE_KEY = "wingman-theme";
const TABS_VISIBILITY_STORAGE_KEY = "wingman-tabs-visible";

const state = {
  config: null,
  sessions: [],
  logs: new Map(),
  conversations: new Map(),
  messageDrafts: new Map(),
  logPanelOpen: new Map(),
  activeSessionId: null,
  lastWorkingDirectory: null,
  lastActiveSessionId: null,
  // DOM references for incremental updates
  conversationContainers: new Map(), // sessionId -> DOM element
  logContainers: new Map(), // sessionId -> DOM element
  lastMessageCount: new Map(), // sessionId -> number of messages
  lastLogLength: new Map(), // sessionId -> length of logs
  autoScrollEnabled: new Map(), // sessionId -> boolean
};

const AUTO_SCROLL_THRESHOLD = 80;

const ensureAutoScrollPreference = (sessionId) => {
  if (!state.autoScrollEnabled.has(sessionId)) {
    state.autoScrollEnabled.set(sessionId, true);
  }
  return state.autoScrollEnabled.get(sessionId);
};

const getScrollMetrics = (element) => {
  if (!element) return null;
  if (element === document.body || element === document.documentElement || element === document.scrollingElement) {
    const target = document.scrollingElement || document.documentElement || document.body;
    const scrollTop = target.scrollTop ?? window.scrollY ?? 0;
    const clientHeight = target.clientHeight ?? window.innerHeight ?? 0;
    const scrollHeight = target.scrollHeight ?? 0;
    return { scrollTop, clientHeight, scrollHeight };
  }
  return {
    scrollTop: element.scrollTop ?? 0,
    clientHeight: element.clientHeight ?? 0,
    scrollHeight: element.scrollHeight ?? 0,
  };
};

const isElementNearBottom = (element) => {
  const metrics = getScrollMetrics(element);
  if (!metrics) return true;
  const { scrollTop, clientHeight, scrollHeight } = metrics;
  return scrollHeight - (scrollTop + clientHeight) <= AUTO_SCROLL_THRESHOLD;
};

const getFallbackScrollElement = () =>
  document.scrollingElement || document.documentElement || document.body;

const scrollConversationToBottom = (element) => {
  if (!element) return;
  requestAnimationFrame(() => {
    if (element === document.body || element === document.documentElement || element === document.scrollingElement) {
      const target = document.scrollingElement || document.documentElement || document.body;
      window.scrollTo(0, target.scrollHeight);
      return;
    }
    element.scrollTop = element.scrollHeight;
  });
};

const getConversationScrollElement = (sessionId) => {
  const container = state.conversationContainers.get(sessionId);
  if (!container) return null;
  return container.closest('.wm-live-conversation');
};

const getActiveScrollElement = (sessionId) => {
  const conversationElement = getConversationScrollElement(sessionId);
  if (conversationElement) {
    return conversationElement;
  }
  return getFallbackScrollElement();
};

const updateAutoScrollStateForSession = (sessionId) => {
  const scrollElement = getActiveScrollElement(sessionId);
  if (!scrollElement) return;
  const nearBottom = isElementNearBottom(scrollElement);
  state.autoScrollEnabled.set(sessionId, nearBottom);
};

const attachConversationScrollHandler = (sessionId, element) => {
  if (!element) return;
  if (element.dataset.scrollMonitorSessionId === sessionId) return;
  const handler = () => updateAutoScrollStateForSession(sessionId);
  element.addEventListener("scroll", handler, { passive: true });
  element.dataset.scrollMonitorSessionId = sessionId;
};

const scrollConversationAreaToBottom = (sessionId, options = {}) => {
  const { includeWindow = false } = options;
  const target = getActiveScrollElement(sessionId);
  if (target) {
    scrollConversationToBottom(target);
  }
  if (includeWindow) {
    const fallback = getFallbackScrollElement();
    if (fallback && fallback !== target) {
      scrollConversationToBottom(fallback);
    }
  }
  requestAnimationFrame(() => updateAutoScrollStateForSession(sessionId));
};

const copyTextToClipboard = async (text) => {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "absolute";
    fallback.style.left = "-9999px";
    document.body.append(fallback);
    fallback.select();
    const success = document.execCommand("copy");
    fallback.remove();
    return success;
  } catch (error) {
    console.error("Failed to copy to clipboard", error);
    return false;
  }
};

const attachCopyButton = (bubble) => {
  if (!bubble || bubble.dataset.copyAttached === "true") return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "wm-message-copy";
  button.setAttribute("aria-label", "Copy message");
  button.innerHTML =
    '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M15 3H7a2 2 0 0 0-2 2v10h2V5h8V3zm4 4h-8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zm0 12h-8V9h8v10z"/></svg>';
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const body = bubble.querySelector("pre");
    const text = body?.textContent ?? "";
    const copied = await copyTextToClipboard(text);
    if (copied) {
      bubble.dataset.copied = "true";
      setTimeout(() => {
        if (bubble.isConnected) {
          delete bubble.dataset.copied;
        }
      }, 1600);
    }
  });
  bubble.append(button);
  bubble.dataset.copyAttached = "true";
};

const copyConversationToClipboard = async (sessionId) => {
  const conversation = state.conversations.get(sessionId) ?? [];
  let textBlocks = conversation;
  if (textBlocks.length === 0) {
    const container = state.conversationContainers.get(sessionId);
    if (container) {
      const domMessages = container.querySelectorAll(".wm-message pre");
      textBlocks = Array.from(domMessages).map((node) => ({
        role: null,
        content: node.textContent ?? "",
      }));
    }
  }

  if (textBlocks.length === 0) return false;

  const formatted = textBlocks
    .map((message) => {
      const role = typeof message.role === "string" ? message.role : message.type;
      const labelSource = role ?? "assistant";
      const label = `${labelSource.charAt(0).toUpperCase()}${labelSource.slice(1)}`;
      const content = message.content ?? message.message ?? "";
      if (!content) return label;
      return `${label}:\n${content}`;
    })
    .join("\n\n")
    .trim();

  if (!formatted) return false;
  return copyTextToClipboard(formatted);
};

let windowScrollHandler = null;

const ensureWindowScrollMonitoring = () => {
  if (windowScrollHandler) return;
  windowScrollHandler = () => {
    const sessionId = state.activeSessionId;
    if (!sessionId) return;
    updateAutoScrollStateForSession(sessionId);
  };
  window.addEventListener("scroll", windowScrollHandler, { passive: true });
  window.addEventListener("resize", windowScrollHandler);
};

const getSessionById = (sessionId) => state.sessions.find((session) => session.id === sessionId);
const ACTIVE_SESSION_STATUSES = new Set(["starting", "running"]);
const isSessionActive = (session) => ACTIVE_SESSION_STATUSES.has(session?.status);
const getActiveSessions = () => state.sessions.filter((session) => isSessionActive(session));

const LIVE_ROUTE_PREFIX = "/live";

const getRouteFromPath = (pathname) => {
  if (pathname === LIVE_ROUTE_PREFIX || pathname.startsWith(`${LIVE_ROUTE_PREFIX}/`)) {
    return "live";
  }
  return "home";
};

const getSessionIdFromPath = (pathname) => {
  if (!pathname.startsWith(LIVE_ROUTE_PREFIX)) {
    return null;
  }
  if (pathname === LIVE_ROUTE_PREFIX) {
    return null;
  }
  const segments = pathname.slice(LIVE_ROUTE_PREFIX.length + 1).split("/").filter(Boolean);
  return segments[0] ?? null;
};

let currentRoute = getRouteFromPath(window.location.pathname);
let currentTheme = "dark";
let tabsVisible = true;
let lastLoggedSessionId = null;

const initialRouteSessionId = getSessionIdFromPath(window.location.pathname);
if (initialRouteSessionId) {
  state.activeSessionId = initialRouteSessionId;
  state.lastActiveSessionId = initialRouteSessionId;
}

const setActiveSession = (sessionId, options = {}) => {
  const { updateHistory = true, logPort = true, allowPending = false, forceLog = false } = options;
  const previousSessionId = state.activeSessionId;

  if (sessionId) {
    const sessionExists = state.sessions.some((session) => session.id === sessionId);
    if (!sessionExists && !allowPending) {
      state.activeSessionId = null;
      lastLoggedSessionId = null;
      return false;
    }

    state.activeSessionId = sessionId;
    state.lastActiveSessionId = sessionId;

    if (updateHistory && currentRoute === "live") {
      const targetPath = `${LIVE_ROUTE_PREFIX}/${sessionId}`;
      if (window.location.pathname !== targetPath) {
        window.history.pushState({ route: "live", sessionId }, "", targetPath);
      }
    }

    if (logPort && sessionExists) {
      const shouldLog = forceLog ? lastLoggedSessionId !== sessionId : sessionId !== previousSessionId;
      if (shouldLog) {
        const session = getSessionById(sessionId);
        if (session) {
          console.log("This session is sending to port:", session.port);
          lastLoggedSessionId = sessionId;
        }
      }
    }

    return true;
  }

  state.activeSessionId = null;
  lastLoggedSessionId = null;
  if (updateHistory && currentRoute === "live" && window.location.pathname !== LIVE_ROUTE_PREFIX) {
    window.history.pushState({ route: "live" }, "", LIVE_ROUTE_PREFIX);
  }
  return true;
};

const ensureActiveSession = () => {
  if (state.activeSessionId && state.sessions.some((session) => session.id === state.activeSessionId)) {
    return state.activeSessionId;
  }
  if (state.lastActiveSessionId && state.sessions.some((session) => session.id === state.lastActiveSessionId)) {
    setActiveSession(state.lastActiveSessionId, { updateHistory: false, logPort: false });
    return state.activeSessionId;
  }
  if (currentRoute === "live") {
    setActiveSession(null, { updateHistory: false, logPort: false });
    return null;
  }
  const activeSessions = getActiveSessions();
  const fallback = activeSessions[0] ?? state.sessions[0] ?? null;
  if (fallback) {
    setActiveSession(fallback.id, { updateHistory: false, logPort: false });
  } else {
    setActiveSession(null, { updateHistory: false, logPort: false });
  }
  return state.activeSessionId;
};

const applyRouteSessionFromPath = (options = {}) => {
  const { allowHistoryUpdate = false, logPort = true } = options;
  const routeSessionId = getSessionIdFromPath(window.location.pathname);

  if (routeSessionId) {
    if (state.sessions.some((session) => session.id === routeSessionId)) {
      if (state.activeSessionId !== routeSessionId) {
        setActiveSession(routeSessionId, { updateHistory: false, logPort });
      }
      return false;
    }
    if (state.activeSessionId) {
      setActiveSession(null, { updateHistory: false, logPort: false });
    }
    return true;
  }

  if (allowHistoryUpdate && state.lastActiveSessionId && state.sessions.some((session) => session.id === state.lastActiveSessionId)) {
    setActiveSession(state.lastActiveSessionId, { updateHistory: true, logPort });
    return false;
  }

  if (state.activeSessionId && !state.sessions.some((session) => session.id === state.activeSessionId)) {
    setActiveSession(null, { updateHistory: allowHistoryUpdate, logPort: false });
  }
  return false;
};
const insertTextAtCursor = (textarea, text, sessionId) => {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const next = `${before}${text}${after}`;
  textarea.value = next;
  const nextCursor = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = nextCursor;
  state.messageDrafts.set(sessionId, next);
  return next;
};

const extractImageFiles = (items) => {
  if (!items) return [];
  const files = [];
  for (const item of Array.from(items)) {
    if (!item) continue;
    if (item.kind === "file") {
      const file = item.getAsFile?.() ?? item;
      if (file && file.type?.startsWith?.("image/")) {
        files.push(file);
      }
    } else if ("type" in item && item.type?.startsWith?.("image/")) {
      files.push(item);
    }
  }
  return files;
};

const handleImageUploads = async (sessionId, files, textarea, resizeTextarea, setUploadingState) => {
  if (!files || files.length === 0) return;
  const session = getSessionById(sessionId);
  if (!session) {
    window.alert("Unable to locate session for image upload.");
    return;
  }

  for (const file of files) {
    if (!file?.type?.startsWith?.("image/")) {
      continue;
    }
    setUploadingState(true);
    try {
      const form = new FormData();
      form.append("agent", session.agent);
      form.append("image", file, file.name);

      const response = await fetch("/api/uploads/images", {
        method: "POST",
        body: form,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const message = data?.error ?? response.statusText ?? "Image upload failed";
        window.alert(message);
        continue;
      }

      const payload = await response.json().catch(() => ({}));
      const placeholder =
        typeof payload?.placeholder === "string"
          ? payload.placeholder
          : typeof payload?.publicPath === "string"
            ? payload.publicPath
            : null;

      if (!placeholder) {
        window.alert("Image upload succeeded without a usable reference.");
        continue;
      }

      const textToInsert = textarea.value.endsWith("\n") ? `${placeholder}\n` : `\n${placeholder}\n`;
      insertTextAtCursor(textarea, textToInsert, sessionId);
      resizeTextarea();
      textarea.focus();
    } catch (error) {
      console.error("Failed to upload image", error);
      window.alert("Image upload failed. Check console for details.");
    } finally {
      setUploadingState(false);
    }
  }
};

const dialog = document.getElementById("session-dialog");
const agentSelect = document.getElementById("agent-select");
const confirmButton = document.getElementById("confirm-session");
const cancelButton = document.getElementById("cancel-session");
const sessionForm = dialog?.querySelector("form");
const appRoot = document.getElementById("app");
const navLinks = Array.from(document.querySelectorAll("nav a[data-route]"));
const themeToggle = document.getElementById("theme-toggle");
const tabsToggle = document.getElementById("tabs-toggle");
const menuToggle = document.getElementById("menu-toggle");
const menuPanel = document.querySelector(".wm-menu-panel");
const menuTabsContainer = document.getElementById("menu-tabs");
const pullRefreshIndicator = document.getElementById("pull-refresh");
const pullRefreshLabel = pullRefreshIndicator?.querySelector(".label");
const directoryInput = document.getElementById("working-directory");
const directorySuggestions = document.getElementById("directory-suggestions");
const browseDirectoryButton = document.getElementById("browse-directory");
const directoryDialog = document.getElementById("directory-dialog");
const directoryList = document.getElementById("directory-list");
const directoryCurrent = document.getElementById("directory-current");
const directoryUpButton = document.getElementById("directory-up");
const directoryUseButton = document.getElementById("directory-use");

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

const applyTabsVisibility = (visible, persist = true) => {
  tabsVisible = visible;
  document.body.dataset.tabsVisible = visible ? "true" : "false";
  tabsToggle?.setAttribute("aria-pressed", visible ? "false" : "true");
  if (persist) {
    try {
      localStorage.setItem(TABS_VISIBILITY_STORAGE_KEY, visible ? "true" : "false");
    } catch (error) {
      console.warn("Failed to persist tabs visibility preference", error);
    }
  }
};

const detectPreferredTabsVisibility = () => {
  try {
    const stored = localStorage.getItem(TABS_VISIBILITY_STORAGE_KEY);
    if (stored === "true" || stored === "false") {
      return stored === "true";
    }
  } catch {
    // ignore storage failures
  }
  return true; // default to visible
};

const toggleTabsVisibility = () => {
  const nextVisible = !tabsVisible;
  applyTabsVisibility(nextVisible);
};

const closeMenu = () => {
  if (document.body.dataset.menuOpen === "true") {
    delete document.body.dataset.menuOpen;
    menuToggle?.setAttribute("aria-expanded", "false");
    menuPanel?.setAttribute("aria-hidden", "true");
    resetPullRefresh();
  }
};

const toggleMenu = () => {
  const isOpen = document.body.dataset.menuOpen === "true";
  if (isOpen) {
    closeMenu();
  } else {
    document.body.dataset.menuOpen = "true";
    menuToggle?.setAttribute("aria-expanded", "true");
    menuPanel?.setAttribute("aria-hidden", "false");
    resetPullRefresh();
  }
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

const initTabsVisibility = () => {
  const preferred = detectPreferredTabsVisibility();
  applyTabsVisibility(preferred, false);
  if (tabsToggle) {
    tabsToggle.addEventListener("click", toggleTabsVisibility);
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

const syncMenuTabs = () => {
  if (!menuTabsContainer) return;
  menuTabsContainer.innerHTML = "";
  if (currentRoute !== "live") {
    menuTabsContainer.dataset.state = "hidden";
    return;
  }
  
  menuTabsContainer.dataset.state = "ready";
  const heading = document.createElement("p");
  heading.className = "wm-menu-heading";
  heading.textContent = "Sessions";
  menuTabsContainer.append(heading);
  
  const sessionsContainer = document.createElement("div");
  sessionsContainer.className = "wm-menu-sessions-container";
  
  const activeSessions = getActiveSessions();
  if (activeSessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wm-menu-empty";
    empty.textContent = "No live sessions yet.";
    sessionsContainer.append(empty);
  } else {
    const sessionsList = document.createElement("div");
    sessionsList.className = "wm-menu-sessions-list";
    const sessionTabs = renderSessionTabs({ onSelect: closeMenu });
    sessionsList.append(sessionTabs);
    sessionsContainer.append(sessionsList);
  }
  
  // Always show the + button
  const addButton = document.createElement("div");
  addButton.className = "wm-tab new wm-menu-add-session";
  addButton.textContent = "+";
  addButton.title = "Start new session";
  addButton.addEventListener("click", () => {
    openDialog();
    closeMenu();
  });
  sessionsContainer.append(addButton);
  
  menuTabsContainer.append(sessionsContainer);
};

const PULL_THRESHOLD = 90;
const PULL_MAX = 150;
const PULL_BASE_OFFSET = -120;
let pullStartY = null;
let pullActive = false;
let pullReady = false;
let pullRefreshing = false;

// Auto-polling for live updates
const POLL_INTERVAL = 2000; // Poll every 2 seconds
let pollIntervalId = null;

const setPullState = (state, distance = 0) => {
  if (!pullRefreshIndicator) return;
  const clamped = Math.max(0, Math.min(distance, PULL_MAX));
  const translate = state === "hidden"
    ? PULL_BASE_OFFSET
    : Math.min(90, -80 + clamped * 1.1);
  pullRefreshIndicator.dataset.state = state;
  pullRefreshIndicator.style.transform = `translate(-50%, ${translate}px)`;
  if (pullRefreshLabel) {
    if (state === "release") {
      pullRefreshLabel.textContent = "Release to refresh";
    } else if (state === "refresh") {
      pullRefreshLabel.textContent = "Refreshing…";
    } else {
      pullRefreshLabel.textContent = "Pull to refresh";
    }
  }
};

const resetPullRefresh = () => {
  pullStartY = null;
  pullActive = false;
  pullReady = false;
  if (pullRefreshing) return;
  setPullState("hidden", 0);
};

const triggerPullRefresh = () => {
  if (!pullRefreshIndicator || pullRefreshing) return;
  pullRefreshing = true;
  setPullState("refresh", PULL_THRESHOLD);

  const MIN_REFRESH_DURATION = 400;
  pullReady = false;
  pullActive = false;

  setTimeout(() => {
    window.location.reload();
  }, MIN_REFRESH_DURATION);
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
  if (state.lastActiveSessionId && !sessionIds.has(state.lastActiveSessionId)) {
    state.lastActiveSessionId = null;
  }

  // Clean up data and DOM references for deleted sessions
  for (const key of Array.from(state.logs.keys())) {
    if (!sessionIds.has(key)) state.logs.delete(key);
  }
  for (const key of Array.from(state.conversations.keys())) {
    if (!sessionIds.has(key)) state.conversations.delete(key);
  }
  for (const key of Array.from(state.messageDrafts.keys())) {
    if (!sessionIds.has(key)) state.messageDrafts.delete(key);
  }
  for (const key of Array.from(state.conversationContainers.keys())) {
    if (!sessionIds.has(key)) state.conversationContainers.delete(key);
  }
  for (const key of Array.from(state.logContainers.keys())) {
    if (!sessionIds.has(key)) state.logContainers.delete(key);
  }
  for (const key of Array.from(state.lastMessageCount.keys())) {
    if (!sessionIds.has(key)) state.lastMessageCount.delete(key);
  }
  for (const key of Array.from(state.lastLogLength.keys())) {
    if (!sessionIds.has(key)) state.lastLogLength.delete(key);
  }
  for (const key of Array.from(state.autoScrollEnabled.keys())) {
    if (!sessionIds.has(key)) state.autoScrollEnabled.delete(key);
  }
  const routeSessionId = getSessionIdFromPath(window.location.pathname);
  const allowHistoryUpdate = currentRoute === "live" && !routeSessionId;
  const redirectHome = applyRouteSessionFromPath({ allowHistoryUpdate });
  if (redirectHome) {
    currentRoute = "home";
    lastLoggedSessionId = null;
    if (window.location.pathname !== "/home") {
      window.history.replaceState({ route: "home" }, "", "/home");
    }
  }
  ensureActiveSession();
  if (
    !redirectHome &&
    currentRoute === "live" &&
    state.activeSessionId &&
    state.sessions.some((session) => session.id === state.activeSessionId)
  ) {
    setActiveSession(state.activeSessionId, { updateHistory: false, forceLog: true });
  }

  if (!redirectHome && currentRoute === "live" && state.activeSessionId) {
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

  // Trigger incremental DOM update if on live route
  if (currentRoute === "live" && sessionId === state.activeSessionId) {
    updateLogsDOM(sessionId);
  }
};

const fetchConversation = async (sessionId) => {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/messages?refresh=true`);
    if (!response.ok) return;
    const data = await response.json();
    const items = Array.isArray(data?.messages) ? data.messages : [];
    state.conversations.set(sessionId, items);

    // Trigger incremental DOM update if on live route
    if (currentRoute === "live" && sessionId === state.activeSessionId) {
      updateConversationDOM(sessionId);
    }
  } catch (error) {
    console.error("Failed to load conversation", error);
  }
};

const pollSessions = async () => {
  try {
    const previousSessionCount = state.sessions.length;
    const previousSessionIds = state.sessions.map(s => s.id).join(',');

    await fetchSessions();

    const currentSessionCount = state.sessions.length;
    const currentSessionIds = state.sessions.map(s => s.id).join(',');
    const sessionsChanged = previousSessionCount !== currentSessionCount || previousSessionIds !== currentSessionIds;

    // On home route, always render to show session updates
    if (currentRoute !== "live") {
      render();
    } else if (!state.activeSessionId) {
      // On live route with no active session, render to show empty state
      render();
    } else {
      // On live route with active session:
      // - Update menu tabs to reflect current sessions
      syncMenuTabs();
      // - Only replace tabs bar if sessions changed (to preserve event listeners)
      if (sessionsChanged && tabsVisible) {
        const tabsBar = document.querySelector('.wm-tabs-bar');
        if (tabsBar) {
          const existingTabs = tabsBar.querySelector('.wm-tabs');
          if (existingTabs) {
            const newTabs = renderTabs();
            existingTabs.replaceWith(newTabs);
          }
        }
      }
      // - Incremental updates for conversation/logs are handled by fetchConversation and fetchLogs
    }
  } catch (error) {
    console.error("Failed to refresh sessions", error);
  }
};

const handleWindowFocus = async () => {
  try {
    await pollSessions();
  } catch (error) {
    console.error("Failed to refresh on focus", error);
  }
};

const startPolling = () => {
  // Clear any existing interval
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
  }

  // Start polling
  pollIntervalId = setInterval(async () => {
    try {
      await pollSessions();
    } catch (error) {
      console.error("Polling error", error);
    }
  }, POLL_INTERVAL);
};

const stopPolling = () => {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
};

const updateConversationDOM = (sessionId) => {
  let container = state.conversationContainers.get(sessionId);

  // If container reference is lost, try to find it in the DOM
  if (!container || !document.contains(container)) {
    const conversationWrapper = document.querySelector('.wm-live-conversation .wm-conversation');
    if (conversationWrapper) {
      container = conversationWrapper;
      state.conversationContainers.set(sessionId, container);
      // Re-sync the message count based on actual DOM
      const existingMessages = container.querySelectorAll('.wm-message');
      existingMessages.forEach((node) => attachCopyButton(node));
      state.lastMessageCount.set(sessionId, existingMessages.length);
    } else {
      return;
    }
  }

  attachConversationScrollHandler(sessionId, container.closest('.wm-live-conversation'));

  const conversation = state.conversations.get(sessionId) ?? [];
  const lastCount = state.lastMessageCount.get(sessionId) ?? 0;

  const autoScrollPreferred = ensureAutoScrollPreference(sessionId);
  const shouldAutoScroll = Boolean(autoScrollPreferred);

  // Handle new messages
  if (conversation.length > lastCount) {
    const newMessages = conversation.slice(lastCount);

    newMessages.forEach((message) => {
      const bubble = document.createElement("article");
      bubble.className = `wm-message ${message.type ?? message.role ?? "assistant"}`;
      const body = document.createElement("pre");
      body.textContent = message.content ?? message.message ?? "";
      bubble.append(body);
      attachCopyButton(bubble);
      container.append(bubble);
    });

    state.lastMessageCount.set(sessionId, conversation.length);
  }

  // Handle updated messages (streaming SSE - message content changes)
  if (conversation.length === lastCount && conversation.length > 0) {
    const domMessages = container.querySelectorAll('.wm-message');

    conversation.forEach((message, idx) => {
      const domMessage = domMessages[idx];
      if (domMessage) {
        attachCopyButton(domMessage);
        const body = domMessage.querySelector('pre');
        const currentContent = body?.textContent || '';
        const newContent = message.content ?? message.message ?? '';

        if (currentContent !== newContent) {
          if (body) {
            body.textContent = newContent;
          }
        }
      }
    });
  }

  // Auto-scroll if user was at bottom
  if (shouldAutoScroll) {
    scrollConversationAreaToBottom(sessionId);
  } else {
    updateAutoScrollStateForSession(sessionId);
  }
};

const updateLogsDOM = (sessionId) => {
  let container = state.logContainers.get(sessionId);

  // If container reference is lost, try to find it in the DOM
  if (!container || !document.contains(container)) {
    const logViewer = document.querySelector('.wm-log-panel .log-viewer');
    if (logViewer) {
      container = logViewer;
      state.logContainers.set(sessionId, container);
      // Re-sync the log length
      const currentLines = container.textContent.split('\n').filter(l => l.length > 0);
      state.lastLogLength.set(sessionId, currentLines.length);
    } else {
      return;
    }
  }

  const logs = state.logs.get(sessionId) ?? [];
  const lastLength = state.lastLogLength.get(sessionId) ?? 0;

  // Only update if logs changed
  if (logs.length !== lastLength || logs.join("\n") !== container.textContent) {
    container.textContent = logs.join("\n");
    state.lastLogLength.set(sessionId, logs.length);
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
  setActiveSession(session.id, { allowPending: true, logPort: false, updateHistory: currentRoute === "live" });
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
  render();
};

const deleteSession = async (sessionId) => {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/storage`, { method: "DELETE" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      window.alert(`Failed to delete session: ${data.error ?? response.statusText}`);
      return;
    }
    await fetchSessions();
    render();
  } catch (error) {
    console.error("Failed to delete session", error);
    window.alert("Failed to delete session. Check console for details.");
  }
};

const resumeSession = async (sessionId) => {
  const session = getSessionById(sessionId);
  if (!session) {
    window.alert("Session not available. It may have been deleted.");
    return;
  }
  currentRoute = "live";
  setActiveSession(sessionId, { updateHistory: true, forceLog: true });
  await Promise.all([fetchConversation(sessionId), fetchLogs(sessionId)]);
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
    state.autoScrollEnabled.set(sessionId, true);

    // Trigger incremental updates instead of full render
    updateConversationDOM(sessionId);
    await fetchLogs(sessionId);

    // Clear textarea and restore focus
    const textarea = document.querySelector('.wm-composer textarea');
    if (textarea) {
      textarea.value = "";
      textarea.style.height = "auto";
      requestAnimationFrame(() => {
        textarea.focus();
      });
    }
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

  const renderSessionActions = (target, session) => {
    const resumeBtn = document.createElement("button");
    resumeBtn.className = "wm-button";
    resumeBtn.textContent = "Resume";
    resumeBtn.addEventListener("click", () => resumeSession(session.id));
    target.append(resumeBtn);

    if (isSessionActive(session)) {
      const stopBtn = document.createElement("button");
      stopBtn.className = "wm-button secondary";
      stopBtn.textContent = "Stop";
      stopBtn.addEventListener("click", () => stopSession(session.id));
      target.append(stopBtn);
    } else {
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "wm-button secondary";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", () => deleteSession(session.id));
      target.append(deleteBtn);
    }
  };

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

      renderSessionActions(actionsCell, session);
      tbody.append(row);
    });
  }

  table.append(tbody);

  const tableContainer = document.createElement("div");
  tableContainer.className = "wm-table-container session-table-wrapper";
  tableContainer.append(table);

  const cardsContainer = document.createElement("div");
  cardsContainer.className = "session-card-list";
  if (state.sessions.length === 0) {
    const emptyCard = document.createElement("article");
    emptyCard.className = "session-card empty";
    emptyCard.textContent = "No active sessions";
    cardsContainer.append(emptyCard);
  } else {
    state.sessions.forEach((session) => {
      const card = document.createElement("article");
      card.className = "session-card";

      const header = document.createElement("header");
      header.className = "session-card-header";
      const title = document.createElement("h3");
      title.textContent = session.agent;
      const status = document.createElement("span");
      status.className = `session-status ${session.status}`;
      status.textContent = session.status;
      header.append(title, status);
      card.append(header);

      const details = document.createElement("div");
      details.className = "session-card-details";
      const addDetail = (label, value) => {
        const item = document.createElement("div");
        item.className = "session-card-detail";
        const term = document.createElement("span");
        term.className = "session-card-detail-label";
        term.textContent = label;
        const desc = document.createElement("span");
        desc.className = "session-card-detail-value";
        desc.textContent = value ?? "-";
        item.append(term, desc);
        details.append(item);
      };

      addDetail("Port", session.port ?? "-");
      addDetail("PID", session.pid ?? "-");
      addDetail("Started", new Date(session.startedAt).toLocaleTimeString());
      const directoryValue =
        session.workingDirectory ?? state.config?.defaultDirectory ?? "-";
      addDetail("Directory", directoryValue);
      card.append(details);

      const actionRow = document.createElement("div");
      actionRow.className = "session-card-actions";
      renderSessionActions(actionRow, session);
      card.append(actionRow);

      cardsContainer.append(card);
    });
  }

  container.append(cardsContainer, tableContainer);
  return container;
};

const renderSessionTabs = (options = {}) => {
  const onSelect = typeof options.onSelect === "function" ? options.onSelect : null;
  const tabs = document.createElement("div");
  tabs.className = "wm-tabs menu";

  const activeSessions = getActiveSessions();
  activeSessions.forEach((session) => {
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
      if (state.activeSessionId === session.id && currentRoute === "live") {
        // Already active, no need to switch
        onSelect?.();
        return;
      }
      currentRoute = "live";
      setActiveSession(session.id, { updateHistory: true, forceLog: true });
      fetchLogs(session.id);
      fetchConversation(session.id);
      // Don't call render() - it will destroy DOM references
      // Instead, just update the tabs to show active state
      if (tabsVisible) {
        const tabsBar = document.querySelector('.wm-tabs-bar');
        if (tabsBar) {
          const existingTabs = tabsBar.querySelector('.wm-tabs');
          if (existingTabs) {
            const newTabs = renderTabs();
            existingTabs.replaceWith(newTabs);
          }
        }
      }
      // Render the conversation/logs for the new session
      const scrollRegion = document.querySelector('.wm-live-scroll');
      if (scrollRegion) {
        scrollRegion.innerHTML = '';
        const logSection = renderLogs(session.id);
        scrollRegion.append(logSection);
        const conversationContainer = document.createElement("div");
        conversationContainer.className = "wm-live-conversation";
        conversationContainer.append(renderConversation(session.id));
        scrollRegion.append(conversationContainer);
        attachConversationScrollHandler(session.id, conversationContainer);
        const allowAutoScroll = ensureAutoScrollPreference(session.id);
        if (allowAutoScroll) {
          scrollConversationAreaToBottom(session.id);
        } else {
          updateAutoScrollStateForSession(session.id);
        }
      }
      onSelect?.();
    });

    const closeButton = tab.querySelector(".close");
    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      stopSession(session.id);
      onSelect?.();
    });

    tabs.append(tab);
  });

  return tabs;
};

const renderTabs = (options = {}) => {
  const variant = options.variant === "menu" ? "menu" : "default";
  const onSelect = typeof options.onSelect === "function" ? options.onSelect : null;
  const tabs = document.createElement("div");
  tabs.className = `wm-tabs${variant === "menu" ? " menu" : ""}`;

  const activeSessions = getActiveSessions();
  activeSessions.forEach((session) => {
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
      if (state.activeSessionId === session.id && currentRoute === "live") {
        // Already active, no need to switch
        onSelect?.();
        return;
      }
      currentRoute = "live";
      setActiveSession(session.id, { updateHistory: true, forceLog: true });
      fetchLogs(session.id);
      fetchConversation(session.id);
      // Don't call render() - it will destroy DOM references
      // Instead, just update the tabs to show active state
      if (tabsVisible) {
        const tabsBar = document.querySelector('.wm-tabs-bar');
        if (tabsBar) {
          const existingTabs = tabsBar.querySelector('.wm-tabs');
          if (existingTabs) {
            const newTabs = renderTabs();
            existingTabs.replaceWith(newTabs);
          }
        }
      }
      // Render the conversation/logs for the new session
      const scrollRegion = document.querySelector('.wm-live-scroll');
      if (scrollRegion) {
        scrollRegion.innerHTML = '';
        const logSection = renderLogs(session.id);
        scrollRegion.append(logSection);
        const conversationContainer = document.createElement("div");
        conversationContainer.className = "wm-live-conversation";
        conversationContainer.append(renderConversation(session.id));
        scrollRegion.append(conversationContainer);
        attachConversationScrollHandler(session.id, conversationContainer);
        const allowAutoScroll = ensureAutoScrollPreference(session.id);
        if (allowAutoScroll) {
          scrollConversationAreaToBottom(session.id);
        } else {
          updateAutoScrollStateForSession(session.id);
        }
      }
      onSelect?.();
    });

    const closeButton = tab.querySelector(".close");
    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      stopSession(session.id);
      onSelect?.();
    });

    tabs.append(tab);
  });

  const newTab = document.createElement("div");
  newTab.className = "wm-tab new";
  newTab.textContent = "+";
  newTab.title = "Start new session";
  newTab.addEventListener("click", () => {
    openDialog();
    onSelect?.();
  });
  tabs.append(newTab);

  return tabs;
};

const renderLogs = (sessionId) => {
  const logs = state.logs.get(sessionId) ?? ["No logs yet"];
  const panel = document.createElement("details");
  panel.className = "wm-log-panel";
  const summary = document.createElement("summary");
  summary.textContent = "Raw Terminal Output";
  const container = document.createElement("div");
  container.className = "log-viewer";
  container.textContent = logs.join("\n");
  const isOpen = state.logPanelOpen.get(sessionId) ?? false;
  panel.open = Boolean(isOpen);
  panel.addEventListener("toggle", () => {
    state.logPanelOpen.set(sessionId, panel.open);
  });
  panel.append(summary, container);

  // Store reference for incremental updates
  state.logContainers.set(sessionId, container);
  state.lastLogLength.set(sessionId, logs.length);

  return panel;
};

const renderConversation = (sessionId) => {
  const conversation = state.conversations.get(sessionId) ?? [];
  const wrapper = document.createElement("div");
  wrapper.className = "wm-conversation";

  if (conversation.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "Conversation has no messages yet.";
    wrapper.append(empty);
  } else {
    conversation.forEach((message) => {
      const bubble = document.createElement("article");
      bubble.className = `wm-message ${message.type ?? message.role ?? "assistant"}`;
      const body = document.createElement("pre");
      body.textContent = message.content ?? message.message ?? "";
      bubble.append(body);
      attachCopyButton(bubble);
      wrapper.append(bubble);
    });
  }

  // Store reference for incremental updates
  state.conversationContainers.set(sessionId, wrapper);
  state.lastMessageCount.set(sessionId, conversation.length);

  return wrapper;
};

const renderLive = () => {
  const wrapper = document.createElement("div");
  wrapper.className = "wm-live";
  ensureWindowScrollMonitoring();

  if (tabsVisible) {
    const tabsBar = document.createElement("div");
    tabsBar.className = "wm-tabs-bar";
    tabsBar.append(renderTabs());
    wrapper.append(tabsBar);
  }

  if (state.sessions.length === 0) {
    const container = document.createElement("section");
    container.className = "wm-card wm-live-main";
    const empty = document.createElement("p");
    empty.textContent = "No live sessions. Launch a new agent to begin.";
    container.append(empty);
    wrapper.append(container);
    return wrapper;
  }

  if (!state.activeSessionId || !state.sessions.some((session) => session.id === state.activeSessionId)) {
    ensureActiveSession();
  }

  if (!state.activeSessionId) {
    const container = document.createElement("section");
    container.className = "wm-card wm-live-main";
    const empty = document.createElement("p");
    empty.textContent = "No live session selected. Launch a new agent or use the menu to resume one.";
    container.append(empty);
    wrapper.append(container);
    return wrapper;
  }

  const sessionId = state.activeSessionId;

  const main = document.createElement("section");
  main.className = "wm-card wm-live-main";

  const scrollRegion = document.createElement("div");
  scrollRegion.className = "wm-live-scroll";
  const logSection = renderLogs(sessionId);
  scrollRegion.append(logSection);

  const conversationContainer = document.createElement("div");
  conversationContainer.className = "wm-live-conversation";
  conversationContainer.append(renderConversation(sessionId));
  scrollRegion.append(conversationContainer);
  attachConversationScrollHandler(sessionId, conversationContainer);
  const allowAutoScroll = ensureAutoScrollPreference(sessionId);
  if (allowAutoScroll) {
    scrollConversationAreaToBottom(sessionId);
  } else {
    updateAutoScrollStateForSession(sessionId);
  }

  main.append(scrollRegion);
  wrapper.append(main);

  const composerShell = document.createElement("div");
  composerShell.className = "wm-composer-shell";

  const composer = document.createElement("form");
  composer.className = "wm-composer";

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Ask the agent something...";
  textarea.value = state.messageDrafts.get(sessionId) ?? "";
  textarea.setAttribute("rows", "1");

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.multiple = true;
  fileInput.style.display = "none";

  const resizeTextarea = () => {
    textarea.style.height = "auto";
    const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight) || 20;
    const minHeight = lineHeight;
    const maxHeight = lineHeight * 8;
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  };

  let submit;
  let commandButton;
  const setUploadingState = (isUploading) => {
    if (isUploading) {
      composer.dataset.uploading = "true";
    } else {
      delete composer.dataset.uploading;
    }
    if (submit) {
      submit.disabled = Boolean(isUploading);
    }
    if (commandButton) {
      commandButton.disabled = Boolean(isUploading);
    }
  };

  textarea.addEventListener("input", (event) => {
    state.messageDrafts.set(sessionId, event.target.value);
    resizeTextarea();
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });

  textarea.addEventListener("paste", (event) => {
    const files = extractImageFiles(event.clipboardData?.items ?? event.clipboardData?.files);
    if (files.length > 0) {
      event.preventDefault();
      handleImageUploads(sessionId, files, textarea, resizeTextarea, setUploadingState);
    }
  });

  const handleDropEvent = (event) => {
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const files = extractImageFiles(transfer.items ?? transfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    handleImageUploads(sessionId, files, textarea, resizeTextarea, setUploadingState);
  };

  composer.addEventListener("dragover", (event) => {
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    event.preventDefault();
  });
  composer.addEventListener("drop", handleDropEvent);

  fileInput.addEventListener("change", () => {
    const files = extractImageFiles(fileInput.files);
    if (files.length > 0) {
      handleImageUploads(sessionId, files, textarea, resizeTextarea, setUploadingState);
    }
    fileInput.value = "";
  });

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const draft = textarea.value;
    state.messageDrafts.set(sessionId, draft);
    const result = sendMessage(sessionId, draft);
    if (result?.finally) {
      result.finally(() => {
        // After sending, find the new textarea and focus it
        requestAnimationFrame(() => {
          const newTextarea = document.querySelector('.wm-composer textarea');
          if (newTextarea) {
            newTextarea.focus();
          }
        });
      });
    }
  });

  commandButton = document.createElement("button");
  commandButton.type = "button";
  commandButton.className = "wm-button secondary wm-command-button";
  commandButton.innerHTML = '<span class="button-icon" aria-hidden="true">$></span><span class="button-text">Cmd</span>';
  commandButton.setAttribute("aria-haspopup", "true");
  commandButton.setAttribute("aria-expanded", "false");

  const commandMenu = document.createElement("div");
  commandMenu.className = "wm-command-menu";
  commandMenu.setAttribute("role", "menu");

  const addCommand = (label, handler) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "wm-command-item";
    item.textContent = label;
    item.setAttribute("role", "menuitem");
    item.addEventListener("click", () => {
      handler();
      commandMenu.classList.remove("is-open");
      commandButton.setAttribute("aria-expanded", "false");
    });
    commandMenu.append(item);
  };

  addCommand("Scroll to end", () => {
    scrollConversationAreaToBottom(sessionId, { includeWindow: true });
    state.autoScrollEnabled.set(sessionId, true);
  });

  addCommand("Copy chat", () => {
    copyConversationToClipboard(sessionId);
  });

  addCommand("Attach image", () => {
    fileInput.click();
  });

  const toggleCommandMenu = () => {
    const isOpen = commandMenu.classList.toggle("is-open");
    commandButton.setAttribute("aria-expanded", String(isOpen));
    if (isOpen) {
      const closeMenu = (event) => {
        if (!commandMenu.contains(event.target) && event.target !== commandButton) {
          commandMenu.classList.remove("is-open");
          commandButton.setAttribute("aria-expanded", "false");
          document.removeEventListener("mousedown", closeMenu);
          document.removeEventListener("touchstart", closeMenu);
        }
      };
      document.addEventListener("mousedown", closeMenu);
      document.addEventListener("touchstart", closeMenu, { passive: true });
    }
  };

  commandButton.addEventListener("click", () => {
    if (commandButton.disabled) return;
    toggleCommandMenu();
  });

  submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "wm-button";
  submit.innerHTML = '<span class="button-icon" aria-hidden="true">-&gt;</span><span class="button-text">Send</span>';
  submit.setAttribute("aria-label", "Send");

  const buttonGroup = document.createElement("div");
  buttonGroup.className = "wm-button-group";
  const commandWrapper = document.createElement("div");
  commandWrapper.className = "wm-command-wrapper";
  commandWrapper.append(commandButton, commandMenu);

  buttonGroup.append(commandWrapper, submit);

  composer.append(fileInput, textarea, buttonGroup);
  composerShell.append(composer);
  wrapper.append(composerShell);

  resizeTextarea();

  requestAnimationFrame(() => {
    if (!document.contains(textarea)) return;
    textarea.focus();
    resizeTextarea();
  });

  return wrapper;
};

const render = () => {
  appRoot.innerHTML = "";
  const view = currentRoute === "live" ? renderLive() : renderHome();
  appRoot.append(view);
  appRoot.dataset.route = currentRoute;
  setActiveNav();
  closeMenu();
  syncMenuTabs();
  if (!pullRefreshing && !pullActive) {
    resetPullRefresh();
  }

  // Start or stop polling based on route
  if (currentRoute === "live" && getActiveSessions().length > 0) {
    startPolling();
  } else {
    stopPolling();
  }
};

const handleTouchStart = (event) => {
  if (!pullRefreshIndicator || pullRefreshing) return;
  if (document.body.dataset.menuOpen === "true") return;

  const touch = event.touches?.[0];
  if (!touch) return;

  // Only allow pull-to-refresh if touch starts in header area
  const header = document.querySelector('.wm-header');
  if (!header) return;

  const headerRect = header.getBoundingClientRect();
  if (touch.clientY < headerRect.top || touch.clientY > headerRect.bottom) {
    return;
  }

  pullStartY = touch.clientY;
  pullActive = true;
  pullReady = false;
};

const handleTouchMove = (event) => {
  if (!pullActive || pullRefreshing || !pullRefreshIndicator) return;
  const touch = event.touches?.[0];
  if (!touch) return;

  const delta = touch.clientY - (pullStartY ?? touch.clientY);
  if (delta <= 0) {
    pullReady = false;
    setPullState("pull", 0);
    return;
  }
  const distance = Math.min(delta, PULL_MAX);
  if (distance > 0) {
    try {
      event.preventDefault();
    } catch {
      // ignore
    }
  }
  if (distance >= PULL_THRESHOLD) {
    pullReady = true;
    setPullState("release", distance);
  } else {
    pullReady = false;
    setPullState("pull", distance);
  }
};

const finishPull = () => {
  if (!pullActive) return;
  pullActive = false;
  if (pullReady && !pullRefreshing) {
    triggerPullRefresh();
  } else {
    resetPullRefresh();
  }
};

navLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const targetRoute = link.dataset.route;
    if (!targetRoute || targetRoute === currentRoute) return;
    closeMenu();
    if (targetRoute === "live") {
      currentRoute = "live";
      const hasActive = state.activeSessionId && state.sessions.some((session) => session.id === state.activeSessionId);
      const hasLast = state.lastActiveSessionId && state.sessions.some((session) => session.id === state.lastActiveSessionId);
      const targetSessionId = hasActive ? state.activeSessionId : hasLast ? state.lastActiveSessionId : null;
      if (targetSessionId) {
        setActiveSession(targetSessionId, { updateHistory: true, forceLog: true });
      } else {
        setActiveSession(null, { updateHistory: true });
      }
    } else {
      currentRoute = "home";
      lastLoggedSessionId = null;
      if (window.location.pathname !== "/home") {
        window.history.pushState({ route: "home" }, "", "/home");
      }
    }
    render();
  });
});

menuToggle?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleMenu();
});

document.addEventListener("click", (event) => {
  if (document.body.dataset.menuOpen === "true") {
    const target = event.target;
    if (target instanceof Node && !menuToggle?.contains(target) && !menuPanel?.contains(target)) {
      closeMenu();
    }
  }
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 720) {
    closeMenu();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMenu();
  }
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

window.addEventListener("touchstart", handleTouchStart, { passive: true });
window.addEventListener("touchmove", handleTouchMove, { passive: false });
window.addEventListener("touchend", finishPull, { passive: true });
window.addEventListener("touchcancel", finishPull, { passive: true });

window.addEventListener("popstate", () => {
  currentRoute = getRouteFromPath(window.location.pathname);
  if (currentRoute !== "live") {
    lastLoggedSessionId = null;
  }
  const redirectHome = applyRouteSessionFromPath({ allowHistoryUpdate: false });
  if (redirectHome) {
    currentRoute = "home";
    if (window.location.pathname !== "/home") {
      window.history.replaceState({ route: "home" }, "", "/home");
    }
  }
  render();
});

window.addEventListener("focus", handleWindowFocus);

// Handle page visibility changes (pause polling when page is hidden)
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
  } else if (currentRoute === "live" && getActiveSessions().length > 0) {
    // Resume polling when page becomes visible
    pollSessions(); // Immediate poll
    startPolling();
  }
});

const handleSessionLaunchRequest = () => {
  const agentId = agentSelect?.value ?? "";
  const workingDirectory = directoryInput?.value ?? "";
  closeDialog();
  launchSession(agentId, workingDirectory);
};

sessionForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  handleSessionLaunchRequest();
});

confirmButton.addEventListener("click", (event) => {
  event.preventDefault();
  handleSessionLaunchRequest();
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
  initTabsVisibility();
  await fetchConfig();
  await fetchSessions();
  render();
})();
