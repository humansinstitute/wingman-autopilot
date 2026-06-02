/**
 * Live view renderer — session tabs, logs, conversation, composer, webview split,
 * archived session viewer, and focus snapshot utilities.
 *
 * Depends on: state, sessions store, navigation, session actions, image attachments (via DI).
 */

import { getSessionDisplayName } from "../core/icons.js";
import { openTextPromptDialog } from "../common/dialog-prompts.js";
import { attachCopyButton, copyConversationToClipboard } from "../utils/clipboard.js";
import { showToast } from "../utils/toast.js";
import { renderChatMessageHtml } from "../rendering/chat-message-content.js";
import { fetchSessionHistoryApi, forkSessionToWorktreeApi, setPinnedArtifactApi } from "../services/sessions.js";
import { showRunningAppsModal } from "../apps/running-apps-modal.js";
import { showRunningPipelinesModal } from "../pipelines/running-pipelines-modal.js";
import { isAlpineChatEnabled, getChatTemplate, Alpine, MessageStore } from "../live/index.js";
import { attachPathMentionAutocomplete } from "../live/path-mention-autocomplete.js";
import { findAppForSession, findWebAppForSession, createWebviewPanel, createLayoutToolbar } from "../live/webview-panel.js";
import { createWriterPanel, createWriterToolbar } from "../writer/writer-panel.js";
import { createMobileTabBar, attachSwipeGesture } from "../writer/mobile-tabs.js";
import { fetchSessionArtifacts, createArtifactsPanel, createArtifactsToolbar } from "../live/artifacts-panel.js";
import { createAppControlsPanel, createAppControlsToolbar } from "../live/app-controls-panel.js";
import { createCommandMenuController } from "../live/command-menu-positioning.js";
import { addGitCommandSubmenus } from "../live/git-command-submenus.js";
import { createSessionStopFeedback } from "../live/session-stop-feedback.js";
import {
  addPinnedFileForSession,
  clearWriterDismissal,
  getPinnedFilePageForSession,
  getPinnedFileForSession,
  markWriterDismissed,
  setPinnedFilePageForSession,
  shouldAutoOpenWriter,
  syncPinnedFileForSession,
} from "../live/writer-panel-state.js";
import { addNightWatchToggle } from "../nightwatch/cmd-toggle.js";
import { openFilePicker } from "../modals/file-picker.js";
import { npubProjectsState } from "../npub-projects/index.js";
import { state, TERMINAL_CONTROL_ACTIONS } from "../state/index.js";
import * as scrollPill from "../live/scroll-pill.js";
import { resolveTerminalControlKeyAction } from "../live/terminal-controls.js";
import {
  createConversationElement,
  expandConversationWindow,
  capturePrependedScrollState,
  schedulePrependedScrollRestore,
} from "../live/conversation-window.js";
import { focusComposerTextarea } from "../live/mobile-runtime.js";
import {
  createLiveSessionDrawer,
  isLiveDrawerVisible,
} from "../live/session-drawer.js";
import {
  getLiveDrawerLayoutState,
  getRenderedLiveDrawerVisible,
} from "../live/drawer-visibility.js";
import { createLiveHeaderFullscreenToggle } from "../live/header-fullscreen-toggle.js";
import { canResumeNativeAgentSession } from "../home/native-session-resume.js";
import { filterTaskDispatchSessionsForTabs } from "../sessions/session-classification.js";

export function initLiveView(deps) {
  const {
    sessionsStore,
    appsStore,
    getCurrentRoute,
    setCurrentRoute,
    getTabsVisible,
    getTaskDispatchTabsVisible,
    getLiveHeaderCollapsed,
    toggleLiveHeaderCollapsed,
    getRawTerminalOutputVisible,
    appRoot,
    render,
    // Session helpers
    getActiveSessions,
    setActiveSession,
    stopSession,
    fetchLogs,
    fetchConversation,
    sendMessage,
    getSessionIdFromPath,
    ensureActiveSession,
    promptRenameSession,
    resumeNativeSession,
    sendControlCommand,
    syncHeaderWebviewToggle,
    syncHeaderWriterToggle,
    scheduleLiveScroll,
    scrollConversationAreaToBottom,
    // Stubs (late-bound)
    createAgentStatusIndicator,
    extractImageFiles,
    extractAttachmentFiles,
    handleImageUploads,
    handleAttachmentUploads,
    cleanupOrphanedMarkers,
    clearImagePreviews,
    openVoiceNoteRecorder,
    openDialog,
    isFeatureEnabledForViewer,
    showToast,
    renderAppCard,
    refreshApps,
    triggerAppAction,
  } = deps;

  // Track active writer panel cleanup function
  let activeWriterCleanup = null;
  let archivedNativeResumePending = false;
  const sessionStopFeedback = createSessionStopFeedback({
    getSessionById(sessionId) {
      return sessionsStore().items.find((item) => item.id === sessionId) ?? null;
    },
    getSessionDisplayName,
    stopSession,
    showToast,
  });

  function updateSessionPinnedFile(sessionId, filePath) {
    const session = sessionsStore().items.find((item) => item.id === sessionId);
    if (session) {
      session.pinnedFile = filePath ?? null;
    }
  }

  async function persistPinnedArtifact(sessionId, filePath) {
    const result = await setPinnedArtifactApi(sessionId, filePath);
    const pinnedFile = result?.pinnedFile ?? null;
    updateSessionPinnedFile(sessionId, pinnedFile);
    if (pinnedFile) {
      addPinnedFileForSession(state, sessionId, pinnedFile);
    } else {
      state.pinnedFiles.delete(sessionId);
    }
    return pinnedFile;
  }

  function getPinnedArtifactLabel(filePath) {
    const normalized = typeof filePath === "string" ? filePath.replace(/\\/g, "/") : "";
    return normalized.split("/").filter(Boolean).pop() || "Pinned doc";
  }

  function createPinnedArtifactPager(sessionId, pageState) {
    if (!pageState || pageState.files.length <= 1) {
      return null;
    }
    const pager = document.createElement("div");
    pager.className = "wm-webview-toolbar-actions";
    pager.setAttribute("aria-label", "Pinned artifacts");
    pager.dataset.testid = "live-pinned-artifact-pager";

    const previousButton = document.createElement("button");
    previousButton.type = "button";
    previousButton.className = "wm-webview-mode-btn";
    previousButton.textContent = "<";
    previousButton.setAttribute("aria-label", "Previous pinned artifact");
    previousButton.disabled = pageState.activeIndex <= 0;
    previousButton.addEventListener("click", () => {
      setPinnedFilePageForSession(state, sessionId, pageState.activeIndex - 1);
      clearWriterDismissal(state, sessionId);
      render();
    });

    const label = document.createElement("span");
    label.className = "wm-webview-toolbar-title wm-pinned-artifact-page-label";
    label.textContent = `${pageState.activeIndex + 1} of ${pageState.files.length} · ${getPinnedArtifactLabel(pageState.activeFile)}`;
    label.title = pageState.activeFile ?? "";
    label.dataset.testid = "live-pinned-artifact-page-label";

    const nextButton = document.createElement("button");
    nextButton.type = "button";
    nextButton.className = "wm-webview-mode-btn";
    nextButton.textContent = ">";
    nextButton.setAttribute("aria-label", "Next pinned artifact");
    nextButton.disabled = pageState.activeIndex >= pageState.files.length - 1;
    nextButton.addEventListener("click", () => {
      setPinnedFilePageForSession(state, sessionId, pageState.activeIndex + 1);
      clearWriterDismissal(state, sessionId);
      render();
    });

    pager.append(previousButton, label, nextButton);
    return pager;
  }

  function resolveCurrentLiveSessionId() {
    const liveSessions = sessionsStore().items;
    const routeSessionId =
      getCurrentRoute() === "live"
        ? getSessionIdFromPath(window.location.pathname)
        : null;

    if (routeSessionId && liveSessions.some((session) => session.id === routeSessionId)) {
      return routeSessionId;
    }

    const activeId = sessionsStore().activeSessionId;
    if (activeId && liveSessions.some((session) => session.id === activeId)) {
      return activeId;
    }

    const lastId = sessionsStore().lastActiveSessionId;
    if (lastId && liveSessions.some((session) => session.id === lastId)) {
      return lastId;
    }

    return null;
  }

  function closeLiveDrawerModal() {
    state.liveDrawer.reportModalOpen = false;
    state.liveDrawer.selectedReportId = "";
  }

  function setLiveDrawerOpen(nextOpen) {
    state.liveDrawer.userToggled = true;
    state.liveDrawer.open = Boolean(nextOpen);
    if (!nextOpen) {
      closeLiveDrawerModal();
    }
  }

  function closeSecondaryPanels() {
    state.writerLayout.open = false;
    state.artifactsLayout.open = false;
    state.appCardLayout.open = false;
    state.webviewLayout.open = false;
  }

  function getLiveDrawerRenderState(sessionId) {
    const session = sessionsStore().items.find((item) => item.id === sessionId) ?? null;
    const sessionPinnedFiles = Array.isArray(session?.metadata?.pinnedFiles) && session.metadata.pinnedFiles.length > 0
      ? session.metadata.pinnedFiles
      : session?.pinnedFile ?? null;
    const effectiveFile =
      getPinnedFileForSession(state, sessionId, sessionPinnedFiles) || session?.targetFile || null;
    const matchingApp = findAppForSession(sessionId, sessionsStore().items, appsStore().items, npubProjectsState);
    const webApp = findWebAppForSession(sessionId, sessionsStore().items, appsStore().items, npubProjectsState);
    const layoutState = getLiveDrawerLayoutState({
      effectiveFile,
      matchingApp,
      webApp,
      writerLayout: state.writerLayout,
      artifactsLayout: state.artifactsLayout,
      appCardLayout: state.appCardLayout,
      webviewLayout: state.webviewLayout,
    });

    return {
      session,
      effectiveFile,
      matchingApp,
      webApp,
      layoutState,
      visible: getRenderedLiveDrawerVisible({
        drawerState: state.liveDrawer,
        viewportWidth: window.innerWidth,
        layoutState,
      }),
    };
  }

  function toggleLiveDrawer() {
    const sessionId = resolveCurrentLiveSessionId();
    const visible = sessionId
      ? getLiveDrawerRenderState(sessionId).visible
      : isLiveDrawerVisible(state.liveDrawer, window.innerWidth);
    const nextOpen = !visible;
    if (nextOpen) {
      closeSecondaryPanels();
    }
    setLiveDrawerOpen(nextOpen);
    render();
  }

  // ── Session tabs ────────────────────────────────────────────────

  function replaceLiveTabsBarContent() {
    const tabsBar = document.querySelector(".wm-tabs-bar");
    if (!tabsBar) {
      return;
    }
    const existingPanel = tabsBar.querySelector(".wm-live-tabs-panel");
    if (!existingPanel) {
      return;
    }
    existingPanel.replaceWith(renderLiveTabsBarContent());
  }

  function renderLiveTabsBarContent() {
    const panel = document.createElement("div");
    panel.className = "wm-live-tabs-panel";
    panel.append(renderTabs({ sessions: getVisibleTabSessions(getActiveSessions()) }));
    const actions = document.createElement("div");
    actions.className = "wm-live-tabs-actions";
    actions.append(createLiveHeaderFullscreenToggle({
      collapsed: shouldCollapseLiveHeader(),
      onToggle: toggleLiveHeaderCollapsed,
    }));
    panel.append(actions);
    return panel;
  }

  function shouldCollapseLiveHeader() {
    return typeof getLiveHeaderCollapsed === "function"
      ? getLiveHeaderCollapsed()
      : false;
  }

  function shouldShowTaskDispatchTabs() {
    return typeof getTaskDispatchTabsVisible === "function"
      ? getTaskDispatchTabsVisible()
      : true;
  }

  function getVisibleTabSessions(sessions) {
    return filterTaskDispatchSessionsForTabs(sessions, shouldShowTaskDispatchTabs());
  }

  function shouldShowRawTerminalOutput() {
    return typeof getRawTerminalOutputVisible === "function"
      ? getRawTerminalOutputVisible()
      : false;
  }

  function appendRawTerminalOutput(target, sessionId) {
    if (!shouldShowRawTerminalOutput()) {
      state.logContainers.delete(sessionId);
      return;
    }
    target.append(renderLogs(sessionId));
  }

  function activateSessionTab(session, onSelect) {
    const wasLiveRoute = getCurrentRoute() === "live";
    const activeId = resolveCurrentLiveSessionId();
    if (activeId === session.id && wasLiveRoute) {
      onSelect?.();
      return;
    }

    setCurrentRoute("live");
    setActiveSession(session.id, { updateHistory: true, forceLog: true });
    fetchLogs(session.id);
    fetchConversation(session.id);
    if (wasLiveRoute) {
      if (getTabsVisible()) {
        replaceLiveTabsBarContent();
      }
      updateLivePanelsForSession(session.id);
    } else {
      render();
    }
    onSelect?.();
  }

  function createSessionTab(session, onSelect) {
    const activeId = resolveCurrentLiveSessionId();
    const isActive = session.id === activeId;
    const displayName = getSessionDisplayName(session);
    const tab = document.createElement("div");
    tab.className = "wm-tab";
    tab.setAttribute("role", "presentation");
    tab.title = `${displayName} - ${session.agent}:${session.port}`;
    if (isActive) {
      tab.classList.add("active");
    }

    const tabButton = document.createElement("button");
    tabButton.type = "button";
    tabButton.className = "wm-tab__button";
    tabButton.setAttribute("role", "tab");
    tabButton.setAttribute("aria-selected", isActive ? "true" : "false");
    tabButton.setAttribute("aria-label", `Open ${displayName}`);
    tabButton.setAttribute("data-testid", `live-session-tab-${session.id}`);
    tabButton.addEventListener("click", () => {
      activateSessionTab(session, onSelect);
    });

    const label = document.createElement("span");
    label.className = "wm-tab__label";
    label.textContent = displayName;
    tabButton.append(label);

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "close wm-tab__close";
    closeButton.title = "Stop session";
    closeButton.setAttribute("aria-label", `Stop ${displayName}`);
    closeButton.setAttribute("data-testid", `live-session-close-${session.id}`);
    closeButton.textContent = "\u00d7";
    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void sessionStopFeedback.requestStopSession(session.id);
      onSelect?.();
    });

    tab.append(tabButton, closeButton);
    return tab;
  }

  function createTabsContainer(variant) {
    const tabs = document.createElement("div");
    tabs.className = `wm-tabs${variant === "menu" ? " menu" : ""}`;
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Live sessions");
    tabs.setAttribute("aria-orientation", variant === "menu" ? "vertical" : "horizontal");
    tabs.setAttribute("data-testid", variant === "menu" ? "menu-session-tabs" : "live-session-tabs");
    return tabs;
  }

  const renderSessionTabs = (options = {}) => {
    const onSelect = typeof options.onSelect === "function" ? options.onSelect : null;
    const tabs = createTabsContainer("menu");

    getActiveSessions().forEach((session) => {
      tabs.append(createSessionTab(session, onSelect));
    });

    return tabs;
  };

  const renderTabs = (options = {}) => {
    const variant = options.variant === "menu" ? "menu" : "default";
    const onSelect = typeof options.onSelect === "function" ? options.onSelect : null;
    const sessions = Array.isArray(options.sessions) ? options.sessions : getActiveSessions();
    const tabs = createTabsContainer(variant);

    sessions.forEach((session) => {
      tabs.append(createSessionTab(session, onSelect));
    });

    if (state.identity.authenticated) {
      const newTab = document.createElement("button");
      newTab.type = "button";
      newTab.className = "wm-tab wm-tab-new new";
      newTab.textContent = "+";
      newTab.title = "Start new session";
      newTab.setAttribute("aria-label", "Start new session");
      newTab.setAttribute("data-testid", "live-session-new-tab");
      newTab.addEventListener("click", () => {
        openDialog();
        onSelect?.();
      });
      tabs.append(newTab);
    }

    return tabs;
  };

  // ── Logs panel ──────────────────────────────────────────────────

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

    state.logContainers.set(sessionId, container);
    state.lastLogLength.set(sessionId, logs.length);

    return panel;
  };

  // ── Archived sessions ───────────────────────────────────────────

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
        const body = document.createElement("div");
        body.className = "wm-message-body";
        body.innerHTML = renderChatMessageHtml(message.content ?? message.message ?? "");
        bubble.append(body);
        attachCopyButton(bubble);
        wrapper.append(bubble);
      });
    }

    return wrapper;
  };

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

  // ── Conversation ────────────────────────────────────────────────

  const rerenderConversation = async (sessionId, options = {}) => {
    const { prependedScrollState = null } = options;
    const current = state.conversationContainers.get(sessionId);
    const conversation = await MessageStore.getSessionMessages(sessionId);
    const next = createConversationElement({
      sessionId,
      conversation,
      windowStore: state.liveMessageWindows,
      onRevealOlder: (scrollElement) => {
        const snapshot = capturePrependedScrollState(scrollElement);
        expandConversationWindow(state.liveMessageWindows, sessionId, conversation.length);
        void rerenderConversation(sessionId, { prependedScrollState: snapshot });
      },
    });

    if (current?.parentNode) {
      current.replaceWith(next);
    }

    state.conversationContainers.set(sessionId, next);
    state.lastMessageCount.set(sessionId, conversation.length);

    if (prependedScrollState) {
      schedulePrependedScrollRestore(prependedScrollState);
    }

    return next;
  };

  const renderConversation = (sessionId) => {
    const placeholder = document.createElement("div");
    placeholder.className = "wm-conversation";
    placeholder.dataset.sessionId = sessionId;
    const loading = document.createElement("p");
    loading.textContent = "Loading conversation...";
    placeholder.append(loading);
    state.conversationContainers.set(sessionId, placeholder);
    queueMicrotask(() => {
      void rerenderConversation(sessionId);
    });
    return placeholder;
  };

  // ── Composer ────────────────────────────────────────────────────

  function resolveSessionAgentLabel(session) {
    const agentId = typeof session?.agent === "string" ? session.agent : "";
    const configuredAgent = Array.isArray(state.config?.agents)
      ? state.config.agents.find((agent) => agent?.id === agentId)
      : null;
    return configuredAgent?.label || agentId || "Agent";
  }

  function renderComposerContext(sessionId) {
    const session = sessionsStore().items.find((item) => item.id === sessionId) ?? null;
    const context = document.createElement("div");
    context.className = "wm-composer-context";

    const name = document.createElement("strong");
    name.textContent = `${getSessionDisplayName(session)}:`;

    const directory = session?.workingDirectory || session?.directory || "";
    const details = document.createElement("span");
    details.textContent = ` ${directory || "No directory"} | ${resolveSessionAgentLabel(session)}`;

    context.append(name, details);
    return context;
  }

  const renderComposer = (sessionId) => {
    const composerShell = document.createElement("div");
    composerShell.className = "wm-composer-shell";
    composerShell.dataset.sessionId = sessionId;

    const imagePreviewContainer = document.createElement("div");
    imagePreviewContainer.className = "wm-image-preview-container";
    imagePreviewContainer.style.display = "none";
    imagePreviewContainer.style.marginBottom = "8px";
    imagePreviewContainer.style.display = "flex";
    imagePreviewContainer.style.flexWrap = "wrap";
    imagePreviewContainer.style.gap = "8px";

    const composer = document.createElement("form");
    composer.className = "wm-composer";

    let initialDraft = state.messageDrafts.get(sessionId) ?? "";
    let shouldAutoSubmit = false;
    if (!initialDraft) {
      try {
        const storedDraft = localStorage.getItem(`session-draft-${sessionId}`);
        if (storedDraft) {
          initialDraft = storedDraft;
          state.messageDrafts.set(sessionId, storedDraft);
          localStorage.removeItem(`session-draft-${sessionId}`);
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
    textarea.dataset.focusKey = `live-composer-${sessionId}`;

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

    let mentionAutocomplete = null;
    let submit;
    let commandButton;
    const defaultPlaceholder = "Ask the agent something...";
    const setUploadingState = (isUploading) => {
      if (isUploading) {
        composer.dataset.uploading = "true";
        textarea.placeholder = "Uploading\u2026";
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
      cleanupOrphanedMarkers(sessionId, newText);
      mentionAutocomplete?.handleInput();
    });
    textarea.addEventListener("keydown", (event) => {
      if (mentionAutocomplete?.handleKeydown(event)) {
        return;
      }
      const controlAction = resolveTerminalControlKeyAction(event, textarea.value, TERMINAL_CONTROL_ACTIONS);
      if (controlAction) {
        event.preventDefault();
        sendControlCommand(sessionId, controlAction);
        return;
      }
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
      clearImagePreviews(sessionId);
      const result = sendMessage(sessionId, draft);
      if (result?.finally) {
        result.finally(() => {
          requestAnimationFrame(() => {
            const newTextarea = document.querySelector('.wm-composer textarea');
            if (newTextarea) {
              focusComposerTextarea(newTextarea, "send");
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

    const commandMenuController = createCommandMenuController({ commandButton, commandMenu });

    const addCommand = (label, handler) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "wm-command-item";
      item.textContent = label;
      item.setAttribute("role", "menuitem");
      item.addEventListener("click", () => {
        handler();
        commandMenuController.close();
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
          commandMenuController.close();
        });
        panel.append(item);
      });

      submenu.append(trigger, panel);
      commandMenu.append(submenu);
    };

    const drawerVisible = getLiveDrawerRenderState(sessionId).visible;
    addCommand(drawerVisible ? "Hide Session Drawer" : "Show Session Drawer", () => {
      toggleLiveDrawer();
    });
    addCommand("Running Apps", () => {
      showRunningAppsModal({
        appsStore,
        renderAppCard,
        refreshApps,
        triggerAppAction,
        showToast,
      });
    });
    addCommand("Running Pipelines", () => {
      showRunningPipelinesModal({ showToast });
    });
    addCommandDivider();
    addGitCommandSubmenus({
      addSubmenu,
      sessionId,
      sessionsStore,
      openTextPromptDialog,
      showToast,
      forkSessionToWorktreeApi,
    });

    const matchingApp = findAppForSession(sessionId, sessionsStore().items, appsStore().items, npubProjectsState);

    if (matchingApp) {
      const appItems = [];

      appItems.push({
        label: state.appCardLayout.open ? "Hide app card" : "App card",
        handler: () => {
          const shouldOpen = !state.appCardLayout.open;
          state.appCardLayout.open = shouldOpen;
          if (shouldOpen) {
            state.appCardLayout.mobileTab = "app";
            state.writerLayout.open = false;
            state.artifactsLayout.open = false;
            state.webviewLayout.open = false;
          }
          render();
        },
      });

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
            const success = typeof triggerAppAction === "function"
              ? await triggerAppAction(matchingApp.id, "restart")
              : false;
            if (success) {
              showToast(`Restarting ${matchingApp.label}...`, { type: "success" });
            } else {
              showToast("Failed to restart app", { type: "error" });
            }
          },
        });
      }

      if (matchingApp.availableScripts?.stop) {
        appItems.push({
          label: "Stop",
          handler: async () => {
            const success = typeof triggerAppAction === "function"
              ? await triggerAppAction(matchingApp.id, "stop")
              : false;
            if (success) {
              showToast(`Stopped ${matchingApp.label}`, { type: "success" });
            } else {
              showToast("Failed to stop app", { type: "error" });
            }
          },
        });
      }

      if (appItems.length > 0) {
        addSubmenu("App", appItems);
      }
    }

    const currentSession = sessionsStore().items.find((s) => s.id === sessionId);

    addNightWatchToggle({
      sessionId,
      sessionName: currentSession?.name ?? null,
      sessionMetadata: currentSession?.metadata ?? null,
      addCommand,
      state,
      showToast,
      isFeatureEnabled: isFeatureEnabledForViewer,
    });

    const cmdWebApp = findWebAppForSession(sessionId, sessionsStore().items, appsStore().items, npubProjectsState);
    if (cmdWebApp) {
      addCommand(state.webviewLayout.open ? "Close Web View" : "Open Web View", () => {
        const shouldOpen = !state.webviewLayout.open;
        state.webviewLayout.open = shouldOpen;
        if (shouldOpen) {
          state.appCardLayout.open = false;
          state.writerLayout.open = false;
          state.artifactsLayout.open = false;
          state.webviewLayout.mobileTab = "app";
        }
        render();
      });
    }

    const sessionPinnedFiles = Array.isArray(currentSession?.metadata?.pinnedFiles) && currentSession.metadata.pinnedFiles.length > 0
      ? currentSession.metadata.pinnedFiles
      : currentSession?.pinnedFile ?? null;
    const pinnedFile = getPinnedFileForSession(state, sessionId, sessionPinnedFiles);
    const artifactPanelOpen = Boolean(pinnedFile) && state.writerLayout.open;
    addCommand(artifactPanelOpen ? "Close Artifact" : "Open Artifact", async () => {
      if (pinnedFile) {
        if (artifactPanelOpen) {
          markWriterDismissed(state, sessionId, pinnedFile);
          state.writerLayout.open = false;
          render();
          return;
        }
        clearWriterDismissal(state, sessionId);
        state.writerLayout.open = true;
        state.writerLayout.mobileTab = "writer";
        state.appCardLayout.open = false;
        state.artifactsLayout.open = false;
        state.webviewLayout.open = false;
        render();
        return;
      }

      const session = sessionsStore().items.find((s) => s.id === sessionId);
      const startPath = session?.workingDirectory || "";
      const filePath = await openFilePicker({ initialPath: startPath });
      if (filePath) {
        try {
          await persistPinnedArtifact(sessionId, filePath);
          clearWriterDismissal(state, sessionId);
          state.writerLayout.open = true;
          state.writerLayout.mobileTab = "writer";
          state.appCardLayout.open = false;
          state.artifactsLayout.open = false;
          state.webviewLayout.open = false;
          render();
        } catch (error) {
          showToast(`Failed to pin artifact: ${error.message}`, { type: "error" });
        }
      }
    });

    addCommandDivider();

    addCommand("Scroll to end", () => {
      scrollConversationAreaToBottom(sessionId, { includeWindow: true });
      scrollPill.hide();
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
      const session = sessionsStore().items.find((s) => s.id === sessionId);
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

    addCommand("Record voice note", () => {
      openVoiceNoteRecorder(sessionId);
    });

    addCommandDivider();
    addSubmenu("Terminal", TERMINAL_CONTROL_ACTIONS.map((action) => ({
      label: action.label,
      handler: () => sendControlCommand(sessionId, action),
    })));

    addCommandDivider();
    addCommand("Stop Session", () => {
      void sessionStopFeedback.requestStopSession(sessionId, { confirm: true });
    });

    commandButton.addEventListener("click", () => {
      if (commandButton.disabled) return;
      commandMenuController.toggle();
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

    const textareaWrapper = document.createElement("div");
    textareaWrapper.className = "wm-textarea-wrapper";
    const knightRider = document.createElement("div");
    knightRider.className = "wm-knight-rider";
    knightRider.dataset.sessionId = sessionId;
    textareaWrapper.append(knightRider, textarea);
    mentionAutocomplete = attachPathMentionAutocomplete({
      sessionId,
      textarea,
      parentElement: textareaWrapper,
      getWorkingDirectory: () => {
        const session = sessionsStore().items.find((item) => item.id === sessionId);
        return session?.workingDirectory ?? "";
      },
      onDraftChange: (nextValue) => {
        state.messageDrafts.set(sessionId, nextValue);
        cleanupOrphanedMarkers(sessionId, nextValue);
      },
      onResize: resizeTextarea,
    });

    const inputColumn = document.createElement("div");
    inputColumn.className = "wm-composer-input-column";
    inputColumn.append(renderComposerContext(sessionId), textareaWrapper);

    composer.append(fileInput, attachmentInput, inputColumn, buttonGroup);

    const statusIndicator = createAgentStatusIndicator(sessionId, { variant: "pill" });
    statusIndicator.classList.add("wm-agent-status-pill-button");
    buttonGroup.prepend(statusIndicator);

    composerShell.append(imagePreviewContainer, composer);

    resizeTextarea();

    requestAnimationFrame(() => {
      if (!document.contains(textarea)) return;
      focusComposerTextarea(textarea, "mount");
      resizeTextarea();

      if (shouldAutoSubmit && textarea.value.trim()) {
        setTimeout(() => {
          if (document.contains(composer)) {
            composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          }
        }, 500);
      }
    });

    return composerShell;
  };

  // ── Live panel updates ──────────────────────────────────────────

  const updateLivePanelsForSession = (sessionId) => {
    const scrollRegion = document.querySelector('.wm-live-scroll');
    if (scrollRegion) {
      scrollRegion.innerHTML = "";
      appendRawTerminalOutput(scrollRegion, sessionId);
      const conversationContainer = document.createElement("div");
      conversationContainer.className = "wm-live-conversation";
      if (isAlpineChatEnabled()) {
        conversationContainer.innerHTML = getChatTemplate(sessionId);
      } else {
        conversationContainer.append(renderConversation(sessionId));
      }
      scrollRegion.append(conversationContainer);
      // Tell Alpine to process the new DOM tree
      if (isAlpineChatEnabled()) {
        Alpine.initTree(conversationContainer);
      }
    }

    const currentComposer = document.querySelector('.wm-composer-shell');
    const newComposer = renderComposer(sessionId);
    if (currentComposer) {
      currentComposer.replaceWith(newComposer);
    } else {
      const liveWrapper = document.querySelector('.wm-live');
      if (liveWrapper) {
        liveWrapper.append(newComposer);
      }
    }
    // Re-attach scroll pill to new composer
    requestAnimationFrame(() => {
      const splitScroll = newComposer.closest('.wm-live-chat-col')?.querySelector('.wm-live-scroll');
      const docScroll = document.scrollingElement || document.documentElement || document.body;
      scrollPill.attachScrollPill(newComposer, splitScroll || docScroll);
    });

    requestAnimationFrame(() => {
      const textarea = document.querySelector('.wm-composer textarea');
      if (textarea) {
        focusComposerTextarea(textarea, "mount");
      }
    });
  };

  // ── Main live renderer ──────────────────────────────────────────

  const renderLive = () => {
    const wrapper = document.createElement("div");
    wrapper.className = "wm-live";

    if (getTabsVisible()) {
      const tabsBar = document.createElement("div");
      tabsBar.className = "wm-tabs-bar";
      tabsBar.append(renderLiveTabsBarContent());
      wrapper.append(tabsBar);
    }

    const routeSessionId = getSessionIdFromPath(window.location.pathname);
    const isLiveSession = routeSessionId && sessionsStore().items.some((s) => s.id === routeSessionId);

    if (routeSessionId && !isLiveSession) {
      if (state.archivedSession.sessionId !== routeSessionId && !state.archivedSession.loading) {
        void loadArchivedSession(routeSessionId);
      }

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

        if (
          canResumeNativeAgentSession(state.archivedSession.session) &&
          typeof resumeNativeSession === "function"
        ) {
          const resumeNativeBtn = document.createElement("button");
          resumeNativeBtn.type = "button";
          resumeNativeBtn.className = "wm-button wm-archived-resume-native";
          resumeNativeBtn.textContent = archivedNativeResumePending ? "Resuming..." : "Resume Native";
          resumeNativeBtn.disabled = archivedNativeResumePending;
          resumeNativeBtn.setAttribute("aria-label", `Resume native agent session for ${sessionName}`);
          resumeNativeBtn.dataset.testid = "resume-native-archived-live-session";
          resumeNativeBtn.addEventListener("click", async () => {
            if (archivedNativeResumePending) return;
            archivedNativeResumePending = true;
            render();
            try {
              await resumeNativeSession(routeSessionId);
            } finally {
              archivedNativeResumePending = false;
            }
          });
          header.append(resumeNativeBtn);
        }

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

        requestAnimationFrame(() => {
          const scrollEl = wrapper.querySelector(".wm-live-scroll");
          if (scrollEl) {
            scrollEl.scrollTop = scrollEl.scrollHeight;
          }
        });

        return wrapper;
      }

      const notFoundContainer = document.createElement("div");
      notFoundContainer.className = "wm-live-empty";
      const notFoundText = document.createElement("p");
      notFoundText.textContent = "Session not found.";
      notFoundContainer.append(notFoundText);
      main.append(notFoundContainer);
      wrapper.append(main);
      return wrapper;
    }

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

    if (sessionsStore().items.length === 0) {
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
        // placeholder
      });

      emptyContainer.append(empty, refreshBtn);
      container.append(emptyContainer);
      wrapper.append(container);
      return wrapper;
    }

    let sessionId = resolveCurrentLiveSessionId();
    if (sessionId && sessionsStore().activeSessionId !== sessionId) {
      setActiveSession(sessionId, { updateHistory: false, logPort: false });
    }
    if (!sessionId) {
      ensureActiveSession();
      sessionId = resolveCurrentLiveSessionId();
    }
    if (!sessionId) {
      const container = document.createElement("section");
      container.className = "wm-card wm-live-main";
      const empty = document.createElement("p");
      empty.textContent = "No live session selected. Launch a new agent or use the menu to resume one.";
      container.append(empty);
      wrapper.append(container);
      return wrapper;
    }

    const main = document.createElement("section");
    main.className = "wm-card wm-live-main";
    main.style.position = "relative";

    const scrollRegion = document.createElement("div");
    scrollRegion.className = "wm-live-scroll";
    appendRawTerminalOutput(scrollRegion, sessionId);

    const conversationContainer = document.createElement("div");
    conversationContainer.className = "wm-live-conversation";

    if (isAlpineChatEnabled()) {
      conversationContainer.innerHTML = getChatTemplate(sessionId);
    } else {
      conversationContainer.append(renderConversation(sessionId));
    }

    scrollRegion.append(conversationContainer);
    // Tell Alpine to process the new DOM tree
    if (isAlpineChatEnabled()) {
      Alpine.initTree(conversationContainer);
    }
    // Initial render: scroll to bottom once DOM is ready
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollConversationAreaToBottom(sessionId, { includeWindow: true });
      });
    });

    // Clean up previous writer panel if any
    if (activeWriterCleanup) {
      activeWriterCleanup();
      activeWriterCleanup = null;
    }

    // Determine if this session has a target file for writer mode
    const drawerRenderState = getLiveDrawerRenderState(sessionId);
    const activeSession = drawerRenderState.session;
    const targetFile = activeSession?.targetFile ?? null;

    const sessionPinnedFiles = Array.isArray(activeSession?.metadata?.pinnedFiles) && activeSession.metadata.pinnedFiles.length > 0
      ? activeSession.metadata.pinnedFiles
      : activeSession?.pinnedFile ?? null;
    syncPinnedFileForSession(state, sessionId, sessionPinnedFiles);
    const pinnedFilePage = getPinnedFilePageForSession(state, sessionId, sessionPinnedFiles);

    // Pinned file takes priority over session targetFile
    const effectiveFile = pinnedFilePage.activeFile ?? drawerRenderState.effectiveFile ?? targetFile;

    if (!effectiveFile) {
      clearWriterDismissal(state, sessionId);
    }

    // Auto-open writer layout when session has an effective file unless the user dismissed it
    if (shouldAutoOpenWriter(state, sessionId, effectiveFile)) {
      state.writerLayout.open = true;
    }

    const matchingApp = drawerRenderState.matchingApp;
    if (!matchingApp && state.appCardLayout.open) {
      state.appCardLayout.open = false;
    }
    const webApp = drawerRenderState.webApp;
    syncHeaderWebviewToggle(webApp);
    syncHeaderWriterToggle(effectiveFile);

    // Fetch artifacts count for header icon (non-blocking)
    fetchSessionArtifacts(sessionId).then((items) => {
      state.artifactCounts.set(sessionId, items.length);
      // Store artifacts for panel rendering
      state._sessionArtifacts = items;
    });

    // Writer split takes priority, then artifacts, then webview
    if (effectiveFile && state.writerLayout.open) {
      appRoot.dataset.webviewOpen = "true";

      const mobileTab = state.writerLayout.mobileTab || "chat";
      const split = document.createElement("div");
      split.className = `wm-live-split wm-live-split--${state.writerLayout.mode} wm-live-split--mobile-${mobileTab}`;

      // Mobile tab bar (hidden on desktop via CSS)
      const mobileTabBar = createMobileTabBar(mobileTab, (tab) => {
        state.writerLayout.mobileTab = tab;
        render();
      });
      split.prepend(mobileTabBar);

      const chatCol = document.createElement("div");
      chatCol.className = "wm-live-chat-col";
      main.append(scrollRegion);
      chatCol.append(main);

      const writerCol = document.createElement("div");
      writerCol.className = "wm-webview-col";

      const writerResult = createWriterPanel(sessionId, effectiveFile, { showToast });
      activeWriterCleanup = writerResult.cleanup;

      const toolbar = createWriterToolbar(
        state.writerLayout.mode,
        (newMode) => {
          state.writerLayout.mode = newMode;
          render();
        },
        () => {
          markWriterDismissed(state, sessionId, effectiveFile);
          state.writerLayout.open = false;
          render();
        },
      );
      const pinnedPager = createPinnedArtifactPager(sessionId, pinnedFilePage);
      if (pinnedPager) {
        toolbar.append(pinnedPager);
      }
      writerCol.append(toolbar);
      writerCol.append(writerResult.panel);

      split.append(chatCol, writerCol);
      wrapper.append(split);

      const writerComposerEl = renderComposer(sessionId);
      chatCol.append(writerComposerEl);
      requestAnimationFrame(() => {
        const splitScroll = chatCol.querySelector('.wm-live-scroll');
        scrollPill.attachScrollPill(writerComposerEl, splitScroll || scrollRegion);
      });

      // Swipe gestures for mobile
      attachSwipeGesture(split, {
        onSwipeLeft: () => {
          if (state.writerLayout.mobileTab !== "writer") {
            state.writerLayout.mobileTab = "writer";
            render();
          }
        },
        onSwipeRight: () => {
          if (state.writerLayout.mobileTab !== "chat") {
            state.writerLayout.mobileTab = "chat";
            render();
          }
        },
      });
    } else if (state.artifactsLayout.open) {
      appRoot.dataset.webviewOpen = "true";

      const artMobileTab = state.artifactsLayout.mobileTab || "chat";
      const split = document.createElement("div");
      split.className = `wm-live-split wm-live-split--${state.artifactsLayout.mode} wm-live-split--mobile-${artMobileTab}`;

      // Mobile tab bar (hidden on desktop via CSS)
      const artMobileTabBar = createMobileTabBar(artMobileTab, (tab) => {
        state.artifactsLayout.mobileTab = tab;
        render();
      }, [
        { key: "chat", label: "Chat" },
        { key: "app", label: "App" },
      ]);
      split.prepend(artMobileTabBar);

      const chatCol = document.createElement("div");
      chatCol.className = "wm-live-chat-col";
      main.append(scrollRegion);
      chatCol.append(main);

      const artifactsCol = document.createElement("div");
      artifactsCol.className = "wm-webview-col";

      const artToolbar = createArtifactsToolbar(
        state.artifactsLayout.mode,
        (newMode) => {
          state.artifactsLayout.mode = newMode;
          render();
        },
        () => {
          state.artifactsLayout.open = false;
          render();
        },
      );
      artifactsCol.append(artToolbar);

      const cachedArtifacts = state._sessionArtifacts || [];
      const artResult = createArtifactsPanel(sessionId, cachedArtifacts);
      artifactsCol.append(artResult.panel);

      // Refresh artifacts after a short delay in case the fetch is still in flight
      setTimeout(() => artResult.refresh(), 500);

      split.append(chatCol, artifactsCol);
      wrapper.append(split);

      const artComposerEl = renderComposer(sessionId);
      chatCol.append(artComposerEl);
      // In split mode, the scroll target is .wm-live-scroll inside chatCol
      requestAnimationFrame(() => {
        const splitScroll = chatCol.querySelector('.wm-live-scroll');
        scrollPill.attachScrollPill(artComposerEl, splitScroll || scrollRegion);
      });

      // Swipe gestures for mobile
      attachSwipeGesture(split, {
        onSwipeLeft: () => {
          if (state.artifactsLayout.mobileTab !== "app") {
            state.artifactsLayout.mobileTab = "app";
            render();
          }
        },
        onSwipeRight: () => {
          if (state.artifactsLayout.mobileTab !== "chat") {
            state.artifactsLayout.mobileTab = "chat";
            render();
          }
        },
      });
    } else if (matchingApp && state.appCardLayout.open) {
      appRoot.dataset.webviewOpen = "true";

      const appMobileTab = state.appCardLayout.mobileTab || "chat";
      const split = document.createElement("div");
      split.className = `wm-live-split wm-live-split--${state.appCardLayout.mode} wm-live-split--mobile-${appMobileTab}`;

      const appMobileTabBar = createMobileTabBar(
        appMobileTab,
        (tab) => {
          state.appCardLayout.mobileTab = tab;
          render();
        },
        [
          { key: "chat", label: "Chat" },
          { key: "app", label: "App" },
        ],
      );
      split.prepend(appMobileTabBar);

      const chatCol = document.createElement("div");
      chatCol.className = "wm-live-chat-col";
      main.append(scrollRegion);
      chatCol.append(main);

      const appCol = document.createElement("div");
      appCol.className = "wm-webview-col";

      const appToolbar = createAppControlsToolbar(
        state.appCardLayout.mode,
        (newMode) => {
          state.appCardLayout.mode = newMode;
          render();
        },
        () => {
          state.appCardLayout.open = false;
          render();
        },
      );
      appCol.append(appToolbar);

      const appPanel = createAppControlsPanel(matchingApp, {
        renderAppCard,
      });
      appCol.append(appPanel);

      split.append(chatCol, appCol);
      wrapper.append(split);

      const appComposerEl = renderComposer(sessionId);
      chatCol.append(appComposerEl);
      requestAnimationFrame(() => {
        const splitScroll = chatCol.querySelector(".wm-live-scroll");
        scrollPill.attachScrollPill(appComposerEl, splitScroll || scrollRegion);
      });

      attachSwipeGesture(split, {
        onSwipeLeft: () => {
          if (state.appCardLayout.mobileTab !== "app") {
            state.appCardLayout.mobileTab = "app";
            render();
          }
        },
        onSwipeRight: () => {
          if (state.appCardLayout.mobileTab !== "chat") {
            state.appCardLayout.mobileTab = "chat";
            render();
          }
        },
      });
    } else if (webApp && state.webviewLayout.open) {
      appRoot.dataset.webviewOpen = "true";

      const webMobileTab = state.webviewLayout.mobileTab || "chat";
      const split = document.createElement("div");
      split.className = `wm-live-split wm-live-split--${state.webviewLayout.mode} wm-live-split--mobile-${webMobileTab}`;

      // Mobile tab bar (hidden on desktop via CSS)
      const webMobileTabBar = createMobileTabBar(webMobileTab, (tab) => {
        state.webviewLayout.mobileTab = tab;
        render();
      }, [
        { key: "chat", label: "Chat" },
        { key: "app", label: "App" },
      ]);
      split.prepend(webMobileTabBar);

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

      const webComposerEl = renderComposer(sessionId);
      chatCol.append(webComposerEl);
      requestAnimationFrame(() => {
        const splitScroll = chatCol.querySelector('.wm-live-scroll');
        scrollPill.attachScrollPill(webComposerEl, splitScroll || scrollRegion);
      });

      // Swipe gestures for mobile
      attachSwipeGesture(split, {
        onSwipeLeft: () => {
          if (state.webviewLayout.mobileTab !== "app") {
            state.webviewLayout.mobileTab = "app";
            render();
          }
        },
        onSwipeRight: () => {
          if (state.webviewLayout.mobileTab !== "chat") {
            state.webviewLayout.mobileTab = "chat";
            render();
          }
        },
      });
    } else {
      delete appRoot.dataset.webviewOpen;
      const drawer = createLiveSessionDrawer({
        session: activeSession,
        state,
        showToast,
        render,
        viewportWidth: window.innerWidth,
      });
      main.append(scrollRegion);
      const composerEl = renderComposer(sessionId);
      wrapper.append(main, composerEl);
      if (drawer.visible && drawer.backdrop) {
        wrapper.append(drawer.backdrop);
      }
      if (drawer.visible) {
        wrapper.append(drawer.aside);
      }
      if (drawer.modal) {
        wrapper.append(drawer.modal);
      }
      // Attach scroll pill to the composer — scrollTarget is the document for non-split
      requestAnimationFrame(() => {
        const docScroll = document.scrollingElement || document.documentElement || document.body;
        scrollPill.attachScrollPill(composerEl, docScroll);
      });
    }

    return wrapper;
  };

  // ── Focus snapshot utilities ────────────────────────────────────

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

  return {
    renderSessionTabs,
    renderTabs,
    renderLiveTabsBarContent,
    renderLive,
    updateLivePanelsForSession,
    captureFocusSnapshot,
    restoreFocusFromSnapshot,
  };
}
