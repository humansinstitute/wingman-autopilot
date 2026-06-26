import { escapeHtml, escapeAttribute } from "../core/icons.js";
import { collapseNewlines } from "../utils/text.js";
import { cleanAgentOutputText } from "./agent-output-format.js";

const IMAGE_MARKDOWN_LINE_RE = /^\s*\\?!\[([^\]]*)\]\\?\(([^)\s]+)\)\s*$/;
const IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)(?:[?#].*)?$/i;

function rewriteUploadedAssetUrl(url) {
  if (url === null || url === undefined) return "";
  const trimmed = String(url).trim();
  if (!trimmed) return "";
  if (!/^file:\/\//i.test(trimmed)) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "file:") {
      return trimmed;
    }
    const decodedPath = decodeURIComponent(parsed.pathname);
    const uploadMatch = decodedPath.match(/(?:^|\/)tmp\/uploads\/(images|files)\/(.+)$/);
    if (!uploadMatch) {
      return trimmed;
    }
    return `/uploads/${uploadMatch[1]}/${encodeURI(uploadMatch[2])}`;
  } catch {
    return trimmed;
  }
}

function sanitizeDisplayUrl(url) {
  const rewritten = rewriteUploadedAssetUrl(url);
  if (!rewritten) return null;
  const trimmed = String(rewritten).trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const explicitlyAllowed = /^(https?:\/\/|\/|\.{1,2}\/|#)/i.test(trimmed);
  if (explicitlyAllowed) {
    return escapeAttribute(trimmed);
  }
  if (trimmed.includes(":")) return null;
  return escapeAttribute(trimmed);
}

function isImageUrl(url) {
  if (!url) return false;
  const rewritten = rewriteUploadedAssetUrl(url);
  return /^\/uploads\/images\//i.test(rewritten) || IMAGE_EXTENSION_RE.test(rewritten);
}

function buildImageHtml(alt, url) {
  const safeUrl = sanitizeDisplayUrl(url);
  if (!safeUrl || !isImageUrl(url)) {
    return null;
  }
  const safeAlt = escapeHtml(alt || "uploaded image").replace(/"/g, "&quot;");
  return `<a class="wm-inline-image-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer" aria-label="Open ${safeAlt} preview" data-testid="inline-image-preview-link"><img class="wm-inline-image" src="${safeUrl}" alt="${safeAlt}" loading="lazy" /></a>`;
}

export function renderChatMessageHtml(content, options = {}) {
  const text = options.cleanAgentText
    ? cleanAgentOutputText(content)
    : String(content ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const parts = [];
  const textBuffer = [];

  const flushText = () => {
    if (textBuffer.length === 0) {
      return;
    }
    const block = collapseNewlines(textBuffer.join("\n"));
    parts.push(`<pre class="wm-message-plain">${escapeHtml(block)}</pre>`);
    textBuffer.length = 0;
  };

  for (const line of lines) {
    const match = line.match(IMAGE_MARKDOWN_LINE_RE);
    if (!match) {
      textBuffer.push(line);
      continue;
    }
    const imageHtml = buildImageHtml(match[1], match[2]);
    if (!imageHtml) {
      textBuffer.push(line);
      continue;
    }
    flushText();
    parts.push(imageHtml);
  }

  flushText();

  if (parts.length === 0) {
    return `<pre class="wm-message-plain"></pre>`;
  }

  return parts.join("");
}

export function renderWorkingNotesHtml(content, options = {}) {
  const body = renderChatMessageHtml(content, options);
  return [
    '<details class="wm-message-working-notes" data-testid="message-working-notes" data-working-notes-panel>',
    '<summary aria-label="Toggle working notes" data-testid="message-working-notes-summary">Working notes</summary>',
    `<div class="wm-message-working-notes__body">${body}</div>`,
    '</details>',
  ].join("");
}
