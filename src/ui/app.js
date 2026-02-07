import "/ace-builds/src-noconflict/ace.js";
import "/ace-builds/src-noconflict/mode-text.js";
import "/ace-builds/src-noconflict/theme-chrome.js";
import "/ace-builds/src-noconflict/theme-tomorrow_night.js";
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
import { initSessionsStore } from "./sessions/store.js";
import { initAppsStore } from "./apps/store.js";
import { startSigningListener, stopSigningListener } from "./nip98/signing-listener.js";
import { buildSessionOrigin, createSessionLauncher } from "./helpers/session-launch.js";
import {
  state,
  createAdminUsersState,
  initFilesShowHidden,
  resolveWebAppBase,
  formatWebAppUrl,
  THEME_STORAGE_KEY,
  TABS_VISIBILITY_STORAGE_KEY,
  FILES_SHOW_HIDDEN_STORAGE_KEY,
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

const ace = globalThis.ace;
if (!ace) {
  throw new Error("Ace editor failed to load");
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
let orchestratorFeatureEnabledForViewer = () => false;
let projectsFeatureEnabledForViewer = () => true;
let syncFeatureFlagsFromConfig = () => {};
let scheduleDirectorySuggestions = () => {};
let openDirectoryBrowser = async () => null;
let openFileTransferDialogForMode = async () => {};

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

// Initialize files.showHidden from localStorage
initFilesShowHidden();

const IDENTITY_STORAGE_KEY = "wingman-identity-state";
const IDENTITY_EVENT_NAMES = ["wingman:identity-state", "identity:state", "nostr-auth:state"];

const identityDomEntries = new Set();
const identityDomEntryByNode = new WeakMap();
const identityCopyFeedbackTimeouts = new WeakMap();
const identityButtonTimers = new WeakMap();
let identityCountdownIntervalId = null;

const clearButtonStateTimer = (button) => {
  if (!button) return;
  const timerId = identityButtonTimers.get(button);
  if (timerId) {
    window.clearTimeout(timerId);
    identityButtonTimers.delete(button);
  }
};

const ensureButtonOriginalLabel = (button) => {
  if (!button) return;
  if (!button.dataset.originalLabel) {
    button.dataset.originalLabel = button.textContent ?? "";
  }
};

const resetButtonState = (button) => {
  if (!button) return;
  clearButtonStateTimer(button);
  const originalLabel = button.dataset.originalLabel;
  if (typeof originalLabel === "string") {
    button.textContent = originalLabel;
  }
  delete button.dataset.state;
  button.removeAttribute("aria-busy");
};

const setButtonState = (button, options = {}) => {
  if (!button) return;
  ensureButtonOriginalLabel(button);
  const { state, label, disable, restoreAfterMs } = options;
  if (state) {
    button.dataset.state = state;
    if (state === "loading") {
      button.setAttribute("aria-busy", "true");
    } else {
      button.removeAttribute("aria-busy");
    }
  } else {
    delete button.dataset.state;
    button.removeAttribute("aria-busy");
  }
  if (typeof label === "string") {
    button.textContent = label;
  }
  if (typeof disable === "boolean") {
    button.disabled = disable;
  }
  if (restoreAfterMs && restoreAfterMs > 0) {
    clearButtonStateTimer(button);
    const timerId = window.setTimeout(() => {
      resetButtonState(button);
      identityButtonTimers.delete(button);
    }, restoreAfterMs);
    identityButtonTimers.set(button, timerId);
  }
};

const identityMethodLabels = {
  none: "Not signed in",
  nip07: "Browser extension",
  local_keys: "BYO Nsec",
  bunker: "Remote signer",
};

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

const toFiniteTimestamp = (value) => {
  if (isFiniteNumber(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.getTime();
  }
  return null;
};

const abbreviateNpub = (npub) => {
  if (!npub || typeof npub !== "string") return "";
  const trimmed = npub.trim();
  if (trimmed.length <= 20) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-6)}`;
};

const formatSatoshis = (value) => {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const truncated = Math.trunc(numeric);
  const positive = truncated < 0 ? 0 : truncated;
  return positive.toLocaleString(undefined, { maximumFractionDigits: 0 });
};

const normaliseNpubValue = (npub) => {
  if (typeof npub !== "string") return null;
  const trimmed = npub.trim();
  return trimmed.length === 0 ? null : trimmed;
};


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

const getConfiguredAdminNpub = () => {
  const configured = state.config?.adminNpub;
  return typeof configured === "string" && configured.trim().length > 0 ? configured.trim() : null;
};

const formatIdentityDuration = (ms) => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 && parts.length < 3) parts.push(`${minutes}m`);
  if (parts.length < 3) parts.push(`${seconds}s`);
  return parts.join(" ");
};

const showIdentityCopyFeedback = (message, { error = false, entry } = {}) => {
  const targets = entry ? [entry] : Array.from(identityDomEntries);
  targets.forEach((target) => {
    const feedback = target.copyFeedback;
    if (!feedback) return;
    feedback.textContent = message;
    feedback.hidden = false;
    if (error) {
      feedback.dataset.state = "error";
    } else {
      feedback.dataset.state = "success";
    }
    const existingTimeout = identityCopyFeedbackTimeouts.get(target);
    if (existingTimeout) {
      window.clearTimeout(existingTimeout);
    }
    const timeoutId = window.setTimeout(() => {
      const currentFeedback = target.copyFeedback;
      if (!currentFeedback) return;
      currentFeedback.hidden = true;
      delete currentFeedback.dataset.state;
    }, 2000);
    identityCopyFeedbackTimeouts.set(target, timeoutId);
    if (target.copyButton) {
      target.copyButton.dataset.state = error ? "error" : "success";
      window.setTimeout(() => {
        if (target.copyButton) {
          delete target.copyButton.dataset.state;
        }
      }, error ? 2500 : 1500);
    }
  });
};

const stopIdentityCountdown = () => {
  if (identityCountdownIntervalId !== null) {
    window.clearInterval(identityCountdownIntervalId);
    identityCountdownIntervalId = null;
  }
};

const updateIdentityCountdown = () => {
  pruneIdentityDomEntries();
  const expiresAt = state.identity.expiresAt;
  const authenticated = state.identity.authenticated;
  const expirationKnown = isFiniteNumber(expiresAt);
  identityDomEntries.forEach((entry) => {
    const expiry = entry.expiry;
    if (!expiry) return;
    if (!expirationKnown) {
      expiry.textContent = authenticated ? "Session expiry unknown" : "—";
      expiry.dataset.state = authenticated ? "unknown" : "inactive";
      expiry.title = "";
      return;
    }
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      expiry.textContent = "Session expired";
      expiry.dataset.state = "expired";
      expiry.title = new Date(expiresAt).toLocaleString();
      return;
    }
    expiry.textContent = `Expires in ${formatIdentityDuration(remaining)}`;
    expiry.dataset.state = "active";
    expiry.title = new Date(expiresAt).toLocaleString();
  });
  if (expirationKnown && expiresAt - Date.now() <= 0) {
    stopIdentityCountdown();
  }
};

const startIdentityCountdown = () => {
  stopIdentityCountdown();
  if (!state.identity.authenticated || !isFiniteNumber(state.identity.expiresAt)) {
    return;
  }
  const hasExpiryTarget = Array.from(identityDomEntries).some((entry) => Boolean(entry.expiry));
  if (!hasExpiryTarget) {
    return;
  }
  updateIdentityCountdown();
  identityCountdownIntervalId = window.setInterval(() => {
    updateIdentityCountdown();
  }, 1000);
};

const persistIdentityState = (identity) => {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    if (identity.npub) {
      const payload = {
        npub: identity.npub,
        method: identity.method,
        expiresAt: identity.expiresAt ?? null,
        alias: identity.alias ?? null,
        picture: identity.picture ?? null,
        ports: Array.isArray(identity.ports) ? [...identity.ports] : [],
        balance: typeof identity.balance === "number" ? identity.balance : 0,
      };
      window.localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(payload));
    } else {
      window.localStorage.removeItem(IDENTITY_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
};

const syncIdentityDisplayForEntry = (entry) => {
  const { npub, method, authenticated, expiresAt, alias, balance } = state.identity;
  if (entry.root) {
    if (authenticated) {
      entry.root.dataset.authenticated = "true";
    } else {
      delete entry.root.dataset.authenticated;
    }
  }
  if (entry.details) {
    entry.details.hidden = !authenticated;
  }
  if (entry.registerSection) {
    entry.registerSection.hidden = authenticated;
  }
  if (entry.alias) {
    if (!authenticated) {
      entry.alias.textContent = "Not signed in";
      entry.alias.removeAttribute("title");
    } else {
      const abbreviated = npub ? abbreviateNpub(npub) : "";
      if (alias && abbreviated) {
        entry.alias.textContent = `${alias} (${abbreviated})`;
        entry.alias.title = npub;
      } else if (abbreviated) {
        entry.alias.textContent = abbreviated;
        entry.alias.title = npub;
      } else if (alias) {
        entry.alias.textContent = alias;
        entry.alias.removeAttribute("title");
      } else {
        entry.alias.textContent = "Not signed in";
        entry.alias.removeAttribute("title");
      }
    }
  }
  if (entry.npub) {
    if (npub) {
      entry.npub.textContent = abbreviateNpub(npub);
      entry.npub.title = npub;
    } else {
      entry.npub.textContent = "Not signed in";
      entry.npub.removeAttribute("title");
    }
  }
  if (entry.method) {
    entry.method.textContent = authenticated ? (identityMethodLabels[method] ?? method ?? "Unknown") : "—";
  }
  if (entry.balance) {
    if (!authenticated) {
      entry.balance.textContent = "—";
    } else {
      entry.balance.textContent = `${formatSatoshis(balance)} sats`;
    }
  }
  if (entry.copyButton) {
    if (!npub) {
      entry.copyButton.disabled = true;
    } else {
      entry.copyButton.disabled = false;
    }
  }
  if (entry.copyNpubButton) {
    if (!authenticated || !npub) {
      entry.copyNpubButton.disabled = true;
    } else {
      entry.copyNpubButton.disabled = false;
    }
  }
  if (entry.copyNsecButton) {
    if (!authenticated || method !== "local_keys") {
      entry.copyNsecButton.disabled = true;
    } else {
      entry.copyNsecButton.disabled = false;
    }
  }
  if (entry.logoutButton) {
    if (!authenticated) {
      resetButtonState(entry.logoutButton);
      entry.logoutButton.disabled = true;
    } else {
      entry.logoutButton.disabled = false;
    }
  }
  if (entry.copyFeedback && !npub) {
    entry.copyFeedback.hidden = true;
    delete entry.copyFeedback.dataset.state;
  }
  if (entry.expiry) {
    if (!authenticated) {
      entry.expiry.textContent = "—";
      entry.expiry.dataset.state = "inactive";
      entry.expiry.removeAttribute("title");
    } else if (!isFiniteNumber(expiresAt)) {
      entry.expiry.textContent = "Session expiry unknown";
      entry.expiry.dataset.state = "unknown";
      entry.expiry.removeAttribute("title");
    } else {
      updateIdentityCountdown();
    }
  }
};

const syncIdentityDisplay = () => {
  pruneIdentityDomEntries();
  identityDomEntries.forEach((entry) => {
    syncIdentityDisplayForEntry(entry);
  });
  requestAuthUiSync();
  if (state.identity.authenticated && isFiniteNumber(state.identity.expiresAt)) {
    startIdentityCountdown();
  } else {
    stopIdentityCountdown();
  }
};

let postAuthSessionsFetchScheduled = false;
const requestPostAuthSessionsFetch = () => {
  if (postAuthSessionsFetchScheduled) {
    return;
  }
  postAuthSessionsFetchScheduled = true;
  const triggerFetch = async () => {
    postAuthSessionsFetchScheduled = false;
    await fetchSessions();
    if (state.identity.authenticated) {
      fetchApps({ tail: APP_LOG_PREVIEW_LINES }).catch(() => {});
      fetchNpubProjects().catch(() => {});
    }
    render();
  };
  if (typeof queueMicrotask === "function") {
    queueMicrotask(triggerFetch);
  } else {
    Promise.resolve().then(triggerFetch);
  }
};

let postAuthConfigRefreshScheduled = false;
const requestPostAuthConfigRefresh = () => {
  if (postAuthConfigRefreshScheduled) {
    return;
  }
  postAuthConfigRefreshScheduled = true;
  const triggerRefresh = () => {
    postAuthConfigRefreshScheduled = false;
    void fetchConfig();
  };
  if (typeof queueMicrotask === "function") {
    queueMicrotask(triggerRefresh);
  } else {
    Promise.resolve().then(triggerRefresh);
  }
};

const updateIdentityState = (partial, { persist = true, emit = true } = {}) => {
  if (!partial || typeof partial !== "object") {
    return state.identity;
  }
  const current = state.identity;
  const next = {
    method: current.method,
    npub: current.npub,
    expiresAt: current.expiresAt,
    authenticated: current.authenticated,
    alias: current.alias,
    picture: current.picture ?? null,
    isAdmin: current.isAdmin,
    ports: Array.isArray(current.ports) ? [...current.ports] : [],
    balance: typeof current.balance === "number" ? current.balance : 0,
  };
  const wasAdmin = current.isAdmin;

  if ("isAuthenticated" in partial && partial.isAuthenticated === false) {
    next.method = "none";
    next.npub = null;
    next.expiresAt = null;
    next.ports = [];
  }

  if ("method" in partial && typeof partial.method === "string" && partial.method.length > 0) {
    next.method = partial.method;
  }

  if ("npub" in partial) {
    if (typeof partial.npub === "string" && partial.npub.trim().length > 0) {
      next.npub = partial.npub.trim();
    } else if (partial.npub === null) {
      next.npub = null;
    }
  } else if (typeof partial.pubkey === "string" && partial.pubkey.trim().length > 0 && !next.npub) {
    next.npub = partial.pubkey.trim();
  }

  const expiryCandidate =
    "expiresAt" in partial
      ? partial.expiresAt
      : "sessionExpiresAt" in partial
        ? partial.sessionExpiresAt
        : "expiry" in partial
          ? partial.expiry
          : undefined;
  if (expiryCandidate !== undefined) {
    const timestamp = toFiniteTimestamp(expiryCandidate);
    next.expiresAt = timestamp;
  }

  if ("ports" in partial) {
    if (partial.ports === null) {
      next.ports = [];
    } else if (Array.isArray(partial.ports)) {
      next.ports = normalisePortList(partial.ports);
    }
  }

  if (!next.npub) {
    next.method = "none";
    next.expiresAt = null;
    next.alias = null;
    next.picture = null;
    next.ports = [];
    next.balance = 0;
  }

  const configuredAdminNpub = getConfiguredAdminNpub();
  const normalizedNextNpub = normaliseNpubValue(next.npub);
  next.isAdmin = Boolean(configuredAdminNpub && normalizedNextNpub && normalizedNextNpub === configuredAdminNpub);

  if ("alias" in partial) {
    if (typeof partial.alias === "string" && partial.alias.trim().length > 0) {
      next.alias = partial.alias.trim();
    } else if (partial.alias === null) {
      next.alias = null;
    }
  }

  if ("picture" in partial) {
    if (typeof partial.picture === "string" && partial.picture.trim().length > 0) {
      next.picture = partial.picture.trim();
    } else if (partial.picture === null) {
      next.picture = null;
    }
  }

  if ("balance" in partial) {
    const candidate = partial.balance;
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      next.balance = Math.max(0, Math.trunc(candidate));
    } else if (candidate === null) {
      next.balance = 0;
    }
  }

  next.authenticated = Boolean(next.npub);
  const becameAuthenticated = !current.authenticated && next.authenticated;
  const becameUnauthenticated = current.authenticated && !next.authenticated;

  const currentPorts = Array.isArray(current.ports) ? current.ports : [];
  const portsChanged =
    next.ports.length !== currentPorts.length || next.ports.some((value, index) => value !== currentPorts[index]);

  const changed =
    next.method !== current.method ||
    next.npub !== current.npub ||
    next.expiresAt !== current.expiresAt ||
    next.authenticated !== current.authenticated ||
    next.isAdmin !== current.isAdmin ||
    next.alias !== current.alias ||
    next.picture !== current.picture ||
    portsChanged ||
    next.balance !== (current.balance ?? 0);

  if (!changed) {
    return current;
  }

  state.identity = next;
  if (wasAdmin && !next.isAdmin) {
    state.adminUsers = createAdminUsersState();
  }

  if (next.authenticated && (!next.picture || becameAuthenticated)) {
    void refreshIdentityProfilePicture({ force: becameAuthenticated });
  }

  if (next.npub !== current.npub || next.isAdmin !== current.isAdmin) {
    state.sessionFilters.initialized = false;
    const viewerNormalized = normaliseNpubValue(next.npub);
    if (!next.isAdmin && viewerNormalized) {
      state.sessionFilters.npub = viewerNormalized;
    } else if (!next.isAdmin && !viewerNormalized) {
      state.sessionFilters.npub = "all";
    }
    const ss = sessionsStore();
    if (ss) {
      ss.filters.initialized = false;
      if (!next.isAdmin && viewerNormalized) {
        ss.filters.npub = viewerNormalized;
      } else if (!next.isAdmin && !viewerNormalized) {
        ss.filters.npub = "all";
      }
    }
    state.appFilters.initialized = false;
    state.appFilters.options = [];
    if (viewerNormalized) {
      state.appFilters.npub = viewerNormalized;
    } else {
      state.appFilters.npub = "all";
    }
    const as = appsStore();
    if (as) {
      as.filters.initialized = false;
      as.filters.options = [];
      as.filters.npub = viewerNormalized ?? "all";
    }
  }

  if (persist) {
    persistIdentityState(next);
  }

  syncIdentityDisplay();

  if (emit && typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    try {
      window.dispatchEvent(new CustomEvent("wingman:identity-ui-state", { detail: { ...next } }));
      if (becameAuthenticated) {
        closeIdentityLoginDialog();
        if (currentRoute !== "home") {
          currentRoute = "home";
          if (window.location.pathname !== HOME_ROUTE) {
            window.history.pushState({ route: "home" }, "", HOME_ROUTE);
          }
        }
        render();
      }
    } catch {
      // ignore dispatch errors
    }
  }

  if (becameAuthenticated || becameUnauthenticated) {
    requestPostAuthConfigRefresh();
  }
  if (becameAuthenticated) {
    requestPostAuthSessionsFetch();
    if (next.npub) {
      startSigningListener(next.npub);
    }
  }
  if (becameUnauthenticated) {
    stopSigningListener();
  }

  return next;
};

const handleIdentityCopy = async (event, entryOverride) => {
  if (event?.preventDefault) {
    event.preventDefault();
  }
  const entry = entryOverride ?? (event?.currentTarget ? identityDomEntryByNode.get(event.currentTarget) : null);
  const npub = state.identity.npub;
  if (!npub) {
    if (entry?.copyButton) {
      resetButtonState(entry.copyButton);
    }
    return;
  }
  if (entry?.copyButton) {
    setButtonState(entry.copyButton, { state: "loading", label: "Copying…", disable: true });
  }
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(npub);
      showIdentityCopyFeedback("Copied", { entry });
      return;
    }
  } catch (error) {
    console.warn("[identity] clipboard write failed", error);
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = npub;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    textarea.select();
    const success = document.execCommand("copy");
    textarea.remove();
    if (success) {
      showIdentityCopyFeedback("Copied", { entry });
      return;
    }
  } catch (error) {
    console.warn("[identity] fallback copy failed", error);
  }

  showIdentityCopyFeedback("Copy failed", { error: true, entry });
};

const handleCopyNostrUserId = async (event, entryOverride) => {
  if (event?.preventDefault) {
    event.preventDefault();
  }
  const entry = entryOverride ?? (event?.currentTarget ? identityDomEntryByNode.get(event.currentTarget) : null);
  const npub = state.identity.npub;
  if (!npub) {
    if (entry?.copyNpubButton) {
      resetButtonState(entry.copyNpubButton);
    }
    return;
  }
  if (entry?.copyNpubButton) {
    setButtonState(entry.copyNpubButton, { state: "loading", label: "Copying…", disable: true });
  }
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(npub);
      if (entry?.copyNpubButton) {
        setButtonState(entry.copyNpubButton, { state: "success", label: "Copied!", disable: false });
        setTimeout(() => {
          if (entry?.copyNpubButton) {
            resetButtonState(entry.copyNpubButton);
          }
        }, 2000);
      }
      return;
    }
  } catch (error) {
    console.warn("[identity] clipboard write failed", error);
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = npub;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    textarea.select();
    const success = document.execCommand("copy");
    textarea.remove();
    if (success) {
      if (entry?.copyNpubButton) {
        setButtonState(entry.copyNpubButton, { state: "success", label: "Copied!", disable: false });
        setTimeout(() => {
          if (entry?.copyNpubButton) {
            resetButtonState(entry.copyNpubButton);
          }
        }, 2000);
      }
      return;
    }
  } catch (error) {
    console.warn("[identity] fallback copy failed", error);
  }

  if (entry?.copyNpubButton) {
    setButtonState(entry.copyNpubButton, { state: "error", label: "Copy failed", disable: false });
    setTimeout(() => {
      if (entry?.copyNpubButton) {
        resetButtonState(entry.copyNpubButton);
      }
    }, 2000);
  }
};

const handleCopyNostrPassword = async (event, entryOverride) => {
  if (event?.preventDefault) {
    event.preventDefault();
  }
  const entry = entryOverride ?? (event?.currentTarget ? identityDomEntryByNode.get(event.currentTarget) : null);
  const method = state.identity.method;
  if (method !== "local_keys") {
    if (entry?.copyNsecButton) {
      resetButtonState(entry.copyNsecButton);
    }
    return;
  }
  if (entry?.copyNsecButton) {
    setButtonState(entry.copyNsecButton, { state: "loading", label: "Retrieving…", disable: true });
  }

  try {
    const wingmanIdentity = globalThis.wingmanIdentity;
    if (!wingmanIdentity) {
      throw new Error("Identity API unavailable");
    }

    const session = wingmanIdentity.sessionCache?.load?.();
    if (!session || !session.encryptedNsec) {
      throw new Error("No encrypted key found");
    }

    if (entry?.copyNsecButton) {
      setButtonState(entry.copyNsecButton, { state: "loading", label: "Decrypting…", disable: true });
    }

    const decryptPrivateKeyWithPrompt = wingmanIdentity.crypto?.decryptPrivateKeyWithPrompt;
    if (typeof decryptPrivateKeyWithPrompt !== "function") {
      throw new Error("Decryption unavailable");
    }

    const privateKeyBytes = await decryptPrivateKeyWithPrompt(session.encryptedNsec, {
      reason: "Enter your password to copy your Nostr private key."
    });

    const nip19Module = await import("/vendor/nostr-tools/index.js");
    const nsec = nip19Module.nip19.nsecEncode(privateKeyBytes);

    const wipeBytes = (bytes) => {
      if (!bytes) return;
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = 0;
      }
    };

    if (entry?.copyNsecButton) {
      setButtonState(entry.copyNsecButton, { state: "loading", label: "Copying…", disable: true });
    }

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(nsec);
        if (entry?.copyNsecButton) {
          setButtonState(entry.copyNsecButton, { state: "success", label: "Copied!", disable: false });
          setTimeout(() => {
            if (entry?.copyNsecButton) {
              resetButtonState(entry.copyNsecButton);
            }
          }, 2000);
        }
        wipeBytes(privateKeyBytes);
        return;
      }
    } catch (error) {
      console.warn("[identity] clipboard write failed", error);
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = nsec;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      document.body.append(textarea);
      textarea.select();
      const success = document.execCommand("copy");
      textarea.remove();
      if (success) {
        if (entry?.copyNsecButton) {
          setButtonState(entry.copyNsecButton, { state: "success", label: "Copied!", disable: false });
          setTimeout(() => {
            if (entry?.copyNsecButton) {
              resetButtonState(entry.copyNsecButton);
            }
          }, 2000);
        }
        wipeBytes(privateKeyBytes);
        return;
      }
    } catch (error) {
      console.warn("[identity] fallback copy failed", error);
    }

    wipeBytes(privateKeyBytes);

    if (entry?.copyNsecButton) {
      setButtonState(entry.copyNsecButton, { state: "error", label: "Copy failed", disable: false });
      setTimeout(() => {
        if (entry?.copyNsecButton) {
          resetButtonState(entry.copyNsecButton);
        }
      }, 2000);
    }
  } catch (error) {
    console.error("[identity] failed to copy nsec", error);
    if (entry?.copyNsecButton) {
      const errorMessage = error?.name === "PasswordPromptCancelledError" ? "Cancelled" : "Failed";
      setButtonState(entry.copyNsecButton, { state: "error", label: errorMessage, disable: false });
      setTimeout(() => {
        if (entry?.copyNsecButton) {
          resetButtonState(entry.copyNsecButton);
        }
      }, 2000);
    }
  }
};

const handleIdentityRegister = (event, entryOverride) => {
  if (event?.preventDefault) {
    event.preventDefault();
  }
  const entry = entryOverride ?? (event?.currentTarget ? identityDomEntryByNode.get(event.currentTarget) : null);
  const root = entry?.root ?? document;
  const generateBtn = root.querySelector('[data-action="generate-keys"]');
  if (!generateBtn) {
    window.alert("Registration is unavailable right now. Try an advanced option below.");
    return;
  }
  if (entry?.registerButton) {
    setButtonState(entry.registerButton, {
      state: "loading",
      label: "Registering…",
      disable: true,
      restoreAfterMs: 4000,
    });
  }
  generateBtn.focus?.();
  generateBtn.click();
};

const clearCachedIdentity = () => {
  try {
    globalThis.wingmanIdentity?.sessionCache?.clear?.();
  } catch (error) {
    console.warn("[identity] failed to clear session cache", error);
  }
  try {
    globalThis.wingmanIdentity?.passwordMeta?.clear?.();
  } catch (error) {
    console.warn("[identity] failed to clear password metadata", error);
  }
};

let identityProfileRequest = { npub: null, inFlight: false };

const refreshIdentityProfilePicture = async (options = {}) => {
  const npub = state.identity.npub;
  if (!npub) return;
  const normalized = normaliseNpubValue(npub);
  if (!normalized) return;
  if (identityProfileRequest.inFlight && identityProfileRequest.npub === normalized && !options.force) {
    return;
  }
  identityProfileRequest = { npub: normalized, inFlight: true };
  try {
    const payload = await fetchIdentityProfile({ npub, force: options.force });
    if (payload && typeof payload === "object") {
      if (typeof payload.pictureUrl === "string") {
        updateIdentityState({ picture: payload.pictureUrl }, { persist: true, emit: true });
      } else if (payload.pictureUrl === null) {
        updateIdentityState({ picture: null }, { persist: true, emit: true });
      }
    }
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.warn("[identity] failed to refresh profile picture:", error);
    }
  } finally {
    identityProfileRequest = { npub: normalized, inFlight: false };
  }
};

const forceIdentityLogoutState = () => {
  clearCachedIdentity();
  updateIdentityState(
    { npub: null, method: "none", expiresAt: null, isAuthenticated: false, alias: null, balance: 0 },
    { persist: true, emit: true },
  );
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent("wingman:identity-logout"));
    } catch {
      // ignore dispatch failures
    }
  }
};

const handleUnauthorizedAccess = createUnauthorizedGuard({
  onLogout: () => {
    if (!state.identity.authenticated) {
      return;
    }
    showToast("Session expired. Please log in again.");
    forceIdentityLogoutState();
  },
});

const requestServerLogout = async () => {
  const response = await fetch("/api/auth/session", {
    method: "DELETE",
    credentials: "include",
    headers: { "cache-control": "no-store" },
  });
  if (!response.ok && response.status !== 204) {
    const data = await response.json().catch(() => ({}));
    const message =
      data && typeof data === "object" && typeof data.error === "string"
        ? data.error
        : `Failed to clear session (${response.status})`;
    throw new Error(message);
  }
};

const handleIdentityLogout = async (event, entryOverride) => {
  if (event?.preventDefault) {
    event.preventDefault();
  }
  identityDomEntries.forEach((entry) => {
    if (entry.logoutButton) {
      setButtonState(entry.logoutButton, { state: "loading", label: "Logging out…", disable: true });
    }
  });
  let logoutSuccessful = false;
  const sources = [globalThis.wingmanIdentity, globalThis.identity];
  for (const source of sources) {
    if (source && typeof source.logoutIdentity === "function") {
      try {
        await source.logoutIdentity();
        logoutSuccessful = true;
        break;
      } catch (error) {
        console.error("[identity] logout failed", error);
        const message = error instanceof Error ? error.message : "Failed to sign out";
        window.alert(message);
      }
    }
  }

  if (!logoutSuccessful) {
    try {
      await requestServerLogout();
      logoutSuccessful = true;
    } catch (error) {
      console.error("[identity] server logout failed", error);
      const message = error instanceof Error ? error.message : "Failed to clear session on server.";
      window.alert(message);
    }
  }

  if (logoutSuccessful) {
    forceIdentityLogoutState();
    identityDomEntries.forEach((entry) => {
      if (entry.logoutButton) {
        setButtonState(entry.logoutButton, {
          state: "success",
          label: "Logged out",
          disable: true,
          restoreAfterMs: 1500,
        });
      }
    });
    navigateToHome({ replaceHistory: true, skipMenuClose: true });
  } else {
    identityDomEntries.forEach((entry) => {
      if (entry.logoutButton) {
        setButtonState(entry.logoutButton, {
          state: "error",
          label: "Retry logout",
          disable: false,
          restoreAfterMs: 2500,
        });
      }
    });
  }
};

const detachIdentityDomEntry = (entry) => {
  if (!entry) return;
  if (entry.copyButton && entry.copyHandler) {
    entry.copyButton.removeEventListener("click", entry.copyHandler);
    identityDomEntryByNode.delete(entry.copyButton);
    resetButtonState(entry.copyButton);
  }
  if (entry.registerButton && entry.registerHandler) {
    entry.registerButton.removeEventListener("click", entry.registerHandler);
    identityDomEntryByNode.delete(entry.registerButton);
    resetButtonState(entry.registerButton);
  }
  if (entry.logoutButton && entry.logoutHandler) {
    entry.logoutButton.removeEventListener("click", entry.logoutHandler);
    identityDomEntryByNode.delete(entry.logoutButton);
    resetButtonState(entry.logoutButton);
  }
  const timeoutId = identityCopyFeedbackTimeouts.get(entry);
  if (timeoutId) {
    window.clearTimeout(timeoutId);
    identityCopyFeedbackTimeouts.delete(entry);
  }
};

const pruneIdentityDomEntries = () => {
  const staleEntries = [];
  identityDomEntries.forEach((entry) => {
    if (!entry.root || !entry.root.isConnected) {
      staleEntries.push(entry);
    }
  });
  staleEntries.forEach((entry) => {
    detachIdentityDomEntry(entry);
    identityDomEntries.delete(entry);
  });
  if (staleEntries.length > 0 && identityDomEntries.size === 0) {
    stopIdentityCountdown();
  }
};

const registerIdentityDom = (root) => {
  if (!root) return;
  pruneIdentityDomEntries();
  let existingEntry = null;
  identityDomEntries.forEach((entry) => {
    if (entry.root === root) {
      existingEntry = entry;
    }
  });
  if (existingEntry) {
    detachIdentityDomEntry(existingEntry);
    identityDomEntries.delete(existingEntry);
  }

  const entry = {
    root,
    alias: root.querySelector('[data-role="identity-alias"]'),
    npub: root.querySelector('[data-role="identity-npub"]'),
    details: root.querySelector('[data-role="identity-details"]'),
    registerSection: root.querySelector('[data-role="identity-register"]'),
    method: root.querySelector('[data-role="identity-method"]'),
    balance: root.querySelector('[data-role="identity-balance"]'),
    expiry: root.querySelector('[data-role="identity-expiry"]'),
    copyFeedback: root.querySelector('[data-role="identity-copy-feedback"]'),
    copyButton: root.querySelector('[data-action="copy-active-npub"]'),
    registerButton: root.querySelector('[data-action="identity-register"]'),
    copyNpubButton: root.querySelector('[data-action="copy-nostr-user-id"]'),
    copyNsecButton: root.querySelector('[data-action="copy-nostr-password"]'),
    logoutButton: root.querySelector('[data-action="identity-logout"]'),
    copyHandler: null,
    registerHandler: null,
    copyNpubHandler: null,
    copyNsecHandler: null,
    logoutHandler: null,
  };

  if (entry.copyButton) {
    ensureButtonOriginalLabel(entry.copyButton);
    entry.copyHandler = (event) => {
      void handleIdentityCopy(event, entry);
    };
    entry.copyButton.addEventListener("click", entry.copyHandler);
    identityDomEntryByNode.set(entry.copyButton, entry);
  }

  if (entry.registerButton) {
    ensureButtonOriginalLabel(entry.registerButton);
    entry.registerHandler = (event) => {
      handleIdentityRegister(event, entry);
    };
    entry.registerButton.addEventListener("click", entry.registerHandler);
    identityDomEntryByNode.set(entry.registerButton, entry);
  }

  if (entry.copyNpubButton) {
    ensureButtonOriginalLabel(entry.copyNpubButton);
    entry.copyNpubHandler = (event) => {
      void handleCopyNostrUserId(event, entry);
    };
    entry.copyNpubButton.addEventListener("click", entry.copyNpubHandler);
    identityDomEntryByNode.set(entry.copyNpubButton, entry);
  }

  if (entry.copyNsecButton) {
    ensureButtonOriginalLabel(entry.copyNsecButton);
    entry.copyNsecHandler = (event) => {
      void handleCopyNostrPassword(event, entry);
    };
    entry.copyNsecButton.addEventListener("click", entry.copyNsecHandler);
    identityDomEntryByNode.set(entry.copyNsecButton, entry);
  }

  if (entry.logoutButton) {
    ensureButtonOriginalLabel(entry.logoutButton);
    entry.logoutHandler = (event) => {
      void handleIdentityLogout(event, entry);
    };
    entry.logoutButton.addEventListener("click", entry.logoutHandler);
    identityDomEntryByNode.set(entry.logoutButton, entry);
  }

  identityDomEntries.add(entry);
  syncIdentityDisplayForEntry(entry);
};

const callIdentityWire = (names, element, ...extraArgs) => {
  const nameList = Array.isArray(names) ? names : [names];
  if (!element || typeof element !== "object") return false;
  if (typeof globalThis === "undefined") return false;
  const sources = [globalThis.wingmanIdentity, globalThis.identity, globalThis];
  for (const name of nameList) {
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      const candidate = source[name];
      if (typeof candidate === "function") {
        try {
          candidate(element, ...extraArgs);
          return true;
        } catch (error) {
          console.error(`[identity] Failed to wire ${name}:`, error);
          return true;
        }
      }
    }
  }
  return false;
};

let identityWiringContext = null;

const getIdentityWiringContext = () => {
  if (identityWiringContext) {
    return identityWiringContext;
  }
  identityWiringContext = {
    updateIdentityState,
    getConfig: () => state.config,
    getIdentityState: () => ({ ...state.identity }),
    syncDisplay: syncIdentityDisplay,
    requestBinding: () => {
      pruneIdentityDomEntries();
      identityDomEntries.forEach((entry) => {
        if (entry.root && entry.root.isConnected) {
          bindIdentityFlows(entry.root);
        }
      });
    },
  };
  return identityWiringContext;
};

function bindIdentityFlows(root) {
  if (!root) return;
  const context = getIdentityWiringContext();
  const localPanel = root.querySelector('[data-identity-panel="local"]');
  if (localPanel) {
    callIdentityWire(["wireLocalIdentityPanel"], localPanel, context);
  }
  const nip07Panel = root.querySelector('[data-identity-panel="nip07"]');
  if (nip07Panel) {
    callIdentityWire(["wireNip07Login", "wireNip07Panel", "wireNip07"], nip07Panel, context);
  }
  const bunkerPanel = root.querySelector('[data-identity-panel="bunker"]');
  if (bunkerPanel) {
    callIdentityWire(["wireBunkerLogin"], bunkerPanel, context);
  }
}

const identityWireRequestHandler = () => {
  pruneIdentityDomEntries();
  identityDomEntries.forEach((entry) => {
    if (entry.root && entry.root.isConnected) {
      bindIdentityFlows(entry.root);
    }
  });
};

const handleIdentityEventPayload = (payload) => {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const next = {};
  if ("npub" in payload) {
    next.npub = typeof payload.npub === "string" ? payload.npub : payload.npub === null ? null : undefined;
  } else if (typeof payload.pubkey === "string") {
    next.npub = payload.pubkey;
  }
  if (typeof payload.method === "string") {
    next.method = payload.method;
  }
  if ("expiresAt" in payload || "sessionExpiresAt" in payload || "expiry" in payload) {
    const timestamp = toFiniteTimestamp(
      "expiresAt" in payload
        ? payload.expiresAt
        : "sessionExpiresAt" in payload
          ? payload.sessionExpiresAt
          : payload.expiry,
    );
    next.expiresAt = timestamp;
  }
  if ("isAuthenticated" in payload) {
    next.isAuthenticated = payload.isAuthenticated;
  }
  updateIdentityState(next);
};

const handleIdentityEvent = (event) => {
  if (!event) return;
  if ("detail" in event && event.detail) {
    handleIdentityEventPayload(event.detail);
    return;
  }
  handleIdentityEventPayload(event);
};

const setupIdentityEventBridges = () => {
  if (typeof window === "undefined") return;
  IDENTITY_EVENT_NAMES.forEach((name) => {
    window.addEventListener(name, handleIdentityEvent);
    document.addEventListener(name, handleIdentityEvent);
  });
  window.addEventListener("wingman:identity-refresh", () => {
    syncIdentityDisplay();
  });
  window.addEventListener("wingman:identity-wire-request", identityWireRequestHandler);
};

setupIdentityEventBridges();

const loadPersistedIdentityState = () => {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    const raw = window.localStorage.getItem(IDENTITY_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    updateIdentityState(parsed, { persist: false, emit: false });
  } catch {
    // ignore parse errors
  }
};

loadPersistedIdentityState();

const handleIdentityStorageEvent = (event) => {
  if (!event) return;
  if (event.key !== IDENTITY_STORAGE_KEY) return;
  if (event.newValue) {
    try {
      const parsed = JSON.parse(event.newValue);
      updateIdentityState(parsed, { persist: false, emit: false });
    } catch {
      // ignore parse errors
    }
  } else {
    updateIdentityState({ npub: null, method: "none", expiresAt: null, isAuthenticated: false, alias: null }, { persist: false, emit: false });
  }
};

if (typeof window !== "undefined") {
  window.addEventListener("storage", handleIdentityStorageEvent);
}

const attachIdentityUiApi = () => {
  if (typeof globalThis === "undefined") return;
  const existing =
    typeof globalThis.wingmanIdentityUI === "object" && globalThis.wingmanIdentityUI !== null
      ? globalThis.wingmanIdentityUI
      : {};
  const api = {
    ...existing,
    getState: () => ({ ...state.identity }),
    update: (partial, options) => updateIdentityState(partial, options),
    notify: (partial, options) => updateIdentityState(partial, options),
    bindPanels: () => {
      pruneIdentityDomEntries();
      identityDomEntries.forEach((entry) => {
        if (entry.root && entry.root.isConnected) {
          bindIdentityFlows(entry.root);
        }
      });
    },
    refreshDisplay: () => syncIdentityDisplay(),
  };
  globalThis.wingmanIdentityUI = api;
};

attachIdentityUiApi();

// -- Encoding utilities imported from core/encoding.js --
// -- SVG/icon utilities imported from core/icons.js --

// Thin wrappers closing over state.conversationContainers for scroll utilities
const getConversationScrollElement = (sessionId) =>
  _getConversationScrollElement(sessionId, state.conversationContainers);

const scrollConversationAreaToBottom = (sessionId, options = {}) =>
  _scrollConversationAreaToBottom(sessionId, state.conversationContainers, options);

const scheduleLiveScroll = (sessionId, options = {}) => {
  if (!sessionId || currentRoute !== "live") return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      scrollConversationAreaToBottom(sessionId, options);
    });
  });
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

const initialRouteSessionId = getSessionIdFromPath(window.location.pathname);
if (initialRouteSessionId) {
  state.activeSessionId = initialRouteSessionId;
  state.lastActiveSessionId = initialRouteSessionId;
  const ss = sessionsStore();
  if (ss) {
    ss.activeSessionId = initialRouteSessionId;
    ss.lastActiveSessionId = initialRouteSessionId;
  }
}

const setActiveSession = (sessionId, options = {}) => {
  const { updateHistory = true, logPort = true, allowPending = false, forceLog = false } = options;
  const ss = sessionsStore();
  const previousSessionId = ss?.activeSessionId ?? state.activeSessionId;
  const allSessions = ss?.items ?? state.sessions;

  if (sessionId) {
    const sessionExists = allSessions.some((session) => session.id === sessionId);
    if (!sessionExists && !allowPending) {
      state.activeSessionId = null;
      if (ss) ss.activeSessionId = null;
      lastLoggedSessionId = null;
      syncDesktopSessionIndicator();
      return false;
    }

    state.activeSessionId = sessionId;
    state.lastActiveSessionId = sessionId;
    if (ss) {
      ss.activeSessionId = sessionId;
      ss.lastActiveSessionId = sessionId;
    }

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
  state.activeSessionId = null;
  if (ss) ss.activeSessionId = null;
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
  const ss = sessionsStore();
  const allSessions = ss?.items ?? state.sessions;
  const activeId = ss?.activeSessionId ?? state.activeSessionId;
  const lastId = ss?.lastActiveSessionId ?? state.lastActiveSessionId;

  if (activeId && allSessions.some((session) => session.id === activeId)) {
    return activeId;
  }
  if (lastId && allSessions.some((session) => session.id === lastId)) {
    setActiveSession(lastId, { updateHistory: false, logPort: false });
    return ss?.activeSessionId ?? state.activeSessionId;
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
  return ss?.activeSessionId ?? state.activeSessionId;
};

const applyRouteSessionFromPath = (options = {}) => {
  const { allowHistoryUpdate = false, logPort = true } = options;
  const routeSessionId = getSessionIdFromPath(window.location.pathname);
  const ss = sessionsStore();
  const allSessions = ss?.items ?? state.sessions;
  const activeId = ss?.activeSessionId ?? state.activeSessionId;
  const lastId = ss?.lastActiveSessionId ?? state.lastActiveSessionId;

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
const sessionNameInput = document.getElementById("session-name");
const sessionAdvancedToggle = document.getElementById("session-advanced-toggle");
const sessionAdvancedPanel = document.getElementById("session-advanced-panel");
const sessionWorkspaceModeSelect = document.getElementById("session-workspace-mode");
const sessionWorktreeField = document.querySelector('[data-workspace="worktree"]');
const sessionWorktreeNameInput = document.getElementById("session-worktree-name");
const sessionWorktreeHint = document.getElementById("session-worktree-hint");
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
    return (appsStore()?.items ?? state.apps.items).find((app) => app.root === entry.folderPath) ?? null;
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
  const activeId = sessionsStore()?.activeSessionId ?? state.activeSessionId;
  if (!activeId) return null;
  return (sessionsStore()?.items ?? state.sessions).find((session) => session.id === activeId) ?? null;
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
    const titleActiveId = sessionsStore()?.activeSessionId ?? state.activeSessionId;
    const session = titleActiveId
      ? (sessionsStore()?.items ?? state.sessions).find((s) => s.id === titleActiveId)
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
  if (ss) {
    await ss.sync();
    // Copy store data back to legacy state for code that still reads from it
    state.sessions = ss.items;
    state.sessionFilters.npub = ss.filters.npub;
    state.sessionFilters.options = ss.filters.options;
    state.sessionFilters.initialized = ss.filters.initialized;
  }

  // Handle 401 redirect (store sets items to [] on unauthorized)
  if (ss && ss.items.length === 0 && !ss.initialized) {
    if (currentRoute !== "home") {
      currentRoute = "home";
      if (window.location.pathname !== HOME_ROUTE) {
        window.history.replaceState({ route: "home" }, "", HOME_ROUTE);
      }
    }
    return;
  }

  const allSessions = ss?.items ?? state.sessions;
  const sessionIds = new Set(allSessions.map((session) => session.id));
  const lastId = ss?.lastActiveSessionId ?? state.lastActiveSessionId;
  if (lastId && !sessionIds.has(lastId)) {
    state.lastActiveSessionId = null;
    if (ss) ss.lastActiveSessionId = null;
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
  const activeId = ss?.activeSessionId ?? state.activeSessionId;
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

  const sessionFilterOptions = sessionsStore()?.filters?.options ?? state.sessionFilters.options;
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
  const appFilterOptions = appsStore()?.filters?.options ?? state.appFilters.options;
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
  if (currentRoute === "live" && sessionId === (sessionsStore()?.activeSessionId ?? state.activeSessionId)) {
    updateLogsDOM(sessionId);
  }
};

const fetchConversation = async (sessionId) => {
  try {
    const data = await fetchSessionMessagesApi(sessionId);
    if (!data) return;
    const items = Array.isArray(data?.messages) ? data.messages : [];
    state.conversations.set(sessionId, items);

    // Trigger incremental DOM update if on live route
    if (currentRoute === "live" && sessionId === (sessionsStore()?.activeSessionId ?? state.activeSessionId)) {
      updateConversationDOM(sessionId);
    }
  } catch (error) {
    console.error("Failed to load conversation", error);
  }
};

const fetchApps = async ({ tail = APP_LOG_PREVIEW_LINES } = {}) => {
  const as = appsStore();

  // Delegate API call + Dexie write + filter processing to store
  if (as) {
    await as.sync({ tail });
    // Copy store data back to legacy state for code that still reads from it
    state.apps.items = as.items;
    state.apps.loading = as.loading;
    state.apps.initialized = as.initialized;
    state.apps.error = as.error;
    state.appFilters.npub = as.filters.npub;
    state.appFilters.options = as.filters.options;
    state.appFilters.initialized = as.filters.initialized;
    return;
  }

  // Fallback: direct API call if Alpine store not available
  state.apps.loading = true;
  try {
    const payload = await fetchAppsApi({ tail });
    if (payload.unauthorized) {
      handleUnauthorizedAccess();
      state.apps.items = [];
      state.apps.error = "Unauthorized";
      return;
    }
    state.apps.items = Array.isArray(payload?.apps) ? payload.apps : [];
    state.apps.error = null;
  } catch (error) {
    state.apps.error = error instanceof Error ? error.message : "Failed to load apps";
  } finally {
    state.apps.loading = false;
    state.apps.initialized = true;
  }
};

const fetchRestartStatus = async () => {
  if (!state.identity.isAdmin) {
    state.system.restart.loading = false;
    state.system.restart.inProgress = false;
    state.system.restart.marker = null;
    state.system.restart.outcome = null;
    state.system.restart.error = null;
    return;
  }
  state.system.restart.loading = true;
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
    state.system.restart.inProgress = Boolean(payload?.inProgress);
    state.system.restart.marker = payload?.marker ?? null;
    state.system.restart.outcome = payload?.outcome ?? null;
    state.system.restart.error = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load restart status";
    state.system.restart.error = message;
  } finally {
    state.system.restart.loading = false;
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
  if (state.apps.loading) return;
  if (!state.apps.initialized) {
    await refreshApps({ skipRender: false });
  }
};

// Apps polling has been replaced by Dexie-backed Alpine store with liveQuery.
// These stubs remain for callers that haven't been updated yet.
const syncAppsPolling = () => {};

const pollSessions = async () => {
  try {
    const allSessions = sessionsStore()?.items ?? state.sessions;
    const previousSessionCount = allSessions.length;
    const previousSessionIds = allSessions.map(s => s.id).join(',');

    await fetchSessions();
    syncMenuTabs();
    syncDesktopSessionIndicator();

    const updatedSessions = sessionsStore()?.items ?? state.sessions;
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

    const activeId = sessionsStore()?.activeSessionId ?? state.activeSessionId;
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

const startConversationPolling = (sessionId) => {
  stopConversationPolling();
  if (!sessionId) return;

  console.log(`[poll] Starting conversation polling for ${sessionId}`);

  conversationPollIntervalId = window.setInterval(async () => {
    if (conversationPollInFlight) return;
    const pollingActiveId = sessionsStore()?.activeSessionId ?? state.activeSessionId;
    if (currentRoute !== "live" || pollingActiveId !== sessionId) {
      stopConversationPolling();
      return;
    }

    conversationPollInFlight = true;
    try {
      // Fetch conversation, session status, and queue in parallel
      const [, sessionData, queueData] = await Promise.all([
        fetchConversation(sessionId),
        fetchSessionApi(sessionId),
        fetchSessionQueueApi(sessionId),
      ]);

      // Update session status if we got data
      if (sessionData) {
        const session = (sessionsStore()?.items ?? state.sessions).find((s) => s.id === sessionId);
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
      console.warn("[poll] Conversation poll failed:", err);
    } finally {
      conversationPollInFlight = false;
    }
  }, CONVERSATION_POLL_INTERVAL);
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
  isAuthenticated: () => Boolean(state.identity.authenticated),
  getConfig: () => state.config,
  getFallbackDirectory: getSessionFallbackDirectory,
  onRequireAuth: openIdentityLoginDialog,
  onDirectoryPrefill: (...args) => scheduleDirectorySuggestions(...args),
  onSubmit: ({ agentId, workingDirectory, sessionName, workspace }) => {
    launchSession(agentId, workingDirectory, sessionName, workspace);
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
  const session = state.sessions.find((item) => item.id === sessionId);
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
        requestAnimationFrame(() => textarea.focus());
      }
      await fetchLogs(sessionId);
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
          textarea.focus();
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

    // Trigger incremental updates instead of full render
    updateConversationDOM(sessionId);
    requestAnimationFrame(() => {
      scrollConversationAreaToBottom(sessionId, { includeWindow: true });
    });
    await fetchLogs(sessionId);

    const textarea = document.querySelector('.wm-composer textarea');
    if (textarea) {
      textarea.value = "";
      textarea.style.height = "auto";
      requestAnimationFrame(() => {
        textarea.focus();
      });
    }
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Failed to send message to agent.";
    console.error("Failed to send agent message", error);
    window.alert(`Agent request failed: ${message}`);
  }
};

const sendControlCommand = async (sessionId, action) => {
  const session = state.sessions.find((item) => item.id === sessionId);
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

const getAppById = (appId) => (appsStore()?.items ?? state.apps.items).find((item) => item?.id === appId) ?? null;

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
  if (state.system.restart.submitting || state.system.restart.inProgress) {
    return false;
  }
  state.system.restart.submitting = true;
  try {
    await triggerWarmRestartApi();
    state.system.restart.inProgress = true;
    state.system.restart.error = null;
    await fetchRestartStatus();
    if (currentRoute === "apps") {
      render();
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to initiate restart";
    state.system.restart.error = message;
    window.alert(message);
    return false;
  } finally {
    state.system.restart.submitting = false;
  }
};

const runSystemCleanup = async () => {
  if (state.system.cleanup.running) {
    return false;
  }
  state.system.cleanup.running = true;
  state.system.cleanup.error = null;
  if (currentRoute === "apps") {
    render();
  }
  try {
    const payload = await runSystemCleanupApi();
    state.system.cleanup.result = payload;
    state.system.cleanup.error = null;
    await Promise.all([
      fetchSessions(),
      refreshApps({ skipRender: true }),
    ]);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to stop agents and apps";
    state.system.cleanup.error = message;
    window.alert(message);
    return false;
  } finally {
    state.system.cleanup.running = false;
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
  const restartInProgress = state.system.restart.inProgress;
  const cleanupState = state.system.cleanup;
  const cleanupRunning = cleanupState.running;
  const statusValue = restartInProgress ? "restarting" : app?.status?.status ?? "running";
  statusBadge.dataset.state = statusValue;
  statusBadge.textContent = APP_STATUS_LABELS[statusValue] ?? statusValue;
  header.append(statusBadge);
  card.append(header);

  const statusInfo = document.createElement("div");
  statusInfo.className = "wm-app-status-info";

  if (state.system.restart.error) {
    const errorLine = document.createElement("p");
    errorLine.className = "wm-app-status-error";
    errorLine.textContent = state.system.restart.error;
    statusInfo.append(errorLine);
  } else if (restartInProgress) {
    const progressLine = document.createElement("p");
    const sessionCount = Array.isArray(state.system.restart.marker?.sessionIds)
      ? state.system.restart.marker.sessionIds.length
      : null;
    progressLine.textContent =
      sessionCount && sessionCount > 0
        ? `Warm restart in progress… preserving ${sessionCount} active session${sessionCount === 1 ? "" : "s"}.`
        : "Warm restart in progress… Wingman will reload without interrupting active sessions.";
    statusInfo.append(progressLine);
  } else if (state.system.restart.outcome) {
    const outcome = state.system.restart.outcome;
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

  const marker = state.system.restart.marker;
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
    state.system.restart.submitting || restartInProgress || cleanupRunning;
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
    const cleanupDisabled = cleanupRunning || restartInProgress || state.system.restart.submitting;
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
    if (state.apps.pendingOpenDialog === "create") {
      state.apps.pendingOpenDialog = null;
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
        const currentAppFilter = appsStore()?.filters?.npub ?? state.appFilters.npub;
        if (option.value === currentAppFilter) {
          opt.selected = true;
        }
        filterSelect.append(opt);
      });
      filterSelect.addEventListener("change", (event) => {
        const target = event.target;
        const value = target instanceof HTMLSelectElement && target.value ? target.value : "all";
        state.appFilters.npub = value;
        state.appFilters.initialized = true;
        const as = appsStore();
        if (as) {
          as.filters.npub = value;
          as.filters.initialized = true;
        }
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
  refreshButton.textContent = state.apps.loading ? "Refreshing…" : "Refresh";
  refreshButton.disabled = state.apps.loading;
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

  if (!state.apps.initialized && !state.apps.loading) {
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

  if (state.apps.error) {
    const errorBox = document.createElement("div");
    errorBox.className = "wm-apps-error";
    const errorText = document.createElement("p");
    errorText.textContent = state.apps.error;
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

  const apps = Array.isArray(state.apps.items) ? state.apps.items : [];
  if (state.apps.loading && apps.length === 0) {
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
    if (!state.apps.pendingFocusId) {
      return;
    }
    const targetId = state.apps.pendingFocusId;
    state.apps.pendingFocusId = null;
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
        if (currentRoute === "live" && (sessionsStore()?.activeSessionId ?? state.activeSessionId)) {
          sseManager.connect(sessionsStore()?.activeSessionId ?? state.activeSessionId);
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
          textarea.focus();
        }
      }
      setActiveNav();
      syncMenuTabs();
      syncDesktopSessionIndicator();
      // Hide header webview toggle when not on live route (renderLive handles showing it)
      if (currentRoute !== "live") {
        syncHeaderWebviewToggle(null);
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
});
renderFiles = filesViewModule.renderFiles;

const liveViewModule = initLiveView({
  sessionsStore,
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
  scheduleLiveScroll,
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
  ace,
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
    state.apps.pendingOpenDialog = "create";
  }
  if (focusAppId) {
    state.apps.pendingFocusId = focusAppId;
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
      const navSessions = ss?.items ?? state.sessions;
      const navActiveId = ss?.activeSessionId ?? state.activeSessionId;
      const navLastId = ss?.lastActiveSessionId ?? state.lastActiveSessionId;
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
    } else if (targetRoute === "files") {
      // If navigating from live page with an active session, start in that session's directory
      const activeSession = currentRoute === "live" ? getActiveSessionForIndicator() : null;
      const sessionDir = activeSession?.workingDirectory;
      stopConversationPolling();
      currentRoute = "files";
      lastLoggedSessionId = null;
      if (window.location.pathname !== FILES_ROUTE) {
        window.history.pushState({ route: "files" }, "", FILES_ROUTE);
      }
      if (!state.files.initialized) {
        state.files.initialized = true;
        void loadFilesTree(sessionDir);
      } else if (sessionDir) {
        // Already initialized but coming from live with a session directory - navigate there
        void loadFilesTree(sessionDir);
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
  const scrollActiveId = sessionsStore()?.activeSessionId ?? state.activeSessionId;
  if (!scrollActiveId) {
    return;
  }
  scheduleLiveScroll(scrollActiveId, { includeWindow: true });
};

window.addEventListener("focus", scrollLiveViewIfVisible);

// Initialize visibility manager for SSE reconnection on tab return
visibilityManager.init({
  getSessionId: () => sessionsStore()?.activeSessionId ?? state.activeSessionId,
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
    if (!state.files.initialized) {
      state.files.initialized = true;
      void loadFilesTree();
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
    if (!isFeatureEnabledForViewer("nightwatch_enabled")) {
      currentRoute = "home";
      if (window.location.pathname !== HOME_ROUTE) {
        window.history.replaceState({ route: "home" }, "", HOME_ROUTE);
      }
    } else {
      void ensureNightWatchPageLoaded();
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

  // Wire SSE status events to knight rider and status indicators
  sseManager.onStatusChange((sessionId, status) => {
    const session = (sessionsStore()?.items ?? state.sessions).find((s) => s.id === sessionId);
    if (session) {
      session.agentRuntimeStatus = status;
      updateAgentStatusIndicators();
    }
  });

  // Wire SSE message events to update conversation state
  sseManager.onMessage((sessionId, message) => {
    const existing = state.conversations.get(sessionId) || [];
    // Check if this is a new message or an update to the last message
    const lastMessage = existing[existing.length - 1];
    const isStreamingUpdate = lastMessage &&
      lastMessage.role === (message.role || message.type) &&
      message.content?.startsWith(lastMessage.content?.slice(0, 50));

    if (isStreamingUpdate) {
      // Update last message content (streaming)
      lastMessage.content = message.content || message.message || "";
    } else {
      // Add new message
      existing.push({
        role: message.role || message.type || "assistant",
        content: message.content || message.message || "",
        createdAt: message.createdAt || new Date().toISOString(),
      });
    }
    state.conversations.set(sessionId, existing);

    // Update DOM if on live view with this session active
    if (currentRoute === "live" && sessionId === (sessionsStore()?.activeSessionId ?? state.activeSessionId)) {
      updateConversationDOM(sessionId);
    }
  });

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
  if (orchestratorFeatureEnabledForViewer()) {
    await refreshOrchestratorPresets();
  }
  await fetchSessions();
  // Always fetch apps for authenticated users (needed for CMD menu app actions)
  if (state.identity.authenticated) {
    await fetchApps({ tail: APP_LOG_PREVIEW_LINES });
    // Also fetch npub projects for app fallback matching
    fetchNpubProjects().catch(() => {});
    // Start NIP-98 signing listener for Tier 2 agent delegation
    if (state.identity.npub) {
      startSigningListener(state.identity.npub);
    }
  } else if (currentRoute === "apps") {
    await fetchApps({ tail: APP_LOG_PREVIEW_LINES });
  }
  render();
})();
