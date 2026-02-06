/**
 * Night Watch CMD Menu Toggle
 *
 * Adds a Night Watch on/off toggle to the session command menu.
 * The button text updates live after toggling and after the initial fetch.
 */

import { fetchNightWatchSessionState, enableNightWatch, disableNightWatch } from "./api.js";

function labelFor(enabled) {
  return enabled ? "Night Watch: ON" : "Night Watch: OFF";
}

export function addNightWatchToggle({ sessionId, addCommand, state, showToast, isFeatureEnabled }) {
  if (!isFeatureEnabled("nightwatch_enabled")) return;

  const toggleMap = state.nightwatch.sessionToggles;
  const cached = toggleMap.get(sessionId);
  const initiallyOn = cached?.enabled ?? false;

  const btn = addCommand(labelFor(initiallyOn), async () => {
    const currentlyOn = toggleMap.get(sessionId)?.enabled ?? false;
    try {
      if (currentlyOn) {
        await disableNightWatch(sessionId);
        toggleMap.set(sessionId, { enabled: false });
        btn.textContent = labelFor(false);
        showToast("Night Watch disabled");
      } else {
        const result = await enableNightWatch(sessionId);
        toggleMap.set(sessionId, { enabled: true, ...result });
        btn.textContent = labelFor(true);
        showToast("Night Watch enabled");
      }
    } catch (err) {
      showToast(`Night Watch toggle failed: ${err.message}`, { type: "error" });
    }
  });

  // Lazy-load session state if not cached, update button when resolved
  if (!toggleMap.has(sessionId)) {
    fetchNightWatchSessionState(sessionId)
      .then((data) => {
        toggleMap.set(sessionId, data);
        if (data.enabled) {
          btn.textContent = labelFor(true);
        }
      })
      .catch(() => {});
  }
}
