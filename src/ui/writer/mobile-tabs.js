/**
 * Mobile tab bar and swipe gesture support for the writer split view.
 * On screens <= 768px, shows a tab bar to switch between Chat and Writer
 * panels, plus swipe left/right gesture support.
 */

const SWIPE_THRESHOLD = 50; // min px for a swipe

/**
 * Create the mobile tab bar element.
 * @param {string} activeTab - 'chat' or 'writer'
 * @param {(tab: string) => void} onSwitch
 * @returns {HTMLElement}
 */
export function createMobileTabBar(activeTab, onSwitch) {
  const bar = document.createElement("div");
  bar.className = "wm-writer-mobile-tabs";

  const chatBtn = document.createElement("button");
  chatBtn.className = `wm-writer-mobile-tab${activeTab === "chat" ? " active" : ""}`;
  chatBtn.textContent = "Chat";
  chatBtn.addEventListener("click", () => onSwitch("chat"));

  const writerBtn = document.createElement("button");
  writerBtn.className = `wm-writer-mobile-tab${activeTab === "writer" ? " active" : ""}`;
  writerBtn.textContent = "Writer";
  writerBtn.addEventListener("click", () => onSwitch("writer"));

  bar.append(chatBtn, writerBtn);
  return bar;
}

/**
 * Attach horizontal swipe detection to an element.
 * Calls onSwipeLeft / onSwipeRight when a qualifying swipe is detected.
 * @param {HTMLElement} el
 * @param {{ onSwipeLeft: () => void, onSwipeRight: () => void }} handlers
 * @returns {() => void} cleanup function
 */
export function attachSwipeGesture(el, { onSwipeLeft, onSwipeRight }) {
  let startX = 0;
  let startY = 0;
  let tracking = false;

  function onTouchStart(e) {
    const touch = e.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    tracking = true;
  }

  function onTouchEnd(e) {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    // Only fire if horizontal movement dominates vertical
    if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) onSwipeLeft();
      else onSwipeRight();
    }
  }

  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchend", onTouchEnd, { passive: true });

  return () => {
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchend", onTouchEnd);
  };
}
