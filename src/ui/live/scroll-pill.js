/**
 * Floating "scroll to bottom" pill indicator.
 *
 * Shows a small pill above the composer when new content arrives and the user
 * is scrolled up. Clicking it smooth-scrolls to the bottom. The pill hides
 * automatically when the user scrolls to within 50px of the bottom.
 */

const THRESHOLD = 50;

let pillEl = null;
let scrollTarget = null;
let scrollListener = null;

/**
 * Create (or re-use) the floating pill and attach it to a parent container.
 * The parent should be position:relative so the pill can anchor itself.
 *
 * @param {HTMLElement} parent  - element to append the pill into (e.g. wrapper or composer-shell)
 * @param {HTMLElement} scrollElement - the scrollable element to watch & scroll
 */
export function attachScrollPill(parent, scrollElement) {
  cleanup();

  if (!parent || !scrollElement) return;

  scrollTarget = scrollElement;

  pillEl = document.createElement("button");
  pillEl.className = "wm-scroll-pill";
  pillEl.textContent = "scroll to bottom";
  pillEl.setAttribute("aria-label", "Scroll to bottom");
  pillEl.style.display = "none";

  pillEl.addEventListener("click", () => {
    if (!scrollTarget) return;
    scrollTarget.scrollTo({ top: scrollTarget.scrollHeight, behavior: "smooth" });
    // Also scroll the window for non-split layouts
    const docTarget = document.scrollingElement || document.documentElement || document.body;
    if (docTarget !== scrollTarget) {
      docTarget.scrollTo({ top: docTarget.scrollHeight, behavior: "smooth" });
    }
    hide();
  });

  parent.appendChild(pillEl);

  // Listen for scroll on the scroll region to auto-hide when user reaches bottom
  scrollListener = () => {
    if (!scrollTarget || !pillEl) return;
    const nearBottom = scrollTarget.scrollHeight - scrollTarget.scrollTop - scrollTarget.clientHeight < THRESHOLD;
    if (nearBottom) hide();
  };
  scrollTarget.addEventListener("scroll", scrollListener, { passive: true });
}

/** Show the pill (call when new content arrives and user is scrolled up). */
export function show() {
  if (pillEl) pillEl.style.display = "";
}

/** Hide the pill. */
export function hide() {
  if (pillEl) pillEl.style.display = "none";
}

/** Returns true if the scroll target is near the bottom. */
export function isNearBottom() {
  if (!scrollTarget) return true;
  return scrollTarget.scrollHeight - scrollTarget.scrollTop - scrollTarget.clientHeight < THRESHOLD;
}

/** Remove listeners and element. Call on view teardown. */
export function cleanup() {
  if (scrollTarget && scrollListener) {
    scrollTarget.removeEventListener("scroll", scrollListener);
  }
  if (pillEl && pillEl.parentNode) {
    pillEl.parentNode.removeChild(pillEl);
  }
  pillEl = null;
  scrollTarget = null;
  scrollListener = null;
}
