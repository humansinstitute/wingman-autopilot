/**
 * Live view renderer — session tabs, logs, conversation, composer, webview split,
 * archived session viewer, and focus snapshot utilities.
 *
 * Depends on: state, sessions store, navigation, session actions, image attachments (via DI).
 */

import { escapeHtml, getSessionDisplayName } from "../core/icons.js";
import { collapseNewlines } from "../utils/text.js";
import { attachCopyButton, copyConversationToClipboard } from "../utils/clipboard.js";
import { showToast } from "../utils/toast.js";
import { fetchSessionHistoryApi, forkSessionToWorktreeApi } from "../services/sessions.js";
import { triggerAppActionApi } from "../services/apps.js";
import { isAlpineChatEnabled, getChatTemplate } from "../live/index.js";
import { findAppForSession, findWebAppForSession, createWebviewPanel, createLayoutToolbar } from "../live/webview-panel.js";
import { createWriterPanel, createWriterToolbar } from "../writer/writer-panel.js";
import { createMobileTabBar, attachSwipeGesture } from "../writer/mobile-tabs.js";
import { fetchSessionArtifacts, createArtifactsPanel, createArtifactsToolbar } from "../live/artifacts-panel.js";
import { addNightWatchToggle } from "../nightwatch/cmd-toggle.js";
import { openFilePicker } from "../modals/file-picker.js";
import { npubProjectsState } from "../npub-projects/index.js";
import { state, TERMINAL_CONTROL_ACTIONS } from "../state/index.js";
import * as scrollPill from "../live/scroll-pill.js";

export function initLiveView(deps) {
  const {
    sessionsStore,
    appsStore,
    getCurrentRoute,
    setCurrentRoute,
    getTabsVisible,
    appRoot,
    render,
    // Session helpers
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
    // Stubs (late-bound)
    createAgentStatusIndicator,
    resolveAgentRuntimeStatus,
    extractImageFiles,
    extractAttachmentFiles,
    handleImageUploads,
    handleAttachmentUploads,
    cleanupOrphanedMarkers,
    clearImagePreviews,
    openDialog,
    isFeatureEnabledForViewer,
    showToast,
  } = deps;

  // Track active writer panel cleanup function
  let activeWriterCleanup = null;

  // ── Session tabs ────────────────────────────────────────────────

  const renderSessionTabs = (options = {}) => {
    const onSelect = typeof options.onSelect === "function" ? options.onSelect : null;
    const tabs = document.createElement("div");
    tabs.className = "wm-tabs menu";

    const activeSessions = getActiveSessions();
    activeSessions.forEach((session) => {
      const tab = document.createElement("div");
      tab.className = "wm-tab";
      const tabActiveId = sessionsStore().activeSessionId;
      if (session.id === tabActiveId) {
        tab.classList.add("active");
      }

      const displayName = getSessionDisplayName(session);
      const safeLabel = escapeHtml(displayName);
      tab.innerHTML = `
        <span>${safeLabel}</span>
        <span class="close" title="Stop session">\u00d7</span>
      `;
      tab.title = `${displayName} - ${session.agent}:${session.port}`;

      tab.addEventListener("click", () => {
        const wasLiveRoute = getCurrentRoute() === "live";
        const clickActiveId = sessionsStore().activeSessionId;
        if (clickActiveId === session.id && wasLiveRoute) {
          onSelect?.();
          return;
        }
        setCurrentRoute("live");
        setActiveSession(session.id, { updateHistory: true, forceLog: true });
        fetchLogs(session.id);
        fetchConversation(session.id);
        if (wasLiveRoute) {
          if (getTabsVisible()) {
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
      const menuTabActiveId = sessionsStore().activeSessionId;
      if (session.id === menuTabActiveId) {
        tab.classList.add("active");
      }

      const displayName = getSessionDisplayName(session);
      const safeLabel = escapeHtml(displayName);
      tab.innerHTML = `
        <span>${safeLabel}</span>
        <span class="close" title="Stop session">\u00d7</span>
      `;
      tab.title = `${displayName} - ${session.agent}:${session.port}`;

      tab.addEventListener("click", () => {
        const menuClickActiveId = sessionsStore().activeSessionId;
        if (menuClickActiveId === session.id && getCurrentRoute() === "live") {
          onSelect?.();
          return;
        }
        setCurrentRoute("live");
        setActiveSession(session.id, { updateHistory: true, forceLog: true });
        fetchLogs(session.id);
        fetchConversation(session.id);
        if (getTabsVisible()) {
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
        const body = document.createElement("pre");
        body.textContent = collapseNewlines(message.content ?? message.message ?? "");
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

    state.conversationContainers.set(sessionId, wrapper);
    state.lastMessageCount.set(sessionId, conversation.length);

    return wrapper;
  };

  // ── Composer ────────────────────────────────────────────────────

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
    });
    textarea.addEventListener("keydown", (event) => {
      if (textarea.value === "") {
        if (event.key === "Escape") {
          event.preventDefault();
          const escAction = TERMINAL_CONTROL_ACTIONS.find((a) => a.id === "terminal-esc");
          sendControlCommand(sessionId, escAction);
          return;
        }
        if (event.key === "Tab" && event.shiftKey) {
          event.preventDefault();
          const shiftTabAction = TERMINAL_CONTROL_ACTIONS.find((a) => a.id === "terminal-shift-tab");
          sendControlCommand(sessionId, shiftTabAction);
          return;
        }
      }
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
              newTextarea.focus({ preventScroll: true });
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
      const session = sessionsStore().items.find((s) => s.id === sessionId);
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
          const session = sessionsStore().items.find((s) => s.id === sessionId);
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
          if (!/^[a-zA-Z0-9._/-]+$/.test(trimmedBranch)) {
            showToast("Invalid branch name. Use alphanumeric characters, dots, underscores, and hyphens.", { type: "error" });
            return;
          }

          showToast(`Creating worktree "${trimmedBranch}"...`, { type: "info" });

          try {
            const result = await forkSessionToWorktreeApi(sessionId, trimmedBranch, 5);

            if (result.session?.id) {
              if (result.initialPrompt) {
                try {
                  localStorage.setItem(`session-draft-${result.session.id}`, result.initialPrompt);
                  localStorage.setItem(`session-autosubmit-${result.session.id}`, "true");
                } catch {
                  // Ignore localStorage errors
                }
              }

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

    // ---- Gitea submenu ----
    const executeGiteaAction = async (action, options = {}) => {
      try {
        const response = await fetch(`/api/gitea/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, ...options }),
        });
        const data = await response.json();
        if (!response.ok) {
          showToast(`Gitea ${action} failed: ${data.error || "Unknown error"}`, { type: "error", duration: 5000 });
          return null;
        }
        showToast(`Gitea ${action} successful`, { type: "success" });
        if (data.stdout) {
          console.log(`Gitea ${action} output:`, data.stdout);
        }
        return data;
      } catch (error) {
        showToast(`Gitea ${action} failed: ${error.message}`, { type: "error" });
        return null;
      }
    };

    addSubmenu("Gitea", [
      {
        label: "Go to repo",
        handler: async () => {
          try {
            const resp = await fetch(`/api/gitea/remote-url?sessionId=${sessionId}`);
            const data = await resp.json();
            if (!resp.ok || !data.configured) {
              showToast(data.error || "No Gitea remote configured — run Setup first", { type: "warning", duration: 4000 });
              return;
            }
            window.open(data.webUrl, "_blank");
          } catch (err) {
            showToast(`Failed to get repo URL: ${err.message}`, { type: "error" });
          }
        },
      },
      {
        label: "Setup",
        handler: async () => {
          const session = sessionsStore().items.find((s) => s.id === sessionId);
          const dirName = session?.workingDirectory?.split("/").pop() || "";
          const projectName = window.prompt("Project name for Gitea repo:", dirName);
          if (projectName === null) return; // cancelled
          showToast("Setting up Gitea repo...", { type: "info" });
          const data = await executeGiteaAction("set-remote", { projectName: projectName || undefined });
          if (data?.cloneUrl) {
            showToast(`Gitea repo ready: ${data.cloneUrl}`, { type: "success", duration: 5000 });
          }
        },
      },
      { label: "Push", handler: () => executeGiteaAction("push") },
      { label: "Pull", handler: () => executeGiteaAction("pull") },
      {
        label: "Commit and Push All",
        handler: () => {
          const message = window.prompt("Commit message:", "updates");
          if (message === null) return; // cancelled
          executeGiteaAction("commit-and-push", { message: message || "updates" });
        },
      },
    ]);

    const matchingApp = findAppForSession(sessionId, sessionsStore().items, appsStore().items, npubProjectsState);

    if (matchingApp) {
      const appItems = [];

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

    const cmdWebApp = findWebAppForSession(sessionId, sessionsStore().items, appsStore().items, npubProjectsState);
    if (cmdWebApp) {
      addCommand(state.webviewLayout.open ? "Close Web View" : "Open Web View", () => {
        state.webviewLayout.open = !state.webviewLayout.open;
        render();
      });
    }

    const hasPinnedFile = state.pinnedFiles.has(sessionId);
    addCommand(hasPinnedFile ? "Close Artifact" : "Open Artifact", () => {
      if (hasPinnedFile) {
        state.pinnedFiles.delete(sessionId);
        state.writerLayout.open = false;
        render();
      } else {
        const session = sessionsStore().items.find((s) => s.id === sessionId);
        const startPath = session?.workingDirectory || "";
        openFilePicker({ initialPath: startPath }).then((filePath) => {
          if (filePath) {
            state.pinnedFiles.set(sessionId, filePath);
            state.writerLayout.open = true;
            render();
          }
        });
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

    addCommandDivider();
    addSubmenu("Terminal", TERMINAL_CONTROL_ACTIONS.map((action) => ({
      label: action.label,
      handler: () => sendControlCommand(sessionId, action),
    })));

    addCommandDivider();
    addCommand("Stop Session", () => {
      const session = sessionsStore().items.find((s) => s.id === sessionId);
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

    const textareaWrapper = document.createElement("div");
    textareaWrapper.className = "wm-textarea-wrapper";
    const knightRider = document.createElement("div");
    knightRider.className = "wm-knight-rider";
    knightRider.dataset.sessionId = sessionId;
    textareaWrapper.append(knightRider, textarea);

    composer.append(fileInput, attachmentInput, textareaWrapper, buttonGroup);

    const statusIndicator = createAgentStatusIndicator(sessionId, { variant: "pill" });
    statusIndicator.classList.add("wm-agent-status-pill-button");
    buttonGroup.prepend(statusIndicator);

    composerShell.append(imagePreviewContainer, composer);

    resizeTextarea();

    requestAnimationFrame(() => {
      if (!document.contains(textarea)) return;
      textarea.focus({ preventScroll: true });
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
      const logSection = renderLogs(sessionId);
      scrollRegion.append(logSection);
      const conversationContainer = document.createElement("div");
      conversationContainer.className = "wm-live-conversation";
      if (isAlpineChatEnabled()) {
        conversationContainer.innerHTML = getChatTemplate().replace(
          "'${window.wingman?.activeSessionId || \"\"}'",
          `'${sessionId}'`
        );
        window.wingman = window.wingman || {};
        window.wingman.activeSessionId = sessionId;
      } else {
        conversationContainer.append(renderConversation(sessionId));
      }
      scrollRegion.append(conversationContainer);
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
        textarea.focus({ preventScroll: true });
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
      tabsBar.append(renderTabs());
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

    const liveActiveId = sessionsStore().activeSessionId;
    const liveSessions = sessionsStore().items;
    if (!liveActiveId || !liveSessions.some((session) => session.id === liveActiveId)) {
      ensureActiveSession();
    }

    const resolvedActiveId = sessionsStore().activeSessionId;
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

    if (isAlpineChatEnabled()) {
      conversationContainer.innerHTML = getChatTemplate().replace(
        "'${window.wingman?.activeSessionId || \"\"}'",
        `'${sessionId}'`
      );
      window.wingman = window.wingman || {};
      window.wingman.activeSessionId = sessionId;
    } else {
      conversationContainer.append(renderConversation(sessionId));
    }

    scrollRegion.append(conversationContainer);
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
    const activeSession = sessionsStore().items.find((s) => s.id === sessionId);
    const targetFile = activeSession?.targetFile ?? null;

    // Sync server-side pinnedFile into client state
    if (activeSession?.pinnedFile && !state.pinnedFiles.has(sessionId)) {
      state.pinnedFiles.set(sessionId, activeSession.pinnedFile);
    }

    // Pinned file takes priority over session targetFile
    const effectiveFile = state.pinnedFiles.get(sessionId) || targetFile;

    // Auto-open writer layout when session has an effective file
    if (effectiveFile && !state.writerLayout.open) {
      state.writerLayout.open = true;
    }

    const webApp = findWebAppForSession(sessionId, sessionsStore().items, appsStore().items, npubProjectsState);
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
          state.writerLayout.open = false;
          state.pinnedFiles.delete(sessionId);
          render();
        },
      );
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
      main.append(scrollRegion);
      wrapper.append(main);
      const composerEl = renderComposer(sessionId);
      wrapper.append(composerEl);
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
    renderLive,
    updateLivePanelsForSession,
    captureFocusSnapshot,
    restoreFocusFromSnapshot,
  };
}
