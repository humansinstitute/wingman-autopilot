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
import { createLiveRefreshController } from "./live/refresh-controller.js";
import { syncLiveRouteTransport } from "./live/route-transport.js";
import {
  normalizeRuntimeStatus,
  normalizeSessionStatus,
  syncSessionStatusCaches,
} from "./live/session-status-cache.js";
import {
  initLiveMobileRuntime,
  isComposerInteractionActive,
  isMobileKeyboardOpen,
  focusComposerTextarea,
} from "./live/mobile-runtime.js";
import {
  createWebviewIcon,
} from "./live/webview-panel.js";
import {
  createWriterIcon,
} from "./writer/writer-panel.js";
import { createUnauthorizedGuard } from "./common/unauthorized-guard.js";
import { openTextPromptDialog } from "./common/dialog-prompts.js";
import { populateAgentSelect } from "./common/agent-options.js";
import { createSessionDialogController } from "./common/session-dialog.js";
import { createJobDialogController } from "./common/job-dialog.js";
import { initAppDialogs } from "./apps/dialog.js";
import { initWorkspaceTree } from "./apps/tree.js";
import { initAppCards } from "./apps/cards.js";
import {
  initFeatureFlagsUI,
  ORCHESTRATOR_FLAG_KEY,
} from "./feature-flags/index.js";
import { initNightWatchSettingsPanel } from "./nightwatch/settings-panel.js";
import { initNightWatchPage } from "./nightwatch/page.js";
import { initNightWatchStore } from "./nightwatch/store.js";
import { initSchedulerStore } from "./scheduler/store.js";
import { initSchedulerPage } from "./scheduler/page.js";
import { initJobsStore } from "./jobs/store.js";
import { initJobsPage } from "./jobs/page.js";
import { dispatchJobRun, fetchJobDefinitions } from "./jobs/api.js";
import { initSessionsStore } from "./sessions/store.js";
import { initAppsStore } from "./apps/store.js";
import { startSigningListener, stopSigningListener } from "./nip98/signing-listener.js";
import { startSessionSubscriber, stopSessionSubscriber } from "./sessions/subscriber.js";
import { buildSessionOrigin, createSessionLauncher } from "./helpers/session-launch.js";
import { createSessionStartHandler } from "./helpers/session-post-start.js";
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
// encoding utilities used by extracted modules (core/encoding.js)
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
import { initVoiceNotes } from "./core/voice-notes.js";
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
  postSessionMessageApi,
} from "./services/sessions.js";
import {
  stopSession as stopSessionAction,
  deleteSession as deleteSessionAction,
  renameSession as renameSessionAction,
} from "./sessions/actions.js";
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
import { initStarterProjectsPanel } from "./views/starter-projects-panel.js";
import { initHomeView } from "./views/home-view.js";
import { initFilesView } from "./views/files-view.js";
import { initFilesApi } from "./files/api.js";
import { initLiveView } from "./views/live-view.js";
import { initDirectoryBrowser } from "./modals/directory-browser.js";
import { abbreviateNpub, formatSatoshis, normaliseNpubValue, isFiniteNumber, initIdentityDom } from "./identity/dom.js";
import { initIdentityStateManager } from "./identity/state-manager.js";
import { createNavigation } from "./navigation/navigation.js";
import { createSessionRouting } from "./sessions/session-routing.js";

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
const sessionMessageSendInFlight = new Set();
let sessionDialogController = null;
let jobDialogController = null;
let liveRefreshController = null;
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
let renderLiveTabsBarContent = () => document.createElement("div");
let updateLivePanelsForSession = () => {};
let captureFocusSnapshot = () => null;
let restoreFocusFromSnapshot = () => {};
let openAppDialog = () => {};
let closeAppDialog = () => {};
let openAppLogsDialog = () => {};
let openDeployDialog = () => {};
let refreshAppLogs = async () => {};
let resetAppDialog = () => {};
let createWorkspaceTreeSidebar = () => null;
let renderAppCard = () => document.createElement("section");
let renderWingmanCard = () => document.createElement("section");
let renderFeatureFlagsPanel = () => document.createDocumentFragment();
let ensureFeatureFlagsLoaded = () => {};
let renderStarterProjectsPanel = () => document.createDocumentFragment();
let ensureStarterProjectsLoaded = () => {};
let resolveFeatureFlagForViewer = () => ({ state: "off", effectiveState: "off" });
let isFeatureEnabledForViewer = () => false;
let renderNightWatchSettingsPanel = () => document.createDocumentFragment();
let ensureNightWatchLoaded = () => {};
let renderNightWatchPage = () => document.createDocumentFragment();
let ensureNightWatchPageLoaded = () => {};
let renderSchedulerPage = () => document.createDocumentFragment();
let ensureSchedulerPageLoaded = () => {};
let renderJobsPage = () => document.createDocumentFragment();
let ensureJobsPageLoaded = () => {};
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

// -- Files API helpers (populated in bootstrap via initFilesApi) --
let resetFilesPreview = () => {};
let updateFilesUrl = () => {};
let parseFilesPathFromUrl = () => ({ slug: null });
let navigateToFilesSlug = async () => {};
let loadFilesTree = async () => {};
let loadFilesPreview = async () => {};
let showFilesPreviewUnavailable = () => {};
let createFilesDirectory = async () => {};
let createFilesTextFile = async () => {};
let uploadFilesBinary = async () => {};
let deleteFilesEntry = async () => {};
let createDirectoryEntry = async () => {};
let copyFilesEntry = async () => {};
let moveFilesEntry = async () => {};

// -- Markdown / code rendering imported from rendering/markdown.js --

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
let openVoiceNoteRecorder = async () => {};
let cleanupVoiceNoteDraftState = () => {};
let prepareVoiceNoteDraftForSend = async (_sessionId, draft) => draft;

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
const JOBS_ROUTE = "/jobs";
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
  if (pathname === SETTINGS_ROUTE || pathname.startsWith(`${SETTINGS_ROUTE}/`)) {
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
  if (pathname === JOBS_ROUTE) {
    return "jobs";
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

function resolveCurrentLiveSessionId() {
  const allSessions = sessionsStore().items;
  const routeSessionId =
    currentRoute === "live"
      ? getSessionIdFromPath(window.location.pathname)
      : null;

  if (routeSessionId && allSessions.some((session) => session.id === routeSessionId)) {
    return routeSessionId;
  }

  const activeId = sessionsStore().activeSessionId;
  if (activeId && allSessions.some((session) => session.id === activeId)) {
    return activeId;
  }

  const lastId = sessionsStore().lastActiveSessionId;
  if (lastId && allSessions.some((session) => session.id === lastId)) {
    return lastId;
  }

  return null;
}

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

// Session routing module — extracted from app.js.
// setActiveSession, ensureActiveSession, and applyRouteSessionFromPath live in sessions/session-routing.js.
// syncDesktopSessionIndicator and updateDocumentTitle are defined later in this file; they are
// referenced via closures inside the module so forward-declaration is fine (the functions are only
// called at runtime, never at module initialisation time).
const {
  setActiveSession,
  ensureActiveSession,
  applyRouteSessionFromPath,
} = createSessionRouting({
  sessionsStore,
  getCurrentRoute: () => currentRoute,
  getLastLoggedSessionId: () => lastLoggedSessionId,
  setLastLoggedSessionId: (id) => { lastLoggedSessionId = id; },
  LIVE_ROUTE_PREFIX,
  getSessionById: (...args) => getSessionById(...args),
  getActiveSessions: (...args) => getActiveSessions(...args),
  getSessionIdFromPath,
  syncDesktopSessionIndicator: (...args) => syncDesktopSessionIndicator(...args),
  updateDocumentTitle: (...args) => updateDocumentTitle(...args),
  activateLiveSessionRefresh: (...args) => liveRefreshController?.activateSession(...args),
  deactivateLiveSessionRefresh: (...args) => liveRefreshController?.deactivateSession(...args),
  getLiveRefreshSessionId: () => liveRefreshController?.getActiveSessionId?.() ?? null,
  isAlpineChatEnabled,
  scheduleLiveScroll: (...args) => scheduleLiveScroll(...args),
});

const dialog = document.getElementById("session-dialog");
const agentSelect = document.getElementById("agent-select");
const confirmButton = document.getElementById("confirm-session");
const cancelButton = document.getElementById("cancel-session");
const sessionForm = dialog?.querySelector("form");
const jobDialog = document.getElementById("job-dialog");
const jobForm = jobDialog?.querySelector("form");
const jobSelect = document.getElementById("job-select");
const jobWorkerAgentSelect = document.getElementById("job-worker-agent");
const jobManagerAgentSelect = document.getElementById("job-manager-agent");
const jobWorkerDirectoryInput = document.getElementById("job-worker-directory");
const jobManagerDirectoryInput = document.getElementById("job-manager-directory");
const jobGoalInput = document.getElementById("job-goal");
const jobWorkerGoalInput = document.getElementById("job-worker-goal");
const jobManagerGoalInput = document.getElementById("job-manager-goal");
const jobExtraPromptInput = document.getElementById("job-extra-prompt");
const jobRefsInput = document.getElementById("job-refs");
const confirmJobButton = document.getElementById("confirm-job-launch");
const cancelJobButton = document.getElementById("cancel-job-launch");
const jobDefaultManagerDir = document.getElementById("job-default-manager-dir");
const jobDefaultWorkerAgent = document.getElementById("job-default-worker-agent");
const jobDefaultManagerAgent = document.getElementById("job-default-manager-agent");
const jobCheckInterval = document.getElementById("job-check-interval");
const jobDefaultManagerGoal = document.getElementById("job-default-manager-goal");
const jobDefaultWorkerPrompt = document.getElementById("job-default-worker-prompt");
const jobDefaultManagerPrompt = document.getElementById("job-default-manager-prompt");
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
const sessionGoalInput = document.getElementById("session-goal");
const sessionNextActionSelect = document.getElementById("session-next-action");
const sessionNextActionTemplateInput = document.getElementById("session-next-action-template");
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
  const sessionId = resolveCurrentLiveSessionId();
  if (!sessionId) return null;
  return sessionsStore().items.find((session) => session.id === sessionId) ?? null;
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
    const currentSessionId = resolveCurrentLiveSessionId();
    const session = currentSessionId
      ? sessionsStore().items.find((s) => s.id === currentSessionId)
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
  } else if (currentRoute === "jobs") {
    title = "Jobs - Wingman";
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
  for (const key of Array.from(state.liveMessageWindows.keys())) {
    if (!sessionIds.has(key)) state.liveMessageWindows.delete(key);
  }
  for (const key of Array.from(state.lastLogLength.keys())) {
    if (!sessionIds.has(key)) state.lastLogLength.delete(key);
  }
  for (const key of Array.from(state.promptQueues.keys())) {
    if (!sessionIds.has(key)) state.promptQueues.delete(key);
  }
  const routeSessionId = getSessionIdFromPath(window.location.pathname);
  const allowHistoryUpdate = currentRoute === "live" && !routeSessionId;
  applyRouteSessionFromPath({ allowHistoryUpdate });
  ensureActiveSession();
  const activeId = ss.activeSessionId;

  syncDesktopSessionIndicator();

  if (currentRoute === "live" && activeId) {
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

const conversationSelectionState = {
  pointerDownInConversation: false,
  locked: false,
};

function isConversationSelectionInsideLiveChat() {
  const selection = typeof window !== "undefined" ? window.getSelection?.() : null;
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  const anchorEl = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement ?? null;
  const focusEl = focusNode instanceof Element ? focusNode : focusNode?.parentElement ?? null;
  const anchorInConversation = Boolean(anchorEl?.closest?.(".wm-live-conversation .wm-conversation"));
  const focusInConversation = Boolean(focusEl?.closest?.(".wm-live-conversation .wm-conversation"));
  return anchorInConversation || focusInConversation;
}

function isConversationRenderLocked(sessionId) {
  return conversationSelectionState.locked &&
    currentRoute === "live" &&
    sessionId === sessionsStore().activeSessionId;
}

async function renderConversationForSession(sessionId, options = {}) {
  const { isStreamingUpdate = false } = options;
  if (isConversationRenderLocked(sessionId)) {
    return;
  }
  if (isAlpineChatEnabled()) {
    if (currentRoute === "live" && sessionId === sessionsStore().activeSessionId) {
      if (!scrollPillIsNearBottom() && !isStreamingUpdate) {
        scrollPillShow();
      }
    }
    return;
  }
  if (currentRoute === "live" && sessionId === sessionsStore().activeSessionId) {
    const wasNearBottom = scrollPillIsNearBottom();
    await updateConversationDOM(sessionId);
    if (!wasNearBottom && !isStreamingUpdate) {
      scrollPillShow();
    }
  }
}

function flushConversationRenderLock() {
  const activeSessionId = sessionsStore().activeSessionId;
  if (!activeSessionId) {
    return;
  }
  void renderConversationForSession(activeSessionId);
}

function setupConversationSelectionLock() {
  document.addEventListener("mousedown", (event) => {
    const target = event.target;
    conversationSelectionState.pointerDownInConversation = Boolean(
      target instanceof Element && target.closest(".wm-live-conversation .wm-conversation"),
    );
  });
  document.addEventListener("mouseup", () => {
    conversationSelectionState.pointerDownInConversation = false;
    const shouldLock = isConversationSelectionInsideLiveChat();
    const wasLocked = conversationSelectionState.locked;
    conversationSelectionState.locked = shouldLock;
    if (wasLocked && !shouldLock) {
      flushConversationRenderLock();
    }
  });
  document.addEventListener("selectionchange", () => {
    const shouldLock = conversationSelectionState.pointerDownInConversation && isConversationSelectionInsideLiveChat();
    const wasLocked = conversationSelectionState.locked;
    conversationSelectionState.locked = shouldLock;
    if (wasLocked && !shouldLock) {
      flushConversationRenderLock();
    }
  });
}

const fetchConversation = async (sessionId) => {
  try {
    const data = await fetchSessionMessagesApi(sessionId);
    if (!data) return;
    const items = Array.isArray(data?.messages) ? data.messages : [];
    const { changed } = await MessageStore.syncFromServerIfChanged(sessionId, items);
    if (!changed) {
      return;
    }
    await renderConversationForSession(sessionId);
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
          const existingTabsPanel = tabsBar.querySelector('.wm-live-tabs-panel');
          if (existingTabsPanel) {
            const newTabsPanel = renderLiveTabsBarContent();
            existingTabsPanel.replaceWith(newTabsPanel);
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

const openJobDialog = async () => {
  if (!jobDialogController) {
    return;
  }
  try {
    await jobDialogController.open();
  } catch (error) {
    console.error("Failed to open job dialog", error);
    window.alert(`Failed to load jobs: ${(error instanceof Error ? error.message : String(error))}`);
  }
};

const closeJobDialog = () => {
  if (jobDialogController) {
    jobDialogController.close();
    return;
  }
  if (jobDialog?.open) {
    jobDialog.close();
  }
};

const handleSessionStart = createSessionStartHandler({
  getCurrentRoute: () => currentRoute,
  setCurrentRoute: (route) => {
    currentRoute = route;
  },
  setActiveSession: (...args) => setActiveSession(...args),
  updateWorkingDirectory: (session) => {
    if (typeof session?.workingDirectory !== "string" || session.workingDirectory.length === 0) {
      return;
    }
    state.lastWorkingDirectory = session.workingDirectory;
    if (directoryInput) {
      directoryInput.value = session.workingDirectory;
      scheduleDirectorySuggestions(session.workingDirectory);
    }
    sessionDialogController?.syncWorktreeHint?.();
  },
  fetchSessions: (...args) => fetchSessions(...args),
  fetchConversation: (...args) => fetchConversation(...args),
  fetchLogs: (...args) => fetchLogs(...args),
  render: () => render(),
});

const launchSession = createSessionLauncher({
  handleSessionStart,
  liveRoutePrefix: LIVE_ROUTE_PREFIX,
});

const launchJob = async ({
  jobId,
  workerAgent,
  managerAgent,
  workerDir,
  managerDir,
  goal,
  workerGoal,
  managerGoal,
  prompt,
  refs,
}) => {
  const payload = {
    job_id: jobId,
    worker_agent: workerAgent,
    manager_agent: managerAgent,
    worker_dir: workerDir,
    manager_dir: managerDir,
    goal,
    worker_goal: workerGoal,
    manager_goal: managerGoal,
    prompt,
    refs,
  };
  const result = await dispatchJobRun(payload);
  if (result?.manager_session) {
    await handleSessionStart(result.manager_session);
    return;
  }
  await fetchSessions();
  render();
  showToast(`Launched ${jobId}`);
};

populateAgentSelect(jobWorkerAgentSelect);
populateAgentSelect(jobManagerAgentSelect);

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
  goalInput: sessionGoalInput,
  nextActionSelect: sessionNextActionSelect,
  nextActionTemplateInput: sessionNextActionTemplateInput,
  writerModeCheckbox: sessionWriterModeCheckbox,
  targetFileInput: sessionTargetFileInput,
  targetFileField: sessionTargetFileField,
  isAuthenticated: () => Boolean(state.identity.authenticated),
  getConfig: () => state.config,
  getFallbackDirectory: getSessionFallbackDirectory,
  onRequireAuth: openIdentityLoginDialog,
  onDirectoryPrefill: (...args) => scheduleDirectorySuggestions(...args),
  onSubmit: ({ agentId, workingDirectory, sessionName, workspace, targetFile, metadata }) => {
    const options = {};
    if (targetFile) {
      options.targetFile = targetFile;
    }
    if (metadata && typeof metadata === "object") {
      options.metadata = metadata;
    }
    launchSession(agentId, workingDirectory, sessionName, workspace, options);
  },
});
sessionDialogController.resetFormState();

jobDialogController = createJobDialogController({
  dialog: jobDialog,
  jobSelect,
  workerAgentSelect: jobWorkerAgentSelect,
  managerAgentSelect: jobManagerAgentSelect,
  workerDirInput: jobWorkerDirectoryInput,
  managerDirInput: jobManagerDirectoryInput,
  goalInput: jobGoalInput,
  workerGoalInput: jobWorkerGoalInput,
  managerGoalInput: jobManagerGoalInput,
  extraPromptInput: jobExtraPromptInput,
  refsInput: jobRefsInput,
  confirmButton: confirmJobButton,
  isAuthenticated: () => Boolean(state.identity.authenticated),
  onRequireAuth: openIdentityLoginDialog,
  loadJobDefinitions: () => fetchJobDefinitions(),
  onSubmit: (values) =>
    launchJob({
      jobId: values.jobId,
      workerDir: values.workerDir,
      managerDir: values.managerDir,
      goal: values.goal,
      workerGoal: values.workerGoal,
      managerGoal: values.managerGoal,
      prompt: values.prompt,
      refs: values.refs,
    }),
  onDirectoryInput: (...args) => scheduleDirectorySuggestions(...args),
  defaultManagerDirOutput: jobDefaultManagerDir,
  defaultWorkerAgentOutput: jobDefaultWorkerAgent,
  defaultManagerAgentOutput: jobDefaultManagerAgent,
  checkIntervalOutput: jobCheckInterval,
  managerGoalOutput: jobDefaultManagerGoal,
  workerPromptOutput: jobDefaultWorkerPrompt,
  managerPromptOutput: jobDefaultManagerPrompt,
});

const stopSession = async (sessionId) => {
  try {
    const result = await stopSessionAction(sessionId);
    if (!result.success) {
      window.alert(`Failed to stop session: ${result.error}`);
      return;
    }
    await fetchSessions();
    render();
  } catch (error) {
    console.error("Failed to stop session", error);
    window.alert("Failed to stop session. Check console for details.");
  }
};

const deleteSession = async (sessionId) => {
  try {
    const result = await deleteSessionAction(sessionId);
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
  return renameSessionAction(sessionId, name);
};

const promptRenameSession = async (session) => {
  const currentLabel =
    typeof session.name === "string" && session.name.trim().length > 0
      ? session.name.trim()
      : getSessionDisplayName(session);
  const trimmed = await openTextPromptDialog({
    title: "Rename Session",
    description: "Update the label used across the session list and live view.",
    label: "Session name",
    value: currentLabel,
    confirmLabel: "Save",
    testId: "rename-session-dialog",
    validate: (value) => (value ? "" : "Session name cannot be empty."),
  });
  if (trimmed === null) return;
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

  if (sessionMessageSendInFlight.has(sessionId)) {
    showToast("Agent working", { variant: "info", duration: 2200 });
    return { sent: false, queued: false, busy: true };
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
        focusComposerTextarea(textarea, "send");
      }
      // Show the raw input in the chat and refresh conversation
      if (isAlpineChatEnabled()) {
        const chatStore = window.Alpine?.store("chat");
        if (chatStore && chatStore.sessionId === sessionId) {
          chatStore.appendMessage({
            id: `raw-${Date.now()}`,
            sessionId,
            role: "user",
            content: trimmed,
            createdAt: new Date().toISOString(),
          });
        }
      }
      await Promise.all([fetchConversation(sessionId), fetchLogs(sessionId)]);
      return { sent: true, queued: false, type: "raw" };
    } catch (error) {
      console.error("Failed to send raw input", error);
      showToast(`Failed to send ${trimmed}`, { variant: "error" });
      return { sent: false, queued: false, error };
    }
  }

  let preparedContent = trimmed;
  try {
    preparedContent = await prepareVoiceNoteDraftForSend(sessionId, trimmed);
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Failed to prepare voice note transcript.";
    showToast(`Failed to send message: ${message}`, { variant: "error" });
    return { sent: false, queued: false, error };
  }

  const finalContent = typeof preparedContent === "string" ? preparedContent.trim() : "";
  if (!finalContent) {
    window.alert("Enter a message before sending.");
    return { sent: false, queued: false };
  }

  // Check if agent is busy - if so, queue the message
  if (isSessionBusy(session)) {
    const queued = await addToPromptQueue(sessionId, finalContent);
    if (queued) {
      state.messageDrafts.set(sessionId, "");
      // Clear the textarea
      const textarea = document.querySelector('.wm-composer textarea');
      if (textarea) {
        textarea.value = "";
        textarea.style.height = "auto";
        focusComposerTextarea(textarea, "queue");
      }
      // Update status indicators to show queue count
      updateAgentStatusIndicators();
      return { sent: false, queued: true };
    }
    return { sent: false, queued: false };
  }

  // Agent is not busy - send message immediately
  try {
    sessionMessageSendInFlight.add(sessionId);
    const payload = await postSessionMessage(sessionId, finalContent, "user");
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    await MessageStore.syncFromServer(sessionId, messages);
    state.messageDrafts.set(sessionId, "");

    // Activate knight rider effect immediately after sending
    const knightRider = document.querySelector(`.wm-knight-rider[data-session-id="${sessionId}"]`);
    if (knightRider) knightRider.classList.add("active");

    // After sending, update conversation display
    await renderConversationForSession(sessionId);
    scrollPillHide();
    requestAnimationFrame(() => {
      scrollConversationAreaToBottom(sessionId, { includeWindow: true });
    });
    await fetchLogs(sessionId);

    const textarea = document.querySelector('.wm-composer textarea');
    if (textarea) {
      textarea.value = "";
      textarea.style.height = "auto";
      focusComposerTextarea(textarea, "send");
    }
    return { sent: true, queued: false };
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Failed to send message to agent.";
    const status = Number(error?.status ?? 0);
    const normalized = message.toLowerCase();
    const isWorkingState =
      status === 409 ||
      status === 429 ||
      normalized.includes("already in progress") ||
      normalized.includes("already posted") ||
      normalized.includes("already processing") ||
      normalized.includes("agent working") ||
      normalized.includes("not ready for prompt dispatch");
    if (isWorkingState) {
      showToast("Agent working", { variant: "info", duration: 2600 });
      return { sent: false, queued: false, busy: true };
    }
    console.error("Failed to send agent message", error);
    showToast(`Failed to send message: ${message}`, { variant: "error" });
    return { sent: false, queued: false, error };
  } finally {
    sessionMessageSendInFlight.delete(sessionId);
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
      const routeChanged = previousRenderRoute !== currentRoute;
      previousRenderRoute = syncLiveRouteTransport({
        previousRoute: previousRenderRoute,
        currentRoute,
        activeSessionId: sessionsStore().activeSessionId,
        sseManager,
        liveRefreshController,
      });

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

      // Skip full DOM rebuild for pages that manage their own Alpine state
      // to avoid destroying in-progress form edits
      const stablePages = ["scheduler", "jobs"];
      if (!routeChanged && stablePages.includes(currentRoute)) {
        setActiveNav();
        syncMenuTabs();
        syncDesktopSessionIndicator();
        updateAgentStatusIndicators();
        updateDocumentTitle();
        return;
      }

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
      } else if (currentRoute === "jobs") {
        view = renderJobsPage();
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
        focusComposerTextarea(textarea, "restore");
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

function shouldFullRenderOnSessionUpdate(route) {
  // Files view should not full re-render on background session updates because
  // it resets reading position in the spec/file preview.
  if (route === "files" || route === "live") {
    return false;
  }
  return true;
}

function handleSessionsStoreItemsChanged() {
  syncMenuTabs();
  syncDesktopSessionIndicator();
  if (shouldFullRenderOnSessionUpdate(currentRoute)) {
    render();
  } else {
    updateAgentStatusIndicators();
  }
}

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

liveRefreshController = createLiveRefreshController({
  sseManager,
  getCurrentRoute: () => currentRoute,
  getActiveSessionId: () => sessionsStore().activeSessionId,
  getSessionRuntimeStatus: (sessionId) => {
    const session = sessionsStore().items.find((item) => item.id === sessionId);
    if (!session) {
      return null;
    }
    return session.agentRuntimeStatus ?? session.status ?? null;
  },
  fetchConversation: (...args) => fetchConversation(...args),
  fetchLogs: (...args) => fetchLogs(...args),
  fetchSessionQueue: (...args) => fetchSessionQueue(...args),
  fetchSessionDetails: (...args) => fetchSessionApi(...args),
  applySessionDetails: (sessionId, sessionData) => {
    const nextSessionStatus = normalizeSessionStatus(sessionData?.status ?? null);
    const nextRuntimeStatus = normalizeRuntimeStatus(sessionData?.agentRuntimeStatus ?? null);
    const session = sessionsStore().items.find((item) => item.id === sessionId);
    if (session) {
      if (nextSessionStatus !== null) {
        session.status = nextSessionStatus;
      }
      session.agentRuntimeStatus = nextRuntimeStatus;
    }
    void syncSessionStatusCaches(sessionId, {
      status: nextSessionStatus,
      agentRuntimeStatus: nextRuntimeStatus,
    });
    updateAgentStatusIndicators();
  },
  isComposerInteractionActive,
  isMobileKeyboardOpen,
});

initQuickLauncher({ state, launchSession, showToast });

const imageAttachmentsModule = initImageAttachments({ state, getSessionById });
insertTextAtCursor = imageAttachmentsModule.insertTextAtCursor;
clearImagePreviews = imageAttachmentsModule.clearImagePreviews;
extractImageFiles = imageAttachmentsModule.extractImageFiles;
extractAttachmentFiles = imageAttachmentsModule.extractAttachmentFiles;
handleImageUploads = imageAttachmentsModule.handleImageUploads;
handleAttachmentUploads = imageAttachmentsModule.handleAttachmentUploads;
cleanupOrphanedMarkers = imageAttachmentsModule.cleanupOrphanedMarkers;

const voiceNotesModule = initVoiceNotes({
  state,
  getSessionById,
  insertTextAtCursor,
  showToast,
});
openVoiceNoteRecorder = voiceNotesModule.openVoiceNoteRecorder;
cleanupVoiceNoteDraftState = voiceNotesModule.cleanupOrphanedVoiceNotes;
prepareVoiceNoteDraftForSend = voiceNotesModule.prepareDraftForSend;

const imageMarkerCleanup = cleanupOrphanedMarkers;
cleanupOrphanedMarkers = (sessionId, text) => {
  imageMarkerCleanup(sessionId, text);
  cleanupVoiceNoteDraftState(sessionId, text);
};

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

const appCardsModule = initAppCards({
  appsStore,
  APP_STATUS_LABELS,
  renderLogPreview: (...args) => renderAppLogPreview(...args),
  launchSession: (...args) => launchSession(...args),
  fetchAppLogsApi,
  removeApp: (...args) => removeApp(...args),
  state,
  formatAppTimestamp,
  formatAppActionLabel,
  formatWebAppUrl,
  deriveAppWindowName,
  appendVariableUrlRow,
  appendVariablePubkeyRow,
  isAppActionDisabled,
  triggerAppAction: (...args) => triggerAppAction(...args),
  triggerWarmRestart: (...args) => triggerWarmRestart(...args),
  runSystemCleanup: (...args) => runSystemCleanup(...args),
  openIdentityLoginDialog,
  buildSessionOrigin,
  openAppLogsDialog: (...args) => openAppLogsDialog(...args),
  openDeployDialog: (...args) => openDeployDialog(...args),
  openAppDialog: (...args) => openAppDialog(...args),
});
renderAppCard = appCardsModule.renderAppCard;
renderWingmanCard = appCardsModule.renderWingmanCard;

const starterProjectsPanelModule = initStarterProjectsPanel({
  state,
  getCurrentRoute: () => currentRoute,
  render,
  showToast,
});
ensureStarterProjectsLoaded = starterProjectsPanelModule.ensureStarterProjectsLoaded;
renderStarterProjectsPanel = starterProjectsPanelModule.renderStarterProjectsPanel;

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
  ensureStarterProjectsLoaded: (...args) => ensureStarterProjectsLoaded(...args),
  renderStarterProjectsPanel: (...args) => renderStarterProjectsPanel(...args),
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
  navigateToApps: (...args) => navigateToApps(...args),
  navigateToChat: (...args) => navigateToChat(...args),
  openDialog,
  openJobDialog,
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

// Files API module — must init before dirBrowser and filesView which depend on these
const filesApiModule = initFilesApi({
  state,
  getCurrentRoute: () => currentRoute,
  render,
  FILES_ROUTE,
});
resetFilesPreview = filesApiModule.resetFilesPreview;
updateFilesUrl = filesApiModule.updateFilesUrl;
parseFilesPathFromUrl = filesApiModule.parseFilesPathFromUrl;
navigateToFilesSlug = filesApiModule.navigateToFilesSlug;
loadFilesTree = filesApiModule.loadFilesTree;
loadFilesPreview = filesApiModule.loadFilesPreview;
showFilesPreviewUnavailable = filesApiModule.showFilesPreviewUnavailable;
createFilesDirectory = filesApiModule.createFilesDirectory;
createFilesTextFile = filesApiModule.createFilesTextFile;
uploadFilesBinary = filesApiModule.uploadFilesBinary;
deleteFilesEntry = filesApiModule.deleteFilesEntry;
createDirectoryEntry = filesApiModule.createDirectoryEntry;
copyFilesEntry = filesApiModule.copyFilesEntry;
moveFilesEntry = filesApiModule.moveFilesEntry;

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
  openVoiceNoteRecorder,
  openDialog,
  isFeatureEnabledForViewer: (...args) => isFeatureEnabledForViewer(...args),
  showToast,
  renderAppCard: (...args) => renderAppCard(...args),
});
renderLive = liveViewModule.renderLive;
renderSessionTabs = liveViewModule.renderSessionTabs;
renderTabs = liveViewModule.renderTabs;
renderLiveTabsBarContent = liveViewModule.renderLiveTabsBarContent;
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
  navigateToHome: (...args) => navigateToHome(...args),
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

const jobsPageUI = initJobsPage({ showToast });
renderJobsPage = jobsPageUI.renderPage;
ensureJobsPageLoaded = jobsPageUI.ensureLoaded;

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

// Navigation module — extracted from app.js.
// All six navigateTo* functions and the nav event listeners live in navigation.js.
const {
  navigateToHome,
  navigateToApps,
  navigateToProjects,
  navigateToNightWatch,
  navigateToScheduler,
  navigateToJobs,
  navigateToSettings,
  setupNavListeners,
} = createNavigation({
  closeMenu,
  closeIdentityLoginDialog,
  openIdentityLoginDialog,
  deactivateLiveSessionRefresh: (...args) => liveRefreshController?.deactivateSession(...args),
  render,
  getCurrentRoute: () => currentRoute,
  setCurrentRoute: (r) => { currentRoute = r; },
  setLastLoggedSessionId: (id) => { lastLoggedSessionId = id; },
  appsStore,
  sessionsStore,
  setActiveSession,
  state,
  showToast,
  projectsFeatureEnabledForViewer: (...args) => projectsFeatureEnabledForViewer(...args),
  isFeatureEnabledForViewer: (...args) => isFeatureEnabledForViewer(...args),
  get projectFeature() { return projectFeature; },
  ensureNightWatchPageLoaded: (...args) => ensureNightWatchPageLoaded(...args),
  ensureSchedulerPageLoaded: (...args) => ensureSchedulerPageLoaded(...args),
  ensureJobsPageLoaded: (...args) => ensureJobsPageLoaded(...args),
  loadFilesTree: (...args) => loadFilesTree(...args),
  updateFilesUrl: (...args) => updateFilesUrl(...args),
  getActiveSessionForIndicator,
  scrollConversationAreaToBottom,
  HOME_ROUTE,
  APPS_ROUTE,
  PROJECTS_ROUTE,
  NIGHTWATCH_ROUTE,
  TRIGGERS_ROUTE,
  SCHEDULER_ROUTE,
  JOBS_ROUTE,
  SETTINGS_ROUTE,
  PRIVACY_ROUTE,
  navLinks,
  menuToggle,
  menuPanel,
  desktopSessionIndicatorButton,
  toggleMenu,
  getHandleIdentityLogout: () => handleIdentityLogout,
  getHandleIdentityCopy: () => handleIdentityCopy,
  getIdentityDomEntryByNode: () => identityDomEntryByNode,
});

setupNavListeners();

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
  if (isComposerInteractionActive() || isMobileKeyboardOpen()) {
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
  applyRouteSessionFromPath({ allowHistoryUpdate: false });
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
  } else if (currentRoute === "jobs") {
    if (!state.identity.isAdmin) {
      currentRoute = "home";
      if (window.location.pathname !== HOME_ROUTE) {
        window.history.replaceState({ route: "home" }, "", HOME_ROUTE);
      }
    } else {
      void ensureJobsPageLoaded();
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

jobForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  void jobDialogController?.handleSubmit();
});

confirmButton.addEventListener("click", (event) => {
  event.preventDefault();
  handleSessionLaunchRequest();
});

confirmJobButton?.addEventListener("click", (event) => {
  event.preventDefault();
  void jobDialogController?.handleSubmit();
});

cancelButton.addEventListener("click", (event) => {
  event.preventDefault();
  closeDialog();
});

cancelJobButton?.addEventListener("click", (event) => {
  event.preventDefault();
  closeJobDialog();
});

dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog();
});

jobDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeJobDialog();
});

(async () => {
  initTheme();
  initTabsVisibility();
  setupConversationSelectionLock();
  initLiveMobileRuntime();
  // Initialize live module (Dexie database for SSE updates)
  initLiveModule().catch((err) => console.warn("[app] Live module init failed:", err));

  // Initialize Night Watch Alpine store (Dexie-backed, must register before Alpine.start)
  initNightWatchStore({ showToast });
  initSchedulerStore({ showToast });
  initJobsStore({ showToast });

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
    onItemsChanged: () => {
      handleSessionsStoreItemsChanged();
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
    const nextRuntimeStatus = normalizeRuntimeStatus(status);
    const session = sessionsStore().items.find((s) => s.id === sessionId);
    if (session) {
      session.agentRuntimeStatus = nextRuntimeStatus;
    }
    void syncSessionStatusCaches(sessionId, { agentRuntimeStatus: nextRuntimeStatus });
    updateAgentStatusIndicators();
  });

  // SSE manager writes incoming messages into Dexie. The DOM then hydrates from
  // the canonical MessageStore path instead of maintaining a legacy mirror.
  sseManager.onMessage((sessionId, _message, meta = {}) => {
    void renderConversationForSession(sessionId, { isStreamingUpdate: meta.isStreamingUpdate });
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
    startSessionSubscriber({
      onConnect: () => {
        void fetchSessions();
      },
      onEvent: () => {
        void fetchSessions();
      },
    });
    window.addEventListener("wingman:identity-logout", () => stopSessionSubscriber(), { once: true });
  }

  // Re-render with fresh server data
  render();
})();
