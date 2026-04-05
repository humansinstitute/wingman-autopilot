/**
 * Markdown and code-block rendering utilities.
 *
 * Depends on escapeHtml / escapeAttribute / sanitizeLanguageClass from core/icons.js.
 */

import { escapeHtml, escapeAttribute, sanitizeLanguageClass } from "../core/icons.js";

function normaliseMarkdownForDisplay(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\\(!\[[^\]]*\]\([^)]+\))/g, "$1");
}

function rewriteUploadedAssetUrl(value) {
  if (value === null || value === undefined) return "";
  const trimmed = String(value).trim();
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

function sanitizeLinkHref(value) {
  const rewritten = rewriteUploadedAssetUrl(value);
  if (!rewritten) return "#";
  const trimmed = String(rewritten).trim();
  if (!trimmed || /\s/.test(trimmed)) return "#";
  const explicitlyAllowed = /^(https?:\/\/|mailto:|tel:|\/|\.{1,2}\/|#)/i.test(trimmed);
  if (explicitlyAllowed) {
    return escapeAttribute(trimmed);
  }
  if (trimmed.includes(":")) return "#";
  return escapeAttribute(trimmed);
}

const sanitizeImageSrc = (value) => {
  const rewritten = rewriteUploadedAssetUrl(value);
  if (!rewritten) return "#";
  const trimmed = String(rewritten).trim();
  if (!trimmed || /\s/.test(trimmed)) return "#";
  const explicitlyAllowed = /^(https?:\/\/|\/|\.{1,2}\/|#)/i.test(trimmed);
  if (explicitlyAllowed) {
    return escapeHtml(trimmed).replace(/"/g, "&quot;");
  }
  // Relative paths are allowed, but block arbitrary URI schemes like javascript:
  if (trimmed.includes(":")) return "#";
  return escapeHtml(trimmed).replace(/"/g, "&quot;");
};

export const renderInlineMarkdown = (text) => {
  if (!text) return "";
  let working = normaliseMarkdownForDisplay(text);
  const placeholders = [];
  const createPlaceholder = (html) => {
    const token = `@@MD${placeholders.length}@@`;
    placeholders.push(html);
    return token;
  };

  working = working.replace(/`([^`]+)`/g, (_, code) =>
    createPlaceholder(`<code>${escapeHtml(code)}</code>`),
  );

  working = working.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
    const safeUrl = sanitizeImageSrc(url);
    const safeHref = sanitizeLinkHref(url);
    const safeAlt = escapeHtml(alt).replace(/"/g, "&quot;");
    const imageHtml = `<img class="wm-inline-image" src="${safeUrl}" alt="${safeAlt}" loading="lazy" />`;
    if (safeHref === "#") {
      return createPlaceholder(imageHtml);
    }
    return createPlaceholder(
      `<a class="wm-inline-image-link" href="${safeHref}" target="_blank" rel="noopener noreferrer" aria-label="Open image">${imageHtml}</a>`,
    );
  });

  working = working.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const safeLabel = escapeHtml(label);
    const safeUrl = sanitizeLinkHref(url);
    if (safeUrl === "#") {
      return createPlaceholder(safeLabel);
    }
    return createPlaceholder(
      `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`,
    );
  });

  working = working.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, (_, __, content) =>
    createPlaceholder(`<strong>${renderInlineMarkdown(content)}</strong>`),
  );

  working = working.replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, (_, __, content) =>
    createPlaceholder(`<em>${renderInlineMarkdown(content)}</em>`),
  );

  working = working.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, (_, content) =>
    createPlaceholder(`<del>${renderInlineMarkdown(content)}</del>`),
  );

  const escaped = escapeHtml(working);
  return escaped.replace(/@@MD(\d+)@@/g, (_, index) => placeholders[Number(index)] ?? "");
};

/** Detect a GFM table separator row: |---|---|  or  |:---:|---:|  etc. */
const TABLE_SEP_RE = /^\|?[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)+\|?\s*$/;

/** Split a pipe-table row into cell strings. */
function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((c) => c.trim());
}

/** Parse alignment from a separator row. Returns array of 'left'|'center'|'right'. */
function parseTableAlignments(sepLine) {
  return splitTableRow(sepLine).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

export const renderMarkdownToHtml = (markdown) => {
  if (!markdown) return "";
  const lines = normaliseMarkdownForDisplay(markdown).replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let inCodeBlock = false;
  let codeLanguage = "";
  let codeBuffer = [];
  let listStack = [];
  let paragraph = "";
  let inBlockquote = false;

  const closeParagraph = () => {
    if (paragraph) {
      html += `<p>${paragraph.trim()}</p>`;
      paragraph = "";
    }
  };

  const renderListNode = (node) => `<${node.type}>${node.items.join("")}</${node.type}>`;

  const appendNestedListToParent = (parentNode, nestedHtml) => {
    if (parentNode.items.length === 0) {
      parentNode.items.push(`<li>${nestedHtml}</li>`);
      return;
    }
    const lastIndex = parentNode.items.length - 1;
    parentNode.items[lastIndex] = parentNode.items[lastIndex].replace(/<\/li>$/, `${nestedHtml}</li>`);
  };

  const closeListToLevel = (targetLevel = 0) => {
    while (listStack.length > targetLevel) {
      const node = listStack.pop();
      if (!node) break;
      const rendered = renderListNode(node);
      const parentNode = listStack[listStack.length - 1];
      if (parentNode) {
        appendNestedListToParent(parentNode, rendered);
      } else {
        html += rendered;
      }
    }
  };

  const closeList = () => {
    closeListToLevel(0);
  };

  const getIndentWidth = (raw) => {
    let width = 0;
    for (const ch of raw) {
      if (ch === " ") width += 1;
      else if (ch === "\t") width += 4;
      else break;
    }
    return width;
  };

  const getListLevel = (rawLine) => {
    // Treat every 3 leading spaces as one nesting level.
    return Math.floor(getIndentWidth(rawLine) / 3) + 1;
  };

  const addListItem = (type, rawLine, content) => {
    let level = getListLevel(rawLine);
    if (level > listStack.length + 1) {
      level = listStack.length + 1;
    }

    if (listStack.length > level) {
      closeListToLevel(level);
    }

    if (listStack.length === level) {
      const current = listStack[level - 1];
      if (current && current.type !== type) {
        closeListToLevel(level - 1);
      }
    }

    while (listStack.length < level) {
      const parent = listStack[listStack.length - 1];
      if (parent && parent.items.length === 0) {
        parent.items.push("<li></li>");
      }
      listStack.push({ type, items: [] });
    }

    const current = listStack[level - 1];
    if (current.type !== type) {
      closeListToLevel(level - 1);
      while (listStack.length < level) {
        const parent = listStack[listStack.length - 1];
        if (parent && parent.items.length === 0) {
          parent.items.push("<li></li>");
        }
        listStack.push({ type, items: [] });
      }
    }

    const target = listStack[level - 1];
    target.items.push(`<li>${content}</li>`);
  };

  const closeBlockquote = () => {
    if (inBlockquote) {
      html += "</blockquote>";
      inBlockquote = false;
    }
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    const line = rawLine.replace(/\s+$/, "");
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        const languageClass = sanitizeLanguageClass(codeLanguage);
        const classAttr = languageClass ? ` class="language-${languageClass}"` : "";
        html += `<pre><code${classAttr}>${escapeHtml(codeBuffer.join("\n"))}\n</code></pre>`;
        inCodeBlock = false;
        codeLanguage = "";
        codeBuffer = [];
      } else {
        closeParagraph();
        closeList();
        closeBlockquote();
        inCodeBlock = true;
        codeLanguage = line.slice(3).trim();
        codeBuffer = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(rawLine);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      closeParagraph();
      closeList();
      closeBlockquote();
      continue;
    }

    if (trimmed.startsWith(">")) {
      closeParagraph();
      closeList();
      if (!inBlockquote) {
        inBlockquote = true;
        html += "<blockquote>";
      }
      const quote = trimmed.replace(/^>\s?/, "");
      html += `<p>${renderInlineMarkdown(quote)}</p>`;
      continue;
    }

    if (inBlockquote) {
      closeBlockquote();
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      closeParagraph();
      closeList();
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      html += `<h${level}>${renderInlineMarkdown(text)}</h${level}>`;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeParagraph();
      closeList();
      html += "<hr />";
      continue;
    }

    // GFM table: header row followed by separator row
    if (
      trimmed.includes("|") &&
      idx + 1 < lines.length &&
      TABLE_SEP_RE.test(lines[idx + 1].trim())
    ) {
      closeParagraph();
      closeList();
      closeBlockquote();
      const headerCells = splitTableRow(trimmed);
      const alignments = parseTableAlignments(lines[idx + 1]);
      idx++; // skip separator

      const alignAttr = (i) => {
        const a = alignments[i];
        return a && a !== "left" ? ` style="text-align:${a}"` : "";
      };

      let tableHtml = "<table><thead><tr>";
      headerCells.forEach((cell, i) => {
        tableHtml += `<th${alignAttr(i)}>${renderInlineMarkdown(cell)}</th>`;
      });
      tableHtml += "</tr></thead><tbody>";

      // Consume body rows
      while (idx + 1 < lines.length) {
        const nextLine = lines[idx + 1].trim();
        if (!nextLine || !nextLine.includes("|")) break;
        idx++;
        const bodyCells = splitTableRow(nextLine);
        tableHtml += "<tr>";
        headerCells.forEach((_, i) => {
          const cellContent = i < bodyCells.length ? bodyCells[i] : "";
          tableHtml += `<td${alignAttr(i)}>${renderInlineMarkdown(cellContent)}</td>`;
        });
        tableHtml += "</tr>";
      }

      tableHtml += "</tbody></table>";
      html += tableHtml;
      continue;
    }

    const orderedMatch = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (orderedMatch) {
      closeParagraph();
      const content = renderInlineMarkdown(orderedMatch[2]);
      addListItem("ol", rawLine, content);
      continue;
    }

    const unorderedMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      closeParagraph();
      const content = renderInlineMarkdown(unorderedMatch[1]);
      addListItem("ul", rawLine, content);
      continue;
    }

    closeList();
    if (paragraph) {
      paragraph += ` ${renderInlineMarkdown(trimmed)}`;
    } else {
      paragraph = renderInlineMarkdown(trimmed);
    }
  }

  if (inCodeBlock) {
    const languageClass = sanitizeLanguageClass(codeLanguage);
    const classAttr = languageClass ? ` class="language-${languageClass}"` : "";
    html += `<pre><code${classAttr}>${escapeHtml(codeBuffer.join("\n"))}\n</code></pre>`;
  }
  closeParagraph();
  closeList();
  closeBlockquote();
  return html.trim();
};

const CODE_KEYWORDS = {
  javascript: [
    "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
    "else", "export", "extends", "finally", "for", "from", "function", "if", "import", "in", "instanceof",
    "let", "new", "return", "super", "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with", "yield", "await",
  ],
  typescript: [
    "abstract", "any", "as", "asserts", "async", "await", "boolean", "break", "case", "catch", "class", "const",
    "constructor", "continue", "declare", "default", "delete", "do", "else", "enum", "export", "extends", "false",
    "finally", "for", "from", "function", "get", "if", "implements", "import", "in", "infer", "instanceof", "interface",
    "is", "keyof", "let", "module", "namespace", "never", "new", "null", "number", "object", "package", "private", "protected",
    "public", "readonly", "require", "return", "set", "static", "string", "super", "switch", "symbol", "this", "throw", "true",
    "try", "type", "typeof", "undefined", "unique", "unknown", "var", "void", "while", "with", "yield",
  ],
  go: [
    "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go",
    "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
  ],
  json: ["true", "false", "null"],
  yaml: ["true", "false", "null", "yes", "no", "on", "off"],
  toml: ["true", "false"],
  ini: ["true", "false"],
  rust: [
    "as", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let",
    "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait",
    "true", "type", "unsafe", "use", "where", "while",
  ],
  python: [
    "and", "as", "assert", "break", "class", "continue", "def", "del", "elif", "else", "except", "False", "finally", "for",
    "from", "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return",
    "True", "try", "while", "with", "yield",
  ],
  shell: [
    "if", "then", "else", "elif", "fi", "for", "while", "in", "do", "done", "case", "esac", "function", "select",
  ],
  css: ["@import", "@media", "@supports", "@keyframes", "from", "to"],
  html: ["doctype", "html", "head", "body", "div", "span", "script", "style", "link", "meta", "title"],
  plaintext: [],
};

export const buildKeywordPattern = (keywords) => {
  if (!keywords || keywords.length === 0) return null;
  const escaped = keywords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "g");
};

const CODE_KEYWORD_PATTERNS = Object.fromEntries(
  Object.entries(CODE_KEYWORDS).map(([language, keywords]) => [language, buildKeywordPattern(keywords)]),
);

export const renderCodeToHtml = (content, language = "plaintext") => {
  const normalizedLanguage = CODE_KEYWORDS[language] ? language : "plaintext";
  const escaped = escapeHtml(content ?? "");
  const replacements = [];
  const createToken = (html) => {
    const token = `__WM_TOKEN_${replacements.length}__`;
    replacements.push({ token, html });
    return token;
  };

  let working = escaped;

  if (normalizedLanguage === "json") {
    working = working.replace(/(&quot;[^&]*?&quot;)(?=\s*:)/g, (match) =>
      createToken(`<span class="token key">${match}</span>`),
    );
  } else if (normalizedLanguage === "yaml" || normalizedLanguage === "toml" || normalizedLanguage === "ini") {
    working = working.replace(/^(\s*)([^\s:#][^:]*)(?=\s*:)/gm, (full, indent, key) => {
      return `${indent}${createToken(`<span class="token key">${key}</span>`)}`;
    });
  }

  if (
    normalizedLanguage === "javascript" ||
    normalizedLanguage === "typescript" ||
    normalizedLanguage === "go" ||
    normalizedLanguage === "rust"
  ) {
    working = working.replace(/(\/\/[^\n]*)/g, (match) => createToken(`<span class="token comment">${match}</span>`));
    working = working.replace(/(\/\*[\s\S]*?\*\/)/g, (match) =>
      createToken(`<span class="token comment">${match}</span>`),
    );
  }

  if (
    normalizedLanguage === "python" ||
    normalizedLanguage === "shell" ||
    normalizedLanguage === "yaml" ||
    normalizedLanguage === "toml" ||
    normalizedLanguage === "ini"
  ) {
    working = working.replace(/(^|\s)(#[^\n]*)/gm, (full, prefix, comment) => {
      return `${prefix}${createToken(`<span class="token comment">${comment}</span>`)}`;
    });
  }

  working = working.replace(/(&quot;.*?&quot;)/g, (match) => createToken(`<span class="token string">${match}</span>`));
  working = working.replace(/(&#39;.*?&#39;)/g, (match) => createToken(`<span class="token string">${match}</span>`));
  working = working.replace(/`[^`]*`/g, (match) => createToken(`<span class="token string">${match}</span>`));

  working = working.replace(/\b(0x[a-fA-F0-9]+|\d+\.\d+|\d+)\b/g, '<span class="token number">$1</span>');

  const keywordPattern = CODE_KEYWORD_PATTERNS[normalizedLanguage];
  if (keywordPattern) {
    working = working.replace(keywordPattern, '<span class="token keyword">$1</span>');
  }

  replacements.forEach(({ token, html }) => {
    working = working.replaceAll(token, html);
  });

  return `<pre><code class="language-${normalizedLanguage}">${working}</code></pre>`;
};
