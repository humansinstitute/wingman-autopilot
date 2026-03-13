const MOBILE_WIDTH_PX = 820;
const KEYBOARD_DELTA_THRESHOLD_PX = 120;

let initialized = false;
let animationFrameId = null;

function getViewportHeight() {
  const visualViewportHeight = window.visualViewport?.height;
  if (typeof visualViewportHeight === "number" && Number.isFinite(visualViewportHeight) && visualViewportHeight > 0) {
    return visualViewportHeight;
  }
  return window.innerHeight;
}

function isCoarsePointerDevice() {
  if (!window.matchMedia) {
    return window.innerWidth <= MOBILE_WIDTH_PX;
  }
  try {
    return window.matchMedia("(pointer: coarse)").matches || window.matchMedia(`(max-width: ${MOBILE_WIDTH_PX}px)`).matches;
  } catch {
    return window.innerWidth <= MOBILE_WIDTH_PX;
  }
}

function detectKeyboardOpen() {
  if (!isCoarsePointerDevice()) {
    return false;
  }
  const visualViewportHeight = window.visualViewport?.height;
  if (typeof visualViewportHeight !== "number" || !Number.isFinite(visualViewportHeight)) {
    return false;
  }
  return window.innerHeight - visualViewportHeight > KEYBOARD_DELTA_THRESHOLD_PX;
}

function applyViewportState() {
  animationFrameId = null;
  const root = document.documentElement;
  const body = document.body;
  if (!root || !body) {
    return;
  }

  root.style.setProperty("--wm-viewport-height", `${Math.round(getViewportHeight())}px`);
  body.dataset.keyboardOpen = detectKeyboardOpen() ? "true" : "false";
}

function scheduleViewportStateSync() {
  if (animationFrameId !== null) {
    return;
  }
  animationFrameId = requestAnimationFrame(applyViewportState);
}

export function initLiveMobileRuntime() {
  if (initialized) {
    applyViewportState();
    return;
  }

  initialized = true;
  applyViewportState();

  const visualViewport = window.visualViewport;
  window.addEventListener("resize", scheduleViewportStateSync, { passive: true });
  window.addEventListener("orientationchange", scheduleViewportStateSync, { passive: true });
  if (visualViewport) {
    visualViewport.addEventListener("resize", scheduleViewportStateSync, { passive: true });
    visualViewport.addEventListener("scroll", scheduleViewportStateSync, { passive: true });
  }
  document.addEventListener("focusin", scheduleViewportStateSync, true);
  document.addEventListener("focusout", scheduleViewportStateSync, true);
}

export function isMobileViewport() {
  return isCoarsePointerDevice();
}

export function isMobileKeyboardOpen() {
  return document.body?.dataset.keyboardOpen === "true";
}

export function isComposerInteractionActive() {
  const activeElement = document.activeElement;
  return activeElement instanceof HTMLTextAreaElement && Boolean(activeElement.closest(".wm-composer"));
}

export function shouldAutoFocusComposer(reason = "mount") {
  if (!isMobileViewport()) {
    return true;
  }
  return reason === "send" || reason === "queue";
}

export function focusComposerTextarea(textarea, reason = "mount") {
  if (!(textarea instanceof HTMLTextAreaElement) || !document.contains(textarea)) {
    return;
  }
  if (!shouldAutoFocusComposer(reason)) {
    return;
  }
  requestAnimationFrame(() => {
    if (!document.contains(textarea)) {
      return;
    }
    textarea.focus({ preventScroll: true });
  });
}
