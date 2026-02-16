/**
 * Alpine.js reactive chat component for live session view.
 * Uses Dexie liveQuery for real-time message updates from IndexedDB.
 */

import Alpine from "/vendor/alpinejs/module.esm.js";
import { Dexie, db, MessageStore, SessionStore } from "./db.js";
import { sseManager } from "./sse-manager.js";
import { show as scrollPillShow, isNearBottom as scrollPillIsNearBottom } from "./scroll-pill.js";

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
 * Format message content for display.
 * Handles markdown-like formatting and code blocks.
 * @param {string} content
 * @returns {string}
 */
function formatMessageContent(content) {
  if (!content) return "";
  // Escape HTML first
  let escaped = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Handle code blocks (triple backticks)
  escaped = escaped.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre class="code-block${lang ? ` language-${lang}` : ""}"><code>${code.trim()}</code></pre>`;
  });

  // Handle inline code (single backticks)
  escaped = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Handle bold (**text**)
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // Collapse multiple consecutive blank lines (3+ becomes 2 max for paragraph breaks)
  // Handles lines with only whitespace or whitespace + TUI box-drawing characters
  escaped = escaped.replace(/\n([ \t]*[┃│║]?[ \t]*\n){2,}/g, "\n\n");
  escaped = escaped.replace(/\n{3,}/g, "\n\n");

  // Handle newlines
  escaped = escaped.replace(/\n/g, "<br>");

  return escaped;
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
    status: "disconnected",
    connectionState: "disconnected",
    isLoading: false,
    error: null,
    _liveQuerySubscription: null,
    _sseUnsubscribers: [],

    /**
     * Initialize the chat store for a session.
     * @param {string} sessionId
     */
    async init(sessionId) {
      this.cleanup();
      this.sessionId = sessionId;
      this.isLoading = true;
      this.error = null;

      try {
        // Load initial messages from Dexie
        this.messages = await MessageStore.getSessionMessages(sessionId);

        // Set up live query for reactive updates
        this._setupLiveQuery(sessionId);

        // Subscribe to SSE events
        this._setupSSEListeners(sessionId);

        // Connect SSE
        sseManager.connect(sessionId);
        this.connectionState = sseManager.getConnectionState(sessionId);

        // Load session status
        const session = await SessionStore.getSession(sessionId);
        if (session) {
          this.status = session.agentRuntimeStatus || session.status || "stable";
        }

        this.isLoading = false;
        console.log("[chat] Initialized for session", sessionId, "with", this.messages.length, "messages");
      } catch (error) {
        console.error("[chat] Failed to initialize:", error);
        this.error = error.message;
        this.isLoading = false;
      }
    },

    /**
     * Set up Dexie liveQuery for reactive message updates.
     * @param {string} sessionId
     */
    _setupLiveQuery(sessionId) {
      // Use Dexie's liveQuery for reactive updates
      const observable = Dexie.liveQuery(() => MessageStore.getSessionMessages(sessionId));

      this._liveQuerySubscription = observable.subscribe({
        next: (messages) => {
          const prevCount = this.messages.length;
          this.messages = messages;
          if (messages.length > prevCount) {
            // New message arrived, trigger auto-scroll
            this._scheduleScroll();
          }
        },
        error: (error) => {
          console.error("[chat] LiveQuery error:", error);
        },
      });
    },

    /**
     * Set up SSE event listeners.
     * @param {string} sessionId
     */
    _setupSSEListeners(sessionId) {
      // Message events — update Alpine store immediately instead of
      // waiting for Dexie liveQuery (which can lag ~1-2s).
      this._sseUnsubscribers.push(
        sseManager.onMessage((sid, message) => {
          if (sid !== sessionId) return;
          const role = message.role || message.type || "assistant";
          const content = message.content || message.message || "";
          const now = new Date().toISOString();

          // Streaming: update last message in-place if same role and content extends
          const last = this.messages[this.messages.length - 1];
          if (last && last.role === role) {
            const oldContent = last.content || "";
            if (content.length > oldContent.length && content.startsWith(oldContent.slice(0, 50))) {
              // Mutate + reassign for Alpine reactivity
              last.content = content;
              last.updatedAt = now;
              this.messages = [...this.messages];
              return;
            }
          }

          // New message
          this.messages = [...this.messages, {
            sessionId,
            role,
            content,
            createdAt: message.createdAt || message.created_at || now,
            updatedAt: now,
            id: `sse-${Date.now()}`,
          }];
          this._scheduleScroll();
        })
      );

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

    /**
     * Clean up subscriptions and connections.
     */
    cleanup() {
      if (this._liveQuerySubscription) {
        this._liveQuerySubscription.unsubscribe();
        this._liveQuerySubscription = null;
      }
      this._sseUnsubscribers.forEach((unsub) => unsub());
      this._sseUnsubscribers = [];
      if (this.sessionId) {
        sseManager.disconnect(this.sessionId);
      }
      this.sessionId = null;
      this.messages = [];
      this.status = "disconnected";
      this.connectionState = "disconnected";
    },

    /**
     * Format a message for display.
     * @param {Object} message
     * @returns {Object}
     */
    formatMessage(message) {
      return {
        ...message,
        formattedContent: formatMessageContent(message.content),
        isUser: message.role === "user",
        isAssistant: message.role === "assistant" || message.role === "agent",
        isSystem: message.role === "system",
        time: message.createdAt ? new Date(message.createdAt).toLocaleTimeString() : "",
      };
    },

    /**
     * Check if agent is busy.
     * @returns {boolean}
     */
    get isBusy() {
      return this.status === "running";
    },

    /**
     * Get connection status label.
     * @returns {string}
     */
    get connectionLabel() {
      switch (this.connectionState) {
        case "connected":
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
<div x-data x-init="$store.chat.init('${sid}')"
     class="chat-container alpine-chat"
     @session-change.window="$store.chat.init($event.detail.sessionId)">

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
    <template x-for="message in $store.chat.messages" :key="message.id">
      <article class="wm-message"
               :class="message.role === 'user' ? 'user' : (message.role === 'assistant' || message.role === 'agent' ? 'assistant' : 'system')">
        <pre x-text="message.content"></pre>
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
