import "/ace-builds/src-noconflict/ace.js";
import "/ace-builds/src-noconflict/mode-text.js";
import "/ace-builds/src-noconflict/theme-chrome.js";
import "/ace-builds/src-noconflict/theme-tomorrow_night.js";

const ace = globalThis.ace;
if (!ace) {
  throw new Error("Ace editor failed to load");
}

const THEME_STORAGE_KEY = "wingman-theme";
const TABS_VISIBILITY_STORAGE_KEY = "wingman-tabs-visible";

const state = {
  config: null,
  sessions: [],
  orchestratorPresets: [],
  orchestratorPresetsLoading: false,
  orchestratorPresetsLoaded: false,
  orchestratorPresetsError: null,
  logs: new Map(),
  conversations: new Map(),
  messageDrafts: new Map(),
  logPanelOpen: new Map(),
  activeSessionId: null,
  lastWorkingDirectory: null,
  lastActiveSessionId: null,
  // DOM references for incremental updates
  conversationContainers: new Map(), // sessionId -> DOM element
  logContainers: new Map(), // sessionId -> DOM element
  lastMessageCount: new Map(), // sessionId -> number of messages
  lastLogLength: new Map(), // sessionId -> length of logs
  files: {
    initialized: false,
    loading: false,
    error: null,
    currentPath: null,
    relativePath: null,
    displayPath: "~",
    parent: null,
    entries: [],
    previewPath: null,
    previewRelativePath: null,
    previewDisplayPath: "",
    previewName: null,
    previewContent: null,
    previewLoading: false,
    previewError: null,
    previewFormat: null,
    previewLanguage: null,
    previewLabel: null,
    browserCollapsed: false,
    mobileView: "browser",
  },
  fileEditor: {
    open: false,
    loading: false,
    saving: false,
    error: null,
    saveError: null,
    path: null,
    relativePath: null,
    displayPath: null,
    name: null,
    base64: null,
    content: "",
    initialContent: "",
    mtimeMs: null,
    dirty: false,
    requestId: 0,
  },
};

const textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { fatal: false }) : null;
const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

const decodeBase64ToUint8Array = (value) => {
  if (!value) return new Uint8Array(0);
  try {
    const binary = atob(value);
    const length = binary.length;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
};

const encodeUint8ArrayToBase64 = (bytes) => {
  if (!bytes || bytes.length === 0) return "";
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const decodeBytesToText = (bytes) => {
  if (!bytes || bytes.length === 0) return "";
  if (textDecoder) {
    try {
      return textDecoder.decode(bytes);
    } catch {
      // fall through to manual decoding
    }
  }
  let result = "";
  for (let i = 0; i < bytes.length; i += 1) {
    result += String.fromCharCode(bytes[i]);
  }
  return result;
};

const encodeTextToBytes = (text) => {
  if (!text || text.length === 0) return new Uint8Array(0);
  if (textEncoder) {
    try {
      return textEncoder.encode(text);
    } catch {
      // fall through to manual encoding
    }
  }
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
};

let aceEditorInstance = null;

const getSessionDisplayName = (session) => {
  if (!session || typeof session !== "object") return "";
  const rawName = typeof session.name === "string" ? session.name.trim() : "";
  if (rawName.length > 0) return rawName;
  const agent = typeof session.agent === "string" ? session.agent : "agent";
  const port = typeof session.port === "number" ? session.port : "";
  return port ? `${agent} :${port}` : agent;
};

const scrollConversationToBottom = (element) => {
  if (!element) return;
  requestAnimationFrame(() => {
    if (element === document.body || element === document.documentElement || element === document.scrollingElement) {
      const target = document.scrollingElement || document.documentElement || document.body;
      window.scrollTo(0, target.scrollHeight);
      return;
    }
    element.scrollTop = element.scrollHeight;
  });
};

const getConversationScrollElement = (sessionId) => {
  const container = state.conversationContainers.get(sessionId);
  if (!container) return null;
  return container.closest('.wm-live-conversation');
};

const scrollConversationAreaToBottom = (sessionId, options = {}) => {
  const { includeWindow = false } = options;
  const target =
    getConversationScrollElement(sessionId) ??
    document.querySelector('.wm-live-conversation');
  if (target) {
    scrollConversationToBottom(target);
  }
  if (includeWindow) {
    const fallback = document.scrollingElement || document.documentElement || document.body;
    if (fallback && fallback !== target) {
      scrollConversationToBottom(fallback);
    }
  }
};

const isMobileFilesLayout = () => {
  if (window.matchMedia) {
    try {
      return window.matchMedia("(max-width: 720px)").matches;
    } catch {
      // fall through to manual check
    }
  }
  return window.innerWidth <= 720;
};

const copyTextToClipboard = async (text) => {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "absolute";
    fallback.style.left = "-9999px";
    document.body.append(fallback);
    fallback.select();
    const success = document.execCommand("copy");
    fallback.remove();
    return success;
  } catch (error) {
    console.error("Failed to copy to clipboard", error);
    return false;
  }
};

const attachCopyButton = (bubble) => {
  if (!bubble || bubble.dataset.copyAttached === "true") return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "wm-message-copy";
  button.setAttribute("aria-label", "Copy message");
  button.innerHTML =
    '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M15 3H7a2 2 0 0 0-2 2v10h2V5h8V3zm4 4h-8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zm0 12h-8V9h8v10z"/></svg>';
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const body = bubble.querySelector("pre");
    const text = body?.textContent ?? "";
    const copied = await copyTextToClipboard(text);
    if (copied) {
      bubble.dataset.copied = "true";
      setTimeout(() => {
        if (bubble.isConnected) {
          delete bubble.dataset.copied;
        }
      }, 1600);
    }
  });
  bubble.append(button);
  bubble.dataset.copyAttached = "true";
};

const copyConversationToClipboard = async (sessionId) => {
  const conversation = state.conversations.get(sessionId) ?? [];
  let textBlocks = conversation;
  if (textBlocks.length === 0) {
    const container = state.conversationContainers.get(sessionId);
    if (container) {
      const domMessages = container.querySelectorAll(".wm-message pre");
      textBlocks = Array.from(domMessages).map((node) => ({
        role: null,
        content: node.textContent ?? "",
      }));
    }
  }

  if (textBlocks.length === 0) return false;

  const formatted = textBlocks
    .map((message) => {
      const role = typeof message.role === "string" ? message.role : message.type;
      const labelSource = role ?? "assistant";
      const label = `${labelSource.charAt(0).toUpperCase()}${labelSource.slice(1)}`;
      const content = message.content ?? message.message ?? "";
      if (!content) return label;
      return `${label}:\n${content}`;
    })
    .join("\n\n")
    .trim();

  if (!formatted) return false;
  return copyTextToClipboard(formatted);
};

const escapeHtml = (value) => {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const escapeAttribute = (value) => {
  if (value === null || value === undefined) return "#";
  const trimmed = String(value).trim();
  const allowed = /^(https?:\/\/|\/|#|mailto:|tel:)/i;
  const safe = allowed.test(trimmed) ? trimmed : "#";
  return escapeHtml(safe).replace(/"/g, "&quot;");
};

const sanitizeLanguageClass = (value) => {
  if (!value) return "";
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "");
};

const renderInlineMarkdown = (text) => {
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

const renderMarkdownToHtml = (markdown) => {
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

const resetFilesPreview = () => {
  state.files.previewPath = null;
  state.files.previewRelativePath = null;
  state.files.previewDisplayPath = "";
  state.files.previewName = null;
  state.files.previewContent = null;
  state.files.previewLoading = false;
  state.files.previewError = null;
  state.files.previewFormat = null;
  state.files.previewLanguage = null;
  state.files.previewLabel = null;
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

const buildKeywordPattern = (keywords) => {
  if (!keywords || keywords.length === 0) return null;
  const escaped = keywords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "g");
};

const CODE_KEYWORD_PATTERNS = Object.fromEntries(
  Object.entries(CODE_KEYWORDS).map(([language, keywords]) => [language, buildKeywordPattern(keywords)]),
);

const renderCodeToHtml = (content, language = "plaintext") => {
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

const loadFilesTree = async (path) => {
  const files = state.files;
  const targetPath = typeof path === "string" && path.length > 0 ? path : files.currentPath;
  if (typeof path === "string" && path.length > 0 && path !== files.currentPath) {
    resetFilesPreview();
  }
  files.loading = true;
  files.error = null;

  try {
    const url = new URL("/api/docs/tree", window.location.origin);
    if (targetPath) {
      url.searchParams.set("path", targetPath);
    }
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      let message = response.statusText || "Failed to load directory";
      try {
        const payload = await response.json();
        if (payload && typeof payload.error === "string") {
          message = payload.error;
        }
      } catch {
        // ignore json parsing error
      }
      throw new Error(message);
    }

    const data = await response.json();
    files.currentPath = data?.path ?? targetPath ?? files.currentPath;
    files.relativePath = data?.relativePath ?? "";
    files.displayPath = data?.displayPath ?? (files.relativePath ? `~/${files.relativePath}` : "~");
    files.parent = data?.parent ?? null;
    files.entries = Array.isArray(data?.entries) ? data.entries : [];
    files.loading = false;
    files.error = null;

    if (files.previewPath) {
      const exists = files.entries.some((entry) => entry.path === files.previewPath);
      if (!exists) {
        resetFilesPreview();
      }
    }
  } catch (error) {
    files.loading = false;
    files.error = error instanceof Error ? error.message : String(error);
    files.entries = [];
    if (typeof path === "string" && path.length > 0) {
      files.currentPath = path;
    }
  } finally {
    if (currentRoute === "files") {
      render();
    }
  }
};

const loadFilesPreview = async (path) => {
  if (!path) return;
  const files = state.files;
  files.previewPath = path;
  files.previewRelativePath = "";
  files.previewDisplayPath = "";
  files.previewName = null;
  files.previewContent = null;
  files.previewError = null;
  files.previewLoading = true;
  files.previewFormat = null;
  files.previewLanguage = null;
  files.previewLabel = null;
  if (currentRoute === "files") {
    render();
  }

  try {
    const url = new URL("/api/docs/file", window.location.origin);
    url.searchParams.set("path", path);
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      let message = response.statusText || "Failed to load file";
      try {
        const payload = await response.json();
        if (payload && typeof payload.error === "string") {
          message = payload.error;
        }
      } catch {
        // ignore json parse error
      }
      throw new Error(message);
    }

    const data = await response.json();
    files.previewPath = data?.path ?? path;
    files.previewRelativePath = data?.relativePath ?? "";
    files.previewDisplayPath = data?.displayPath ?? (files.previewRelativePath ? `~/${files.previewRelativePath}` : "");
    files.previewName = data?.name ?? null;
    files.previewContent = data?.content ?? "";
    files.previewFormat = data?.format ?? null;
    files.previewLanguage = data?.language ?? null;
    files.previewLabel = data?.label ?? null;
    files.previewLoading = false;
    files.previewError = null;
  } catch (error) {
    files.previewLoading = false;
    files.previewError = error instanceof Error ? error.message : String(error);
    files.previewContent = null;
  } finally {
    if (currentRoute === "files") {
      render();
    }
  }
};

const createFilesDirectory = async (parentPath, name) => {
  const response = await fetch("/api/docs/directory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent: parentPath, name }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to create directory";
    throw new Error(message);
  }
  return response.json();
};

const createFilesTextFile = async (parentPath, name, content = "") => {
  const response = await fetch("/api/docs/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ directory: parentPath, name, content }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error ?? response.statusText ?? "Failed to create file";
    throw new Error(message);
  }
  return response.json();
};

const destroyAceEditor = () => {
  if (!aceEditorInstance) return;
  const container = aceEditorInstance.container;
  aceEditorInstance.destroy();
  if (container) {
    container.textContent = "";
  }
  aceEditorInstance = null;
};

const setFileEditorState = (updater) => {
  const editor = state.fileEditor;
  if (!editor) return;
  updater(editor);
};

const resetFileEditorState = () => {
  setFileEditorState((editor) => {
    editor.open = false;
    editor.loading = false;
    editor.saving = false;
    editor.error = null;
    editor.saveError = null;
    editor.path = null;
    editor.relativePath = null;
    editor.displayPath = null;
    editor.name = null;
    editor.base64 = null;
    editor.content = "";
    editor.initialContent = "";
    editor.mtimeMs = null;
    editor.dirty = false;
    editor.requestId += 1;
  });
  destroyAceEditor();
};

const closeFileEditor = () => {
  resetFileEditorState();
  render();
};

const requestFileEditorClose = () => {
  const editor = state.fileEditor;
  if (editor.saving) return;
  if (editor.dirty) {
    const confirmClose = window.confirm("Discard unsaved changes?");
    if (!confirmClose) {
      return;
    }
  }
  closeFileEditor();
};

const updateFileEditorControls = () => {
  const editor = state.fileEditor;
  const overlay = document.getElementById("wm-file-editor-overlay");
  if (!overlay || !editor.open) {
    return;
  }
  const saveButton = overlay.querySelector("#wm-file-editor-save");
  if (saveButton instanceof HTMLButtonElement) {
    saveButton.disabled = editor.saving || !editor.dirty;
  }
  const cancelButton = overlay.querySelector("#wm-file-editor-cancel");
  if (cancelButton instanceof HTMLButtonElement) {
    cancelButton.disabled = editor.saving;
  }
  const status = overlay.querySelector("#wm-file-editor-status");
  if (status instanceof HTMLElement) {
    if (editor.saveError) {
      status.textContent = editor.saveError;
      status.hidden = false;
    } else if (editor.saving) {
      status.textContent = "Saving…";
      status.hidden = false;
    } else {
      status.textContent = "";
      status.hidden = true;
    }
  }
};

const ensureAceEditorMounted = () => {
  const editor = state.fileEditor;
  if (!editor.open || editor.loading || editor.error) {
    destroyAceEditor();
    return;
  }

  const container = document.getElementById("wm-file-editor-ace");
  if (!container) {
    destroyAceEditor();
    return;
  }

  if (!aceEditorInstance) {
    aceEditorInstance = ace.edit(container);
    aceEditorInstance.session.setMode("ace/mode/text");
    aceEditorInstance.session.setUseWrapMode(false);
    aceEditorInstance.setOptions({
      useWorker: false,
      showPrintMargin: false,
      behavioursEnabled: false,
      highlightActiveLine: true,
      highlightSelectedWord: false,
      enableBasicAutocompletion: false,
      enableLiveAutocompletion: false,
      enableSnippets: false,
      wrap: false,
      fontSize: 14,
      tabSize: 2,
    });
    aceEditorInstance.renderer.setScrollMargin(8, 8, 8, 8);
    aceEditorInstance.on("change", () => {
      if (!aceEditorInstance) return;
      const value = aceEditorInstance.getValue();
      const editorState = state.fileEditor;
      editorState.content = value;
      editorState.dirty = value !== editorState.initialContent;
      updateFileEditorControls();
    });
  }

  applyAceTheme();
  const targetValue = editor.content ?? "";
  if (aceEditorInstance.getValue() !== targetValue) {
    const selection = aceEditorInstance.getSelectionRange();
    aceEditorInstance.setValue(targetValue, -1);
    if (!editor.loading) {
      aceEditorInstance.selection.setRange(selection, false);
    }
  }

  aceEditorInstance.resize(true);
  aceEditorInstance.focus();
  updateFileEditorControls();
};

const getFileEditorDisplayTitle = () => {
  const editor = state.fileEditor;
  if (editor.displayPath) {
    return editor.displayPath;
  }
  if (editor.name) {
    return editor.name;
  }
  if (editor.path) {
    return editor.path;
  }
  return "File Editor";
};

const openFileEditor = async (path, displayPath, name) => {
  if (!path) return;
  const editor = state.fileEditor;
  editor.open = true;
  editor.loading = true;
  editor.saving = false;
  editor.error = null;
  editor.saveError = null;
  editor.path = path;
  editor.displayPath = displayPath ?? null;
  editor.name = name ?? null;
  editor.content = "";
  editor.initialContent = "";
  editor.base64 = null;
  editor.dirty = false;
  editor.mtimeMs = null;
  editor.requestId += 1;
  const requestId = editor.requestId;
  render();

  try {
    const url = new URL("/api/docs/file/raw", window.location.origin);
    url.searchParams.set("path", path);
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      let message = response.statusText || "Failed to load file";
      try {
        const payload = await response.json();
        if (payload && typeof payload.error === "string") {
          message = payload.error;
        }
      } catch {
        // ignore json parse error
      }
      throw new Error(message);
    }

    const data = await response.json();
    if (editor.requestId !== requestId) {
      return;
    }
    const base64 = typeof data?.base64 === "string" ? data.base64 : "";
    const bytes = decodeBase64ToUint8Array(base64);
    const content = decodeBytesToText(bytes);
    editor.open = true;
    editor.loading = false;
    editor.error = null;
    editor.saveError = null;
    editor.path = data?.path ?? path;
    editor.relativePath = data?.relativePath ?? null;
    editor.displayPath = data?.displayPath ?? displayPath ?? null;
    editor.name = data?.name ?? name ?? null;
    editor.base64 = base64;
    editor.content = content;
    editor.initialContent = content;
    editor.mtimeMs = typeof data?.mtimeMs === "number" ? data.mtimeMs : null;
    editor.dirty = false;
  } catch (error) {
    if (editor.requestId !== requestId) {
      return;
    }
    editor.loading = false;
    editor.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (editor.requestId === requestId) {
      render();
    }
  }
};

const saveFileEditor = async () => {
  const editor = state.fileEditor;
  if (!editor.open || editor.loading || editor.saving || !editor.path) {
    return;
  }
  editor.saving = true;
  editor.saveError = null;
  updateFileEditorControls();
  const content = aceEditorInstance ? aceEditorInstance.getValue() : editor.content;
  editor.content = content;
  editor.dirty = content !== editor.initialContent;
  const bytes = encodeTextToBytes(content);
  const base64 = encodeUint8ArrayToBase64(bytes);

  try {
    const response = await fetch("/api/docs/file", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: editor.path,
        base64,
        expectedMtimeMs: editor.mtimeMs ?? undefined,
      }),
    });
    if (!response.ok) {
      let message = response.statusText || "Failed to save file";
      try {
        const payload = await response.json();
        if (payload && typeof payload.error === "string") {
          message = payload.error;
        }
      } catch {
        // ignore json parse error
      }
      throw new Error(message);
    }

    const data = await response.json();
    editor.initialContent = content;
    editor.content = content;
    editor.base64 = base64;
    editor.mtimeMs = typeof data?.mtimeMs === "number" ? data.mtimeMs : editor.mtimeMs;
    editor.dirty = false;
    editor.saving = false;
    editor.saveError = null;
    if (state.files.previewPath === editor.path) {
      state.files.previewContent = content;
    }
    updateFileEditorControls();
  } catch (error) {
    editor.saving = false;
    editor.saveError = error instanceof Error ? error.message : String(error);
    editor.dirty = editor.content !== editor.initialContent;
    updateFileEditorControls();
  }
};

const renderFileEditorOverlay = () => {
  const existing = document.getElementById("wm-file-editor-overlay");
  if (existing) {
    existing.remove();
  }

  const editor = state.fileEditor;
  if (!editor.open) {
    destroyAceEditor();
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = "wm-file-editor-overlay";
  overlay.className = "wm-file-editor";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      requestFileEditorClose();
    }
  });

  const dialog = document.createElement("div");
  dialog.className = "wm-file-editor__dialog";
  overlay.append(dialog);

  const header = document.createElement("div");
  header.className = "wm-file-editor__header";
  const heading = document.createElement("div");
  heading.className = "wm-file-editor__heading";
  const title = document.createElement("h2");
  title.textContent = editor.name ?? "Edit File";
  heading.append(title);

  const subtitleText = editor.name ? getFileEditorDisplayTitle() : editor.displayPath ?? editor.path ?? "";
  if (subtitleText) {
    const subtitle = document.createElement("p");
    subtitle.className = "wm-file-editor__subtitle";
    subtitle.textContent = subtitleText;
    heading.append(subtitle);
  }

  header.append(heading);
  dialog.append(header);

  const body = document.createElement("div");
  body.className = "wm-file-editor__body";
  dialog.append(body);

  if (editor.loading) {
    const message = document.createElement("p");
    message.className = "wm-file-editor__message";
    message.textContent = "Loading file…";
    body.append(message);
  } else if (editor.error) {
    const message = document.createElement("p");
    message.className = "wm-file-editor__message";
    message.textContent = editor.error;
    body.append(message);
  } else {
    const editorContainer = document.createElement("div");
    editorContainer.id = "wm-file-editor-ace";
    editorContainer.className = "wm-file-editor__editor";
    body.append(editorContainer);
  }

  const footer = document.createElement("div");
  footer.className = "wm-file-editor__footer";
  const status = document.createElement("div");
  status.id = "wm-file-editor-status";
  status.className = "wm-file-editor__status";
  status.hidden = true;
  footer.append(status);

  const actions = document.createElement("div");
  actions.className = "wm-file-editor__actions";

  const cancelButton = document.createElement("button");
  cancelButton.id = "wm-file-editor-cancel";
  cancelButton.type = "button";
  cancelButton.className = "wm-button secondary";
  cancelButton.textContent = editor.error ? "Close" : "Cancel";
  cancelButton.addEventListener("click", () => {
    requestFileEditorClose();
  });
  actions.append(cancelButton);

  if (editor.error && editor.path) {
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "wm-button";
    retryButton.textContent = "Retry";
    retryButton.addEventListener("click", () => {
      void openFileEditor(editor.path, editor.displayPath, editor.name);
    });
    actions.append(retryButton);
  } else if (!editor.loading) {
    const saveButton = document.createElement("button");
    saveButton.id = "wm-file-editor-save";
    saveButton.type = "button";
    saveButton.className = "wm-button";
    saveButton.textContent = "Save";
    saveButton.disabled = true;
    saveButton.addEventListener("click", () => {
      void saveFileEditor();
    });
    actions.append(saveButton);
  }

  footer.append(actions);
  dialog.append(footer);

  appRoot.append(overlay);

  updateFileEditorControls();

  if (!editor.loading && !editor.error) {
    requestAnimationFrame(() => {
      ensureAceEditorMounted();
    });
  } else {
    updateFileEditorControls();
  }
};

let orchestratorPrefixDirty = false;
let orchestratorDialogSubmitting = false;
const orchestratorDirectoryState = {
  target: null,
  requestId: 0,
  currentPath: null,
  parent: null,
  selection: null,
};

const getSessionById = (sessionId) => state.sessions.find((session) => session.id === sessionId);
const ACTIVE_SESSION_STATUSES = new Set(["starting", "running"]);
const isSessionActive = (session) => ACTIVE_SESSION_STATUSES.has(session?.status);
const getActiveSessions = () => state.sessions.filter((session) => isSessionActive(session));

const LIVE_ROUTE_PREFIX = "/live";
const FILES_ROUTE = "/files";
const SETTINGS_ROUTE = "/settings";

const getRouteFromPath = (pathname) => {
  if (
    pathname === FILES_ROUTE ||
    pathname.startsWith(`${FILES_ROUTE}/`) ||
    pathname === "/docs" ||
    pathname.startsWith("/docs/")
  ) {
    return "files";
  }
  if (pathname === SETTINGS_ROUTE) {
    return "settings";
  }
  if (pathname === LIVE_ROUTE_PREFIX || pathname.startsWith(`${LIVE_ROUTE_PREFIX}/`)) {
    return "live";
  }
  return "home";
};

const getSessionIdFromPath = (pathname) => {
  if (!pathname.startsWith(LIVE_ROUTE_PREFIX)) {
    return null;
  }
  if (pathname === LIVE_ROUTE_PREFIX) {
    return null;
  }
  const segments = pathname.slice(LIVE_ROUTE_PREFIX.length + 1).split("/").filter(Boolean);
  return segments[0] ?? null;
};

let currentRoute = getRouteFromPath(window.location.pathname);
let currentTheme = "dark";
let tabsVisible = true;
let lastLoggedSessionId = null;
let lastFilesMobileLayout = isMobileFilesLayout();

const ACE_LIGHT_THEME = "ace/theme/chrome";
const ACE_DARK_THEME = "ace/theme/tomorrow_night";

const applyAceTheme = () => {
  if (!aceEditorInstance) return;
  const targetTheme = currentTheme === "dark" ? ACE_DARK_THEME : ACE_LIGHT_THEME;
  if (aceEditorInstance.getTheme() !== targetTheme) {
    aceEditorInstance.setTheme(targetTheme);
  }
};

if (currentRoute === "files" && window.location.pathname.startsWith("/docs")) {
  const newPath = window.location.pathname.replace("/docs", "/files");
  window.history.replaceState({ route: "files" }, "", newPath);
}

const initialRouteSessionId = getSessionIdFromPath(window.location.pathname);
if (initialRouteSessionId) {
  state.activeSessionId = initialRouteSessionId;
  state.lastActiveSessionId = initialRouteSessionId;
}

const setActiveSession = (sessionId, options = {}) => {
  const { updateHistory = true, logPort = true, allowPending = false, forceLog = false } = options;
  const previousSessionId = state.activeSessionId;

  if (sessionId) {
    const sessionExists = state.sessions.some((session) => session.id === sessionId);
    if (!sessionExists && !allowPending) {
      state.activeSessionId = null;
      lastLoggedSessionId = null;
      syncDesktopSessionIndicator();
      return false;
    }

    state.activeSessionId = sessionId;
    state.lastActiveSessionId = sessionId;

    if (updateHistory && currentRoute === "live") {
      const targetPath = `${LIVE_ROUTE_PREFIX}/${sessionId}`;
      if (window.location.pathname !== targetPath) {
        window.history.pushState({ route: "live", sessionId }, "", targetPath);
      }
    }

    if (logPort && sessionExists) {
      const shouldLog = forceLog ? lastLoggedSessionId !== sessionId : sessionId !== previousSessionId;
      if (shouldLog) {
        const session = getSessionById(sessionId);
        if (session) {
          console.log("This session is sending to port:", session.port);
          lastLoggedSessionId = sessionId;
        }
      }
    }

    syncDesktopSessionIndicator();
    return true;
  }

  state.activeSessionId = null;
  lastLoggedSessionId = null;
  if (updateHistory && currentRoute === "live" && window.location.pathname !== LIVE_ROUTE_PREFIX) {
    window.history.pushState({ route: "live" }, "", LIVE_ROUTE_PREFIX);
  }
  syncDesktopSessionIndicator();
  return true;
};

const ensureActiveSession = () => {
  if (state.activeSessionId && state.sessions.some((session) => session.id === state.activeSessionId)) {
    return state.activeSessionId;
  }
  if (state.lastActiveSessionId && state.sessions.some((session) => session.id === state.lastActiveSessionId)) {
    setActiveSession(state.lastActiveSessionId, { updateHistory: false, logPort: false });
    return state.activeSessionId;
  }
  if (currentRoute === "live") {
    setActiveSession(null, { updateHistory: false, logPort: false });
    return null;
  }
  const activeSessions = getActiveSessions();
  const fallback = activeSessions[0] ?? state.sessions[0] ?? null;
  if (fallback) {
    setActiveSession(fallback.id, { updateHistory: false, logPort: false });
  } else {
    setActiveSession(null, { updateHistory: false, logPort: false });
  }
  return state.activeSessionId;
};

const applyRouteSessionFromPath = (options = {}) => {
  const { allowHistoryUpdate = false, logPort = true } = options;
  const routeSessionId = getSessionIdFromPath(window.location.pathname);

  if (routeSessionId) {
    if (state.sessions.some((session) => session.id === routeSessionId)) {
      if (state.activeSessionId !== routeSessionId) {
        setActiveSession(routeSessionId, { updateHistory: false, logPort });
      }
      return false;
    }
    if (state.activeSessionId) {
      setActiveSession(null, { updateHistory: false, logPort: false });
    }
    return true;
  }

  if (allowHistoryUpdate && state.lastActiveSessionId && state.sessions.some((session) => session.id === state.lastActiveSessionId)) {
    setActiveSession(state.lastActiveSessionId, { updateHistory: true, logPort });
    return false;
  }

  if (state.activeSessionId && !state.sessions.some((session) => session.id === state.activeSessionId)) {
    setActiveSession(null, { updateHistory: allowHistoryUpdate, logPort: false });
  }
  return false;
};
const insertTextAtCursor = (textarea, text, sessionId) => {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const next = `${before}${text}${after}`;
  textarea.value = next;
  const nextCursor = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = nextCursor;
  state.messageDrafts.set(sessionId, next);
  return next;
};

const extractImageFiles = (items) => {
  if (!items) return [];
  const files = [];
  for (const item of Array.from(items)) {
    if (!item) continue;
    if (item.kind === "file") {
      const file = item.getAsFile?.() ?? item;
      if (file && file.type?.startsWith?.("image/")) {
        files.push(file);
      }
    } else if ("type" in item && item.type?.startsWith?.("image/")) {
      files.push(item);
    }
  }
  return files;
};

const handleImageUploads = async (sessionId, files, textarea, resizeTextarea, setUploadingState) => {
  if (!files || files.length === 0) return;
  const session = getSessionById(sessionId);
  if (!session) {
    window.alert("Unable to locate session for image upload.");
    return;
  }

  for (const file of files) {
    if (!file?.type?.startsWith?.("image/")) {
      continue;
    }
    setUploadingState(true);
    try {
      const form = new FormData();
      form.append("agent", session.agent);
      form.append("image", file, file.name);

      const response = await fetch("/api/uploads/images", {
        method: "POST",
        body: form,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const message = data?.error ?? response.statusText ?? "Image upload failed";
        window.alert(message);
        continue;
      }

      const payload = await response.json().catch(() => ({}));
      const placeholder =
        typeof payload?.placeholder === "string"
          ? payload.placeholder
          : typeof payload?.publicPath === "string"
            ? payload.publicPath
            : null;

      if (!placeholder) {
        window.alert("Image upload succeeded without a usable reference.");
        continue;
      }

      const textToInsert = textarea.value.endsWith("\n") ? `${placeholder}\n` : `\n${placeholder}\n`;
      insertTextAtCursor(textarea, textToInsert, sessionId);
      resizeTextarea();
      textarea.focus();
    } catch (error) {
      console.error("Failed to upload image", error);
      window.alert("Image upload failed. Check console for details.");
    } finally {
      setUploadingState(false);
    }
  }
};

const dialog = document.getElementById("session-dialog");
const agentSelect = document.getElementById("agent-select");
const confirmButton = document.getElementById("confirm-session");
const cancelButton = document.getElementById("cancel-session");
const sessionForm = dialog?.querySelector("form");
const appRoot = document.getElementById("app");
const navLinks = Array.from(document.querySelectorAll("nav a[data-route]"));
const themeToggle = document.getElementById("theme-toggle");
const tabsToggle = document.getElementById("tabs-toggle");
const menuToggle = document.getElementById("menu-toggle");
const menuPanel = document.querySelector(".wm-menu-panel");
const menuTabsContainer = document.getElementById("menu-tabs");
const pullRefreshIndicator = document.getElementById("pull-refresh");
const pullRefreshLabel = pullRefreshIndicator?.querySelector(".label");
const desktopSessionIndicator = document.getElementById("desktop-session-indicator");
const desktopSessionIndicatorButton = document.getElementById("desktop-session-indicator-button");
const desktopSessionIndicatorName =
  desktopSessionIndicator?.querySelector('[data-part="name"]') ?? null;
const desktopSessionIndicatorDirectory =
  desktopSessionIndicator?.querySelector('[data-part="directory"]') ?? null;
const sessionNameInput = document.getElementById("session-name");
const directoryInput = document.getElementById("working-directory");
const directorySuggestions = document.getElementById("directory-suggestions");
const browseDirectoryButton = document.getElementById("browse-directory");
const directoryDialog = document.getElementById("directory-dialog");
const directoryList = document.getElementById("directory-list");
const directoryCurrent = document.getElementById("directory-current");
const directoryUpButton = document.getElementById("directory-up");
const directoryUseButton = document.getElementById("directory-use");
const orchestratorDialog = document.getElementById("orchestrator-dialog");
const orchestratorForm = orchestratorDialog?.querySelector("form");
const orchestratorLabelInput = document.getElementById("orchestrator-label");
const orchestratorAgentSelect = document.getElementById("orchestrator-agent");
const orchestratorTemplateInput = document.getElementById("orchestrator-template");
const orchestratorActiveRootInput = document.getElementById("orchestrator-active-root");
const orchestratorTemplateBrowseButton = document.getElementById("orchestrator-template-browse");
const orchestratorActiveRootBrowseButton = document.getElementById("orchestrator-active-root-browse");
const orchestratorDirectoryPrefixInput = document.getElementById("orchestrator-directory-prefix");
const orchestratorWorkingDirectoryInput = document.getElementById("orchestrator-working-directory");
const orchestratorIntroTextarea = document.getElementById("orchestrator-intro");
const orchestratorPollTimeoutInput = document.getElementById("orchestrator-timeout");
const orchestratorPollIntervalInput = document.getElementById("orchestrator-interval");
const orchestratorRetryAttemptsInput = document.getElementById("orchestrator-retries");
const orchestratorRetryDelayInput = document.getElementById("orchestrator-retry-delay");
const orchestratorCancelButton = document.getElementById("orchestrator-cancel");
const orchestratorSaveButton = document.getElementById("orchestrator-save");
const orchestratorDirectoryDialog = document.getElementById("orchestrator-directory-dialog");
const orchestratorDirectoryList = document.getElementById("orchestrator-directory-list");
const orchestratorDirectoryCurrent = document.getElementById("orchestrator-directory-current");
const orchestratorDirectoryUpButton = document.getElementById("orchestrator-directory-up");
const orchestratorDirectoryUseButton = document.getElementById("orchestrator-directory-use");

const applyTheme = (theme, persist = true) => {
  currentTheme = theme;
  document.body.dataset.theme = theme;
  themeToggle?.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  applyAceTheme();
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (error) {
      console.warn("Failed to persist theme preference", error);
    }
  }
};

const getActiveSessionForIndicator = () => {
  if (!state.activeSessionId) return null;
  return state.sessions.find((session) => session.id === state.activeSessionId) ?? null;
};

const shouldShowDesktopIndicator = () => window.innerWidth >= 900;

const syncDesktopSessionIndicator = () => {
  if (!desktopSessionIndicator) return;
  const session = getActiveSessionForIndicator();
  const canShow = Boolean(session) && shouldShowDesktopIndicator();
  if (!canShow) {
    desktopSessionIndicator.hidden = true;
    return;
  }

  const displayName = getSessionDisplayName(session);
  if (desktopSessionIndicatorName) {
    desktopSessionIndicatorName.textContent = displayName;
    desktopSessionIndicatorName.title = displayName;
  }

  const directoryValue =
    typeof session.workingDirectory === "string" && session.workingDirectory.trim().length > 0
      ? session.workingDirectory
      : state.config?.defaultDirectory ?? "";

  if (desktopSessionIndicatorDirectory) {
    const text = directoryValue || "—";
    desktopSessionIndicatorDirectory.textContent = text;
    desktopSessionIndicatorDirectory.title = directoryValue || "";
  }

  desktopSessionIndicator.hidden = false;
};

const detectPreferredTheme = () => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // ignore storage failures
  }
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
};

const toggleTheme = () => {
  const nextTheme = currentTheme === "dark" ? "light" : "dark";
  applyTheme(nextTheme);
};

const applyTabsVisibility = (visible, persist = true) => {
  tabsVisible = visible;
  document.body.dataset.tabsVisible = visible ? "true" : "false";
  tabsToggle?.setAttribute("aria-pressed", visible ? "false" : "true");
  if (persist) {
    try {
      localStorage.setItem(TABS_VISIBILITY_STORAGE_KEY, visible ? "true" : "false");
    } catch (error) {
      console.warn("Failed to persist tabs visibility preference", error);
    }
  }
};

const detectPreferredTabsVisibility = () => {
  try {
    const stored = localStorage.getItem(TABS_VISIBILITY_STORAGE_KEY);
    if (stored === "true" || stored === "false") {
      return stored === "true";
    }
  } catch {
    // ignore storage failures
  }
  return true; // default to visible
};

const toggleTabsVisibility = () => {
  const nextVisible = !tabsVisible;
  applyTabsVisibility(nextVisible);
};

const closeMenu = () => {
  if (document.body.dataset.menuOpen === "true") {
    delete document.body.dataset.menuOpen;
    menuToggle?.setAttribute("aria-expanded", "false");
    menuPanel?.setAttribute("aria-hidden", "true");
    resetPullRefresh();
  }
};

const toggleMenu = () => {
  const isOpen = document.body.dataset.menuOpen === "true";
  if (isOpen) {
    closeMenu();
  } else {
    document.body.dataset.menuOpen = "true";
    menuToggle?.setAttribute("aria-expanded", "true");
    menuPanel?.setAttribute("aria-hidden", "false");
    resetPullRefresh();
  }
};

const initTheme = () => {
  const preferred = detectPreferredTheme();
  applyTheme(preferred, false);
  if (themeToggle) {
    themeToggle.addEventListener("click", toggleTheme);
  }
  if (window.matchMedia) {
    const listener = (event) => {
      const stored = (() => {
        try {
          return localStorage.getItem(THEME_STORAGE_KEY);
        } catch {
          return null;
        }
      })();
      if (stored !== "light" && stored !== "dark") {
        applyTheme(event.matches ? "dark" : "light", false);
      }
    };
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", listener);
  }
};

const initTabsVisibility = () => {
  const preferred = detectPreferredTabsVisibility();
  applyTabsVisibility(preferred, false);
  if (tabsToggle) {
    tabsToggle.addEventListener("click", toggleTabsVisibility);
  }
};

const setActiveNav = () => {
  navLinks.forEach((link) => {
    const route = link.dataset.route;
    if (route === currentRoute) {
      link.classList.add("active");
    } else {
      link.classList.remove("active");
    }
  });
};

const syncMenuTabs = () => {
  if (!menuTabsContainer) return;
  menuTabsContainer.innerHTML = "";
  if (currentRoute !== "live") {
    menuTabsContainer.dataset.state = "hidden";
    return;
  }
  
  menuTabsContainer.dataset.state = "ready";
  const heading = document.createElement("p");
  heading.className = "wm-menu-heading";
  heading.textContent = "Sessions";
  menuTabsContainer.append(heading);
  
  const sessionsContainer = document.createElement("div");
  sessionsContainer.className = "wm-menu-sessions-container";
  
  const activeSessions = getActiveSessions();
  if (activeSessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wm-menu-empty";
    empty.textContent = "No live sessions yet.";
    sessionsContainer.append(empty);
  } else {
    const sessionsList = document.createElement("div");
    sessionsList.className = "wm-menu-sessions-list";
    const sessionTabs = renderSessionTabs({ onSelect: closeMenu });
    sessionsList.append(sessionTabs);
    sessionsContainer.append(sessionsList);
  }
  
  // Always show the + button
  const addButton = document.createElement("div");
  addButton.className = "wm-tab new wm-menu-add-session";
  addButton.textContent = "+";
  addButton.title = "Start new session";
  addButton.addEventListener("click", () => {
    openDialog();
    closeMenu();
  });
  sessionsContainer.append(addButton);
  
  menuTabsContainer.append(sessionsContainer);
};

const PULL_THRESHOLD = 90;
const PULL_MAX = 150;
const PULL_BASE_OFFSET = -120;
let pullStartY = null;
let pullActive = false;
let pullReady = false;
let pullRefreshing = false;

// Auto-polling for live updates
const POLL_INTERVAL = 2000; // Poll every 2 seconds
let pollIntervalId = null;

const setPullState = (state, distance = 0) => {
  if (!pullRefreshIndicator) return;
  const clamped = Math.max(0, Math.min(distance, PULL_MAX));
  const translate = state === "hidden"
    ? PULL_BASE_OFFSET
    : Math.min(90, -80 + clamped * 1.1);
  pullRefreshIndicator.dataset.state = state;
  pullRefreshIndicator.style.transform = `translate(-50%, ${translate}px)`;
  if (pullRefreshLabel) {
    if (state === "release") {
      pullRefreshLabel.textContent = "Release to refresh";
    } else if (state === "refresh") {
      pullRefreshLabel.textContent = "Refreshing…";
    } else {
      pullRefreshLabel.textContent = "Pull to refresh";
    }
  }
};

const resetPullRefresh = () => {
  pullStartY = null;
  pullActive = false;
  pullReady = false;
  if (pullRefreshing) return;
  setPullState("hidden", 0);
};

const triggerPullRefresh = () => {
  if (!pullRefreshIndicator || pullRefreshing) return;
  pullRefreshing = true;
  setPullState("refresh", PULL_THRESHOLD);

  const MIN_REFRESH_DURATION = 400;
  pullReady = false;
  pullActive = false;

  setTimeout(() => {
    window.location.reload();
  }, MIN_REFRESH_DURATION);
};

const DIRECTORY_SUGGESTION_DELAY = 160;
let directorySuggestionTimer = null;
let directorySuggestionRequestId = 0;

const directoryBrowserState = {
  currentPath: "",
  parent: null,
  requestId: 0,
};

const parseDirectoryLookup = (rawValue) => {
  const defaultPath = state.config?.defaultDirectory ?? "";
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) {
    return { basePath: defaultPath, term: "" };
  }

  const hasTrailingSeparator = /[\\/]$/.test(value);
  if (hasTrailingSeparator) {
    return { basePath: value, term: "" };
  }

  const lastForward = value.lastIndexOf("/");
  const lastBackward = value.lastIndexOf("\\");
  const separatorIndex = Math.max(lastForward, lastBackward);

  if (separatorIndex === -1) {
    return { basePath: defaultPath, term: value };
  }

  return {
    basePath: value.slice(0, separatorIndex + 1),
    term: value.slice(separatorIndex + 1),
  };
};

const requestDirectoryData = async (path, query) => {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (query) params.set("query", query);
  const search = params.toString();
  const url = search ? `/api/directories?${search}` : "/api/directories";
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error("Failed to request directory data", error);
    return null;
  }
};

const populateDirectorySuggestions = (data) => {
  if (!directorySuggestions) return;
  directorySuggestions.innerHTML = "";
  if (!data) return;

  const seen = new Set();
  const addOption = (value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    const option = document.createElement("option");
    option.value = value;
    directorySuggestions.append(option);
  };

  addOption(data.path);
  data.entries.forEach((entry) => addOption(entry.path));
};

const fetchDirectorySuggestions = async (value) => {
  if (!state.config) return;
  const requestId = ++directorySuggestionRequestId;
  const { basePath, term } = parseDirectoryLookup(value);
  let data = await requestDirectoryData(basePath, term);
  if (!data && basePath !== state.config.defaultDirectory) {
    data = await requestDirectoryData(state.config.defaultDirectory, term);
  }
  if (directorySuggestionRequestId !== requestId) return;
  populateDirectorySuggestions(data);
};

const scheduleDirectorySuggestions = (value) => {
  if (!directorySuggestions) return;
  if (directorySuggestionTimer) {
    clearTimeout(directorySuggestionTimer);
  }
  directorySuggestionTimer = setTimeout(() => {
    fetchDirectorySuggestions(value);
  }, DIRECTORY_SUGGESTION_DELAY);
};

const chooseDirectory = (path) => {
  if (!directoryInput) return;
  if (typeof path !== "string" || path.length === 0) return;
  directoryInput.value = path;
  state.lastWorkingDirectory = path;
  scheduleDirectorySuggestions(path);
  if (directoryDialog?.open) {
    directoryDialog.close();
  }
};

const renderDirectoryBrowser = (data) => {
  if (!data) return;
  if (directoryCurrent) {
    directoryCurrent.textContent = data.path;
  }
  if (directoryUpButton) {
    directoryUpButton.disabled = !data.parent;
  }
  if (!directoryList) return;
  directoryList.innerHTML = "";
  if (!Array.isArray(data.entries) || data.entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "directory-browser__empty";
    empty.textContent = "No subdirectories";
    directoryList.append(empty);
    return;
  }
  data.entries.forEach((entry) => {
    const item = document.createElement("li");
    item.className = "directory-browser__item";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "directory-browser__folder";
    openButton.textContent = entry.name;
    openButton.addEventListener("click", () => {
      updateDirectoryBrowser(entry.path);
    });

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "directory-browser__choose wm-button secondary";
    selectButton.textContent = "Select";
    selectButton.addEventListener("click", () => {
      chooseDirectory(entry.path);
    });

    item.append(openButton, selectButton);
    directoryList.append(item);
  });
};

const updateDirectoryBrowser = async (path) => {
  if (!state.config) return false;
  const requestId = ++directoryBrowserState.requestId;
  let data = await requestDirectoryData(path, undefined);
  if (!data && path && path !== state.config.defaultDirectory) {
    data = await requestDirectoryData(state.config.defaultDirectory, undefined);
  }
  if (directoryBrowserState.requestId !== requestId || !data) {
    return false;
  }
  directoryBrowserState.currentPath = data.path;
  directoryBrowserState.parent = data.parent;
  renderDirectoryBrowser(data);
  return true;
};

const openDirectoryBrowser = async () => {
  if (!state.config) return;
  if (!directoryDialog || typeof directoryDialog.showModal !== "function") {
    const fallback = window.prompt(
      "Enter working directory",
      directoryInput?.value ||
        state.lastWorkingDirectory ||
        state.config.defaultDirectory ||
        "",
    );
    if (fallback) {
      chooseDirectory(fallback);
    }
    return;
  }
  const seed =
    directoryInput?.value?.trim() ||
    state.lastWorkingDirectory ||
    state.config.defaultDirectory ||
    "";
  const loaded = await updateDirectoryBrowser(seed);
  if (!loaded) {
    window.alert("Unable to open directory browser for the requested path.");
    return;
  }
  directoryDialog.showModal();
};

const fetchConfig = async () => {
  const response = await fetch("/api/config");
  state.config = await response.json();
  agentSelect.innerHTML = "";
  state.config.agents.forEach((agent) => {
    const option = document.createElement("option");
    option.value = agent.id;
    option.textContent = agent.label;
    agentSelect.append(option);
  });
  if (orchestratorAgentSelect) {
    orchestratorAgentSelect.innerHTML = "";
    state.config.agents.forEach((agent) => {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = agent.label;
      orchestratorAgentSelect.append(option);
    });
  }
  if (directoryInput) {
    const initial =
      state.lastWorkingDirectory ??
      state.config.defaultDirectory ??
      "";
    directoryInput.value = initial;
    directoryInput.placeholder = state.config.defaultDirectory ?? "";
    scheduleDirectorySuggestions(initial);
  }
};

const fetchSessions = async () => {
  const response = await fetch("/api/sessions");
  const data = await response.json();
  state.sessions = data.sessions ?? [];

  const sessionIds = new Set(state.sessions.map((session) => session.id));
  if (state.lastActiveSessionId && !sessionIds.has(state.lastActiveSessionId)) {
    state.lastActiveSessionId = null;
  }

  // Clean up data and DOM references for deleted sessions
  for (const key of Array.from(state.logs.keys())) {
    if (!sessionIds.has(key)) state.logs.delete(key);
  }
  for (const key of Array.from(state.conversations.keys())) {
    if (!sessionIds.has(key)) state.conversations.delete(key);
  }
  for (const key of Array.from(state.messageDrafts.keys())) {
    if (!sessionIds.has(key)) state.messageDrafts.delete(key);
  }
  for (const key of Array.from(state.conversationContainers.keys())) {
    if (!sessionIds.has(key)) state.conversationContainers.delete(key);
  }
  for (const key of Array.from(state.logContainers.keys())) {
    if (!sessionIds.has(key)) state.logContainers.delete(key);
  }
  for (const key of Array.from(state.lastMessageCount.keys())) {
    if (!sessionIds.has(key)) state.lastMessageCount.delete(key);
  }
  for (const key of Array.from(state.lastLogLength.keys())) {
    if (!sessionIds.has(key)) state.lastLogLength.delete(key);
  }
  const routeSessionId = getSessionIdFromPath(window.location.pathname);
  const allowHistoryUpdate = currentRoute === "live" && !routeSessionId;
  const redirectHome = applyRouteSessionFromPath({ allowHistoryUpdate });
  if (redirectHome) {
    currentRoute = "home";
    lastLoggedSessionId = null;
    if (window.location.pathname !== "/home") {
      window.history.replaceState({ route: "home" }, "", "/home");
    }
  }
  ensureActiveSession();
  if (
    !redirectHome &&
    currentRoute === "live" &&
    state.activeSessionId &&
    state.sessions.some((session) => session.id === state.activeSessionId)
  ) {
    setActiveSession(state.activeSessionId, { updateHistory: false, forceLog: true });
  }

  syncDesktopSessionIndicator();

  if (!redirectHome && currentRoute === "live" && state.activeSessionId) {
    await Promise.all([
      fetchLogs(state.activeSessionId),
      fetchConversation(state.activeSessionId),
    ]);
  }
};

const fetchLogs = async (sessionId) => {
  const response = await fetch(`/api/sessions/${sessionId}/logs`);
  if (!response.ok) return;
  const data = await response.json();
  state.logs.set(sessionId, data.logs);

  // Trigger incremental DOM update if on live route
  if (currentRoute === "live" && sessionId === state.activeSessionId) {
    updateLogsDOM(sessionId);
  }
};

const fetchConversation = async (sessionId) => {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/messages?refresh=true`);
    if (!response.ok) return;
    const data = await response.json();
    const items = Array.isArray(data?.messages) ? data.messages : [];
    state.conversations.set(sessionId, items);

    // Trigger incremental DOM update if on live route
    if (currentRoute === "live" && sessionId === state.activeSessionId) {
      updateConversationDOM(sessionId);
    }
  } catch (error) {
    console.error("Failed to load conversation", error);
  }
};

const pollSessions = async () => {
  try {
    const previousSessionCount = state.sessions.length;
    const previousSessionIds = state.sessions.map(s => s.id).join(',');

    await fetchSessions();

    const currentSessionCount = state.sessions.length;
    const currentSessionIds = state.sessions.map(s => s.id).join(',');
    const sessionsChanged = previousSessionCount !== currentSessionCount || previousSessionIds !== currentSessionIds;

    // On home route, always render to show session updates
    if (currentRoute !== "live") {
      render();
    } else if (!state.activeSessionId) {
      // On live route with no active session, render to show empty state
      render();
    } else {
      // On live route with active session:
      // - Update menu tabs to reflect current sessions
      syncMenuTabs();
      // - Only replace tabs bar if sessions changed (to preserve event listeners)
      if (sessionsChanged && tabsVisible) {
        const tabsBar = document.querySelector('.wm-tabs-bar');
        if (tabsBar) {
          const existingTabs = tabsBar.querySelector('.wm-tabs');
          if (existingTabs) {
            const newTabs = renderTabs();
            existingTabs.replaceWith(newTabs);
          }
        }
      }
      // - Incremental updates for conversation/logs are handled by fetchConversation and fetchLogs
    }
  } catch (error) {
    console.error("Failed to refresh sessions", error);
  }
};

const handleWindowFocus = async () => {
  try {
    await pollSessions();
  } catch (error) {
    console.error("Failed to refresh on focus", error);
  } finally {
    if (currentRoute === "live" && state.activeSessionId) {
      requestAnimationFrame(() => {
        scrollConversationAreaToBottom(state.activeSessionId, { includeWindow: true });
      });
    }
  }
};

const startPolling = () => {
  // Clear any existing interval
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
  }

  // Start polling
  pollIntervalId = setInterval(async () => {
    try {
      await pollSessions();
    } catch (error) {
      console.error("Polling error", error);
    }
  }, POLL_INTERVAL);
};

const stopPolling = () => {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
};

const updateConversationDOM = (sessionId) => {
  let container = state.conversationContainers.get(sessionId);

  // If container reference is lost, try to find it in the DOM
  if (!container || !document.contains(container)) {
    const conversationWrapper = document.querySelector('.wm-live-conversation .wm-conversation');
    if (conversationWrapper) {
      container = conversationWrapper;
      state.conversationContainers.set(sessionId, container);
      // Re-sync the message count based on actual DOM
      const existingMessages = container.querySelectorAll('.wm-message');
      existingMessages.forEach((node) => attachCopyButton(node));
      state.lastMessageCount.set(sessionId, existingMessages.length);
    } else {
      return;
    }
  }

  const conversation = state.conversations.get(sessionId) ?? [];
  const lastCount = state.lastMessageCount.get(sessionId) ?? 0;

  // Handle new messages
  if (conversation.length > lastCount) {
    const newMessages = conversation.slice(lastCount);

    newMessages.forEach((message) => {
      const bubble = document.createElement("article");
      bubble.className = `wm-message ${message.type ?? message.role ?? "assistant"}`;
      const body = document.createElement("pre");
      body.textContent = message.content ?? message.message ?? "";
      bubble.append(body);
      attachCopyButton(bubble);
      container.append(bubble);
    });

    state.lastMessageCount.set(sessionId, conversation.length);
  }

  // Handle updated messages (streaming SSE - message content changes)
  if (conversation.length === lastCount && conversation.length > 0) {
    const domMessages = container.querySelectorAll('.wm-message');

    conversation.forEach((message, idx) => {
      const domMessage = domMessages[idx];
      if (domMessage) {
        attachCopyButton(domMessage);
        const body = domMessage.querySelector('pre');
        const currentContent = body?.textContent || '';
        const newContent = message.content ?? message.message ?? '';

        if (currentContent !== newContent) {
          if (body) {
            body.textContent = newContent;
          }
        }
      }
    });
  }
};

const updateLogsDOM = (sessionId) => {
  let container = state.logContainers.get(sessionId);

  // If container reference is lost, try to find it in the DOM
  if (!container || !document.contains(container)) {
    const logViewer = document.querySelector('.wm-log-panel .log-viewer');
    if (logViewer) {
      container = logViewer;
      state.logContainers.set(sessionId, container);
      // Re-sync the log length
      const currentLines = container.textContent.split('\n').filter(l => l.length > 0);
      state.lastLogLength.set(sessionId, currentLines.length);
    } else {
      return;
    }
  }

  const logs = state.logs.get(sessionId) ?? [];
  const lastLength = state.lastLogLength.get(sessionId) ?? 0;

  // Only update if logs changed
  if (logs.length !== lastLength || logs.join("\n") !== container.textContent) {
    container.textContent = logs.join("\n");
    state.lastLogLength.set(sessionId, logs.length);
  }
};

const openDialog = () => {
  if (!state.config) return;
  const fallbackDirectory =
    directoryInput?.value?.trim() ||
    state.lastWorkingDirectory ||
    state.config.defaultDirectory ||
    "";
  if (sessionNameInput) {
    sessionNameInput.value = "";
  }
  if (directoryInput) {
    directoryInput.value = fallbackDirectory;
    scheduleDirectorySuggestions(fallbackDirectory);
  }
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    if (sessionNameInput) {
      sessionNameInput.focus();
      sessionNameInput.select();
    } else {
      directoryInput?.focus();
      directoryInput?.select();
    }
  } else {
    // Fallback: use prompt if dialog unsupported.
    const agent = window.prompt(
      `Select agent (${state.config.agents.map((a) => a.id).join(", ")}):`,
      state.config.agents[0]?.id ?? "",
    );
    if (agent) {
      const directory = window.prompt("Working directory:", fallbackDirectory) ?? fallbackDirectory;
      const sessionName = window.prompt("Session name (optional):", "") ?? "";
      launchSession(agent, directory, sessionName);
    }
  }
};

const closeDialog = () => {
  if (dialog.open) {
    dialog.close();
  }
  if (sessionNameInput) {
    sessionNameInput.value = "";
  }
};

const handleSessionStart = async (session) => {
  if (!session || !session.id) {
    return;
  }

  const switchingToLive = currentRoute !== "live";
  if (switchingToLive) {
    currentRoute = "live";
  }
  setActiveSession(session.id, { allowPending: true, logPort: false, updateHistory: true });
  if (typeof session.workingDirectory === "string" && session.workingDirectory.length > 0) {
    state.lastWorkingDirectory = session.workingDirectory;
    if (directoryInput) {
      directoryInput.value = session.workingDirectory;
      scheduleDirectorySuggestions(session.workingDirectory);
    }
  }
  await fetchSessions();
  await Promise.all([fetchConversation(session.id), fetchLogs(session.id)]);
  render();
};

const launchSession = async (agentId, workingDirectory, name) => {
  if (!agentId) {
    window.alert("Select an agent before launching a session.");
    return;
  }

  const payload = { agent: agentId };
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (trimmedName.length > 0) {
    payload.name = trimmedName.slice(0, 120);
  }
  if (typeof workingDirectory === "string" && workingDirectory.trim().length > 0) {
    payload.directory = workingDirectory.trim();
  }

  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    window.alert(`Failed to start session: ${data.error ?? response.statusText}`);
    return;
  }

  const session = await response.json();
  await handleSessionStart(session);
};

const stopSession = async (sessionId) => {
  const response = await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    window.alert(`Failed to stop session: ${data.error ?? response.statusText}`);
    return;
  }
  await fetchSessions();
  render();
};

const deleteSession = async (sessionId) => {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/storage`, { method: "DELETE" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      window.alert(`Failed to delete session: ${data.error ?? response.statusText}`);
      return;
    }
    await fetchSessions();
    render();
  } catch (error) {
    console.error("Failed to delete session", error);
    window.alert("Failed to delete session. Check console for details.");
  }
};

const resumeSession = async (sessionId) => {
  const session = getSessionById(sessionId);
  if (!session) {
    window.alert("Session not available. It may have been deleted.");
    return;
  }
  currentRoute = "live";
  setActiveSession(sessionId, { updateHistory: true, forceLog: true });
  await Promise.all([fetchConversation(sessionId), fetchLogs(sessionId)]);
  render();
};

const sendMessage = async (sessionId, content) => {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  if (!content?.trim()) {
    window.alert("Enter a message before sending.");
    return;
  }

  try {
    const response = await fetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      window.alert(`Agent request failed: ${data.error ?? response.statusText}`);
      return;
    }
    const payload = await response.json();
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    state.conversations.set(sessionId, messages);
    state.messageDrafts.set(sessionId, "");

    // Trigger incremental updates instead of full render
    updateConversationDOM(sessionId);
    requestAnimationFrame(() => {
      scrollConversationAreaToBottom(sessionId, { includeWindow: true });
    });
    await fetchLogs(sessionId);

    // Clear textarea and restore focus
    const textarea = document.querySelector('.wm-composer textarea');
    if (textarea) {
      textarea.value = "";
      textarea.style.height = "auto";
      requestAnimationFrame(() => {
        textarea.focus();
      });
    }
  } catch (error) {
    console.error("Failed to send agent message", error);
    window.alert("Failed to send message to agent. Check console for details.");
  }
};

const normaliseOrchestratorPresetSummary = (item) => {
  if (!item || typeof item !== "object") return null;
  const id = typeof item.id === "string" ? item.id : "";
  if (!id) return null;
  const label = typeof item.label === "string" ? item.label : "";
  const agent = typeof item.agent === "string" ? item.agent : "";
  return { id, label, agent };
};

const refreshOrchestratorPresets = async () => {
  if (state.orchestratorPresetsLoading) return;
  state.orchestratorPresetsLoading = true;
  state.orchestratorPresetsError = null;
  if (currentRoute === "home") render();

  try {
    const response = await fetch("/api/orchestrators");
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error ?? response.statusText ?? "Failed to load orchestrators");
    }

    const payload = await response.json().catch(() => ({}));
    const candidates = Array.isArray(payload?.presets) ? payload.presets : [];
    state.orchestratorPresets = candidates
      .map((item) => normaliseOrchestratorPresetSummary(item))
      .filter((item) => item !== null);
    state.orchestratorPresetsError = null;
  } catch (error) {
    console.error("Failed to load orchestrator presets", error);
    state.orchestratorPresets = [];
    state.orchestratorPresetsError = error instanceof Error ? error.message : String(error);
  } finally {
    state.orchestratorPresetsLoading = false;
    state.orchestratorPresetsLoaded = true;
    if (currentRoute === "home") {
      render();
    }
  }
};

const ensureOrchestratorPresetsLoaded = () => {
  if (!state.orchestratorPresetsLoaded && !state.orchestratorPresetsLoading) {
    refreshOrchestratorPresets().catch((error) => {
      console.error("Failed to load orchestrators", error);
    });
  }
};

const launchOrchestratorPreset = async (presetId) => {
  const response = await fetch(`/api/orchestrators/${encodeURIComponent(presetId)}/launch`, {
    method: "POST",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? response.statusText ?? "Failed to launch orchestrator");
  }
  return response.json();
};

const createOrchestratorPreset = async (payload) => {
  const response = await fetch("/api/orchestrators", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? response.statusText ?? "Failed to create orchestrator");
  }
  return response.json();
};

const renderOrchestratorPresetButtons = (container) => {
  if (!container) return;
  container.textContent = "";

  if (state.orchestratorPresetsLoading && !state.orchestratorPresetsLoaded) {
    container.textContent = "Loading orchestrators...";
    return;
  }

  if (state.orchestratorPresetsError) {
    container.textContent = `Failed to load orchestrator presets: ${state.orchestratorPresetsError}`;
    return;
  }

  if (state.orchestratorPresets.length === 0) {
    container.textContent = "No orchestrator presets configured.";
    return;
  }

  for (const preset of state.orchestratorPresets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wm-button secondary";
    const label = preset.label && preset.label.length > 0 ? preset.label : preset.id;
    button.textContent = label;

    const setPending = (pending) => {
      if (pending) {
        button.disabled = true;
        button.dataset.pending = "true";
        button.textContent = "Launching...";
      } else {
        button.disabled = false;
        delete button.dataset.pending;
        button.textContent = label;
      }
    };

    button.addEventListener("click", async () => {
      if (button.dataset.pending === "true") return;
      setPending(true);
      try {
        const result = await launchOrchestratorPreset(preset.id);
        if (!result?.session) {
          window.alert("Orchestrator launched, but no session information was returned.");
          return;
        }
        await handleSessionStart(result.session);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        window.alert(`Failed to launch ${label}: ${message}`);
      } finally {
        if (button.isConnected) {
          setPending(false);
        }
      }
    });

    container.append(button);
  }
};

const formatDirectoryPrefix = (value) => {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  return trimmed
    .replace(/[^a-zA-Z0-9/_-]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
};

const getDefaultOrchestratorPath = (target) => {
  return target === "templates" ? "orchestrator/templates" : "orchestrator/active";
};

const fetchOrchestratorDirectoryData = async (target, path) => {
  const params = new URLSearchParams({ target });
  if (path) {
    params.set("path", path);
  }
  const response = await fetch(`/api/orchestrators/directories?${params.toString()}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? response.statusText ?? "Failed to load directories");
  }
  return response.json();
};

const renderOrchestratorDirectoryBrowser = (data) => {
  if (!orchestratorDirectoryCurrent || !orchestratorDirectoryList) return;
  orchestratorDirectoryCurrent.textContent = data.path;
  orchestratorDirectoryList.textContent = "";
  if (orchestratorDirectoryUpButton) {
    orchestratorDirectoryUpButton.disabled = !data.parent;
  }

  if (Array.isArray(data.entries) && data.entries.length > 0) {
    data.entries.forEach((entry) => {
      const item = document.createElement("li");
      item.className = "directory-browser__item";
      item.dataset.path = entry.path;

      const folderButton = document.createElement("button");
      folderButton.type = "button";
      folderButton.className = "directory-browser__folder";
      folderButton.textContent = entry.name;
      folderButton.dataset.path = entry.path;

      const chooseButton = document.createElement("button");
      chooseButton.type = "button";
      chooseButton.className = "wm-button secondary directory-browser__choose";
      chooseButton.textContent = "Choose";
      chooseButton.dataset.path = entry.path;

      item.append(folderButton, chooseButton);
      orchestratorDirectoryList.append(item);
    });
  } else {
    const empty = document.createElement("li");
    empty.className = "directory-browser__empty";
    empty.textContent = "No subdirectories";
    orchestratorDirectoryList.append(empty);
  }

  refreshOrchestratorDirectoryHighlights();
};

const setOrchestratorDirectorySelection = (path) => {
  orchestratorDirectoryState.selection = path;
  refreshOrchestratorDirectoryHighlights();
};

const refreshOrchestratorDirectoryHighlights = () => {
  if (!orchestratorDirectoryList) return;
  const selected = orchestratorDirectoryState.selection;
  orchestratorDirectoryList.querySelectorAll(".directory-browser__item").forEach((item) => {
    if (!(item instanceof HTMLElement)) return;
    const path = item.dataset.path;
    if (selected && path === selected) {
      item.dataset.selected = "true";
    } else {
      delete item.dataset.selected;
    }
  });
};

const updateOrchestratorDirectoryBrowser = async (target, path) => {
  orchestratorDirectoryState.target = target;
  orchestratorDirectoryState.requestId += 1;
  const requestId = orchestratorDirectoryState.requestId;
  orchestratorDirectoryState.selection = null;

  let data;
  try {
    data = await fetchOrchestratorDirectoryData(target, path ?? undefined);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error));
    return false;
  }

  if (orchestratorDirectoryState.requestId !== requestId) {
    return false;
  }

  orchestratorDirectoryState.currentPath = data.path ?? null;
  orchestratorDirectoryState.parent = data.parent ?? null;
  orchestratorDirectoryState.selection = data.path ?? null;
  renderOrchestratorDirectoryBrowser(data);
  return true;
};

const openOrchestratorDirectoryDialog = async (target, initialPath) => {
  if (!orchestratorDirectoryDialog || typeof orchestratorDirectoryDialog.showModal !== "function") {
    window.alert("Your browser does not support the directory picker.");
    return;
  }

  const seed = initialPath && initialPath.trim().length > 0 ? initialPath : getDefaultOrchestratorPath(target);
  const loaded = await updateOrchestratorDirectoryBrowser(target, seed ?? null);
  if (!loaded) {
    return;
  }
  orchestratorDirectoryDialog.showModal();
};

const setOrchestratorDialogPending = (pending) => {
  orchestratorDialogSubmitting = pending;
  if (orchestratorSaveButton) {
    orchestratorSaveButton.disabled = pending;
    orchestratorSaveButton.textContent = pending ? "Saving..." : "Save";
  }
};

const resetOrchestratorForm = () => {
  orchestratorPrefixDirty = false;
  const defaultDir = state.lastWorkingDirectory ?? state.config?.defaultDirectory ?? "";
  if (orchestratorLabelInput) {
    orchestratorLabelInput.value = "";
  }
  if (orchestratorTemplateInput) {
    orchestratorTemplateInput.value = "";
  }
  if (orchestratorActiveRootInput) {
    orchestratorActiveRootInput.value = "orchestrator/active";
    orchestratorActiveRootInput.disabled = true;
  }
  if (orchestratorTemplateBrowseButton) {
    orchestratorTemplateBrowseButton.disabled = false;
  }
  if (orchestratorActiveRootBrowseButton) {
    orchestratorActiveRootBrowseButton.disabled = true;
  }
  if (orchestratorDirectoryPrefixInput) {
    orchestratorDirectoryPrefixInput.value = "";
    orchestratorDirectoryPrefixInput.placeholder = "Security_Review";
  }
  if (orchestratorWorkingDirectoryInput) {
    orchestratorWorkingDirectoryInput.value = defaultDir;
  }
  if (orchestratorIntroTextarea) {
    orchestratorIntroTextarea.value = "";
  }
  if (orchestratorPollTimeoutInput) {
    orchestratorPollTimeoutInput.value = "30000";
  }
  if (orchestratorPollIntervalInput) {
    orchestratorPollIntervalInput.value = "250";
  }
  if (orchestratorRetryAttemptsInput) {
    orchestratorRetryAttemptsInput.value = "10";
  }
  if (orchestratorRetryDelayInput) {
    orchestratorRetryDelayInput.value = "1000";
  }

  if (state.config?.agents && orchestratorAgentSelect) {
    orchestratorAgentSelect.value = state.config.agents[0]?.id ?? "";
  }
  applyOrchestratorTemplateState();
};

const applyOrchestratorTemplateState = () => {
  const hasTemplate = Boolean(orchestratorTemplateInput?.value.trim().length);
  if (orchestratorActiveRootInput) {
    orchestratorActiveRootInput.disabled = !hasTemplate;
    if (!hasTemplate) {
      orchestratorActiveRootInput.value = getDefaultOrchestratorPath("active");
    }
  }
  if (orchestratorActiveRootBrowseButton) {
    orchestratorActiveRootBrowseButton.disabled = !hasTemplate;
  }
};

const closeOrchestratorDialog = () => {
  setOrchestratorDialogPending(false);
  if (orchestratorDialog && typeof orchestratorDialog.close === "function" && orchestratorDialog.open) {
    orchestratorDialog.close();
  }
};

const openOrchestratorDialog = () => {
  if (!state.config) {
    window.alert("Configuration is still loading. Try again shortly.");
    return;
  }
  if (!orchestratorDialog || typeof orchestratorDialog.showModal !== "function") {
    window.alert("Your browser does not support the orchestrator dialog.");
    return;
  }
  resetOrchestratorForm();
  orchestratorDialog.showModal();
  orchestratorLabelInput?.focus();
};

const readIntegerInput = (input, fallback, minimum) => {
  if (!input) return fallback;
  const value = Number.parseInt(input.value, 10);
  if (Number.isFinite(value) && (!Number.isFinite(minimum) || value >= minimum)) {
    return value;
  }
  return fallback;
};

const handleOrchestratorFormSubmit = async (event) => {
  event.preventDefault();
  if (orchestratorDialogSubmitting) return;

  const label = orchestratorLabelInput?.value.trim() ?? "";
  if (!label) {
    window.alert("Enter a button label for the orchestrator.");
    orchestratorLabelInput?.focus();
    return;
  }

  const agent = orchestratorAgentSelect?.value ?? "";
  if (!agent) {
    window.alert("Select an agent for the orchestrator.");
    orchestratorAgentSelect?.focus();
    return;
  }

  const templateDirRaw = orchestratorTemplateInput?.value.trim() ?? "";
  const workingDirectoryRaw = orchestratorWorkingDirectoryInput?.value.trim() ?? "";
  const useTemplate = templateDirRaw.length > 0;
  if (!useTemplate && !workingDirectoryRaw) {
    window.alert("Provide either a template directory or a working directory.");
    orchestratorTemplateInput?.focus();
    return;
  }

  const directoryPrefixRaw = orchestratorDirectoryPrefixInput?.value.trim() ?? "";
  const introMessageRaw = orchestratorIntroTextarea?.value ?? "";
  const introMessageTrimmed = introMessageRaw.trim();
  const pollTimeout = readIntegerInput(orchestratorPollTimeoutInput, 30000, 1000);
  const pollInterval = readIntegerInput(orchestratorPollIntervalInput, 250, 50);
  const retryAttempts = readIntegerInput(orchestratorRetryAttemptsInput, 10, 1);
  const retryDelay = readIntegerInput(orchestratorRetryDelayInput, 1000, 0);

  const payload = {
    label,
    agent,
    templateDir: useTemplate ? templateDirRaw : undefined,
    activeRoot: useTemplate ? (orchestratorActiveRootInput?.value.trim() || "orchestrator/active") : undefined,
    directoryPrefix: useTemplate
      ? directoryPrefixRaw || formatDirectoryPrefix(label)
      : directoryPrefixRaw || undefined,
    workingDirectory: useTemplate ? undefined : workingDirectoryRaw || undefined,
    introMessage: introMessageTrimmed ? introMessageTrimmed : undefined,
    pollTimeoutMs: pollTimeout,
    pollIntervalMs: pollInterval,
    retryAttempts,
    retryDelayMs: retryDelay,
  };

  setOrchestratorDialogPending(true);
  try {
    await createOrchestratorPreset(payload);
    closeOrchestratorDialog();
    await refreshOrchestratorPresets();
    if (currentRoute !== "home") {
      currentRoute = "home";
      render();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    window.alert(`Failed to create orchestrator: ${message}`);
  } finally {
    if (orchestratorDialog?.open) {
      setOrchestratorDialogPending(false);
    }
  }
};

const renderHome = () => {
  const wrapper = document.createElement("div");
  wrapper.className = "wm-home";

  const orchestratorCard = document.createElement("section");
  orchestratorCard.className = "wm-card wm-home-orchestrator";

  const orchestratorHeader = document.createElement("div");
  orchestratorHeader.className = "wm-home-section-header";

  const orchestratorTitle = document.createElement("h2");
  orchestratorTitle.textContent = "Orchestrator";

  const orchestratorContent = document.createElement("div");
  orchestratorContent.className = "wm-home-orchestrator-content";
  orchestratorContent.id = "orchestrator-content";

  const setOrchestratorCollapsed = (collapsed) => {
    if (collapsed) {
      orchestratorCard.dataset.collapsed = "true";
      orchestratorContent.hidden = true;
      orchestratorHeader.setAttribute("aria-expanded", "false");
    } else {
      delete orchestratorCard.dataset.collapsed;
      orchestratorContent.hidden = false;
      orchestratorHeader.setAttribute("aria-expanded", "true");
    }
  };

  const orchestratorCreateButton = document.createElement("button");
  orchestratorCreateButton.type = "button";
  orchestratorCreateButton.className = "wm-button secondary wm-button-icon";
  orchestratorCreateButton.setAttribute("aria-label", "Add orchestrator preset");
  orchestratorCreateButton.innerHTML = '<span aria-hidden="true">+</span>';
  orchestratorCreateButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openOrchestratorDialog();
  });

  const orchestratorHeaderActions = document.createElement("div");
  orchestratorHeaderActions.className = "wm-home-section-actions";
  orchestratorHeaderActions.append(orchestratorCreateButton);

  const orchestratorActions = document.createElement("div");
  orchestratorActions.className = "wm-home-orchestrator-actions";
  renderOrchestratorPresetButtons(orchestratorActions);

  if (!state.orchestratorPresetsLoaded && !state.orchestratorPresetsLoading) {
    ensureOrchestratorPresetsLoaded();
  }

  // Make header clickable to toggle collapse
  orchestratorHeader.addEventListener("click", (event) => {
    if (orchestratorCreateButton.contains(event.target)) return;
    const currentlyCollapsed = orchestratorCard.dataset.collapsed === "true";
    setOrchestratorCollapsed(!currentlyCollapsed);
  });

  orchestratorHeader.append(orchestratorTitle, orchestratorHeaderActions);
  orchestratorContent.append(orchestratorActions);
  orchestratorCard.append(orchestratorHeader, orchestratorContent);
  setOrchestratorCollapsed(false);

  wrapper.append(orchestratorCard);

  const liveCard = document.createElement("section");
  liveCard.className = "wm-card wm-home-live";

  const liveHeader = document.createElement("div");
  liveHeader.className = "wm-home-section-header";

  const liveTitle = document.createElement("h2");
  liveTitle.textContent = "Live Agents";

  const liveContent = document.createElement("div");
  liveContent.className = "wm-home-live-content";
  liveContent.id = "live-agents-content";

  const setCollapsed = (collapsed) => {
    if (collapsed) {
      liveCard.dataset.collapsed = "true";
      liveContent.hidden = true;
    } else {
      delete liveCard.dataset.collapsed;
      liveContent.hidden = false;
    }
  };

  // Make header clickable to toggle collapse
  liveHeader.addEventListener("click", () => {
    const currentlyCollapsed = liveCard.dataset.collapsed === "true";
    setCollapsed(!currentlyCollapsed);
  });

  liveHeader.append(liveTitle);
  liveCard.append(liveHeader);

  const renderSessionActions = (target, session) => {
    const resumeBtn = document.createElement("button");
    resumeBtn.className = "wm-button";
    resumeBtn.textContent = "Resume";
    resumeBtn.addEventListener("click", () => resumeSession(session.id));
    target.append(resumeBtn);

    if (isSessionActive(session)) {
      const stopBtn = document.createElement("button");
      stopBtn.className = "wm-button secondary";
      stopBtn.textContent = "Stop";
      stopBtn.addEventListener("click", () => stopSession(session.id));
      target.append(stopBtn);
    } else {
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "wm-button secondary";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", () => deleteSession(session.id));
      target.append(deleteBtn);
    }
  };

  const actions = document.createElement("div");
  actions.className = "wm-actions";

  const launchBtn = document.createElement("button");
  launchBtn.className = "wm-button";
  launchBtn.textContent = "Launch Agent Session";
  launchBtn.addEventListener("click", openDialog);
  actions.append(launchBtn);

  const table = document.createElement("table");
  table.className = "session-table";

  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr><th>Name</th><th>Agent</th><th>Status</th><th>Port</th><th>PID</th><th>Started</th><th>Directory</th><th></th></tr>";
  table.append(thead);

  const tbody = document.createElement("tbody");
  if (state.sessions.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.textContent = "No active sessions";
    row.append(cell);
    tbody.append(row);
  } else {
    state.sessions.forEach((session) => {
      const row = document.createElement("tr");
      const displayName = getSessionDisplayName(session);
      row.innerHTML = `
        <td>${escapeHtml(displayName)}</td>
        <td>${escapeHtml(session.agent)}</td>
        <td>${escapeHtml(session.status)}</td>
        <td>${escapeHtml(session.port)}</td>
        <td>${session.pid ?? "-"}</td>
        <td>${new Date(session.startedAt).toLocaleTimeString()}</td>
        <td class="directory-cell"></td>
        <td></td>
      `;
      const directoryCell = row.querySelector(".directory-cell");
      if (directoryCell) {
        const directoryValue =
          session.workingDirectory ??
          state.config?.defaultDirectory ??
          "-";
        directoryCell.textContent = directoryValue;
        if (typeof session.workingDirectory === "string") {
          directoryCell.title = session.workingDirectory;
        } else {
          directoryCell.removeAttribute("title");
        }
      }
      const actionsCell = row.lastElementChild;

      renderSessionActions(actionsCell, session);
      tbody.append(row);
    });
  }

  table.append(tbody);

  const tableContainer = document.createElement("div");
  tableContainer.className = "wm-table-container session-table-wrapper";
  tableContainer.append(table);

  const cardsContainer = document.createElement("div");
  cardsContainer.className = "session-card-list";
  if (state.sessions.length === 0) {
    const emptyCard = document.createElement("article");
    emptyCard.className = "session-card empty";
    emptyCard.textContent = "No active sessions";
    cardsContainer.append(emptyCard);
  } else {
    state.sessions.forEach((session) => {
      const card = document.createElement("article");
      card.className = "session-card";

      const header = document.createElement("header");
      header.className = "session-card-header";
      const title = document.createElement("h3");
      const displayName = getSessionDisplayName(session);
      title.textContent = displayName;
      const status = document.createElement("span");
      status.className = `session-status ${session.status}`;
      status.textContent = session.status;
      header.append(title, status);
      card.append(header);

      const details = document.createElement("div");
      details.className = "session-card-details";
      const addDetail = (label, value) => {
        const item = document.createElement("div");
        item.className = "session-card-detail";
        const term = document.createElement("span");
        term.className = "session-card-detail-label";
        term.textContent = label;
        const desc = document.createElement("span");
        desc.className = "session-card-detail-value";
        desc.textContent = value ?? "-";
        item.append(term, desc);
        details.append(item);
      };

      addDetail("Agent", session.agent);
      addDetail("Port", session.port ?? "-");
      addDetail("PID", session.pid ?? "-");
      addDetail("Started", new Date(session.startedAt).toLocaleTimeString());
      const directoryValue =
        session.workingDirectory ?? state.config?.defaultDirectory ?? "-";
      addDetail("Directory", directoryValue);
      card.append(details);

      const actionRow = document.createElement("div");
      actionRow.className = "session-card-actions";
      renderSessionActions(actionRow, session);
      card.append(actionRow);

      cardsContainer.append(card);
    });
  }

  liveContent.append(actions, cardsContainer, tableContainer);
  liveCard.append(liveContent);

  setCollapsed(false);
  wrapper.append(liveCard);
  return wrapper;
};

const promptCreateDirectory = async () => {
  const files = state.files;
  if (files.loading) return;
  const parentPath = files.currentPath;
  const rawName = window.prompt("Folder name", "New Folder");
  const name = rawName?.trim();
  if (!name) return;
  if (isMobileFilesLayout()) {
    files.mobileView = "browser";
  }
  files.loading = true;
  if (currentRoute === "files") render();
  try {
    const result = await createFilesDirectory(parentPath, name);
    if (isMobileFilesLayout()) {
      files.mobileView = "browser";
    }
    await loadFilesTree(result?.path ?? parentPath);
  } catch (error) {
    files.loading = false;
    if (currentRoute === "files") render();
    const message = error instanceof Error ? error.message : "Failed to create directory";
    window.alert(message);
  }
};

const promptCreateFile = async () => {
  const files = state.files;
  if (files.loading) return;
  const parentPath = files.currentPath;
  const rawName = window.prompt("File name (include extension)", "notes.txt");
  const name = rawName?.trim();
  if (!name) return;
  files.loading = true;
  if (currentRoute === "files") render();
  try {
    const result = await createFilesTextFile(parentPath, name, "");
    await loadFilesTree(parentPath);
    if (result?.path) {
      if (isMobileFilesLayout()) {
        files.mobileView = result.previewable ? "preview" : "browser";
      }
      if (result.previewable) {
        void loadFilesPreview(result.path);
      } else {
        resetFilesPreview();
        if (currentRoute === "files") render();
      }
      void openFileEditor(result.path, result.displayPath ?? null, result.name ?? null);
    }
  } catch (error) {
    files.loading = false;
    if (currentRoute === "files") render();
    const message = error instanceof Error ? error.message : "Failed to create file";
    window.alert(message);
  }
};

const renderFiles = () => {
  const files = state.files;
  if (!files.initialized) {
    files.initialized = true;
    void loadFilesTree();
  }

  const useMobileLayout = isMobileFilesLayout();
  if (!files.mobileView) {
    files.mobileView = "browser";
  }
  if (useMobileLayout && files.mobileView === "preview" && !files.previewPath && !files.previewLoading) {
    files.mobileView = "browser";
  }
  if (!useMobileLayout && files.mobileView !== "browser") {
    files.mobileView = "browser";
  }

  const wrapper = document.createElement("div");
  wrapper.className = "wm-files";

  if (useMobileLayout) {
    const toggle = document.createElement("div");
    toggle.className = "wm-files-mobile-toggle";

    const browserTab = document.createElement("button");
    browserTab.type = "button";
    browserTab.className = "wm-files-mobile-tab";
    browserTab.textContent = "Browse";
    if (files.mobileView === "browser") {
      browserTab.classList.add("active");
    }
    browserTab.addEventListener("click", () => {
      if (files.mobileView !== "browser") {
        files.mobileView = "browser";
        render();
      }
    });

    const previewTab = document.createElement("button");
    previewTab.type = "button";
    previewTab.className = "wm-files-mobile-tab";
    previewTab.textContent = "Preview";
    const previewAvailable = Boolean(files.previewPath) || files.previewLoading;
    previewTab.disabled = !previewAvailable;
    if (files.mobileView === "preview") {
      previewTab.classList.add("active");
    }
    previewTab.addEventListener("click", () => {
      if (!previewTab.disabled && files.mobileView !== "preview") {
        files.mobileView = "preview";
        render();
      }
    });

    toggle.append(browserTab, previewTab);
    wrapper.append(toggle);
  }

  const layout = document.createElement("div");
  layout.className = "wm-files-layout";

  const browserCard = document.createElement("section");
  browserCard.className = "wm-card wm-files-browser";

  const browserHeader = document.createElement("div");
  browserHeader.className = "wm-files-browser__header";

  const headerButton = document.createElement("button");
  headerButton.type = "button";
  headerButton.className = "wm-files-browser__info";
  headerButton.setAttribute("aria-expanded", "true");
  const headerTitle = document.createElement("h2");
  headerTitle.textContent = "Files";
  const pathLabel = document.createElement("span");
  pathLabel.className = "wm-files-browser__path";
  pathLabel.textContent = files.displayPath ?? "~";
  headerButton.append(headerTitle, pathLabel);

  const controls = document.createElement("div");
  controls.className = "wm-files-browser__controls";

  const upButton = document.createElement("button");
  upButton.type = "button";
  upButton.className = "wm-button secondary";
  upButton.textContent = "Up";
  upButton.disabled = files.loading || !files.parent?.path;
  upButton.addEventListener("click", () => {
    if (files.loading) return;
    if (files.parent?.path) {
      void loadFilesTree(files.parent.path);
    }
  });

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "wm-button secondary";
  refreshButton.textContent = "Refresh";
  refreshButton.disabled = files.loading;
  refreshButton.addEventListener("click", () => {
    if (files.loading) return;
    void loadFilesTree(files.currentPath);
  });

  const newFolderButton = document.createElement("button");
  newFolderButton.type = "button";
  newFolderButton.className = "wm-button secondary";
  newFolderButton.textContent = "New Folder";
  newFolderButton.disabled = files.loading;
  newFolderButton.addEventListener("click", () => {
    if (files.loading) return;
    void promptCreateDirectory();
  });

  const newFileButton = document.createElement("button");
  newFileButton.type = "button";
  newFileButton.className = "wm-button secondary";
  newFileButton.textContent = "New File";
  newFileButton.disabled = files.loading;
  newFileButton.addEventListener("click", () => {
    if (files.loading) return;
    void promptCreateFile();
  });

  controls.append(upButton, refreshButton, newFolderButton, newFileButton);
  browserHeader.append(headerButton, controls);

  const list = document.createElement("ul");
  list.className = "wm-files-browser__list";
  list.id = "files-browser-list";
  headerButton.setAttribute("aria-controls", list.id);

  const collapsed = Boolean(files.browserCollapsed);
  const setBrowserCollapsed = (next) => {
    files.browserCollapsed = next;
    if (next) {
      browserCard.dataset.collapsed = "true";
      list.hidden = true;
      list.setAttribute("aria-hidden", "true");
      headerButton.setAttribute("aria-expanded", "false");
    } else {
      delete browserCard.dataset.collapsed;
      list.hidden = false;
      list.removeAttribute("aria-hidden");
      headerButton.setAttribute("aria-expanded", "true");
    }
  };
  setBrowserCollapsed(collapsed);
  headerButton.addEventListener("click", () => {
    setBrowserCollapsed(!files.browserCollapsed);
  });
  headerButton.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " " || event.key === "Space") {
      event.preventDefault();
      setBrowserCollapsed(!files.browserCollapsed);
    }
  });

  if (files.error) {
    const item = document.createElement("li");
    item.className = "wm-files-browser__status";
    item.textContent = files.error;
    list.append(item);
  } else {
    const entries = Array.isArray(files.entries) ? files.entries : [];
    if (entries.length === 0 && !files.loading) {
      const empty = document.createElement("li");
      empty.className = "wm-files-browser__status";
      empty.textContent = "Directory is empty.";
      list.append(empty);
    }

    entries.forEach((entry) => {
      const item = document.createElement("li");
      item.className = "wm-files-browser__item";
      item.dataset.type = entry.type;
      if (entry.type === "file" && entry.path === files.previewPath) {
        item.dataset.selected = "true";
      }

      const button = document.createElement("button");
      button.type = "button";

      const name = document.createElement("span");
      name.className = "wm-files-browser__name";
      const icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent =
        entry.type === "directory"
          ? "📁"
          : entry.previewable
            ? entry.previewFormat === "markdown"
              ? "📝"
              : "💻"
            : "🚫";
      const label = document.createElement("span");
      label.textContent = entry.name;
      name.append(icon, label);
      button.append(name);

      const meta = document.createElement("span");
      meta.className = "wm-files-browser__meta";
      if (entry.type === "directory") {
        meta.textContent = "Folder";
      } else if (entry.previewable) {
        meta.textContent = entry.previewLabel ?? (entry.previewFormat === "markdown" ? "Markdown" : "Code");
      } else {
        meta.textContent = "Preview unavailable";
      }
      button.append(meta);

      if (entry.type === "directory") {
        button.addEventListener("click", () => {
          if (files.loading) return;
          void loadFilesTree(entry.path);
        });
      } else if (entry.previewable) {
        button.addEventListener("click", () => {
          if (files.previewPath !== entry.path || files.previewError) {
            void loadFilesPreview(entry.path);
          } else if (!files.previewLoading) {
            void loadFilesPreview(entry.path);
          }
        });
      } else {
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
      }

      item.append(button);
      list.append(item);
    });

    if (files.loading) {
      const loadingItem = document.createElement("li");
      loadingItem.className = "wm-files-browser__status";
      loadingItem.textContent = "Loading…";
      list.append(loadingItem);
    }
  }

  browserCard.append(browserHeader, list);

  const previewCard = document.createElement("section");
  previewCard.className = "wm-card wm-files-preview";

  const previewHeader = document.createElement("div");
  previewHeader.className = "wm-files-preview__header";
  const previewTitle = document.createElement("h2");
  previewTitle.className = "wm-files-preview__title";
  previewTitle.textContent = files.previewName ?? "Preview";
  const previewPathRow = document.createElement("div");
  previewPathRow.className = "wm-files-preview__path-row";
  const previewPath = document.createElement("p");
  previewPath.className = "wm-files-preview__path";
  if (files.previewDisplayPath) {
    previewPath.textContent = files.previewDisplayPath;
  } else if (files.previewName) {
    previewPath.textContent = files.previewName;
  } else {
    previewPath.textContent = "~";
  }
  if (files.previewLabel) {
    const formatBadge = document.createElement("span");
    formatBadge.className = "wm-files-preview__badge";
    formatBadge.textContent = files.previewLabel;
    previewPath.append(document.createTextNode(" "), formatBadge);
  }
  previewPathRow.append(previewPath);

  const copyablePath = files.previewDisplayPath || files.previewPath || null;
  if (copyablePath) {
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "wm-files-copy-link";
    copyButton.setAttribute("aria-label", "Copy file path");
    copyButton.title = "Copy file path";
    const defaultIcon =
      '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M16 1H8a2 2 0 0 0-2 2v2H5a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8l1-2H5V7h1v2h10V3h2v9l2-1V3a2 2 0 0 0-2-2Zm-2 6H8V3h6v4Zm7.71 9.29-5-5a1 1 0 0 0-1.42 1.42l1.3 1.29-4.59 4.59V22h3.41l4.59-4.59 1.29 1.3a1 1 0 0 0 1.42-1.42Z"/></svg>';
    const successIcon =
      '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="m9 16.17-3.5-3.5L4.08 14.1 9 19l12-12-1.41-1.41Z"/></svg>';
    copyButton.innerHTML = defaultIcon;
    copyButton.addEventListener("click", async () => {
      const text = copyablePath;
      if (!text) return;
      const success = await copyTextToClipboard(text);
      if (success) {
        copyButton.dataset.copied = "true";
        copyButton.innerHTML = successIcon;
        setTimeout(() => {
          if (copyButton.isConnected) {
            delete copyButton.dataset.copied;
            copyButton.innerHTML = defaultIcon;
          }
        }, 1600);
      }
    });
    previewPathRow.append(copyButton);
  }

  const previewInfo = document.createElement("div");
  previewInfo.className = "wm-files-preview__info";
  previewInfo.append(previewTitle, previewPathRow);
  previewHeader.append(previewInfo);

  const previewActions = document.createElement("div");
  previewActions.className = "wm-files-preview__actions";
  const canEdit =
    Boolean(files.previewPath) &&
    !files.previewLoading &&
    !files.previewError &&
    files.previewContent !== null &&
    typeof files.previewPath === "string";
  if (canEdit) {
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "wm-button secondary";
    editButton.textContent = "Edit File";
    editButton.addEventListener("click", () => {
      void openFileEditor(files.previewPath, files.previewDisplayPath ?? null, files.previewName ?? null);
    });
    previewActions.append(editButton);
  }
  if (previewActions.childElementCount > 0) {
    previewHeader.append(previewActions);
  }

  const previewBody = document.createElement("div");
  previewBody.className = "wm-files-preview__body";

  if (files.previewLoading) {
    previewBody.dataset.loading = "true";
    previewBody.textContent = "Loading preview…";
  } else if (files.previewError) {
    const error = document.createElement("div");
    error.className = "wm-files-browser__status";
    error.textContent = files.previewError;
    previewBody.append(error);
  } else if (files.previewContent !== null) {
    if (files.previewFormat === "markdown") {
      if (files.previewContent.trim().length > 0) {
        const content = document.createElement("div");
        content.className = "wm-files-preview-content";
        content.innerHTML = renderMarkdownToHtml(files.previewContent);
        previewBody.append(content);
      } else {
        previewBody.dataset.empty = "true";
        previewBody.textContent = "This document is empty.";
      }
    } else {
      const content = document.createElement("div");
      content.className = "wm-files-preview-code";
      content.innerHTML = renderCodeToHtml(files.previewContent, files.previewLanguage ?? "plaintext");
      previewBody.append(content);
    }
  } else {
    previewBody.dataset.empty = "true";
    previewBody.textContent = "Select a previewable file to view.";
  }

  previewCard.append(previewHeader, previewBody);

  if (useMobileLayout) {
    browserCard.hidden = files.mobileView !== "browser";
    previewCard.hidden = files.mobileView !== "preview";
  }

  layout.append(browserCard, previewCard);
  wrapper.append(layout);
  return wrapper;
};

const renderSettings = () => {
  const wrapper = document.createElement("div");
  wrapper.className = "wm-settings";

  const pageTitle = document.createElement("h1");
  pageTitle.textContent = "Settings";
  wrapper.append(pageTitle);

  const sections = [
    {
      title: "Wingman Settings",
      description: "Adjust global preferences for the Wingman workspace.",
    },
    {
      title: "Agent Settings",
      description: "Manage default behaviors for the connected agents.",
    },
    {
      title: "Orchestrator Settings",
      description: "Tune orchestrator automation and preset options.",
    },
    {
      title: "User Settings",
      description: "Update your personal profile and interface choices.",
    },
    {
      title: "Team Settings",
      description: "Coordinate shared settings and access for your team.",
    },
  ];

  sections.forEach((section) => {
    const card = document.createElement("section");
    card.className = "wm-card";

    const heading = document.createElement("h2");
    heading.textContent = section.title;

    const description = document.createElement("p");
    description.textContent = section.description;

    card.append(heading, description);
    wrapper.append(card);
  });

  return wrapper;
};

const renderSessionTabs = (options = {}) => {
  const onSelect = typeof options.onSelect === "function" ? options.onSelect : null;
  const tabs = document.createElement("div");
  tabs.className = "wm-tabs menu";

  const activeSessions = getActiveSessions();
  activeSessions.forEach((session) => {
    const tab = document.createElement("div");
    tab.className = "wm-tab";
    if (session.id === state.activeSessionId) {
      tab.classList.add("active");
    }

    const displayName = getSessionDisplayName(session);
    const safeLabel = escapeHtml(displayName);
    tab.innerHTML = `
      <span>${safeLabel}</span>
      <span class="close" title="Stop session">×</span>
    `;
    tab.title = `${displayName} - ${session.agent}:${session.port}`;

    tab.addEventListener("click", () => {
      if (state.activeSessionId === session.id && currentRoute === "live") {
        // Already active, no need to switch
        onSelect?.();
        return;
      }
      currentRoute = "live";
      setActiveSession(session.id, { updateHistory: true, forceLog: true });
      fetchLogs(session.id);
      fetchConversation(session.id);
      // Don't call render() - it will destroy DOM references
      // Instead, just update the tabs to show active state
      if (tabsVisible) {
        const tabsBar = document.querySelector('.wm-tabs-bar');
        if (tabsBar) {
          const existingTabs = tabsBar.querySelector('.wm-tabs');
          if (existingTabs) {
            const newTabs = renderTabs();
            existingTabs.replaceWith(newTabs);
          }
        }
      }
      updateLivePanelsForSession(session.id);
      onSelect?.();
    });

    const closeButton = tab.querySelector(".close");
    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      stopSession(session.id);
      onSelect?.();
    });

    tabs.append(tab);
  });

  return tabs;
};

const renderTabs = (options = {}) => {
  const variant = options.variant === "menu" ? "menu" : "default";
  const onSelect = typeof options.onSelect === "function" ? options.onSelect : null;
  const tabs = document.createElement("div");
  tabs.className = `wm-tabs${variant === "menu" ? " menu" : ""}`;

  const activeSessions = getActiveSessions();
  activeSessions.forEach((session) => {
    const tab = document.createElement("div");
    tab.className = "wm-tab";
    if (session.id === state.activeSessionId) {
      tab.classList.add("active");
    }

    const displayName = getSessionDisplayName(session);
    const safeLabel = escapeHtml(displayName);
    tab.innerHTML = `
      <span>${safeLabel}</span>
      <span class="close" title="Stop session">×</span>
    `;
    tab.title = `${displayName} - ${session.agent}:${session.port}`;

    tab.addEventListener("click", () => {
      if (state.activeSessionId === session.id && currentRoute === "live") {
        // Already active, no need to switch
        onSelect?.();
        return;
      }
      currentRoute = "live";
      setActiveSession(session.id, { updateHistory: true, forceLog: true });
      fetchLogs(session.id);
      fetchConversation(session.id);
      // Don't call render() - it will destroy DOM references
      // Instead, just update the tabs to show active state
      if (tabsVisible) {
        const tabsBar = document.querySelector('.wm-tabs-bar');
        if (tabsBar) {
          const existingTabs = tabsBar.querySelector('.wm-tabs');
          if (existingTabs) {
            const newTabs = renderTabs();
            existingTabs.replaceWith(newTabs);
          }
        }
      }
      updateLivePanelsForSession(session.id);
      onSelect?.();
    });

    const closeButton = tab.querySelector(".close");
    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      stopSession(session.id);
      onSelect?.();
    });

    tabs.append(tab);
  });

  const newTab = document.createElement("div");
  newTab.className = "wm-tab new";
  newTab.textContent = "+";
  newTab.title = "Start new session";
  newTab.addEventListener("click", () => {
    openDialog();
    onSelect?.();
  });
  tabs.append(newTab);

  return tabs;
};

const renderLogs = (sessionId) => {
  const logs = state.logs.get(sessionId) ?? ["No logs yet"];
  const panel = document.createElement("details");
  panel.className = "wm-log-panel";
  const summary = document.createElement("summary");
  summary.textContent = "Raw Terminal Output";
  const container = document.createElement("div");
  container.className = "log-viewer";
  container.textContent = logs.join("\n");
  const isOpen = state.logPanelOpen.get(sessionId) ?? false;
  panel.open = Boolean(isOpen);
  panel.addEventListener("toggle", () => {
    state.logPanelOpen.set(sessionId, panel.open);
  });
  panel.append(summary, container);

  // Store reference for incremental updates
  state.logContainers.set(sessionId, container);
  state.lastLogLength.set(sessionId, logs.length);

  return panel;
};

const renderConversation = (sessionId) => {
  const conversation = state.conversations.get(sessionId) ?? [];
  const wrapper = document.createElement("div");
  wrapper.className = "wm-conversation";

  if (conversation.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "Conversation has no messages yet.";
    wrapper.append(empty);
  } else {
    conversation.forEach((message) => {
      const bubble = document.createElement("article");
      bubble.className = `wm-message ${message.type ?? message.role ?? "assistant"}`;
      const body = document.createElement("pre");
      body.textContent = message.content ?? message.message ?? "";
      bubble.append(body);
      attachCopyButton(bubble);
      wrapper.append(bubble);
    });
  }

  // Store reference for incremental updates
  state.conversationContainers.set(sessionId, wrapper);
  state.lastMessageCount.set(sessionId, conversation.length);

  return wrapper;
};

const renderComposer = (sessionId) => {
  const composerShell = document.createElement("div");
  composerShell.className = "wm-composer-shell";
  composerShell.dataset.sessionId = sessionId;

  const composer = document.createElement("form");
  composer.className = "wm-composer";

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Ask the agent something...";
  textarea.value = state.messageDrafts.get(sessionId) ?? "";
  textarea.setAttribute("rows", "1");

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.multiple = true;
  fileInput.style.display = "none";

  const resizeTextarea = () => {
    textarea.style.height = "auto";
    const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight) || 20;
    const minHeight = lineHeight;
    const maxHeight = lineHeight * 8;
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  };

  let submit;
  let commandButton;
  const setUploadingState = (isUploading) => {
    if (isUploading) {
      composer.dataset.uploading = "true";
    } else {
      delete composer.dataset.uploading;
    }
    if (submit) {
      submit.disabled = Boolean(isUploading);
    }
    if (commandButton) {
      commandButton.disabled = Boolean(isUploading);
    }
  };

  textarea.addEventListener("input", (event) => {
    state.messageDrafts.set(sessionId, event.target.value);
    resizeTextarea();
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });

  textarea.addEventListener("paste", (event) => {
    const files = extractImageFiles(event.clipboardData?.items ?? event.clipboardData?.files);
    if (files.length > 0) {
      event.preventDefault();
      handleImageUploads(sessionId, files, textarea, resizeTextarea, setUploadingState);
    }
  });

  const handleDropEvent = (event) => {
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const files = extractImageFiles(transfer.items ?? transfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    handleImageUploads(sessionId, files, textarea, resizeTextarea, setUploadingState);
  };

  composer.addEventListener("dragover", (event) => {
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    event.preventDefault();
  });
  composer.addEventListener("drop", handleDropEvent);

  fileInput.addEventListener("change", () => {
    const files = extractImageFiles(fileInput.files);
    if (files.length > 0) {
      handleImageUploads(sessionId, files, textarea, resizeTextarea, setUploadingState);
    }
    fileInput.value = "";
  });

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const draft = textarea.value;
    state.messageDrafts.set(sessionId, draft);
    const result = sendMessage(sessionId, draft);
    if (result?.finally) {
      result.finally(() => {
        requestAnimationFrame(() => {
          const newTextarea = document.querySelector('.wm-composer textarea');
          if (newTextarea) {
            newTextarea.focus();
          }
        });
      });
    }
  });

  commandButton = document.createElement("button");
  commandButton.type = "button";
  commandButton.className = "wm-button secondary wm-command-button";
  commandButton.innerHTML = '<span class="button-icon" aria-hidden="true">$></span><span class="button-text">Cmd</span>';
  commandButton.setAttribute("aria-haspopup", "true");
  commandButton.setAttribute("aria-expanded", "false");

  const commandMenu = document.createElement("div");
  commandMenu.className = "wm-command-menu";
  commandMenu.setAttribute("role", "menu");

  const addCommand = (label, handler) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "wm-command-item";
    item.textContent = label;
    item.setAttribute("role", "menuitem");
    item.addEventListener("click", () => {
      handler();
      commandMenu.classList.remove("is-open");
      commandButton.setAttribute("aria-expanded", "false");
    });
    commandMenu.append(item);
  };

  addCommand("Scroll to end", () => {
    scrollConversationAreaToBottom(sessionId, { includeWindow: true });
  });

  addCommand("Copy chat", () => {
    copyConversationToClipboard(sessionId);
  });

  addCommand("Attach image", () => {
    fileInput.click();
  });

  const toggleCommandMenu = () => {
    const isOpen = commandMenu.classList.toggle("is-open");
    commandButton.setAttribute("aria-expanded", String(isOpen));
    if (isOpen) {
      const closeMenu = (event) => {
        if (!commandMenu.contains(event.target) && event.target !== commandButton) {
          commandMenu.classList.remove("is-open");
          commandButton.setAttribute("aria-expanded", "false");
          document.removeEventListener("mousedown", closeMenu);
          document.removeEventListener("touchstart", closeMenu);
        }
      };
      document.addEventListener("mousedown", closeMenu);
      document.addEventListener("touchstart", closeMenu, { passive: true });
    }
  };

  commandButton.addEventListener("click", () => {
    if (commandButton.disabled) return;
    toggleCommandMenu();
  });

  submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "wm-button";
  submit.innerHTML = '<span class="button-icon" aria-hidden="true">-&gt;</span><span class="button-text">Send</span>';
  submit.setAttribute("aria-label", "Send");

  const buttonGroup = document.createElement("div");
  buttonGroup.className = "wm-button-group";
  const commandWrapper = document.createElement("div");
  commandWrapper.className = "wm-command-wrapper";
  commandWrapper.append(commandButton, commandMenu);

  buttonGroup.append(commandWrapper, submit);

  composer.append(fileInput, textarea, buttonGroup);
  composerShell.append(composer);

  resizeTextarea();

  requestAnimationFrame(() => {
    if (!document.contains(textarea)) return;
    textarea.focus();
    resizeTextarea();
  });

  return composerShell;
};

const updateLivePanelsForSession = (sessionId) => {
  const scrollRegion = document.querySelector('.wm-live-scroll');
  if (scrollRegion) {
    scrollRegion.innerHTML = "";
    const logSection = renderLogs(sessionId);
    scrollRegion.append(logSection);
    const conversationContainer = document.createElement("div");
    conversationContainer.className = "wm-live-conversation";
    conversationContainer.append(renderConversation(sessionId));
    scrollRegion.append(conversationContainer);
    requestAnimationFrame(() => {
      scrollConversationAreaToBottom(sessionId);
    });
  }

  const currentComposer = document.querySelector('.wm-composer-shell');
  if (currentComposer) {
    currentComposer.replaceWith(renderComposer(sessionId));
  } else {
    const liveWrapper = document.querySelector('.wm-live');
    if (liveWrapper) {
      liveWrapper.append(renderComposer(sessionId));
    }
  }
};

const renderLive = () => {
  const wrapper = document.createElement("div");
  wrapper.className = "wm-live";

  if (tabsVisible) {
    const tabsBar = document.createElement("div");
    tabsBar.className = "wm-tabs-bar";
    tabsBar.append(renderTabs());
    wrapper.append(tabsBar);
  }

  if (state.sessions.length === 0) {
    const container = document.createElement("section");
    container.className = "wm-card wm-live-main";
    const empty = document.createElement("p");
    empty.textContent = "No live sessions. Launch a new agent to begin.";
    container.append(empty);
    wrapper.append(container);
    return wrapper;
  }

  if (!state.activeSessionId || !state.sessions.some((session) => session.id === state.activeSessionId)) {
    ensureActiveSession();
  }

  if (!state.activeSessionId) {
    const container = document.createElement("section");
    container.className = "wm-card wm-live-main";
    const empty = document.createElement("p");
    empty.textContent = "No live session selected. Launch a new agent or use the menu to resume one.";
    container.append(empty);
    wrapper.append(container);
    return wrapper;
  }

  const sessionId = state.activeSessionId;

  const main = document.createElement("section");
  main.className = "wm-card wm-live-main";

  const scrollRegion = document.createElement("div");
  scrollRegion.className = "wm-live-scroll";
  const logSection = renderLogs(sessionId);
  scrollRegion.append(logSection);

  const conversationContainer = document.createElement("div");
  conversationContainer.className = "wm-live-conversation";
  conversationContainer.append(renderConversation(sessionId));
  scrollRegion.append(conversationContainer);
  requestAnimationFrame(() => {
    scrollConversationAreaToBottom(sessionId);
  });

  main.append(scrollRegion);
  wrapper.append(main);

  wrapper.append(renderComposer(sessionId));

  return wrapper;
};

const render = () => {
  appRoot.innerHTML = "";
  let view;
  if (currentRoute === "live") {
    view = renderLive();
  } else if (currentRoute === "files") {
    view = renderFiles();
  } else if (currentRoute === "settings") {
    view = renderSettings();
  } else {
    view = renderHome();
  }
  appRoot.append(view);
  renderFileEditorOverlay();
  appRoot.dataset.route = currentRoute;
  setActiveNav();
  closeMenu();
  syncMenuTabs();
  syncDesktopSessionIndicator();
  lastFilesMobileLayout = isMobileFilesLayout();
  if (!pullRefreshing && !pullActive) {
    resetPullRefresh();
  }

  // Start or stop polling based on route
  if (currentRoute === "live" && getActiveSessions().length > 0) {
    startPolling();
  } else {
    stopPolling();
  }
};

const handleTouchStart = (event) => {
  if (!pullRefreshIndicator || pullRefreshing) return;
  if (document.body.dataset.menuOpen === "true") return;

  const touch = event.touches?.[0];
  if (!touch) return;

  // Only allow pull-to-refresh if touch starts in header area
  const header = document.querySelector('.wm-header');
  if (!header) return;

  const headerRect = header.getBoundingClientRect();
  if (touch.clientY < headerRect.top || touch.clientY > headerRect.bottom) {
    return;
  }

  pullStartY = touch.clientY;
  pullActive = true;
  pullReady = false;
};

const handleTouchMove = (event) => {
  if (!pullActive || pullRefreshing || !pullRefreshIndicator) return;
  const touch = event.touches?.[0];
  if (!touch) return;

  const delta = touch.clientY - (pullStartY ?? touch.clientY);
  if (delta <= 0) {
    pullReady = false;
    setPullState("pull", 0);
    return;
  }
  const distance = Math.min(delta, PULL_MAX);
  if (distance > 0) {
    try {
      event.preventDefault();
    } catch {
      // ignore
    }
  }
  if (distance >= PULL_THRESHOLD) {
    pullReady = true;
    setPullState("release", distance);
  } else {
    pullReady = false;
    setPullState("pull", distance);
  }
};

const finishPull = () => {
  if (!pullActive) return;
  pullActive = false;
  if (pullReady && !pullRefreshing) {
    triggerPullRefresh();
  } else {
    resetPullRefresh();
  }
};

navLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const targetRoute = link.dataset.route;
    if (!targetRoute || targetRoute === currentRoute) return;
    closeMenu();
    if (targetRoute === "live") {
      currentRoute = "live";
      const hasActive = state.activeSessionId && state.sessions.some((session) => session.id === state.activeSessionId);
      const hasLast = state.lastActiveSessionId && state.sessions.some((session) => session.id === state.lastActiveSessionId);
      const targetSessionId = hasActive ? state.activeSessionId : hasLast ? state.lastActiveSessionId : null;
      if (targetSessionId) {
        setActiveSession(targetSessionId, { updateHistory: true, forceLog: true });
      } else {
        setActiveSession(null, { updateHistory: true });
      }
    } else if (targetRoute === "files") {
      currentRoute = "files";
      lastLoggedSessionId = null;
      if (window.location.pathname !== FILES_ROUTE) {
        window.history.pushState({ route: "files" }, "", FILES_ROUTE);
      }
      if (!state.files.initialized) {
        state.files.initialized = true;
        void loadFilesTree();
      }
    } else if (targetRoute === "settings") {
      currentRoute = "settings";
      lastLoggedSessionId = null;
      if (window.location.pathname !== SETTINGS_ROUTE) {
        window.history.pushState({ route: "settings" }, "", SETTINGS_ROUTE);
      }
    } else {
      currentRoute = "home";
      lastLoggedSessionId = null;
      if (window.location.pathname !== "/home") {
        window.history.pushState({ route: "home" }, "", "/home");
      }
    }
    render();
  });
});

menuToggle?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleMenu();
});

desktopSessionIndicatorButton?.addEventListener("click", (event) => {
  event.preventDefault();
  const session = getActiveSessionForIndicator();
  if (!session) return;
  closeMenu();
  if (currentRoute !== "live") {
    currentRoute = "live";
  }
  setActiveSession(session.id, { updateHistory: true, forceLog: true });
  render();
  requestAnimationFrame(() => {
    scrollConversationAreaToBottom(session.id, { includeWindow: true });
  });
});

document.addEventListener("click", (event) => {
  if (document.body.dataset.menuOpen === "true") {
    const target = event.target;
    if (target instanceof Node && !menuToggle?.contains(target) && !menuPanel?.contains(target)) {
      closeMenu();
    }
  }
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 720) {
    closeMenu();
  }
  syncDesktopSessionIndicator();
  const mobileLayout = isMobileFilesLayout();
  if (currentRoute === "files" && mobileLayout !== lastFilesMobileLayout) {
    lastFilesMobileLayout = mobileLayout;
    render();
  } else {
    lastFilesMobileLayout = mobileLayout;
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMenu();
  }
});

if (directoryInput) {
  directoryInput.addEventListener("input", (event) => {
    scheduleDirectorySuggestions(event.target.value);
  });
  directoryInput.addEventListener("focus", () => {
    scheduleDirectorySuggestions(directoryInput.value);
  });
}

browseDirectoryButton?.addEventListener("click", (event) => {
  event.preventDefault();
  openDirectoryBrowser();
});

directoryUpButton?.addEventListener("click", (event) => {
  event.preventDefault();
  if (directoryBrowserState.parent) {
    updateDirectoryBrowser(directoryBrowserState.parent);
  }
});

directoryUseButton?.addEventListener("click", (event) => {
  event.preventDefault();
  if (directoryBrowserState.currentPath) {
    chooseDirectory(directoryBrowserState.currentPath);
  }
});

if (directoryDialog) {
  directoryDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    directoryDialog.close();
  });
  directoryDialog.addEventListener("close", () => {
    directoryBrowserState.requestId += 1;
  });
}

window.addEventListener("touchstart", handleTouchStart, { passive: true });
window.addEventListener("touchmove", handleTouchMove, { passive: false });
window.addEventListener("touchend", finishPull, { passive: true });
window.addEventListener("touchcancel", finishPull, { passive: true });

window.addEventListener("popstate", () => {
  currentRoute = getRouteFromPath(window.location.pathname);
  if (currentRoute !== "live") {
    lastLoggedSessionId = null;
  }
  const redirectHome = applyRouteSessionFromPath({ allowHistoryUpdate: false });
  if (redirectHome) {
    currentRoute = "home";
    if (window.location.pathname !== "/home") {
      window.history.replaceState({ route: "home" }, "", "/home");
    }
  }
  if (currentRoute === "files") {
    if (window.location.pathname.startsWith("/docs")) {
      const newPath = window.location.pathname.replace("/docs", "/files");
      window.history.replaceState({ route: "files" }, "", newPath);
    }
    if (!state.files.initialized) {
      state.files.initialized = true;
      void loadFilesTree();
    } else if (!state.files.loading && !state.files.currentPath) {
      void loadFilesTree();
    }
  }
  render();
});

window.addEventListener("focus", handleWindowFocus);

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.fileEditor.open) {
    event.preventDefault();
    requestFileEditorClose();
  }
});

// Handle page visibility changes (pause polling when page is hidden)
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
  } else if (currentRoute === "live" && getActiveSessions().length > 0) {
    // Resume polling when page becomes visible
    pollSessions(); // Immediate poll
    startPolling();
  }
});

const handleSessionLaunchRequest = () => {
  const agentId = agentSelect?.value ?? "";
  const workingDirectory = directoryInput?.value ?? "";
  const sessionName = sessionNameInput?.value ?? "";
  closeDialog();
  launchSession(agentId, workingDirectory, sessionName);
};

orchestratorForm?.addEventListener("submit", handleOrchestratorFormSubmit);

if (orchestratorCancelButton) {
  orchestratorCancelButton.addEventListener("click", (event) => {
    event.preventDefault();
    closeOrchestratorDialog();
  });
}

if (orchestratorDialog) {
  orchestratorDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeOrchestratorDialog();
  });
  orchestratorDialog.addEventListener("close", () => {
    setOrchestratorDialogPending(false);
  });
}

if (orchestratorDirectoryDialog) {
  orchestratorDirectoryDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    orchestratorDirectoryDialog.close();
  });
  orchestratorDirectoryDialog.addEventListener("close", () => {
    orchestratorDirectoryState.target = null;
    orchestratorDirectoryState.selection = null;
    orchestratorDirectoryState.currentPath = null;
    orchestratorDirectoryState.parent = null;
  });
}

orchestratorDirectoryUpButton?.addEventListener("click", (event) => {
  event.preventDefault();
  if (orchestratorDirectoryState.parent && orchestratorDirectoryState.target) {
    updateOrchestratorDirectoryBrowser(orchestratorDirectoryState.target, orchestratorDirectoryState.parent);
  }
});

orchestratorDirectoryList?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const path = target.dataset.path;
  if (!path || !orchestratorDirectoryState.target) return;

  if (target.classList.contains("directory-browser__folder")) {
    updateOrchestratorDirectoryBrowser(orchestratorDirectoryState.target, path);
  }

  if (target.classList.contains("directory-browser__choose")) {
    setOrchestratorDirectorySelection(path);
  }
});

orchestratorDirectoryUseButton?.addEventListener("click", (event) => {
  event.preventDefault();
  const target = orchestratorDirectoryState.target;
  if (!target) return;
  const selected = orchestratorDirectoryState.selection ?? orchestratorDirectoryState.currentPath;
  if (!selected) {
    window.alert("Select a directory first.");
    return;
  }

  if (target === "templates") {
    if (orchestratorTemplateInput) {
      orchestratorTemplateInput.value = selected;
      orchestratorTemplateInput.dispatchEvent(new Event("input"));
    }
    if (!orchestratorPrefixDirty && orchestratorDirectoryPrefixInput) {
      const lastSegment = selected.split("/").filter(Boolean).pop() ?? "";
      const suggestion = formatDirectoryPrefix(lastSegment);
      if (suggestion) {
        orchestratorDirectoryPrefixInput.value = suggestion;
      }
      orchestratorDirectoryPrefixInput.placeholder = suggestion || "Security_Review";
    }
  } else if (target === "active") {
    if (orchestratorActiveRootInput) {
      orchestratorActiveRootInput.value = selected;
    }
  }

  setOrchestratorDirectorySelection(selected);
  applyOrchestratorTemplateState();
  if (orchestratorDirectoryDialog.open) {
    orchestratorDirectoryDialog.close();
  }
});

orchestratorLabelInput?.addEventListener("input", () => {
  const suggestion = formatDirectoryPrefix(orchestratorLabelInput.value);
  if (!orchestratorPrefixDirty && orchestratorDirectoryPrefixInput) {
    orchestratorDirectoryPrefixInput.value = suggestion;
  }
  if (orchestratorDirectoryPrefixInput) {
    orchestratorDirectoryPrefixInput.placeholder = suggestion || "Security_Review";
  }
});

orchestratorDirectoryPrefixInput?.addEventListener("input", () => {
  orchestratorPrefixDirty = true;
});

orchestratorTemplateInput?.addEventListener("input", () => {
  applyOrchestratorTemplateState();
});

orchestratorTemplateBrowseButton?.addEventListener("click", (event) => {
  event.preventDefault();
  const seed = orchestratorTemplateInput?.value ?? getDefaultOrchestratorPath("templates");
  openOrchestratorDirectoryDialog("templates", seed);
});

orchestratorActiveRootBrowseButton?.addEventListener("click", (event) => {
  event.preventDefault();
  if (orchestratorActiveRootBrowseButton.disabled) return;
  const seed = orchestratorActiveRootInput?.value ?? getDefaultOrchestratorPath("active");
  openOrchestratorDirectoryDialog("active", seed);
});

sessionForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  handleSessionLaunchRequest();
});

confirmButton.addEventListener("click", (event) => {
  event.preventDefault();
  handleSessionLaunchRequest();
});

cancelButton.addEventListener("click", (event) => {
  event.preventDefault();
  closeDialog();
});

dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog();
});

(async () => {
  initTheme();
  initTabsVisibility();
  await fetchConfig();
  await refreshOrchestratorPresets();
  await fetchSessions();
  render();
})();
