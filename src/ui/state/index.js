/**
 * Central application state and state factory functions.
 * This module provides the shared state object used across all UI modules.
 */

import { createFeatureFlagsState } from "../feature-flags/index.js";

// Storage keys
export const THEME_STORAGE_KEY = "wingman-theme";
export const TABS_VISIBILITY_STORAGE_KEY = "wingman-tabs-visible";
export const FILES_SHOW_HIDDEN_STORAGE_KEY = "wingman-files-show-hidden";

// Polling intervals
export const SESSION_POLL_INTERVAL_MS = 5000;
export const APPS_POLL_INTERVAL_MS = 5000;
export const APP_LOG_PREVIEW_LINES = 5;

// URL configuration
export const WEB_APP_PORT_PLACEHOLDER = "<port>";
export const DEFAULT_WEB_APP_BASE_URL = "https://host.otherstuff.ai/<port>";

// Toast configuration
export const TOAST_DEFAULT_DURATION_MS = 2600;

// Nostr relay defaults
export const DEFAULT_CONNECT_RELAYS = [
  "wss://relay.nsec.app",
  "wss://nos.lol",
  "wss://relay.getalby.com/v1",
  "wss://nostr.mineracks.com",
];

// Cache TTLs
export const ADMIN_PICTURE_CACHE_TTL_MS = 3 * 60 * 60 * 1000;

// Terminal control sequences
export const TERMINAL_CONTROL_ACTIONS = [
  { id: "terminal-esc", label: "Send Esc", toastLabel: "Esc", sequence: "\u001b" },
  { id: "terminal-1", label: "Send 1", toastLabel: "1", sequence: "1" },
  { id: "terminal-2", label: "Send 2", toastLabel: "2", sequence: "2" },
  { id: "terminal-3", label: "Send 3", toastLabel: "3", sequence: "3" },
  { id: "terminal-up", label: "Send Arrow Up", toastLabel: "Arrow Up", sequence: "\u001b[A" },
  { id: "terminal-down", label: "Send Arrow Down", toastLabel: "Arrow Down", sequence: "\u001b[B" },
  { id: "terminal-shift-tab", label: "Send Shift+Tab", toastLabel: "Shift+Tab", sequence: "\u001b[Z" },
  { id: "terminal-return", label: "Send Return", toastLabel: "Return", sequence: "\r" },
  { id: "terminal-ctrlc", label: "Send Ctrl+C", toastLabel: "Ctrl+C", sequence: "\u0003" },
];

/**
 * Creates the initial admin users state object.
 */
export function createAdminUsersState() {
  return {
    items: [],
    loading: false,
    initialized: false,
    error: null,
    pending: new Set(),
    pictureRequests: new Set(),
    pictureCache: new Map(),
    filter: "",
    filterDraft: "",
    nicknameDrafts: new Map(),
    selection: new Set(),
    bulkDeleteBusy: false,
    balanceTool: {
      identifier: "",
      amount: "",
      busy: false,
      error: null,
      success: null,
    },
  };
}

/**
 * Central application state object.
 * This is a mutable singleton shared across all UI modules.
 */
export const state = {
  config: null,
  sessions: [],
  identitySummaries: [],
  sessionFilters: {
    npub: "all",
    options: [],
    initialized: false,
  },
  appFilters: {
    npub: "all",
    options: [],
    initialized: false,
  },
  orchestratorPresets: [],
  orchestratorPresetsLoading: false,
  orchestratorPresetsLoaded: false,
  orchestratorPresetsError: null,
  logs: new Map(),
  conversations: new Map(),
  messageDrafts: new Map(),
  logPanelOpen: new Map(),
  promptQueues: new Map(), // sessionId -> {prompts: [], maxSize: 21}
  activeSessionId: null,
  lastWorkingDirectory: null,
  lastActiveSessionId: null,
  // Archived session data for viewing historical sessions
  archivedSession: {
    sessionId: null,
    status: null, // "abandoned" | "archived"
    session: null,
    messages: [],
    loading: false,
    error: null,
  },
  settingsPanels: {
    adminBalanceCollapsed: false,
    adminPortsCollapsed: false,
    adminUsersCollapsed: false,
    featureFlagsCollapsed: false,
    nightwatchCollapsed: false,
  },
  nightwatch: {
    sessionToggles: new Map(),
    reports: [],
    reportsLoading: false,
    reportsInitialized: false,
    config: { model: "google/gemini-3-flash-preview", maxCycles: 21, models: [], maxCycleOptions: [6, 21, 256], prompt: "", defaultPrompt: "" },
  },
  // Webview split-panel layout state
  webviewLayout: { open: false, mode: "chat-narrow" },
  // DOM references for incremental updates
  conversationContainers: new Map(), // sessionId -> DOM element
  logContainers: new Map(), // sessionId -> DOM element
  lastMessageCount: new Map(), // sessionId -> number of messages
  lastLogLength: new Map(), // sessionId -> length of logs
  apps: {
    items: [],
    loading: false,
    initialized: false,
    error: null,
    pendingOpenDialog: null,
    pendingFocusId: null,
  },
  adminUsers: createAdminUsersState(),
  featureFlags: createFeatureFlagsState(),
  system: {
    restart: {
      loading: false,
      inProgress: false,
      marker: null,
      outcome: null,
      error: null,
      submitting: false,
    },
    cleanup: {
      running: false,
      result: null,
      error: null,
    },
  },
  appLogViewer: {
    appId: null,
    title: "",
    lines: [],
    loading: false,
    tail: 200,
  },
  todos: {
    items: [],
    loading: false,
    error: null,
    initialized: false,
  },
  projects: {
    items: [],
    loading: false,
    error: null,
    initialized: false,
  },
  files: {
    initialized: false,
    loading: false,
    error: null,
    currentPath: null,
    relativePath: null,
    displayPath: "~",
    parent: null,
    entries: [],
    git: null,
    previewPath: null,
    previewRelativePath: null,
    previewDisplayPath: "",
    previewName: null,
    previewContent: null,
    previewLoading: false,
    previewError: null,
    previewFormat: null,
    previewLanguage: null,
    previewLabel: null,
    showHidden: false,
    browserCollapsed: false,
    uploading: false,
    gitCommandPending: false,
    worktreeModal: {
      open: false,
      submitting: false,
      error: null,
      branch: "",
      startPoint: "",
    },
    transfer: {
      mode: null,
      sourcePath: null,
      sourceName: null,
      sourceDisplayPath: null,
      destinationPath: null,
      destinationDisplayPath: null,
      destinationName: null,
      destinationNameInput: "",
      nameError: null,
      submitting: false,
      error: null,
      browser: {
        currentPath: "",
        parent: null,
        requestId: 0,
        selection: null,
      },
    },
  },
  fileEditor: {
    open: false,
    loading: false,
    saving: false,
    error: null,
    saveError: null,
    path: null,
    relativePath: null,
    displayPath: null,
    name: null,
    base64: null,
    content: "",
    initialContent: "",
    mtimeMs: null,
    dirty: false,
    requestId: 0,
  },
  identity: {
    method: "none",
    npub: null,
    expiresAt: null,
    authenticated: false,
    alias: null,
    picture: null,
    isAdmin: false,
    ports: [],
    balance: 0,
  },
  // Private chat state
  chats: {
    items: [],
    loading: false,
    initialized: false,
    error: null,
  },
  activeChatId: null,
  chatConversations: new Map(), // chatId -> messages[]
  chatMessageDrafts: new Map(), // chatId -> draft string
  chatStreaming: new Map(), // chatId -> {active: boolean, content: string}
};

/**
 * Initializes files.showHidden from localStorage.
 * Call this once during app bootstrap.
 */
export function initFilesShowHidden() {
  try {
    const storedShowHidden = localStorage.getItem(FILES_SHOW_HIDDEN_STORAGE_KEY);
    if (storedShowHidden === "true" || storedShowHidden === "false") {
      state.files.showHidden = storedShowHidden === "true";
    }
  } catch {
    // Ignore storage errors (e.g., during private browsing)
  }
}

/**
 * Resolves the web app base URL from config or uses default.
 */
export function resolveWebAppBase() {
  const candidate = state.config?.hostUrlBase;
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return DEFAULT_WEB_APP_BASE_URL;
}

/**
 * Formats a port number into a full web app URL.
 */
export function formatWebAppUrl(port) {
  if (typeof port !== "number" || !Number.isFinite(port)) return null;
  const normalized = Math.trunc(port);
  if (normalized <= 0) return null;
  const base = resolveWebAppBase();
  if (base.includes(WEB_APP_PORT_PLACEHOLDER)) {
    return base.replaceAll(WEB_APP_PORT_PLACEHOLDER, String(normalized));
  }
  const separator = base.endsWith("/") ? "" : "/";
  return `${base}${separator}${normalized}`;
}
