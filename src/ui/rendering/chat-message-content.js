import { escapeHtml } from "../core/icons.js";
import { cleanAgentOutputText } from "./agent-output-format.js";
import { renderMarkdownToHtml } from "./markdown.js";

export function renderChatMessageHtml(content, options = {}) {
  const text = options.cleanAgentText
    ? cleanAgentOutputText(content)
    : String(content ?? "").replace(/\r\n?/g, "\n");
  return renderMarkdownToHtml(text);
}

export function countWorkingNoteRows(content) {
  const text = String(content ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) {
    return 0;
  }
  const paragraphRows = text
    .split(/\n{2,}/)
    .map((row) => row.trim())
    .filter(Boolean);
  if (paragraphRows.length > 1) {
    return paragraphRows.length;
  }
  return text.split("\n").map((row) => row.trim()).filter(Boolean).length;
}

function formatWorkingNotesCount(count) {
  const safeCount = Math.max(1, count);
  const noun = safeCount === 1 ? "message" : "messages";
  const verb = safeCount === 1 ? "is" : "are";
  return {
    collapsed: `Show thinking ${safeCount} thinking ${noun} ${verb} collapsed`,
    expanded: `Hide thinking ${safeCount} thinking ${noun}`,
  };
}

export function renderWorkingNotesHtml(content, options = {}) {
  const body = renderChatMessageHtml(content, options);
  const labels = formatWorkingNotesCount(countWorkingNoteRows(content));
  const panelKey =
    typeof options.workingNotesKey === "string" && options.workingNotesKey.length > 0
      ? ` data-working-notes-key="${escapeHtml(options.workingNotesKey)}"`
      : "";
  const openAttribute = options.workingNotesOpen === true ? " open" : "";
  return [
    `<details class="wm-message-working-notes" data-testid="message-working-notes" data-working-notes-panel${panelKey}${openAttribute}>`,
    '<summary aria-label="Toggle working notes" data-testid="message-working-notes-summary">',
    `<span class="wm-message-working-notes__summary-collapsed">${escapeHtml(labels.collapsed)}</span>`,
    `<span class="wm-message-working-notes__summary-expanded">${escapeHtml(labels.expanded)}</span>`,
    '</summary>',
    `<div class="wm-message-working-notes__body">${body}</div>`,
    '</details>',
  ].join("");
}
