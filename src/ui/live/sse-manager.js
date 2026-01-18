/**
 * SSE Manager for live session events.
 * Manages EventSource connections with automatic reconnection.
 */

import { MessageStore, SessionStore } from "./db.js";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/**
 * Manages SSE connections to session event streams.
 */
class SSEManager {
  constructor() {
    /** @type {Map<string, EventSource>} Active connections by sessionId */
    this.connections = new Map();
    /** @type {Map<string, number>} Reconnect timers by sessionId */
    this.reconnectTimers = new Map();
    /** @type {Map<string, number>} Reconnect attempt counts by sessionId */
    this.reconnectAttempts = new Map();
    /** @type {Set<Function>} Status change listeners */
    this.statusListeners = new Set();
    /** @type {Set<Function>} Message listeners */
    this.messageListeners = new Set();
    /** @type {Set<Function>} Connection state listeners */
    this.connectionListeners = new Set();
  }

  /**
   * Connect to a session's event stream.
   * @param {string} sessionId
   */
  connect(sessionId) {
    // Already connected
    if (this.connections.has(sessionId)) {
      const existing = this.connections.get(sessionId);
      if (existing.readyState !== EventSource.CLOSED) {
        return;
      }
    }

    // Clear any pending reconnect
    this.clearReconnectTimer(sessionId);

    const url = `/api/sessions/${sessionId}/events`;

    try {
      const source = new EventSource(url, { withCredentials: true });

      source.onopen = () => {
        console.log(`[sse] Connected to session ${sessionId}`);
        this.reconnectAttempts.set(sessionId, 0);
        this.notifyConnectionListeners(sessionId, "connected");
      };

      source.onerror = (event) => {
        console.warn(`[sse] Connection error for session ${sessionId}`, event);
        this.handleConnectionError(sessionId);
      };

      // Handle generic message events (default event type)
      source.onmessage = async (event) => {
        try {
          console.log(`[sse] Received event for ${sessionId}:`, event.data?.slice(0, 100));
          const data = JSON.parse(event.data);
          await this.handleEventData(sessionId, data);
        } catch (err) {
          console.warn("[sse] Failed to process message:", err);
        }
      };

      // Handle typed events from AgentAPI
      source.addEventListener("message", async (event) => {
        try {
          console.log(`[sse] message event for ${sessionId}:`, event.data?.slice(0, 100));
          const data = JSON.parse(event.data);
          if (data.type === "message" || data.role) {
            await MessageStore.upsertMessage(sessionId, data);
            this.notifyMessageListeners(sessionId, data);
          }
        } catch (err) {
          console.warn("[sse] Failed to process message event:", err);
        }
      });

      source.addEventListener("status", async (event) => {
        try {
          const data = JSON.parse(event.data);
          const status = data.status || data.agent_status || "stable";
          await SessionStore.updateStatus(sessionId, status, status);
          this.notifyStatusListeners(sessionId, status);
        } catch (err) {
          console.warn("[sse] Failed to process status event:", err);
        }
      });

      source.addEventListener("error", async (event) => {
        try {
          const data = JSON.parse(event.data);
          console.error(`[sse] Error event for session ${sessionId}:`, data);
        } catch {
          // Ignore parse errors for error events
        }
      });

      this.connections.set(sessionId, source);
    } catch (error) {
      console.error(`[sse] Failed to create EventSource for ${sessionId}:`, error);
      this.scheduleReconnect(sessionId);
    }
  }

  /**
   * Handle event data from SSE stream.
   * @param {string} sessionId
   * @param {Object} data
   */
  async handleEventData(sessionId, data) {
    // Handle message events
    if (data.type === "message" || data.role || data.content) {
      await MessageStore.upsertMessage(sessionId, data);
      this.notifyMessageListeners(sessionId, data);
    }

    // Handle status events
    if (data.status || data.agent_status) {
      const status = data.status || data.agent_status;
      await SessionStore.updateStatus(sessionId, status, status);
      this.notifyStatusListeners(sessionId, status);
    }
  }

  /**
   * Disconnect from a session's event stream.
   * @param {string} sessionId
   */
  disconnect(sessionId) {
    const source = this.connections.get(sessionId);
    if (source) {
      source.close();
      this.connections.delete(sessionId);
      this.notifyConnectionListeners(sessionId, "disconnected");
    }
    this.clearReconnectTimer(sessionId);
    this.reconnectAttempts.delete(sessionId);
  }

  /**
   * Disconnect all active connections.
   */
  disconnectAll() {
    for (const sessionId of this.connections.keys()) {
      this.disconnect(sessionId);
    }
  }

  /**
   * Handle connection error - disconnect and schedule reconnect.
   * @param {string} sessionId
   */
  handleConnectionError(sessionId) {
    const source = this.connections.get(sessionId);
    if (source) {
      source.close();
      this.connections.delete(sessionId);
    }
    this.notifyConnectionListeners(sessionId, "error");
    this.scheduleReconnect(sessionId);
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   * @param {string} sessionId
   */
  scheduleReconnect(sessionId) {
    const attempts = this.reconnectAttempts.get(sessionId) || 0;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempts), RECONNECT_MAX_MS);

    console.log(`[sse] Scheduling reconnect for ${sessionId} in ${delay}ms (attempt ${attempts + 1})`);

    const timerId = window.setTimeout(() => {
      this.reconnectTimers.delete(sessionId);
      this.reconnectAttempts.set(sessionId, attempts + 1);
      this.connect(sessionId);
    }, delay);

    this.reconnectTimers.set(sessionId, timerId);
  }

  /**
   * Clear any pending reconnect timer.
   * @param {string} sessionId
   */
  clearReconnectTimer(sessionId) {
    const timerId = this.reconnectTimers.get(sessionId);
    if (timerId) {
      window.clearTimeout(timerId);
      this.reconnectTimers.delete(sessionId);
    }
  }

  /**
   * Check if connected to a session.
   * @param {string} sessionId
   * @returns {boolean}
   */
  isConnected(sessionId) {
    const source = this.connections.get(sessionId);
    return source && source.readyState === EventSource.OPEN;
  }

  /**
   * Get connection state for a session.
   * @param {string} sessionId
   * @returns {"connected" | "connecting" | "disconnected"}
   */
  getConnectionState(sessionId) {
    const source = this.connections.get(sessionId);
    if (!source) return "disconnected";
    switch (source.readyState) {
      case EventSource.CONNECTING:
        return "connecting";
      case EventSource.OPEN:
        return "connected";
      default:
        return "disconnected";
    }
  }

  /**
   * Subscribe to status changes.
   * @param {Function} callback - Called with (sessionId, status)
   * @returns {Function} Unsubscribe function
   */
  onStatusChange(callback) {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  /**
   * Subscribe to message events.
   * @param {Function} callback - Called with (sessionId, message)
   * @returns {Function} Unsubscribe function
   */
  onMessage(callback) {
    this.messageListeners.add(callback);
    return () => this.messageListeners.delete(callback);
  }

  /**
   * Subscribe to connection state changes.
   * @param {Function} callback - Called with (sessionId, state)
   * @returns {Function} Unsubscribe function
   */
  onConnectionChange(callback) {
    this.connectionListeners.add(callback);
    return () => this.connectionListeners.delete(callback);
  }

  /**
   * Notify status listeners.
   * @param {string} sessionId
   * @param {string} status
   */
  notifyStatusListeners(sessionId, status) {
    for (const listener of this.statusListeners) {
      try {
        listener(sessionId, status);
      } catch (err) {
        console.warn("[sse] Status listener error:", err);
      }
    }
  }

  /**
   * Notify message listeners.
   * @param {string} sessionId
   * @param {Object} message
   */
  notifyMessageListeners(sessionId, message) {
    for (const listener of this.messageListeners) {
      try {
        listener(sessionId, message);
      } catch (err) {
        console.warn("[sse] Message listener error:", err);
      }
    }
  }

  /**
   * Notify connection listeners.
   * @param {string} sessionId
   * @param {string} state
   */
  notifyConnectionListeners(sessionId, state) {
    for (const listener of this.connectionListeners) {
      try {
        listener(sessionId, state);
      } catch (err) {
        console.warn("[sse] Connection listener error:", err);
      }
    }
  }
}

// Export singleton instance
export const sseManager = new SSEManager();
