/**
 * Alpine.js reactive chat component for live session view.
 * Messages are read reactively from Dexie, with SSE as the steady-state write path.
 */

import Alpine from "/vendor/alpinejs/module.esm.js";
import Dexie from "/vendor/dexie/dexie.mjs";
import { sseManager } from "./sse-manager.js";
import { MessageStore, SessionStore } from "./db.js";
import { show as scrollPillShow, isNearBottom as scrollPillIsNearBottom } from "./scroll-pill.js";
import {
  getChatMessageHtmlCacheOptions,
  renderChatMessageHtml,
  renderWorkingNotesHtml,
} from "../rendering/chat-message-content.js";
import { state } from "../state/index.js";
import { getWorkingNotesPanelKey, getWorkingNotesPanelState } from "./working-notes-toggle.js";
import { AGENT_OUTPUT_FORMATTING_FLAG_KEY } from "../rendering/agent-output-format.js";
import { normalizeRuntimeStatus } from "./session-status-cache.js";
import { fetchSessionMessagesApi } from "../services/sessions.js";
import {
  LIVE_MESSAGE_WINDOW_DEFAULT,
  LIVE_MESSAGE_PAGE_SIZE,
  createWindowRecord,
  syncConversationWindow,
  expandConversationWindow,
  capturePrependedScrollState,
  schedulePrependedScrollRestore,
} from "./conversation-window.js";
import {
  autoReadLatestAssistantMessage,
  ensureLatestAssistantSpeech,
  getLatestAssistantSpeechKey,
  getMessageSpeechKey,
  isSessionAlwaysReadEnabled,
  isSessionSpeechGenerationEnabled,
  readMessageAloud,
  stopSpeechPlayback,
} from "./message-speech.js";

let featureEnabledResolver = () => false;

export function configureLiveChatFeatures({ isFeatureEnabled } = {}) {
  featureEnabledResolver = typeof isFeatureEnabled === "function" ? isFeatureEnabled : () => false;
}

function isAgentOutputFormattingEnabled() {
  return Boolean(featureEnabledResolver(AGENT_OUTPUT_FORMATTING_FLAG_KEY));
}

function shouldFormatAgentMessage(message) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  return role === "assistant" || role === "agent";
}

function isWorkingNotesMessage(message) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  return role === "agent-working";
}

function isReadableAgentMessage(message) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  const content = String(message?.content ?? message?.message ?? "").trim();
  return (role === "assistant" || role === "agent") && Boolean(content);
}

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
    _messageSubscription: null,
    _statusSubscription: null,
    _speechBaselineReady: false,
    _lastSpeechCandidateKey: "",
    speechPlaybackKey: "",

    init() {
      window.addEventListener("speech-playback-change", (event) => {
        this.speechPlaybackKey = event.detail?.key ?? "";
      });
    },

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
        this._subscribeToMessages(sessionId);
        this._subscribeToSessionStatus(sessionId);
        void this._syncMessagesFromServer(sessionId);

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
            const wasBusy = this.isBusy;
            this.status = status;
            if (wasBusy && !this.isBusy) {
              this._scheduleSpeechWork();
            }
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

    _subscribeToMessages(sessionId) {
      this._messageSubscription?.unsubscribe?.();
      this._messageSubscription = Dexie.liveQuery(() => MessageStore.getSessionMessages(sessionId))
        .subscribe({
          next: (messages) => {
            if (this.sessionId !== sessionId) {
              return;
            }
            this.replaceMessages(messages);
            this.isLoading = false;
          },
          error: (error) => {
            if (this.sessionId !== sessionId) {
              return;
            }
            console.error("[chat] Failed to read messages:", error);
            this.error = error instanceof Error ? error.message : String(error);
            this.isLoading = false;
          },
        });
    },

    _subscribeToSessionStatus(sessionId) {
      this._statusSubscription?.unsubscribe?.();
      this._statusSubscription = Dexie.liveQuery(SessionStore.liveQuery(sessionId))
        .subscribe({
          next: (session) => {
            if (this.sessionId !== sessionId) {
              return;
            }
            const wasBusy = this.isBusy;
            this.status = normalizeRuntimeStatus(session?.agentRuntimeStatus) ?? "stable";
            if (wasBusy && !this.isBusy) {
              this._scheduleSpeechWork();
            }
          },
          error: (error) => {
            if (this.sessionId !== sessionId) {
              return;
            }
            console.warn("[chat] Failed to read session status:", error);
          },
        });
    },

    async _syncMessagesFromServer(sessionId) {
      const payload = await fetchSessionMessagesApi(sessionId, { refresh: true }).catch(() => null);
      if (this.sessionId !== sessionId || !Array.isArray(payload?.messages)) {
        return;
      }
      await MessageStore.syncFromServerIfChanged(sessionId, payload.messages);
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
      this._scheduleSpeechWork();
    },

    appendMessage(message) {
      this.messages = [...this.messages, message];
      this._syncMessageWindow();
      this._scheduleSpeechWork();
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
      this._messageSubscription?.unsubscribe?.();
      this._messageSubscription = null;
      this._statusSubscription?.unsubscribe?.();
      this._statusSubscription = null;
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
      this._speechBaselineReady = false;
      this._lastSpeechCandidateKey = "";
    },

    renderMessageContent(message) {
      const cacheOptions = getChatMessageHtmlCacheOptions(message, { sessionId: this.sessionId });
      if (isWorkingNotesMessage(message)) {
        const workingNotesKey = getWorkingNotesPanelKey(this.sessionId, message);
        return renderWorkingNotesHtml(message?.content ?? "", {
          cleanAgentText: Boolean(isAgentOutputFormattingEnabled()),
          workingNotesKey,
          workingNotesOpen: getWorkingNotesPanelState(workingNotesKey) === true,
          config: state.config,
          ...cacheOptions,
        });
      }
      return renderChatMessageHtml(message?.content ?? "", {
        cleanAgentText: Boolean(isAgentOutputFormattingEnabled() && shouldFormatAgentMessage(message)),
        config: state.config,
        ...cacheOptions,
      });
    },

    getMessageClass(message) {
      const role = String(message?.role ?? message?.type ?? "assistant").toLowerCase();
      if (role === "user") return "user";
      if (role === "assistant" || role === "agent" || role === "agent-working") return "assistant";
      return "system";
    },

    getSpeechSummary(message) {
      return typeof message?.speech?.summary === "string" ? message.speech.summary.trim() : "";
    },

    canReadMessage(message) {
      return isReadableAgentMessage(message);
    },

    async playMessageSpeech(message, button) {
      if (!this.sessionId) return;
      if (this.isMessageSpeechPlaying(message)) {
        stopSpeechPlayback();
        return;
      }
      await readMessageAloud({
        sessionId: this.sessionId,
        message,
        button,
        showToast: (messageText, options = {}) => {
          const level = options.type === "error" ? "error" : "warn";
          console[level]("[chat] speech playback", messageText);
        },
      });
    },

    getMessageSpeechKey(message) {
      return this.sessionId ? getMessageSpeechKey(this.sessionId, message) : "";
    },

    isMessageSpeechPlaying(message) {
      const key = this.getMessageSpeechKey(message);
      return Boolean(key && key === this.speechPlaybackKey);
    },

    getMessageSpeechLabel(message) {
      if (this.isMessageSpeechPlaying(message)) {
        return "Stop spoken summary";
      }
      return message?.speech?.publicPath ? "Play spoken summary" : "Generate spoken summary";
    },

    _scheduleSpeechWork() {
      if (!this.sessionId || !Array.isArray(this.messages)) {
        return;
      }
      if (this.isBusy) {
        return;
      }
      const latestSpeechKey = getLatestAssistantSpeechKey(this.sessionId, this.messages);
      if (!this._speechBaselineReady) {
        this._speechBaselineReady = true;
        this._lastSpeechCandidateKey = latestSpeechKey;
        return;
      }
      if (this.messages.length === 0 || !latestSpeechKey || latestSpeechKey === this._lastSpeechCandidateKey) {
        return;
      }
      this._lastSpeechCandidateKey = latestSpeechKey;
      const session = window.Alpine?.store("sessions")?.items?.find?.((item) => item.id === this.sessionId) ?? null;
      if (!isSessionSpeechGenerationEnabled(session)) {
        return;
      }
      if (!isSessionAlwaysReadEnabled(session)) {
        void ensureLatestAssistantSpeech({
          sessionId: this.sessionId,
          session,
          conversation: this.messages,
          showToast: (messageText, options = {}) => {
            const level = options.type === "error" ? "error" : "warn";
            console[level]("[chat] speech generation", messageText);
          },
        });
        return;
      }
      void autoReadLatestAssistantMessage({
        sessionId: this.sessionId,
        session,
        conversation: this.messages,
        showToast: (messageText, options = {}) => {
          const level = options.type === "error" ? "error" : "warn";
          console[level]("[chat] auto speech", messageText);
        },
      });
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
               :data-role="(message.role || message.type || 'assistant').toLowerCase()"
               :class="$store.chat.getMessageClass(message)">
        <div class="wm-message-body" x-html="$store.chat.renderMessageContent(message)"></div>
        <template x-if="$store.chat.getSpeechSummary(message)">
          <p class="wm-message-speech-summary"
             data-testid="message-speech-summary"
             x-text="$store.chat.getSpeechSummary(message)">
          </p>
        </template>
        <div class="wm-message-actions">
          <template x-if="$store.chat.canReadMessage(message)">
            <button type="button"
                    class="wm-message-speech-play"
                    data-testid="message-speech-play"
                    :aria-label="$store.chat.getMessageSpeechLabel(message)"
                    :title="$store.chat.getMessageSpeechLabel(message)"
                    :data-playing="$store.chat.isMessageSpeechPlaying(message) ? 'true' : 'false'"
                    @click.stop="$store.chat.playMessageSpeech(message, $el)">
              <template x-if="!$store.chat.isMessageSpeechPlaying(message)">
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
              </template>
              <template x-if="$store.chat.isMessageSpeechPlaying(message)">
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M6 6h12v12H6z"/></svg>
              </template>
            </button>
          </template>
          <button type="button" class="wm-message-copy" data-testid="message-copy" aria-label="Copy message"
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
        </div>
      </article>
    </template>

    <!-- Empty state -->
    <template x-if="!$store.chat.isLoading && $store.chat.messages.length === 0">
      <div class="chat-empty">
        <span>Session ready. Send a message to begin.</span>
      </div>
    </template>
  </div>
</div>
`;
}

// Export Alpine for direct use if needed
export { Alpine };
