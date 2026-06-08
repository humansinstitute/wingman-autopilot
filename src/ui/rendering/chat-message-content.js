import { escapeHtml, escapeAttribute, sanitizeLanguageClass } from "../core/icons.js";
import { collapseNewlines } from "../utils/text.js";
import { cleanAgentOutputText } from "./agent-output-format.js";

const IMAGE_MARKDOWN_LINE_RE = /^\s*\\?!\[([^\]]*)\]\\?\(([^)\s]+)\)\s*$/;
const IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)(?:[?#].*)?$/i;
const CODE_FENCE_RE = /^\s*(```|~~~)\s*([A-Za-z0-9_+.#-]*)?.*$/;
const EDITED_DIFF_SUMMARY_RE = /^\s*(?:(?:[-*+]|\u2022)\s+)?Edited\s+.+\(\+\d+\s+-\d+\)\s*$/i;

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
  return `<a class="wm-inline-image-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer"><img class="wm-inline-image" src="${safeUrl}" alt="${safeAlt}" loading="lazy" /></a>`;
}

function normalizeCodeLanguage(language) {
  const sanitized = sanitizeLanguageClass(language);
  if (!sanitized) return "text";
  if (sanitized === "js") return "javascript";
  if (sanitized === "ts") return "typescript";
  if (sanitized === "sh" || sanitized === "bash" || sanitized === "zsh") return "shell";
  if (sanitized === "patch") return "diff";
  return sanitized;
}

function getCodeBlockLabel(language) {
  if (language === "text" || language === "plaintext") return "code";
  return language;
}

function isDiffHeaderLine(line) {
  return /^(diff --git|index\s+[0-9a-f]+\b|@@\s|---\s|\+\+\+\s|Index:\s)/.test(String(line).trim());
}

function isNumberedDiffLine(line) {
  return /^\s*\d+\s+[+-]/.test(String(line));
}

function isDiffMarkerLine(line) {
  const text = String(line);
  return /^[+-](?![+-]\s*$)/.test(text) || isNumberedDiffLine(text) || isDiffHeaderLine(text);
}

function isBareDiffStartMarker(line) {
  const text = String(line);
  return /^[+-](?![\s+-])/.test(text) || isNumberedDiffLine(text) || isDiffHeaderLine(text);
}

function startsBareDiffBlock(lines, index) {
  const line = lines[index] ?? "";
  if (EDITED_DIFF_SUMMARY_RE.test(line) || isDiffHeaderLine(line)) return true;

  let markerCount = 0;
  for (let offset = 0; offset < 5 && index + offset < lines.length; offset += 1) {
    if (isBareDiffStartMarker(lines[index + offset])) markerCount += 1;
  }
  return markerCount >= 2;
}

function shouldContinueBareDiffBlock(lines, index, sawMarker) {
  const line = lines[index] ?? "";
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (EDITED_DIFF_SUMMARY_RE.test(line) || isDiffMarkerLine(line)) return true;
  if (/^\s*(\d+|:)\s*$/.test(line)) return true;
  if (/^\s+\S/.test(line)) return true;
  return sawMarker && index > 0 && /^\s*[A-Za-z_$][\w$.-]*[\s:=({[]/.test(line);
}

function getDiffLineClass(line) {
  const text = String(line);
  const trimmed = text.trim();
  if (EDITED_DIFF_SUMMARY_RE.test(text) || isDiffHeaderLine(text)) return "wm-diff-line wm-diff-line-meta";
  if (/^\s*\d+\s+\+/.test(text) || /^\+(?!\+\+)/.test(text)) return "wm-diff-line wm-diff-line-add";
  if (/^\s*\d+\s+-/.test(text) || /^-(?!--)/.test(text)) return "wm-diff-line wm-diff-line-remove";
  if (/^@@/.test(trimmed)) return "wm-diff-line wm-diff-line-hunk";
  return "wm-diff-line";
}

function renderDiffCode(code) {
  return String(code ?? "")
    .split("\n")
    .map((line) => `<span class="${getDiffLineClass(line)}">${escapeHtml(line) || " "}</span>`)
    .join("\n");
}

function renderCodeBlockHtml(code, language = "text") {
  const normalizedLanguage = normalizeCodeLanguage(language);
  const label = escapeHtml(getCodeBlockLabel(normalizedLanguage));
  const codeClass = `language-${normalizedLanguage}`;
  const codeHtml = normalizedLanguage === "diff" ? renderDiffCode(code) : escapeHtml(code ?? "");
  return [
    `<figure class="wm-message-code-block wm-message-code-block-${normalizedLanguage}">`,
    `<figcaption class="wm-message-code-header">${label}</figcaption>`,
    `<pre class="wm-message-code"><code class="${codeClass}">${codeHtml}</code></pre>`,
    "</figure>",
  ].join("");
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

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(CODE_FENCE_RE);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const language = fenceMatch[2] ?? "";
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith(fence)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      flushText();
      parts.push(renderCodeBlockHtml(codeLines.join("\n"), language));
      continue;
    }

    const match = line.match(IMAGE_MARKDOWN_LINE_RE);
    if (!match) {
      if (startsBareDiffBlock(lines, index)) {
        const diffLines = [];
        let sawMarker = false;
        while (index < lines.length && shouldContinueBareDiffBlock(lines, index, sawMarker)) {
          sawMarker = sawMarker || isDiffMarkerLine(lines[index]);
          diffLines.push(lines[index]);
          index += 1;
        }
        if (index >= lines.length || lines[index].trim()) {
          index -= 1;
        }
        flushText();
        parts.push(renderCodeBlockHtml(diffLines.join("\n"), "diff"));
        continue;
      }
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
