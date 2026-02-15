/**
 * Session Subscriber — SSE client for live session list updates.
 *
 * Connects to /api/sessions/subscribe and triggers a store sync
 * whenever a session is started, stopped, or updated so the home
 * page and navigation reflect changes without a manual reload.
 */

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;

let eventSource = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let onSessionEvent = null;

/**
 * Start listening for session lifecycle events.
 *
 * @param {Function} callback — called with the event payload on each
 *   session-started / session-stopped / session-updated event.
 */
export function startSessionSubscriber(callback) {
  onSessionEvent = callback;
  connect();
}

/** Stop the subscriber and clean up. */
export function stopSessionSubscriber() {
  onSessionEvent = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  reconnectAttempts = 0;
}

function connect() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  const source = new EventSource("/api/sessions/subscribe", { withCredentials: true });

  source.onopen = () => {
    console.log("[session-sub] Connected");
    reconnectAttempts = 0;
  };

  source.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (data.type && onSessionEvent) {
        onSessionEvent(data);
      }
    } catch {
      // ignore non-JSON (keepalive comments won't fire onmessage)
    }
  };

  source.onerror = () => {
    console.warn("[session-sub] Connection lost, scheduling reconnect");
    source.close();
    eventSource = null;
    scheduleReconnect();
  };

  eventSource = source;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (onSessionEvent) connect();
  }, delay);
}
