import "./identity/index.js";
import { fetchIdentityProfile, fetchAdminUserProfile } from "./identity/profile.js";
import { createProjectFeature } from "./projects/index.js";
import { npubProjectsState, fetchNpubProjects, renderNpubProjectsPanel } from "./npub-projects/index.js";
import "./logging/browser.js";
import {
  sseManager,
  visibilityManager,
  initLiveModule,
  MessageStore,
  isAlpineChatEnabled,
  initAlpineChat,
} from "./live/index.js";
import {
  createWebviewIcon,
} from "./live/webview-panel.js";
import {
  createWriterIcon,
} from "./writer/writer-panel.js";
import { createUnauthorizedGuard } from "./common/unauthorized-guard.js";
import { createSessionDialogController } from "./common/session-dialog.js";
import { initOrchestratorUI } from "./orchestrator/index.js";
import { initAppDialogs } from "./apps/dialog.js";
import { initWorkspaceTree } from "./apps/tree.js";
import {
  initFeatureFlagsUI,
  ORCHESTRATOR_FLAG_KEY,
} from "./feature-flags/index.js";
import { initNightWatchSettingsPanel } from "./nightwatch/settings-panel.js";
import { initNightWatchPage } from "./nightwatch/page.js";
import { initNightWatchStore } from "./nightwatch/store.js";
import { initSchedulerStore } from "./scheduler/store.js";
import { initSchedulerPage } from "./scheduler/page.js";
import { initSessionsStore } from "./sessions/store.js";
import { initAppsStore } from "./apps/store.js";
import { startSigningListener, stopSigningListener } from "./nip98/signing-listener.js";
import { startSessionSubscriber, stopSessionSubscriber } from "./sessions/subscriber.js";
import { buildSessionOrigin, createSessionLauncher } from "./helpers/session-launch.js";
import {
  state,
  createAdminUsersState,
  initFilesPreferences,
  resolveWebAppBase,
  formatWebAppUrl,
  THEME_STORAGE_KEY,
  TABS_VISIBILITY_STORAGE_KEY,
  APP_LOG_PREVIEW_LINES,
  TOAST_DEFAULT_DURATION_MS,
  DEFAULT_CONNECT_RELAYS,
  ADMIN_PICTURE_CACHE_TTL_MS,
} from "./state/index.js";
import {
  decodeBase64ToUint8Array,
  encodeUint8ArrayToBase64,
  decodeBytesToText,
  encodeTextToBytes,
  readFileAsUint8Array,
} from "./core/encoding.js";
import {
  createSvgShape,
  createIconSvg,
  FILE_BROWSER_ICON_DEFS,
  setIconButton,
  getSessionDisplayName,
  truncateText,
  scrollConversationToBottom,
  getConversationScrollElement as _getConversationScrollElement,
  scrollConversationAreaToBottom as _scrollConversationAreaToBottom,
  isConversationScrolledToBottom as _isConversationScrolledToBottom,
  isMobileFilesLayout,
  escapeHtml,
  escapeAttribute,
  sanitizeLanguageClass,
} from "./core/icons.js";
import {
  renderInlineMarkdown,
  renderMarkdownToHtml,
  renderCodeToHtml,
  buildKeywordPattern,
} from "./rendering/markdown.js";
import { initFileEditor } from "./modals/file-editor.js";
import { initQueueModule } from "./sessions/queue-modal.js";
import { initQuickLauncher } from "./core/quick-launcher.js";
import { initImageAttachments } from "./core/image-attachments.js";
import { initAgentIndicators } from "./status/agent-indicators.js";
import { show as scrollPillShow, hide as scrollPillHide, isNearBottom as scrollPillIsNearBottom } from "./live/scroll-pill.js";
import { initAdminUsersApi } from "./api/admin-users.js";
import { showToast } from "./utils/toast.js";
import { collapseNewlines } from "./utils/text.js";
import {
  copyTextToClipboard,
  attachCopyButton,
  copyConversationToClipboard,
  createCopyIconButton,
} from "./utils/clipboard.js";
import {
  fetchConfigApi,
  normaliseConnectRelays,
  fetchRestartStatusApi,
  triggerWarmRestartApi,
  runSystemCleanupApi,
} from "./services/config.js";
import {
  fetchSessionsApi,
  fetchSessionApi,
  fetchSessionLogsApi,
  fetchSessionMessagesApi,
  stopSessionApi,
  deleteSessionApi,
  updateSessionNameApi,
  postSessionMessageApi,
  fetchSessionQueueApi,
  addToSessionQueueApi,
  removeFromSessionQueueApi,
  updateSessionQueuePromptApi,
} from "./services/sessions.js";
import {
  fetchAppsApi,
  fetchAppLogsApi,
  triggerAppActionApi,
  removeAppApi,
} from "./services/apps.js";
import { isChatRoute } from "./chat/index.js";
import { initPrivateChat } from "./chat/private-chat.js";
import { initIdentityPanels } from "./identity/panels.js";
import { initAdminUsersPanels } from "./api/admin-users-panels.js";
import { initPrivacyPolicy } from "./views/privacy-policy.js";
import { initSettingsView } from "./views/settings-view.js";
import { initHomeView } from "./views/home-view.js";
import { initFilesView } from "./views/files-view.js";
import { initLiveView } from "./views/live-view.js";
import { initDirectoryBrowser } from "./modals/directory-browser.js";
import { abbreviateNpub, formatSatoshis, normaliseNpubValue, isFiniteNumber, initIdentityDom } from "./identity/dom.js";
import { initIdentityStateManager } from "./identity/state-manager.js";

// Ace editor is lazy-loaded when the file editor is first opened.
// See loadAceEditor() below and initFileEditor deps.
let aceInstance = null;

async function loadAceEditor() {
  if (aceInstance) return aceInstance;
  await import("/ace-builds/src-noconflict/ace.js");
  await Promise.all([
    import("/ace-builds/src-noconflict/mode-text.js"),
    import("/ace-builds/src-noconflict/theme-chrome.js"),
    import("/ace-builds/src-noconflict/theme-tomorrow_night.js"),
  ]);
  aceInstance = globalThis.ace;
  return aceInstance;
}

/** Lazy accessor for the Dexie-backed sessions Alpine store. */
const sessionsStore = () => window.Alpine?.store("sessions");
/** Lazy accessor for the Dexie-backed apps Alpine store. */
const appsStore = () => window.Alpine?.store("apps");
let conversationPollIntervalId = null;
let conversationPollInFlight = false;
let sessionDialogController = null;
let loadChats = async () => {};
let loadChatMessages = async () => {};
let navigateToChat = () => {};
let openPrivateChatDialog = () => {};
let deleteChat = async () => {};
let renderChat = () => document.createElement("div");
let renderIdentityPanel = () => document.createDocumentFragment();
let renderIdentitySummary = () => document.createDocumentFragment();
let renderMenuIdentitySection = () => {};
let renderAdminUsersPanel = () => document.createDocumentFragment();
let renderPrivacyPolicy = () => document.createElement("div");
let renderSettings = () => document.createElement("div");
let renderHome = () => document.createElement("div");
let renderFiles = () => document.createElement("div");
let renderLive = () => document.createElement("div");
let renderSessionTabs = () => document.createElement("div");
let renderTabs = () => document.createElement("div");
let updateLivePanelsForSession = () => {};
let captureFocusSnapshot = () => null;
let restoreFocusFromSnapshot = () => {};
let renderOrchestratorPresetButtons = () => {};
let ensureOrchestratorPresetsLoaded = () => {};
let refreshOrchestratorPresets = async () => {};
let openOrchestratorDialog = () => {};
let syncOrchestratorAgents = () => {};
let openAppDialog = () => {};
let closeAppDialog = () => {};
let openAppLogsDialog = () => {};
let openDeployDialog = () => {};
let refreshAppLogs = async () => {};
let resetAppDialog = () => {};
let createWorkspaceTreeSidebar = () => null;
let renderFeatureFlagsPanel = () => document.createDocumentFragment();
let ensureFeatureFlagsLoaded = () => {};
let resolveFeatureFlagForViewer = () => ({ state: "off", effectiveState: "off" });
let isFeatureEnabledForViewer = () => false;
let renderNightWatchSettingsPanel = () => document.createDocumentFragment();
let ensureNightWatchLoaded = () => {};
let renderNightWatchPage = () => document.createDocumentFragment();
let ensureNightWatchPageLoaded = () => {};
let renderSchedulerPage = () => document.createDocumentFragment();
let ensureSchedulerPageLoaded = () => {};
let orchestratorFeatureEnabledForViewer = () => false;
let projectsFeatureEnabledForViewer = () => true;
let syncFeatureFlagsFromConfig = () => {};
let scheduleDirectorySuggestions = () => {};
let openDirectoryBrowser = async () => null;
let openFileTransferDialogForMode = async () => {};
let updateIdentityState = (partial, options) => state.identity;
let registerIdentityDom = () => {};
let bindIdentityFlows = () => {};
let handleIdentityLogout = async () => {};
let handleIdentityCopy = async () => {};
let handleUnauthorizedAccess = () => {};
let forceIdentityLogoutState = () => {};
let getIdentityWiringContext = () => ({});
let identityDomEntryByNode = new WeakMap();
let IDENTITY_EVENT_NAMES = [];

let projectFeature = null;

let performAuthUiSync = () => {};
let pendingAuthUiSync = false;
const scheduleAuthMicrotask =
  typeof queueMicrotask === "function" ? queueMicrotask : (callback) => Promise.resolve().then(callback);
const requestAuthUiSync = () => {
  if (pendingAuthUiSync) return;
  pendingAuthUiSync = true;
  scheduleAuthMicrotask(() => {
    pendingAuthUiSync = false;
    performAuthUiSync();
  });
};

requestAuthUiSync();

// Initialize files preferences (showHidden, browserShelved, favourites) from localStorage
initFilesPreferences();

const normalisePortList = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  const unique = new Set();
  value.forEach((entry) => {
    const parsed = typeof entry === "number" ? entry : Number.parseInt(String(entry), 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      unique.add(parsed);
    }
  });
  return Array.from(unique).sort((a, b) => a - b);
};

const matchesAdminUserFilter = (user, filter) => {
  if (!filter) return true;
  const target = filter.toLowerCase();
  const alias = typeof user?.alias === "string" ? user.alias.toLowerCase() : "";
  const nickname = typeof user?.nickname === "string" ? user.nickname.toLowerCase() : "";
  const npub = typeof user?.npub === "string" ? user.npub.toLowerCase() : "";
  const normalized = typeof user?.normalizedNpub === "string" ? user.normalizedNpub.toLowerCase() : npub;
  return (
    alias.startsWith(target) ||
    nickname.startsWith(target) ||
    npub.startsWith(target) ||
    normalized.startsWith(target)
  );
};

let collapsibleIdCounter = 0;
const createCollapsibleCard = ({ title, className = "", collapsed = false, onToggle } = {}) => {
  const card = document.createElement("section");
  card.className = ["wm-card", "wm-collapsible", className].filter(Boolean).join(" ");

  const heading = document.createElement("h2");
  heading.className = "wm-collapsible__title";
  heading.textContent = title;
  heading.tabIndex = 0;
  heading.setAttribute("role", "button");

  const body = document.createElement("div");
  body.className = "wm-collapsible__body";
  const bodyId = `wm-collapsible-${++collapsibleIdCounter}`;
  body.id = bodyId;
  heading.setAttribute("aria-controls", bodyId);

  const applyState = (nextCollapsed) => {
    if (nextCollapsed) {
      card.dataset.collapsed = "true";
      body.hidden = true;
      heading.setAttribute("aria-expanded", "false");
      heading.dataset.state = "collapsed";
    } else {
      delete card.dataset.collapsed;
      body.hidden = false;
      heading.setAttribute("aria-expanded", "true");
      heading.dataset.state = "expanded";
    }
  };

  applyState(collapsed);

  const toggle = () => {
    const currentlyCollapsed = card.dataset.collapsed === "true";
    const nextCollapsed = !currentlyCollapsed;
    applyState(nextCollapsed);
    if (typeof onToggle === "function") {
      onToggle(nextCollapsed);
    }
  };

  heading.addEventListener("click", toggle);
  heading.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });

  card.append(heading, body);
  return { card, body, header: heading };
};
// -- Encoding utilities imported from core/encoding.js --
// -- SVG/icon utilities imported from core/icons.js --

// Thin wrappers closing over state.conversationContainers for scroll utilities
const getConversationScrollElement = (sessionId) =>
  _getConversationScrollElement(sessionId, state.conversationContainers);

const scrollConversationAreaToBottom = (sessionId, options = {}) =>
  _scrollConversationAreaToBottom(sessionId, state.conversationContainers, options);

const scheduleLiveScroll = (sessionId, options = {}) => {
  if (!sessionId || currentRoute !== "live") return;
  // Never auto-scroll — show the pill if user is scrolled up
  if (!scrollPillIsNearBottom()) {
    scrollPillShow();
    return;
  }
};

const isConversationScrolledToBottom = (sessionId) =>
  _isConversationScrolledToBottom(sessionId, state.conversationContainers);

const resetFilesPreview = () => {
  state.files.previewPath = null;
  state.files.previewRelativePath = null;
  state.files.previewDisplayPath = "";
  state.files.previewName = null;
  state.files.previewContent = null;
  state.files.previewLoading = false;
  state.files.previewError = null;
  state.files.previewFormat = null;
  state.files.previewLanguage = null;
  state.files.previewLabel = null;
};

/**
 * Build the browser URL for the current files view state and update the address bar.
 * Format: /files/<relativePath>[?file=<filename>]
 */
function updateFilesUrl({ replace = false } = {}) {
  if (currentRoute !== "files") return;
  const dirRelative = state.files.relativePath || "";
  const slug = dirRelative ? `${FILES_ROUTE}/${dirRelative}` : FILES_ROUTE;
  const fileRelative = state.files.previewRelativePath || "";
  let target = slug;
  if (fileRelative) {
    target = `${FILES_ROUTE}/${fileRelative}`;
  }
  if (window.location.pathname === target) return;
  const stateObj = { route: "files" };
  if (replace) {
    window.history.replaceState(stateObj, "", target);
  } else {
    window.history.pushState(stateObj, "", target);
  }
}

/**
 * Extract a docs-root-relative path from the current URL when on the files route.
 * Returns { slug } where slug is the path after /files/.
 */
function parseFilesPathFromUrl() {
  const pathname = window.location.pathname;
  const prefix = `${FILES_ROUTE}/`;
  if (!pathname.startsWith(prefix)) {
    return { slug: null };
  }
  const slug = decodeURIComponent(pathname.slice(prefix.length));
  return { slug: slug || null };
}

/**
 * Navigate to a files URL slug — tries as directory first, falls back to
 * loading parent directory + file preview if the slug points to a file.
 */
async function navigateToFilesSlug(slug) {
  if (!slug) {
    void loadFilesTree();
    return;
  }
  const files = state.files;
  // Probe the slug to see if it's a directory or file
  try {
    const probeUrl = new URL("/api/docs/tree", window.location.origin);
    probeUrl.searchParams.set("path", slug);
    if (files.showHidden) probeUrl.searchParams.set("showHidden", "1");
    const response = await fetch(probeUrl.toString(), { method: "GET" });
    if (response.ok) {
      // It's a directory — load it via the normal path
      void loadFilesTree(slug);
      return;
    }
  } catch {
    // fall through to file attempt
  }
  // Slug is likely a file — load parent directory, then preview the file
  const lastSlash = slug.lastIndexOf("/");
  const parentSlug = lastSlash > 0 ? slug.slice(0, lastSlash) : null;
  await loadFilesTree(parentSlug || undefined);
  // The backend resolveDocsPath handles relative paths, so pass the slug directly
  void loadFilesPreview(slug);
}

// -- Markdown / code rendering imported from rendering/markdown.js --

const loadFilesTree = async (path) => {
  const files = state.files;
  const targetPath = typeof path === "string" && path.length > 0 ? path : files.currentPath;
  if (typeof path === "string" && path.length > 0 && path !== files.currentPath) {
    resetFilesPreview();
  }
  files.loading = true;
  files.error = null;

  try {
    const url = new URL("/api/docs/tree", window.location.origin);
    if (targetPath) {
      url.searchParams.set("path", targetPath);
    }
    if (files.showHidden) {
      url.searchParams.set("showHidden", "1");
    }
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      let message = response.statusText || "Failed to load directory";
      try {
        const payload = await response.json();
        if (payload && typeof payload.error === "string") {
          message = payload.error;
        }
      } catch {
        // ignore json parsing error
      }
      throw new Error(message);
    }

    const data = await response.json();
    files.currentPath = data?.path ?? targetPath ?? files.currentPath;
    files.relativePath = data?.relativePath ?? "";
    files.displayPath = data?.displayPath ?? (files.relativePath ? `~/${files.relativePath}` : "~");
    files.parent = data?.parent ?? null;
    files.entries = Array.isArray(data?.entries) ? data.entries : [];
    files.git = data?.git ?? null;
    files.loading = false;
    files.error = null;

    if (files.previewPath) {
      const exists = files.entries.some((entry) => entry.path === files.previewPath);
      if (!exists) {
        resetFilesPreview();
      }
    }
    updateFilesUrl({ replace: true });
  } catch (error) {
    files.loading = false;
    files.error = error instanceof Error ? error.message : String(error);
    files.entries = [];
    files.git = null;
    if (typeof path === "string" && path.length > 0) {
      files.currentPath = path;
    }
  } finally {
    if (currentRoute === "files") {
      render();
    }
  }
};

const loadFilesPreview = async (path) => {
  if (!path) return;
  const files = state.files;
  files.previewPath = path;
  files.previewRelativePath = "";
  files.previewDisplayPath = "";
  files.previewName = null;
  files.previewContent = null;
  files.previewError = null;
  files.previewLoading = true;
  files.previewFormat = null;
  files.previewLanguage = null;
  files.previewLabel = null;
  if (currentRoute === "files") {
    render();
  }

  try {
    const url = new URL("/api/docs/file", window.location.origin);
    url.searchParams.set("path", path);
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      let message = response.statusText || "Failed to load file";
      try {
        const payload = await response.json();
        if (payload && typeof payload.error === "string") {
          message = payload.error;
        }
      } catch {
        // ignore json parse error
      }
      throw new Error(message);
    }

    const data = await response.json();
    files.previewPath = data?.path ?? path;
    files.previewRelativePath = data?.relativePath ?? "";
    files.previewDisplayPath = data?.displayPath ?? (files.previewRelativePath ? `~/${files.previewRelativePath}` : "");
    files.previewName = data?.name ?? null;
    files.previewContent = data?.content ?? "";
    files.previewFormat = data?.format ?? null;
    files.previewLanguage = data?.language ?? null;
    files.previewLabel = data?.label ?? null;
    files.previewLoading = false;
    files.previewError = null;
    updateFilesUrl();
  } catch (error) {
    files.previewLoading = false;
    files.previewError = error instanceof Error ? error.message : String(error);
    files.previewContent = null;
  } finally {
    if (currentRoute === "files") {
      render();
    }
  }
};

const showFilesPreviewUnavailable = (entry) => {
  const files = state.files;
  files.previewPath = entry?.path ?? null;
  files.previewRelativePath = entry?.relativePath ?? "";
  files.previewDisplayPath = entry?.displayPath ?? "";
  files.previewName = entry?.name ?? null;
  files.previewFormat = null;
  files.previewLanguage = null;
  files.previewLabel = entry?.previewLabel ?? null;
  files.previewContent = null;
  files.previewLoading = false;
  files.previewError = "Preview not available for this file type.";
  updateFilesUrl();
  if (currentRoute === "files") {
    render();
  }
};

const createFilesDirectory = async (parentPath, name) => {
  const response = await fetch("/api/docs/directory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent: parentPath, name }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to create directory";
    throw new Error(message);
  }
  return response.json();
};

const createFilesTextFile = async (parentPath, name, content = "") => {
  const response = await fetch("/api/docs/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ directory: parentPath, name, content }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to create file";
    throw new Error(message);
  }
  return response.json();
};

const uploadFilesBinary = async (parentPath, file) => {
  const bytes = await readFileAsUint8Array(file);
  const base64 = encodeUint8ArrayToBase64(bytes);
  const response = await fetch("/api/docs/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ directory: parentPath, name: file.name, base64 }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to upload file";
    throw new Error(message);
  }
  return response.json();
};

const deleteFilesEntry = async (path) => {
  const response = await fetch("/api/docs/file", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to delete file";
    throw new Error(message);
  }
  return response.json();
};

const createDirectoryEntry = async (parent, name) => {
  const response = await fetch("/api/directories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent, name }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to create folder";
    throw new Error(message);
  }
  return response.json();
};

const copyFilesEntry = async (path, targetDirectory, name) => {
  const payload = { path, targetDirectory };
  if (typeof name === "string" && name.trim().length > 0) {
    payload.name = name.trim();
  }
  const response = await fetch("/api/docs/file/copy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to copy file";
    throw new Error(message);
  }
  return response.json();
};

const moveFilesEntry = async (path, targetDirectory, name) => {
  const payload = { path, targetDirectory };
  if (typeof name === "string" && name.trim().length > 0) {
    payload.name = name.trim();
  }
  const response = await fetch("/api/docs/file/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to move file";
    throw new Error(message);
  }
  return response.json();
};

// -- File editor + worktree modal initialized via initFileEditor (see bootstrap) --
let canCreateWorktree = () => false;
let openWorktreeModal = () => {};
let closeWorktreeModal = () => {};
let openFileEditor = async () => {};
let closeFileEditor = () => {};
let getFileEditorDisplayTitle = () => "File Editor";
let resetFileEditorState = () => {};
let renderFileEditorOverlay = () => {};
let renderWorktreeModal = () => {};
let destroyAceEditor = () => {};
let ensureAceEditorMounted = () => {};
let requestFileEditorClose = () => {};
let getAceEditorInstance = () => null;

// -- Session helpers + prompt queue initialized via initQueueModule (see bootstrap) --
let getSessionById = () => undefined;
let isSessionActive = () => false;
let getActiveSessions = () => [];
let isSessionBusy = () => false;
let isStatusRecordBusy = () => false;
let getSessionQueue = () => ({ prompts: [], maxSize: 21 });
let getQueueCount = () => 0;
let isQueueFull = () => false;
let addToPromptQueue = async () => false;
let removeFromPromptQueue = async () => false;
let updatePromptInQueue = async () => false;
let fetchSessionQueue = async () => [];
let sendNextQueuedPrompt = async () => false;
let openPromptQueueModal = async () => {};
let closePromptQueueModal = () => {};

// -- Image attachments initialized via initImageAttachments (see bootstrap) --
let insertTextAtCursor = () => {};
let clearImagePreviews = () => {};
let extractImageFiles = () => [];
let extractAttachmentFiles = () => [];
let handleImageUploads = async () => {};
let handleAttachmentUploads = async () => {};
let cleanupOrphanedMarkers = () => {};

// -- Agent indicators initialized via initAgentIndicators (see bootstrap) --
let resolveAgentRuntimeStatus = () => null;
let createAgentStatusIndicator = () => document.createElement("div");
let updateAgentStatusIndicators = () => {};
let updateKnightRiderState = () => {};
let updateConversationDOM = () => {};
let updateLogsDOM = () => {};

// -- Admin users API initialized via initAdminUsersApi (see bootstrap) --
let getAdminUserKey = () => null;
let ensureAdminSelectionState = () => new Set();
let setAdminUserSelected = () => {};
let clearAdminSelection = () => {};
let getAdminSelectedUsers = () => [];
let getAdminSelectionCount = () => 0;
let fetchAdminUsers = async () => {};
let replaceAdminUsersList = () => {};
let toggleUserOnboarding = async () => {};
let deleteAdminUser = async () => {};
let deleteSelectedAdminUsers = async () => {};
let updateAdminUserNickname = async () => {};
let primeAdminUserPictures = () => {};
let ensureAdminBalanceToolState = () => {};
let submitAdminBalanceUpdate = async () => {};
let ensureAdminPortsToolState = () => {};
let submitAdminPortsAssignment = async () => {};
let generateAdminPorts = async () => {};

const LIVE_ROUTE_PREFIX = "/live";
const FILES_ROUTE = "/files";
const SETTINGS_ROUTE = "/settings";
const APPS_ROUTE = "/apps";
const PROJECTS_ROUTE = "/projects";
const NIGHTWATCH_ROUTE = "/nightwatch";
const SCHEDULER_ROUTE = "/scheduler";
const TRIGGERS_ROUTE = "/triggers";
const HOME_ROUTE = "/home";
const PRIVACY_ROUTE = "/privacy";

const getRouteFromPath = (pathname) => {
  if (
    pathname === FILES_ROUTE ||
    pathname.startsWith(`${FILES_ROUTE}/`) ||
    pathname === "/docs" ||
    pathname.startsWith("/docs/")
  ) {
    return "files";
  }
  if (pathname === SETTINGS_ROUTE) {
    return "settings";
  }
  if (pathname === APPS_ROUTE) {
    return "apps";
  }
  if (pathname === PROJECTS_ROUTE) {
    return "projects";
  }
  if (pathname === NIGHTWATCH_ROUTE) {
    return "nightwatch";
  }
  if (pathname === SCHEDULER_ROUTE || pathname === TRIGGERS_ROUTE) {
    return "scheduler";
  }
  if (pathname === LIVE_ROUTE_PREFIX || pathname.startsWith(`${LIVE_ROUTE_PREFIX}/`)) {
    return "live";
  }
  if (isChatRoute(pathname)) {
    return "chat";
  }
  if (pathname === PRIVACY_ROUTE) {
    return "privacy";
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
let lastFilesMobileLayout = isMobileFilesLayout();

const ACE_LIGHT_THEME = "ace/theme/tomorrow_night";
const ACE_DARK_THEME = "ace/theme/tomorrow_night";

const applyAceTheme = (instance) => {
  const editor = instance ?? getAceEditorInstance();
  if (!editor) return;
  const targetTheme = currentTheme === "dark" ? ACE_DARK_THEME : ACE_LIGHT_THEME;
  if (editor.getTheme() !== targetTheme) {
    editor.setTheme(targetTheme);
  }
};

if (currentRoute === "files" && window.location.pathname.startsWith("/docs")) {
  const newPath = window.location.pathname.replace("/docs", "/files");
  window.history.replaceState({ route: "files" }, "", newPath);
}

const setActiveSession = (sessionId, options = {}) => {
  const { updateHistory = true, logPort = true, allowPending = false, forceLog = false } = options;
  const ss = sessionsStore();
  const previousSessionId = ss.activeSessionId;
  const allSessions = ss.items;

  if (sessionId) {
    const sessionExists = allSessions.some((session) => session.id === sessionId);
    if (!sessionExists && !allowPending) {
      ss.activeSessionId = null;
      lastLoggedSessionId = null;
      syncDesktopSessionIndicator();
      return false;
    }

    ss.activeSessionId = sessionId;
    ss.lastActiveSessionId = sessionId;

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

    syncDesktopSessionIndicator();
    updateDocumentTitle();

    // Manage SSE connections and polling for live view
    if (currentRoute === "live" && sessionExists) {
      // Disconnect previous session if different
      if (previousSessionId && previousSessionId !== sessionId) {
        sseManager.disconnect(previousSessionId);
      }
      // Connect to new session
      sseManager.connect(sessionId);

      // Start conversation polling (1 second interval)
      startConversationPolling(sessionId);

      // Dispatch session-change event for Alpine.js chat component
      if (isAlpineChatEnabled() && previousSessionId !== sessionId) {
        window.wingman = window.wingman || {};
        window.wingman.activeSessionId = sessionId;
        window.dispatchEvent(new CustomEvent("session-change", { detail: { sessionId } }));
      }

      // Scroll to end when switching to a different session
      if (previousSessionId !== sessionId) {
        scheduleLiveScroll(sessionId, { includeWindow: true });
      }
    }

    return true;
  }

  // No session selected - stop polling
  ss.activeSessionId = null;
  lastLoggedSessionId = null;
  stopConversationPolling();
  if (updateHistory && currentRoute === "live" && window.location.pathname !== LIVE_ROUTE_PREFIX) {
    window.history.pushState({ route: "live" }, "", LIVE_ROUTE_PREFIX);
  }
  syncDesktopSessionIndicator();
  updateDocumentTitle();
  return true;
};

const ensureActiveSession = () => {
  const allSessions = sessionsStore().items;
  const activeId = sessionsStore().activeSessionId;
  const lastId = sessionsStore().lastActiveSessionId;

  if (activeId && allSessions.some((session) => session.id === activeId)) {
    return activeId;
  }
  if (lastId && allSessions.some((session) => session.id === lastId)) {
    setActiveSession(lastId, { updateHistory: false, logPort: false });
    return sessionsStore().activeSessionId;
  }
  if (currentRoute === "live") {
    setActiveSession(null, { updateHistory: false, logPort: false });
    return null;
  }
  const activeSessions = getActiveSessions();
  const fallback = activeSessions[0] ?? allSessions[0] ?? null;
  if (fallback) {
    setActiveSession(fallback.id, { updateHistory: false, logPort: false });
  } else {
    setActiveSession(null, { updateHistory: false, logPort: false });
  }
  return sessionsStore().activeSessionId;
};

const applyRouteSessionFromPath = (options = {}) => {
  const { allowHistoryUpdate = false, logPort = true } = options;
  const routeSessionId = getSessionIdFromPath(window.location.pathname);
  const allSessions = sessionsStore().items;
  const activeId = sessionsStore().activeSessionId;
  const lastId = sessionsStore().lastActiveSessionId;

  if (routeSessionId) {
    if (allSessions.some((session) => session.id === routeSessionId)) {
      if (activeId !== routeSessionId) {
        setActiveSession(routeSessionId, { updateHistory: false, logPort });
      }
      return false;
    }
    if (activeId) {
      setActiveSession(null, { updateHistory: false, logPort: false });
    }
    return true;
  }

  if (allowHistoryUpdate && lastId && allSessions.some((session) => session.id === lastId)) {
    setActiveSession(lastId, { updateHistory: true, logPort });
    return false;
  }

  if (activeId && !allSessions.some((session) => session.id === activeId)) {
    setActiveSession(null, { updateHistory: allowHistoryUpdate, logPort: false });
  }
  return false;
};

const dialog = document.getElementById("session-dialog");
const agentSelect = document.getElementById("agent-select");
const confirmButton = document.getElementById("confirm-session");
const cancelButton = document.getElementById("cancel-session");
const sessionForm = dialog?.querySelector("form");
const appRoot = document.getElementById("app");
const navLinks = Array.from(document.querySelectorAll("nav a[data-route]"));
const projectsNavLink = navLinks.find((link) => link.dataset.route === "projects");
const nightwatchNavLink = navLinks.find((link) => link.dataset.route === "nightwatch");
const themeToggle = document.getElementById("theme-toggle");
const tabsToggle = document.getElementById("tabs-toggle");
const menuToggle = document.getElementById("menu-toggle");
const menuPanel = document.querySelector(".wm-menu-panel");
const menuTabsContainer = document.getElementById("menu-tabs");
const headerLoginButton = document.getElementById("header-login");
performAuthUiSync = () => {
  const authed = Boolean(state.identity.authenticated);
  const isAdmin = Boolean(state.identity.isAdmin);
  if (typeof document !== "undefined" && document.body) {
    document.body.dataset.authenticated = authed ? "true" : "false";
    document.body.dataset.admin = isAdmin ? "true" : "false";
  }
  navLinks.forEach((link) => {
    if (authed) {
      link.removeAttribute("tabindex");
    } else {
      link.setAttribute("tabindex", "-1");
    }
  });
  if (!authed && typeof document !== "undefined" && document.body.dataset.menuOpen === "true") {
    delete document.body.dataset.menuOpen;
    menuToggle?.setAttribute("aria-expanded", "false");
    menuPanel?.setAttribute("aria-hidden", "true");
  }
  if (headerLoginButton) {
    headerLoginButton.disabled = authed;
  }
  syncProjectsNavigationVisibility();
  syncNightWatchNavigationVisibility();
};

performAuthUiSync();
const pullRefreshIndicator = document.getElementById("pull-refresh");
const pullRefreshLabel = pullRefreshIndicator?.querySelector(".label");
const desktopSessionIndicator = document.getElementById("desktop-session-indicator");
const desktopSessionIndicatorButton = document.getElementById("desktop-session-indicator-button");
const identityLoginDialog = document.getElementById("identity-login-dialog");
const identityLoginDialogContent = identityLoginDialog?.querySelector(".wm-identity-dialog__content");
const identityLoginDialogCloseButton = identityLoginDialog?.querySelector('[data-action="identity-dialog-close"]');
const desktopSessionIndicatorName =
  desktopSessionIndicator?.querySelector('[data-part="name"]') ?? null;
const desktopSessionIndicatorDirectory =
  desktopSessionIndicator?.querySelector('[data-part="directory"]') ?? null;
const headerWebviewToggle = document.getElementById("header-webview-toggle");
const headerWriterToggle = document.getElementById("header-writer-toggle");
const sessionNameInput = document.getElementById("session-name");
const sessionAdvancedToggle = document.getElementById("session-advanced-toggle");
const sessionAdvancedPanel = document.getElementById("session-advanced-panel");
const sessionWorkspaceModeSelect = document.getElementById("session-workspace-mode");
const sessionWorktreeField = document.querySelector('[data-workspace="worktree"]');
const sessionWorktreeNameInput = document.getElementById("session-worktree-name");
const sessionWorktreeHint = document.getElementById("session-worktree-hint");
const sessionWriterModeCheckbox = document.getElementById("session-writer-mode");
const sessionTargetFileInput = document.getElementById("session-target-file");
const sessionTargetFileField = document.getElementById("session-target-file-field");
const directoryInput = document.getElementById("working-directory");
const directorySuggestions = document.getElementById("directory-suggestions");
const browseDirectoryButton = document.getElementById("browse-directory");
const directoryDialog = document.getElementById("directory-dialog");
const directoryTitle = document.getElementById("directory-title");
const directoryList = document.getElementById("directory-list");
const directoryCurrent = document.getElementById("directory-current");
const directoryUpButton = document.getElementById("directory-up");
const directoryNewFolderButton = document.getElementById("directory-new-folder");
const directoryUseButton = document.getElementById("directory-use");
const fileTransferDialog = document.getElementById("file-transfer-dialog");
const fileTransferTitle = document.getElementById("file-transfer-title");
const fileTransferSource = document.getElementById("file-transfer-source");
const fileTransferCurrent = document.getElementById("file-transfer-current");
const fileTransferList = document.getElementById("file-transfer-list");
const fileTransferSelected = document.getElementById("file-transfer-selected");
const fileTransferNameInput = document.getElementById("file-transfer-name");
const fileTransferNameFeedback = document.getElementById("file-transfer-name-feedback");
const fileTransferUpButton = document.getElementById("file-transfer-up");
const fileTransferNewFolderButton = document.getElementById("file-transfer-new-folder");
const fileTransferCancelButton = document.getElementById("file-transfer-cancel");
const fileTransferConfirmButton = document.getElementById("file-transfer-confirm");

const appDialog = document.getElementById("app-dialog");
const appForm = appDialog?.querySelector("form") ?? null;
const appDialogTitle = document.getElementById("app-dialog-title");
const appLabelInput = document.getElementById("app-label");
const appRootInput = document.getElementById("app-root");
const appRootBrowseButton = document.getElementById("app-root-browse");
const appAdvancedSection = document.getElementById("app-advanced");
const appTmuxInput = document.getElementById("app-tmux-session");
const appTmuxWindowInput = document.getElementById("app-tmux-window");
const appNotesInput = document.getElementById("app-notes");
const appDiscoverToggle = document.getElementById("app-discover-enabled");
const appDiscoverButton = document.getElementById("app-discover");
const appWebAppToggle = document.getElementById("app-web-app");
const appWebAppPortNote = document.getElementById("app-web-app-port");
const appScriptInputs = {
  start: document.getElementById("app-script-start"),
  stop: document.getElementById("app-script-stop"),
  restart: document.getElementById("app-script-restart"),
  setup: document.getElementById("app-script-setup"),
  build: document.getElementById("app-script-build"),
};
const appCancelButton = document.getElementById("app-cancel");
const appSaveButton = document.getElementById("app-save");
const appLogsDialog = document.getElementById("app-logs-dialog");
const appLogsTitle = document.getElementById("app-logs-title");
const appLogsContent = document.getElementById("app-logs-content");
const appLogsRefreshButton = document.getElementById("app-logs-refresh");
const appLogsCloseButton = document.getElementById("app-logs-close");
const appCloneButton = document.getElementById("app-clone");
const appCloneDialog = document.getElementById("app-clone-dialog");
const appCloneForm = appCloneDialog?.querySelector("form") ?? null;
const appCloneUrlInput = document.getElementById("app-clone-url");
const appCloneNameInput = document.getElementById("app-clone-name");
const appCloneCancelButton = document.getElementById("app-clone-cancel");
const appCloneConfirmButton = document.getElementById("app-clone-confirm");
const projectDialog = document.getElementById("project-dialog");
const projectDialogForm = projectDialog?.querySelector("form") ?? null;
const projectDialogNameInput = document.getElementById("project-dialog-name");
const projectDialogRootInput = document.getElementById("project-dialog-root");
const projectDialogRootBrowseButton = document.getElementById("project-dialog-root-browse");
const projectDialogError = document.getElementById("project-dialog-error");
const projectDialogCancel = document.getElementById("project-dialog-cancel");
const projectDialogSubmit = document.getElementById("project-dialog-submit");
const SHARED_TMUX_SESSION = "wingman-apps";

let identityLoginPanelRoot = null;

const ensureIdentityLoginPanel = () => {
  if (!identityLoginDialogContent) return null;
  if (!identityLoginPanelRoot) {
    identityLoginPanelRoot = renderIdentityPanel({ variant: "dialog" });
    identityLoginDialogContent.append(identityLoginPanelRoot);
  }
  return identityLoginPanelRoot;
};

function openIdentityLoginDialog() {
  const panel = ensureIdentityLoginPanel();
  if (!identityLoginDialog || !panel) {
    navigateToSettings();
    return;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("wingman:identity-login-open"));
  }
  if (typeof identityLoginDialog.showModal === "function") {
    identityLoginDialog.showModal();
  } else {
    navigateToSettings();
  }
}

function closeIdentityLoginDialog() {
  if (identityLoginDialog?.open) {
    identityLoginDialog.close();
  }
}

identityLoginDialogCloseButton?.addEventListener("click", (event) => {
  event.preventDefault();
  closeIdentityLoginDialog();
});

identityLoginDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeIdentityLoginDialog();
});

const syncProjectDialogState = () => {
  if (!projectDialog) return;
  const formState = projectFeature?.state?.createForm;
  const nameValue = formState?.name ?? "";
  const rootValue = formState?.rootPath ?? "";
  if (projectDialogNameInput && projectDialogNameInput.value !== nameValue) {
    projectDialogNameInput.value = nameValue;
  }
  if (projectDialogRootInput && projectDialogRootInput.value !== rootValue) {
    projectDialogRootInput.value = rootValue;
  }
  if (projectDialogError) {
    if (formState?.error) {
      projectDialogError.hidden = false;
      projectDialogError.textContent = formState.error;
    } else {
      projectDialogError.hidden = true;
      projectDialogError.textContent = "";
    }
  }
  const submitting = Boolean(formState?.submitting);
  if (projectDialogSubmit) {
    projectDialogSubmit.textContent = submitting ? "Creating…" : "Create Project";
    projectDialogSubmit.disabled = submitting;
  }
  if (projectDialogCancel) {
    projectDialogCancel.disabled = submitting;
  }
  if (projectDialogNameInput) {
    projectDialogNameInput.disabled = submitting;
  }
  if (projectDialogRootInput) {
    projectDialogRootInput.disabled = submitting;
  }
};

function openProjectDialog() {
  if (!state.identity.authenticated) {
    openIdentityLoginDialog();
    return;
  }
  if (!projectsFeatureEnabledForViewer()) {
    showToast?.("Projects are disabled right now", { variant: "info" });
    return;
  }
  syncProjectDialogState();
  if (typeof projectDialog?.showModal === "function") {
    projectDialog.showModal();
    requestAnimationFrame(() => {
      if (projectDialogNameInput) {
        projectDialogNameInput.focus();
        const length = projectDialogNameInput.value.length;
        projectDialogNameInput.setSelectionRange?.(length, length);
      }
    });
  }
}

function closeProjectDialog() {
  if (projectDialog?.open) {
    projectDialog.close();
  }
}

projectDialogCancel?.addEventListener("click", (event) => {
  event.preventDefault();
  closeProjectDialog();
});

projectDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeProjectDialog();
});

projectDialogNameInput?.addEventListener("input", (event) => {
  projectFeature?.setCreateFormValue?.("name", event.target.value);
});

projectDialogRootInput?.addEventListener("input", (event) => {
  projectFeature?.setCreateFormValue?.("rootPath", event.target.value);
  scheduleDirectorySuggestions(event.target.value);
});

projectDialogRootInput?.addEventListener("focus", () => {
  scheduleDirectorySuggestions(projectDialogRootInput.value);
});

projectDialogForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!projectFeature) {
    return;
  }
  if (!projectsFeatureEnabledForViewer()) {
    showToast?.("Projects are disabled right now", { variant: "info" });
    closeProjectDialog();
    return;
  }
  const success = await projectFeature.submitCreateProject();
  syncProjectDialogState();
  if (success) {
    closeProjectDialog();
    showToast("Project created");
  }
});

projectDialogRootBrowseButton?.addEventListener("click", (event) => {
  event.preventDefault();
  const seed =
    projectDialogRootInput?.value?.trim() || state.lastWorkingDirectory || state.config?.defaultDirectory || "";
  void openDirectoryBrowser({
    initialPath: seed,
    title: "Select Project Root",
    confirmLabel: "Use This Directory",
    allowCreate: true,
    onSelect: (path) => {
      if (projectDialogRootInput) {
        projectDialogRootInput.value = path;
      }
      state.lastWorkingDirectory = path;
      projectFeature?.setCreateFormValue?.("rootPath", path);
      scheduleDirectorySuggestions(path);
    },
  });
});

const readProjectApiError = async (response) => {
  const payload = await response.json().catch(() => ({}));
  const message = typeof payload?.error === "string" ? payload.error : response.statusText;
  return message || "Request failed";
};

const linkAppToProject = async (context, app) => {
  if (!context?.projectId || !app?.id) {
    return;
  }
  if (!projectsFeatureEnabledForViewer()) {
    showToast?.("Projects are disabled right now", { variant: "info" });
    return;
  }
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(context.projectId)}/apps`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ appId: app.id }),
    });
    if (!response.ok) {
      throw new Error(await readProjectApiError(response));
    }
    await projectFeature?.refresh();
    showToast(context.projectName ? `Added to ${context.projectName}` : "App linked to project");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to link app to project";
    window.alert(message);
  }
};

const openProjectAppCreation = (project) => {
  if (!project?.id) {
    return;
  }
  if (!state.identity.authenticated) {
    openIdentityLoginDialog();
    return;
  }
  if (!projectsFeatureEnabledForViewer()) {
    showToast?.("Projects are disabled right now", { variant: "info" });
    return;
  }
  const context = {
    projectId: project.id,
    projectName: project.name ?? "",
    rootPath: project.rootPath ?? "",
    defaultLabel: project.name ? `${project.name}` : "",
  };
  openAppDialog(null, { projectContext: context });
};

const resolveProjectAppEntry = (entry) => {
  if (!entry) {
    return null;
  }
  if (entry.appId) {
    const found = getAppById(entry.appId);
    if (found) {
      return found;
    }
  }
  if (entry.folderPath) {
    return appsStore().items.find((app) => app.root === entry.folderPath) ?? null;
  }
  return null;
};

const openProjectAppDetails = (appOrId) => {
  const targetId = typeof appOrId === "string" ? appOrId : appOrId?.id;
  if (!targetId) {
    return;
  }
  navigateToApps({ skipMenuClose: true, focusAppId: targetId });
};

const triggerProjectAppAction = (appId, action) => triggerAppAction(appId, action);

const isProjectActionDisabled = (app, action) => isAppActionDisabled(app, action);

headerLoginButton?.addEventListener("click", (event) => {
  event.preventDefault();
  openIdentityLoginDialog();
});

const applyTheme = (theme, persist = true) => {
  currentTheme = theme;
  document.body.dataset.theme = theme;
  themeToggle?.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  applyAceTheme();
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (error) {
      console.warn("Failed to persist theme preference", error);
    }
  }
};

const getActiveSessionForIndicator = () => {
  const activeId = sessionsStore().activeSessionId;
  if (!activeId) return null;
  return sessionsStore().items.find((session) => session.id === activeId) ?? null;
};

const shouldShowDesktopIndicator = () => currentRoute === "live" && window.innerWidth >= 900;

const syncDesktopSessionIndicator = () => {
  if (!desktopSessionIndicator) return;
  const session = getActiveSessionForIndicator();
  const canShow = Boolean(session) && shouldShowDesktopIndicator();
  if (!canShow) {
    desktopSessionIndicator.hidden = true;
    return;
  }

  const displayName = getSessionDisplayName(session);
  if (desktopSessionIndicatorName) {
    desktopSessionIndicatorName.textContent = displayName;
    desktopSessionIndicatorName.title = displayName;
  }

  const directoryValue =
    typeof session.workingDirectory === "string" && session.workingDirectory.trim().length > 0
      ? session.workingDirectory
      : state.config?.defaultDirectory ?? "";

  if (desktopSessionIndicatorDirectory) {
    if (directoryValue) {
      desktopSessionIndicatorDirectory.textContent = truncateText(directoryValue, 31);
      desktopSessionIndicatorDirectory.title = directoryValue;
    } else {
      desktopSessionIndicatorDirectory.textContent = "—";
      desktopSessionIndicatorDirectory.title = "";
    }
  }

  desktopSessionIndicator.hidden = false;
};

/**
 * Sync the header webview toggle button.
 * Shows a globe icon when the active session has an associated web app.
 */
function syncHeaderWebviewToggle(webApp) {
  if (!headerWebviewToggle) return;
  if (!webApp) {
    headerWebviewToggle.hidden = true;
    headerWebviewToggle.innerHTML = "";
    return;
  }
  headerWebviewToggle.hidden = false;
  headerWebviewToggle.innerHTML = "";
  const btn = createWebviewIcon(webApp, () => {
    state.webviewLayout.open = !state.webviewLayout.open;
    render();
  });
  if (state.webviewLayout.open) {
    btn.classList.add("active");
  }
  headerWebviewToggle.append(btn);
}

/**
 * Sync the header writer toggle button.
 * Shows a pencil icon when the active session has a targetFile.
 */
function syncHeaderWriterToggle(targetFile) {
  if (!headerWriterToggle) return;
  if (!targetFile) {
    headerWriterToggle.hidden = true;
    headerWriterToggle.innerHTML = "";
    return;
  }
  headerWriterToggle.hidden = false;
  headerWriterToggle.innerHTML = "";
  const btn = createWriterIcon(() => {
    state.writerLayout.open = !state.writerLayout.open;
    render();
  });
  if (state.writerLayout.open) {
    btn.classList.add("active");
  }
  headerWriterToggle.append(btn);
}

const getStoredThemePreference = () => {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
};

const detectPreferredTheme = () => {
  const stored = getStoredThemePreference();
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  return "light";
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

let menuOpenedAt = 0;

const closeMenu = (options = {}) => {
  const { force = false } = options;
  // Prevent immediate close after open (iOS touch event double-fire issue)
  if (!force && Date.now() - menuOpenedAt < 150) {
    return;
  }
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
    closeMenu({ force: true });
  } else {
    menuOpenedAt = Date.now();
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

const updateDocumentTitle = () => {
  let title = "Wingman";
  if (currentRoute === "live") {
    const titleActiveId = sessionsStore().activeSessionId;
    const session = titleActiveId
      ? sessionsStore().items.find((s) => s.id === titleActiveId)
      : null;
    if (session) {
      const sessionName = getSessionDisplayName(session);
      title = `${sessionName} - Wingman`;
    } else {
      title = "Agents - Wingman";
    }
  } else if (currentRoute === "apps") {
    title = "Apps - Wingman";
  } else if (currentRoute === "files") {
    title = "Files - Wingman";
  } else if (currentRoute === "settings") {
    title = "Settings - Wingman";
  } else if (currentRoute === "projects") {
    title = "Projects - Wingman";
  } else if (currentRoute === "nightwatch") {
    title = "Night Watchman - Wingman";
  } else if (currentRoute === "scheduler") {
    title = "Triggers - Wingman";
  } else if (currentRoute === "home") {
    title = "Home - Wingman";
  }
  document.title = title;
};

function syncProjectsNavigationVisibility() {
  const enabled = projectsFeatureEnabledForViewer();
  if (projectsNavLink) {
    projectsNavLink.hidden = !enabled;
    projectsNavLink.setAttribute("aria-hidden", enabled ? "false" : "true");
    if (!enabled) {
      projectsNavLink.setAttribute("tabindex", "-1");
    } else if (state.identity.authenticated) {
      projectsNavLink.removeAttribute("tabindex");
    }
  }
  return enabled;
}

function syncNightWatchNavigationVisibility() {
  const enabled = isFeatureEnabledForViewer("nightwatch_enabled");
  if (nightwatchNavLink) {
    nightwatchNavLink.hidden = !enabled;
    nightwatchNavLink.setAttribute("aria-hidden", enabled ? "false" : "true");
    if (!enabled) {
      nightwatchNavLink.setAttribute("tabindex", "-1");
    } else if (state.identity.authenticated) {
      nightwatchNavLink.removeAttribute("tabindex");
    }
  }
  return enabled;
}

const syncMenuTabs = () => {
  if (!menuTabsContainer) return;
  menuTabsContainer.innerHTML = "";
  menuTabsContainer.dataset.state = "ready";

  if (!state.identity.authenticated) {
    menuTabsContainer.dataset.state = "guest";
    return;
  }

  const heading = document.createElement("p");
  heading.className = "wm-menu-heading";
  heading.textContent = "Agents";
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

  if (state.identity.authenticated) {
    const addButton = document.createElement("div");
    addButton.className = "wm-tab new wm-menu-add-session";
    addButton.textContent = "+";
    addButton.title = "Start new session";
    addButton.addEventListener("click", () => {
      openDialog();
      closeMenu();
    });
    sessionsContainer.append(addButton);
  }

  menuTabsContainer.append(sessionsContainer);
};

const PULL_THRESHOLD = 90;
const PULL_MAX = 150;
const PULL_BASE_OFFSET = -120;
let pullStartY = null;
let pullActive = false;
let pullReady = false;
let pullRefreshing = false;

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


const fetchConfig = async () => {
  const configData = await fetchConfigApi();
  const adminNpubNormalized = normaliseNpubValue(configData?.adminNpub ?? null);
  const connectRelays = normaliseConnectRelays(configData?.connectRelays);
  state.config = { ...configData, adminNpub: adminNpubNormalized ?? null, connectRelays };
  if (typeof globalThis !== "undefined" && globalThis.wingmanIdentity) {
    globalThis.wingmanIdentity.connectRelays = connectRelays;
  }
  if (Array.isArray(configData?.featureFlags)) {
    syncFeatureFlagsFromConfig(configData.featureFlags);
  }
  agentSelect.innerHTML = "";
  state.config.agents.forEach((agent) => {
    const option = document.createElement("option");
    option.value = agent.id;
    option.textContent = agent.label;
    agentSelect.append(option);
  });
  // Default to configured default agent if available
  const defaultAgentId = state.config.defaultAgent ?? "claude";
  if (state.config.agents.some((a) => a.id === defaultAgentId)) {
    agentSelect.value = defaultAgentId;
  }
  syncOrchestratorAgents();
  if (directoryInput) {
    const initial =
      state.lastWorkingDirectory ??
      state.config.defaultDirectory ??
      "";
    directoryInput.value = initial;
    directoryInput.placeholder = state.config.defaultDirectory ?? "";
    scheduleDirectorySuggestions(initial);
  }
  updateIdentityState({ npub: state.identity.npub }, { persist: false, emit: true });
};

const fetchSessions = async () => {
  const ss = sessionsStore();

  // Delegate API call + Dexie write + filter/identity processing to store
  await ss.sync();

  // Handle 401 redirect (store sets items to [] on unauthorized)
  if (ss.items.length === 0 && !ss.initialized) {
    if (currentRoute !== "home") {
      currentRoute = "home";
      if (window.location.pathname !== HOME_ROUTE) {
        window.history.replaceState({ route: "home" }, "", HOME_ROUTE);
      }
    }
    return;
  }

  const allSessions = ss.items;
  const sessionIds = new Set(allSessions.map((session) => session.id));
  const lastId = ss.lastActiveSessionId;
  if (lastId && !sessionIds.has(lastId)) {
    ss.lastActiveSessionId = null;
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
  for (const key of Array.from(state.promptQueues.keys())) {
    if (!sessionIds.has(key)) state.promptQueues.delete(key);
  }
  const routeSessionId = getSessionIdFromPath(window.location.pathname);
  const allowHistoryUpdate = currentRoute === "live" && !routeSessionId;
  const redirectHome = applyRouteSessionFromPath({ allowHistoryUpdate });
  if (redirectHome) {
    currentRoute = "home";
    lastLoggedSessionId = null;
    if (window.location.pathname !== HOME_ROUTE) {
      window.history.replaceState({ route: "home" }, "", HOME_ROUTE);
    }
  }
  ensureActiveSession();
  const activeId = ss.activeSessionId;
  if (
    !redirectHome &&
    currentRoute === "live" &&
    activeId &&
    allSessions.some((session) => session.id === activeId)
  ) {
    setActiveSession(activeId, { updateHistory: false, forceLog: true });
  }

  syncDesktopSessionIndicator();

  if (!redirectHome && currentRoute === "live" && activeId) {
    await Promise.all([
      fetchLogs(activeId),
      fetchConversation(activeId),
      fetchSessionQueue(activeId),
    ]);
  }
};

const buildSessionFilterOptions = () => {
  const seen = new Set();
  const options = [];
  const appendOption = (value, label, meta = {}) => {
    if (seen.has(value)) return;
    seen.add(value);
    options.push({ value, label, ...meta });
  };

  const viewerNpub = normaliseNpubValue(state.identity.npub);
  if (state.identity.isAdmin && viewerNpub) {
    appendOption(viewerNpub, `My identity (${abbreviateNpub(viewerNpub)})`, { npub: viewerNpub });
  }

  appendOption("all", "All identities");

  const sessionFilterOptions = sessionsStore().filters.options;
  sessionFilterOptions.forEach((option) => {
    if (!option || typeof option !== "object") return;
    const value = typeof option.value === "string" ? option.value : "__anonymous__";
    const npub = typeof option.npub === "string" ? option.npub : null;
    const baseLabel = typeof option.label === "string" && option.label.trim().length > 0 ? option.label.trim() : npub ?? "Anonymous";
    const sessionCount = typeof option.sessionCount === "number" ? option.sessionCount : 0;
    const activeCount = typeof option.activeCount === "number" ? option.activeCount : 0;
    const detail = activeCount > 0 ? `${sessionCount} sessions (${activeCount} active)` : `${sessionCount} sessions`;
    appendOption(value, `${baseLabel} • ${detail}`, { npub, sessionCount, activeCount });
  });

  return options;
};

const buildAppFilterOptions = () => {
  if (!state.identity.isAdmin) {
    return [];
  }
  const seen = new Set();
  const options = [];
  const appendOption = (value, label) => {
    if (seen.has(value)) return;
    seen.add(value);
    options.push({ value, label });
  };
  const viewerNpub = normaliseNpubValue(state.identity.npub);
  if (viewerNpub) {
    appendOption(viewerNpub, `My apps (${abbreviateNpub(viewerNpub)})`);
  }
  appendOption("all", "All apps");
  const appFilterOptions = appsStore().filters.options;
  appFilterOptions.forEach((option) => {
    if (!option || typeof option !== "object") return;
    const value = typeof option.value === "string" ? option.value : "__anonymous__";
    if (seen.has(value)) return;
    const alias = typeof option.alias === "string" && option.alias.trim().length > 0 ? option.alias.trim() : null;
    const npub = typeof option.npub === "string" ? option.npub : null;
    const appCount = typeof option.appCount === "number" ? option.appCount : 0;
    const baseLabel = alias ?? (npub ? abbreviateNpub(npub) : value === "__anonymous__" ? "Shared" : "Unknown");
    const detail =
      appCount === 0 ? "No apps" : appCount === 1 ? "1 app" : `${appCount} apps`;
    appendOption(value, `${baseLabel} • ${detail}`);
  });
  return options;
};

const fetchLogs = async (sessionId) => {
  const data = await fetchSessionLogsApi(sessionId);
  if (!data) return;
  state.logs.set(sessionId, data.logs);

  // Trigger incremental DOM update if on live route
  if (currentRoute === "live" && sessionId === sessionsStore().activeSessionId) {
    updateLogsDOM(sessionId);
  }
};

const fetchConversation = async (sessionId) => {
  try {
    const data = await fetchSessionMessagesApi(sessionId);
    if (!data) return;
    const items = Array.isArray(data?.messages) ? data.messages : [];
    state.conversations.set(sessionId, items);

    // Push conversation directly to Alpine store — no Dexie intermediary.
    // This is the most reliable path: API truth → Alpine → DOM.
    if (isAlpineChatEnabled()) {
      const chatStore = window.Alpine?.store("chat");
      if (chatStore && chatStore.sessionId === sessionId) {
        chatStore.messages = items.map((msg, idx) => ({
          id: `api-${idx}`,
          sessionId,
          role: msg.role || msg.type || "assistant",
          content: msg.content || msg.message || "",
          createdAt: msg.createdAt || msg.created_at || "",
        }));
      }
      return;
    }

    // Legacy: manual DOM update
    if (currentRoute === "live" && sessionId === sessionsStore().activeSessionId) {
      updateConversationDOM(sessionId);
    }
  } catch (error) {
    console.error("Failed to load conversation", error);
  }
};

const fetchApps = async ({ tail = APP_LOG_PREVIEW_LINES } = {}) => {
  await appsStore().sync({ tail });
};

const fetchRestartStatus = async () => {
  if (!state.identity.isAdmin) {
    appsStore().system.restart.loading = false;
    appsStore().system.restart.inProgress = false;
    appsStore().system.restart.marker = null;
    appsStore().system.restart.outcome = null;
    appsStore().system.restart.error = null;
    return;
  }
  appsStore().system.restart.loading = true;
  try {
    const response = await fetch("/api/system/restart/status");
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
          ? payload.error
          : response.statusText || "Failed to load restart status";
      throw new Error(message);
    }
    appsStore().system.restart.inProgress = Boolean(payload?.inProgress);
    appsStore().system.restart.marker = payload?.marker ?? null;
    appsStore().system.restart.outcome = payload?.outcome ?? null;
    appsStore().system.restart.error = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load restart status";
    appsStore().system.restart.error = message;
  } finally {
    appsStore().system.restart.loading = false;
  }
};


const refreshApps = async ({ tail = APP_LOG_PREVIEW_LINES, skipRender = false } = {}) => {
  if (state.identity.isAdmin) {
    await Promise.all([fetchApps({ tail }), fetchRestartStatus()]);
  } else {
    await fetchApps({ tail });
  }
  if (!skipRender && currentRoute === "apps") {
    render();
  }
};

const ensureAppsLoaded = async () => {
  if (appsStore().loading) return;
  if (!appsStore().initialized) {
    await refreshApps({ skipRender: false });
  }
};

// Apps polling has been replaced by Dexie-backed Alpine store with liveQuery.
// These stubs remain for callers that haven't been updated yet.
const syncAppsPolling = () => {};

const pollSessions = async () => {
  try {
    const allSessions = sessionsStore().items;
    const previousSessionCount = allSessions.length;
    const previousSessionIds = allSessions.map(s => s.id).join(',');

    await fetchSessions();
    syncMenuTabs();
    syncDesktopSessionIndicator();

    const updatedSessions = sessionsStore().items;
    const currentSessionCount = updatedSessions.length;
    const currentSessionIds = updatedSessions.map(s => s.id).join(',');
    const sessionsChanged = previousSessionCount !== currentSessionCount || previousSessionIds !== currentSessionIds;

    if (currentRoute === "home") {
      // Only render on home route if sessions actually changed
      if (sessionsChanged) {
        render();
      }
      // Don't update status indicators on home route - they're not visible there
      return;
    }

    if (currentRoute !== "live") {
      return;
    }

    const activeId = sessionsStore().activeSessionId;
    if (!activeId) {
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

    updateAgentStatusIndicators();
    
  } catch (error) {
    console.error("Failed to refresh sessions", error);
  }
};

// Session polling has been replaced by Dexie-backed Alpine store with liveQuery.
// These stubs remain for callers that haven't been updated yet.
const startSessionPolling = () => {};
const stopSessionPolling = () => {};
const syncSessionPolling = () => {};

// Conversation polling for live view - polls every 100ms for responsiveness
const CONVERSATION_POLL_INTERVAL = 100;
// When Alpine handles messages via SSE, we still need to poll session status
// and queue data, but at a slower cadence (1s) to avoid hammering the API.
const STATUS_POLL_INTERVAL = 1000;

const startConversationPolling = (sessionId) => {
  stopConversationPolling();
  if (!sessionId) return;

  const alpineActive = isAlpineChatEnabled();
  const interval = alpineActive ? STATUS_POLL_INTERVAL : CONVERSATION_POLL_INTERVAL;

  console.log(`[poll] Starting ${alpineActive ? "status" : "conversation"} polling for ${sessionId} (${interval}ms)`);

  conversationPollIntervalId = window.setInterval(async () => {
    if (conversationPollInFlight) return;
    const pollingActiveId = sessionsStore().activeSessionId;
    if (currentRoute !== "live" || pollingActiveId !== sessionId) {
      stopConversationPolling();
      return;
    }

    conversationPollInFlight = true;
    try {
      // Fetch conversation, session status, and queue in parallel.
      // Alpine mode: fetchConversation syncs to Dexie (no manual DOM).
      const fetches = [fetchConversation(sessionId), fetchSessionApi(sessionId), fetchSessionQueueApi(sessionId)];

      const [, sessionData, queueData] = await Promise.all(fetches);

      // Update session status if we got data
      if (sessionData) {
        const session = sessionsStore().items.find((s) => s.id === sessionId);
        if (session) {
          const oldStatus = session.agentRuntimeStatus;
          session.agentRuntimeStatus = sessionData.agentRuntimeStatus ?? null;
          // Update UI if status changed
          if (oldStatus !== session.agentRuntimeStatus) {
            updateAgentStatusIndicators();
          }
        }
      }

      // Sync queue from server (response is { id, queue: { prompts, maxSize } })
      if (queueData?.queue) {
        const queue = getSessionQueue(sessionId);
        const oldCount = queue.prompts.length;
        queue.prompts = queueData.queue.prompts ?? [];
        queue.maxSize = queueData.queue.maxSize ?? 21;
        // Update UI if queue count changed
        if (oldCount !== queue.prompts.length) {
          updateAgentStatusIndicators();
        }
      }
    } catch (err) {
      console.warn("[poll] Poll failed:", err);
    } finally {
      conversationPollInFlight = false;
    }
  }, interval);
};

const stopConversationPolling = () => {
  if (conversationPollIntervalId !== null) {
    console.log("[poll] Stopping conversation polling");
    window.clearInterval(conversationPollIntervalId);
    conversationPollIntervalId = null;
  }
  conversationPollInFlight = false;
};

const getSessionFallbackDirectory = () => {
  return (
    directoryInput?.value?.trim() ||
    state.lastWorkingDirectory ||
    state.config?.defaultDirectory ||
    ""
  );
};

const openDialog = () => {
  if (sessionDialogController) {
    sessionDialogController.open();
    return;
  }
  if (!state.identity.authenticated) {
    openIdentityLoginDialog();
    return;
  }
  if (!state.config) return;
  const fallbackDirectory = getSessionFallbackDirectory();
  if (sessionNameInput) {
    sessionNameInput.value = "";
  }
  if (directoryInput) {
    directoryInput.value = fallbackDirectory;
    scheduleDirectorySuggestions(fallbackDirectory);
  }
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    if (sessionNameInput) {
      sessionNameInput.focus();
      sessionNameInput.select();
    } else {
      directoryInput?.focus();
      directoryInput?.select();
    }
  } else {
    // Fallback: use prompt if dialog unsupported.
    const agent = window.prompt(
      `Select agent (${state.config.agents.map((a) => a.id).join(", ")}):`,
      state.config.agents[0]?.id ?? "",
    );
    if (agent) {
      const directory = window.prompt("Working directory:", fallbackDirectory) ?? fallbackDirectory;
      const sessionName = window.prompt("Session name (optional):", "") ?? "";
      launchSession(agent, directory, sessionName);
    }
  }
};

const closeDialog = () => {
  if (sessionDialogController) {
    sessionDialogController.close();
    return;
  }
  if (dialog.open) {
    dialog.close();
  }
  if (sessionNameInput) {
    sessionNameInput.value = "";
  }
};

const handleSessionStart = async (session, options = {}) => {
  const { suppressRouteChange = false } = options;
  if (!session || !session.id) {
    return;
  }

  const switchingToLive = currentRoute !== "live";
  if (switchingToLive && !suppressRouteChange) {
    currentRoute = "live";
  }
  setActiveSession(session.id, {
    allowPending: true,
    logPort: false,
    updateHistory: !suppressRouteChange,
  });
  if (typeof session.workingDirectory === "string" && session.workingDirectory.length > 0) {
    state.lastWorkingDirectory = session.workingDirectory;
    if (directoryInput) {
      directoryInput.value = session.workingDirectory;
      scheduleDirectorySuggestions(session.workingDirectory);
    }
    sessionDialogController?.syncWorktreeHint?.();
  }
  await fetchSessions();
  await Promise.all([fetchConversation(session.id), fetchLogs(session.id)]);
  render();
};

const launchSession = createSessionLauncher({
  handleSessionStart,
  liveRoutePrefix: LIVE_ROUTE_PREFIX,
});

sessionDialogController = createSessionDialogController({
  dialog,
  agentSelect,
  sessionNameInput,
  directoryInput,
  advancedToggle: sessionAdvancedToggle,
  advancedPanel: sessionAdvancedPanel,
  workspaceSelect: sessionWorkspaceModeSelect,
  worktreeField: sessionWorktreeField,
  worktreeNameInput: sessionWorktreeNameInput,
  worktreeHint: sessionWorktreeHint,
  writerModeCheckbox: sessionWriterModeCheckbox,
  targetFileInput: sessionTargetFileInput,
  targetFileField: sessionTargetFileField,
  isAuthenticated: () => Boolean(state.identity.authenticated),
  getConfig: () => state.config,
  getFallbackDirectory: getSessionFallbackDirectory,
  onRequireAuth: openIdentityLoginDialog,
  onDirectoryPrefill: (...args) => scheduleDirectorySuggestions(...args),
  onSubmit: ({ agentId, workingDirectory, sessionName, workspace, targetFile }) => {
    const options = targetFile ? { targetFile } : undefined;
    launchSession(agentId, workingDirectory, sessionName, workspace, options);
  },
});
sessionDialogController.resetFormState();

const stopSession = async (sessionId) => {
  const result = await stopSessionApi(sessionId);
  if (!result.success) {
    window.alert(`Failed to stop session: ${result.error}`);
    return;
  }
  await fetchSessions();
  render();
};

const deleteSession = async (sessionId) => {
  try {
    const result = await deleteSessionApi(sessionId);
    if (!result.success) {
      window.alert(`Failed to delete session: ${result.error}`);
      return;
    }
    await fetchSessions();
    render();
  } catch (error) {
    console.error("Failed to delete session", error);
    window.alert("Failed to delete session. Check console for details.");
  }
};

const updateSessionName = async (sessionId, name) => {
  return updateSessionNameApi(sessionId, name);
};

const promptRenameSession = async (session) => {
  const currentLabel =
    typeof session.name === "string" && session.name.trim().length > 0
      ? session.name.trim()
      : getSessionDisplayName(session);
  const nextName = window.prompt("Rename session", currentLabel);
  if (nextName === null) return;
  const trimmed = nextName.trim();
  if (!trimmed) {
    window.alert("Session name cannot be empty.");
    return;
  }
  const existing = typeof session.name === "string" ? session.name.trim() : "";
  if (existing === trimmed) {
    return;
  }
  try {
    await updateSessionName(session.id, trimmed);
    await fetchSessions();
    render();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to rename session";
    window.alert(message);
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

const postSessionMessage = async (sessionId, content, type = "user") => {
  try {
    const result = await postSessionMessageApi(sessionId, content, type);
    if (result && typeof result === "object" && typeof result.balance === "number") {
      updateIdentityState({ balance: result.balance }, { persist: true, emit: true });
    }
    return result;
  } catch (error) {
    // Handle balance update from error response
    if (error && typeof error.balance === "number") {
      updateIdentityState({ balance: error.balance }, { persist: true, emit: true });
    }
    throw error;
  }
};

const sendMessage = async (sessionId, content) => {
  const session = sessionsStore().items.find((item) => item.id === sessionId);
  if (!session) return;
  const trimmed = typeof content === "string" ? content.trim() : "";
  if (!trimmed) {
    window.alert("Enter a message before sending.");
    return;
  }

  // Single alphanumeric character: send as raw terminal input for TUI interaction
  if (/^[a-zA-Z0-9]$/.test(trimmed)) {
    try {
      await postSessionMessage(sessionId, trimmed, "raw");
      showToast(`Sent ${trimmed}`);
      state.messageDrafts.set(sessionId, "");
      const textarea = document.querySelector('.wm-composer textarea');
      if (textarea) {
        textarea.value = "";
        textarea.style.height = "auto";
        requestAnimationFrame(() => textarea.focus({ preventScroll: true }));
      }
      // Show the raw input in the chat and refresh conversation
      if (isAlpineChatEnabled()) {
        const chatStore = window.Alpine?.store("chat");
        if (chatStore && chatStore.sessionId === sessionId) {
          chatStore.messages = [...chatStore.messages, {
            id: `raw-${Date.now()}`,
            sessionId,
            role: "user",
            content: trimmed,
            createdAt: new Date().toISOString(),
          }];
        }
      }
      await Promise.all([fetchConversation(sessionId), fetchLogs(sessionId)]);
    } catch (error) {
      console.error("Failed to send raw input", error);
      showToast(`Failed to send ${trimmed}`, { variant: "error" });
    }
    return;
  }

  // Check if agent is busy - if so, queue the message
  if (isSessionBusy(session)) {
    const queued = await addToPromptQueue(sessionId, trimmed);
    if (queued) {
      state.messageDrafts.set(sessionId, "");
      // Clear the textarea
      const textarea = document.querySelector('.wm-composer textarea');
      if (textarea) {
        textarea.value = "";
        textarea.style.height = "auto";
        requestAnimationFrame(() => {
          textarea.focus({ preventScroll: true });
        });
      }
      // Update status indicators to show queue count
      updateAgentStatusIndicators();
    }
    return;
  }

  // Agent is not busy - send message immediately
  try {
    const payload = await postSessionMessage(sessionId, trimmed, "user");
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    state.conversations.set(sessionId, messages);
    state.messageDrafts.set(sessionId, "");

    // Activate knight rider effect immediately after sending
    const knightRider = document.querySelector(`.wm-knight-rider[data-session-id="${sessionId}"]`);
    if (knightRider) knightRider.classList.add("active");

    // After sending, update conversation display
    if (isAlpineChatEnabled()) {
      const chatStore = window.Alpine?.store("chat");
      if (chatStore && chatStore.sessionId === sessionId) {
        chatStore.messages = messages.map((msg, idx) => ({
          id: `api-${idx}`,
          sessionId,
          role: msg.role || msg.type || "assistant",
          content: msg.content || msg.message || "",
          createdAt: msg.createdAt || msg.created_at || "",
        }));
      }
    } else {
      updateConversationDOM(sessionId);
    }
    scrollPillHide();
    requestAnimationFrame(() => {
      scrollConversationAreaToBottom(sessionId, { includeWindow: true });
    });
    await fetchLogs(sessionId);

    const textarea = document.querySelector('.wm-composer textarea');
    if (textarea) {
      textarea.value = "";
      textarea.style.height = "auto";
      requestAnimationFrame(() => {
        textarea.focus({ preventScroll: true });
      });
    }
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Failed to send message to agent.";
    console.error("Failed to send agent message", error);
    window.alert(`Agent request failed: ${message}`);
  }
};

const sendControlCommand = async (sessionId, action) => {
  const session = sessionsStore().items.find((item) => item.id === sessionId);
  if (!session || !action || typeof action.sequence !== "string") {
    return;
  }
  try {
    await postSessionMessage(sessionId, action.sequence, "raw");
    showToast(`Sent ${action.toastLabel}`);
    await fetchLogs(sessionId);
  } catch (error) {
    console.error(`Failed to send control command (${action.toastLabel})`, error);
    showToast(`Failed to send ${action.toastLabel}`, { variant: "error" });
  }
};

const APP_STATUS_LABELS = {
  idle: "Idle",
  running: "Running",
  stopping: "Stopping",
  restarting: "Restarting",
  building: "Building",
  "setting-up": "Setting Up",
  failed: "Failed",
};

const APP_ACTION_LABELS = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  setup: "Setup",
  build: "Build",
};

const APP_BUSY_STATUSES = new Set(["stopping", "restarting", "building", "setting-up"]);

const formatAppActionLabel = (action) => APP_ACTION_LABELS[action] ?? action ?? "Unknown";

const formatAppTimestamp = (value) => {
  if (!value) return "—";
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  } catch {
    return value;
  }
};

const getAppById = (appId) => appsStore().items.find((item) => item?.id === appId) ?? null;

const isAppBusy = (app) => {
  const status = app?.status;
  if (!status) return false;
  if (status.inProgressAction) return true;
  if (APP_BUSY_STATUSES.has(status.status)) return true;
  return false;
};

const isAppActionDisabled = (app, action) => {
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
  if (action === "setup") {
    return statusValue === "running";
  }
  if (action === "build") {
    return statusValue === "running";
  }
  return true;
};

const deriveAppWindowName = (labelValue, rootValue) => {
  const label = (labelValue ?? "").trim();
  const root = (rootValue ?? "").trim();
  const basename = (input) => {
    if (!input) return "";
    const segments = input.split(/[\\/]/).filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : "";
  };
  const source = label || basename(root);
  const cleaned = source
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 48);
  return cleaned.length > 0 ? cleaned : "app";
};

const triggerAppAction = async (appId, action) => {
  const result = await triggerAppActionApi(appId, action);
  if (!result.success) {
    window.alert(result.error);
    return false;
  }
  await refreshApps({ skipRender: currentRoute !== "apps" });
  if (currentRoute !== "apps") {
    render();
  }
  return true;
};

const triggerWarmRestart = async () => {
  if (appsStore().system.restart.submitting || appsStore().system.restart.inProgress) {
    return false;
  }
  appsStore().system.restart.submitting = true;
  try {
    await triggerWarmRestartApi();
    appsStore().system.restart.inProgress = true;
    appsStore().system.restart.error = null;
    await fetchRestartStatus();
    if (currentRoute === "apps") {
      render();
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to initiate restart";
    appsStore().system.restart.error = message;
    window.alert(message);
    return false;
  } finally {
    appsStore().system.restart.submitting = false;
  }
};

const runSystemCleanup = async () => {
  if (appsStore().system.cleanup.running) {
    return false;
  }
  appsStore().system.cleanup.running = true;
  appsStore().system.cleanup.error = null;
  if (currentRoute === "apps") {
    render();
  }
  try {
    const payload = await runSystemCleanupApi();
    appsStore().system.cleanup.result = payload;
    appsStore().system.cleanup.error = null;
    await Promise.all([
      fetchSessions(),
      refreshApps({ skipRender: true }),
    ]);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to stop agents and apps";
    appsStore().system.cleanup.error = message;
    window.alert(message);
    return false;
  } finally {
    appsStore().system.cleanup.running = false;
    if (currentRoute === "apps") {
      render();
    }
  }
};

const removeApp = async (appId) => {
  const app = getAppById(appId);
  if (!app) return;
  const confirmed = window.confirm(`Remove "${app.label ?? app.id}" from Wingman?`);
  if (!confirmed) return;
  const killSession = app?.status?.running
    ? window.confirm("The app appears to be running. Kill the tmux session as well?")
    : false;
  const result = await removeAppApi(appId, killSession);
  if (!result.success) {
    window.alert(result.error);
    return;
  }
  await refreshApps({ skipRender: false });
};

const VARIABLE_URL_LOG_PREFIX = "[WINGMAN21-URL]";
const VARIABLE_PUBKEY_LOG_PREFIX = "[WINGMAN21-PUBKEY]";

const extractVariableUrlFromLogs = (logs) => {
  if (!Array.isArray(logs)) return null;
  for (const entry of logs) {
    if (typeof entry !== "string") continue;
    if (!entry.startsWith(VARIABLE_URL_LOG_PREFIX)) continue;
    const remainder = entry.slice(VARIABLE_URL_LOG_PREFIX.length).trim();
    if (!remainder) continue;
    const candidate = remainder.split(/\s+/)[0];
    try {
      const url = new URL(candidate);
      return url.toString();
    } catch {
      continue;
    }
  }
  return null;
};

const extractPubkeyFromLogs = (logs) => {
  if (!Array.isArray(logs)) return null;
  for (const entry of logs) {
    if (typeof entry !== "string") continue;
    if (!entry.startsWith(VARIABLE_PUBKEY_LOG_PREFIX)) continue;
    const remainder = entry.slice(VARIABLE_PUBKEY_LOG_PREFIX.length).trim();
    if (!remainder) continue;
    const candidate = remainder.split(/\s+/)[0];
    if (!candidate) continue;
    if (!/^[0-9a-fA-F]{64,130}$/.test(candidate)) continue;
    return candidate;
  }
  return null;
};

const appendVariableUrlRow = (metaContainer, logs) => {
  if (!metaContainer) return;
  const variableUrl = extractVariableUrlFromLogs(logs);
  if (!variableUrl) return;

  const row = document.createElement("div");
  row.className = "wm-app-meta-row";

  const label = document.createElement("span");
  label.className = "wm-app-meta-label";
  label.textContent = "Variable URL";

  const value = document.createElement("span");
  value.className = "wm-app-meta-value";

  const link = document.createElement("a");
  link.href = variableUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = variableUrl;
  value.append(link);

  const copyButton = createCopyIconButton({
    text: variableUrl,
    ariaLabel: "Copy variable URL",
    title: "Copy variable URL",
  });
  value.append(copyButton);
  row.append(label, value);
  metaContainer.append(row);
};

const appendVariablePubkeyRow = (metaContainer, logs) => {
  if (!metaContainer) return;
  const pubkey = extractPubkeyFromLogs(logs);
  if (!pubkey) return;

  const row = document.createElement("div");
  row.className = "wm-app-meta-row";

  const label = document.createElement("span");
  label.className = "wm-app-meta-label";
  label.textContent = "Pubkey";

  const value = document.createElement("span");
  value.className = "wm-app-meta-value";

  const pubkeyDisplay = document.createElement("code");
  pubkeyDisplay.textContent = pubkey;
  value.append(pubkeyDisplay);

  const copyButton = createCopyIconButton({
    text: pubkey,
    ariaLabel: "Copy pubkey",
    title: "Copy pubkey",
  });

  value.append(copyButton);
  row.append(label, value);
  metaContainer.append(row);
};

const renderAppLogPreview = (logs) => {
  const preview = document.createElement("pre");
  preview.className = "wm-app-log";
  if (Array.isArray(logs) && logs.length > 0) {
    preview.textContent = logs.join("\n");
  } else {
    preview.textContent = "No recent logs.";
  }
  return preview;
};

const renderWingmanCard = (app) => {
  const card = document.createElement("section");
  card.className = "wm-card wm-app-card wm-app-card-core";

  const header = document.createElement("div");
  header.className = "wm-app-card__header";
  const title = document.createElement("h3");
  title.textContent = app.label ?? "Wingman Server";
  header.append(title);

  const statusBadge = document.createElement("span");
  statusBadge.className = "wm-app-status";
  const restartInProgress = appsStore().system.restart.inProgress;
  const cleanupState = appsStore().system.cleanup;
  const cleanupRunning = cleanupState.running;
  const statusValue = restartInProgress ? "restarting" : app?.status?.status ?? "running";
  statusBadge.dataset.state = statusValue;
  statusBadge.textContent = APP_STATUS_LABELS[statusValue] ?? statusValue;
  header.append(statusBadge);
  card.append(header);

  const statusInfo = document.createElement("div");
  statusInfo.className = "wm-app-status-info";

  if (appsStore().system.restart.error) {
    const errorLine = document.createElement("p");
    errorLine.className = "wm-app-status-error";
    errorLine.textContent = appsStore().system.restart.error;
    statusInfo.append(errorLine);
  } else if (restartInProgress) {
    const progressLine = document.createElement("p");
    const sessionCount = Array.isArray(appsStore().system.restart.marker?.sessionIds)
      ? appsStore().system.restart.marker.sessionIds.length
      : null;
    progressLine.textContent =
      sessionCount && sessionCount > 0
        ? `Warm restart in progress… preserving ${sessionCount} active session${sessionCount === 1 ? "" : "s"}.`
        : "Warm restart in progress… Wingman will reload without interrupting active sessions.";
    statusInfo.append(progressLine);
  } else if (appsStore().system.restart.outcome) {
    const outcome = appsStore().system.restart.outcome;
    const summaryLine = document.createElement("p");
    summaryLine.textContent = `Last warm restart restored ${outcome.restored} session${
      outcome.restored === 1 ? "" : "s"
    } (${formatAppTimestamp(outcome.timestamp)}).`;
    statusInfo.append(summaryLine);
    if (outcome.failed?.length > 0) {
      const failedLine = document.createElement("p");
      failedLine.textContent = `Unable to rehydrate ${outcome.failed.length} session${
        outcome.failed.length === 1 ? "" : "s"
      }.`;
      statusInfo.append(failedLine);
    }
  } else {
    const idleLine = document.createElement("p");
    idleLine.textContent = "Warm restart keeps agent sessions alive while Wingman reloads.";
    statusInfo.append(idleLine);
  }

  const marker = appsStore().system.restart.marker;
  if (marker?.createdAt && !restartInProgress) {
    const scheduledLine = document.createElement("p");
    scheduledLine.textContent = `Last restart request: ${formatAppTimestamp(marker.createdAt)}`;
    statusInfo.append(scheduledLine);
  }

  const cleanupResult =
    cleanupState.result && typeof cleanupState.result === "object" ? cleanupState.result : null;
  if (cleanupState.error) {
    const cleanupError = document.createElement("p");
    cleanupError.className = "wm-app-status-error";
    cleanupError.textContent = cleanupState.error;
    statusInfo.append(cleanupError);
  }
  if (cleanupResult && typeof cleanupResult.timestamp === "string") {
    const sessionsSummary =
      cleanupResult.sessions && typeof cleanupResult.sessions === "object"
        ? cleanupResult.sessions
        : {};
    const appsSummary =
      cleanupResult.apps && typeof cleanupResult.apps === "object"
        ? cleanupResult.apps
        : {};
    const deletedSessions =
      typeof sessionsSummary.deleted === "number" ? sessionsSummary.deleted : 0;
    const removedApps = typeof appsSummary.removed === "number" ? appsSummary.removed : 0;
    const summaryLine = document.createElement("p");
    summaryLine.textContent = `Last cleanup removed ${deletedSessions} session${deletedSessions === 1 ? "" : "s"} and ${removedApps} app${removedApps === 1 ? "" : "s"} (${formatAppTimestamp(cleanupResult.timestamp)}).`;
    statusInfo.append(summaryLine);
    const sessionFailures =
      typeof sessionsSummary.failed === "number" ? sessionsSummary.failed : 0;
    const appFailures = typeof appsSummary.failed === "number" ? appsSummary.failed : 0;
    const totalFailures = sessionFailures + appFailures;
    if (totalFailures > 0) {
      const failureLine = document.createElement("p");
      failureLine.textContent = `${totalFailures} cleanup action${totalFailures === 1 ? "" : "s"} reported errors.`;
      statusInfo.append(failureLine);
    }
    if (cleanupResult.preservedCoreApp) {
      const preservedLine = document.createElement("p");
      preservedLine.textContent = "Wingman core app preserved during cleanup.";
      statusInfo.append(preservedLine);
    }
  }

  card.append(statusInfo);

  card.append(renderAppLogPreview(app.logs));

  const actions = document.createElement("div");
  actions.className = "wm-app-actions";

  const viewLogsButton = document.createElement("button");
  viewLogsButton.type = "button";
  viewLogsButton.className = "wm-button secondary";
  viewLogsButton.textContent = "View Logs";
  viewLogsButton.addEventListener("click", () => void openAppLogsDialog(app.id));
  actions.append(viewLogsButton);

  const restartButton = document.createElement("button");
  restartButton.type = "button";
  restartButton.className = "wm-button";
  restartButton.textContent = restartInProgress ? "Restarting…" : "Restart Wingman";
  restartButton.disabled =
    appsStore().system.restart.submitting || restartInProgress || cleanupRunning;
  restartButton.addEventListener("click", async () => {
    if (restartButton.disabled) return;
    restartButton.disabled = true;
    restartButton.textContent = "Restarting…";
    const success = await triggerWarmRestart();
    if (!success) {
      restartButton.disabled = false;
      restartButton.textContent = "Restart Wingman";
    }
  });
  actions.append(restartButton);

  if (state.identity.isAdmin) {
    const cleanupButton = document.createElement("button");
    cleanupButton.type = "button";
    cleanupButton.className = "wm-button danger";
    const cleanupDisabled = cleanupRunning || restartInProgress || appsStore().system.restart.submitting;
    cleanupButton.textContent = cleanupRunning ? "Stopping…" : "Stop Agents & Apps";
    cleanupButton.disabled = cleanupDisabled;
    cleanupButton.addEventListener("click", async () => {
      if (cleanupButton.disabled) return;
      cleanupButton.disabled = true;
      cleanupButton.textContent = "Stopping…";
      const success = await runSystemCleanup();
      if (!success) {
        cleanupButton.disabled = false;
        cleanupButton.textContent = "Stop Agents & Apps";
      }
    });
    actions.append(cleanupButton);
  }

  card.append(actions);
  return card;
};

const renderAppCard = (app) => {
  const card = document.createElement("section");
  card.className = "wm-card wm-app-card";
  card.dataset.appId = app.id;
  if (app.id === "wingman-core") {
    card.classList.add("wm-app-card-core");
  }

  const header = document.createElement("div");
  header.className = "wm-app-card__header";
  const title = document.createElement("h3");
  title.textContent = app.label ?? app.id;
  header.append(title);

  const statusBadge = document.createElement("span");
  statusBadge.className = "wm-app-status";
  const statusValue = app?.status?.status ?? "idle";
  statusBadge.dataset.state = statusValue;
  statusBadge.textContent = APP_STATUS_LABELS[statusValue] ?? statusValue;
  header.append(statusBadge);
  card.append(header);

  const meta = document.createElement("div");
  meta.className = "wm-app-meta";

  const rootRow = document.createElement("div");
  rootRow.className = "wm-app-meta-row";
  const rootLabel = document.createElement("span");
  rootLabel.className = "wm-app-meta-label";
  rootLabel.textContent = "Root";
  const rootValue = document.createElement("code");
  rootValue.textContent = app.root;
  rootValue.title = app.root;
  rootRow.append(rootLabel, rootValue);
  meta.append(rootRow);

  const isWebApp = Boolean(app.webApp);
  const webAppRow = document.createElement("div");
  webAppRow.className = "wm-app-meta-row";
  const webAppLabel = document.createElement("span");
  webAppLabel.className = "wm-app-meta-label";
  webAppLabel.textContent = "Web app";
  const webAppValue = document.createElement("span");
  webAppValue.className = "wm-app-meta-value";
  webAppValue.textContent = isWebApp ? "Yes" : "No";
  webAppRow.append(webAppLabel, webAppValue);
  meta.append(webAppRow);

  if (isWebApp) {
    const portRow = document.createElement("div");
    portRow.className = "wm-app-meta-row";
    const portLabel = document.createElement("span");
    portLabel.className = "wm-app-meta-label";
    portLabel.textContent = "Port";
    const portValue = document.createElement("span");
    portValue.className = "wm-app-meta-value";
    if (typeof app.webAppPort === "number") {
      const code = document.createElement("code");
      code.textContent = String(app.webAppPort);
      portValue.append(code);
      const href =
        typeof app.webAppUrl === "string" && app.webAppUrl.length > 0
          ? app.webAppUrl
          : formatWebAppUrl(app.webAppPort);
      if (href) {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open";
        portValue.append(link);
      }
    } else {
      portValue.textContent = "Assigning…";
    }
    portRow.append(portLabel, portValue);
    meta.append(portRow);

    // Subdomain URL row (alias-based routing)
    if (app.subdomainUrl) {
      const subdomainRow = document.createElement("div");
      subdomainRow.className = "wm-app-meta-row";
      const subdomainLabel = document.createElement("span");
      subdomainLabel.className = "wm-app-meta-label";
      subdomainLabel.textContent = "Open App";
      const subdomainValue = document.createElement("span");
      subdomainValue.className = "wm-app-meta-value";
      const subdomainLink = document.createElement("a");
      subdomainLink.href = app.subdomainUrl;
      subdomainLink.target = "_blank";
      subdomainLink.rel = "noopener noreferrer";
      // For path-based URLs, show just the alias; for full URLs, show the URL
      const displayText = app.subdomainUrl.startsWith("/host/")
        ? app.subdomainAlias ?? app.subdomainUrl
        : app.subdomainUrl;
      subdomainLink.textContent = displayText;
      subdomainValue.append(subdomainLink);
      subdomainRow.append(subdomainLabel, subdomainValue);
      meta.append(subdomainRow);
    }
  }

  const windowRow = document.createElement("div");
  windowRow.className = "wm-app-meta-row";
  const windowValue = document.createElement("code");
  const windowName = app.tmuxWindow ?? app.tmuxSession ?? deriveAppWindowName(app.label ?? "", app.root ?? "");
  windowValue.textContent = windowName;
  windowValue.title = windowName;
  windowRow.append(windowValue);
  meta.append(windowRow);

  appendVariableUrlRow(meta, app.logs);
  appendVariablePubkeyRow(meta, app.logs);

  card.append(meta);

  if (app.notes) {
    const notes = document.createElement("p");
    notes.className = "wm-app-notes";
    notes.textContent = app.notes;
    card.append(notes);
  }

  const statusInfo = document.createElement("div");
  statusInfo.className = "wm-app-status-info";

  const lastAction = document.createElement("p");
  lastAction.textContent = `Last Action: ${
    app.status?.lastAction ? formatAppActionLabel(app.status.lastAction) : "—"
  }`;
  statusInfo.append(lastAction);

  const updatedLine = document.createElement("p");
  updatedLine.textContent = `Updated: ${formatAppTimestamp(app.status?.updatedAt ?? null)}`;
  statusInfo.append(updatedLine);

  const messageLine = document.createElement("p");
  messageLine.textContent = `Message: ${app.status?.message ?? "—"}`;
  statusInfo.append(messageLine);

  if (typeof app.status?.lastExitCode === "number") {
    const exitLine = document.createElement("p");
    exitLine.textContent = `Last Exit Code: ${app.status.lastExitCode}`;
    statusInfo.append(exitLine);
  }

  card.append(statusInfo);

  card.append(renderAppLogPreview(app.logs));

  const isCoreApp = app.id === "wingman-core";

  const controls = document.createElement("div");
  controls.className = "wm-app-actions";

  if (!isCoreApp && app.availableScripts?.start) {
    const startButton = document.createElement("button");
    startButton.type = "button";
    startButton.className = "wm-button";
    startButton.textContent = "Start";
    startButton.disabled = isAppActionDisabled(app, "start");
    startButton.addEventListener("click", async () => {
      if (startButton.disabled) return;
      startButton.disabled = true;
      const success = await triggerAppAction(app.id, "start");
      if (!success && startButton.isConnected) {
        startButton.disabled = false;
      }
    });
    controls.append(startButton);
  }

  if (!isCoreApp) {
    const stopButton = document.createElement("button");
    stopButton.type = "button";
    stopButton.className = "wm-button secondary";
    stopButton.textContent = "Stop";
    stopButton.disabled = isAppActionDisabled(app, "stop");
    stopButton.addEventListener("click", async () => {
      if (stopButton.disabled) return;
      stopButton.disabled = true;
      const success = await triggerAppAction(app.id, "stop");
      if (!success && stopButton.isConnected) {
        stopButton.disabled = false;
      }
    });
    controls.append(stopButton);
  }

  const restartButton = document.createElement("button");
  restartButton.type = "button";
  restartButton.className = "wm-button";
  restartButton.textContent = "Restart";
  restartButton.disabled = isAppActionDisabled(app, "restart");
  restartButton.addEventListener("click", async () => {
    if (restartButton.disabled) return;
    restartButton.disabled = true;
    const success = await triggerAppAction(app.id, "restart");
    if (!success && restartButton.isConnected) {
      restartButton.disabled = false;
    }
  });
  controls.append(restartButton);

  if (!isCoreApp && app.availableScripts?.setup) {
    const setupButton = document.createElement("button");
    setupButton.type = "button";
    setupButton.className = "wm-button secondary";
    setupButton.textContent = "Setup";
    setupButton.disabled = isAppActionDisabled(app, "setup");
    setupButton.addEventListener("click", async () => {
      if (setupButton.disabled) return;
      setupButton.disabled = true;
      const success = await triggerAppAction(app.id, "setup");
      if (!success && setupButton.isConnected) {
        setupButton.disabled = false;
      }
    });
    controls.append(setupButton);
  }

  const editWithAiButton = document.createElement("button");
  editWithAiButton.type = "button";
  editWithAiButton.className = "wm-button secondary";
  editWithAiButton.textContent = "Edit with AI";
  editWithAiButton.addEventListener("click", async () => {
    if (editWithAiButton.disabled) return;
    if (!state.identity.authenticated) {
      openIdentityLoginDialog();
      return;
    }
    const workingDirectory = typeof app.root === "string" ? app.root : "";
    if (!workingDirectory) {
      window.alert("App root directory is unavailable for this app.");
      return;
    }
    const agentId = state.config?.defaultAgent ?? "claude";
    const configuredAgents = Array.isArray(state.config?.agents) ? state.config.agents : null;
    if (configuredAgents && !configuredAgents.some((agent) => agent && typeof agent.id === "string" && agent.id === agentId)) {
      window.alert(`${agentId} agent is not available. Update your configuration and try again.`);
      return;
    }
    const appName =
      typeof app.label === "string" && app.label.trim().length > 0 ? app.label.trim() : String(app.id ?? "app");
    const sessionName = `editing ${appName}`;
    const origin = buildSessionOrigin({
      type: "app",
      id: app.id ?? "",
      url: app.id !== undefined && app.id !== null ? `/apps/${app.id}` : undefined,
      label: app.label,
    });
    const originalLabel = editWithAiButton.textContent;
    editWithAiButton.disabled = true;
    editWithAiButton.textContent = "Launching…";
    try {
      await launchSession(agentId, workingDirectory, sessionName, undefined, { openInNewTab: true, origin });
    } finally {
      if (editWithAiButton.isConnected) {
        editWithAiButton.disabled = false;
        editWithAiButton.textContent = originalLabel ?? "Edit with AI";
      }
    }
  });
  controls.append(editWithAiButton);

  // Fix with AI button - fetches logs and launches Claude with them pre-filled
  const fixWithAiButton = document.createElement("button");
  fixWithAiButton.type = "button";
  fixWithAiButton.className = "wm-button secondary";
  fixWithAiButton.textContent = "Fix with AI";
  fixWithAiButton.addEventListener("click", async () => {
    if (fixWithAiButton.disabled) return;
    if (!state.identity.authenticated) {
      openIdentityLoginDialog();
      return;
    }
    const workingDirectory = typeof app.root === "string" ? app.root : "";
    if (!workingDirectory) {
      window.alert("App root directory is unavailable for this app.");
      return;
    }
    const agentId = state.config?.defaultAgent ?? "claude";
    const configuredAgents = Array.isArray(state.config?.agents) ? state.config.agents : null;
    if (configuredAgents && !configuredAgents.some((agent) => agent && typeof agent.id === "string" && agent.id === agentId)) {
      window.alert(`${agentId} agent is not available. Update your configuration and try again.`);
      return;
    }

    const originalLabel = fixWithAiButton.textContent;
    fixWithAiButton.disabled = true;
    fixWithAiButton.textContent = "Loading logs…";

    try {
      // Fetch the app's recent logs
      const logsResponse = await fetchAppLogsApi(app.id, 100);
      const logs = logsResponse?.logs ?? [];

      // Build log file paths
      const logFilePaths = [];
      if (app.logsDir && app.pm2Name) {
        logFilePaths.push(`${app.logsDir}/${app.pm2Name}-out.log`);
        logFilePaths.push(`${app.logsDir}/${app.pm2Name}-error.log`);
      }

      // Build the initial prompt
      const appName =
        typeof app.label === "string" && app.label.trim().length > 0 ? app.label.trim() : String(app.id ?? "app");
      const sessionName = `fixing ${appName}`;

      let initialPrompt = `Please review these logs and the full log file if needed. I would like assistance debugging this issue and approaches to fix. Please ask questions if you need more context.\n\n`;

      if (logs.length > 0) {
        initialPrompt += `## Recent Logs (tail)\n\`\`\`\n${logs.join("\n")}\n\`\`\`\n\n`;
      } else {
        initialPrompt += `## Recent Logs\nNo recent logs available.\n\n`;
      }

      if (logFilePaths.length > 0) {
        initialPrompt += `## Full Log Files\n${logFilePaths.map((p) => `- ${p}`).join("\n")}\n`;
      }

      const origin = buildSessionOrigin({
        type: "app",
        id: app.id ?? "",
        url: app.id !== undefined && app.id !== null ? `/apps/${app.id}` : undefined,
        label: app.label,
      });

      fixWithAiButton.textContent = "Launching…";
      await launchSession(agentId, workingDirectory, sessionName, undefined, {
        openInNewTab: true,
        origin,
        initialPrompt,
      });
    } catch (error) {
      console.error("Fix with AI failed:", error);
      window.alert("Failed to launch Fix with AI. Check console for details.");
    } finally {
      if (fixWithAiButton.isConnected) {
        fixWithAiButton.disabled = false;
        fixWithAiButton.textContent = originalLabel ?? "Fix with AI";
      }
    }
  });
  controls.append(fixWithAiButton);

  // Deploy button (web apps only)
  if (isWebApp) {
    const deployButton = document.createElement("button");
    deployButton.type = "button";
    deployButton.className = "wm-button secondary";
    deployButton.textContent = "Deploy";
    deployButton.addEventListener("click", () => {
      openDeployDialog(app.id);
    });
    controls.append(deployButton);
  }

  card.append(controls);

  const linkBar = document.createElement("div");
  linkBar.className = "wm-app-links";

  const viewLogsLink = document.createElement("a");
  viewLogsLink.href = "#";
  viewLogsLink.textContent = "View logs";
  viewLogsLink.addEventListener("click", (event) => {
    event.preventDefault();
    void openAppLogsDialog(app.id);
  });
  linkBar.append(viewLogsLink);

  const editLink = document.createElement("a");
  editLink.href = "#";
  editLink.textContent = "Edit";
  editLink.addEventListener("click", (event) => {
    event.preventDefault();
    openAppDialog(app.id);
  });
  linkBar.append(editLink);

  const removeLink = document.createElement("a");
  removeLink.href = "#";
  removeLink.textContent = "Remove";
  removeLink.addEventListener("click", (event) => {
    event.preventDefault();
    removeApp(app.id);
  });
  linkBar.append(removeLink);

  card.append(linkBar);

  return card;
};

const renderApps = () => {
  const wrapper = document.createElement("div");
  wrapper.className = "wm-apps";

  const schedulePendingAppDialog = () => {
    if (appsStore().pendingOpenDialog === "create") {
      appsStore().pendingOpenDialog = null;
      requestAnimationFrame(() => {
        openAppDialog();
      });
    }
  };

  const header = document.createElement("div");
  header.className = "wm-apps-header";

  const title = document.createElement("h2");
  title.textContent = "Apps";
  header.append(title);

  const headerActions = document.createElement("div");
  headerActions.className = "wm-apps-header-actions";

  if (state.identity.isAdmin) {
    const ownerFilterOptions = buildAppFilterOptions();
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
        const as = appsStore();
        as.filters.npub = value;
        as.filters.initialized = true;
        void fetchApps({ tail: APP_LOG_PREVIEW_LINES }).then(() => {
          if (currentRoute === "apps") {
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

  // Split layout: sidebar + main content
  const splitContainer = document.createElement("div");
  splitContainer.className = "wm-apps-split";

  // Create sidebar with workspace tree
  const sidebar = createWorkspaceTreeSidebar();
  if (sidebar) {
    splitContainer.append(sidebar);
  }

  // Main content area
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

  const apps = Array.isArray(appsStore().items) ? appsStore().items : [];
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

  const focusPendingAppCard = () => {
    if (!appsStore().pendingFocusId) {
      return;
    }
    const targetId = appsStore().pendingFocusId;
    appsStore().pendingFocusId = null;
    requestAnimationFrame(() => {
      const escape = typeof CSS?.escape === "function" ? CSS.escape : (value) => value.replace(/"/g, '\\"');
      const selector = `[data-app-id=\"${escape(targetId)}\"]`;
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
  };

  focusPendingAppCard();

  schedulePendingAppDialog();

  return wrapper;
};

const renderProjects = () => {
  if (!projectsFeatureEnabledForViewer()) {
    const container = document.createElement("div");
    container.className = "wm-projects-page";
    return container;
  }
  if (!state.identity.authenticated) {
    const guestContainer = document.createElement("div");
    guestContainer.className = "wm-projects-page";
    const guestCard = document.createElement("section");
    guestCard.className = "wm-card wm-project-card";
    const guestMessage = document.createElement("p");
    guestMessage.textContent = "Sign in to manage projects.";
    guestCard.append(guestMessage);
    guestContainer.append(guestCard);
    return guestContainer;
  }
  // void ensureAppsLoaded(); // DISABLED
  if (projectFeature) {
    void projectFeature.ensureLoaded();
    return projectFeature.renderPage();
  }
  const container = document.createElement("div");
  container.className = "wm-projects-page";
  return container;
};



let renderDebounceTimer = null;
let isRendering = false;
let previousRenderRoute = null;

// ===========================================================================

const render = () => {
  // Prevent concurrent renders
  if (isRendering) {
    return;
  }
  
  // Clear any pending render and set a new one
  if (renderDebounceTimer) {
    clearTimeout(renderDebounceTimer);
  }
  
  renderDebounceTimer = setTimeout(() => {
    isRendering = true;
    try {
      // Manage SSE connections based on route changes
      const routeChanged = previousRenderRoute !== currentRoute;
      if (routeChanged) {
        // Leaving live view - disconnect all SSE
        if (previousRenderRoute === "live" && currentRoute !== "live") {
          sseManager.disconnectAll();
        }
        // Entering live view - connect to active session
        if (currentRoute === "live" && sessionsStore().activeSessionId) {
          sseManager.connect(sessionsStore().activeSessionId);
        }
        previousRenderRoute = currentRoute;
      }

      const projectsEnabled = syncProjectsNavigationVisibility();
      if (!projectsEnabled && currentRoute === "projects") {
        currentRoute = "home";
        if (window.location.pathname === PROJECTS_ROUTE) {
          window.history.replaceState({ route: "home" }, "", HOME_ROUTE);
        }
      }
      const nightwatchEnabled = syncNightWatchNavigationVisibility();
      if (!nightwatchEnabled && currentRoute === "nightwatch") {
        currentRoute = "home";
        if (window.location.pathname === NIGHTWATCH_ROUTE) {
          window.history.replaceState({ route: "home" }, "", HOME_ROUTE);
        }
      }
      const focusSnapshot = captureFocusSnapshot();
      appRoot.innerHTML = "";
      let view;
      if (currentRoute === "live") {
        view = renderLive();
      } else if (currentRoute === "apps") {
        view = renderApps();
      } else if (currentRoute === "projects") {
        view = renderProjects();
      } else if (currentRoute === "nightwatch") {
        view = renderNightWatchPage();
      } else if (currentRoute === "scheduler") {
        view = renderSchedulerPage();
      } else if (currentRoute === "files") {
        view = renderFiles();
      } else if (currentRoute === "settings") {
        view = renderSettings();
      } else if (currentRoute === "chat") {
        view = renderChat();
      } else if (currentRoute === "privacy") {
        view = renderPrivacyPolicy();
      } else {
        view = renderHome();
      }
      appRoot.append(view);
      renderFileEditorOverlay();
      renderWorktreeModal();
      appRoot.dataset.route = currentRoute;
      restoreFocusFromSnapshot(focusSnapshot);
      // If on live route and no element was focused, focus the composer textarea
      if (currentRoute === "live" && (!document.activeElement || document.activeElement === document.body)) {
        const textarea = document.querySelector('.wm-composer textarea');
        if (textarea) {
          textarea.focus({ preventScroll: true });
        }
      }
      setActiveNav();
      syncMenuTabs();
      syncDesktopSessionIndicator();
      // Hide header webview/writer toggles when not on live route (renderLive handles showing them)
      if (currentRoute !== "live") {
        syncHeaderWebviewToggle(null);
        syncHeaderWriterToggle(null);
      }
      updateAgentStatusIndicators();
      updateDocumentTitle();
    } finally {
      isRendering = false;
      renderDebounceTimer = null;
    }
  }, 50); // 50ms debounce to prevent rapid re-renders
};

projectFeature = createProjectFeature({
  onRenderRequested: () => {
    if (currentRoute === "projects") {
      render();
    }
    syncProjectDialogState();
  },
  onCreateRequested: () => {
    openProjectDialog();
  },
  onProjectAppRequested: (project) => {
    openProjectAppCreation(project);
  },
  resolveApp: (entry) => resolveProjectAppEntry(entry),
  openAppDetails: (app) => {
    if (!app) return;
    openProjectAppDetails(app.id ?? app);
  },
  triggerAppAction: (appId, action) => triggerProjectAppAction(appId, action),
  isActionDisabled: (app, action) => isProjectActionDisabled(app, action),
});
state.projects = projectFeature.state;

const queueModule = initQueueModule({
  state,
  sessionsStore,
  showToast,
  updateAgentStatusIndicators: (...args) => updateAgentStatusIndicators(...args),
  updateConversationDOM: (...args) => updateConversationDOM(...args),
  scrollConversationAreaToBottom,
});
getSessionById = queueModule.getSessionById;
isSessionActive = queueModule.isSessionActive;
getActiveSessions = queueModule.getActiveSessions;
isSessionBusy = queueModule.isSessionBusy;
isStatusRecordBusy = queueModule.isStatusRecordBusy;
getSessionQueue = queueModule.getSessionQueue;
getQueueCount = queueModule.getQueueCount;
isQueueFull = queueModule.isQueueFull;
addToPromptQueue = queueModule.addToPromptQueue;
removeFromPromptQueue = queueModule.removeFromPromptQueue;
updatePromptInQueue = queueModule.updatePromptInQueue;
fetchSessionQueue = queueModule.fetchSessionQueue;
sendNextQueuedPrompt = queueModule.sendNextQueuedPrompt;
openPromptQueueModal = queueModule.openPromptQueueModal;
closePromptQueueModal = queueModule.closePromptQueueModal;

initQuickLauncher({ state, launchSession, showToast });

const imageAttachmentsModule = initImageAttachments({ state, getSessionById });
insertTextAtCursor = imageAttachmentsModule.insertTextAtCursor;
clearImagePreviews = imageAttachmentsModule.clearImagePreviews;
extractImageFiles = imageAttachmentsModule.extractImageFiles;
extractAttachmentFiles = imageAttachmentsModule.extractAttachmentFiles;
handleImageUploads = imageAttachmentsModule.handleImageUploads;
handleAttachmentUploads = imageAttachmentsModule.handleAttachmentUploads;
cleanupOrphanedMarkers = imageAttachmentsModule.cleanupOrphanedMarkers;

const agentIndicatorsModule = initAgentIndicators({
  state,
  sessionsStore,
  getCurrentRoute: () => currentRoute,
  getQueueCount,
  isSessionBusy,
  openPromptQueueModal,
});
resolveAgentRuntimeStatus = agentIndicatorsModule.resolveAgentRuntimeStatus;
createAgentStatusIndicator = agentIndicatorsModule.createAgentStatusIndicator;
updateAgentStatusIndicators = agentIndicatorsModule.updateAgentStatusIndicators;
updateKnightRiderState = agentIndicatorsModule.updateKnightRiderState;
updateConversationDOM = agentIndicatorsModule.updateConversationDOM;
updateLogsDOM = agentIndicatorsModule.updateLogsDOM;

const adminUsersModule = initAdminUsersApi({
  state,
  getCurrentRoute: () => currentRoute,
  render,
  normaliseNpubValue,
  isFiniteNumber,
  formatSatoshis,
  ADMIN_PICTURE_CACHE_TTL_MS,
});
getAdminUserKey = adminUsersModule.getAdminUserKey;
ensureAdminSelectionState = adminUsersModule.ensureAdminSelectionState;
setAdminUserSelected = adminUsersModule.setAdminUserSelected;
clearAdminSelection = adminUsersModule.clearAdminSelection;
getAdminSelectedUsers = adminUsersModule.getAdminSelectedUsers;
getAdminSelectionCount = adminUsersModule.getAdminSelectionCount;
fetchAdminUsers = adminUsersModule.fetchAdminUsers;
replaceAdminUsersList = adminUsersModule.replaceAdminUsersList;
toggleUserOnboarding = adminUsersModule.toggleUserOnboarding;
deleteAdminUser = adminUsersModule.deleteAdminUser;
deleteSelectedAdminUsers = adminUsersModule.deleteSelectedAdminUsers;
updateAdminUserNickname = adminUsersModule.updateAdminUserNickname;
primeAdminUserPictures = adminUsersModule.primeAdminUserPictures;
ensureAdminBalanceToolState = adminUsersModule.ensureAdminBalanceToolState;
submitAdminBalanceUpdate = adminUsersModule.submitAdminBalanceUpdate;
ensureAdminPortsToolState = adminUsersModule.ensureAdminPortsToolState;
submitAdminPortsAssignment = adminUsersModule.submitAdminPortsAssignment;
generateAdminPorts = adminUsersModule.generateAdminPorts;

const adminUsersPanelsModule = initAdminUsersPanels({
  state,
  getCurrentRoute: () => currentRoute,
  render,
  createCollapsibleCard,
  abbreviateNpub,
  normaliseNpubValue,
  matchesAdminUserFilter,
  ensureAdminBalanceToolState,
  submitAdminBalanceUpdate,
  ensureAdminPortsToolState,
  submitAdminPortsAssignment,
  ensureAdminSelectionState,
  getAdminUserKey,
  setAdminUserSelected,
  clearAdminSelection,
  fetchAdminUsers,
  toggleUserOnboarding,
  deleteAdminUser,
  deleteSelectedAdminUsers,
  updateAdminUserNickname,
});
renderAdminUsersPanel = adminUsersPanelsModule.renderAdminUsersPanel;

const privacyPolicyModule = initPrivacyPolicy({
  HOME_ROUTE,
  setCurrentRoute: (r) => { currentRoute = r; },
  render,
});
renderPrivacyPolicy = privacyPolicyModule.renderPrivacyPolicy;

const settingsViewModule = initSettingsView({
  state,
  appsStore,
  getCurrentRoute: () => currentRoute,
  render,
  normalisePortList,
  generateAdminPorts: (...args) => generateAdminPorts(...args),
  renderIdentityPanel: (...args) => renderIdentityPanel(...args),
  renderFeatureFlagsPanel: (...args) => renderFeatureFlagsPanel(...args),
  ensureFeatureFlagsLoaded: (...args) => ensureFeatureFlagsLoaded(...args),
  renderAdminUsersPanel: (...args) => renderAdminUsersPanel(...args),
  fetchAdminUsers: (...args) => fetchAdminUsers(...args),
  renderWingmanCard: (...args) => renderWingmanCard(...args),
  npubProjectsState,
  fetchNpubProjects,
  renderNpubProjectsPanel,
});
renderSettings = settingsViewModule.renderSettings;

const homeViewModule = initHomeView({
  state,
  sessionsStore,
  appsStore,
  getCurrentRoute: () => currentRoute,
  setCurrentRoute: (r) => { currentRoute = r; },
  render,
  openIdentityLoginDialog,
  navigateToApps,
  navigateToChat: (...args) => navigateToChat(...args),
  openDialog,
  openOrchestratorDialog: (...args) => openOrchestratorDialog(...args),
  renderOrchestratorPresetButtons: (...args) => renderOrchestratorPresetButtons(...args),
  ensureOrchestratorPresetsLoaded: (...args) => ensureOrchestratorPresetsLoaded(...args),
  orchestratorFeatureEnabledForViewer: (...args) => orchestratorFeatureEnabledForViewer(...args),
  ensureFeatureFlagsLoaded: (...args) => ensureFeatureFlagsLoaded(...args),
  isFeatureEnabledForViewer: (...args) => isFeatureEnabledForViewer(...args),
  isSessionActive,
  resumeSession,
  stopSession,
  deleteSession,
  promptRenameSession,
  getSessionDisplayName,
  createAgentStatusIndicator,
  buildSessionFilterOptions,
  fetchSessions,
  syncMenuTabs,
  isAppActionDisabled,
  triggerAppAction,
  escapeHtml,
  APP_STATUS_LABELS,
  APP_ACTION_LABELS,
  PRIVACY_ROUTE,
  LIVE_ROUTE_PREFIX,
});
renderHome = homeViewModule.renderHome;

const dirBrowserModule = initDirectoryBrowser({
  state,
  directoryInput,
  directorySuggestions,
  directoryDialog,
  directoryTitle,
  directoryList,
  directoryCurrent,
  directoryUpButton,
  directoryNewFolderButton,
  directoryUseButton,
  browseDirectoryButton,
  fileTransferDialog,
  fileTransferTitle,
  fileTransferSource,
  fileTransferCurrent,
  fileTransferList,
  fileTransferSelected,
  fileTransferNameInput,
  fileTransferNameFeedback,
  fileTransferUpButton,
  fileTransferNewFolderButton,
  fileTransferConfirmButton,
  fileTransferCancelButton,
  createDirectoryEntry,
  moveFilesEntry,
  copyFilesEntry,
  resetFilesPreview,
  loadFilesTree,
  fetchConfig: (...args) => fetchConfig(...args),
  getSessionDialogController: () => sessionDialogController,
});
scheduleDirectorySuggestions = dirBrowserModule.scheduleDirectorySuggestions;
openDirectoryBrowser = dirBrowserModule.openDirectoryBrowser;
openFileTransferDialogForMode = dirBrowserModule.openFileTransferDialogForMode;

const filesViewModule = initFilesView({
  state,
  getCurrentRoute: () => currentRoute,
  render,
  loadFilesTree,
  loadFilesPreview,
  resetFilesPreview,
  showFilesPreviewUnavailable,
  createFilesDirectory,
  createFilesTextFile,
  uploadFilesBinary,
  deleteFilesEntry,
  openFileEditor: (...args) => openFileEditor(...args),
  canCreateWorktree: (...args) => canCreateWorktree(...args),
  openWorktreeModal: (...args) => openWorktreeModal(...args),
  openFileTransferDialogForMode,
  moveFilesEntry,
  launchSession: (...args) => launchSession(...args),
  getConfig: () => state.config,
  showToast,
  initFilesFromUrl: () => {
    const parsed = parseFilesPathFromUrl();
    if (parsed.slug) {
      void navigateToFilesSlug(parsed.slug);
    } else {
      void loadFilesTree();
    }
  },
});
renderFiles = filesViewModule.renderFiles;

const liveViewModule = initLiveView({
  sessionsStore,
  appsStore,
  getCurrentRoute: () => currentRoute,
  setCurrentRoute: (r) => { currentRoute = r; },
  getTabsVisible: () => tabsVisible,
  appRoot,
  render,
  getActiveSessions,
  getSessionQueue,
  setActiveSession,
  stopSession,
  fetchLogs,
  fetchConversation,
  sendMessage,
  getSessionIdFromPath,
  ensureActiveSession,
  promptRenameSession,
  sendControlCommand,
  syncHeaderWebviewToggle,
  syncHeaderWriterToggle,
  scheduleLiveScroll,
  isConversationScrolledToBottom,
  scrollConversationAreaToBottom,
  createAgentStatusIndicator,
  resolveAgentRuntimeStatus,
  extractImageFiles,
  extractAttachmentFiles,
  handleImageUploads,
  handleAttachmentUploads,
  cleanupOrphanedMarkers,
  clearImagePreviews,
  openDialog,
  isFeatureEnabledForViewer: (...args) => isFeatureEnabledForViewer(...args),
  showToast,
});
renderLive = liveViewModule.renderLive;
renderSessionTabs = liveViewModule.renderSessionTabs;
renderTabs = liveViewModule.renderTabs;
updateLivePanelsForSession = liveViewModule.updateLivePanelsForSession;
captureFocusSnapshot = liveViewModule.captureFocusSnapshot;
restoreFocusFromSnapshot = liveViewModule.restoreFocusFromSnapshot;

const fileEditorModule = initFileEditor({
  state,
  render,
  loadFilesTree,
  applyAceTheme,
  appRoot,
  loadAceEditor,
});
canCreateWorktree = fileEditorModule.canCreateWorktree;
openWorktreeModal = fileEditorModule.openWorktreeModal;
closeWorktreeModal = fileEditorModule.closeWorktreeModal;
openFileEditor = fileEditorModule.openFileEditor;
closeFileEditor = fileEditorModule.closeFileEditor;
getFileEditorDisplayTitle = fileEditorModule.getFileEditorDisplayTitle;
resetFileEditorState = fileEditorModule.resetFileEditorState;
renderFileEditorOverlay = fileEditorModule.renderFileEditorOverlay;
renderWorktreeModal = fileEditorModule.renderWorktreeModal;
destroyAceEditor = fileEditorModule.destroyAceEditor;
ensureAceEditorMounted = fileEditorModule.ensureAceEditorMounted;
requestFileEditorClose = fileEditorModule.requestFileEditorClose;
getAceEditorInstance = fileEditorModule.getAceEditorInstance;

// Identity DOM module (pure helpers + shared data structures)
const identityDomModule = initIdentityDom({ state, requestAuthUiSync });
identityDomEntryByNode = identityDomModule.identityDomEntryByNode;
IDENTITY_EVENT_NAMES = identityDomModule.IDENTITY_EVENT_NAMES;

// Identity state manager (handlers, event bridges, persistence)
const identityStateModule = initIdentityStateManager({
  state,
  dom: identityDomModule,
  sessionsStore,
  appsStore,
  render,
  fetchSessions,
  fetchApps,
  fetchConfig: (...args) => fetchConfig(...args),
  normalisePortList,
  closeIdentityLoginDialog,
  navigateToHome,
  getCurrentRoute: () => currentRoute,
  setCurrentRoute: (r) => { currentRoute = r; },
  HOME_ROUTE,
  APP_LOG_PREVIEW_LINES,
});
updateIdentityState = identityStateModule.updateIdentityState;
handleIdentityCopy = identityStateModule.handleIdentityCopy;
handleIdentityLogout = identityStateModule.handleIdentityLogout;
handleUnauthorizedAccess = identityStateModule.handleUnauthorizedAccess;
forceIdentityLogoutState = identityStateModule.forceIdentityLogoutState;
registerIdentityDom = identityStateModule.registerIdentityDom;
bindIdentityFlows = identityStateModule.bindIdentityFlows;
getIdentityWiringContext = identityStateModule.getIdentityWiringContext;

const identityPanelsModule = initIdentityPanels({
  state,
  registerIdentityDom,
  bindIdentityFlows,
  navigateToSettings: (...args) => navigateToSettings(...args),
  IDENTITY_EVENT_NAMES,
});
renderIdentityPanel = identityPanelsModule.renderIdentityPanel;
renderIdentitySummary = identityPanelsModule.renderIdentitySummary;
renderMenuIdentitySection = identityPanelsModule.renderMenuIdentitySection;

const privateChatModule = initPrivateChat({
  state,
  getCurrentRoute: () => currentRoute,
  setCurrentRoute: (r) => { currentRoute = r; },
  render,
  showToast,
});
loadChats = privateChatModule.loadChats;
loadChatMessages = privateChatModule.loadChatMessages;
navigateToChat = privateChatModule.navigateToChat;
openPrivateChatDialog = privateChatModule.openPrivateChatDialog;
deleteChat = privateChatModule.deleteChat;
renderChat = privateChatModule.renderChat;

const appDialogs = initAppDialogs({
  state,
  getCurrentRoute: () => currentRoute,
  render,
  refreshApps,
  getAppById,
  openDirectoryBrowser,
  formatWebAppUrl,
  linkAppToProject,
  deriveAppWindowName,
  sharedTmuxSession: SHARED_TMUX_SESSION,
  showToast,
});

openAppDialog = appDialogs.openAppDialog;
closeAppDialog = appDialogs.closeAppDialog;
openAppLogsDialog = appDialogs.openAppLogsDialog;
refreshAppLogs = appDialogs.refreshAppLogs;
resetAppDialog = appDialogs.resetAppDialog;
openDeployDialog = appDialogs.openDeployDialog;

const workspaceTree = initWorkspaceTree({
  state,
  refreshApps,
  showToast,
});

createWorkspaceTreeSidebar = workspaceTree.createSidebar;

const orchestratorUI = initOrchestratorUI({
  state,
  getCurrentRoute: () => currentRoute,
  setCurrentRoute: (route) => {
    currentRoute = route;
  },
  render,
  handleSessionStart,
});

renderOrchestratorPresetButtons = orchestratorUI.renderPresetButtons;
ensureOrchestratorPresetsLoaded = orchestratorUI.ensurePresetsLoaded;
refreshOrchestratorPresets = orchestratorUI.refreshPresets;
openOrchestratorDialog = orchestratorUI.openDialog;
syncOrchestratorAgents = orchestratorUI.syncAgents;

const featureFlagsUI = initFeatureFlagsUI({
  state,
  render,
  showToast,
  abbreviateNpub,
});
ensureFeatureFlagsLoaded = featureFlagsUI.ensureLoaded;
renderFeatureFlagsPanel = featureFlagsUI.renderPanel;
syncFeatureFlagsFromConfig = featureFlagsUI.syncFromConfig;
resolveFeatureFlagForViewer = featureFlagsUI.resolveFlag;
isFeatureEnabledForViewer = featureFlagsUI.isEnabled;
orchestratorFeatureEnabledForViewer = featureFlagsUI.orchestratorEnabled;
projectsFeatureEnabledForViewer = featureFlagsUI.projectsEnabled;

const nightWatchUI = initNightWatchSettingsPanel({ state, render, showToast, createCollapsibleCard });
renderNightWatchSettingsPanel = nightWatchUI.renderPanel;
ensureNightWatchLoaded = nightWatchUI.ensureLoaded;

const nightWatchPageUI = initNightWatchPage({ state, showToast });
renderNightWatchPage = nightWatchPageUI.renderPage;
ensureNightWatchPageLoaded = nightWatchPageUI.ensureLoaded;

const schedulerPageUI = initSchedulerPage({ showToast });
renderSchedulerPage = schedulerPageUI.renderPage;
ensureSchedulerPageLoaded = schedulerPageUI.ensureLoaded;

renderMenuIdentitySection();

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

function navigateToHome({ replaceHistory = false, skipMenuClose = false } = {}) {
  if (!skipMenuClose) {
    closeMenu();
  }
  closeIdentityLoginDialog();
  stopConversationPolling();
  currentRoute = "home";
  lastLoggedSessionId = null;
  if (replaceHistory) {
    window.history.replaceState({ route: "home" }, "", HOME_ROUTE);
  } else if (window.location.pathname !== HOME_ROUTE) {
    window.history.pushState({ route: "home" }, "", HOME_ROUTE);
  }
  render();
}

function navigateToApps({ openNewAppDialog = false, skipMenuClose = false, focusAppId = null } = {}) {
  if (!state.identity.authenticated) {
    openIdentityLoginDialog();
    return;
  }
  if (!skipMenuClose) {
    closeMenu();
  }
  stopConversationPolling();
  if (openNewAppDialog) {
    appsStore().pendingOpenDialog = "create";
  }
  if (focusAppId) {
    appsStore().pendingFocusId = focusAppId;
  }
  currentRoute = "apps";
  lastLoggedSessionId = null;
  if (window.location.pathname !== APPS_ROUTE) {
    window.history.pushState({ route: "apps" }, "", APPS_ROUTE);
  }
  // void ensureAppsLoaded(); // DISABLED
  render();
}

function navigateToProjects({ skipMenuClose = false } = {}) {
  if (!state.identity.authenticated) {
    openIdentityLoginDialog();
    return;
  }
  if (!projectsFeatureEnabledForViewer()) {
    showToast?.("Projects are disabled right now", { variant: "info" });
    return;
  }
  if (!skipMenuClose) {
    closeMenu();
  }
  closeIdentityLoginDialog();
  stopConversationPolling();
  currentRoute = "projects";
  lastLoggedSessionId = null;
  if (window.location.pathname !== PROJECTS_ROUTE) {
    window.history.pushState({ route: "projects" }, "", PROJECTS_ROUTE);
  }
  if (projectFeature) {
    void projectFeature.ensureLoaded();
  }
  render();
}

function navigateToNightWatch({ skipMenuClose = false } = {}) {
  if (!state.identity.authenticated) {
    openIdentityLoginDialog();
    return;
  }
  if (!state.identity.isAdmin) {
    showToast?.("Night Watchman is admin-only", { variant: "info" });
    return;
  }
  if (!isFeatureEnabledForViewer("nightwatch_enabled")) {
    showToast?.("Night Watchman is disabled", { variant: "info" });
    return;
  }
  if (!skipMenuClose) {
    closeMenu();
  }
  closeIdentityLoginDialog();
  stopConversationPolling();
  currentRoute = "nightwatch";
  lastLoggedSessionId = null;
  if (window.location.pathname !== NIGHTWATCH_ROUTE) {
    window.history.pushState({ route: "nightwatch" }, "", NIGHTWATCH_ROUTE);
  }
  void ensureNightWatchPageLoaded();
  render();
}

function navigateToScheduler({ skipMenuClose = false } = {}) {
  if (!state.identity.authenticated) {
    openIdentityLoginDialog();
    return;
  }
  if (!state.identity.isAdmin) {
    showToast?.("Triggers is admin-only", { variant: "info" });
    return;
  }
  if (!skipMenuClose) {
    closeMenu();
  }
  closeIdentityLoginDialog();
  stopConversationPolling();
  currentRoute = "scheduler";
  lastLoggedSessionId = null;
  if (window.location.pathname !== TRIGGERS_ROUTE && window.location.pathname !== SCHEDULER_ROUTE) {
    window.history.pushState({ route: "scheduler" }, "", TRIGGERS_ROUTE);
  }
  void ensureSchedulerPageLoaded();
  render();
}

function navigateToSettings({ skipMenuClose = false } = {}) {
  if (!skipMenuClose) {
    closeMenu();
  }
  closeIdentityLoginDialog();
  stopConversationPolling();
  currentRoute = "settings";
  lastLoggedSessionId = null;
  if (window.location.pathname !== SETTINGS_ROUTE) {
    window.history.pushState({ route: "settings" }, "", SETTINGS_ROUTE);
  }
  render();
}

navLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const targetRoute = link.dataset.route;
    if (!targetRoute || targetRoute === currentRoute) return;
    if (!state.identity.authenticated) {
      openIdentityLoginDialog();
      return;
    }
    closeMenu();
    if (targetRoute === "live") {
      currentRoute = "live";
      const ss = sessionsStore();
      const navSessions = ss.items;
      const navActiveId = ss.activeSessionId;
      const navLastId = ss.lastActiveSessionId;
      const hasActive = navActiveId && navSessions.some((session) => session.id === navActiveId);
      const hasLast = navLastId && navSessions.some((session) => session.id === navLastId);
      const targetSessionId = hasActive ? navActiveId : hasLast ? navLastId : null;
      if (targetSessionId) {
        setActiveSession(targetSessionId, { updateHistory: true, forceLog: true });
      } else {
        setActiveSession(null, { updateHistory: true });
      }
    } else if (targetRoute === "apps") {
      navigateToApps({ skipMenuClose: true });
      return;
    } else if (targetRoute === "projects") {
      navigateToProjects({ skipMenuClose: true });
      return;
    } else if (targetRoute === "nightwatch") {
      navigateToNightWatch({ skipMenuClose: true });
      return;
    } else if (targetRoute === "scheduler") {
      navigateToScheduler({ skipMenuClose: true });
      return;
    } else if (targetRoute === "files") {
      // If navigating from live page with an active session, start in that session's directory
      const activeSession = currentRoute === "live" ? getActiveSessionForIndicator() : null;
      const sessionDir = activeSession?.workingDirectory;
      stopConversationPolling();
      currentRoute = "files";
      lastLoggedSessionId = null;
      if (!state.files.initialized) {
        state.files.initialized = true;
        void loadFilesTree(sessionDir);
      } else if (sessionDir) {
        // Already initialized but coming from live with a session directory - navigate there
        void loadFilesTree(sessionDir);
      } else {
        // Already initialized — sync URL to current state
        updateFilesUrl({ replace: true });
      }
    } else if (targetRoute === "settings") {
      navigateToSettings({ skipMenuClose: true });
      return;
    } else {
      navigateToHome({ skipMenuClose: true });
      return;
    }
    render();
  });
});

// Handle menu footer links (privacy policy, etc.)
const menuFooterLinks = Array.from(document.querySelectorAll(".wm-menu-footer a[data-route]"));
menuFooterLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const targetRoute = link.dataset.route;
    if (!targetRoute || targetRoute === currentRoute) return;
    closeMenu();
    if (targetRoute === "privacy") {
      currentRoute = "privacy";
      if (window.location.pathname !== PRIVACY_ROUTE) {
        window.history.pushState({ route: "privacy" }, "", PRIVACY_ROUTE);
      }
      render();
    }
  });
});

if (typeof window !== "undefined") {
  window.navigateToProjects = navigateToProjects;
}

menuToggle?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (!state.identity.authenticated) {
    openIdentityLoginDialog();
    return;
  }
  toggleMenu();
});

desktopSessionIndicatorButton?.addEventListener("click", (event) => {
  event.preventDefault();
  if (!state.identity.authenticated) {
    openIdentityLoginDialog();
    return;
  }
  const session = getActiveSessionForIndicator();
  if (!session) return;
  closeMenu();
  if (currentRoute !== "live") {
    currentRoute = "live";
  }
  setActiveSession(session.id, { updateHistory: true, forceLog: true });
  render();
  requestAnimationFrame(() => {
    scrollConversationAreaToBottom(session.id, { includeWindow: true });
  });
});

document.addEventListener("click", (event) => {
  if (document.body.dataset.menuOpen === "true") {
    const target = event.target;
    if (target instanceof Node && !menuToggle?.contains(target) && !menuPanel?.contains(target)) {
      closeMenu();
    }
  }

  const clickTarget = event.target;
  if (clickTarget instanceof HTMLElement) {
    if (clickTarget.matches('[data-action="identity-logout"]')) {
      if (!clickTarget.disabled) {
        void handleIdentityLogout(event, identityDomEntryByNode.get(clickTarget) ?? null);
      } else {
        event.preventDefault();
      }
      return;
    }
    if (clickTarget.matches('[data-action="copy-active-npub"]')) {
      void handleIdentityCopy(event, identityDomEntryByNode.get(clickTarget) ?? null);
      return;
    }
  }
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 720) {
    closeMenu();
  }
  syncDesktopSessionIndicator();
  const mobileLayout = isMobileFilesLayout();
  if (currentRoute === "files" && mobileLayout !== lastFilesMobileLayout) {
    lastFilesMobileLayout = mobileLayout;
    render();
  } else {
    lastFilesMobileLayout = mobileLayout;
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMenu();
  }
});

window.addEventListener("touchstart", handleTouchStart, { passive: true });
window.addEventListener("touchmove", handleTouchMove, { passive: false });
window.addEventListener("touchend", finishPull, { passive: true });
window.addEventListener("touchcancel", finishPull, { passive: true });

const scrollLiveViewIfVisible = () => {
  if (currentRoute !== "live") {
    return;
  }
  const scrollActiveId = sessionsStore().activeSessionId;
  if (!scrollActiveId) {
    return;
  }
  scheduleLiveScroll(scrollActiveId, { includeWindow: true });
};

window.addEventListener("focus", scrollLiveViewIfVisible);

// Initialize visibility manager for SSE reconnection on tab return
visibilityManager.init({
  getSessionId: () => sessionsStore().activeSessionId,
  checkHealth: (sessionId) => sseManager.isConnectionHealthy(sessionId),
  reconnect: (sessionId) => sseManager.reconnect(sessionId),
});

// Subscribe to visibility changes for scroll behavior
visibilityManager.onVisibilityChange((isVisible) => {
  if (isVisible) {
    scrollLiveViewIfVisible();
  }
});

window.addEventListener("popstate", () => {
  currentRoute = getRouteFromPath(window.location.pathname);
  if (currentRoute !== "live") {
    lastLoggedSessionId = null;
  }
  const redirectHome = applyRouteSessionFromPath({ allowHistoryUpdate: false });
  if (redirectHome) {
    currentRoute = "home";
    if (window.location.pathname !== HOME_ROUTE) {
      window.history.replaceState({ route: "home" }, "", HOME_ROUTE);
    }
  }
  if (currentRoute === "files") {
    if (window.location.pathname.startsWith("/docs")) {
      const newPath = window.location.pathname.replace("/docs", "/files");
      window.history.replaceState({ route: "files" }, "", newPath);
    }
    const parsed = parseFilesPathFromUrl();
    if (!state.files.initialized) {
      state.files.initialized = true;
      if (parsed.slug) {
        void navigateToFilesSlug(parsed.slug);
      } else {
        void loadFilesTree();
      }
    } else if (parsed.slug) {
      void navigateToFilesSlug(parsed.slug);
    } else if (!state.files.loading && !state.files.currentPath) {
      void loadFilesTree();
    }
  } else if (currentRoute === "apps") {
    // void ensureAppsLoaded(); // DISABLED
  } else if (currentRoute === "projects") {
    if (!projectsFeatureEnabledForViewer()) {
      currentRoute = "home";
      if (window.location.pathname !== HOME_ROUTE) {
        window.history.replaceState({ route: "home" }, "", HOME_ROUTE);
      }
    } else if (projectFeature) {
      void projectFeature.ensureLoaded();
    }
  } else if (currentRoute === "nightwatch") {
    if (!state.identity.isAdmin || !isFeatureEnabledForViewer("nightwatch_enabled")) {
      currentRoute = "home";
      if (window.location.pathname !== HOME_ROUTE) {
        window.history.replaceState({ route: "home" }, "", HOME_ROUTE);
      }
    } else {
      void ensureNightWatchPageLoaded();
    }
  } else if (currentRoute === "scheduler") {
    if (!state.identity.isAdmin) {
      currentRoute = "home";
      if (window.location.pathname !== HOME_ROUTE) {
        window.history.replaceState({ route: "home" }, "", HOME_ROUTE);
      }
    } else {
      void ensureSchedulerPageLoaded();
    }
  }
  render();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.fileEditor.open) {
    event.preventDefault();
    requestFileEditorClose();
  }
});

const handleSessionLaunchRequest = () => {
  if (sessionDialogController) {
    sessionDialogController.handleSubmit();
    return;
  }
  const agentId = agentSelect?.value ?? "";
  const workingDirectory = directoryInput?.value ?? "";
  const sessionName = sessionNameInput?.value ?? "";
  closeDialog();
  launchSession(agentId, workingDirectory, sessionName);
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
  // Initialize live module (Dexie database for SSE updates)
  initLiveModule().catch((err) => console.warn("[app] Live module init failed:", err));

  // Initialize Night Watch Alpine store (Dexie-backed, must register before Alpine.start)
  initNightWatchStore({ showToast });
  initSchedulerStore({ showToast });

  // Initialize Sessions Alpine store (Dexie-backed, must register before Alpine.start)
  initSessionsStore({
    showToast,
    getIdentity: () => state.identity,
    onUnauthorized: () => handleUnauthorizedAccess(),
    onIdentityUpdate: (update) => {
      if (update.ports) {
        update.ports = normalisePortList(update.ports);
      }
      updateIdentityState(update, { persist: true, emit: true });
    },
  });

  // Initialize Apps Alpine store (Dexie-backed, must register before Alpine.start)
  initAppsStore({
    showToast,
    getIdentity: () => state.identity,
    onUnauthorized: () => handleUnauthorizedAccess(),
    formatWebAppUrl,
  });

  // Initialize Alpine.js chat component if enabled
  if (isAlpineChatEnabled()) {
    initAlpineChat();
    console.log("[app] Alpine.js chat component enabled");
  }

  // Ensure Alpine.js is started (chat-component may have started it already)
  if (!window.Alpine) {
    const { default: Alpine } = await import("/vendor/alpinejs/module.esm.js");
    window.Alpine = Alpine;
    Alpine.start();
    console.log("[app] Alpine.js started");
  }

  // Pre-populate active session from URL path (must run after Alpine.start)
  const initialRouteSessionId = getSessionIdFromPath(window.location.pathname);
  if (initialRouteSessionId) {
    const ss = sessionsStore();
    ss.activeSessionId = initialRouteSessionId;
    ss.lastActiveSessionId = initialRouteSessionId;
  }

  // Wire SSE status events to knight rider and status indicators
  sseManager.onStatusChange((sessionId, status) => {
    const session = sessionsStore().items.find((s) => s.id === sessionId);
    if (session) {
      session.agentRuntimeStatus = status;
      updateAgentStatusIndicators();
    }
  });

  // Wire SSE message events to update conversation state.
  // SSE manager already writes each message to Dexie (MessageStore).
  // When Alpine chat is enabled, Dexie liveQuery drives the DOM reactively
  // so we only need to keep state.conversations in sync for legacy callers.
  sseManager.onMessage((sessionId, message) => {
    const existing = state.conversations.get(sessionId) || [];
    const lastMessage = existing[existing.length - 1];
    const isStreamingUpdate = lastMessage &&
      lastMessage.role === (message.role || message.type) &&
      message.content?.startsWith(lastMessage.content?.slice(0, 50));

    if (isStreamingUpdate) {
      lastMessage.content = message.content || message.message || "";
    } else {
      existing.push({
        role: message.role || message.type || "assistant",
        content: message.content || message.message || "",
        createdAt: message.createdAt || new Date().toISOString(),
      });
    }
    state.conversations.set(sessionId, existing);

    // Alpine chat: push conversation state directly to store for instant update.
    if (isAlpineChatEnabled()) {
      const chatStore = window.Alpine?.store("chat");
      if (chatStore && chatStore.sessionId === sessionId) {
        const conv = state.conversations.get(sessionId) || [];
        chatStore.messages = conv.map((msg, idx) => ({
          id: `api-${idx}`,
          sessionId,
          role: msg.role || msg.type || "assistant",
          content: msg.content || msg.message || "",
          createdAt: msg.createdAt || msg.created_at || "",
        }));
      }
      if (currentRoute === "live" && sessionId === sessionsStore().activeSessionId) {
        if (!scrollPillIsNearBottom() && !isStreamingUpdate) {
          scrollPillShow();
        }
      }
      return;
    }

    // Legacy manual DOM path (non-Alpine)
    if (currentRoute === "live" && sessionId === sessionsStore().activeSessionId) {
      const wasNearBottom = scrollPillIsNearBottom();
      updateConversationDOM(sessionId);
      if (!wasNearBottom && !isStreamingUpdate) {
        scrollPillShow();
      }
    }
  });

  // Render immediately from Dexie cache so the UI is visible while
  // network requests are in flight.
  render();

  // ── Sequential auth chain (each step depends on the previous) ──
  await fetchConfig();

  // Try to restore session from device keystore first
  if (typeof wingmanIdentity?.restoreFromDeviceKeystore === "function") {
    try {
      const restored = await wingmanIdentity.restoreFromDeviceKeystore(getIdentityWiringContext());
      if (restored) {
        console.log("[app] Session restored from device keystore");
      }
    } catch (err) {
      console.warn("[app] Device keystore restore failed:", err);
    }
  }

  // Check for Key Teleport login parameter (if not already authenticated)
  if (!state.identity.authenticated && typeof wingmanIdentity?.checkKeyTeleportParam === "function") {
    try {
      const teleportResult = await wingmanIdentity.checkKeyTeleportParam(getIdentityWiringContext());
      if (teleportResult) {
        console.log("[app] Key Teleport login completed");
      }
    } catch (err) {
      console.warn("[app] Key Teleport check failed:", err);
    }
  }

  ensureFeatureFlagsLoaded();

  // ── Parallel data fetches (independent of each other) ──
  const dataFetches = [fetchSessions()];
  if (orchestratorFeatureEnabledForViewer()) {
    dataFetches.push(refreshOrchestratorPresets());
  }
  if (state.identity.authenticated) {
    dataFetches.push(fetchApps({ tail: APP_LOG_PREVIEW_LINES }));
    dataFetches.push(fetchNpubProjects().catch(() => {}));
  } else if (currentRoute === "apps") {
    dataFetches.push(fetchApps({ tail: APP_LOG_PREVIEW_LINES }));
  }
  await Promise.all(dataFetches);

  // Start NIP-98 signing listener after auth + data are settled
  if (state.identity.authenticated && state.identity.npub) {
    startSigningListener(state.identity.npub);
  }

  // Live-refresh sessions via SSE so home page / nav update without reload
  if (state.identity.authenticated) {
    startSessionSubscriber(() => {
      fetchSessions().then(() => {
        syncMenuTabs();
        // Only full-render on pages that need it (home, apps).
        // On live route the conversation is already updating via SSE
        // and a full render() nukes the DOM, resets scroll, and breaks
        // the reading experience.
        if (currentRoute !== "live") {
          render();
        }
      });
    });
    window.addEventListener("wingman:identity-logout", () => stopSessionSubscriber(), { once: true });
  }

  // Re-render with fresh server data
  render();
})();
