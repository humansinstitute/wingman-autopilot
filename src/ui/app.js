import "/ace-builds/src-noconflict/ace.js";
import "/ace-builds/src-noconflict/mode-text.js";
import "/ace-builds/src-noconflict/theme-chrome.js";
import "/ace-builds/src-noconflict/theme-tomorrow_night.js";
import "./identity/index.js";
import { applyAvatarImage } from "./utils/avatar.js";
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
  getChatTemplate,
} from "./live/index.js";
import {
  findAppForSession,
  findWebAppForSession,
  createWebviewIcon,
  createWebviewPanel,
  createLayoutToolbar,
} from "./live/webview-panel.js";
import { createHomeGuestHero } from "./home/hero.js";
import { createArchiveComponent } from "./home/archive.js";
import { createUnauthorizedGuard } from "./common/unauthorized-guard.js";
import { createSessionDialogController } from "./common/session-dialog.js";
import { initOrchestratorUI } from "./orchestrator/index.js";
import { initAppDialogs } from "./apps/dialog.js";
import { initWorkspaceTree } from "./apps/tree.js";
import {
  initFeatureFlagsUI,
  ORCHESTRATOR_FLAG_KEY,
} from "./feature-flags/index.js";
import { addNightWatchToggle } from "./nightwatch/cmd-toggle.js";
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
  TERMINAL_CONTROL_ACTIONS,
} from "./state/index.js";
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
  fetchSessionHistoryApi,
  stopSessionApi,
  deleteSessionApi,
  updateSessionNameApi,
  postSessionMessageApi,
  fetchSessionQueueApi,
  addToSessionQueueApi,
  removeFromSessionQueueApi,
  updateSessionQueuePromptApi,
  forkSessionToWorktreeApi,
} from "./services/sessions.js";
import {
  fetchAppsApi,
  fetchAppLogsApi,
  triggerAppActionApi,
  removeAppApi,
} from "./services/apps.js";
import {
  CHAT_ROUTE_PREFIX,
  getChatIdFromPath,
  buildChatUrl,
  isChatRoute,
  createChatDialogController,
  fetchChatsApi,
  fetchChatMessagesApi,
  postChatMessageApi,
  deleteChatApi,
  streamChatResponse,
} from "./chat/index.js";

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
let chatDialogController = null;
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

let projectFeature = null;
let archiveComponent = null;

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

const getAdminUserKey = (user) => {
  if (!user || typeof user !== "object") return null;
  return normaliseNpubValue(user.normalizedNpub ?? user.npub);
};

const ensureAdminSelectionState = () => {
  if (!(state.adminUsers.selection instanceof Set)) {
    state.adminUsers.selection = new Set();
  }
  return state.adminUsers.selection;
};

const syncAdminSelectionState = (users) => {
  const selection = ensureAdminSelectionState();
  if (!Array.isArray(users)) {
    selection.clear();
    return;
  }
  const validKeys = new Set();
  users.forEach((user) => {
    const key = getAdminUserKey(user);
    if (key) {
      validKeys.add(key);
    }
  });
  Array.from(selection).forEach((key) => {
    if (!validKeys.has(key)) {
      selection.delete(key);
    }
  });
};

const setAdminUserSelected = (key, selected) => {
  if (!key) return;
  const selection = ensureAdminSelectionState();
  if (selected) {
    selection.add(key);
  } else {
    selection.delete(key);
  }
};

const clearAdminSelection = () => {
  ensureAdminSelectionState().clear();
};

const getAdminSelectedUsers = () => {
  const items = Array.isArray(state.adminUsers.items) ? state.adminUsers.items : [];
  const selection = ensureAdminSelectionState();
  return items.filter((user) => {
    const key = getAdminUserKey(user);
    return key ? selection.has(key) : false;
  });
};

const getAdminSelectionCount = () => ensureAdminSelectionState().size;

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

const textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { fatal: false }) : null;
const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

const decodeBase64ToUint8Array = (value) => {
  if (!value) return new Uint8Array(0);
  try {
    const binary = atob(value);
    const length = binary.length;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
};

const encodeUint8ArrayToBase64 = (bytes) => {
  if (!bytes || bytes.length === 0) return "";
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const decodeBytesToText = (bytes) => {
  if (!bytes || bytes.length === 0) return "";
  if (textDecoder) {
    try {
      return textDecoder.decode(bytes);
    } catch {
      // fall through to manual decoding
    }
  }
  let result = "";
  for (let i = 0; i < bytes.length; i += 1) {
    result += String.fromCharCode(bytes[i]);
  }
  return result;
};

const encodeTextToBytes = (text) => {
  if (!text || text.length === 0) return new Uint8Array(0);
  if (textEncoder) {
    try {
      return textEncoder.encode(text);
    } catch {
      // fall through to manual encoding
    }
  }
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
};

const readFileAsUint8Array = (file) =>
  new Promise((resolve, reject) => {
    if (!(file instanceof File)) {
      reject(new Error("Invalid file input"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      reader.abort();
      reject(new Error("Failed to read file"));
    };
    reader.onload = () => {
      const { result } = reader;
      if (result instanceof ArrayBuffer) {
        resolve(new Uint8Array(result));
        return;
      }
      if (ArrayBuffer.isView(result)) {
        resolve(new Uint8Array(result.buffer));
        return;
      }
      reject(new Error("Unsupported file result"));
    };
    reader.readAsArrayBuffer(file);
  });

const SVG_NS = "http://www.w3.org/2000/svg";

const createSvgShape = (tag, attributes = {}) => {
  const element = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => {
    element.setAttribute(key, String(value));
  });
  if (!attributes.fill) {
    element.setAttribute("fill", "none");
  }
  if (!attributes.stroke) {
    element.setAttribute("stroke", "currentColor");
  }
  if (!attributes["stroke-width"]) {
    element.setAttribute("stroke-width", "1.8");
  }
  if ((tag === "path" || tag === "line" || tag === "polyline") && !attributes["stroke-linecap"]) {
    element.setAttribute("stroke-linecap", "round");
  }
  if ((tag === "path" || tag === "polyline") && !attributes["stroke-linejoin"]) {
    element.setAttribute("stroke-linejoin", "round");
  }
  if ((tag === "circle" || tag === "ellipse") && !attributes["stroke-linecap"]) {
    element.setAttribute("stroke-linecap", "round");
  }
  if ((tag === "circle" || tag === "ellipse") && !attributes["stroke-linejoin"]) {
    element.setAttribute("stroke-linejoin", "round");
  }
  return element;
};

const createIconSvg = (definition) => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("wm-icon");
  definition.forEach(([tag, attrs]) => {
    svg.append(createSvgShape(tag, attrs));
  });
  return svg;
};

const FILE_BROWSER_ICON_DEFS = {
  arrowUp: [
    ["line", { x1: 12, y1: 19, x2: 12, y2: 7 }],
    ["polyline", { points: "6 11 12 5 18 11" }],
  ],
  refresh: [
    ["polyline", { points: "23 4 23 10 17 10" }],
    ["path", { d: "M20.49 15a9 9 0 1 1-2.12-9.36" }],
  ],
  eye: [
    ["ellipse", { cx: 12, cy: 12, rx: 9.5, ry: 6.5 }],
    ["circle", { cx: 12, cy: 12, r: 2.5 }],
  ],
  eyeOff: [
    ["ellipse", { cx: 12, cy: 12, rx: 9.5, ry: 6.5 }],
    ["circle", { cx: 12, cy: 12, r: 2.5 }],
    ["line", { x1: 4, y1: 4, x2: 20, y2: 20 }],
  ],
  folder: [
    ["path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" }],
    ["path", { d: "M3 7h18" }],
  ],
  file: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
  ],
  fileText: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
    ["line", { x1: 16, y1: 13, x2: 8, y2: 13 }],
    ["line", { x1: 16, y1: 17, x2: 8, y2: 17 }],
    ["path", { d: "M10 9h4" }],
  ],
  fileCode: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
    ["polyline", { points: "10 13 8 15 10 17" }],
    ["polyline", { points: "14 17 16 15 14 13" }],
  ],
  ban: [
    ["circle", { cx: 12, cy: 12, r: 9 }],
    ["line", { x1: 5, y1: 19, x2: 19, y2: 5 }],
  ],
  folderPlus: [
    ["path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" }],
    ["path", { d: "M12 11v4" }],
    ["path", { d: "M10 13h4" }],
  ],
  filePlus: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
    ["path", { d: "M12 13v4" }],
    ["path", { d: "M10 15h4" }],
  ],
  upload: [
    ["path", { d: "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" }],
    ["polyline", { points: "16 6 12 2 8 6" }],
    ["line", { x1: 12, y1: 2, x2: 12, y2: 16 }],
  ],
  branchPlus: [
    ["circle", { cx: 6, cy: 6, r: 2.5 }],
    ["circle", { cx: 6, cy: 18, r: 2.5 }],
    ["circle", { cx: 18, cy: 12, r: 2.5 }],
    ["line", { x1: 6, y1: 8.5, x2: 6, y2: 15.5 }],
    ["path", { d: "M8.5 8.5a5 5 0 0 1 5.5 4.5" }],
    ["line", { x1: 18, y1: 14.5, x2: 18, y2: 20 }],
    ["line", { x1: 16, y1: 17, x2: 20, y2: 17 }],
  ],
};

const setIconButton = (button, iconKey, label) => {
  const definition = FILE_BROWSER_ICON_DEFS[iconKey];
  if (!definition) return;
  while (button.firstChild) {
    button.removeChild(button.firstChild);
  }
  button.append(createIconSvg(definition));
  if (label) {
    button.setAttribute("aria-label", label);
    button.title = label;
  } else {
    button.removeAttribute("aria-label");
    button.removeAttribute("title");
  }
};

let aceEditorInstance = null;

const getSessionDisplayName = (session) => {
  if (!session || typeof session !== "object") return "";
  const rawName = typeof session.name === "string" ? session.name.trim() : "";
  if (rawName.length > 0) return rawName;
  const agent = typeof session.agent === "string" ? session.agent : "agent";
  const port = typeof session.port === "number" ? session.port : "";
  return port ? `${agent} :${port}` : agent;
};

const truncateText = (value, maxLength = 31) => {
  if (typeof value !== "string") return "";
  if (value.length <= maxLength) return value;
  const safeLength = Math.max(0, maxLength - 3);
  return `${value.slice(0, safeLength)}...`;
};

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

const scrollConversationAreaToBottom = (sessionId, options = {}) => {
  const { includeWindow = false } = options;
  const target =
    getConversationScrollElement(sessionId) ??
    document.querySelector('.wm-live-conversation');
  if (target) {
    scrollConversationToBottom(target);
  }
  if (includeWindow) {
    const fallback = document.scrollingElement || document.documentElement || document.body;
    if (fallback && fallback !== target) {
      scrollConversationToBottom(fallback);
    }
  }
};
const scheduleLiveScroll = (sessionId, options = {}) => {
  if (!sessionId || currentRoute !== "live") return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      scrollConversationAreaToBottom(sessionId, options);
    });
  });
};

const isConversationScrolledToBottom = (sessionId) => {
  const scrollElement = getConversationScrollElement(sessionId);
  if (!scrollElement) {
    // If no scroll element, check main document
    const doc = document.scrollingElement || document.documentElement || document.body;
    const threshold = 50;
    return doc.scrollHeight - doc.scrollTop - doc.clientHeight < threshold;
  }
  const threshold = 50;
  return scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight < threshold;
};

const isMobileFilesLayout = () => {
  if (window.matchMedia) {
    try {
      return window.matchMedia("(max-width: 720px)").matches;
    } catch {
      // fall through to manual check
    }
  }
  return window.innerWidth <= 720;
};

const escapeHtml = (value) => {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const escapeAttribute = (value) => {
  if (value === null || value === undefined) return "#";
  const trimmed = String(value).trim();
  const allowed = /^(https?:\/\/|\/|#|mailto:|tel:)/i;
  const safe = allowed.test(trimmed) ? trimmed : "#";
  return escapeHtml(safe).replace(/"/g, "&quot;");
};

const sanitizeLanguageClass = (value) => {
  if (!value) return "";
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "");
};

const renderInlineMarkdown = (text) => {
  if (!text) return "";
  let working = String(text);
  const placeholders = [];
  const createPlaceholder = (html) => {
    const token = `@@MD${placeholders.length}@@`;
    placeholders.push(html);
    return token;
  };

  working = working.replace(/`([^`]+)`/g, (_, code) =>
    createPlaceholder(`<code>${escapeHtml(code)}</code>`),
  );

  working = working.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const safeUrl = escapeAttribute(url);
    const safeLabel = escapeHtml(label);
    return createPlaceholder(
      `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`,
    );
  });

  working = working.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, (_, __, content) =>
    createPlaceholder(`<strong>${renderInlineMarkdown(content)}</strong>`),
  );

  working = working.replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, (_, __, content) =>
    createPlaceholder(`<em>${renderInlineMarkdown(content)}</em>`),
  );

  working = working.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, (_, content) =>
    createPlaceholder(`<del>${renderInlineMarkdown(content)}</del>`),
  );

  const escaped = escapeHtml(working);
  return escaped.replace(/@@MD(\d+)@@/g, (_, index) => placeholders[Number(index)] ?? "");
};

const renderMarkdownToHtml = (markdown) => {
  if (!markdown) return "";
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let inCodeBlock = false;
  let codeLanguage = "";
  let codeBuffer = [];
  let listType = null;
  let listItems = [];
  let paragraph = "";
  let inBlockquote = false;

  const closeParagraph = () => {
    if (paragraph) {
      html += `<p>${paragraph.trim()}</p>`;
      paragraph = "";
    }
  };

  const closeList = () => {
    if (listType && listItems.length > 0) {
      html += `<${listType}>${listItems.join("")}</${listType}>`;
    }
    listType = null;
    listItems = [];
  };

  const closeBlockquote = () => {
    if (inBlockquote) {
      html += "</blockquote>";
      inBlockquote = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        const languageClass = sanitizeLanguageClass(codeLanguage);
        const classAttr = languageClass ? ` class="language-${languageClass}"` : "";
        html += `<pre><code${classAttr}>${escapeHtml(codeBuffer.join("\n"))}\n</code></pre>`;
        inCodeBlock = false;
        codeLanguage = "";
        codeBuffer = [];
      } else {
        closeParagraph();
        closeList();
        closeBlockquote();
        inCodeBlock = true;
        codeLanguage = line.slice(3).trim();
        codeBuffer = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(rawLine);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      closeParagraph();
      closeList();
      closeBlockquote();
      continue;
    }

    if (trimmed.startsWith(">")) {
      closeParagraph();
      closeList();
      if (!inBlockquote) {
        inBlockquote = true;
        html += "<blockquote>";
      }
      const quote = trimmed.replace(/^>\s?/, "");
      html += `<p>${renderInlineMarkdown(quote)}</p>`;
      continue;
    }

    if (inBlockquote) {
      closeBlockquote();
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      closeParagraph();
      closeList();
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      html += `<h${level}>${renderInlineMarkdown(text)}</h${level}>`;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeParagraph();
      closeList();
      html += "<hr />";
      continue;
    }

    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (orderedMatch) {
      closeParagraph();
      const content = renderInlineMarkdown(orderedMatch[2]);
      if (listType !== "ol") {
        closeList();
        listType = "ol";
      }
      listItems.push(`<li>${content}</li>`);
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      closeParagraph();
      const content = renderInlineMarkdown(unorderedMatch[1]);
      if (listType !== "ul") {
        closeList();
        listType = "ul";
      }
      listItems.push(`<li>${content}</li>`);
      continue;
    }

    closeList();
    if (paragraph) {
      paragraph += ` ${renderInlineMarkdown(trimmed)}`;
    } else {
      paragraph = renderInlineMarkdown(trimmed);
    }
  }

  if (inCodeBlock) {
    const languageClass = sanitizeLanguageClass(codeLanguage);
    const classAttr = languageClass ? ` class="language-${languageClass}"` : "";
    html += `<pre><code${classAttr}>${escapeHtml(codeBuffer.join("\n"))}\n</code></pre>`;
  }
  closeParagraph();
  closeList();
  closeBlockquote();
  return html.trim();
};

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

const CODE_KEYWORDS = {
  javascript: [
    "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
    "else", "export", "extends", "finally", "for", "from", "function", "if", "import", "in", "instanceof",
    "let", "new", "return", "super", "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with", "yield", "await",
  ],
  typescript: [
    "abstract", "any", "as", "asserts", "async", "await", "boolean", "break", "case", "catch", "class", "const",
    "constructor", "continue", "declare", "default", "delete", "do", "else", "enum", "export", "extends", "false",
    "finally", "for", "from", "function", "get", "if", "implements", "import", "in", "infer", "instanceof", "interface",
    "is", "keyof", "let", "module", "namespace", "never", "new", "null", "number", "object", "package", "private", "protected",
    "public", "readonly", "require", "return", "set", "static", "string", "super", "switch", "symbol", "this", "throw", "true",
    "try", "type", "typeof", "undefined", "unique", "unknown", "var", "void", "while", "with", "yield",
  ],
  go: [
    "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go",
    "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
  ],
  json: ["true", "false", "null"],
  yaml: ["true", "false", "null", "yes", "no", "on", "off"],
  toml: ["true", "false"],
  ini: ["true", "false"],
  rust: [
    "as", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let",
    "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait",
    "true", "type", "unsafe", "use", "where", "while",
  ],
  python: [
    "and", "as", "assert", "break", "class", "continue", "def", "del", "elif", "else", "except", "False", "finally", "for",
    "from", "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return",
    "True", "try", "while", "with", "yield",
  ],
  shell: [
    "if", "then", "else", "elif", "fi", "for", "while", "in", "do", "done", "case", "esac", "function", "select",
  ],
  css: ["@import", "@media", "@supports", "@keyframes", "from", "to"],
  html: ["doctype", "html", "head", "body", "div", "span", "script", "style", "link", "meta", "title"],
  plaintext: [],
};

const buildKeywordPattern = (keywords) => {
  if (!keywords || keywords.length === 0) return null;
  const escaped = keywords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "g");
};

const CODE_KEYWORD_PATTERNS = Object.fromEntries(
  Object.entries(CODE_KEYWORDS).map(([language, keywords]) => [language, buildKeywordPattern(keywords)]),
);

const renderCodeToHtml = (content, language = "plaintext") => {
  const normalizedLanguage = CODE_KEYWORDS[language] ? language : "plaintext";
  const escaped = escapeHtml(content ?? "");
  const replacements = [];
  const createToken = (html) => {
    const token = `__WM_TOKEN_${replacements.length}__`;
    replacements.push({ token, html });
    return token;
  };

  let working = escaped;

  if (normalizedLanguage === "json") {
    working = working.replace(/(&quot;[^&]*?&quot;)(?=\s*:)/g, (match) =>
      createToken(`<span class="token key">${match}</span>`),
    );
  } else if (normalizedLanguage === "yaml" || normalizedLanguage === "toml" || normalizedLanguage === "ini") {
    working = working.replace(/^(\s*)([^\s:#][^:]*)(?=\s*:)/gm, (full, indent, key) => {
      return `${indent}${createToken(`<span class="token key">${key}</span>`)}`;
    });
  }

  if (
    normalizedLanguage === "javascript" ||
    normalizedLanguage === "typescript" ||
    normalizedLanguage === "go" ||
    normalizedLanguage === "rust"
  ) {
    working = working.replace(/(\/\/[^\n]*)/g, (match) => createToken(`<span class="token comment">${match}</span>`));
    working = working.replace(/(\/\*[\s\S]*?\*\/)/g, (match) =>
      createToken(`<span class="token comment">${match}</span>`),
    );
  }

  if (
    normalizedLanguage === "python" ||
    normalizedLanguage === "shell" ||
    normalizedLanguage === "yaml" ||
    normalizedLanguage === "toml" ||
    normalizedLanguage === "ini"
  ) {
    working = working.replace(/(^|\s)(#[^\n]*)/gm, (full, prefix, comment) => {
      return `${prefix}${createToken(`<span class="token comment">${comment}</span>`)}`;
    });
  }

  working = working.replace(/(&quot;.*?&quot;)/g, (match) => createToken(`<span class="token string">${match}</span>`));
  working = working.replace(/(&#39;.*?&#39;)/g, (match) => createToken(`<span class="token string">${match}</span>`));
  working = working.replace(/`[^`]*`/g, (match) => createToken(`<span class="token string">${match}</span>`));

  working = working.replace(/\b(0x[a-fA-F0-9]+|\d+\.\d+|\d+)\b/g, '<span class="token number">$1</span>');

  const keywordPattern = CODE_KEYWORD_PATTERNS[normalizedLanguage];
  if (keywordPattern) {
    working = working.replace(keywordPattern, '<span class="token keyword">$1</span>');
  }

  replacements.forEach(({ token, html }) => {
    working = working.replaceAll(token, html);
  });

  return `<pre><code class="language-${normalizedLanguage}">${working}</code></pre>`;
};

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

const getWorktreeGitInfo = () => {
  const git = state.files.git;
  if (!git || typeof git !== "object") return null;
  return git;
};

const canCreateWorktree = () => {
  const git = getWorktreeGitInfo();
  if (!git) return false;
  return Boolean(git.isRepoRoot && git.hasGitMetadata);
};

const resetWorktreeModalState = (defaults = {}) => {
  const modal = state.files.worktreeModal;
  modal.branch = typeof defaults.branch === "string" ? defaults.branch : "";
  modal.startPoint = typeof defaults.startPoint === "string" ? defaults.startPoint : "";
  modal.error = null;
  modal.submitting = false;
};

const openWorktreeModal = () => {
  if (!canCreateWorktree()) return;
  const git = getWorktreeGitInfo();
  const modal = state.files.worktreeModal;
  resetWorktreeModalState({
    branch: "",
    startPoint: git?.currentBranch && git.currentBranch !== "HEAD" ? git.currentBranch : git?.headRef ?? "",
  });
  modal.open = true;
  renderWorktreeModal();
};

const closeWorktreeModal = () => {
  const modal = state.files.worktreeModal;
  if (!modal.open) return;
  modal.open = false;
  resetWorktreeModalState();
  renderWorktreeModal();
};

const requestCreateWorktree = async () => {
  const files = state.files;
  const git = getWorktreeGitInfo();
  if (!git) return;
  const modal = files.worktreeModal;
  const branch = modal.branch.trim();
  if (!branch) {
    modal.error = "Branch name is required";
    renderWorktreeModal();
    return;
  }

  modal.submitting = true;
  modal.error = null;
  renderWorktreeModal();

  try {
    const response = await fetch("/api/docs/worktrees", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        directory: git.repoRoot ?? files.currentPath,
        branch,
        startPoint: modal.startPoint.trim() || null,
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const message = payload?.error ?? response.statusText ?? "Failed to create worktree";
      throw new Error(message);
    }
    const payload = await response.json().catch(() => ({}));
    if (payload?.repository) {
      files.git = payload.repository;
    } else {
      // Refresh to pick up latest git info when response lacks repository payload
      void loadFilesTree(files.currentPath);
    }
    modal.open = false;
    resetWorktreeModalState();
    renderWorktreeModal();
    await loadFilesTree(files.currentPath);
  } catch (error) {
    modal.submitting = false;
    modal.error = error instanceof Error ? error.message : "Failed to create worktree";
    renderWorktreeModal();
  }
};

const destroyAceEditor = () => {
  if (!aceEditorInstance) return;
  const container = aceEditorInstance.container;
  aceEditorInstance.destroy();
  if (container) {
    container.textContent = "";
  }
  aceEditorInstance = null;
};

const setFileEditorState = (updater) => {
  const editor = state.fileEditor;
  if (!editor) return;
  updater(editor);
};

const resetFileEditorState = () => {
  setFileEditorState((editor) => {
    editor.open = false;
    editor.loading = false;
    editor.saving = false;
    editor.error = null;
    editor.saveError = null;
    editor.path = null;
    editor.relativePath = null;
    editor.displayPath = null;
    editor.name = null;
    editor.base64 = null;
    editor.content = "";
    editor.initialContent = "";
    editor.mtimeMs = null;
    editor.dirty = false;
    editor.requestId += 1;
  });
  destroyAceEditor();
};

const closeFileEditor = () => {
  resetFileEditorState();
  render();
};

const requestFileEditorClose = () => {
  const editor = state.fileEditor;
  if (editor.saving) return;
  if (editor.dirty) {
    const confirmClose = window.confirm("Discard unsaved changes?");
    if (!confirmClose) {
      return;
    }
  }
  closeFileEditor();
};

const updateFileEditorControls = () => {
  const editor = state.fileEditor;
  const overlay = document.getElementById("wm-file-editor-overlay");
  if (!overlay || !editor.open) {
    return;
  }
  const saveButton = overlay.querySelector("#wm-file-editor-save");
  if (saveButton instanceof HTMLButtonElement) {
    saveButton.disabled = editor.saving || !editor.dirty;
  }
  const cancelButton = overlay.querySelector("#wm-file-editor-cancel");
  if (cancelButton instanceof HTMLButtonElement) {
    cancelButton.disabled = editor.saving;
  }
  const status = overlay.querySelector("#wm-file-editor-status");
  if (status instanceof HTMLElement) {
    if (editor.saveError) {
      status.textContent = editor.saveError;
      status.hidden = false;
    } else if (editor.saving) {
      status.textContent = "Saving…";
      status.hidden = false;
    } else {
      status.textContent = "";
      status.hidden = true;
    }
  }
};

const ensureAceEditorMounted = () => {
  const editor = state.fileEditor;
  if (!editor.open || editor.loading || editor.error) {
    destroyAceEditor();
    return;
  }

  const container = document.getElementById("wm-file-editor-ace");
  if (!container) {
    destroyAceEditor();
    return;
  }

  if (!aceEditorInstance) {
    aceEditorInstance = ace.edit(container);
    aceEditorInstance.session.setMode("ace/mode/text");
    aceEditorInstance.session.setUseWrapMode(true);
    aceEditorInstance.setOptions({
      useWorker: false,
      showPrintMargin: false,
      behavioursEnabled: false,
      highlightActiveLine: true,
      highlightSelectedWord: false,
      enableBasicAutocompletion: false,
      enableLiveAutocompletion: false,
      enableSnippets: false,
      wrap: true,
      fontSize: 14,
      tabSize: 2,
    });
    aceEditorInstance.renderer.setScrollMargin(8, 8, 8, 8);
    aceEditorInstance.on("change", () => {
      if (!aceEditorInstance) return;
      const value = aceEditorInstance.getValue();
      const editorState = state.fileEditor;
      editorState.content = value;
      editorState.dirty = value !== editorState.initialContent;
      updateFileEditorControls();
    });
  }

  applyAceTheme();
  const targetValue = editor.content ?? "";
  if (aceEditorInstance.getValue() !== targetValue) {
    const selection = aceEditorInstance.getSelectionRange();
    aceEditorInstance.setValue(targetValue, -1);
    if (!editor.loading) {
      aceEditorInstance.selection.setRange(selection, false);
    }
  }

  aceEditorInstance.resize(true);
  aceEditorInstance.focus();
  updateFileEditorControls();
};

const getFileEditorDisplayTitle = () => {
  const editor = state.fileEditor;
  if (editor.displayPath) {
    return editor.displayPath;
  }
  if (editor.name) {
    return editor.name;
  }
  if (editor.path) {
    return editor.path;
  }
  return "File Editor";
};

const openFileEditor = async (path, displayPath, name) => {
  if (!path) return;
  const editor = state.fileEditor;
  editor.open = true;
  editor.loading = true;
  editor.saving = false;
  editor.error = null;
  editor.saveError = null;
  editor.path = path;
  editor.displayPath = displayPath ?? null;
  editor.name = name ?? null;
  editor.content = "";
  editor.initialContent = "";
  editor.base64 = null;
  editor.dirty = false;
  editor.mtimeMs = null;
  editor.requestId += 1;
  const requestId = editor.requestId;
  render();

  try {
    const url = new URL("/api/docs/file/raw", window.location.origin);
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
    if (editor.requestId !== requestId) {
      return;
    }
    const base64 = typeof data?.base64 === "string" ? data.base64 : "";
    const bytes = decodeBase64ToUint8Array(base64);
    const content = decodeBytesToText(bytes);
    editor.open = true;
    editor.loading = false;
    editor.error = null;
    editor.saveError = null;
    editor.path = data?.path ?? path;
    editor.relativePath = data?.relativePath ?? null;
    editor.displayPath = data?.displayPath ?? displayPath ?? null;
    editor.name = data?.name ?? name ?? null;
    editor.base64 = base64;
    editor.content = content;
    editor.initialContent = content;
    editor.mtimeMs = typeof data?.mtimeMs === "number" ? data.mtimeMs : null;
    editor.dirty = false;
  } catch (error) {
    if (editor.requestId !== requestId) {
      return;
    }
    editor.loading = false;
    editor.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (editor.requestId === requestId) {
      render();
    }
  }
};

const saveFileEditor = async () => {
  const editor = state.fileEditor;
  if (!editor.open || editor.loading || editor.saving || !editor.path) {
    return;
  }
  editor.saving = true;
  editor.saveError = null;
  updateFileEditorControls();
  const content = aceEditorInstance ? aceEditorInstance.getValue() : editor.content;
  editor.content = content;
  editor.dirty = content !== editor.initialContent;
  const bytes = encodeTextToBytes(content);
  const base64 = encodeUint8ArrayToBase64(bytes);

  try {
    const response = await fetch("/api/docs/file", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: editor.path,
        base64,
        expectedMtimeMs: editor.mtimeMs ?? undefined,
      }),
    });
    if (!response.ok) {
      let message = response.statusText || "Failed to save file";
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
    editor.initialContent = content;
    editor.content = content;
    editor.base64 = base64;
    editor.mtimeMs = typeof data?.mtimeMs === "number" ? data.mtimeMs : editor.mtimeMs;
    editor.dirty = false;
    editor.saving = false;
    editor.saveError = null;
    if (state.files.previewPath === editor.path) {
      state.files.previewContent = content;
    }
    updateFileEditorControls();
  } catch (error) {
    editor.saving = false;
    editor.saveError = error instanceof Error ? error.message : String(error);
    editor.dirty = editor.content !== editor.initialContent;
    updateFileEditorControls();
  }
};

const renderFileEditorOverlay = () => {
  const existing = document.getElementById("wm-file-editor-overlay");
  if (existing) {
    existing.remove();
  }

  const editor = state.fileEditor;
  if (!editor.open) {
    destroyAceEditor();
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = "wm-file-editor-overlay";
  overlay.className = "wm-file-editor";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      requestFileEditorClose();
    }
  });

  const dialog = document.createElement("div");
  dialog.className = "wm-file-editor__dialog";
  overlay.append(dialog);

  const header = document.createElement("div");
  header.className = "wm-file-editor__header";
  const heading = document.createElement("div");
  heading.className = "wm-file-editor__heading";
  const title = document.createElement("h2");
  title.textContent = editor.name ?? "Edit File";
  heading.append(title);

  const subtitleText = editor.name ? getFileEditorDisplayTitle() : editor.displayPath ?? editor.path ?? "";
  if (subtitleText) {
    const subtitle = document.createElement("p");
    subtitle.className = "wm-file-editor__subtitle";
    subtitle.textContent = subtitleText;
    heading.append(subtitle);
  }

  header.append(heading);
  dialog.append(header);

  const body = document.createElement("div");
  body.className = "wm-file-editor__body";
  dialog.append(body);

  if (editor.loading) {
    const message = document.createElement("p");
    message.className = "wm-file-editor__message";
    message.textContent = "Loading file…";
    body.append(message);
  } else if (editor.error) {
    const message = document.createElement("p");
    message.className = "wm-file-editor__message";
    message.textContent = editor.error;
    body.append(message);
  } else {
    const editorContainer = document.createElement("div");
    editorContainer.id = "wm-file-editor-ace";
    editorContainer.className = "wm-file-editor__editor";
    body.append(editorContainer);
  }

  const footer = document.createElement("div");
  footer.className = "wm-file-editor__footer";
  const status = document.createElement("div");
  status.id = "wm-file-editor-status";
  status.className = "wm-file-editor__status";
  status.hidden = true;
  footer.append(status);

  const actions = document.createElement("div");
  actions.className = "wm-file-editor__actions";

  const cancelButton = document.createElement("button");
  cancelButton.id = "wm-file-editor-cancel";
  cancelButton.type = "button";
  cancelButton.className = "wm-button secondary";
  cancelButton.textContent = editor.error ? "Close" : "Cancel";
  cancelButton.addEventListener("click", () => {
    requestFileEditorClose();
  });
  actions.append(cancelButton);

  if (editor.error && editor.path) {
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "wm-button";
    retryButton.textContent = "Retry";
    retryButton.addEventListener("click", () => {
      void openFileEditor(editor.path, editor.displayPath, editor.name);
    });
    actions.append(retryButton);
  } else if (!editor.loading) {
    const saveButton = document.createElement("button");
    saveButton.id = "wm-file-editor-save";
    saveButton.type = "button";
    saveButton.className = "wm-button";
    saveButton.textContent = "Save";
    saveButton.disabled = true;
    saveButton.addEventListener("click", () => {
      void saveFileEditor();
    });
    actions.append(saveButton);
  }

  footer.append(actions);
  dialog.append(footer);

  appRoot.append(overlay);

  updateFileEditorControls();

  if (!editor.loading && !editor.error) {
    requestAnimationFrame(() => {
      ensureAceEditorMounted();
    });
  } else {
    updateFileEditorControls();
  }
};

const renderWorktreeModal = () => {
  const existing = document.getElementById("wm-worktree-modal");
  if (existing) {
    existing.remove();
  }

  const modal = state.files.worktreeModal;
  if (!modal.open) {
    return;
  }

  const git = getWorktreeGitInfo();

  const overlay = document.createElement("div");
  overlay.id = "wm-worktree-modal";
  overlay.className = "wm-worktree-modal";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay && !modal.submitting) {
      closeWorktreeModal();
    }
  });

  const dialog = document.createElement("div");
  dialog.className = "wm-worktree-modal__dialog";
  overlay.append(dialog);

  const header = document.createElement("div");
  header.className = "wm-worktree-modal__header";
  const title = document.createElement("h2");
  title.textContent = "Create Worktree";
  header.append(title);
  if (git?.repoRoot) {
    const subtitle = document.createElement("p");
    subtitle.className = "wm-worktree-modal__subtitle";
    subtitle.textContent = git.repoRoot;
    header.append(subtitle);
  }
  dialog.append(header);

  const body = document.createElement("div");
  body.className = "wm-worktree-modal__body";
  dialog.append(body);

  const description = document.createElement("p");
  description.className = "wm-worktree-modal__description";
  if (git?.worktreeBase) {
    description.textContent = `New worktrees are created under ${git.worktreeBase}/<branch>`;
  } else {
    description.textContent = "New worktrees are created under .worktrees/<branch> in this repository.";
  }
  body.append(description);

  if (git?.worktreeError) {
    const warning = document.createElement("p");
    warning.className = "wm-worktree-modal__warning";
    warning.textContent = git.worktreeError;
    body.append(warning);
  }

  const form = document.createElement("form");
  form.className = "wm-worktree-modal__form";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (modal.submitting) return;
    void requestCreateWorktree();
  });

  const branchGroup = document.createElement("label");
  branchGroup.className = "wm-worktree-modal__field";
  const branchLabel = document.createElement("span");
  branchLabel.className = "wm-worktree-modal__label";
  branchLabel.textContent = "Feature branch";
  const branchInput = document.createElement("input");
  branchInput.type = "text";
  branchInput.required = true;
  branchInput.placeholder = "feature/amazing-update";
  branchInput.value = modal.branch;
  branchInput.disabled = modal.submitting;
  branchInput.addEventListener("input", (event) => {
    modal.branch = event.target.value;
  });
  branchGroup.append(branchLabel, branchInput);
  form.append(branchGroup);

  const startGroup = document.createElement("label");
  startGroup.className = "wm-worktree-modal__field";
  const startLabel = document.createElement("span");
  startLabel.className = "wm-worktree-modal__label";
  startLabel.textContent = "Start from (optional)";
  const startInput = document.createElement("input");
  startInput.type = "text";
  startInput.placeholder =
    git?.currentBranch && git.currentBranch !== "HEAD" ? git.currentBranch : git?.headRef || "main";
  startInput.value = modal.startPoint;
  startInput.disabled = modal.submitting;
  startInput.addEventListener("input", (event) => {
    modal.startPoint = event.target.value;
  });
  startGroup.append(startLabel, startInput);
  form.append(startGroup);

  const existingWorktrees = Array.isArray(git?.worktrees)
    ? git.worktrees.filter((worktree) => !worktree.primary)
    : [];

  if (existingWorktrees.length > 0) {
    const listWrapper = document.createElement("div");
    listWrapper.className = "wm-worktree-modal__existing";
    const listTitle = document.createElement("h3");
    listTitle.textContent = "Existing worktrees";
    listWrapper.append(listTitle);
    const list = document.createElement("ul");
    existingWorktrees.forEach((worktree) => {
      const item = document.createElement("li");
      const branch = worktree.branch ? ` (${worktree.branch})` : "";
      item.textContent = `${worktree.path}${branch}`;
      list.append(item);
    });
    listWrapper.append(list);
    form.append(listWrapper);
  }

  if (modal.error) {
    const error = document.createElement("p");
    error.className = "wm-worktree-modal__error";
    error.textContent = modal.error;
    form.append(error);
  }

  const actions = document.createElement("div");
  actions.className = "wm-worktree-modal__actions";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "wm-button secondary";
  cancelButton.textContent = "Cancel";
  cancelButton.disabled = modal.submitting;
  cancelButton.addEventListener("click", () => {
    if (modal.submitting) return;
    closeWorktreeModal();
  });
  actions.append(cancelButton);

  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "wm-button";
  submitButton.textContent = modal.submitting ? "Creating..." : "Create Worktree";
  submitButton.disabled = modal.submitting;
  actions.append(submitButton);

  form.append(actions);
  body.append(form);

  appRoot.append(overlay);

  if (!modal.submitting) {
    requestAnimationFrame(() => {
      branchInput.focus();
      branchInput.select();
    });
  }
};

const getSessionById = (sessionId) => (sessionsStore()?.items ?? state.sessions).find((session) => session.id === sessionId);
const ACTIVE_SESSION_STATUSES = new Set(["starting", "running"]);
const isSessionActive = (session) => ACTIVE_SESSION_STATUSES.has(session?.status);
const getActiveSessions = () => (sessionsStore()?.items ?? state.sessions).filter((session) => isSessionActive(session));

const isSessionBusy = (session) => {
  if (!session) return false;
  // Treat sessions as busy only when the agent reports active work or the process is still starting.
  return session.status === "starting" || session.agentRuntimeStatus === "running";
};

const isStatusRecordBusy = (statusRecord) => {
  if (!statusRecord) return false;
  return statusRecord.status === "starting" || statusRecord.agentRuntimeStatus === "running";
};

// Prompt Queue Management Functions
const getSessionQueue = (sessionId) => {
  if (!state.promptQueues.has(sessionId)) {
    state.promptQueues.set(sessionId, { prompts: [], maxSize: 21 });
  }
  return state.promptQueues.get(sessionId);
};

const getQueueCount = (sessionId) => {
  const queue = getSessionQueue(sessionId);
  return queue.prompts.length;
};

const isQueueFull = (sessionId) => {
  const count = getQueueCount(sessionId);
  return count >= 21;
};

let manualQueueSendInFlight = false;

const addToPromptQueue = async (sessionId, content) => {
  if (isQueueFull(sessionId)) {
    showToast("Queue limit reached (21/21)", { type: "warning" });
    return false;
  }

  try {
    const response = await fetch(`/api/sessions/${sessionId}/queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Failed to add prompt to queue");
    }

    const result = await response.json();
    const queue = getSessionQueue(sessionId);
    queue.prompts.push(result.prompt);

    // Update UI to show new queue count
    updateAgentStatusIndicators();

    showToast("Prompt queued", { type: "success" });
    return true;
  } catch (error) {
    console.error("Failed to add prompt to queue:", error);
    showToast(`Failed to queue prompt: ${error.message}`, { type: "error" });
    return false;
  }
};

const removeFromPromptQueue = async (sessionId, promptId) => {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/queue/${promptId}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Failed to remove prompt from queue");
    }

    const queue = getSessionQueue(sessionId);
    queue.prompts = queue.prompts.filter(prompt => prompt.id !== promptId);

    // Update UI to show new queue count
    updateAgentStatusIndicators();

    return true;
  } catch (error) {
    console.error("Failed to remove prompt from queue:", error);
    showToast(`Failed to remove prompt: ${error.message}`, { type: "error" });
    return false;
  }
};

const updatePromptInQueue = async (sessionId, promptId, newContent) => {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/queue/${promptId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: newContent }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Failed to update prompt");
    }

    const queue = getSessionQueue(sessionId);
    const promptIndex = queue.prompts.findIndex(prompt => prompt.id === promptId);
    if (promptIndex !== -1) {
      queue.prompts[promptIndex].content = newContent;
    }
    return true;
  } catch (error) {
    console.error("Failed to update prompt:", error);
    showToast(`Failed to update prompt: ${error.message}`, { type: "error" });
    return false;
  }
};

const fetchSessionQueue = async (sessionId) => {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/queue`);
    if (!response.ok) {
      throw new Error("Failed to fetch queue");
    }
    const data = await response.json();
    const queue = getSessionQueue(sessionId);
    queue.prompts = data.queue?.prompts ?? [];
    return queue.prompts;
  } catch (error) {
    console.error("Failed to fetch session queue:", error);
    return [];
  }
};

const sendNextQueuedPrompt = async (sessionId) => {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/queue/next`, {
      method: "POST",
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      
      // If failed to send, inject the prompt into textarea for manual retry
      if (data.failedPrompt) {
        const textarea = document.querySelector('.wm-composer textarea');
        if (textarea) {
          textarea.value = data.failedPrompt.content;
          textarea.style.height = "auto";
          textarea.style.height = textarea.scrollHeight + "px";
          textarea.focus();
        }
        showToast("Failed to send queued prompt - inserted into text area for manual retry", { type: "error", duration: 5000 });
        
        // Remove the failed prompt from local queue
        const queue = getSessionQueue(sessionId);
        queue.prompts = queue.prompts.filter(prompt => prompt.id !== data.failedPrompt.id);
      }
      return false;
    }

    const result = await response.json();
    
    // Update conversations and logs
    if (result.messages) {
      state.conversations.set(sessionId, result.messages);
      updateConversationDOM(sessionId);
      requestAnimationFrame(() => {
        scrollConversationAreaToBottom(sessionId, { includeWindow: true });
      });
    }
    
    // Remove sent prompt from local queue
    const queue = getSessionQueue(sessionId);
    if (result.sentPrompt) {
      queue.prompts = queue.prompts.filter(prompt => prompt.id !== result.sentPrompt.id);
    }
    
    showToast("Prompt sent to agent", { type: "success" });
    return true;
  } catch (error) {
    console.error("Failed to send queued prompt:", error);
    showToast("Failed to send queued prompt", { type: "error" });
    return false;
  }
};


// Queue Modal Management
let queueModal = null;
let currentQueueSessionId = null;

const openPromptQueueModal = async (sessionId) => {
  const session = getSessionById(sessionId);
  if (!session) return;
  
  currentQueueSessionId = sessionId;
  
  // Fetch latest queue data
  await fetchSessionQueue(sessionId);
  const queue = getSessionQueue(sessionId);
  
  // Create modal if it doesn't exist
  if (!queueModal || !document.contains(queueModal)) {
    queueModal = createPromptQueueModal();
    document.body.appendChild(queueModal);
  }
  
  // Update modal content
  updateQueueModalContent(sessionId, queue.prompts);
  
  // Show modal
  if (typeof queueModal.showModal === "function") {
    queueModal.showModal();
  } else {
    queueModal.style.display = "block";
  }
};

const closePromptQueueModal = () => {
  if (queueModal) {
    if (typeof queueModal.close === "function") {
      queueModal.close();
    } else {
      queueModal.style.display = "none";
    }
  }
  currentQueueSessionId = null;
};

const ensureQueueModalStyles = () => {
  if (document.querySelector("#queue-modal-styles")) return;
  
  const style = document.createElement("style");
  style.id = "queue-modal-styles";
  style.textContent = `
    .wm-prompt-queue-modal {
      max-width: 600px;
      width: 90vw;
      min-height: 300px;
      max-height: 80vh;
      border: 1px solid #ccc;
      border-radius: 8px;
      padding: 0;
      background: white;
      box-sizing: border-box;
    }

    .wm-prompt-queue-modal::backdrop {
      background: rgba(0, 0, 0, 0.5);
    }

    .wm-prompt-queue-modal .modal-content {
      display: flex;
      flex-direction: column;
      min-height: 300px;
      height: auto;
    }

    .wm-prompt-queue-modal .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem;
      border-bottom: 1px solid #eee;
    }

    .wm-prompt-queue-modal .modal-header h2 {
      margin: 0;
      font-size: 1.25rem;
    }

    .wm-prompt-queue-modal .close-btn {
      background: none;
      border: none;
      font-size: 1.5rem;
      cursor: pointer;
      padding: 0.5rem;
      line-height: 1;
      min-width: 44px;
      min-height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .wm-prompt-queue-modal .modal-body {
      flex: 1;
      padding: 1rem;
      overflow-y: auto;
      min-height: 150px;
    }

    .wm-prompt-queue-modal .empty-state {
      text-align: center;
      color: #666;
      font-style: italic;
      padding: 2rem;
    }

    .wm-prompt-queue-modal .queue-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .wm-prompt-queue-modal .queue-item {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 0.75rem;
      border: 1px solid #ddd;
      border-radius: 4px;
      background: #f9f9f9;
    }

    .wm-prompt-queue-modal .prompt-preview {
      flex: 1;
      font-family: monospace;
      font-size: 0.9rem;
      line-height: 1.4;
      word-break: break-word;
    }

    .wm-prompt-queue-modal .prompt-actions {
      display: flex;
      gap: 0.5rem;
      flex-shrink: 0;
    }

    .wm-prompt-queue-modal .prompt-actions button {
      padding: 0.5rem 0.75rem;
      border: 1px solid #ccc;
      border-radius: 3px;
      background: white;
      cursor: pointer;
      font-size: 0.9rem;
      min-height: 44px;
    }

    .wm-prompt-queue-modal .edit-btn:hover {
      background: #e3f2fd;
      border-color: #2196f3;
    }

    .wm-prompt-queue-modal .delete-btn:hover {
      background: #ffebee;
      border-color: #f44336;
    }

    .wm-prompt-queue-modal .modal-footer {
      padding: 1rem;
      border-top: 1px solid #eee;
      text-align: center;
      color: #666;
      font-size: 0.9rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      align-items: center;
    }

    .wm-prompt-queue-modal .modal-footer button {
      min-height: 44px;
      padding: 0.5rem 1rem;
    }

    /* Desktop: side-by-side layout for queue items */
    @media (min-width: 480px) {
      .wm-prompt-queue-modal .queue-item {
        flex-direction: row;
        justify-content: space-between;
        align-items: flex-start;
      }

      .wm-prompt-queue-modal .prompt-preview {
        margin-right: 1rem;
      }
    }
  `;
  
  document.head.appendChild(style);
};

const createPromptQueueModal = () => {
  // Ensure modal styles exist
  ensureQueueModalStyles();
  
  const modal = document.createElement("dialog");
  modal.className = "wm-prompt-queue-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "queue-modal-title");

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closePromptQueueModal();
    }
  });

  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closePromptQueueModal();
    }
  });

  const content = document.createElement("div");
  content.className = "modal-content";
  
  const header = document.createElement("header");
  header.className = "modal-header";
  
  const title = document.createElement("h2");
  title.id = "queue-modal-title";
  title.textContent = "Prompt Queue";
  
  const closeBtn = document.createElement("button");
  closeBtn.className = "close-btn";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close queue modal");
  closeBtn.addEventListener("click", closePromptQueueModal);
  
  header.append(title, closeBtn);
  
  const body = document.createElement("div");
  body.className = "modal-body";
  
  const footer = document.createElement("footer");
  footer.className = "modal-footer";
  
  content.append(header, body, footer);
  modal.appendChild(content);
  
  return modal;
};

const updateQueueModalContent = (sessionId, prompts) => {
  if (!queueModal || !currentQueueSessionId) return;
  
  const session = getSessionById(sessionId);
  const sessionName = getSessionDisplayName(session);
  
  // Update title
  const title = queueModal.querySelector("#queue-modal-title");
  if (title) {
    title.textContent = `Prompt Queue - ${sessionName}`;
  }
  
  // Update body content
  const body = queueModal.querySelector(".modal-body");
  if (!body) return;
  
  body.innerHTML = "";
  
  if (prompts.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = "No prompts queued";
    body.appendChild(emptyState);
  } else {
    const queueList = document.createElement("div");
    queueList.className = "queue-list";
    
    prompts.forEach((prompt, index) => {
      const item = document.createElement("div");
      item.className = "queue-item";
      item.dataset.promptId = prompt.id;
      
      const preview = document.createElement("div");
      preview.className = "prompt-preview";
      const previewText = prompt.content.length > 100 
        ? prompt.content.substring(0, 100) + "..." 
        : prompt.content;
      preview.textContent = `${index + 1}. ${previewText}`;
      
      const actions = document.createElement("div");
      actions.className = "prompt-actions";
      
      const editBtn = document.createElement("button");
      editBtn.className = "edit-btn";
      editBtn.type = "button";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", () => editQueuePrompt(sessionId, prompt.id, prompt.content));
      
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "delete-btn";
      deleteBtn.type = "button";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", () => deleteQueuePrompt(sessionId, prompt.id));
      
      actions.append(editBtn, deleteBtn);
      item.append(preview, actions);
      queueList.appendChild(item);
    });
    
    body.appendChild(queueList);
  }
  
  // Update footer
  const footer = queueModal.querySelector(".modal-footer");
  if (footer) {
    footer.innerHTML = "";
    
    const countLabel = document.createElement("span");
    countLabel.textContent = `${prompts.length}/21 prompts`;
    footer.appendChild(countLabel);
    
    if (prompts.length > 0) {
      const sendButton = document.createElement("button");
      sendButton.type = "button";
      sendButton.className = "wm-button secondary";
      sendButton.textContent = manualQueueSendInFlight ? "Sending..." : "Send next now";
      sendButton.disabled = manualQueueSendInFlight;
      sendButton.addEventListener("click", () => handleManualQueueSend(sessionId));
      footer.appendChild(sendButton);
    }
  }
};

const handleManualQueueSend = async (sessionId) => {
  if (manualQueueSendInFlight) return;
  const queue = getSessionQueue(sessionId);
  if (!queue.prompts.length) {
    showToast("No queued prompts to send", { type: "info" });
    return;
  }

  manualQueueSendInFlight = true;
  updateQueueModalContent(sessionId, queue.prompts);
  try {
    const success = await sendNextQueuedPrompt(sessionId);
    if (success) {
      updateAgentStatusIndicators();
      updateQueueModalContent(sessionId, queue.prompts);
    }
  } finally {
    manualQueueSendInFlight = false;
    updateQueueModalContent(sessionId, queue.prompts);
  }
};

const editQueuePrompt = (sessionId, promptId, currentContent) => {
  const newContent = window.prompt("Edit prompt:", currentContent);
  if (newContent !== null && newContent.trim() !== "") {
    updatePromptInQueue(sessionId, promptId, newContent.trim()).then((success) => {
      if (success) {
        // Refresh modal content
        const queue = getSessionQueue(sessionId);
        updateQueueModalContent(sessionId, queue.prompts);
        updateAgentStatusIndicators();
      }
    });
  }
};

const deleteQueuePrompt = (sessionId, promptId) => {
  if (window.confirm("Delete this prompt from the queue?")) {
    removeFromPromptQueue(sessionId, promptId).then((success) => {
      if (success) {
        // Refresh modal content
        const queue = getSessionQueue(sessionId);
        updateQueueModalContent(sessionId, queue.prompts);
        updateAgentStatusIndicators();
      }
    });
  }
};

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

const applyAceTheme = () => {
  if (!aceEditorInstance) return;
  const targetTheme = currentTheme === "dark" ? ACE_DARK_THEME : ACE_LIGHT_THEME;
  if (aceEditorInstance.getTheme() !== targetTheme) {
    aceEditorInstance.setTheme(targetTheme);
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
const insertTextAtCursor = (textarea, text, sessionId) => {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const next = before + text + after;
  const nextCursor = start + text.length;
  textarea.value = next;
  textarea.selectionStart = textarea.selectionEnd = nextCursor;
  state.messageDrafts.set(sessionId, next);
};

const createThumbnail = (file, maxSize = 80) => {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    
    img.onload = () => {
      // Calculate thumbnail dimensions maintaining aspect ratio
      let { width, height } = img;
      if (width > height) {
        if (width > maxSize) {
          height = (height * maxSize) / width;
          width = maxSize;
        }
      } else {
        if (height > maxSize) {
          width = (width * maxSize) / height;
          height = maxSize;
        }
      }
      
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
      
      canvas.toBlob((blob) => {
        resolve(URL.createObjectURL(blob));
      }, 'image/jpeg', 0.8);
    };
    
    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(file);
  });
};

const addImagePreview = (sessionId, file, thumbnailUrl) => {
  const composerShell = document.querySelector(`.wm-composer-shell[data-session-id="${sessionId}"]`);
  if (!composerShell) return;
  
  const previewContainer = composerShell.querySelector('.wm-image-preview-container');
  if (!previewContainer) return;
  
  // Generate unique marker ID for this upload
  const markerId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  const previewItem = document.createElement('div');
  previewItem.className = 'wm-image-preview-item';
  previewItem.style.cssText = `
    position: relative;
    display: inline-block;
    border-radius: 4px;
    overflow: hidden;
    border: 1px solid #e1e5e9;
    background: #f8f9fa;
  `;
  
  const img = document.createElement('img');
  img.src = thumbnailUrl;
  img.style.cssText = `
    width: 80px;
    height: 80px;
    object-fit: cover;
    display: block;
  `;
  
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.innerHTML = '×';
  removeBtn.style.cssText = `
    position: absolute;
    top: 2px;
    right: 2px;
    width: 20px;
    height: 20px;
    border: none;
    background: rgba(0, 0, 0, 0.7);
    color: white;
    border-radius: 50%;
    cursor: pointer;
    font-size: 14px;
    font-weight: bold;
    display: flex;
    align-items: center;
    justify-content: center;
  `;
  removeBtn.title = 'Remove image';
  
  removeBtn.addEventListener('click', () => {
    // Remove the corresponding text from textarea
    const textarea = composerShell.querySelector('textarea');
    if (textarea) {
      const currentText = textarea.value;
      const markerIndex = imagePreviewTracker.findMarkerInText(currentText, markerId);
      if (markerIndex !== -1) {
        const newText = imagePreviewTracker.removeMarkerFromText(currentText, markerId);
        textarea.value = newText;
        state.messageDrafts.set(sessionId, newText);
        resizeTextarea();
      }
    }
    
    // Remove the preview using tracker
    imagePreviewTracker.remove(sessionId, markerId);
  });
  
  previewItem.append(img, removeBtn);
  previewContainer.append(previewItem);
  previewContainer.style.display = 'flex';
  
  // Add to tracker
  imagePreviewTracker.add(sessionId, markerId, previewItem, thumbnailUrl);
  
  return markerId;
};

// Track relationship between image previews and their text markers
const imagePreviewTracker = {
  // sessionId -> Map<markerId, {previewElement, thumbnailUrl}>
  previews: new Map(),
  
  add: (sessionId, markerId, previewElement, thumbnailUrl) => {
    if (!imagePreviewTracker.previews.has(sessionId)) {
      imagePreviewTracker.previews.set(sessionId, new Map());
    }
    imagePreviewTracker.previews.get(sessionId).set(markerId, {
      previewElement,
      thumbnailUrl
    });
  },
  
  remove: (sessionId, markerId) => {
    const sessionPreviews = imagePreviewTracker.previews.get(sessionId);
    if (sessionPreviews) {
      const previewData = sessionPreviews.get(markerId);
      if (previewData) {
        previewData.previewElement.remove();
        URL.revokeObjectURL(previewData.thumbnailUrl);
        sessionPreviews.delete(markerId);
      }
      
      // Hide container if no more previews
      const composerShell = document.querySelector(`.wm-composer-shell[data-session-id="${sessionId}"]`);
      const previewContainer = composerShell?.querySelector('.wm-image-preview-container');
      if (previewContainer && sessionPreviews.size === 0) {
        previewContainer.style.display = 'none';
      }
    }
  },
  
  clear: (sessionId) => {
    const composerShell = document.querySelector(`.wm-composer-shell[data-session-id="${sessionId}"]`);
    const sessionPreviews = imagePreviewTracker.previews.get(sessionId);
    
    if (sessionPreviews) {
      // Clear markers from textarea first
      const textarea = composerShell?.querySelector('textarea');
      if (textarea) {
        let cleanText = textarea.value;
        sessionPreviews.forEach((_, markerId) => {
          cleanText = imagePreviewTracker.removeMarkerFromText(cleanText, markerId);
        });
        textarea.value = cleanText;
        state.messageDrafts.set(sessionId, cleanText);
      }
      
      // Then remove preview elements
      sessionPreviews.forEach((previewData, markerId) => {
        previewData.previewElement.remove();
        URL.revokeObjectURL(previewData.thumbnailUrl);
      });
      sessionPreviews.clear();
      
      const previewContainer = composerShell?.querySelector('.wm-image-preview-container');
      if (previewContainer) {
        previewContainer.style.display = 'none';
      }
    }
  },
  
  findMarkerInText: (text, markerId) => {
    const marker = `<!--IMG:${markerId}-->`;
    return text.indexOf(marker);
  },
  
  removeMarkerFromText: (text, markerId) => {
    const marker = `<!--IMG:${markerId}-->`;
    return text.replace(marker, '');
  }
};

const clearImagePreviews = (sessionId) => {
  imagePreviewTracker.clear(sessionId);
};

const extractImageFiles = (items) => {
  if (!items) return [];
  const files = [];
  for (const item of Array.from(items)) {
    if (!item) continue;
    if (item.kind === "file") {
      const file = item.getAsFile?.() ?? item;
      if (file instanceof File && file.type?.startsWith?.("image/")) {
        files.push(file);
      }
    } else if (item instanceof File || item instanceof Blob) {
      if (item.type?.startsWith?.("image/")) {
        files.push(item);
      }
    }
  }
  return files;
};

const extractAttachmentFiles = (items) => {
  if (!items) return [];
  const files = [];
  for (const item of Array.from(items)) {
    if (!item) continue;
    if (item.kind === "file") {
      const file = item.getAsFile?.() ?? item;
      if (file instanceof File && !file.type?.startsWith?.("image/")) {
        files.push(file);
      }
    } else if (item instanceof File || item instanceof Blob) {
      if (!item.type || !item.type.startsWith("image/")) {
        files.push(item);
      }
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
    
    // Generate and show thumbnail preview immediately
    const thumbnailUrl = await createThumbnail(file);
    let markerId = null;
    if (thumbnailUrl) {
      markerId = addImagePreview(sessionId, file, thumbnailUrl);
    }
    
    // Insert uploading placeholder with unique marker at cursor position
    const marker = markerId ? `<!--IMG:${markerId}-->` : '';
    const uploadingPlaceholder = markerId ? `${marker}[Uploading...]` : "[Uploading...]";
    const uploadText = textarea.value.endsWith("\n") ? `${uploadingPlaceholder}\n` : `\n${uploadingPlaceholder}\n`;
    insertTextAtCursor(textarea, uploadText, sessionId);
    resizeTextarea();
    
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
        const errorText = data?.error || response.statusText || "Unknown error";
        const message = `Image upload failed (${response.status}): ${errorText}`;
        console.error("[image-upload]", message, { status: response.status, data });
        window.alert(message);
        // Remove uploading placeholder on error
        const currentValue = textarea.value;
        const markerIndex = markerId ? imagePreviewTracker.findMarkerInText(currentValue, markerId) : currentValue.lastIndexOf(uploadingPlaceholder);
        if (markerIndex !== -1) {
          const newText = markerId ? imagePreviewTracker.removeMarkerFromText(currentValue, markerId) : currentValue.replace(uploadingPlaceholder, '');
          textarea.value = newText;
          state.messageDrafts.set(sessionId, textarea.value);
        }
        
        // Remove preview on error
        if (thumbnailUrl && markerId) {
          imagePreviewTracker.remove(sessionId, markerId);
        } else if (thumbnailUrl) {
          URL.revokeObjectURL(thumbnailUrl);
        }
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
        // Remove uploading placeholder on success but no reference
        const currentValue = textarea.value;
        const markerIndex = markerId ? imagePreviewTracker.findMarkerInText(currentValue, markerId) : currentValue.lastIndexOf(uploadingPlaceholder);
        if (markerIndex !== -1) {
          const newText = markerId ? imagePreviewTracker.removeMarkerFromText(currentValue, markerId) : currentValue.replace(uploadingPlaceholder, '');
          textarea.value = newText;
          state.messageDrafts.set(sessionId, textarea.value);
        }
        
        // Remove preview on success but no reference
        if (thumbnailUrl && markerId) {
          imagePreviewTracker.remove(sessionId, markerId);
        } else if (thumbnailUrl) {
          URL.revokeObjectURL(thumbnailUrl);
        }
        continue;
      }

      // Replace uploading placeholder with actual image placeholder
      const currentValue = textarea.value;
      const markerIndex = markerId ? imagePreviewTracker.findMarkerInText(currentValue, markerId) : currentValue.lastIndexOf(uploadingPlaceholder);
      if (markerIndex !== -1) {
        const marker = markerId ? `<!--IMG:${markerId}-->[Uploading...]` : uploadingPlaceholder;
        const beforePlaceholder = currentValue.substring(0, markerIndex);
        const afterPlaceholder = currentValue.substring(markerIndex + marker.length);
        textarea.value = beforePlaceholder + placeholder + afterPlaceholder;
        state.messageDrafts.set(sessionId, textarea.value);
      }
      
      // Clean up thumbnail URL on successful upload (preview will be removed when message is sent)
      if (thumbnailUrl && markerId) {
        // Replace thumbnail with the actual uploaded image URL for preview consistency
        const sessionPreviews = imagePreviewTracker.previews.get(sessionId);
        if (sessionPreviews && sessionPreviews.has(markerId)) {
          const previewData = sessionPreviews.get(markerId);
          URL.revokeObjectURL(previewData.thumbnailUrl);
          // Keep the preview element but update the image source to the uploaded image
          const img = previewData.previewElement.querySelector('img');
          if (img) {
            img.src = payload.publicPath || '';
          }
          sessionPreviews.set(markerId, { ...previewData, thumbnailUrl: null });
        }
      } else if (thumbnailUrl) {
        URL.revokeObjectURL(thumbnailUrl);
      }
      
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

const uploadLiveAttachment = async (agentId, file) => {
  const form = new FormData();
  form.append("agent", agentId);
  form.append("file", file, file.name);

  const response = await fetch("/api/uploads/files", {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "File upload failed";
    throw new Error(message);
  }

  const data = await response.json().catch(() => ({}));
  const first = Array.isArray(data?.files) ? data.files[0] : null;
  if (!first) {
    throw new Error("Upload succeeded without file details");
  }
  return first;
};

const handleAttachmentUploads = async (sessionId, files, textarea, resizeTextarea, setUploadingState) => {
  if (!files || files.length === 0) return;
  const session = getSessionById(sessionId);
  if (!session) {
    window.alert("Unable to locate session for file upload.");
    return;
  }

  for (const file of files) {
    setUploadingState(true);
    try {
      const payload = await uploadLiveAttachment(session.agent, file);
      const placeholder = typeof payload?.placeholder === "string" ? payload.placeholder : null;
      const fallback =
        typeof payload?.publicPath === "string"
          ? payload.publicPath
          : typeof payload?.absolutePath === "string"
            ? payload.absolutePath
            : "";
      const reference = placeholder || fallback;
      if (!reference) {
        window.alert("File upload succeeded without a usable reference.");
        continue;
      }
      const needsPrefix = textarea.value.length > 0 && !textarea.value.endsWith("\n");
      const textToInsert = needsPrefix ? `\n${reference}\n` : `${reference}\n`;
      insertTextAtCursor(textarea, textToInsert, sessionId);
      resizeTextarea();
      textarea.focus();
    } catch (error) {
      console.error("Failed to upload file", error);
      const message = error instanceof Error ? error.message : "File upload failed. Check console for details.";
      window.alert(message);
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
const projectsNavLink = navLinks.find((link) => link.dataset.route === "projects");
const nightwatchNavLink = navLinks.find((link) => link.dataset.route === "nightwatch");
const themeToggle = document.getElementById("theme-toggle");
const tabsToggle = document.getElementById("tabs-toggle");
const menuToggle = document.getElementById("menu-toggle");
const menuPanel = document.querySelector(".wm-menu-panel");
const menuTabsContainer = document.getElementById("menu-tabs");
const menuIdentityContainer = document.getElementById("menu-identity");
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
const quickLauncherButton = document.getElementById("quick-launcher-button");
const quickLauncherMenu = document.getElementById("quick-launcher-menu");
const quickLauncherList = document.getElementById("quick-launcher-list");
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

// Quick Launcher functionality
const quickLauncherState = {
  projects: [],
  loading: false,
  sessionCounters: new Map(), // projectId -> counter for naming
};

const fetchQuickLauncherProjects = async () => {
  quickLauncherState.loading = true;
  try {
    const response = await fetch("/api/npub-projects", { credentials: "include" });
    if (!response.ok) {
      quickLauncherState.projects = [];
      return;
    }
    const data = await response.json();
    quickLauncherState.projects = Array.isArray(data.projects) ? data.projects : [];
  } catch {
    quickLauncherState.projects = [];
  } finally {
    quickLauncherState.loading = false;
  }
};

const getNextSessionId = (projectId) => {
  const current = quickLauncherState.sessionCounters.get(projectId) ?? 0;
  const next = current + 1;
  quickLauncherState.sessionCounters.set(projectId, next);
  return next;
};

const renderQuickLauncherMenu = () => {
  if (!quickLauncherList) return;
  quickLauncherList.innerHTML = "";

  if (quickLauncherState.projects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "wm-quick-launcher-empty";
    empty.textContent = quickLauncherState.loading ? "Loading..." : "No projects yet";
    quickLauncherList.append(empty);
    return;
  }

  quickLauncherState.projects.forEach((project) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "wm-quick-launcher-item";
    item.dataset.projectId = project.id;

    const name = document.createElement("span");
    name.className = "wm-quick-launcher-item-name";
    name.textContent = project.name;

    const path = document.createElement("span");
    path.className = "wm-quick-launcher-item-path";
    path.textContent = project.directoryPath;
    path.title = project.directoryPath;

    item.append(name, path);
    item.addEventListener("click", () => {
      quickLaunchSession(project);
    });
    quickLauncherList.append(item);
  });
};

const quickLaunchSession = async (project) => {
  closeQuickLauncherMenu();
  const sessionId = getNextSessionId(project.id);
  const sessionName = `${project.name}-${sessionId}`;
  const agentId = state.config?.defaultAgent ?? "claude";
  const directory = project.directoryPath;

  try {
    await launchSession(agentId, directory, sessionName, null, { openInNewTab: true });
  } catch (error) {
    console.error("Failed to quick launch session:", error);
    showToast("Failed to launch session", { type: "error" });
  }
};

const openQuickLauncherMenu = async () => {
  if (!quickLauncherMenu || !quickLauncherButton) return;
  await fetchQuickLauncherProjects();
  renderQuickLauncherMenu();
  quickLauncherMenu.hidden = false;
  quickLauncherButton.setAttribute("aria-expanded", "true");

  const closeOnClickOutside = (event) => {
    if (!quickLauncherMenu.contains(event.target) && event.target !== quickLauncherButton) {
      closeQuickLauncherMenu();
      document.removeEventListener("mousedown", closeOnClickOutside);
    }
  };
  document.addEventListener("mousedown", closeOnClickOutside);
};

const closeQuickLauncherMenu = () => {
  if (!quickLauncherMenu || !quickLauncherButton) return;
  quickLauncherMenu.hidden = true;
  quickLauncherButton.setAttribute("aria-expanded", "false");
};

const toggleQuickLauncherMenu = () => {
  if (quickLauncherMenu?.hidden) {
    openQuickLauncherMenu();
  } else {
    closeQuickLauncherMenu();
  }
};

if (quickLauncherButton) {
  quickLauncherButton.addEventListener("click", toggleQuickLauncherMenu);
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

const DIRECTORY_SUGGESTION_DELAY = 160;
const DIRECTORY_BROWSER_ROOT = "__root__";
const DIRECTORY_BROWSER_ROOT_LABEL = "Allowed Directories";
let directorySuggestionTimer = null;
let directorySuggestionRequestId = 0;

const directoryBrowserState = {
  currentPath: "",
  parent: null,
  requestId: 0,
  onSelect: null,
  allowCreate: true,
  confirmLabel: "Use This Directory",
  title: "Select Directory",
  pendingResolve: null,
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

const fetchDocsDirectoryListing = async (path) => {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (state.files.showHidden) {
    params.set("showHidden", "1");
  }
  const response = await fetch(`/api/docs/tree?${params.toString()}`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to load directory";
    throw new Error(message);
  }
  const payload = await response.json();
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  return {
    path: payload?.path ?? path ?? "",
    displayPath: payload?.displayPath ?? payload?.path ?? "",
    parent: payload?.parent ?? null,
    directories: entries.filter((entry) => entry?.type === "directory"),
  };
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
  if (typeof path !== "string" || path.length === 0) return;
  const selected = path;
  const onSelect = directoryBrowserState.onSelect;
  if (typeof onSelect === "function") {
    onSelect(selected);
  } else if (directoryInput) {
    directoryInput.value = selected;
    state.lastWorkingDirectory = selected;
    scheduleDirectorySuggestions(selected);
  }
  sessionDialogController?.syncWorktreeHint?.();
  directoryBrowserState.onSelect = null;
  if (directoryBrowserState.pendingResolve) {
    const resolve = directoryBrowserState.pendingResolve;
    directoryBrowserState.pendingResolve = null;
    resolve(selected);
  }
  if (directoryDialog?.open) {
    directoryDialog.close();
  }
};

const renderDirectoryBrowser = (data) => {
  if (!data) return;
  const isRootView = !data.path || data.path === DIRECTORY_BROWSER_ROOT;
  if (directoryCurrent) {
    const label = isRootView ? DIRECTORY_BROWSER_ROOT_LABEL : data.path;
    directoryCurrent.textContent = label;
  }
  if (directoryUpButton) {
    directoryUpButton.disabled = !data.parent;
  }
  if (directoryUseButton) {
    directoryUseButton.disabled = !(data.path && data.path.length > 0);
  }
  if (directoryNewFolderButton) {
    if (directoryBrowserState.allowCreate) {
      directoryNewFolderButton.hidden = false;
      directoryNewFolderButton.disabled = !data.path;
    } else {
      directoryNewFolderButton.hidden = true;
      directoryNewFolderButton.disabled = true;
    }
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
  directoryBrowserState.currentPath = typeof data.path === "string" ? data.path : "";
  directoryBrowserState.parent = data.parent;
  renderDirectoryBrowser(data);
  return true;
};

const openDirectoryBrowser = async (options = {}) => {
  if (!state.config) {
    try {
      await fetchConfig();
    } catch {
      // ignore config fetch failures; fallback prompt handles it
    }
  }

  const {
    initialPath,
    onSelect,
    allowCreate = true,
    confirmLabel = "Use This Directory",
    title = "Select Directory",
  } = options;

  const seedCandidate =
    (typeof initialPath === "string" && initialPath.trim().length > 0 ? initialPath.trim() : null) ??
    directoryInput?.value?.trim() ??
    state.lastWorkingDirectory ??
    state.config?.defaultDirectory ??
    "";

  directoryBrowserState.onSelect = typeof onSelect === "function" ? onSelect : null;
  directoryBrowserState.allowCreate = allowCreate;
  directoryBrowserState.confirmLabel = confirmLabel;
  directoryBrowserState.title = title;

  if (!directoryDialog || typeof directoryDialog.showModal !== "function") {
    const fallback = window.prompt("Enter directory", seedCandidate);
    if (fallback) {
      chooseDirectory(fallback);
    }
    return null;
  }

  if (directoryTitle) {
    directoryTitle.textContent = title;
  }
  if (directoryUseButton) {
    directoryUseButton.textContent = confirmLabel;
  }
  if (directoryNewFolderButton) {
    directoryNewFolderButton.hidden = !allowCreate;
    directoryNewFolderButton.disabled = !allowCreate;
  }

  if (directoryBrowserState.pendingResolve) {
    directoryBrowserState.pendingResolve(null);
    directoryBrowserState.pendingResolve = null;
  }

  const loaded = await updateDirectoryBrowser(seedCandidate);
  if (!loaded) {
    window.alert("Unable to open directory browser for the requested path.");
    directoryBrowserState.onSelect = null;
    return null;
  }

  directoryDialog.showModal();
  return new Promise((resolve) => {
    directoryBrowserState.pendingResolve = resolve;
  });
};

const promptCreateDirectoryAtPath = async (parentPath, { onSuccess } = {}) => {
  const basePath = typeof parentPath === "string" && parentPath.length > 0 ? parentPath : null;
  if (!basePath) {
    window.alert("Select a parent directory first.");
    return false;
  }
  const rawName = window.prompt("Folder name", "New Folder");
  if (!rawName) {
    return false;
  }
  const trimmed = rawName.trim();
  if (trimmed.length === 0) {
    window.alert("Folder name cannot be empty.");
    return false;
  }
  try {
    const result = await createDirectoryEntry(basePath, trimmed);
    if (typeof onSuccess === "function") {
      await Promise.resolve(onSuccess(result));
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create folder";
    window.alert(message);
    return false;
  }
};

const getParentDirectoryPath = (filePath) => {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return null;
  }
  const normalized = filePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return null;
  }
  const prefix = normalized.slice(0, index);
  if (filePath.includes("\\")) {
    const backslashIndex = filePath.lastIndexOf("\\");
    if (backslashIndex > index) {
      return filePath.slice(0, backslashIndex);
    }
    return filePath.slice(0, index);
  }
  return filePath.slice(0, index);
};

const FILE_TRANSFER_NAME_MAX_LENGTH = 200;

const applyFileTransferNameInput = (rawValue) => {
  const transfer = state.files.transfer;
  const value = typeof rawValue === "string" ? rawValue : "";
  transfer.destinationNameInput = value;
  const trimmed = value.trim();
  let error = null;
  let normalized = null;
  if (trimmed.length > 0) {
    if (trimmed.length > FILE_TRANSFER_NAME_MAX_LENGTH) {
      error = "File name is too long";
    } else if (trimmed === "." || trimmed === "..") {
      error = "File name is not allowed";
    } else if (/[\\/]/.test(trimmed)) {
      error = "File name cannot contain path separators";
    } else {
      normalized = trimmed;
    }
  }
  transfer.destinationName = normalized;
  transfer.nameError = error;
  if (fileTransferNameFeedback) {
    if (error) {
      fileTransferNameFeedback.textContent = error;
      fileTransferNameFeedback.hidden = false;
    } else {
      fileTransferNameFeedback.textContent = "";
      fileTransferNameFeedback.hidden = true;
    }
  }
  if (fileTransferNameInput) {
    if (error) {
      fileTransferNameInput.setAttribute("aria-invalid", "true");
    } else {
      fileTransferNameInput.removeAttribute("aria-invalid");
    }
  }
  syncFileTransferConfirmState();
};

const resetFileTransferState = () => {
  const transfer = state.files.transfer;
  transfer.mode = null;
  transfer.sourcePath = null;
  transfer.sourceName = null;
  transfer.sourceDisplayPath = null;
  transfer.destinationPath = null;
  transfer.destinationDisplayPath = null;
  transfer.destinationName = null;
  transfer.destinationNameInput = "";
  transfer.nameError = null;
  transfer.submitting = false;
  transfer.error = null;
  transfer.browser.currentPath = "";
  transfer.browser.parent = null;
  transfer.browser.selection = null;
  transfer.browser.requestId = 0;
  if (fileTransferList) {
    fileTransferList.innerHTML = "";
  }
  if (fileTransferSelected) {
    fileTransferSelected.textContent = "";
  }
  if (fileTransferNameInput) {
    fileTransferNameInput.value = "";
    fileTransferNameInput.placeholder = "";
    fileTransferNameInput.removeAttribute("aria-invalid");
  }
  if (fileTransferNameFeedback) {
    fileTransferNameFeedback.textContent = "";
    fileTransferNameFeedback.hidden = true;
  }
  if (fileTransferNewFolderButton) {
    fileTransferNewFolderButton.disabled = true;
  }
  syncFileTransferConfirmState();
};

const syncFileTransferConfirmState = () => {
  if (!fileTransferConfirmButton) return;
  const transfer = state.files.transfer;
  const mode = transfer.mode;
  if (!mode) {
    fileTransferConfirmButton.disabled = true;
    delete fileTransferConfirmButton.dataset.loading;
    fileTransferConfirmButton.textContent = "Confirm";
    return;
  }
  const disabled = transfer.submitting || !transfer.destinationPath || Boolean(transfer.nameError);
  fileTransferConfirmButton.disabled = disabled;
  if (transfer.submitting) {
    fileTransferConfirmButton.dataset.loading = "true";
  } else {
    delete fileTransferConfirmButton.dataset.loading;
  }
  if (transfer.submitting) {
    fileTransferConfirmButton.textContent = mode === "move" ? "Moving…" : "Copying…";
  } else {
    fileTransferConfirmButton.textContent = mode === "move" ? "Move Here" : "Copy Here";
  }
};

const setFileTransferSelection = (path, displayPath) => {
  const transfer = state.files.transfer;
  transfer.destinationPath = typeof path === "string" && path.length > 0 ? path : null;
  transfer.browser.selection = transfer.destinationPath;
  transfer.destinationDisplayPath =
    transfer.destinationPath && typeof displayPath === "string" && displayPath.length > 0
      ? displayPath
      : transfer.destinationPath;
  if (fileTransferSelected) {
    if (transfer.destinationDisplayPath) {
      fileTransferSelected.textContent = `Destination: ${transfer.destinationDisplayPath}`;
    } else {
      fileTransferSelected.textContent = "";
    }
  }
  if (fileTransferList) {
    fileTransferList.querySelectorAll(".directory-browser__item").forEach((item) => {
      if (!(item instanceof HTMLElement)) return;
      const itemPath = item.dataset.path;
      if (itemPath && transfer.destinationPath && itemPath === transfer.destinationPath) {
        item.dataset.selected = "true";
      } else {
        delete item.dataset.selected;
      }
    });
  }
  syncFileTransferConfirmState();
};

const renderFileTransferBrowser = (data) => {
  if (!data) return;
  const transfer = state.files.transfer;
  transfer.browser.currentPath = data.path ?? "";
  transfer.browser.parent = typeof data.parent?.path === "string" ? data.parent.path : null;

  if (fileTransferCurrent) {
    fileTransferCurrent.textContent = data.displayPath ?? data.path ?? "";
  }
  if (fileTransferUpButton) {
    fileTransferUpButton.disabled = !transfer.browser.parent;
  }
  if (fileTransferNewFolderButton) {
    fileTransferNewFolderButton.disabled = !(data.path && data.path.length > 0);
  }
  if (!fileTransferList) return;
  fileTransferList.innerHTML = "";

  const directories = Array.isArray(data.directories) ? data.directories : [];
  if (directories.length === 0) {
    const empty = document.createElement("li");
    empty.className = "directory-browser__empty";
    empty.textContent = "No subdirectories";
    fileTransferList.append(empty);
  } else {
    directories.forEach((entry) => {
      const item = document.createElement("li");
      item.className = "directory-browser__item";
      item.dataset.path = entry.path;
      item.dataset.displayPath = entry.displayPath ?? entry.path ?? "";

      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "directory-browser__folder";
      openButton.textContent = entry.name;
      openButton.addEventListener("click", () => {
        void updateFileTransferBrowser(entry.path);
      });

      const chooseButton = document.createElement("button");
      chooseButton.type = "button";
      chooseButton.className = "wm-button secondary directory-browser__choose";
      chooseButton.textContent = "Select";
      chooseButton.addEventListener("click", () => {
        setFileTransferSelection(entry.path, entry.displayPath ?? entry.path ?? "");
      });

      item.append(openButton, chooseButton);
      fileTransferList.append(item);
    });
  }

  if (!transfer.destinationPath || transfer.destinationPath === transfer.browser.currentPath) {
    setFileTransferSelection(data.path ?? transfer.browser.currentPath, data.displayPath ?? data.path ?? "");
  } else {
    setFileTransferSelection(transfer.destinationPath, transfer.destinationDisplayPath);
  }
};

const updateFileTransferBrowser = async (path) => {
  const transfer = state.files.transfer;
  const requestId = ++transfer.browser.requestId;
  try {
    const data = await fetchDocsDirectoryListing(path);
    if (transfer.browser.requestId !== requestId) {
      return false;
    }
    renderFileTransferBrowser(data);
    return true;
  } catch (error) {
    if (transfer.browser.requestId === requestId) {
      const message = error instanceof Error ? error.message : "Failed to load directories";
      window.alert(message);
    }
    return false;
  }
};

const closeFileTransferDialog = () => {
  if (fileTransferDialog?.open) {
    fileTransferDialog.close();
  }
  resetFileTransferState();
  syncFileTransferConfirmState();
};

const openFileTransferDialogForMode = async (mode) => {
  if (!fileTransferDialog) return;
  if (mode !== "copy" && mode !== "move") return;
  const files = state.files;
  const sourcePath = typeof files.previewPath === "string" ? files.previewPath : null;
  if (!sourcePath || files.previewLoading) {
    return;
  }

  const transfer = state.files.transfer;
  transfer.mode = mode;
  transfer.sourcePath = sourcePath;
  transfer.sourceName =
    files.previewName ??
    (typeof sourcePath === "string" ? sourcePath.split(/[\\/]/).pop() ?? sourcePath : sourcePath);
  transfer.sourceDisplayPath =
    files.previewDisplayPath ?? files.previewName ?? transfer.sourceName ?? sourcePath;
  transfer.submitting = false;
  transfer.error = null;
  transfer.destinationPath = files.currentPath ?? getParentDirectoryPath(sourcePath);
  transfer.destinationDisplayPath = files.displayPath ?? transfer.destinationPath;

  const defaultName = transfer.sourceName ?? "";
  transfer.destinationNameInput = defaultName;
  applyFileTransferNameInput(defaultName);
  if (fileTransferNameInput) {
    fileTransferNameInput.value = defaultName;
    fileTransferNameInput.placeholder = transfer.sourceName ?? "";
    const focusInput = () => {
      if (fileTransferNameInput?.isConnected) {
        fileTransferNameInput.focus();
        try {
          const length = fileTransferNameInput.value.length;
          fileTransferNameInput.setSelectionRange(0, length);
        } catch {
          // ignore selection errors on unsupported inputs
        }
      }
    };
    if (typeof queueMicrotask === "function") {
      queueMicrotask(focusInput);
    } else {
      setTimeout(focusInput, 0);
    }
  }

  if (fileTransferTitle) {
    fileTransferTitle.textContent = mode === "move" ? "Move File To…" : "Copy File To…";
  }
  if (fileTransferSource) {
    fileTransferSource.textContent = transfer.sourceDisplayPath ?? transfer.sourcePath ?? "";
  }
  if (fileTransferList) {
    fileTransferList.innerHTML = "";
    const loading = document.createElement("li");
    loading.className = "directory-browser__status";
    loading.textContent = "Loading directories…";
    fileTransferList.append(loading);
  }
  syncFileTransferConfirmState();
  if (!fileTransferDialog.open) {
    fileTransferDialog.showModal();
  }
  const initialPath =
    transfer.destinationPath ??
    files.currentPath ??
    getParentDirectoryPath(sourcePath) ??
    sourcePath;
  await updateFileTransferBrowser(initialPath);
};

const submitFileTransfer = async () => {
  const transfer = state.files.transfer;
  if (!transfer.mode || transfer.submitting) return;
  if (!transfer.sourcePath || !transfer.destinationPath) {
    window.alert("Select a destination directory first.");
    return;
  }
  if (transfer.nameError) {
    window.alert(transfer.nameError);
    return;
  }
  const sourcePath = transfer.sourcePath;
  const mode = transfer.mode;
  const destinationName = transfer.destinationName;
  transfer.submitting = true;
  syncFileTransferConfirmState();
  try {
    if (mode === "move") {
      await moveFilesEntry(transfer.sourcePath, transfer.destinationPath, destinationName ?? null);
    } else {
      await copyFilesEntry(transfer.sourcePath, transfer.destinationPath, destinationName ?? null);
    }
    const refreshPath = state.files.currentPath;
    const moved = mode === "move";
    closeFileTransferDialog();
    if (moved && state.files.previewPath === sourcePath) {
      resetFilesPreview();
    }
    await loadFilesTree(refreshPath);
  } catch (error) {
    transfer.submitting = false;
    syncFileTransferConfirmState();
    const message = error instanceof Error ? error.message : "File operation failed";
    window.alert(message);
  }
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

const fetchAdminUsers = async () => {
  if (!state.identity.isAdmin) {
    return;
  }
  state.adminUsers.loading = true;
  try {
    const response = await fetch("/api/admin/users");
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
          ? payload.error
          : response.statusText || "Failed to load users";
      throw new Error(message);
    }
    const users = Array.isArray(payload?.users) ? payload.users : [];
    replaceAdminUsersList(users);
    state.adminUsers.error = null;
    state.adminUsers.pending.clear();
    if (currentRoute === "settings") {
      render();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load users";
    state.adminUsers.error = message;
    if (currentRoute === "settings") {
      render();
    }
  } finally {
    state.adminUsers.loading = false;
    if (currentRoute === "settings") {
      render();
    }
  }
};

const syncAdminNicknameDrafts = (users) => {
  if (!Array.isArray(users) || !(state.adminUsers.nicknameDrafts instanceof Map)) {
    return;
  }
  const drafts = state.adminUsers.nicknameDrafts;
  const validKeys = new Set();
  users.forEach((user) => {
    const key = normaliseNpubValue(user?.normalizedNpub ?? user?.npub);
    if (!key) return;
    validKeys.add(key);
    const nickname =
      typeof user?.nickname === "string" && user.nickname.trim().length > 0 ? user.nickname : "";
    drafts.set(key, nickname);
  });
  Array.from(drafts.keys()).forEach((key) => {
    if (!validKeys.has(key)) {
      drafts.delete(key);
    }
  });
};

const replaceAdminUsersList = (users) => {
  if (!Array.isArray(users)) return;
  const hydrated = users.map((user) => applyCachedPictureToUser(user));
  hydrateAdminPictureCacheFromUsers(hydrated);
  state.adminUsers.items = hydrated;
  state.adminUsers.initialized = true;
  syncAdminNicknameDrafts(hydrated);
  syncAdminSelectionState(hydrated);
  primeAdminUserPictures(hydrated);
};

const upsertAdminUser = (user) => {
  if (!user || typeof user !== "object") return;
  const hydratedUser = applyCachedPictureToUser(user);
  const items = Array.isArray(state.adminUsers.items) ? [...state.adminUsers.items] : [];
  const idx = items.findIndex((entry) => entry.normalizedNpub === user.normalizedNpub);
  if (idx >= 0) {
    items[idx] = hydratedUser;
  } else {
    items.push(hydratedUser);
  }
  items.sort((a, b) => {
    const left = (a?.nickname || a?.alias || a?.npub || "").toLowerCase();
    const right = (b?.nickname || b?.alias || b?.npub || "").toLowerCase();
    if (left === right) {
      return (a?.alias || "").localeCompare(b?.alias || "");
    }
    return left.localeCompare(right);
  });
  state.adminUsers.items = items;
  const key = normaliseNpubValue(user?.normalizedNpub ?? user?.npub);
  if (key && state.adminUsers.nicknameDrafts instanceof Map) {
    const nickname =
      typeof user?.nickname === "string" && user.nickname.trim().length > 0 ? user.nickname : "";
    state.adminUsers.nicknameDrafts.set(key, nickname);
  }
  primeAdminUserPictures(items);
};

const ensureAdminPictureRequestState = () => {
  if (!(state.adminUsers.pictureRequests instanceof Set)) {
    state.adminUsers.pictureRequests = new Set();
  }
};

const ensureAdminPictureCacheState = () => {
  if (!(state.adminUsers.pictureCache instanceof Map)) {
    state.adminUsers.pictureCache = new Map();
  }
};

const resolveFreshAdminPictureCache = (key) => {
  ensureAdminPictureCacheState();
  const entry = state.adminUsers.pictureCache.get(key);
  if (!entry || !isFiniteNumber(entry.fetchedAt)) {
    return null;
  }
  if (Date.now() - entry.fetchedAt > ADMIN_PICTURE_CACHE_TTL_MS) {
    return null;
  }
  return entry;
};

const memoiseAdminPicture = (key, url) => {
  ensureAdminPictureCacheState();
  state.adminUsers.pictureCache.set(key, { url: url ?? null, fetchedAt: Date.now() });
};

const applyCachedPictureToUser = (user) => {
  if (!user || typeof user !== "object") return user;
  const key = normaliseNpubValue(user?.normalizedNpub ?? user?.npub);
  if (!key) return user;
  const cached = resolveFreshAdminPictureCache(key);
  if (cached && cached.url && !user.pictureUrl) {
    return { ...user, pictureUrl: cached.url };
  }
  return user;
};

const hydrateAdminPictureCacheFromUsers = (users) => {
  if (!Array.isArray(users)) return;
  const now = Date.now();
  ensureAdminPictureCacheState();
  users.forEach((user) => {
    const key = normaliseNpubValue(user?.normalizedNpub ?? user?.npub);
    if (!key) return;
    if (typeof user?.pictureUrl === "string" && user.pictureUrl.length > 0) {
      state.adminUsers.pictureCache.set(key, { url: user.pictureUrl, fetchedAt: now });
    }
  });
};

const fetchAdminUserPicture = async (npub) => {
  if (!state.identity.isAdmin || typeof npub !== "string" || npub.length === 0) {
    return;
  }
  ensureAdminPictureRequestState();
  const key = normaliseNpubValue(npub) ?? npub;
  const cached = resolveFreshAdminPictureCache(key);
  if (cached) {
    return;
  }
  if (state.adminUsers.pictureRequests.has(key)) {
    return;
  }
  state.adminUsers.pictureRequests.add(key);
  let resolvedUser = null;
  try {
    const payload = await fetchAdminUserProfile({ npub });
    const users = Array.isArray(payload?.users) ? payload.users : null;
    const user = payload && typeof payload === "object" ? payload.user : null;
    if (Array.isArray(users)) {
      replaceAdminUsersList(users);
      resolvedUser = users.find(
        (entry) => normaliseNpubValue(entry?.normalizedNpub ?? entry?.npub) === normaliseNpubValue(key),
      );
    } else if (user && typeof user === "object") {
      upsertAdminUser(user);
      resolvedUser = user;
    }
    state.adminUsers.error = null;
    memoiseAdminPicture(key, resolvedUser?.pictureUrl ?? null);
  } catch (error) {
    console.warn("[admin] profile lookup failed:", error);
    memoiseAdminPicture(key, null);
  } finally {
    state.adminUsers.pictureRequests.delete(key);
    if (state.adminUsers.pictureRequests.size === 0 && currentRoute === "settings") {
      render();
    }
  }
};

const primeAdminUserPictures = (users) => {
  if (!state.identity.isAdmin) return;
  ensureAdminPictureRequestState();
  ensureAdminPictureCacheState();
  const now = Date.now();
  const list = Array.isArray(users) ? users : state.adminUsers.items;
  if (!Array.isArray(list)) return;
  list.forEach((user) => {
    const key = normaliseNpubValue(user?.normalizedNpub ?? user?.npub);
    if (!key || state.adminUsers.pictureRequests.has(key)) {
      return;
    }
    const cached = resolveFreshAdminPictureCache(key);
    if (cached) {
      if (cached.url && !user.pictureUrl) {
        user.pictureUrl = cached.url;
      }
      return;
    }
    if (typeof user?.pictureUrl === "string" && user.pictureUrl.length > 0) {
      state.adminUsers.pictureCache.set(key, { url: user.pictureUrl, fetchedAt: now });
      return;
    }
    void fetchAdminUserPicture(user.npub);
  });
};

const toggleUserOnboarding = async (npub, onboarded) => {
  if (!state.identity.isAdmin || typeof npub !== "string" || npub.length === 0) {
    return;
  }
  const normalizedKey = normaliseNpubValue(npub);
  const key = normalizedKey ?? npub;
  state.adminUsers.pending.add(key);
  if (currentRoute === "settings") {
    render();
  }
  try {
    const response = await fetch("/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ npub, onboarded }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
          ? payload.error
          : response.statusText || "Failed to update user";
      throw new Error(message);
    }
    const users = Array.isArray(payload?.users) ? payload.users : null;
    const user = payload && typeof payload === "object" ? payload.user : null;
    if (Array.isArray(users)) {
      replaceAdminUsersList(users);
      state.adminUsers.pending.clear();
    } else if (user && typeof user === "object") {
      upsertAdminUser(user);
    }
    state.adminUsers.error = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update user";
    state.adminUsers.error = message;
  } finally {
    state.adminUsers.pending.delete(key);
    if (currentRoute === "settings") {
      render();
    }
  }
};

const deleteAdminUser = async (npub, alias) => {
  if (!state.identity.isAdmin || typeof npub !== "string" || npub.length === 0) {
    return;
  }
  const displayName = (typeof alias === "string" && alias.length > 0) ? alias : npub;
  const confirmed = confirm(`Are you sure you want to delete user "${displayName}"? This action cannot be undone and will remove all their data.`);
  if (!confirmed) {
    return;
  }
  const key = normaliseNpubValue(npub) ?? npub;
  state.adminUsers.pending.add(key);
  if (currentRoute === "settings") {
    render();
  }
  try {
    const response = await fetch("/api/admin/users", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ npub }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
          ? payload.error
          : response.statusText || "Failed to delete user";
      throw new Error(message);
    }
    const users = Array.isArray(payload?.users) ? payload.users : null;
    if (Array.isArray(users)) {
      replaceAdminUsersList(users);
      state.adminUsers.pending.clear();
    }
    state.adminUsers.error = null;
    if (normalizedKey) {
      ensureAdminSelectionState().delete(normalizedKey);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete user";
    state.adminUsers.error = message;
  } finally {
    state.adminUsers.pending.delete(key);
    if (currentRoute === "settings") {
      render();
    }
  }
};

const deleteSelectedAdminUsers = async () => {
  const selectedUsers = getAdminSelectedUsers();
  if (selectedUsers.length === 0) {
    return;
  }
  const keys = selectedUsers
    .map((user) => getAdminUserKey(user))
    .filter((key) => typeof key === "string" && key.length > 0);
  if (keys.length === 0) {
    clearAdminSelection();
    return;
  }
  const identifiers = selectedUsers
    .map((user) => {
      if (!user || typeof user !== "object") return null;
      const nickname = typeof user.nickname === "string" && user.nickname.trim().length > 0 ? user.nickname.trim() : null;
      const alias = typeof user.alias === "string" && user.alias.trim().length > 0 ? user.alias.trim() : null;
      const npub = typeof user.npub === "string" && user.npub.length > 0 ? user.npub : null;
      return nickname ?? alias ?? npub;
    })
    .filter((value) => typeof value === "string" && value.length > 0);
  const displayPreview = identifiers.slice(0, 3).join(", ");
  const displayNames =
    selectedUsers.length === 1 && identifiers.length > 0
      ? `"${identifiers[0]}"`
      : identifiers.length > 0
        ? `${selectedUsers.length} users (${displayPreview}${identifiers.length > 3 ? ", …" : ""})`
        : `${selectedUsers.length} users`;
  const confirmed = confirm(
    `Are you sure you want to delete ${displayNames}? This action cannot be undone and will remove their data.`,
  );
  if (!confirmed) {
    return;
  }
  const pendingKeys = keys.map((key) => key ?? "");
  pendingKeys.forEach((key) => {
    if (!key) return;
    state.adminUsers.pending.add(key);
  });
  state.adminUsers.bulkDeleteBusy = true;
  if (currentRoute === "settings") {
    render();
  }
  try {
    const npubs = selectedUsers
      .map((user) => (typeof user.npub === "string" && user.npub.length > 0 ? user.npub : user.normalizedNpub))
      .filter((value) => typeof value === "string" && value.length > 0);
    if (npubs.length === 0) {
      throw new Error("No valid users selected");
    }
    const response = await fetch("/api/admin/users/bulk", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ npubs }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
          ? payload.error
          : response.statusText || "Failed to delete users";
      throw new Error(message);
    }
    const users = Array.isArray(payload?.users) ? payload.users : null;
    if (Array.isArray(users)) {
      replaceAdminUsersList(users);
      state.adminUsers.pending.clear();
      clearAdminSelection();
    }
    state.adminUsers.error = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete users";
    state.adminUsers.error = message;
  } finally {
    pendingKeys.forEach((key) => {
      if (!key) return;
      state.adminUsers.pending.delete(key);
    });
    state.adminUsers.bulkDeleteBusy = false;
    if (currentRoute === "settings") {
      render();
    }
  }
};

const updateAdminUserNickname = async (npub, nickname) => {
  if (!state.identity.isAdmin || typeof npub !== "string" || npub.length === 0) {
    return;
  }
  const key = normaliseNpubValue(npub) ?? npub;
  state.adminUsers.pending.add(key);
  if (currentRoute === "settings") {
    render();
  }

  try {
    const response = await fetch("/api/admin/users/nickname", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ npub, nickname }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
          ? payload.error
          : response.statusText || "Failed to update nickname";
      throw new Error(message);
    }
    const users = Array.isArray(payload?.users) ? payload.users : null;
    const user = payload && typeof payload === "object" ? payload.user : null;
    if (Array.isArray(users)) {
      replaceAdminUsersList(users);
      state.adminUsers.pending.clear();
    } else if (user && typeof user === "object") {
      upsertAdminUser(user);
    }
    const resolvedUser =
      user && typeof user === "object"
        ? user
        : Array.isArray(users)
          ? users.find(
              (entry) => normaliseNpubValue(entry?.normalizedNpub ?? entry?.npub) === normaliseNpubValue(key),
            )
          : null;
    if (key && state.adminUsers.nicknameDrafts instanceof Map && resolvedUser) {
      const updatedNickname =
        typeof resolvedUser.nickname === "string" && resolvedUser.nickname.trim().length > 0
          ? resolvedUser.nickname
          : "";
      state.adminUsers.nicknameDrafts.set(key, updatedNickname);
    }
    state.adminUsers.error = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update nickname";
    state.adminUsers.error = message;
  } finally {
    state.adminUsers.pending.delete(key);
    if (currentRoute === "settings") {
      render();
    }
  }
};

const ensureAdminBalanceToolState = () => {
  if (!state.adminUsers.balanceTool) {
    state.adminUsers.balanceTool = {
      identifier: "",
      amount: "",
      busy: false,
      error: null,
      success: null,
    };
  }
};

const submitAdminBalanceUpdate = async () => {
  if (!state.identity.isAdmin) {
    return;
  }
  ensureAdminBalanceToolState();
  const tool = state.adminUsers.balanceTool;
  const identifier = typeof tool.identifier === "string" ? tool.identifier.trim() : "";
  const amountInput = typeof tool.amount === "string" ? tool.amount.trim() : "";

  if (!identifier) {
    tool.error = "Enter a user alias or npub.";
    tool.success = null;
    if (currentRoute === "settings") {
      render();
    }
    return;
  }

  const parsedAmount = Number.parseInt(amountInput, 10);
  if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
    tool.error = "Enter a non-negative sats amount.";
    tool.success = null;
    if (currentRoute === "settings") {
      render();
    }
    return;
  }

  const payload = {
    balance: parsedAmount,
  };

  if (identifier.toLowerCase().startsWith("npub")) {
    payload.npub = identifier;
  } else {
    payload.alias = identifier;
  }

  tool.busy = true;
  tool.error = null;
  tool.success = null;
  if (currentRoute === "settings") {
    render();
  }

  try {
    const response = await fetch("/api/admin/users/balance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        data && typeof data === "object" && typeof data.error === "string" && data.error.length > 0
          ? data.error
          : response.statusText || "Failed to update balance";
      throw new Error(message);
    }

    const users = Array.isArray(data?.users) ? data.users : null;
    const user = data && typeof data === "object" ? data.user : null;
    if (Array.isArray(users)) {
      replaceAdminUsersList(users);
    } else if (user && typeof user === "object") {
      upsertAdminUser(user);
    }

    const updatedBalance =
      user && typeof user === "object" && Number.isFinite(user.balance) ? user.balance : parsedAmount;
    tool.success = `Balance set to ${formatSatoshis(updatedBalance)} sats.`;
    tool.identifier = "";
    tool.amount = "";
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update balance";
    tool.error = message;
    tool.success = null;
  } finally {
    tool.busy = false;
    if (currentRoute === "settings") {
      render();
    }
  }
};

const ensureAdminPortsToolState = () => {
  if (!state.adminUsers.portsTool) {
    state.adminUsers.portsTool = {
      npub: "",
      count: "3",
      busy: false,
      error: null,
      success: null,
    };
  }
};

const submitAdminPortsAssignment = async () => {
  if (!state.identity.isAdmin) {
    return;
  }
  ensureAdminPortsToolState();
  const tool = state.adminUsers.portsTool;
  const npubInput = typeof tool.npub === "string" ? tool.npub.trim() : "";
  const countInput = typeof tool.count === "string" ? tool.count.trim() : "";

  if (!npubInput) {
    tool.error = "Enter a user npub.";
    tool.success = null;
    if (currentRoute === "settings") {
      render();
    }
    return;
  }

  const parsedCount = Number.parseInt(countInput, 10);
  if (!Number.isFinite(parsedCount) || parsedCount < 1 || parsedCount > 100) {
    tool.error = "Enter a port count between 1 and 100.";
    tool.success = null;
    if (currentRoute === "settings") {
      render();
    }
    return;
  }

  const payload = {
    npub: npubInput,
    count: parsedCount,
  };

  tool.busy = true;
  tool.error = null;
  tool.success = null;
  if (currentRoute === "settings") {
    render();
  }

  try {
    const response = await fetch("/api/admin/users/ports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        data && typeof data === "object" && typeof data.error === "string" && data.error.length > 0
          ? data.error
          : response.statusText || "Failed to assign ports";
      throw new Error(message);
    }

    const users = Array.isArray(data?.users) ? data.users : null;
    const user = data && typeof data === "object" ? data.user : null;
    const newPorts = Array.isArray(data?.newPorts) ? data.newPorts : [];

    if (Array.isArray(users)) {
      replaceAdminUsersList(users);
    } else if (user && typeof user === "object") {
      upsertAdminUser(user);
    }

    const portsDisplay = newPorts.length > 0 ? newPorts.join(", ") : "ports";
    tool.success = `Assigned ${parsedCount} new port${parsedCount === 1 ? "" : "s"}: ${portsDisplay}`;
    tool.npub = "";
    tool.count = "3";
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to assign ports";
    tool.error = message;
    tool.success = null;
  } finally {
    tool.busy = false;
    if (currentRoute === "settings") {
      render();
    }
  }
};

const generateAdminPorts = async (count = 3) => {
  if (!state.identity.isAdmin) {
    return;
  }

  const parsedCount = Number.isFinite(count) && count > 0 && count <= 100 ? Math.trunc(count) : 3;

  try {
    const response = await fetch("/api/admin/ports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: parsedCount }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        data && typeof data === "object" && typeof data.error === "string" && data.error.length > 0
          ? data.error
          : response.statusText || "Failed to generate ports";
      throw new Error(message);
    }

    const users = Array.isArray(data?.users) ? data.users : null;
    const user = data && typeof data === "object" ? data.user : null;
    const newPorts = Array.isArray(data?.newPorts) ? data.newPorts : [];

    if (Array.isArray(users)) {
      replaceAdminUsersList(users);
    } else if (user && typeof user === "object") {
      upsertAdminUser(user);
    }

    if (user && Array.isArray(user.ports)) {
      state.identity.ports = user.ports;
    }

    return { success: true, newPorts };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate ports";
    return { success: false, error: message };
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

// Agent Status Indicator Functions
const resolveAgentRuntimeStatus = (sessionId) => {
  const session = state.sessions.find((entry) => entry && entry.id === sessionId);
  if (!session) {
    return null;
  }
  if (session.agentRuntimeStatus === "running" || session.agentRuntimeStatus === "stable") {
    return session.agentRuntimeStatus;
  }
  if (session.status === "running") {
    return "running";
  }
  return null;
};

const createAgentStatusIndicator = (sessionId, options = {}) => {
  const variant = typeof options.variant === "string" ? options.variant : "bar";
  const indicator = document.createElement(variant === "pill" ? "button" : "div");
  indicator.className = "wm-agent-status-indicator";
  indicator.setAttribute("data-session-id", sessionId);
  indicator.setAttribute("role", "status");
  indicator.setAttribute("aria-live", "polite");
  indicator.dataset.variant = variant;

  if (variant === "pill") {
    indicator.classList.add("wm-agent-status-pill");
    indicator.type = "button";
  }
  
  // Make all indicators clickable to open queue modal
  indicator.style.cursor = "pointer";
  indicator.addEventListener("click", () => {
    openPromptQueueModal(sessionId);
  });
  
  applyAgentStatusIndicatorState(indicator, sessionId);
  return indicator;
};

const applyAgentStatusIndicatorState = (indicator, sessionId) => {
  const status = resolveAgentRuntimeStatus(sessionId);
  const variant = indicator.dataset.variant ?? "bar";
  const preservedClasses = indicator.className
    .split(" ")
    .filter(
      (cls) =>
        cls &&
        (cls === "wm-agent-status-indicator" ||
          cls === "status-small" ||
          cls.startsWith("wm-agent-status-") ||
          !cls.startsWith("status-")),
    );
  const baseClasses = new Set(preservedClasses.length > 0 ? preservedClasses : ["wm-agent-status-indicator"]);
  baseClasses.add("wm-agent-status-indicator");
  // Remove any previous status-* classes except the optional small modifier
  for (const value of Array.from(baseClasses)) {
    if (value.startsWith("status-") && value !== "status-small") {
      baseClasses.delete(value);
    }
  }

  let ariaLabel = "Agent status: unknown";
  if (status === "running") {
    baseClasses.add("status-running");
    ariaLabel = "Agent status: running";
  } else if (status === "stable") {
    baseClasses.add("status-stable");
    ariaLabel = "Agent status: stable";
  } else {
    baseClasses.add("status-unknown");
  }

  indicator.className = Array.from(baseClasses).join(" ");
  indicator.setAttribute("aria-label", ariaLabel);
  
  // Get queue count for this session
  const queueCount = getQueueCount(sessionId);
  
  indicator.textContent =
    variant === "pill"
      ? queueCount > 0
        ? queueCount.toString()
        : status === "running"
          ? "0"
          : status === "stable"
            ? "-"
            : "?"
      : "";
};

const updateAgentStatusIndicators = () => {
  // Skip status updates on home route - no indicators visible
  if (currentRoute === "home") {
    return;
  }
  
  // Debounce status indicator updates to prevent performance issues
  if (updateAgentStatusIndicatorsDebounceTimer) {
    clearTimeout(updateAgentStatusIndicatorsDebounceTimer);
  }
  
  updateAgentStatusIndicatorsDebounceTimer = setTimeout(() => {
    document.querySelectorAll(".wm-agent-status-indicator").forEach((indicator) => {
      const sessionId = indicator.getAttribute("data-session-id");
      if (sessionId) {
        applyAgentStatusIndicatorState(indicator, sessionId);
      }
    });
    updateKnightRiderState();
    updateAgentStatusIndicatorsDebounceTimer = null;
  }, 100); // 100ms debounce for status updates
};

const updateKnightRiderState = (targetSessionId) => {
  document.querySelectorAll(".wm-knight-rider").forEach((element) => {
    const sessionId = element.dataset.sessionId;
    if (targetSessionId && sessionId !== targetSessionId) return;
    const session = state.sessions.find((s) => s.id === sessionId);
    const isBusy = isSessionBusy(session);
    element.classList.toggle("active", isBusy);
  });
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

  const conversation = state.conversations.get(sessionId) ?? [];
  const lastCount = state.lastMessageCount.get(sessionId) ?? 0;

  // Handle new messages
  if (conversation.length > lastCount) {
    const newMessages = conversation.slice(lastCount);

    newMessages.forEach((message) => {
      const bubble = document.createElement("article");
      bubble.className = `wm-message ${message.type ?? message.role ?? "assistant"}`;
      const body = document.createElement("pre");
      body.textContent = collapseNewlines(message.content ?? message.message ?? "");
      bubble.append(body);
      attachCopyButton(bubble);
      container.append(bubble);
    });

    state.lastMessageCount.set(sessionId, conversation.length);
  }

  // Handle updated messages (streaming SSE - message content changes)
  if (conversation.length === lastCount && conversation.length > 0) {
    const domMessages = container.querySelectorAll('.wm-message');
    let contentChanged = false;

    conversation.forEach((message, idx) => {
      const domMessage = domMessages[idx];
      if (domMessage) {
        attachCopyButton(domMessage);
        const body = domMessage.querySelector('pre');
        const currentContent = body?.textContent || '';
        const newContent = collapseNewlines(message.content ?? message.message ?? '');

        if (currentContent !== newContent) {
          contentChanged = true;
          if (body) {
            body.textContent = newContent;
          }
        }
      }
    });

    if (contentChanged) {
      state.lastMessageCount.set(sessionId, conversation.length);
    }
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
  onDirectoryPrefill: scheduleDirectorySuggestions,
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

const renderIdentitySummary = () => {
  const summary = document.createElement("div");
  summary.className = "wm-identity-summary";

  const aliasHeading = document.createElement("h2");
  aliasHeading.className = "wm-identity-alias";
  aliasHeading.dataset.role = "identity-alias";
  aliasHeading.textContent = "Not signed in";
  summary.append(aliasHeading);

  const guestCta = document.createElement("div");
  guestCta.className = "wm-identity-guest";
  guestCta.dataset.role = "identity-register";
  const registerButton = document.createElement("button");
  registerButton.type = "button";
  registerButton.className = "wm-button";
  registerButton.dataset.action = "identity-register";
  registerButton.textContent = "Register";
  const registerHelp = document.createElement("p");
  registerHelp.className = "wm-dialog-help";
  registerHelp.dataset.role = "identity-register-help";
  registerHelp.textContent = "We'll create you a brand new Nostr account and log you in.";
  guestCta.append(registerButton, registerHelp);
  summary.append(guestCta);

  const details = document.createElement("div");
  details.className = "wm-identity-summary-details";
  details.dataset.role = "identity-details";

  const list = document.createElement("dl");
  list.className = "wm-identity-summary-list";

  const npubLabel = document.createElement("dt");
  npubLabel.textContent = "npub";
  const npubValue = document.createElement("dd");
  npubValue.className = "wm-identity-summary-item";
  const npubText = document.createElement("span");
  npubText.dataset.role = "identity-npub";
  npubText.textContent = "Not signed in";
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "wm-icon-button";
  copyButton.dataset.action = "copy-active-npub";
  copyButton.setAttribute("aria-label", "Copy npub");
  copyButton.disabled = true;
  copyButton.innerHTML = '<span class="wm-icon" aria-hidden="true">📋</span>';
  const feedback = document.createElement("span");
  feedback.className = "wm-identity-copy-feedback";
  feedback.dataset.role = "identity-copy-feedback";
  feedback.hidden = true;
  npubValue.append(npubText, copyButton, feedback);

  const methodLabel = document.createElement("dt");
  methodLabel.textContent = "Method";
  const methodValue = document.createElement("dd");
  methodValue.dataset.role = "identity-method";
  methodValue.textContent = "—";

  const expiryLabel = document.createElement("dt");
  expiryLabel.textContent = "Session";
  const expiryValue = document.createElement("dd");
  expiryValue.dataset.role = "identity-expiry";
  expiryValue.textContent = "—";

  const balanceLabel = document.createElement("dt");
  balanceLabel.textContent = "Balance";
  const balanceValue = document.createElement("dd");
  balanceValue.dataset.role = "identity-balance";
  balanceValue.textContent = "—";

  list.append(
    npubLabel,
    npubValue,
    methodLabel,
    methodValue,
    expiryLabel,
    expiryValue,
    balanceLabel,
    balanceValue,
  );
  const actions = document.createElement("div");
  actions.className = "wm-identity-summary-actions";

  const copyNpubButton = document.createElement("button");
  copyNpubButton.type = "button";
  copyNpubButton.className = "wm-button";
  copyNpubButton.dataset.action = "copy-nostr-user-id";
  copyNpubButton.textContent = "Copy my Nostr User ID";
  copyNpubButton.disabled = true;
  actions.append(copyNpubButton);

  const copyNsecButton = document.createElement("button");
  copyNsecButton.type = "button";
  copyNsecButton.className = "wm-button";
  copyNsecButton.dataset.action = "copy-nostr-password";
  copyNsecButton.textContent = "Copy my Nostr Password";
  copyNsecButton.disabled = true;
  actions.append(copyNsecButton);

  const logoutButton = document.createElement("button");
  logoutButton.type = "button";
  logoutButton.className = "wm-button danger";
  logoutButton.dataset.action = "identity-logout";
  logoutButton.textContent = "Logout";
  actions.append(logoutButton);

  details.append(list, actions);
  summary.append(details);
  return summary;
};

const renderLocalIdentityPanel = () => {
  const panel = document.createElement("details");
  panel.className = "wm-identity-collapsible";
  panel.dataset.identityPanel = "local";
  panel.open = false;

  const summary = document.createElement("summary");
  summary.textContent = "BYO Nsec";
  panel.append(summary);

  const body = document.createElement("div");
  body.className = "wm-identity-panel";

  const description = document.createElement("p");
  description.className = "wm-identity-panel-description";
  description.textContent = "Bring your own nsec or generate a keypair stored on this device.";
  body.append(description);

  const actions = document.createElement("div");
  actions.className = "wm-identity-button-row";

  const generateBtn = document.createElement("button");
  generateBtn.type = "button";
  generateBtn.className = "wm-button";
  generateBtn.dataset.action = "generate-keys";
  generateBtn.textContent = "Generate Keys";
  actions.append(generateBtn);

  body.append(actions);

  const outputs = document.createElement("div");
  outputs.className = "wm-identity-output";

  const npubLine = document.createElement("div");
  npubLine.className = "wm-identity-output-line";
  const npubKeyLabel = document.createElement("span");
  npubKeyLabel.className = "wm-identity-output-label";
  npubKeyLabel.textContent = "npub";
  const npubValue = document.createElement("span");
  npubValue.className = "wm-identity-output-value";
  npubValue.dataset.role = "npub";
  npubLine.append(npubKeyLabel, npubValue);
  outputs.append(npubLine);

  const nsecRow = document.createElement("div");
  nsecRow.className = "wm-identity-secret-row";
  const nsecLabel = document.createElement("span");
  nsecLabel.className = "wm-identity-output-label";
  nsecLabel.textContent = "nsec";
  const nsecField = document.createElement("input");
  nsecField.type = "password";
  nsecField.readOnly = true;
  nsecField.className = "wm-identity-secret-field";
  nsecField.dataset.role = "nsec-field";
  nsecField.setAttribute("hidden", "");
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "wm-button secondary wm-identity-toggle-secret";
  toggleBtn.dataset.action = "toggle-nsec-visibility";
  toggleBtn.textContent = "Show secret";
  toggleBtn.hidden = true;
  nsecRow.append(nsecLabel, nsecField, toggleBtn);
  outputs.append(nsecRow);

  body.append(outputs);

  const importSection = document.createElement("div");
  importSection.className = "wm-identity-import-section";
  const importHeading = document.createElement("h4");
  importHeading.textContent = "Import nsec";
  importSection.append(importHeading);

  const importForm = document.createElement("form");
  importForm.className = "wm-identity-import";
  importForm.dataset.form = "import-nsec";

  const importInput = document.createElement("textarea");
  importInput.id = "identity-import-nsec";
  importInput.name = "nsec";
  importInput.rows = 2;
  importInput.autocomplete = "off";
  importInput.placeholder = "nsec1...";
  importInput.setAttribute("aria-label", "Import nsec private key");

  const importSubmit = document.createElement("button");
  importSubmit.type = "submit";
  importSubmit.className = "wm-button secondary";
  importSubmit.textContent = "Sign In";

  importForm.append(importInput, importSubmit);
  importSection.append(importForm);
  body.append(importSection);

  panel.append(body);

  return panel;
};

const renderNip07Panel = () => {
  const panel = document.createElement("details");
  panel.className = "wm-identity-collapsible";
  panel.dataset.identityPanel = "nip07";
  panel.open = false;

  const heading = document.createElement("summary");
  heading.textContent = "Browser Extension (NIP-07)";
  panel.append(heading);

  const body = document.createElement("div");
  body.className = "wm-identity-panel";

  const description = document.createElement("p");
  description.className = "wm-identity-panel-description";
  description.textContent = "Connect using a Nostr extension such as Alby, nos2x, or Flamingo.";
  body.append(description);

  const loginButton = document.createElement("button");
  loginButton.type = "button";
  loginButton.className = "wm-button";
  loginButton.dataset.action = "nip07-login";
  loginButton.textContent = "Connect Extension";
  body.append(loginButton);

  const status = document.createElement("p");
  status.className = "wm-identity-status-line";
  status.dataset.role = "nip07-status";
  status.setAttribute("aria-live", "polite");
  status.hidden = true;
  body.append(status);

  panel.append(body);
  return panel;
};

function renderNostrConnectSection() {
  const section = document.createElement("div");
  section.className = "wm-identity-subpanel";
  section.dataset.section = "nostrconnect";

  const title = document.createElement("h4");
  title.className = "wm-identity-subpanel__title";
  title.textContent = "Start from Wingman (nostrconnect://)";
  section.append(title);

  const description = document.createElement("p");
  description.className = "wm-identity-panel-description";
  description.textContent =
    "Generate a nostrconnect:// link for your bunker. Copy or scan to complete login from your signer.";
  section.append(description);

  const relays = document.createElement("p");
  relays.className = "wm-identity-helper";
  relays.dataset.role = "nostrconnect-relays";
  section.append(relays);

  const urlRow = document.createElement("div");
  urlRow.className = "wm-identity-row";

  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.readOnly = true;
  urlInput.placeholder = "nostrconnect://…";
  urlInput.dataset.role = "nostrconnect-url";
  urlRow.append(urlInput);

  const actions = document.createElement("div");
  actions.className = "wm-identity-inline-actions";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "wm-button wm-button--ghost";
  copyButton.dataset.action = "copy-nostrconnect-url";
  copyButton.textContent = "Copy link";
  actions.append(copyButton);

  const qrButton = document.createElement("button");
  qrButton.type = "button";
  qrButton.className = "wm-button wm-button--ghost";
  qrButton.dataset.action = "show-nostrconnect-qr";
  qrButton.textContent = "Show QR";
  actions.append(qrButton);

  urlRow.append(actions);
  section.append(urlRow);

  const status = document.createElement("p");
  status.className = "wm-identity-status-line";
  status.dataset.role = "nostrconnect-status";
  status.hidden = true;
  section.append(status);

  const qrContainer = document.createElement("div");
  qrContainer.className = "wm-identity-qr";
  qrContainer.dataset.role = "nostrconnect-qr";
  qrContainer.hidden = true;

  const qrCanvas = document.createElement("canvas");
  qrCanvas.width = 240;
  qrCanvas.height = 240;
  qrCanvas.dataset.role = "nostrconnect-qr-canvas";
  qrContainer.append(qrCanvas);

  const qrLabel = document.createElement("p");
  qrLabel.className = "wm-identity-helper";
  qrLabel.textContent = "Scan with your bunker to approve the request.";
  qrContainer.append(qrLabel);

  section.append(qrContainer);

  return section;
}

const renderBunkerPanel = () => {
  const panel = document.createElement("details");
  panel.className = "wm-identity-collapsible";
  panel.dataset.identityPanel = "bunker";
  panel.open = false;

  const heading = document.createElement("summary");
  heading.textContent = "Remote Signer";
  panel.append(heading);

  const body = document.createElement("div");
  body.className = "wm-identity-panel";

  const description = document.createElement("p");
  description.className = "wm-identity-panel-description";
  description.textContent = "Connect a remote signer with a bunker:// URI or share a nostrconnect:// request.";
  body.append(description);

  body.append(renderNostrConnectSection());

  const form = document.createElement("form");
  form.className = "wm-identity-bunker-form";
  form.dataset.form = "bunker-auth";

  const textarea = document.createElement("textarea");
  textarea.name = "bunkerUri";
  textarea.rows = 3;
  textarea.placeholder = "bunker://...";
  form.append(textarea);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "wm-button";
  submit.textContent = "Connect Bunker";
  form.append(submit);

  body.append(form);

  const status = document.createElement("p");
  status.className = "wm-identity-status-line";
  status.dataset.role = "bunker-status";
  status.setAttribute("aria-live", "polite");
  status.hidden = true;
  body.append(status);

  panel.append(body);
  return panel;
};

/**
 * Show Key Teleport Setup modal after copying registration code
 */
function showKeyTeleportSetupModal(appNpub) {
  // Create modal dialog
  const dialog = document.createElement("dialog");
  dialog.className = "wm-keyteleport-setup-dialog";

  const content = document.createElement("div");
  content.className = "wm-keyteleport-setup-dialog__content";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "wm-keyteleport-setup-dialog__close";
  closeBtn.innerHTML = "×";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.addEventListener("click", () => {
    dialog.close();
    dialog.remove();
  });
  content.append(closeBtn);

  const title = document.createElement("h2");
  title.className = "wm-keyteleport-setup-dialog__title";
  title.textContent = "Key Teleport Setup";
  content.append(title);

  const subtitle = document.createElement("p");
  subtitle.className = "wm-keyteleport-setup-dialog__subtitle";
  subtitle.textContent = "Registration blob copied to clipboard!";
  content.append(subtitle);

  const instructions = document.createElement("p");
  instructions.className = "wm-keyteleport-setup-dialog__instructions";
  instructions.textContent = "Paste this into your key manager (e.g., Welcome) to register this app.";
  content.append(instructions);

  const identityBox = document.createElement("div");
  identityBox.className = "wm-keyteleport-setup-dialog__identity";

  const identityLabel = document.createElement("span");
  identityLabel.className = "wm-keyteleport-setup-dialog__identity-label";
  identityLabel.textContent = "This app's identity:";
  identityBox.append(identityLabel);

  const identityValue = document.createElement("span");
  identityValue.className = "wm-keyteleport-setup-dialog__identity-value";
  identityValue.textContent = appNpub;
  identityBox.append(identityValue);

  content.append(identityBox);

  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "wm-button";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", () => {
    dialog.close();
    dialog.remove();
  });
  content.append(doneBtn);

  dialog.append(content);
  document.body.append(dialog);
  dialog.showModal();

  // Close on backdrop click
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) {
      dialog.close();
      dialog.remove();
    }
  });
}

/**
 * Render Key Teleport login section
 * This is a primary login option (not under Advanced)
 */
const renderKeyTeleportPanel = () => {
  const section = document.createElement("div");
  section.className = "wm-identity-keyteleport";
  section.dataset.section = "keyteleport";

  const title = document.createElement("h3");
  title.className = "wm-identity-keyteleport__title";
  title.textContent = "Key Teleport";
  section.append(title);

  const description = document.createElement("p");
  description.className = "wm-identity-panel-description";
  description.textContent = "Use your key manager (e.g., Welcome) to securely transfer your Nostr identity.";
  section.append(description);

  // Setup section (for first-time registration with Welcome)
  const setupDetails = document.createElement("details");
  setupDetails.className = "wm-identity-keyteleport__setup";

  const setupSummary = document.createElement("summary");
  setupSummary.textContent = "First time? Set up Key Teleport";
  setupDetails.append(setupSummary);

  const setupBody = document.createElement("div");
  setupBody.className = "wm-identity-keyteleport__setup-body";

  const setupInstructions = document.createElement("ol");
  setupInstructions.className = "wm-identity-keyteleport__instructions";
  setupInstructions.innerHTML = `
    <li>Copy the registration code below</li>
    <li>Open your key manager and go to Key Teleport settings</li>
    <li>Paste the code to register Wingman</li>
    <li>Once registered, you can teleport your identity anytime</li>
  `;
  setupBody.append(setupInstructions);

  const copyRow = document.createElement("div");
  copyRow.className = "wm-identity-button-row";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "wm-button";
  copyButton.dataset.action = "keyteleport-copy-registration";
  copyButton.textContent = "Copy Registration Code";
  copyRow.append(copyButton);

  setupBody.append(copyRow);
  setupDetails.append(setupBody);
  section.append(setupDetails);

  const helper = document.createElement("p");
  helper.className = "wm-identity-helper";
  helper.dataset.role = "keyteleport-helper";
  helper.innerHTML = 'Don\'t have a key manager? <a href="https://welcome.nostr.com" target="_blank" rel="noopener">Try Welcome</a>';
  section.append(helper);

  // Check if Key Teleport is configured and update UI
  fetch("/api/auth/keyteleport/config")
    .then((res) => res.json())
    .then((config) => {
      if (!config.enabled) {
        section.hidden = true;
        return;
      }

      // Handle copy registration button
      copyButton.addEventListener("click", async () => {
        try {
          copyButton.disabled = true;
          copyButton.textContent = "Generating...";

          const regRes = await fetch("/api/auth/keyteleport/registration");
          const regData = await regRes.json();

          if (!regRes.ok || !regData.blob) {
            throw new Error(regData.error ?? "Failed to generate registration code");
          }

          await navigator.clipboard.writeText(regData.blob);

          // Show the setup modal with app's npub
          showKeyTeleportSetupModal(regData.appNpub);

          copyButton.textContent = "Copy Registration Code";
        } catch (err) {
          alert(err.message ?? "Failed to copy registration code");
          copyButton.textContent = "Copy Registration Code";
        } finally {
          copyButton.disabled = false;
        }
      });
    })
    .catch(() => {
      section.hidden = true;
    });

  return section;
};

const renderIdentityPanel = (options = {}) => {
  const variant = options.variant ?? "settings";
  const card = document.createElement("section");
  card.className = "wm-card";
  if (variant === "settings") {
    card.classList.add("wm-settings-identity");
    card.id = "identity-panel";
  } else if (variant === "dialog") {
    card.classList.add("wm-identity-dialog-card");
  } else {
    card.classList.add("wm-identity-panel-card");
  }

  const header = document.createElement("div");
  header.className = "wm-home-section-header";
  const title = document.createElement("h2");
  title.textContent = "Identity";
  header.append(title);
  card.append(header);

  const summary = renderIdentitySummary();
  card.append(summary);

  // Key Teleport: primary login option (before Advanced)
  const keyTeleportPanel = renderKeyTeleportPanel();
  card.append(keyTeleportPanel);

  const advanced = document.createElement("details");
  advanced.className = "wm-identity-advanced";
  advanced.open = false;
  const advancedSummary = document.createElement("summary");
  advancedSummary.className = "wm-identity-advanced-summary";
  advancedSummary.textContent = "Advanced options";
  advanced.append(advancedSummary);

  const advancedBody = document.createElement("div");
  advancedBody.className = "wm-identity-advanced-body";
  const divider = document.createElement("hr");
  divider.className = "wm-identity-divider";
  divider.setAttribute("aria-hidden", "true");
  advancedBody.append(divider);

  const panels = document.createElement("div");
  panels.className = "wm-identity-panels";
  panels.append(renderLocalIdentityPanel(), renderNip07Panel(), renderBunkerPanel());
  advancedBody.append(panels);

  advanced.append(advancedBody);
  card.append(advanced);

  registerIdentityDom(card);
  bindIdentityFlows(card);

  return card;
};

let detachMenuIdentitySectionListener = null;

const renderMenuIdentitySection = () => {
  if (!menuIdentityContainer) return;
  detachMenuIdentitySectionListener?.();
  menuIdentityContainer.innerHTML = "";

  const card = document.createElement("section");
  card.className = "wm-menu-identity-card";

  const info = document.createElement("div");
  info.className = "wm-menu-identity-info";
  const avatar = document.createElement("div");
  avatar.className = "wm-menu-identity-avatar";

  const label = document.createElement("span");
  label.className = "wm-menu-identity-label";
  label.textContent = "Identity";

  const alias = document.createElement("span");
  alias.className = "wm-menu-identity-alias";

  info.append(label, alias);

  const manageButton = document.createElement("button");
  manageButton.type = "button";
  manageButton.className = "wm-link-button wm-menu-identity-manage";
  manageButton.textContent = "Settings";
  manageButton.addEventListener("click", () => {
    navigateToSettings();
  });

  card.append(avatar, info, manageButton);
  menuIdentityContainer.append(card);

  const updateSection = () => {
    const { npub, alias: identityAlias, picture } = state.identity;
    if (npub) {
      const truncated = npub.length > 20 ? `${npub.slice(0, 10)}…${npub.slice(-4)}` : npub;
      const displayName = identityAlias ?? truncated;
      alias.textContent = displayName;
      alias.title = identityAlias ? npub : truncated;
      manageButton.hidden = false;
      applyAvatarImage(avatar, picture, displayName);
    } else {
      alias.textContent = "Not signed in";
      alias.removeAttribute("title");
      manageButton.hidden = true;
      applyAvatarImage(avatar, null, "?");
    }
  };

  const identityEventHandler = () => {
    updateSection();
  };
  const trackedEvents = ["wingman:identity-ui-state", ...IDENTITY_EVENT_NAMES];
  trackedEvents.forEach((eventName) => {
    window.addEventListener(eventName, identityEventHandler);
  });

  detachMenuIdentitySectionListener = () => {
    trackedEvents.forEach((eventName) => {
      window.removeEventListener(eventName, identityEventHandler);
    });
    detachMenuIdentitySectionListener = null;
  };

  updateSection();
};

const HOME_GUEST_FEATURES = [
  {
    icon: "🌍",
    title: "Interact with your agents from anywhere",
    description:
      "Stay connected to your automations and copilots from any device so your work keeps flowing even away from your main workstation.",
  },
  {
    icon: "🤝",
    title: "Share Claude, Codex, and Goose setups",
    description:
      "Package your preferred agent configurations once and roll them out to the rest of the team with shared guardrails and credentials.",
  },
  {
    icon: "⚡",
    title: "Orchestrate common business processes",
    description:
      "Coordinate hand-offs, approvals, and back-office tasks with reproducible workflows that run on schedule or on demand.",
  },
  {
    icon: "🚀",
    title: "Build custom apps in minutes",
    description:
      "Compose bespoke UIs and automations around your agents without leaving Wingman, then deploy them to the people who need them.",
  },
  {
    icon: "🎯",
    title: "Run your business on Wingman",
    description:
      "Centralize knowledge, tooling, and agent-powered operations in one control plane that scales as your team grows.",
  },
];

const renderHomeGuestHero = () => {
  return createHomeGuestHero({
    onLogin: openIdentityLoginDialog,
    onBrowse: () => navigateToApps(),
  });
};

const renderHomeGuestFeatures = () => {
  const card = document.createElement("section");
  card.className = "wm-card wm-home-guest-features";

  const header = document.createElement("div");
  header.className = "wm-home-section-header";
  const title = document.createElement("h2");
  title.textContent = "What you can do with Wingman";
  header.append(title);

  const list = document.createElement("ul");
  list.className = "wm-home-guest-feature-list";

  HOME_GUEST_FEATURES.forEach(({ icon, title: featureTitle, description }) => {
    const item = document.createElement("li");
    item.className = "wm-home-guest-feature";

    const itemIcon = document.createElement("div");
    itemIcon.className = "wm-home-guest-feature-icon";
    itemIcon.textContent = icon;

    const itemTitle = document.createElement("h3");
    itemTitle.textContent = featureTitle;

    const itemDescription = document.createElement("p");
    itemDescription.textContent = description;

    item.append(itemIcon, itemTitle, itemDescription);
    list.append(item);
  });

  card.append(header, list);
  return card;
};

const renderHome = () => {
  const wrapper = document.createElement("div");
  wrapper.className = "wm-home";

  if (!state.identity.authenticated) {
    wrapper.className = "wm-home wm-home-guest-landing";

    const content = document.createElement("div");
    content.className = "wm-home-guest-content";

    const heroText = document.createElement("div");
    heroText.className = "wm-home-guest-hero-text";

    const line1 = document.createElement("div");
    line1.className = "wm-home-guest-hero-line";
    line1.textContent = "YOU";

    const line2 = document.createElement("div");
    line2.className = "wm-home-guest-hero-line";
    line2.textContent = "CAN JUST";

    const line3 = document.createElement("div");
    line3.className = "wm-home-guest-hero-line";
    line3.textContent = "DO THINGS!";

    heroText.append(line1, line2, line3);

    const loginButton = document.createElement("button");
    loginButton.type = "button";
    loginButton.className = "wm-home-guest-login-button";
    loginButton.textContent = "LOG IN";
    loginButton.addEventListener("click", () => {
      openIdentityLoginDialog();
    });

    content.append(heroText, loginButton);

    const footer = document.createElement("footer");
    footer.className = "wm-home-guest-footer";

    const footerText = document.createElement("p");
    footerText.textContent = "Manage your own business - ";

    const footerLink = document.createElement("a");
    footerLink.href = "https://primal.net/pw";
    footerLink.textContent = "pw21";
    footerLink.target = "_blank";
    footerLink.rel = "noopener noreferrer";

    footerText.append(footerLink);

    const footerLinks = document.createElement("div");
    footerLinks.className = "wm-home-guest-footer__links";
    const privacyLink = document.createElement("a");
    privacyLink.href = PRIVACY_ROUTE;
    privacyLink.textContent = "Privacy Policy";
    privacyLink.addEventListener("click", (e) => {
      e.preventDefault();
      currentRoute = "privacy";
      window.history.pushState({ route: "privacy" }, "", PRIVACY_ROUTE);
      render();
    });
    footerLinks.append(privacyLink);

    footer.append(footerText, footerLinks);

    wrapper.append(content, footer);
    return wrapper;
  }

  ensureFeatureFlagsLoaded();

  if (!state.apps.initialized && !state.apps.loading) {
    // void ensureAppsLoaded(); // DISABLED
  }

  let orchestratorCard = null;
  if (orchestratorFeatureEnabledForViewer()) {
    orchestratorCard = document.createElement("section");
    orchestratorCard.className = "wm-card wm-home-orchestrator";

    const orchestratorHeader = document.createElement("div");
    orchestratorHeader.className = "wm-home-section-header";

    const orchestratorTitle = document.createElement("h2");
    orchestratorTitle.textContent = "Orchestrator";

    const orchestratorContent = document.createElement("div");
    orchestratorContent.className = "wm-home-orchestrator-content";
    orchestratorContent.id = "orchestrator-content";

    const setOrchestratorCollapsed = (collapsed) => {
      if (collapsed) {
        orchestratorCard.dataset.collapsed = "true";
        orchestratorContent.hidden = true;
        orchestratorHeader.setAttribute("aria-expanded", "false");
      } else {
        delete orchestratorCard.dataset.collapsed;
        orchestratorContent.hidden = false;
        orchestratorHeader.setAttribute("aria-expanded", "true");
      }
    };

    const orchestratorCreateButton = document.createElement("button");
    orchestratorCreateButton.type = "button";
    orchestratorCreateButton.className = "wm-button secondary wm-button-icon";
    orchestratorCreateButton.setAttribute("aria-label", "Add orchestrator preset");
    orchestratorCreateButton.innerHTML = '<span aria-hidden="true">+</span>';
    orchestratorCreateButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openOrchestratorDialog();
    });

    const orchestratorHeaderActions = document.createElement("div");
    orchestratorHeaderActions.className = "wm-home-section-actions";
    orchestratorHeaderActions.append(orchestratorCreateButton);

    const orchestratorActions = document.createElement("div");
    orchestratorActions.className = "wm-home-orchestrator-actions";
    renderOrchestratorPresetButtons(orchestratorActions);

    if (!state.orchestratorPresetsLoaded && !state.orchestratorPresetsLoading) {
      ensureOrchestratorPresetsLoaded();
    }

    // Make header clickable to toggle collapse
    orchestratorHeader.addEventListener("click", (event) => {
      if (orchestratorCreateButton.contains(event.target)) return;
      const currentlyCollapsed = orchestratorCard.dataset.collapsed === "true";
      setOrchestratorCollapsed(!currentlyCollapsed);
    });

    orchestratorHeader.append(orchestratorTitle, orchestratorHeaderActions);
    orchestratorContent.append(orchestratorActions);
    orchestratorCard.append(orchestratorHeader, orchestratorContent);
    setOrchestratorCollapsed(false);
  }

  const appsCard = document.createElement("section");
  appsCard.className = "wm-card wm-home-apps";

  const appsHeader = document.createElement("div");
  appsHeader.className = "wm-home-section-header";

  const appsTitle = document.createElement("h2");
  appsTitle.textContent = "Running Apps";
  const appsHeaderActions = document.createElement("div");
  appsHeaderActions.className = "wm-home-section-actions";

  const newAppButton = document.createElement("button");
  newAppButton.type = "button";
  newAppButton.className = "wm-button secondary";
  newAppButton.textContent = "New App";
  newAppButton.addEventListener("click", (event) => {
    event.preventDefault();
    navigateToApps({ openNewAppDialog: true });
  });

  appsHeaderActions.append(newAppButton);
  appsHeader.append(appsTitle, appsHeaderActions);
  appsCard.append(appsHeader);

  const appsContent = document.createElement("div");
  appsContent.className = "wm-home-apps-content";

  if (state.apps.error) {
    const error = document.createElement("p");
    error.className = "wm-home-apps-status";
    error.textContent = state.apps.error;
    appsContent.append(error);
  } else {
    const runningApps = Array.isArray(state.apps.items)
      ? state.apps.items.filter((app) => app?.status?.status === "running")
      : [];

    if (state.apps.loading && !state.apps.initialized) {
      const loading = document.createElement("p");
      loading.className = "wm-home-apps-status";
      loading.textContent = "Loading apps…";
      appsContent.append(loading);
    } else if (runningApps.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-home-apps-status";
      empty.textContent = "No apps are currently running.";
      appsContent.append(empty);
    } else {
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
        const row = document.createElement("tr");

        const nameCell = document.createElement("td");
        nameCell.textContent = app.label ?? app.id;
        row.append(nameCell);

        const statusCell = document.createElement("td");
        const statusValue = app?.status?.status ?? "unknown";
        statusCell.textContent = APP_STATUS_LABELS[statusValue] ?? statusValue;
        row.append(statusCell);

        const rootCell = document.createElement("td");
        rootCell.textContent = app.root ?? "—";
        rootCell.title = app.root ?? "";
        row.append(rootCell);

        const actionsCell = document.createElement("td");
        actionsCell.className = "wm-home-apps-actions";

        const addActionButton = (action) => {
          if (!app.availableScripts?.[action]) return;
          if (app.id === "wingman-core" && action === "stop") return;
          const button = document.createElement("button");
          button.type = "button";
          button.className = action === "stop" ? "wm-button secondary" : "wm-button";
          button.textContent = APP_ACTION_LABELS[action] ?? action;
          button.disabled = isAppActionDisabled(app, action);
          button.addEventListener("click", async () => {
            if (button.disabled) return;
            button.disabled = true;
            const success = await triggerAppAction(app.id, action);
            if (!success && button.isConnected) {
              button.disabled = false;
            }
          });
          actionsCell.append(button);
        };

        addActionButton("stop");
        addActionButton("restart");

        if (!actionsCell.hasChildNodes()) {
          actionsCell.textContent = "—";
        }

        row.append(actionsCell);
        tbody.append(row);
      });

      table.append(tbody);
      appsContent.append(table);
    }
  }

  appsCard.append(appsContent);

  const liveCard = document.createElement("section");
  liveCard.className = "wm-card wm-home-live";

  const liveHeader = document.createElement("div");
  liveHeader.className = "wm-home-section-header";

  const liveTitle = document.createElement("h2");
  liveTitle.textContent = "Live Agents";

  const liveContent = document.createElement("div");
  liveContent.className = "wm-home-live-content";
  liveContent.id = "live-agents-content";

  const setCollapsed = (collapsed) => {
    if (collapsed) {
      liveCard.dataset.collapsed = "true";
      liveContent.hidden = true;
    } else {
      delete liveCard.dataset.collapsed;
      liveContent.hidden = false;
    }
  };

  // Make header clickable to toggle collapse
  liveHeader.addEventListener("click", () => {
    const currentlyCollapsed = liveCard.dataset.collapsed === "true";
    setCollapsed(!currentlyCollapsed);
  });

  liveHeader.append(liveTitle);
  liveCard.append(liveHeader);

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

  const actions = document.createElement("div");
  actions.className = "wm-actions";

  if (state.identity.isAdmin) {
    const filterContainer = document.createElement("div");
    filterContainer.className = "wm-session-filter";
    const filterLabel = document.createElement("label");
    filterLabel.textContent = "Identities";
    const filterSelect = document.createElement("select");
    filterSelect.className = "wm-select";
    buildSessionFilterOptions().forEach((option) => {
      const opt = document.createElement("option");
      opt.value = option.value;
      opt.textContent = option.label;
      const currentFilterNpub = sessionsStore()?.filters?.npub ?? state.sessionFilters.npub;
      if (option.value === currentFilterNpub) {
        opt.selected = true;
      }
      filterSelect.append(opt);
    });
    filterSelect.addEventListener("change", (event) => {
      const target = event.target;
      const value = target instanceof HTMLSelectElement && target.value ? target.value : "all";
      state.sessionFilters.npub = value;
      state.sessionFilters.initialized = true;
      const ss = sessionsStore();
      if (ss) {
        ss.filters.npub = value;
        ss.filters.initialized = true;
      }
      void fetchSessions().then(() => {
        syncMenuTabs();
        if (currentRoute === "home" || currentRoute === "live") {
          render();
        }
      });
    });
    filterLabel.append(filterSelect);
    filterContainer.append(filterLabel);
    actions.append(filterContainer);
  }

  const launchBtn = document.createElement("button");
  launchBtn.className = "wm-button";
  launchBtn.textContent = "Launch Agent Session";
  launchBtn.addEventListener("click", openDialog);
  actions.append(launchBtn);

  const privateChatBtn = document.createElement("button");
  privateChatBtn.className = "wm-button secondary";
  privateChatBtn.textContent = "Private Chats";
  privateChatBtn.title = "View private AI chats";
  privateChatBtn.addEventListener("click", () => navigateToChat(null));
  actions.append(privateChatBtn);

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "wm-button secondary";
  refreshBtn.textContent = "Refresh";
  refreshBtn.title = "Refresh sessions";
  refreshBtn.addEventListener("click", () => {
    void pollSessionsLoop();
  });
  actions.append(refreshBtn);

  const table = document.createElement("table");
  table.className = "session-table";

  const colgroup = document.createElement("colgroup");
  [
    "actions",
    "name",
    "agent",
    "identity",
    "status",
    "port",
    "pid",
    "started",
    "directory",
  ].forEach((key) => {
    const col = document.createElement("col");
    col.className = `session-col-${key}`;
    colgroup.append(col);
  });
  table.append(colgroup);

  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr><th>Actions</th><th>Name</th><th>Agent</th><th>Identity</th><th>Status</th><th>Port</th><th>PID</th><th>Started</th><th>Directory</th></tr>";
  table.append(thead);

  const tbody = document.createElement("tbody");
  if (state.sessions.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 9;
    cell.textContent = "No active sessions";
    row.append(cell);
    tbody.append(row);
  } else {
    state.sessions.forEach((session) => {
      const row = document.createElement("tr");
      const displayName = getSessionDisplayName(session);
      const identityAlias = typeof session.identityAlias === "string" && session.identityAlias.trim().length > 0 ? session.identityAlias.trim() : null;
      const identityLabel = identityAlias ?? (session.npub && session.npub.length > 0 ? session.npub : "Anonymous");
      const identityTooltip = session.npub && session.npub.length > 0 ? session.npub : identityLabel;
      row.innerHTML = `
        <td class="actions-cell"></td>
        <td class="session-name-cell">
          <span class="session-name-text">${escapeHtml(displayName)}</span>
          <button type="button" class="wm-link-button session-name-edit" data-action="rename-session">Edit</button>
        </td>
        <td>${escapeHtml(session.agent)}</td>
        <td class="identity-cell" title="${escapeHtml(identityTooltip)}">${escapeHtml(identityLabel)}</td>
        <td class="session-status-cell">
          <div class="wm-agent-status-indicator" data-session-id="${escapeHtml(session.id)}"></div>
          <span class="session-status-text">${escapeHtml(session.status)}</span>
        </td>
        <td>${escapeHtml(session.port)}</td>
        <td>${session.pid ?? "-"}</td>
        <td>${new Date(session.startedAt).toLocaleTimeString()}</td>
        <td class="directory-cell"></td>
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
      const renameButton = row.querySelector('[data-action="rename-session"]');
      if (renameButton instanceof HTMLButtonElement) {
        renameButton.addEventListener("click", (event) => {
          event.preventDefault();
          promptRenameSession(session);
        });
      }

      const actionsCell = row.querySelector(".actions-cell");
      if (actionsCell) {
        renderSessionActions(actionsCell, session);
      }
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
      const displayName = getSessionDisplayName(session);
      title.textContent = displayName;
      const statusContainer = document.createElement("div");
      statusContainer.className = "session-status-container";
      const statusIndicator = createAgentStatusIndicator(session.id);
      statusIndicator.className += " status-small"; // Add small variant
      const status = document.createElement("span");
      status.className = `session-status ${session.status}`;
      status.textContent = session.status;
      statusContainer.append(statusIndicator, status);
      const headerActions = document.createElement("div");
      headerActions.className = "session-card-header-actions";
      const editLink = document.createElement("button");
      editLink.type = "button";
      editLink.className = "wm-link-button session-card-edit";
      editLink.textContent = "Edit name";
      editLink.addEventListener("click", (event) => {
        event.preventDefault();
        promptRenameSession(session);
      });
      headerActions.append(statusContainer, editLink);
      header.append(title, headerActions);
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

      addDetail("Agent", session.agent);
      addDetail("Identity", session.npub ?? "Anonymous");
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

  liveContent.append(actions, cardsContainer, tableContainer);
  liveCard.append(liveContent);

  setCollapsed(false);
  wrapper.append(appsCard);
  wrapper.append(liveCard);
  if (orchestratorCard) {
    wrapper.append(orchestratorCard);
  }

  // Add archive component
  archiveComponent = createArchiveComponent({
    onViewSession: (session) => {
      // Navigate to live view to show the archived session
      const targetPath = `${LIVE_ROUTE_PREFIX}/${session.id}`;
      window.history.pushState({ route: "live", sessionId: session.id }, "", targetPath);
      currentRoute = "live";
      render();
    },
  });
  wrapper.append(archiveComponent.element);

  return wrapper;
};

const promptCreateDirectory = async () => {
  const files = state.files;
  if (files.loading) return;
  const parentPath = files.currentPath;
  const rawName = window.prompt("Folder name", "New Folder");
  const name = rawName?.trim();
  if (!name) return;
  files.loading = true;
  if (currentRoute === "files") render();
  try {
    const result = await createFilesDirectory(parentPath, name);
    await loadFilesTree(result?.path ?? parentPath);
  } catch (error) {
    files.loading = false;
    if (currentRoute === "files") render();
    const message = error instanceof Error ? error.message : "Failed to create directory";
    window.alert(message);
  }
};

const promptCreateFile = async () => {
  const files = state.files;
  if (files.loading) return;
  const parentPath = files.currentPath;
  const rawName = window.prompt("File name (include extension)", "notes.txt");
  const name = rawName?.trim();
  if (!name) return;
  files.loading = true;
  if (currentRoute === "files") render();
  try {
    const result = await createFilesTextFile(parentPath, name, "");
    await loadFilesTree(parentPath);
    if (result?.path) {
      if (result.previewable) {
        void loadFilesPreview(result.path);
      } else {
        resetFilesPreview();
        if (currentRoute === "files") render();
      }
      void openFileEditor(result.path, result.displayPath ?? null, result.name ?? null);
    }
  } catch (error) {
    files.loading = false;
    if (currentRoute === "files") render();
    const message = error instanceof Error ? error.message : "Failed to create file";
    window.alert(message);
  }
};

const uploadSelectedFile = async (file) => {
  if (!(file instanceof File)) return;
  const files = state.files;
  if (files.loading || files.uploading) return;
  const parentPath = files.currentPath;
  files.uploading = true;
  if (currentRoute === "files") render();
  try {
    const result = await uploadFilesBinary(parentPath, file);
    await loadFilesTree(parentPath);
    if (result?.path && result.previewable) {
      void loadFilesPreview(result.path);
    }
  } catch (error) {
    files.uploading = false;
    if (currentRoute === "files") render();
    const message = error instanceof Error ? error.message : "Failed to upload file";
    window.alert(message);
    return;
  }
  files.uploading = false;
  if (currentRoute === "files") render();
};

const promptUploadFile = () => {
  const files = state.files;
  if (files.loading || files.uploading) return;
  const input = document.createElement("input");
  input.type = "file";
  input.hidden = true;
  input.addEventListener("change", () => {
    const [selected] = input.files ?? [];
    if (selected) {
      void uploadSelectedFile(selected);
    }
    input.remove();
  });
  input.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  document.body.append(input);
  input.click();
};

const runGitCommand = async (action) => {
  if (!action) return "cancelled";
  const files = state.files;
  if (files.gitCommandPending) return "cancelled";

  const requiresRepository = action !== "init";
  const gitInfo = files.git;
  const inRepository = Boolean(gitInfo?.isRepository);

  if (requiresRepository && !inRepository) {
    window.alert("Initialize a git repository before running this command.");
    return "cancelled";
  }

  const directory =
    action === "init" && !inRepository ? files.currentPath ?? gitInfo?.repoRoot ?? null : gitInfo?.repoRoot ?? files.currentPath ?? null;

  if (!directory) {
    window.alert("Select a directory before running git commands.");
    return "cancelled";
  }

  const payload = { action, directory };

  if (action === "commit") {
    const rawMessage = window.prompt("Commit message", "");
    if (rawMessage === null) {
      return "cancelled";
    }
    const message = rawMessage.trim();
    if (!message) {
      window.alert("Commit message cannot be empty.");
      return "cancelled";
    }
    payload.message = message;
  } else if (action === "push") {
    const remotePrompt = window.prompt("Remote name (leave blank for tracked remote)", "");
    if (remotePrompt === null) {
      return "cancelled";
    }
    const remote = remotePrompt.trim();
    const defaultBranch =
      gitInfo?.currentBranch && gitInfo.currentBranch !== "HEAD" ? gitInfo.currentBranch : "";
    const branchPrompt = window.prompt("Branch name (leave blank for current tracking branch)", defaultBranch);
    if (branchPrompt === null) {
      return "cancelled";
    }
    const branch = branchPrompt.trim();
    if (remote) {
      payload.remote = remote;
      if (branch) {
        payload.branch = branch;
      }
    }
  } else if (action === "pushUpstream") {
    const remotePrompt = window.prompt("Remote name", "origin");
    if (remotePrompt === null) {
      return "cancelled";
    }
    const remote = remotePrompt.trim() || "origin";
    const defaultBranch =
      gitInfo?.currentBranch && gitInfo.currentBranch !== "HEAD" ? gitInfo.currentBranch : "main";
    const branchPrompt = window.prompt("Branch name", defaultBranch);
    if (branchPrompt === null) {
      return "cancelled";
    }
    const branch = branchPrompt.trim();
    if (!branch) {
      window.alert("Branch name is required to set upstream.");
      return "cancelled";
    }
    payload.remote = remote;
    payload.branch = branch;
  }

  files.gitCommandPending = true;
  if (currentRoute === "files") {
    render();
  }

  try {
    const response = await fetch("/api/docs/git", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok) {
      const exitCode = typeof data?.exitCode === "number" ? ` (exit ${data.exitCode})` : "";
      const message = typeof data?.error === "string" && data.error.length > 0 ? data.error : "Git command failed";
      throw new Error(`${message}${exitCode}`);
    }

    const stdout = typeof data?.stdout === "string" ? data.stdout.trim() : "";
    const stderr = typeof data?.stderr === "string" ? data.stderr.trim() : "";
    const output = [stdout, stderr].filter((part) => part.length > 0).join("\n");
    window.alert(output || "Git command completed successfully.");

    if (files.currentPath) {
      await loadFilesTree(files.currentPath);
    } else {
      await loadFilesTree();
    }
    return "success";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    window.alert(message);
    return "error";
  } finally {
    files.gitCommandPending = false;
    if (currentRoute === "files") {
      render();
    }
  }
};

const renderFiles = () => {
  const files = state.files;
  if (!files.initialized) {
    files.initialized = true;
    void loadFilesTree();
  }

  const wrapper = document.createElement("div");
  wrapper.className = "wm-files";

  const layout = document.createElement("div");
  layout.className = "wm-files-layout";

  const browserCard = document.createElement("section");
  browserCard.className = "wm-card wm-files-browser";

  const browserHeader = document.createElement("div");
  browserHeader.className = "wm-files-browser__header";

  const headerButton = document.createElement("button");
  headerButton.type = "button";
  headerButton.className = "wm-files-browser__info";
  headerButton.setAttribute("aria-expanded", "true");
  const headerTitle = document.createElement("h2");
  headerTitle.textContent = "Files";
  const pathLabel = document.createElement("span");
  pathLabel.className = "wm-files-browser__path";
  pathLabel.textContent = files.displayPath ?? "~";
  headerButton.append(headerTitle, pathLabel);

  const controls = document.createElement("div");
  controls.className = "wm-files-browser__controls";

  const upButton = document.createElement("button");
  upButton.type = "button";
  upButton.className = "wm-button secondary wm-button-icon";
  setIconButton(upButton, "arrowUp", "Go up one directory");
  upButton.disabled = files.loading || !files.parent?.path;
  upButton.addEventListener("click", () => {
    if (files.loading) return;
    if (files.parent?.path) {
      void loadFilesTree(files.parent.path);
    }
  });

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "wm-button secondary wm-button-icon";
  setIconButton(refreshButton, "refresh", "Refresh directory contents");
  refreshButton.disabled = files.loading;
  refreshButton.addEventListener("click", () => {
    if (files.loading) return;
    void loadFilesTree(files.currentPath);
  });

  const toggleHiddenButton = document.createElement("button");
  toggleHiddenButton.type = "button";
  toggleHiddenButton.className = "wm-button secondary wm-button-icon";
  toggleHiddenButton.disabled = files.loading;
  const syncHiddenButtonIcon = () => {
    const iconKey = files.showHidden ? "eyeOff" : "eye";
    const label = files.showHidden ? "Hide hidden files" : "Show hidden files";
    setIconButton(toggleHiddenButton, iconKey, label);
    toggleHiddenButton.setAttribute("aria-pressed", files.showHidden ? "true" : "false");
  };
  syncHiddenButtonIcon();
  toggleHiddenButton.addEventListener("click", () => {
    if (files.loading) return;
    files.showHidden = !files.showHidden;
    syncHiddenButtonIcon();
    try {
      localStorage.setItem(FILES_SHOW_HIDDEN_STORAGE_KEY, files.showHidden ? "true" : "false");
    } catch {
      // Ignore storage failures
    }
    void loadFilesTree(files.currentPath);
    if (currentRoute === "files") {
      render();
    }
  });

  const newFolderButton = document.createElement("button");
  newFolderButton.type = "button";
  newFolderButton.className = "wm-button secondary wm-button-icon";
  setIconButton(newFolderButton, "folderPlus", "Create new folder");
  newFolderButton.disabled = files.loading;
  newFolderButton.addEventListener("click", () => {
    if (files.loading) return;
    void promptCreateDirectory();
  });

  const newFileButton = document.createElement("button");
  newFileButton.type = "button";
  newFileButton.className = "wm-button secondary wm-button-icon";
  setIconButton(newFileButton, "filePlus", "Create new file");
  newFileButton.disabled = files.loading;
  newFileButton.addEventListener("click", () => {
    if (files.loading) return;
    void promptCreateFile();
  });

  const uploadButton = document.createElement("button");
  uploadButton.type = "button";
  uploadButton.className = "wm-button secondary wm-button-icon";
  const syncUploadButtonState = () => {
    uploadButton.disabled = files.loading || files.uploading;
    setIconButton(uploadButton, "upload", files.uploading ? "Uploading…" : "Upload file");
    if (files.uploading) {
      uploadButton.dataset.loading = "true";
    } else {
      delete uploadButton.dataset.loading;
    }
  };
  syncUploadButtonState();
  uploadButton.addEventListener("click", () => {
    if (files.loading || files.uploading) return;
    promptUploadFile();
  });

  const gitWrapper = document.createElement("div");
  gitWrapper.className = "wm-files-browser__git";
  const gitSelect = document.createElement("select");
  gitSelect.className = "wm-select";
  gitSelect.setAttribute("aria-label", "Git commands");
  const gitPlaceholder = document.createElement("option");
  gitPlaceholder.value = "";
  gitPlaceholder.textContent = "Git…";
  gitSelect.append(gitPlaceholder);
  const gitOptions = [
    { value: "addAll", label: "git add .", requiresRepo: true },
    { value: "commit", label: "git commit -m", requiresRepo: true },
    { value: "push", label: "git push", requiresRepo: true },
    { value: "pushUpstream", label: "git push -u origin <branch>", requiresRepo: true },
    { value: "init", label: "git init", requiresRepo: false },
  ];
  const repoReady = Boolean(files.git?.isRepository);
  gitOptions.forEach((optionDef) => {
    const option = document.createElement("option");
    option.value = optionDef.value;
    option.textContent = optionDef.label;
    if (optionDef.requiresRepo && !repoReady) {
      option.disabled = true;
    }
    gitSelect.append(option);
  });
  const gitRunButton = document.createElement("button");
  gitRunButton.type = "button";
  gitRunButton.className = "wm-button secondary";
  const updateGitControlsState = () => {
    const disabled = files.loading || files.gitCommandPending;
    gitSelect.disabled = disabled;
    gitRunButton.disabled = disabled || gitSelect.value === "";
    if (files.gitCommandPending) {
      gitRunButton.dataset.loading = "true";
      gitRunButton.textContent = "Running…";
    } else {
      delete gitRunButton.dataset.loading;
      gitRunButton.textContent = "Run";
    }
  };
  updateGitControlsState();
  gitSelect.addEventListener("change", () => {
    updateGitControlsState();
  });
  gitRunButton.addEventListener("click", async () => {
    const action = gitSelect.value;
    if (!action) return;
    const outcome = await runGitCommand(action);
    if (outcome !== "cancelled") {
      gitSelect.value = "";
    }
    updateGitControlsState();
  });
  gitWrapper.append(gitSelect, gitRunButton);

  controls.append(
    upButton,
    refreshButton,
    toggleHiddenButton,
    newFolderButton,
    newFileButton,
    uploadButton,
    gitWrapper,
  );

  if (canCreateWorktree()) {
    const worktreeButton = document.createElement("button");
    worktreeButton.type = "button";
    worktreeButton.className = "wm-button wm-button-icon";
    setIconButton(worktreeButton, "branchPlus", "Create new worktree");
    worktreeButton.disabled = files.loading || state.files.worktreeModal.submitting;
    worktreeButton.addEventListener("click", () => {
      if (files.loading) return;
      openWorktreeModal();
    });
    if (state.files.worktreeModal.submitting) {
      worktreeButton.dataset.loading = "true";
    }
    controls.append(worktreeButton);
  }

  browserHeader.append(headerButton, controls);

  const list = document.createElement("ul");
  list.className = "wm-files-browser__list";
  list.id = "files-browser-list";
  headerButton.setAttribute("aria-controls", list.id);

  const collapsed = Boolean(files.browserCollapsed);
  const setBrowserCollapsed = (next) => {
    files.browserCollapsed = next;
    if (next) {
      browserCard.dataset.collapsed = "true";
      list.hidden = true;
      list.setAttribute("aria-hidden", "true");
      headerButton.setAttribute("aria-expanded", "false");
    } else {
      delete browserCard.dataset.collapsed;
      list.hidden = false;
      list.removeAttribute("aria-hidden");
      headerButton.setAttribute("aria-expanded", "true");
    }
  };
  setBrowserCollapsed(collapsed);
  headerButton.addEventListener("click", () => {
    setBrowserCollapsed(!files.browserCollapsed);
  });
  headerButton.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " " || event.key === "Space") {
      event.preventDefault();
      setBrowserCollapsed(!files.browserCollapsed);
    }
  });

  if (files.error) {
    const item = document.createElement("li");
    item.className = "wm-files-browser__status";
    item.textContent = files.error;
    list.append(item);
  } else {
    const entries = Array.isArray(files.entries) ? files.entries : [];
    if (entries.length === 0 && !files.loading) {
      const empty = document.createElement("li");
      empty.className = "wm-files-browser__status";
      empty.textContent = "Directory is empty.";
      list.append(empty);
    }

    entries.forEach((entry) => {
      const item = document.createElement("li");
      item.className = "wm-files-browser__item";
      item.dataset.type = entry.type;
      if (entry.type === "file" && entry.path === files.previewPath) {
        item.dataset.selected = "true";
      }

      const button = document.createElement("button");
      button.type = "button";

      const name = document.createElement("span");
      name.className = "wm-files-browser__name";
      const iconKey =
        entry.type === "directory"
          ? "folder"
          : entry.previewable
            ? entry.previewFormat === "markdown"
              ? "fileText"
              : "fileCode"
            : "ban";
      const iconDefinition = FILE_BROWSER_ICON_DEFS[iconKey] ?? FILE_BROWSER_ICON_DEFS.file;
      const icon = createIconSvg(iconDefinition);
      const iconWrapper = document.createElement("span");
      iconWrapper.className = "wm-files-browser__icon";
      iconWrapper.setAttribute("aria-hidden", "true");
      iconWrapper.append(icon);
      const label = document.createElement("span");
      label.textContent = entry.name;
      name.append(iconWrapper, label);
      button.append(name);

      const meta = document.createElement("span");
      meta.className = "wm-files-browser__meta";
      if (entry.type === "directory") {
        meta.textContent = "Folder";
      } else if (entry.previewable) {
        meta.textContent = entry.previewLabel ?? (entry.previewFormat === "markdown" ? "Markdown" : "Code");
      } else {
        meta.textContent = "Preview unavailable";
      }
      button.append(meta);

      if (entry.type === "directory") {
        button.addEventListener("click", () => {
          if (files.loading) return;
          void loadFilesTree(entry.path);
        });
      } else if (entry.previewable) {
        button.addEventListener("click", () => {
          if (files.previewPath !== entry.path || files.previewError) {
            void loadFilesPreview(entry.path);
          } else if (!files.previewLoading) {
            void loadFilesPreview(entry.path);
          }
        });
      } else {
        button.addEventListener("click", () => {
          showFilesPreviewUnavailable(entry);
        });
      }

      item.append(button);
      list.append(item);
    });

    if (files.uploading && !files.loading) {
      const uploadingItem = document.createElement("li");
      uploadingItem.className = "wm-files-browser__status";
      uploadingItem.textContent = "Uploading file…";
      list.append(uploadingItem);
    }

    if (files.loading) {
      const loadingItem = document.createElement("li");
      loadingItem.className = "wm-files-browser__status";
      loadingItem.textContent = "Loading…";
      list.append(loadingItem);
    }
  }

  browserCard.append(browserHeader, list);

  const previewCard = document.createElement("section");
  previewCard.className = "wm-card wm-files-preview";

  const previewHeader = document.createElement("div");
  previewHeader.className = "wm-files-preview__header";
  const previewTitle = document.createElement("h2");
  previewTitle.className = "wm-files-preview__title";
  previewTitle.textContent = files.previewName ?? "Preview";
  const previewPathRow = document.createElement("div");
  previewPathRow.className = "wm-files-preview__path-row";
  const previewPath = document.createElement("p");
  previewPath.className = "wm-files-preview__path";
  if (files.previewDisplayPath) {
    previewPath.textContent = files.previewDisplayPath;
  } else if (files.previewName) {
    previewPath.textContent = files.previewName;
  } else {
    previewPath.textContent = "~";
  }
  if (files.previewLabel) {
    const formatBadge = document.createElement("span");
    formatBadge.className = "wm-files-preview__badge";
    formatBadge.textContent = files.previewLabel;
    previewPath.append(document.createTextNode(" "), formatBadge);
  }
  previewPathRow.append(previewPath);

  const copyablePath = files.previewDisplayPath || files.previewPath || null;
  if (copyablePath) {
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "wm-files-copy-link";
    copyButton.setAttribute("aria-label", "Copy file path");
    copyButton.title = "Copy file path";
    const defaultIcon =
      '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M16 1H8a2 2 0 0 0-2 2v2H5a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8l1-2H5V7h1v2h10V3h2v9l2-1V3a2 2 0 0 0-2-2Zm-2 6H8V3h6v4Zm7.71 9.29-5-5a1 1 0 0 0-1.42 1.42l1.3 1.29-4.59 4.59V22h3.41l4.59-4.59 1.29 1.3a1 1 0 0 0 1.42-1.42Z"/></svg>';
    const successIcon =
      '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="m9 16.17-3.5-3.5L4.08 14.1 9 19l12-12-1.41-1.41Z"/></svg>';
    copyButton.innerHTML = defaultIcon;
    copyButton.addEventListener("click", async () => {
      const text = copyablePath;
      if (!text) return;
      const success = await copyTextToClipboard(text);
      if (success) {
        copyButton.dataset.copied = "true";
        copyButton.innerHTML = successIcon;
        setTimeout(() => {
          if (copyButton.isConnected) {
            delete copyButton.dataset.copied;
            copyButton.innerHTML = defaultIcon;
          }
        }, 1600);
      }
    });
    previewPathRow.append(copyButton);
  }

  const previewInfo = document.createElement("div");
  previewInfo.className = "wm-files-preview__info";
  previewInfo.append(previewTitle, previewPathRow);
  previewHeader.append(previewInfo);

  const previewActions = document.createElement("div");
  previewActions.className = "wm-files-preview__actions";
  const hasFileSelection = typeof files.previewPath === "string" && !files.previewLoading;
  const canEdit = hasFileSelection && !files.previewError && files.previewContent !== null;

  if (canEdit) {
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "wm-button secondary";
    editButton.textContent = "Edit File";
    editButton.addEventListener("click", () => {
      void openFileEditor(files.previewPath, files.previewDisplayPath ?? null, files.previewName ?? null);
    });
    previewActions.append(editButton);
  }

  if (hasFileSelection) {
    const copyUrlButton = document.createElement("button");
    copyUrlButton.type = "button";
    copyUrlButton.className = "wm-button secondary";
    copyUrlButton.textContent = "Copy URL";
    copyUrlButton.addEventListener("click", async () => {
      const targetPath = typeof files.previewPath === "string" ? files.previewPath : null;
      if (!targetPath) return;
      const rawUrl = `${window.location.origin}/api/docs/file/raw?path=${encodeURIComponent(targetPath)}`;
      const success = await copyTextToClipboard(rawUrl);
      if (success) {
        const originalText = "Copy URL";
        copyUrlButton.dataset.copied = "true";
        copyUrlButton.textContent = "Copied!";
        setTimeout(() => {
          if (copyUrlButton.isConnected) {
            delete copyUrlButton.dataset.copied;
            copyUrlButton.textContent = originalText;
          }
        }, 1600);
      } else {
        window.alert("Unable to copy the file URL. Copy it manually from the address bar instead.");
      }
    });
    previewActions.append(copyUrlButton);

    const copyToButton = document.createElement("button");
    copyToButton.type = "button";
    copyToButton.className = "wm-button";
    copyToButton.textContent = "Copy File To…";
    copyToButton.addEventListener("click", () => {
      void openFileTransferDialogForMode("copy");
    });
    previewActions.append(copyToButton);

    const moveToButton = document.createElement("button");
    moveToButton.type = "button";
    moveToButton.className = "wm-button";
    moveToButton.textContent = "Move File To…";
    moveToButton.addEventListener("click", () => {
      void openFileTransferDialogForMode("move");
    });
    previewActions.append(moveToButton);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "wm-button secondary";
    deleteButton.textContent = "Delete File";
    deleteButton.addEventListener("click", async () => {
      const targetPath = typeof files.previewPath === "string" ? files.previewPath : null;
      if (!targetPath) return;
      const displayName = files.previewName ?? files.previewDisplayPath ?? targetPath;
      const confirmed = window.confirm(`Delete "${displayName}"? This cannot be undone.`);
      if (!confirmed) {
        return;
      }
      const originalText = deleteButton.textContent;
      deleteButton.disabled = true;
      deleteButton.dataset.loading = "true";
      deleteButton.textContent = "Deleting…";
      try {
        await deleteFilesEntry(targetPath);
        resetFilesPreview();
        render();
        await loadFilesTree(state.files.currentPath);
      } catch (error) {
        deleteButton.disabled = false;
        deleteButton.textContent = originalText;
        deleteButton.removeAttribute("data-loading");
        const message = error instanceof Error ? error.message : "Failed to delete file";
        window.alert(message);
      }
    });
    previewActions.append(deleteButton);
  }

  if (previewActions.childElementCount > 0) {
    previewHeader.append(previewActions);
  }

  const previewBody = document.createElement("div");
  previewBody.className = "wm-files-preview__body";

  if (files.previewLoading) {
    previewBody.dataset.loading = "true";
    previewBody.textContent = "Loading preview…";
  } else if (files.previewError) {
    const error = document.createElement("div");
    error.className = "wm-files-browser__status";
    error.textContent = files.previewError;
    previewBody.append(error);
  } else if (files.previewContent !== null) {
    if (files.previewFormat === "markdown") {
      if (files.previewContent.trim().length > 0) {
        const content = document.createElement("div");
        content.className = "wm-files-preview-content";
        content.innerHTML = renderMarkdownToHtml(files.previewContent);
        previewBody.append(content);
      } else {
        previewBody.dataset.empty = "true";
        previewBody.textContent = "This document is empty.";
      }
    } else {
      const content = document.createElement("div");
      content.className = "wm-files-preview-code";
      content.innerHTML = renderCodeToHtml(files.previewContent, files.previewLanguage ?? "plaintext");
      previewBody.append(content);
    }
  } else {
    previewBody.dataset.empty = "true";
    previewBody.textContent = "Select a previewable file to view.";
  }

  previewCard.append(previewHeader, previewBody);

  layout.append(browserCard, previewCard);
  wrapper.append(layout);
  return wrapper;
};

function renderAdminUsersPanel() {
  const container = document.createDocumentFragment();

  ensureAdminBalanceToolState();
  const balanceCard = buildAdminBalanceCard();
  container.append(balanceCard);

  ensureAdminPortsToolState();
  const portsCard = buildAdminPortsCard();
  container.append(portsCard);

  const userManagementCard = buildAdminUserManagementCard();
  container.append(userManagementCard);

  return container;
}

function buildAdminBalanceCard() {
  ensureAdminBalanceToolState();
  const balanceTool = state.adminUsers.balanceTool;
  const { card, body } = createCollapsibleCard({
    title: "Set Balance",
    className: "wm-admin-users wm-admin-users--balance",
    collapsed: state.settingsPanels.adminBalanceCollapsed,
    onToggle(collapsed) {
      state.settingsPanels.adminBalanceCollapsed = collapsed;
    },
  });

  const balanceLayout = document.createElement("div");
  balanceLayout.className = "wm-admin-users__balance";

  const balanceIntro = document.createElement("p");
  balanceIntro.className = "wm-admin-users__balance-help";
  balanceIntro.textContent = "Provide a user's npub or alias and the new target balance.";
  balanceLayout.append(balanceIntro);

  const balanceForm = document.createElement("form");
  balanceForm.className = "wm-admin-users__balance-form";
  balanceForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (balanceTool.busy) return;
    void submitAdminBalanceUpdate();
  });

  const identifierField = document.createElement("label");
  identifierField.className = "wm-admin-users__balance-field";
  const identifierSpan = document.createElement("span");
  identifierSpan.textContent = "User npub or alias";
  const identifierInput = document.createElement("input");
  identifierInput.type = "text";
  identifierInput.placeholder = "npub1… or alias";
  identifierInput.value = typeof balanceTool.identifier === "string" ? balanceTool.identifier : "";
  identifierInput.autocomplete = "off";
  identifierInput.disabled = balanceTool.busy;
  identifierInput.addEventListener("input", (event) => {
    ensureAdminBalanceToolState();
    balanceTool.identifier = event.target.value;
    balanceTool.error = null;
    balanceTool.success = null;
  });
  identifierField.append(identifierSpan, identifierInput);

  const amountField = document.createElement("label");
  amountField.className = "wm-admin-users__balance-field";
  const amountSpan = document.createElement("span");
  amountSpan.textContent = "Balance (sats)";
  const amountInput = document.createElement("input");
  amountInput.type = "number";
  amountInput.min = "0";
  amountInput.step = "1";
  amountInput.placeholder = "e.g. 1000";
  amountInput.value = typeof balanceTool.amount === "string" || typeof balanceTool.amount === "number" ? balanceTool.amount : "";
  amountInput.disabled = balanceTool.busy;
  amountInput.addEventListener("input", (event) => {
    ensureAdminBalanceToolState();
    balanceTool.amount = event.target.value;
    balanceTool.error = null;
    balanceTool.success = null;
  });
  amountField.append(amountSpan, amountInput);

  const balanceControls = document.createElement("div");
  balanceControls.className = "wm-admin-users__balance-controls";
  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "wm-button";
  submitButton.disabled = balanceTool.busy;
  submitButton.textContent = balanceTool.busy ? "Updating…" : "Set Balance";
  balanceControls.append(submitButton);

  if (balanceTool.error || balanceTool.success) {
    const statusMessage = document.createElement("p");
    statusMessage.className = "wm-admin-users__balance-status";
    if (balanceTool.error) {
      statusMessage.dataset.state = "error";
      statusMessage.textContent = balanceTool.error;
    } else if (balanceTool.success) {
      statusMessage.dataset.state = "success";
      statusMessage.textContent = balanceTool.success;
    }
    balanceControls.append(statusMessage);
  }

  balanceForm.append(identifierField, amountField, balanceControls);
  balanceLayout.append(balanceForm);
  body.append(balanceLayout);
  return card;
}

function buildAdminPortsCard() {
  ensureAdminPortsToolState();
  const portsTool = state.adminUsers.portsTool;
  const { card, body } = createCollapsibleCard({
    title: "Assign Ports to Users",
    className: "wm-admin-users wm-admin-users--ports",
    collapsed: state.settingsPanels.adminPortsCollapsed,
    onToggle(collapsed) {
      state.settingsPanels.adminPortsCollapsed = collapsed;
    },
  });

  const portsLayout = document.createElement("div");
  portsLayout.className = "wm-admin-users__balance";

  const portsIntro = document.createElement("p");
  portsIntro.className = "wm-admin-users__balance-help";
  portsIntro.textContent = "Assign additional ports to a specific user by providing their npub and the number of ports to add.";
  portsLayout.append(portsIntro);

  const portsForm = document.createElement("form");
  portsForm.className = "wm-admin-users__balance-form";
  portsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (portsTool.busy) return;
    void submitAdminPortsAssignment();
  });

  const npubField = document.createElement("label");
  npubField.className = "wm-admin-users__balance-field";
  const npubSpan = document.createElement("span");
  npubSpan.textContent = "User npub";
  const npubInput = document.createElement("input");
  npubInput.type = "text";
  npubInput.placeholder = "npub1…";
  npubInput.value = typeof portsTool.npub === "string" ? portsTool.npub : "";
  npubInput.autocomplete = "off";
  npubInput.disabled = portsTool.busy;
  npubInput.addEventListener("input", (event) => {
    ensureAdminPortsToolState();
    portsTool.npub = event.target.value;
    portsTool.error = null;
    portsTool.success = null;
  });
  npubField.append(npubSpan, npubInput);

  const countField = document.createElement("label");
  countField.className = "wm-admin-users__balance-field";
  const countSpan = document.createElement("span");
  countSpan.textContent = "Number of ports";
  const countInput = document.createElement("input");
  countInput.type = "number";
  countInput.min = "1";
  countInput.max = "100";
  countInput.step = "1";
  countInput.placeholder = "e.g. 3";
  countInput.value = typeof portsTool.count === "string" || typeof portsTool.count === "number" ? portsTool.count : "3";
  countInput.disabled = portsTool.busy;
  countInput.addEventListener("input", (event) => {
    ensureAdminPortsToolState();
    portsTool.count = event.target.value;
    portsTool.error = null;
    portsTool.success = null;
  });
  countField.append(countSpan, countInput);

  const portsControls = document.createElement("div");
  portsControls.className = "wm-admin-users__balance-controls";
  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "wm-button";
  submitButton.disabled = portsTool.busy;
  submitButton.textContent = portsTool.busy ? "Assigning…" : "Assign Ports";
  portsControls.append(submitButton);

  if (portsTool.error || portsTool.success) {
    const statusMessage = document.createElement("p");
    statusMessage.className = "wm-admin-users__balance-status";
    if (portsTool.error) {
      statusMessage.dataset.state = "error";
      statusMessage.textContent = portsTool.error;
    } else if (portsTool.success) {
      statusMessage.dataset.state = "success";
      statusMessage.textContent = portsTool.success;
    }
    portsControls.append(statusMessage);
  }

  portsForm.append(npubField, countField, portsControls);
  portsLayout.append(portsForm);
  body.append(portsLayout);
  return card;
}

function buildAdminUserManagementCard() {
  const { card, body } = createCollapsibleCard({
    title: "User Management",
    className: "wm-admin-users wm-admin-users--listing",
    collapsed: state.settingsPanels.adminUsersCollapsed,
    onToggle(collapsed) {
      state.settingsPanels.adminUsersCollapsed = collapsed;
    },
  });

  const controls = document.createElement("div");
  controls.className = "wm-admin-users__controls";
  controls.append(buildAdminUsersFilter());
  body.append(controls);

  if (state.adminUsers.loading && !state.adminUsers.initialized) {
    const loading = document.createElement("p");
    loading.className = "wm-admin-users__empty";
    loading.textContent = "Loading users…";
    body.append(loading);
    return card;
  }

  if (state.adminUsers.error) {
    const errorBox = document.createElement("div");
    errorBox.className = "wm-admin-users__error";

    const message = document.createElement("p");
    message.textContent = state.adminUsers.error;

    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "wm-button secondary";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      void fetchAdminUsers();
    });

    errorBox.append(message, retry);
    body.append(errorBox);
    return card;
  }

  const users = Array.isArray(state.adminUsers.items) ? state.adminUsers.items : [];
  if (users.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wm-admin-users__empty";
    empty.textContent = "No registered users yet.";
    body.append(empty);
    return card;
  }

  const filter = typeof state.adminUsers.filter === "string" ? state.adminUsers.filter.trim() : "";
  const filteredUsers = users.filter((user) => matchesAdminUserFilter(user, filter));

  if (filteredUsers.length === 0) {
    const emptyFiltered = document.createElement("p");
    emptyFiltered.className = "wm-admin-users__empty";
    emptyFiltered.textContent = filter.length > 0 ? "No users match your filter." : "No registered users yet.";
    body.append(emptyFiltered);
    return card;
  }

  const selectionControls = buildAdminUsersSelectionControls(filteredUsers);
  if (selectionControls) {
    body.append(selectionControls);
  }

  const list = document.createElement("div");
  list.className = "wm-admin-users__list";
  filteredUsers.forEach((user) => {
    const row = document.createElement("div");
    row.className = "wm-admin-users__item";
    const key = normaliseNpubValue(user.normalizedNpub ?? user.npub) ?? user.npub ?? "";
    const userPending = state.adminUsers.pending.has(key || user.normalizedNpub || user.npub);

    const selectionControl = document.createElement("label");
    selectionControl.className = "wm-admin-users__selection";
    const selectionCheckbox = document.createElement("input");
    selectionCheckbox.type = "checkbox";
    const isSelected = key ? ensureAdminSelectionState().has(key) : false;
    selectionCheckbox.checked = isSelected;
    selectionCheckbox.disabled =
      !key || userPending || state.adminUsers.loading || state.adminUsers.bulkDeleteBusy || !state.identity.isAdmin;
    selectionCheckbox.addEventListener("change", () => {
      if (!key) return;
      setAdminUserSelected(key, selectionCheckbox.checked);
      if (currentRoute === "settings") {
        render();
      }
    });
    selectionControl.append(selectionCheckbox);

    const avatar = document.createElement("div");
    avatar.className = "wm-admin-users__avatar";

    const details = document.createElement("div");
    details.className = "wm-admin-users__details";

    const nicknameValue =
      typeof user.nickname === "string" && user.nickname.trim().length > 0 ? user.nickname.trim() : null;
    const name = document.createElement("strong");
    const alias = typeof user.alias === "string" && user.alias.length > 0 ? user.alias : null;
    name.textContent = nicknameValue ?? alias ?? (user.npub ? abbreviateNpub(user.npub) : "Unknown user");

    const meta = document.createElement("span");
    meta.className = "wm-admin-users__meta";
    const safeAlias = alias ? `alias: ${alias}` : null;
    const safeNickname = nicknameValue ? `nickname: ${nicknameValue}` : null;
    const normalizedNpub = typeof user.normalizedNpub === "string" && user.normalizedNpub.length > 0 ? user.normalizedNpub : null;
    const safeNpub = normalizedNpub ?? user.npub ?? "";
    const metaParts = [];
    if (safeNickname) metaParts.push(safeNickname);
    if (safeAlias) metaParts.push(safeAlias);
    metaParts.push(`npub: ${safeNpub}`);
    meta.textContent = metaParts.join(" • ");

    const status = document.createElement("span");
    status.className = "wm-admin-users__status";
    const balance = typeof user.balance === "number" ? `${user.balance} sats` : "Unknown balance";
    status.textContent = `Balance: ${balance}`;

    const nicknameForm = document.createElement("form");
    nicknameForm.className = "wm-admin-users__nickname";
    nicknameForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (nicknameSave.disabled) return;
      state.adminUsers.nicknameDrafts.set(key, nicknameInput.value);
      void updateAdminUserNickname(user.npub, nicknameInput.value);
    });

    const nicknameField = document.createElement("label");
    nicknameField.className = "wm-admin-users__nickname-field";
    const nicknameLabel = document.createElement("span");
    nicknameLabel.textContent = "Admin nickname";
    const nicknameInput = document.createElement("input");
    nicknameInput.type = "text";
    nicknameInput.placeholder = "Add a short handle (only visible to admins)";
    const draftNickname =
      (state.adminUsers.nicknameDrafts instanceof Map && key ? state.adminUsers.nicknameDrafts.get(key) : undefined) ??
      (nicknameValue ?? "");
    nicknameInput.value = typeof draftNickname === "string" ? draftNickname : "";
    nicknameInput.autocomplete = "off";
    nicknameInput.disabled = userPending || state.adminUsers.loading;
    nicknameInput.addEventListener("input", (event) => {
      state.adminUsers.nicknameDrafts.set(key, event.target.value);
    });
    nicknameField.append(nicknameLabel, nicknameInput);

    const nicknameSave = document.createElement("button");
    nicknameSave.type = "submit";
    nicknameSave.className = "wm-button secondary";
    nicknameSave.textContent = userPending ? "Saving…" : "Save";
    nicknameSave.disabled = userPending || state.adminUsers.loading;

    nicknameForm.append(nicknameField, nicknameSave);

    applyAvatarImage(avatar, user.pictureUrl, nicknameValue ?? alias ?? user.npub ?? "?");
    details.append(name, meta, status, nicknameForm);

    const actions = document.createElement("div");
    actions.className = "wm-admin-users__actions";

    const toggle = document.createElement("label");
    toggle.className = "wm-admin-users__toggle";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(user.onboarded);
    checkbox.disabled = userPending || state.adminUsers.loading;
    checkbox.addEventListener("change", () => {
      if (checkbox.disabled) return;
      toggleUserOnboarding(user.npub, checkbox.checked);
    });

    const label = document.createElement("span");
    label.textContent = "Onboarded";

    toggle.append(checkbox, label);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "wm-admin-users__delete-btn";
    deleteBtn.textContent = "Delete";
    deleteBtn.disabled = userPending || state.adminUsers.loading;
    deleteBtn.addEventListener("click", () => {
      if (deleteBtn.disabled) return;
      deleteAdminUser(user.npub, user.alias);
    });

    actions.append(toggle, deleteBtn);

    row.append(selectionControl, avatar, details, actions);
    list.append(row);
  });

  body.append(list);
  return card;
}

function buildAdminUsersSelectionControls(filteredUsers) {
  if (!Array.isArray(filteredUsers) || filteredUsers.length === 0) {
    return null;
  }
  const selection = ensureAdminSelectionState();
  const selectedCount = selection.size;
  const container = document.createElement("div");
  container.className = "wm-admin-users__bulk-actions";

  const status = document.createElement("span");
  status.className = "wm-admin-users__bulk-status";
  status.textContent =
    selectedCount === 0 ? "No users selected" : selectedCount === 1 ? "1 user selected" : `${selectedCount} users selected`;

  const visibleKeys = filteredUsers
    .map((user) => getAdminUserKey(user))
    .filter((key) => typeof key === "string" && key.length > 0);
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((key) => selection.has(key));
  const disableSelectionControls = state.adminUsers.loading || state.adminUsers.bulkDeleteBusy;

  const selectVisible = document.createElement("button");
  selectVisible.type = "button";
  selectVisible.className = "wm-button secondary";
  selectVisible.textContent = allVisibleSelected ? "Clear visible" : "Select visible";
  selectVisible.disabled = disableSelectionControls || visibleKeys.length === 0;
  selectVisible.addEventListener("click", () => {
    if (selectVisible.disabled) return;
    visibleKeys.forEach((key) => {
      setAdminUserSelected(key, !allVisibleSelected);
    });
    if (currentRoute === "settings") {
      render();
    }
  });

  const clearAll = document.createElement("button");
  clearAll.type = "button";
  clearAll.className = "wm-link-button";
  clearAll.textContent = "Clear all";
  clearAll.disabled = disableSelectionControls || selectedCount === 0;
  clearAll.addEventListener("click", () => {
    if (clearAll.disabled) return;
    clearAdminSelection();
    if (currentRoute === "settings") {
      render();
    }
  });

  const deleteSelected = document.createElement("button");
  deleteSelected.type = "button";
  deleteSelected.className = "wm-button danger";
  deleteSelected.textContent = state.adminUsers.bulkDeleteBusy ? "Deleting…" : "Delete selected";
  deleteSelected.disabled = disableSelectionControls || selectedCount === 0;
  deleteSelected.addEventListener("click", () => {
    if (deleteSelected.disabled) return;
    void deleteSelectedAdminUsers();
  });

  container.append(status, selectVisible, clearAll, deleteSelected);
  return container;
}

function buildAdminUsersFilter() {
  const filterForm = document.createElement("form");
  filterForm.className = "wm-admin-users__filter";
  filterForm.addEventListener("submit", (event) => {
    event.preventDefault();
    applyAdminUsersFilter();
  });

  const filterLabel = document.createElement("label");
  filterLabel.className = "wm-admin-users__filter-field";

  const labelText = document.createElement("span");
  labelText.textContent = "Filter";

  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.placeholder = "nickname, alias or npub prefix";
  const currentDraft = typeof state.adminUsers.filterDraft === "string" ? state.adminUsers.filterDraft : state.adminUsers.filter;
  filterInput.value = typeof currentDraft === "string" ? currentDraft : "";
  filterInput.autocomplete = "off";
  filterInput.addEventListener("input", (event) => {
    state.adminUsers.filterDraft = event.target.value;
  });

  filterLabel.append(labelText, filterInput);

  const actions = document.createElement("div");
  actions.className = "wm-admin-users__filter-actions";

  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "wm-button secondary";
  submitButton.textContent = "Filter";

  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.className = "wm-link-button";
  clearButton.textContent = "Clear";
  clearButton.addEventListener("click", () => {
    state.adminUsers.filterDraft = "";
    if (state.adminUsers.filter) {
      state.adminUsers.filter = "";
      if (currentRoute === "settings") {
        render();
      }
    } else {
      filterInput.value = "";
    }
  });

  actions.append(submitButton, clearButton);
  filterForm.append(filterLabel, actions);
  return filterForm;
}

function applyAdminUsersFilter() {
  const draft = typeof state.adminUsers.filterDraft === "string" ? state.adminUsers.filterDraft : "";
  const nextFilter = draft.trim();
  state.adminUsers.filterDraft = nextFilter;
  if (state.adminUsers.filter === nextFilter) {
    return;
  }
  state.adminUsers.filter = nextFilter;
  if (currentRoute === "settings") {
    render();
  }
}

const renderSettings = () => {
  const wrapper = document.createElement("div");
  wrapper.className = "wm-settings";

  const pageTitle = document.createElement("h1");
  pageTitle.textContent = "Settings";
  wrapper.append(pageTitle);

  wrapper.append(renderIdentityPanel());

  const wingmanCard = document.createElement("section");
  wingmanCard.className = "wm-card";
  const wingmanHeading = document.createElement("h2");
  wingmanHeading.textContent = "Wingman Settings";
  const wingmanDescription = document.createElement("p");
  wingmanDescription.textContent = "Adjust global preferences for the Wingman workspace.";
  wingmanCard.append(wingmanHeading, wingmanDescription);

  const portsContainer = document.createElement("div");
  portsContainer.className = "wm-settings__ports";
  const portsHeading = document.createElement("h3");
  portsHeading.textContent = "Assigned Web App Ports";
  const portsList = document.createElement("ul");
  portsList.className = "wm-settings__port-list";
  const assignedPorts = Array.isArray(state.identity.ports) ? normalisePortList(state.identity.ports) : [];
  if (assignedPorts.length > 0) {
    assignedPorts.forEach((port) => {
      const item = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = String(port);
      item.append(code);
      portsList.append(item);
    });
  } else {
    const item = document.createElement("li");
    item.className = "wm-settings__port-empty";
    item.textContent = state.identity.authenticated ? "Assigned ports will appear here once available." : "Sign in to view your assigned ports.";
    portsList.append(item);
  }
  const portsNote = document.createElement("p");
  portsNote.className = "wm-settings__port-note";
  portsNote.textContent = "These dedicated ports are reserved for your personal Wingman web applications.";
  portsContainer.append(portsHeading, portsList, portsNote);

  if (state.identity.isAdmin) {
    const adminPortsActions = document.createElement("div");
    adminPortsActions.className = "wm-settings__ports-admin-actions";
    const generatePortsButton = document.createElement("button");
    generatePortsButton.type = "button";
    generatePortsButton.className = "wm-button secondary";
    generatePortsButton.textContent = "Generate 3 More Ports";
    generatePortsButton.addEventListener("click", async () => {
      generatePortsButton.disabled = true;
      generatePortsButton.textContent = "Generating…";
      const result = await generateAdminPorts(3);
      if (result && result.success) {
        render();
      } else {
        generatePortsButton.disabled = false;
        generatePortsButton.textContent = "Generate 3 More Ports";
        alert(result?.error || "Failed to generate ports");
      }
    });
    adminPortsActions.append(generatePortsButton);
    portsContainer.append(adminPortsActions);
  }

  wingmanCard.append(portsContainer);
  wrapper.append(wingmanCard);

  // Npub Projects section (for authenticated users)
  if (state.identity.authenticated) {
    if (!npubProjectsState.loading && npubProjectsState.items.length === 0 && !npubProjectsState.error) {
      fetchNpubProjects().then(() => {
        if (currentRoute === "settings") {
          render();
        }
      });
    }
    wrapper.append(renderNpubProjectsPanel(() => {
      fetchNpubProjects().then(() => {
        if (currentRoute === "settings") {
          render();
        }
      });
    }));
  }

  if (state.identity.isAdmin) {
    ensureFeatureFlagsLoaded();
    wrapper.append(renderFeatureFlagsPanel());
    if (!state.adminUsers.initialized && !state.adminUsers.loading && !state.adminUsers.error) {
      void fetchAdminUsers();
    }
    wrapper.append(renderAdminUsersPanel());
    const coreApp = (appsStore()?.items ?? state.apps.items).find((item) => item?.id === "wingman-core");
    if (coreApp) {
      const coreSection = document.createElement("section");
      coreSection.className = "wm-card wm-app-card-core";
      coreSection.append(renderWingmanCard(coreApp));
      wrapper.append(coreSection);
    }
  }

  return wrapper;
};

const renderPrivacyPolicy = () => {
  const wrapper = document.createElement("div");
  wrapper.className = "wm-privacy-policy";

  const header = document.createElement("header");
  header.className = "wm-privacy-policy__header";
  const title = document.createElement("h1");
  title.textContent = "Privacy Policy";
  const lastUpdated = document.createElement("p");
  lastUpdated.className = "wm-privacy-policy__date";
  lastUpdated.textContent = "Last updated: February 2025";
  header.append(title, lastUpdated);

  const content = document.createElement("article");
  content.className = "wm-privacy-policy__content";
  content.innerHTML = `
    <section>
      <h2>Introduction</h2>
      <p>Welcome to Wingman. We are committed to protecting your privacy and ensuring you have a positive experience when using our AI agent orchestration platform. This policy outlines our data handling practices.</p>
    </section>

    <section>
      <h2>Information We Collect</h2>
      <h3>Identity Information</h3>
      <p>Wingman uses Nostr-based identity for authentication. When you sign in, we may collect:</p>
      <ul>
        <li>Your public key (npub) for identification</li>
        <li>Session tokens for maintaining your logged-in state</li>
        <li>Profile metadata you choose to share</li>
      </ul>

      <h3>Usage Data</h3>
      <p>We collect information about how you interact with Wingman, including:</p>
      <ul>
        <li>Agent sessions you create and manage</li>
        <li>Projects and todos you create within the platform</li>
        <li>Configuration preferences and settings</li>
        <li>Log data from agent interactions</li>
      </ul>

      <h3>Technical Data</h3>
      <p>When you use Wingman, we may automatically collect:</p>
      <ul>
        <li>Browser type and version</li>
        <li>Device information</li>
        <li>IP address (for security and rate limiting)</li>
        <li>Access timestamps</li>
      </ul>
    </section>

    <section>
      <h2>How We Use Your Information</h2>
      <p>We use the collected information to:</p>
      <ul>
        <li>Provide and maintain the Wingman service</li>
        <li>Authenticate your identity and manage access</li>
        <li>Store your projects, todos, and preferences</li>
        <li>Improve our platform and develop new features</li>
        <li>Ensure security and prevent abuse</li>
        <li>Communicate important updates about the service</li>
      </ul>
    </section>

    <section>
      <h2>Data Storage and Security</h2>
      <p>Your data is stored locally on the Wingman server instance you connect to. We implement security measures including:</p>
      <ul>
        <li>Encrypted storage for sensitive data (todos, credentials)</li>
        <li>Session-based authentication with secure cookies</li>
        <li>Role-based access control for administrative functions</li>
      </ul>
      <p>Agent conversation data and logs are stored for the duration of your session and may be persisted based on your configuration.</p>
    </section>

    <section>
      <h2>Data Sharing</h2>
      <p>We do not sell your personal information. We may share data only:</p>
      <ul>
        <li>With your explicit consent</li>
        <li>To comply with legal obligations</li>
        <li>To protect our rights and prevent misuse</li>
        <li>With service providers who assist in operating the platform (under strict confidentiality agreements)</li>
      </ul>
    </section>

    <section>
      <h2>Your Rights</h2>
      <p>You have the right to:</p>
      <ul>
        <li>Access the personal data we hold about you</li>
        <li>Request correction of inaccurate data</li>
        <li>Request deletion of your data</li>
        <li>Export your data in a portable format</li>
        <li>Withdraw consent for data processing</li>
      </ul>
    </section>

    <section>
      <h2>Cookies and Local Storage</h2>
      <p>Wingman uses browser storage technologies to:</p>
      <ul>
        <li>Maintain your authentication state</li>
        <li>Store UI preferences (theme, layout settings)</li>
        <li>Cache data for improved performance</li>
      </ul>
      <p>These are essential for the platform to function and cannot be disabled while using the service.</p>
    </section>

    <section>
      <h2>Third-Party Services</h2>
      <p>Wingman integrates with external AI agent services (Claude, Codex, Goose, OpenCode). When you use these agents:</p>
      <ul>
        <li>Your prompts and data may be processed by the respective AI providers</li>
        <li>Each provider has their own privacy policies which govern their handling of your data</li>
        <li>We recommend reviewing the privacy policies of any AI services you choose to use</li>
      </ul>
    </section>

    <section>
      <h2>Changes to This Policy</h2>
      <p>We may update this privacy policy from time to time. We will notify you of significant changes by posting a notice on the platform or through other appropriate means.</p>
    </section>

    <section>
      <h2>Contact Us</h2>
      <p>If you have questions about this privacy policy or our data practices, please reach out through our official channels.</p>
    </section>
  `;

  const footer = document.createElement("footer");
  footer.className = "wm-privacy-policy__footer";
  const backLink = document.createElement("a");
  backLink.href = HOME_ROUTE;
  backLink.className = "wm-button secondary";
  backLink.textContent = "Back to Home";
  backLink.addEventListener("click", (e) => {
    e.preventDefault();
    currentRoute = "home";
    window.history.pushState({ route: "home" }, "", HOME_ROUTE);
    render();
  });
  footer.append(backLink);

  wrapper.append(header, content, footer);
  return wrapper;
};

const renderSessionTabs = (options = {}) => {
  const onSelect = typeof options.onSelect === "function" ? options.onSelect : null;
  const tabs = document.createElement("div");
  tabs.className = "wm-tabs menu";

  const activeSessions = getActiveSessions();
  activeSessions.forEach((session) => {
    const tab = document.createElement("div");
    tab.className = "wm-tab";
    const tabActiveId = sessionsStore()?.activeSessionId ?? state.activeSessionId;
    if (session.id === tabActiveId) {
      tab.classList.add("active");
    }

    const displayName = getSessionDisplayName(session);
    const safeLabel = escapeHtml(displayName);
    tab.innerHTML = `
      <span>${safeLabel}</span>
      <span class="close" title="Stop session">×</span>
    `;
    tab.title = `${displayName} - ${session.agent}:${session.port}`;

    tab.addEventListener("click", () => {
      const wasLiveRoute = currentRoute === "live";
      const clickActiveId = sessionsStore()?.activeSessionId ?? state.activeSessionId;
      if (clickActiveId === session.id && wasLiveRoute) {
        // Already active, no need to switch
        onSelect?.();
        return;
      }
      currentRoute = "live";
      setActiveSession(session.id, { updateHistory: true, forceLog: true });
      fetchLogs(session.id);
      fetchConversation(session.id);
      if (wasLiveRoute) {
        // Don't call render() when already on Live - it will destroy DOM references
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
        updateLivePanelsForSession(session.id);
      } else {
        render();
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
    const menuTabActiveId = sessionsStore()?.activeSessionId ?? state.activeSessionId;
    if (session.id === menuTabActiveId) {
      tab.classList.add("active");
    }

    const displayName = getSessionDisplayName(session);
    const safeLabel = escapeHtml(displayName);
    tab.innerHTML = `
      <span>${safeLabel}</span>
      <span class="close" title="Stop session">×</span>
    `;
    tab.title = `${displayName} - ${session.agent}:${session.port}`;

    tab.addEventListener("click", () => {
      const menuClickActiveId = sessionsStore()?.activeSessionId ?? state.activeSessionId;
      if (menuClickActiveId === session.id && currentRoute === "live") {
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
      updateLivePanelsForSession(session.id);
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

  if (state.identity.authenticated) {
    const newTab = document.createElement("div");
    newTab.className = "wm-tab new";
    newTab.textContent = "+";
    newTab.title = "Start new session";
    newTab.addEventListener("click", () => {
      openDialog();
      onSelect?.();
    });
    tabs.append(newTab);
  }

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

/**
 * Loads archived session data for a session ID that's not currently running.
 * Updates state.archivedSession with the result.
 */
const loadArchivedSession = async (sessionId) => {
  if (state.archivedSession.loading) return;

  state.archivedSession = {
    sessionId,
    status: null,
    session: null,
    messages: [],
    loading: true,
    error: null,
  };
  render();

  try {
    const data = await fetchSessionHistoryApi(sessionId);
    if (!data) {
      state.archivedSession = {
        sessionId,
        status: null,
        session: null,
        messages: [],
        loading: false,
        error: "Session not found",
      };
    } else if (data.status === "live") {
      // Session became live while we were loading - clear archived state
      state.archivedSession = {
        sessionId: null,
        status: null,
        session: null,
        messages: [],
        loading: false,
        error: null,
      };
    } else {
      state.archivedSession = {
        sessionId,
        status: data.status,
        session: data.session,
        messages: data.messages || [],
        loading: false,
        error: null,
      };
    }
  } catch (error) {
    state.archivedSession = {
      sessionId,
      status: null,
      session: null,
      messages: [],
      loading: false,
      error: error.message || "Failed to load session",
    };
  }
  render();
};

/**
 * Renders the archived conversation messages (read-only view).
 */
const renderArchivedConversation = (messages) => {
  const wrapper = document.createElement("div");
  wrapper.className = "wm-conversation wm-conversation-archived";

  if (!messages || messages.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "This session has no messages.";
    wrapper.append(empty);
  } else {
    messages.forEach((message) => {
      const bubble = document.createElement("article");
      bubble.className = `wm-message ${message.type ?? message.role ?? "assistant"}`;
      const body = document.createElement("pre");
      body.textContent = collapseNewlines(message.content ?? message.message ?? "");
      bubble.append(body);
      attachCopyButton(bubble);
      wrapper.append(bubble);
    });
  }

  return wrapper;
};

/**
 * Renders a disabled composer for archived sessions.
 */
const renderArchivedComposer = () => {
  const composerShell = document.createElement("div");
  composerShell.className = "wm-composer-shell wm-composer-shell-archived";

  const composer = document.createElement("div");
  composer.className = "wm-composer wm-composer-archived";

  const textarea = document.createElement("div");
  textarea.className = "wm-composer-archived-placeholder";
  textarea.textContent = "ARCHIVED";

  composer.append(textarea);
  composerShell.append(composer);

  return composerShell;
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
      body.textContent = collapseNewlines(message.content ?? message.message ?? "");
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

const renderComposer = (sessionId) => {
  const composerShell = document.createElement("div");
  composerShell.className = "wm-composer-shell";
  composerShell.dataset.sessionId = sessionId;

  // Image preview container
  const imagePreviewContainer = document.createElement("div");
  imagePreviewContainer.className = "wm-image-preview-container";
  imagePreviewContainer.style.display = "none";
  imagePreviewContainer.style.marginBottom = "8px";
  imagePreviewContainer.style.display = "flex";
  imagePreviewContainer.style.flexWrap = "wrap";
  imagePreviewContainer.style.gap = "8px";

  const composer = document.createElement("form");
  composer.className = "wm-composer";

  // Check localStorage for an initial draft (e.g., from "Fix with AI" or "Fork to Worktree")
  let initialDraft = state.messageDrafts.get(sessionId) ?? "";
  let shouldAutoSubmit = false;
  if (!initialDraft) {
    try {
      const storedDraft = localStorage.getItem(`session-draft-${sessionId}`);
      if (storedDraft) {
        initialDraft = storedDraft;
        state.messageDrafts.set(sessionId, storedDraft);
        localStorage.removeItem(`session-draft-${sessionId}`);
        // Check if auto-submit was requested (e.g., from Fork to Worktree)
        const autoSubmitFlag = localStorage.getItem(`session-autosubmit-${sessionId}`);
        if (autoSubmitFlag === "true") {
          shouldAutoSubmit = true;
          localStorage.removeItem(`session-autosubmit-${sessionId}`);
        }
      }
    } catch {
      // Ignore localStorage errors
    }
  }

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Ask the agent something...";
  textarea.value = initialDraft;
  textarea.setAttribute("rows", "1");

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.multiple = true;
  fileInput.style.display = "none";

  const attachmentInput = document.createElement("input");
  attachmentInput.type = "file";
  attachmentInput.multiple = true;
  attachmentInput.style.display = "none";

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
  const defaultPlaceholder = "Ask the agent something...";
  const setUploadingState = (isUploading) => {
    if (isUploading) {
      composer.dataset.uploading = "true";
      textarea.placeholder = "Uploading…";
    } else {
      delete composer.dataset.uploading;
      textarea.placeholder = defaultPlaceholder;
    }
    if (submit) {
      submit.disabled = Boolean(isUploading);
    }
    if (commandButton) {
      commandButton.disabled = Boolean(isUploading);
    }
  };

  textarea.addEventListener("input", (event) => {
    const newText = event.target.value;
    state.messageDrafts.set(sessionId, newText);
    resizeTextarea();
    
    // Check if any image markers were removed from text and remove corresponding thumbnails
    const sessionPreviews = imagePreviewTracker.previews.get(sessionId);
    if (sessionPreviews) {
      const markersToRemove = [];
      sessionPreviews.forEach((previewData, markerId) => {
        if (imagePreviewTracker.findMarkerInText(newText, markerId) === -1) {
          markersToRemove.push(markerId);
        }
      });
      
      markersToRemove.forEach(markerId => {
        imagePreviewTracker.remove(sessionId, markerId);
      });
    }
  });
  textarea.addEventListener("keydown", (event) => {
    // Direct pass-through shortcuts: send immediately when textarea is empty
    // These bypass agent status/queue checks to allow interrupting or navigating
    if (textarea.value === "") {
      // Esc: send escape sequence directly
      if (event.key === "Escape") {
        event.preventDefault();
        const escAction = TERMINAL_CONTROL_ACTIONS.find((a) => a.id === "terminal-esc");
        sendControlCommand(sessionId, escAction);
        return;
      }
      // Shift+Tab: send reverse tab sequence directly
      if (event.key === "Tab" && event.shiftKey) {
        event.preventDefault();
        const shiftTabAction = TERMINAL_CONTROL_ACTIONS.find((a) => a.id === "terminal-shift-tab");
        sendControlCommand(sessionId, shiftTabAction);
        return;
      }
    }
    // Check for direct terminal control shortcuts when conditions are met:
    // 1. Input is empty, 2. Agent is stable (not running), 3. Queue is empty, 4. Scrolled to bottom
    const directControlKeys = {
      ArrowUp: TERMINAL_CONTROL_ACTIONS.find((a) => a.id === "terminal-up"),
      ArrowDown: TERMINAL_CONTROL_ACTIONS.find((a) => a.id === "terminal-down"),
      Enter: TERMINAL_CONTROL_ACTIONS.find((a) => a.id === "terminal-return"),
    };
    const controlAction = directControlKeys[event.key];
    if (controlAction && textarea.value === "") {
      const agentStatus = resolveAgentRuntimeStatus(sessionId);
      const queue = getSessionQueue(sessionId);
      const queueCount = queue?.prompts?.length ?? 0;
      const isStable = agentStatus === "stable" && queueCount === 0;
      const isScrolledToBottom = isConversationScrolledToBottom(sessionId);
      if (isStable && isScrolledToBottom) {
        event.preventDefault();
        sendControlCommand(sessionId, controlAction);
        return;
      }
    }
    // Normal Enter handling for sending messages
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });

  textarea.addEventListener("paste", async (event) => {
    const items = event.clipboardData?.items ?? event.clipboardData?.files;
    const imageFiles = extractImageFiles(items);
    const otherFiles = extractAttachmentFiles(items);
    if (imageFiles.length > 0 || otherFiles.length > 0) {
      event.preventDefault();
    }
    if (imageFiles.length > 0) {
      await handleImageUploads(sessionId, imageFiles, textarea, resizeTextarea, setUploadingState);
    }
    if (otherFiles.length > 0) {
      await handleAttachmentUploads(sessionId, otherFiles, textarea, resizeTextarea, setUploadingState);
    }
  });

  const handleDropEvent = async (event) => {
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const imageFiles = extractImageFiles(transfer.items ?? transfer.files);
    const otherFiles = extractAttachmentFiles(transfer.items ?? transfer.files);
    if (imageFiles.length === 0 && otherFiles.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (imageFiles.length > 0) {
      await handleImageUploads(sessionId, imageFiles, textarea, resizeTextarea, setUploadingState);
    }
    if (otherFiles.length > 0) {
      await handleAttachmentUploads(sessionId, otherFiles, textarea, resizeTextarea, setUploadingState);
    }
  };

  composer.addEventListener("dragover", (event) => {
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    event.preventDefault();
  });
  composer.addEventListener("drop", handleDropEvent);

  fileInput.addEventListener("change", async () => {
    const files = extractImageFiles(fileInput.files);
    if (files.length > 0) {
      await handleImageUploads(sessionId, files, textarea, resizeTextarea, setUploadingState);
    }
    fileInput.value = "";
  });

  attachmentInput.addEventListener("change", async () => {
    const files = extractAttachmentFiles(attachmentInput.files);
    if (files.length > 0) {
      await handleAttachmentUploads(sessionId, files, textarea, resizeTextarea, setUploadingState);
    }
    attachmentInput.value = "";
  });

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const draft = textarea.value;
    state.messageDrafts.set(sessionId, draft);
    
    // Clear image previews when sending message
    clearImagePreviews(sessionId);
    
    const result = sendMessage(sessionId, draft);
    if (result?.finally) {
      result.finally(() => {
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
    return item;
  };

  const addCommandDivider = () => {
    const divider = document.createElement("div");
    divider.className = "wm-command-divider";
    divider.setAttribute("role", "presentation");
    commandMenu.append(divider);
  };

  const addSubmenu = (label, items) => {
    const submenu = document.createElement("div");
    submenu.className = "wm-command-submenu";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "wm-command-item";
    trigger.textContent = label;
    trigger.setAttribute("role", "menuitem");
    trigger.setAttribute("aria-haspopup", "true");

    const panel = document.createElement("div");
    panel.className = "wm-command-submenu-panel";
    panel.setAttribute("role", "menu");

    items.forEach(({ label: itemLabel, handler }) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "wm-command-item";
      item.textContent = itemLabel;
      item.setAttribute("role", "menuitem");
      item.addEventListener("click", () => {
        handler();
        commandMenu.classList.remove("is-open");
        commandButton.setAttribute("aria-expanded", "false");
      });
      panel.append(item);
    });

    submenu.append(trigger, panel);
    commandMenu.append(submenu);
  };

  const executeGitAction = async (action, options = {}) => {
    const session = state.sessions.find((s) => s.id === sessionId);
    const directory = session?.workingDirectory;
    if (!directory) {
      showToast("No working directory set for this session", { type: "error" });
      return;
    }
    try {
      const response = await fetch("/api/docs/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory, action, ...options }),
      });
      const data = await response.json();
      if (!response.ok) {
        showToast(`Git ${action} failed: ${data.error || "Unknown error"}`, { type: "error", duration: 5000 });
        return;
      }
      showToast(`Git ${action} successful`, { type: "success" });
      if (data.stdout) {
        console.log(`Git ${action} output:`, data.stdout);
      }
    } catch (error) {
      showToast(`Git ${action} failed: ${error.message}`, { type: "error" });
    }
  };

  addSubmenu("Git", [
    { label: "Pull", handler: () => executeGitAction("pull") },
    { label: "Push", handler: () => executeGitAction("push") },
    {
      label: "Commit...",
      handler: () => {
        const message = window.prompt("Enter commit message:");
        if (message?.trim()) {
          executeGitAction("addAll").then(() => {
            executeGitAction("commit", { message: message.trim() });
          });
        }
      }
    },
    {
      label: "Fork to Worktree...",
      handler: async () => {
        const session = state.sessions.find((s) => s.id === sessionId);
        if (!session?.workingDirectory) {
          showToast("No working directory set for this session", { type: "error" });
          return;
        }

        const branch = window.prompt(
          "Enter branch name for the worktree:\n\n" +
          "This will create a new worktree and session with the last 5 messages as context.",
          ""
        );
        if (!branch?.trim()) {
          return;
        }

        const trimmedBranch = branch.trim();
        // Basic validation
        if (!/^[a-zA-Z0-9._/-]+$/.test(trimmedBranch)) {
          showToast("Invalid branch name. Use alphanumeric characters, dots, underscores, and hyphens.", { type: "error" });
          return;
        }

        showToast(`Creating worktree "${trimmedBranch}"...`, { type: "info" });

        try {
          const result = await forkSessionToWorktreeApi(sessionId, trimmedBranch, 5);

          if (result.session?.id) {
            // Store initial prompt for auto-submit
            if (result.initialPrompt) {
              try {
                localStorage.setItem(`session-draft-${result.session.id}`, result.initialPrompt);
                localStorage.setItem(`session-autosubmit-${result.session.id}`, "true");
              } catch {
                // Ignore localStorage errors
              }
            }

            // Open new session in new tab
            const sessionUrl = `/live/${result.session.id}`;
            window.open(sessionUrl, "_blank", "noopener");

            showToast(`Forked to worktree: ${result.worktreePath}`, { type: "success", duration: 5000 });
          }
        } catch (error) {
          showToast(`Fork failed: ${error.message}`, { type: "error", duration: 5000 });
        }
      }
    },
  ]);

  // Apps submenu - show if there's an app matching the session's working directory
  const matchingApp = findAppForSession(sessionId, state.sessions, state.apps.items, npubProjectsState);

  if (matchingApp) {
    const appItems = [];

    // Go to site - open subdomain URL in new tab
    if (matchingApp.subdomainUrl) {
      appItems.push({
        label: "Go to site",
        handler: () => {
          window.open(matchingApp.subdomainUrl, "_blank", "noopener,noreferrer");
        },
      });
    }

    if (matchingApp.availableScripts?.restart) {
      appItems.push({
        label: "Restart",
        handler: async () => {
          const result = await triggerAppActionApi(matchingApp.id, "restart");
          if (result.success) {
            showToast(`Restarting ${matchingApp.label}...`, { type: "success" });
          } else {
            showToast(result.error || "Failed to restart app", { type: "error" });
          }
        },
      });
    }

    if (matchingApp.availableScripts?.stop) {
      appItems.push({
        label: "Stop",
        handler: async () => {
          const result = await triggerAppActionApi(matchingApp.id, "stop");
          if (result.success) {
            showToast(`Stopped ${matchingApp.label}`, { type: "success" });
          } else {
            showToast(result.error || "Failed to stop app", { type: "error" });
          }
        },
      });
    }

    if (appItems.length > 0) {
      addSubmenu(`App: ${matchingApp.label}`, appItems);
    }
  }

  addNightWatchToggle({ sessionId, addCommand, state, showToast, isFeatureEnabled: isFeatureEnabledForViewer });

  addCommandDivider();

  addCommand("Scroll to end", () => {
    scrollConversationAreaToBottom(sessionId, { includeWindow: true });
  });

  addCommand("Last question", () => {
    const container = document.querySelector(`.wm-live-conversation[data-session-id="${sessionId}"]`);
    if (!container) return;
    const userMessages = container.querySelectorAll('.wm-message[data-role="user"]');
    if (userMessages.length === 0) {
      showToast("No user messages found", { type: "info" });
      return;
    }
    const lastUserMessage = userMessages[userMessages.length - 1];
    lastUserMessage.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  addCommand("Copy chat", () => {
    copyConversationToClipboard(sessionId);
  });

  addCommand("Rename session", () => {
    const session = state.sessions.find((s) => s.id === sessionId);
    if (session) {
      promptRenameSession(session);
    }
  });

  addCommand("Attach image", () => {
    fileInput.click();
  });

  addCommand("Upload file", () => {
    attachmentInput.click();
  });

  addCommandDivider();
  addSubmenu("Terminal", TERMINAL_CONTROL_ACTIONS.map((action) => ({
    label: action.label,
    handler: () => sendControlCommand(sessionId, action),
  })));

  addCommandDivider();
  addCommand("Stop Session", () => {
    const session = state.sessions.find((s) => s.id === sessionId);
    const displayName = session ? getSessionDisplayName(session) : "this session";
    const confirmed = window.confirm(
      `Are you sure you want to stop "${displayName}"?\n\nThe session will be archived after 5 seconds.`
    );
    if (confirmed) {
      stopSession(sessionId);
    }
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

  // Wrap textarea with knight rider effect element
  const textareaWrapper = document.createElement("div");
  textareaWrapper.className = "wm-textarea-wrapper";
  const knightRider = document.createElement("div");
  knightRider.className = "wm-knight-rider";
  knightRider.dataset.sessionId = sessionId;
  textareaWrapper.append(knightRider, textarea);

  composer.append(fileInput, attachmentInput, textareaWrapper, buttonGroup);
  
  // Add agent status indicator button inside the controls column
  const statusIndicator = createAgentStatusIndicator(sessionId, { variant: "pill" });
  statusIndicator.classList.add("wm-agent-status-pill-button");
  buttonGroup.prepend(statusIndicator);

  composerShell.append(imagePreviewContainer, composer);

  resizeTextarea();

  requestAnimationFrame(() => {
    if (!document.contains(textarea)) return;
    textarea.focus();
    resizeTextarea();

    // Auto-submit if flag was set (e.g., from Fork to Worktree)
    if (shouldAutoSubmit && textarea.value.trim()) {
      // Small delay to ensure the session is ready
      setTimeout(() => {
        if (document.contains(composer)) {
          composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        }
      }, 500);
    }
  });

  return composerShell;
};

const updateLivePanelsForSession = (sessionId) => {
  const scrollRegion = document.querySelector('.wm-live-scroll');
  if (scrollRegion) {
    scrollRegion.innerHTML = "";
    const logSection = renderLogs(sessionId);
    scrollRegion.append(logSection);
    const conversationContainer = document.createElement("div");
    conversationContainer.className = "wm-live-conversation";
    conversationContainer.append(renderConversation(sessionId));
    scrollRegion.append(conversationContainer);
    scheduleLiveScroll(sessionId, { includeWindow: true });
  }

  const currentComposer = document.querySelector('.wm-composer-shell');
  if (currentComposer) {
    currentComposer.replaceWith(renderComposer(sessionId));
  } else {
    const liveWrapper = document.querySelector('.wm-live');
    if (liveWrapper) {
      liveWrapper.append(renderComposer(sessionId));
    }
  }

  // Focus the textarea after composer is in the DOM
  requestAnimationFrame(() => {
    const textarea = document.querySelector('.wm-composer textarea');
    if (textarea) {
      textarea.focus();
    }
  });
};

const renderLive = () => {
  const wrapper = document.createElement("div");
  wrapper.className = "wm-live";

  if (tabsVisible) {
    const tabsBar = document.createElement("div");
    tabsBar.className = "wm-tabs-bar";
    tabsBar.append(renderTabs());
    wrapper.append(tabsBar);
  }

  // Extract sessionId from URL to check for archived sessions
  const routeSessionId = getSessionIdFromPath(window.location.pathname);
  const isLiveSession = routeSessionId && state.sessions.some((s) => s.id === routeSessionId);

  // Check if we should show an archived session
  if (routeSessionId && !isLiveSession) {
    // Check if we need to load archived session data
    if (state.archivedSession.sessionId !== routeSessionId && !state.archivedSession.loading) {
      // Trigger async load of archived session
      void loadArchivedSession(routeSessionId);
    }

    // Render archived session view
    const main = document.createElement("section");
    main.className = "wm-card wm-live-main wm-live-main-archived";

    if (state.archivedSession.loading) {
      const loadingContainer = document.createElement("div");
      loadingContainer.className = "wm-live-loading";
      const loadingText = document.createElement("p");
      loadingText.textContent = "Loading session history...";
      loadingContainer.append(loadingText);
      main.append(loadingContainer);
      wrapper.append(main);
      return wrapper;
    }

    if (state.archivedSession.error) {
      const errorContainer = document.createElement("div");
      errorContainer.className = "wm-live-error";
      const errorText = document.createElement("p");
      errorText.textContent = state.archivedSession.error;
      errorContainer.append(errorText);
      main.append(errorContainer);
      wrapper.append(main);
      return wrapper;
    }

    if (state.archivedSession.sessionId === routeSessionId && state.archivedSession.session) {
      // Show archived session header with metadata
      const header = document.createElement("div");
      header.className = "wm-archived-header";

      const statusBadge = document.createElement("span");
      statusBadge.className = "wm-archived-badge";
      statusBadge.textContent = state.archivedSession.status === "abandoned" ? "ABANDONED" : "ARCHIVED";

      const sessionInfo = document.createElement("div");
      sessionInfo.className = "wm-archived-info";
      const sessionName = state.archivedSession.session.name || `Session ${routeSessionId.slice(0, 8)}`;
      const agentType = state.archivedSession.session.agent || "unknown";
      sessionInfo.innerHTML = `<strong>${sessionName}</strong> <span class="wm-archived-agent">(${agentType})</span>`;

      header.append(statusBadge, sessionInfo);
      main.append(header);

      const scrollRegion = document.createElement("div");
      scrollRegion.className = "wm-live-scroll";

      const conversationContainer = document.createElement("div");
      conversationContainer.className = "wm-live-conversation";
      conversationContainer.append(renderArchivedConversation(state.archivedSession.messages));

      scrollRegion.append(conversationContainer);
      main.append(scrollRegion);
      wrapper.append(main);
      wrapper.append(renderArchivedComposer());

      // Scroll to bottom after render
      requestAnimationFrame(() => {
        const scrollEl = wrapper.querySelector(".wm-live-scroll");
        if (scrollEl) {
          scrollEl.scrollTop = scrollEl.scrollHeight;
        }
      });

      return wrapper;
    }

    // Fallback - session not found
    const notFoundContainer = document.createElement("div");
    notFoundContainer.className = "wm-live-empty";
    const notFoundText = document.createElement("p");
    notFoundText.textContent = "Session not found.";
    notFoundContainer.append(notFoundText);
    main.append(notFoundContainer);
    wrapper.append(main);
    return wrapper;
  }

  // Clear archived session state if we're viewing a live session
  if (state.archivedSession.sessionId) {
    state.archivedSession = {
      sessionId: null,
      status: null,
      session: null,
      messages: [],
      loading: false,
      error: null,
    };
  }

  if (state.sessions.length === 0) {
    const container = document.createElement("section");
    container.className = "wm-card wm-live-main";

    const emptyContainer = document.createElement("div");
    emptyContainer.className = "wm-live-empty";

    const empty = document.createElement("p");
    empty.textContent = "No live sessions. Launch a new agent to begin.";

    const refreshBtn = document.createElement("button");
    refreshBtn.className = "wm-button secondary";
    refreshBtn.textContent = "Refresh";
    refreshBtn.title = "Check for sessions";
    refreshBtn.addEventListener("click", () => {
      // void pollSessionsLoop(); // DISABLED
    });

    emptyContainer.append(empty, refreshBtn);
    container.append(emptyContainer);
    wrapper.append(container);
    return wrapper;
  }

  const liveActiveId = sessionsStore()?.activeSessionId ?? state.activeSessionId;
  const liveSessions = sessionsStore()?.items ?? state.sessions;
  if (!liveActiveId || !liveSessions.some((session) => session.id === liveActiveId)) {
    ensureActiveSession();
  }

  const resolvedActiveId = sessionsStore()?.activeSessionId ?? state.activeSessionId;
  if (!resolvedActiveId) {
    const container = document.createElement("section");
    container.className = "wm-card wm-live-main";
    const empty = document.createElement("p");
    empty.textContent = "No live session selected. Launch a new agent or use the menu to resume one.";
    container.append(empty);
    wrapper.append(container);
    return wrapper;
  }

  const sessionId = resolvedActiveId;

  const main = document.createElement("section");
  main.className = "wm-card wm-live-main";
  main.style.position = "relative";

  const scrollRegion = document.createElement("div");
  scrollRegion.className = "wm-live-scroll";
  const logSection = renderLogs(sessionId);
  scrollRegion.append(logSection);

  const conversationContainer = document.createElement("div");
  conversationContainer.className = "wm-live-conversation";

  // Use Alpine.js chat component if enabled, otherwise use standard rendering
  if (isAlpineChatEnabled()) {
    conversationContainer.innerHTML = getChatTemplate().replace(
      "'${window.wingman?.activeSessionId || \"\"}'",
      `'${sessionId}'`
    );
    // Make sessionId available globally for Alpine
    window.wingman = window.wingman || {};
    window.wingman.activeSessionId = sessionId;
  } else {
    conversationContainer.append(renderConversation(sessionId));
  }

  scrollRegion.append(conversationContainer);
  scheduleLiveScroll(sessionId, { includeWindow: true });

  // Check for a web app associated with this session
  const webApp = findWebAppForSession(sessionId, state.sessions, state.apps.items, npubProjectsState);
  syncHeaderWebviewToggle(webApp);

  if (webApp && state.webviewLayout.open) {
    // Flag the app container so CSS can expand to full width
    appRoot.dataset.webviewOpen = "true";

    // Split layout: chat column + webview column
    const split = document.createElement("div");
    split.className = `wm-live-split wm-live-split--${state.webviewLayout.mode}`;

    const chatCol = document.createElement("div");
    chatCol.className = "wm-live-chat-col";
    main.append(scrollRegion);
    chatCol.append(main);

    const webviewCol = document.createElement("div");
    webviewCol.className = "wm-webview-col";

    const webviewResult = createWebviewPanel(webApp);
    const toolbar = createLayoutToolbar(
      state.webviewLayout.mode,
      (newMode) => {
        state.webviewLayout.mode = newMode;
        render();
      },
      () => {
        state.webviewLayout.open = false;
        render();
      },
      webviewResult
    );
    webviewCol.append(toolbar);

    if (webviewResult) {
      webviewCol.append(webviewResult.panel);
    }

    split.append(chatCol, webviewCol);
    wrapper.append(split);

    // Composer inside chat column so app iframe gets full height
    chatCol.append(renderComposer(sessionId));
  } else {
    delete appRoot.dataset.webviewOpen;
    main.append(scrollRegion);
    wrapper.append(main);
    wrapper.append(renderComposer(sessionId));
  }

  return wrapper;
};

function captureFocusSnapshot() {
  const active = document.activeElement;
  if (!active || !appRoot || !appRoot.contains(active)) {
    return null;
  }
  if (!(active instanceof HTMLElement)) {
    return null;
  }
  const focusKey = active.dataset?.focusKey;
  if (!focusKey) {
    return null;
  }
  const snapshot = {
    key: focusKey,
    selectionStart: null,
    selectionEnd: null,
  };
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    snapshot.selectionStart = typeof active.selectionStart === "number" ? active.selectionStart : null;
    snapshot.selectionEnd = typeof active.selectionEnd === "number" ? active.selectionEnd : null;
  }
  return snapshot;
}

function restoreFocusFromSnapshot(snapshot) {
  if (!snapshot?.key) {
    return;
  }
  const candidate = document.querySelector(`[data-focus-key="${snapshot.key}"]`);
  if (!(candidate instanceof HTMLElement)) {
    return;
  }
  try {
    candidate.focus({ preventScroll: true });
  } catch {
    candidate.focus();
  }
  if (
    (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) &&
    typeof snapshot.selectionStart === "number" &&
    typeof snapshot.selectionEnd === "number" &&
    typeof candidate.setSelectionRange === "function"
  ) {
    try {
      candidate.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    } catch {
      // ignore selection errors
    }
  }
}

let renderDebounceTimer = null;
let updateAgentStatusIndicatorsDebounceTimer = null;
let isRendering = false;
let previousRenderRoute = null;

// ===========================================================================
// Private Chat Functions
// ===========================================================================

const loadChats = async () => {
  if (state.chats.loading) return;
  state.chats.loading = true;

  try {
    const result = await fetchChatsApi();
    if (result?.unauthorized) {
      state.chats.error = "Authentication required";
      state.chats.items = [];
    } else if (result?.chats) {
      // Sort by startedAt descending (newest first)
      state.chats.items = result.chats.sort((a, b) => {
        const dateA = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const dateB = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        return dateB - dateA;
      });
      state.chats.error = null;
    }
    state.chats.initialized = true;
  } catch (err) {
    console.error("[chat] Failed to load chats:", err);
    state.chats.error = err.message || "Failed to load chats";
  } finally {
    state.chats.loading = false;
    // Re-render to show loaded chats if still on chat route
    if (currentRoute === "chat") {
      render();
    }
  }
};

const loadChatMessages = async (chatId) => {
  if (!chatId) return;

  try {
    const result = await fetchChatMessagesApi(chatId);
    if (result?.messages) {
      state.chatConversations.set(chatId, result.messages);
    }
  } catch (err) {
    console.error("[chat] Failed to load messages:", err);
  }
};

const navigateToChat = (chatId) => {
  const url = chatId ? buildChatUrl(chatId) : CHAT_ROUTE_PREFIX;
  state.activeChatId = chatId || null;
  currentRoute = "chat";
  window.history.pushState({ route: "chat", chatId }, "", url);
  render();
};

const openPrivateChatDialog = () => {
  if (!chatDialogController) {
    chatDialogController = createChatDialogController({
      onCreated: (chat) => {
        // Add to state and navigate
        state.chats.items.unshift(chat);
        navigateToChat(chat.id);
      },
      showToast,
    });
  }
  chatDialogController.open();
};

const deleteChat = async (chatId) => {
  if (!window.confirm("Delete this chat? This cannot be undone.")) {
    return;
  }

  const result = await deleteChatApi(chatId);
  if (result.success) {
    state.chats.items = state.chats.items.filter((c) => c.id !== chatId);
    state.chatConversations.delete(chatId);
    state.chatMessageDrafts.delete(chatId);
    state.chatStreaming.delete(chatId);

    if (state.activeChatId === chatId) {
      navigateToChat(null);
    } else {
      render();
    }
    showToast("Chat deleted");
  } else {
    showToast(result.error || "Failed to delete chat", "error");
  }
};

const sendChatMessageToApi = async (chatId, content) => {
  if (!chatId || !content.trim()) return;

  // Add user message to conversation immediately
  const userMessage = {
    id: `temp-${Date.now()}`,
    role: "user",
    content: content.trim(),
    createdAt: new Date().toISOString(),
  };

  const existing = state.chatConversations.get(chatId) || [];
  state.chatConversations.set(chatId, [...existing, userMessage]);

  // Clear draft
  state.chatMessageDrafts.set(chatId, "");

  // Mark as streaming
  state.chatStreaming.set(chatId, { active: true, content: "" });
  render();

  try {
    const response = await postChatMessageApi(chatId, content.trim());

    let fullContent = "";
    for await (const event of streamChatResponse(response)) {
      if (event.type === "chunk" && event.content) {
        fullContent += event.content;
        state.chatStreaming.set(chatId, { active: true, content: fullContent });
        render();
      } else if (event.type === "done") {
        // Add assistant message
        const messages = state.chatConversations.get(chatId) || [];
        const assistantMessage = {
          id: event.messageId || `msg-${Date.now()}`,
          role: "assistant",
          content: fullContent,
          createdAt: new Date().toISOString(),
        };
        state.chatConversations.set(chatId, [...messages, assistantMessage]);
        state.chatStreaming.set(chatId, { active: false, content: "" });
        render();
        break;
      } else if (event.type === "error") {
        showToast(event.content || "Chat error", "error");
        state.chatStreaming.set(chatId, { active: false, content: "" });
        render();
        break;
      }
    }
  } catch (err) {
    console.error("[chat] Message error:", err);
    showToast(err.message || "Failed to send message", "error");
    state.chatStreaming.set(chatId, { active: false, content: "" });
    render();
  }
};

const renderChatMessage = (message, isStreaming = false) => {
  const container = document.createElement("div");
  container.className = `wm-chat-message wm-chat-message-${message.role}`;
  if (isStreaming) {
    container.classList.add("wm-chat-message-streaming");
  }

  const roleLabel = document.createElement("div");
  roleLabel.className = "wm-chat-message-role";
  roleLabel.textContent = message.role === "user" ? "You" : "Assistant";

  const contentEl = document.createElement("div");
  contentEl.className = "wm-chat-message-content";
  contentEl.textContent = collapseNewlines(message.content);

  container.append(roleLabel, contentEl);
  return container;
};

const renderChatConversation = (chatId) => {
  const container = document.createElement("div");
  container.className = "wm-chat-conversation";

  const messages = state.chatConversations.get(chatId) || [];
  const streaming = state.chatStreaming.get(chatId);

  if (messages.length === 0 && !streaming?.active) {
    const empty = document.createElement("p");
    empty.className = "wm-chat-empty";
    empty.textContent = "Start a conversation by typing a message below.";
    container.append(empty);
    return container;
  }

  for (const message of messages) {
    container.append(renderChatMessage(message));
  }

  // Show streaming message if active
  if (streaming?.active && streaming.content) {
    const streamingMessage = {
      id: "streaming",
      role: "assistant",
      content: streaming.content,
      createdAt: new Date().toISOString(),
    };
    container.append(renderChatMessage(streamingMessage, true));
  }

  return container;
};

const renderChatComposer = (chatId) => {
  // Use the same structure as the live view composer
  const composer = document.createElement("form");
  composer.className = "wm-composer";

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Type your message...";
  textarea.setAttribute("rows", "1");
  textarea.dataset.focusKey = `chat-composer-${chatId}`;
  textarea.value = state.chatMessageDrafts.get(chatId) || "";

  const streaming = state.chatStreaming.get(chatId);
  const isStreaming = streaming?.active ?? false;
  textarea.disabled = isStreaming;

  // Auto-resize textarea
  const resizeTextarea = () => {
    textarea.style.height = "auto";
    const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight) || 20;
    const minHeight = lineHeight * 2.5;
    const maxHeight = lineHeight * 8;
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  };

  textarea.addEventListener("input", () => {
    state.chatMessageDrafts.set(chatId, textarea.value);
    resizeTextarea();
  });

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (textarea.value.trim() && !isStreaming) {
        sendChatMessageToApi(chatId, textarea.value);
      }
    }
  });

  // Button group container (matches live view)
  const buttonGroup = document.createElement("div");
  buttonGroup.className = "wm-button-group";

  const sendBtn = document.createElement("button");
  sendBtn.type = "submit";
  sendBtn.className = "wm-button";
  sendBtn.innerHTML = `<span class="button-text">${isStreaming ? "Sending..." : "Send"}</span>`;
  sendBtn.disabled = isStreaming;

  buttonGroup.append(sendBtn);

  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    if (textarea.value.trim() && !isStreaming) {
      sendChatMessageToApi(chatId, textarea.value);
    }
  });

  composer.append(textarea, buttonGroup);

  // Initialize textarea height after it's in the DOM
  requestAnimationFrame(resizeTextarea);

  return composer;
};

const renderChat = () => {
  const wrapper = document.createElement("div");
  wrapper.className = "wm-chat";

  const chatId = getChatIdFromPath(window.location.pathname);

  // Ensure chats are loaded
  if (!state.chats.initialized && !state.chats.loading) {
    void loadChats();
  }

  // No specific chat selected - show chat list
  if (!chatId) {
    const header = document.createElement("div");
    header.className = "wm-chat-header";

    const title = document.createElement("h2");
    title.textContent = "Private Chats";

    const newBtn = document.createElement("button");
    newBtn.className = "wm-button";
    newBtn.textContent = "New Chat";
    newBtn.addEventListener("click", openPrivateChatDialog);

    header.append(title, newBtn);
    wrapper.append(header);

    const listContainer = document.createElement("div");
    listContainer.className = "wm-chat-list";

    if (state.chats.loading && !state.chats.initialized) {
      const loading = document.createElement("p");
      loading.className = "wm-chat-status";
      loading.textContent = "Loading chats...";
      listContainer.append(loading);
    } else if (state.chats.error) {
      const error = document.createElement("p");
      error.className = "wm-chat-status wm-chat-error";
      error.textContent = state.chats.error;
      listContainer.append(error);
    } else if (state.chats.items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-chat-status";
      empty.textContent = "No chats yet. Click 'New Chat' to start.";
      listContainer.append(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "wm-chat-items";

      for (const chat of state.chats.items) {
        const item = document.createElement("li");
        item.className = "wm-chat-item";

        const link = document.createElement("a");
        link.href = buildChatUrl(chat.id);
        link.className = "wm-chat-item-link";
        link.addEventListener("click", (e) => {
          e.preventDefault();
          navigateToChat(chat.id);
        });

        const name = document.createElement("span");
        name.className = "wm-chat-item-name";
        name.textContent = chat.name || "Untitled Chat";

        const model = document.createElement("span");
        model.className = "wm-chat-item-model";
        model.textContent = chat.model;

        link.append(name, model);

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "wm-button secondary wm-chat-item-delete";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          deleteChat(chat.id);
        });

        item.append(link, deleteBtn);
        list.append(item);
      }

      listContainer.append(list);
    }

    wrapper.append(listContainer);
    return wrapper;
  }

  // Specific chat selected - show chat view
  state.activeChatId = chatId;

  // Load messages if needed
  if (!state.chatConversations.has(chatId)) {
    void loadChatMessages(chatId);
  }

  const chat = state.chats.items.find((c) => c.id === chatId);
  const chatName = chat?.name || "Chat";
  const chatModel = chat?.model || "Unknown";

  const header = document.createElement("div");
  header.className = "wm-chat-header";

  const backBtn = document.createElement("button");
  backBtn.className = "wm-button secondary";
  backBtn.textContent = "\u2190 Back";
  backBtn.addEventListener("click", () => navigateToChat(null));

  const titleContainer = document.createElement("div");
  titleContainer.className = "wm-chat-title-container";

  const title = document.createElement("h2");
  title.className = "wm-chat-title";
  title.textContent = chatName;

  const modelBadge = document.createElement("span");
  modelBadge.className = "wm-chat-model-badge";
  modelBadge.textContent = chatModel;

  titleContainer.append(title, modelBadge);
  header.append(backBtn, titleContainer);
  wrapper.append(header);

  const main = document.createElement("section");
  main.className = "wm-card wm-chat-main";

  const scrollRegion = document.createElement("div");
  scrollRegion.className = "wm-chat-scroll";

  scrollRegion.append(renderChatConversation(chatId));
  main.append(scrollRegion);
  wrapper.append(main);

  wrapper.append(renderChatComposer(chatId));

  // Scroll to bottom after render
  requestAnimationFrame(() => {
    const scrollEl = wrapper.querySelector(".wm-chat-scroll");
    if (scrollEl) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  });

  return wrapper;
};

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
  const seed =
    directoryInput?.value?.trim() ||
    state.lastWorkingDirectory ||
    state.config?.defaultDirectory ||
    "";
  void openDirectoryBrowser({
    initialPath: seed,
    title: "Select Working Directory",
    confirmLabel: "Use This Directory",
    allowCreate: true,
    onSelect: (path) => {
      if (!directoryInput) return;
      directoryInput.value = path;
      state.lastWorkingDirectory = path;
      scheduleDirectorySuggestions(path);
    },
  });
});

directoryUpButton?.addEventListener("click", (event) => {
  event.preventDefault();
  if (directoryBrowserState.parent) {
    updateDirectoryBrowser(directoryBrowserState.parent);
  }
});

directoryNewFolderButton?.addEventListener("click", async (event) => {
  event.preventDefault();
  if (!directoryBrowserState.allowCreate) return;
  const parentPath = directoryBrowserState.currentPath || directoryBrowserState.parent || state.config?.defaultDirectory || "";
  if (!parentPath) {
    window.alert("Select a directory first.");
    return;
  }
  await promptCreateDirectoryAtPath(parentPath, {
    onSuccess: async () => {
      await updateDirectoryBrowser(parentPath);
    },
  });
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
    if (directoryBrowserState.pendingResolve) {
      const resolve = directoryBrowserState.pendingResolve;
      directoryBrowserState.pendingResolve = null;
      resolve(null);
    }
    directoryBrowserState.onSelect = null;
    directoryBrowserState.allowCreate = true;
    directoryBrowserState.confirmLabel = "Use This Directory";
    directoryBrowserState.title = "Select Directory";
  });
}

fileTransferCancelButton?.addEventListener("click", (event) => {
  event.preventDefault();
  closeFileTransferDialog();
});

fileTransferDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeFileTransferDialog();
});

fileTransferDialog?.addEventListener("close", () => {
  resetFileTransferState();
  syncFileTransferConfirmState();
});

fileTransferNameInput?.addEventListener("input", (event) => {
  applyFileTransferNameInput(event.currentTarget?.value ?? "");
});

fileTransferUpButton?.addEventListener("click", (event) => {
  event.preventDefault();
  const parent = state.files.transfer.browser.parent;
  if (parent) {
    void updateFileTransferBrowser(parent);
  }
});

fileTransferNewFolderButton?.addEventListener("click", async (event) => {
  event.preventDefault();
  const parent =
    state.files.transfer.browser.currentPath ||
    state.files.transfer.browser.parent ||
    state.files.currentPath ||
    "";
  if (!parent) {
    window.alert("Select a directory first.");
    return;
  }
  await promptCreateDirectoryAtPath(parent, {
    onSuccess: async (result) => {
      await updateFileTransferBrowser(parent);
      if (result?.path) {
        setFileTransferSelection(result.path, result?.displayPath ?? result.path);
      }
    },
  });
});

fileTransferConfirmButton?.addEventListener("click", async (event) => {
  event.preventDefault();
  await submitFileTransfer();
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
