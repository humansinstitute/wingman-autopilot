/**
 * Text formatting utilities for UI content.
 */

/**
 * Collapse multiple consecutive newlines into a maximum of two.
 * This prevents large swathes of empty space from TUI-style agent output.
 * @param {string} text - The text to normalize
 * @returns {string} - Text with collapsed newlines
 */
export function collapseNewlines(text) {
  if (!text) return "";
  return text.replace(/\n{3,}/g, "\n\n");
}
