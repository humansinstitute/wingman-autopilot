/**
 * Alpine.js reactive chat component for live session view.
 * Messages are pushed to the store directly by app.js, with SSE as the steady-state path.
 */

import Alpine from "/vendor/alpinejs/module.esm.js";
import { sseManager } from "./sse-manager.js";
import { show as scrollPillShow, isNearBottom as scrollPillIsNearBottom } from "./scroll-pill.js";
import { renderChatMessageHtml } from "../rendering/chat-message-content.js";
import {
  LIVE_MESSAGE_WINDOW_DEFAULT,
  LIVE_MESSAGE_PAGE_SIZE,
  createWindowRecord,
  syncConversationWindow,
  expandConversationWindow,
  capturePrependedScrollState,
  schedulePrependedScrollRestore,
} from "./conversation-window.js";

/**
 * Check if Alpine chat is enabled via feature flag.
 * @returns {boolean}
 */
export function isAlpineChatEnabled() {
  try {
    // Enabled by default — set to "false" to disable
    const flag = localStorage.getItem("wingman-alpine-chat");
    return flag !== "false";
  } catch {
    return true;
  }
}

/**
 * Enable Alpine chat feature.
 */
export function enableAlpineChat() {
  try {
    localStorage.setItem("wingman-alpine-chat", "true");
  } catch {
    // Storage not available
  }
}

/**
 * Disable Alpine chat feature.
 */
export function disableAlpineChat() {
  try {
    localStorage.removeItem("wingman-alpine-chat");
  } catch {
    // Storage not available
  }
}

/**
 * Register the Alpine.js chat component.
 * Call this once during app initialization.
 */
export function registerChatComponent() {
  // Register the chat store
  Alpine.store("chat", {
    sessionId: null,
    messages: [],
    messageWindow: createWindowRecord(0, LIVE_MESSAGE_WINDOW_DEFAULT),
    status: "disconnected",
    connectionState: "disconnected",
    streamMode: "unknown",
    isLoading: false,
    error: null,
    _sseUnsubscribers: [],

    /** Alpine auto-calls init() on store registration — nothing to do yet. */
    init() {},

    /**
     * Load (or switch to) a session's chat.
     * @param {string} sessionId
     */
    async loadSession(sessionId) {
      if (!sessionId) return;
      // Already loaded for this session — don't wipe messages
      if (this.sessionId === sessionId) return;
      this.cleanup();
      this.sessionId = sessionId;
      this.messageWindow = createWindowRecord(0, LIVE_MESSAGE_WINDOW_DEFAULT);
      this.isLoading = true;
      this.error = null;

      try {
        // Subscribe to SSE status/connection events
        this._setupSSEListeners(sessionId);

        // Connect SSE
        sseManager.connect(sessionId);
        this.connectionState = sseManager.getConnectionState(sessionId);
        this.streamMode = typeof sseManager.getStreamMode === "function"
          ? sseManager.getStreamMode(sessionId)
          : "unknown";

        this.isLoading = false;
        console.log("[chat] Loaded session", sessionId);
      } catch (error) {
        console.error("[chat] Failed to initialize:", error);
        this.error = error.message;
        this.isLoading = false;
      }
    },

    /**
     * Set up SSE event listeners.
     * @param {string} sessionId
     */
    _setupSSEListeners(sessionId) {
      // Status changes
      this._sseUnsubscribers.push(
        sseManager.onStatusChange((sid, status) => {
          if (sid === sessionId) {
            this.status = status;
          }
        })
      );

      // Connection state changes
      this._sseUnsubscribers.push(
        sseManager.onConnectionChange((sid, state) => {
          if (sid === sessionId) {
            this.connectionState = state;
          }
        })
      );

      this._sseUnsubscribers.push(
        sseManager.onStreamModeChange((sid, mode) => {
          if (sid === sessionId) {
            this.streamMode = mode;
          }
        })
      );
    },

    /**
     * Show the scroll pill if user is scrolled up, otherwise do nothing
     * (the user is already at the bottom and will see new content naturally).
     */
    _scheduleScroll() {
      if (!scrollPillIsNearBottom()) {
        scrollPillShow();
      }
    },

    _syncMessageWindow() {
      this.messageWindow = syncConversationWindow(
        new Map([["active", this.messageWindow]]),
        "active",
        this.messages.length,
      );
    },

    replaceMessages(messages) {
      this.messages = Array.isArray(messages) ? messages : [];
      this._syncMessageWindow();
    },

    appendMessage(message) {
      this.messages = [...this.messages, message];
      this._syncMessageWindow();
    },

    revealOlderMessages(scrollElement) {
      const tempStore = new Map([["active", this.messageWindow]]);
      const snapshot = capturePrependedScrollState(scrollElement);
      this.messageWindow = expandConversationWindow(tempStore, "active", this.messages.length, LIVE_MESSAGE_PAGE_SIZE);
      schedulePrependedScrollRestore(snapshot);
    },

    /**
     * Clean up subscriptions and connections.
     */
    cleanup() {
      this._sseUnsubscribers.forEach((unsub) => unsub());
      this._sseUnsubscribers = [];
      if (this.sessionId) {
        sseManager.disconnect(this.sessionId);
      }
      this.sessionId = null;
      this.messages = [];
      this.messageWindow = createWindowRecord(0, LIVE_MESSAGE_WINDOW_DEFAULT);
      this.status = "disconnected";
      this.connectionState = "disconnected";
      this.streamMode = "unknown";
    },

    renderMessageContent(message) {
      return renderChatMessageHtml(message?.content ?? "");
    },

    /**
     * Check if agent is busy.
     * @returns {boolean}
     */
    get isBusy() {
      return this.status === "running";
    },

    get visibleMessages() {
      const visibleCount = Math.min(this.messages.length, this.messageWindow?.visibleCount ?? LIVE_MESSAGE_WINDOW_DEFAULT);
      if (visibleCount <= 0 || visibleCount >= this.messages.length) {
        return this.messages;
      }
      return this.messages.slice(-visibleCount);
    },

    get hiddenMessageCount() {
      const visibleCount = Math.min(this.messages.length, this.messageWindow?.visibleCount ?? LIVE_MESSAGE_WINDOW_DEFAULT);
      return Math.max(0, this.messages.length - visibleCount);
    },

    get revealOlderLabel() {
      const nextStep = Math.min(LIVE_MESSAGE_PAGE_SIZE, this.hiddenMessageCount);
      return `Show ${nextStep} older message${nextStep === 1 ? "" : "s"}`;
    },

    get windowSummary() {
      if (this.hiddenMessageCount <= 0) {
        return "";
      }
      const visibleCount = Math.min(this.messages.length, this.messageWindow?.visibleCount ?? LIVE_MESSAGE_WINDOW_DEFAULT);
      return `Showing the latest ${visibleCount} of ${this.messages.length} messages to keep long sessions responsive on mobile.`;
    },

    /**
     * Get connection status label.
     * @returns {string}
     */
    get connectionLabel() {
      switch (this.connectionState) {
        case "connected":
          if (this.streamMode === "heartbeat-only") {
            return "Heartbeat";
          }
          if (this.streamMode === "degraded") {
            return "Recovering";
          }
          return "Live";
        case "connecting":
          return "Connecting...";
        default:
          return "Disconnected";
      }
    },
  });

  // Register the chat message component
  Alpine.data("chatMessage", (message) => ({
    message,
    get formatted() {
      return Alpine.store("chat").formatMessage(this.message);
    },
  }));

  console.log("[chat] Alpine chat component registered");
}

/**
 * Initialize Alpine.js for the chat component.
 * Should be called once when the app starts.
 */
export function initAlpineChat() {
  if (!isAlpineChatEnabled()) {
    console.log("[chat] Alpine chat disabled by feature flag");
    return false;
  }

  // Register component before starting Alpine
  registerChatComponent();

  // Start Alpine if not already started
  if (!window.Alpine) {
    window.Alpine = Alpine;
    Alpine.start();
    console.log("[chat] Alpine.js started");
  }

  return true;
}

/**
 * Get the HTML template for the Alpine chat component.
 * This replaces the existing chat container when Alpine is enabled.
 * @param {string} sessionId - The session to initialize the chat for
 * @returns {string}
 */
export function getChatTemplate(sessionId) {
  const sid = sessionId || window.wingman?.activeSessionId || "";
  return `
<div x-data x-init="$store.chat.loadSession('${sid}')"
     class="chat-container alpine-chat"
     @session-change.window="$store.chat.loadSession($event.detail.sessionId)">

  <!-- Connection status indicator -->
  <div class="chat-status-bar" :class="{ 'connected': $store.chat.connectionState === 'connected', 'connecting': $store.chat.connectionState === 'connecting' }">
    <span class="status-dot" :class="$store.chat.connectionState"></span>
    <span x-text="$store.chat.connectionLabel"></span>
    <template x-if="$store.chat.isBusy">
      <span class="busy-indicator">Agent working...</span>
    </template>
  </div>

  <!-- Loading state -->
  <template x-if="$store.chat.isLoading">
    <div class="chat-loading">
      <span>Loading messages...</span>
    </div>
  </template>

  <!-- Error state -->
  <template x-if="$store.chat.error">
    <div class="chat-error">
      <span x-text="$store.chat.error"></span>
    </div>
  </template>

  <!-- Messages container -->
  <div x-ref="chatContainer" class="wm-conversation" :class="{ 'loading': $store.chat.isLoading }">
    <template x-if="$store.chat.hiddenMessageCount > 0">
      <div class="wm-conversation-window-notice">
        <button
          type="button"
          class="wm-conversation-window-button"
          data-testid="conversation-show-older"
          :aria-label="$store.chat.revealOlderLabel + ' in this session'"
          x-text="$store.chat.revealOlderLabel"
          @click="$store.chat.revealOlderMessages($el.closest('.wm-live-conversation'))">
        </button>
        <p class="wm-conversation-window-summary" x-text="$store.chat.windowSummary"></p>
      </div>
    </template>

    <template x-for="message in $store.chat.visibleMessages" :key="message.id">
      <article class="wm-message"
               :class="message.role === 'user' ? 'user' : (message.role === 'assistant' || message.role === 'agent' ? 'assistant' : 'system')">
        <div class="wm-message-body" x-html="$store.chat.renderMessageContent(message)"></div>
        <button type="button" class="wm-message-copy" aria-label="Copy message"
                @click.stop="
                  const text = message.content || '';
                  if (text && navigator.clipboard?.writeText) {
                    navigator.clipboard.writeText(text).then(() => {
                      $el.closest('.wm-message').dataset.copied = 'true';
                      setTimeout(() => { delete $el.closest('.wm-message').dataset.copied }, 1600);
                    });
                  }
                ">
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M15 3H7a2 2 0 0 0-2 2v10h2V5h8V3zm4 4h-8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zm0 12h-8V9h8v10z"/></svg>
        </button>
      </article>
    </template>

    <!-- Empty state -->
    <template x-if="!$store.chat.isLoading && $store.chat.messages.length === 0">
      <div class="chat-empty">
        <span>No messages yet</span>
      </div>
    </template>
  </div>
</div>
`;
}

// Export Alpine for direct use if needed
export { Alpine };
