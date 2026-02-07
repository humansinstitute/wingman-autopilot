/**
 * Markdown and code-block rendering utilities.
 *
 * Depends on escapeHtml / escapeAttribute / sanitizeLanguageClass from core/icons.js.
 */

import { escapeHtml, escapeAttribute, sanitizeLanguageClass } from "../core/icons.js";

export const renderInlineMarkdown = (text) => {
  if (!text) return "";
  let working = String(text);
  const placeholders = [];
  const createPlaceholder = (html) => {
    const token = `@@MD${placeholders.length}@@`;
    placeholders.push(html);
    return token;
  };

  working = working.replace(/`([^`]+)`/g, (_, code) =>
    createPlaceholder(`<code>${escapeHtml(code)}</code>`),
  );

  working = working.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const safeUrl = escapeAttribute(url);
    const safeLabel = escapeHtml(label);
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

export const renderMarkdownToHtml = (markdown) => {
  if (!markdown) return "";
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let inCodeBlock = false;
  let codeLanguage = "";
  let codeBuffer = [];
  let listType = null;
  let listItems = [];
  let paragraph = "";
  let inBlockquote = false;

  const closeParagraph = () => {
    if (paragraph) {
      html += `<p>${paragraph.trim()}</p>`;
      paragraph = "";
    }
  };

  const closeList = () => {
    if (listType && listItems.length > 0) {
      html += `<${listType}>${listItems.join("")}</${listType}>`;
    }
    listType = null;
    listItems = [];
  };

  const closeBlockquote = () => {
    if (inBlockquote) {
      html += "</blockquote>";
      inBlockquote = false;
    }
  };

  for (const rawLine of lines) {
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

    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (orderedMatch) {
      closeParagraph();
      const content = renderInlineMarkdown(orderedMatch[2]);
      if (listType !== "ol") {
        closeList();
        listType = "ol";
      }
      listItems.push(`<li>${content}</li>`);
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      closeParagraph();
      const content = renderInlineMarkdown(unorderedMatch[1]);
      if (listType !== "ul") {
        closeList();
        listType = "ul";
      }
      listItems.push(`<li>${content}</li>`);
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

