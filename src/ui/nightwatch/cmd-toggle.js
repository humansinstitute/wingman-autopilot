/**
 * Night Watch CMD Menu Toggle
 *
 * Adds a Night Watch on/off toggle to the session command menu.
 */

import { fetchNightWatchSessionState, enableNightWatch, disableNightWatch } from "./api.js";

export function addNightWatchToggle({ sessionId, addCommand, state, showToast, isFeatureEnabled }) {
  if (!isFeatureEnabled("nightwatch_enabled")) return;

  const toggleMap = state.nightwatch.sessionToggles;
  const cached = toggleMap.get(sessionId);
  const isOn = cached?.enabled ?? false;
  const label = isOn ? "Night Watch: ON" : "Night Watch: OFF";

  addCommand(label, async () => {
    try {
      if (isOn) {
        await disableNightWatch(sessionId);
        toggleMap.set(sessionId, { enabled: false });
        showToast("Night Watch disabled");
      } else {
        const result = await enableNightWatch(sessionId);
        toggleMap.set(sessionId, { enabled: true, ...result });
        showToast("Night Watch enabled");
      }
    } catch (err) {
      showToast(`Night Watch toggle failed: ${err.message}`, { type: "error" });
    }
  });

  // Lazy-load session state if not cached
  if (!toggleMap.has(sessionId)) {
    fetchNightWatchSessionState(sessionId)
      .then((data) => {
        toggleMap.set(sessionId, data);
      })
      .catch(() => {});
  }
}
