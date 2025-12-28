/**
 * Toast notification system for displaying transient messages.
 */

import { TOAST_DEFAULT_DURATION_MS } from "../state/index.js";

let toastContainer = null;

/**
 * Ensures the toast container exists in the DOM.
 * @returns {HTMLElement} The toast container element
 */
function ensureToastContainer() {
  if (toastContainer && document.body.contains(toastContainer)) {
    return toastContainer;
  }
  toastContainer = document.createElement("div");
  toastContainer.className = "wm-toast-container";
  document.body.append(toastContainer);
  return toastContainer;
}

/**
 * Displays a toast notification.
 * @param {string} message - The message to display
 * @param {Object} options - Configuration options
 * @param {string} [options.variant="info"] - Toast variant ("info" or "error")
 * @param {number} [options.duration] - Duration in ms before auto-dismiss
 */
export function showToast(message, options = {}) {
  if (!message) return;
  const variant = options.variant === "error" ? "error" : "info";
  const duration =
    typeof options.duration === "number" && Number.isFinite(options.duration) && options.duration > 0
      ? options.duration
      : TOAST_DEFAULT_DURATION_MS;
  const container = ensureToastContainer();
  const toast = document.createElement("div");
  toast.className = `wm-toast wm-toast--${variant}`;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.textContent = message;
  container.append(toast);
  requestAnimationFrame(() => {
    toast.classList.add("is-visible");
  });
  const removeToast = () => {
    toast.remove();
  };
  const scheduleRemoval = () => {
    toast.classList.remove("is-visible");
    toast.addEventListener("transitionend", removeToast, { once: true });
    setTimeout(removeToast, 400);
  };
  setTimeout(scheduleRemoval, duration);
}
