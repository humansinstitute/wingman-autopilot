/**
 * Agent status indicators, knight rider animation, conversation/log DOM updates.
 *
 * Depends on: state, queue helpers, clipboard/text utilities (via DI).
 */

import { collapseNewlines } from "../utils/text.js";
import { attachCopyButton } from "../utils/clipboard.js";

export function initAgentIndicators(deps) {
  const {
    state,
    sessionsStore,
    getCurrentRoute,
    getQueueCount,
    isSessionBusy,
    openPromptQueueModal,
  } = deps;

  let debounceTimer = null;

  // ── Status resolution ───────────────────────────────────────────

  const resolveAgentRuntimeStatus = (sessionId) => {
    const session = sessionsStore().items.find((entry) => entry && entry.id === sessionId);
    if (!session) {
      return null;
    }
    // Session is no longer running — ignore stale agentRuntimeStatus
    if (session.status === "stopped" || session.status === "error") {
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

  // ── Indicator DOM ───────────────────────────────────────────────

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

    indicator.style.cursor = "pointer";
    indicator.addEventListener("click", () => {
      openPromptQueueModal(sessionId);
    });

    applyAgentStatusIndicatorState(indicator, sessionId);
    return indicator;
  };

  // ── Batch update ────────────────────────────────────────────────

  const updateKnightRiderState = (targetSessionId) => {
    document.querySelectorAll(".wm-knight-rider").forEach((element) => {
      const sessionId = element.dataset.sessionId;
      if (targetSessionId && sessionId !== targetSessionId) return;
      const session = sessionsStore().items.find((s) => s.id === sessionId);
      const isBusy = isSessionBusy(session);
      element.classList.toggle("active", isBusy);
    });
  };

  const updateAgentStatusIndicators = () => {
    if (getCurrentRoute() === "home") {
      return;
    }

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      document.querySelectorAll(".wm-agent-status-indicator").forEach((indicator) => {
        const sessionId = indicator.getAttribute("data-session-id");
        if (sessionId) {
          applyAgentStatusIndicatorState(indicator, sessionId);
        }
      });
      updateKnightRiderState();
      debounceTimer = null;
    }, 100);
  };

  // ── Conversation DOM ────────────────────────────────────────────

  const updateConversationDOM = (sessionId) => {
    let container = state.conversationContainers.get(sessionId);

    if (!container || !document.contains(container)) {
      const conversationWrapper = document.querySelector('.wm-live-conversation .wm-conversation');
      if (conversationWrapper) {
        container = conversationWrapper;
        state.conversationContainers.set(sessionId, container);
        const existingMessages = container.querySelectorAll('.wm-message');
        existingMessages.forEach((node) => attachCopyButton(node));
        state.lastMessageCount.set(sessionId, existingMessages.length);
      } else {
        return;
      }
    }

    const conversation = state.conversations.get(sessionId) ?? [];
    const lastCount = state.lastMessageCount.get(sessionId) ?? 0;

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

  // ── Logs DOM ────────────────────────────────────────────────────

  const updateLogsDOM = (sessionId) => {
    let container = state.logContainers.get(sessionId);

    if (!container || !document.contains(container)) {
      const logViewer = document.querySelector('.wm-log-panel .log-viewer');
      if (logViewer) {
        container = logViewer;
        state.logContainers.set(sessionId, container);
        const currentLines = container.textContent.split('\n').filter(l => l.length > 0);
        state.lastLogLength.set(sessionId, currentLines.length);
      } else {
        return;
      }
    }

    const logs = state.logs.get(sessionId) ?? [];
    const lastLength = state.lastLogLength.get(sessionId) ?? 0;

    if (logs.length !== lastLength || logs.join("\n") !== container.textContent) {
      container.textContent = logs.join("\n");
      state.lastLogLength.set(sessionId, logs.length);
    }
  };

  return {
    resolveAgentRuntimeStatus,
    createAgentStatusIndicator,
    updateAgentStatusIndicators,
    updateKnightRiderState,
    updateConversationDOM,
    updateLogsDOM,
  };
}
