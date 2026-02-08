/**
 * Writer panel component — block-based markdown editor that pairs with
 * a live agent session. Renders markdown blocks with click-to-edit.
 *
 * Exports:
 *   createWriterPanel(sessionId, targetFile, deps) -> { panel, cleanup }
 *   createWriterIcon(onToggle) -> HTMLButtonElement
 *   createWriterToolbar(currentMode, onModeChange, onClose) -> HTMLElement
 */

import { parseMarkdownBlocks, assembleBlocks } from "./block-parser.js";
import { renderMarkdownToHtml } from "../rendering/markdown.js";
import { escapeHtml } from "../core/icons.js";

const POLL_INTERVAL_MS = 2500;

/**
 * Create the pencil icon button that toggles the writer panel.
 * @param {Function} onToggle
 * @returns {HTMLButtonElement}
 */
export function createWriterIcon(onToggle) {
  const btn = document.createElement("button");
  btn.className = "wm-writer-icon";
  btn.title = "Toggle writer panel";
  btn.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
  btn.addEventListener("click", onToggle);
  return btn;
}

/**
 * Create the writer toolbar with layout toggle and close buttons.
 * Reuses the webview toolbar CSS pattern.
 * @param {string} currentMode - 'chat-narrow' or 'app-narrow'
 * @param {Function} onModeChange - Called with new mode string
 * @param {Function} onClose - Called when close is clicked
 * @returns {HTMLElement}
 */
export function createWriterToolbar(currentMode, onModeChange, onClose) {
  const toolbar = document.createElement("div");
  toolbar.className = "wm-webview-toolbar";

  const modeGroup = document.createElement("div");
  modeGroup.className = "wm-webview-toolbar-modes";

  const chatNarrowBtn = document.createElement("button");
  chatNarrowBtn.className = `wm-webview-mode-btn${currentMode === "chat-narrow" ? " active" : ""}`;
  chatNarrowBtn.title = "Chat narrow, writer wide";
  chatNarrowBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="6" height="18" rx="1"/><rect x="10" y="3" width="12" height="18" rx="1"/></svg>`;
  chatNarrowBtn.addEventListener("click", () => onModeChange("chat-narrow"));

  const appNarrowBtn = document.createElement("button");
  appNarrowBtn.className = `wm-webview-mode-btn${currentMode === "app-narrow" ? " active" : ""}`;
  appNarrowBtn.title = "Chat wide, writer narrow";
  appNarrowBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="12" height="18" rx="1"/><rect x="16" y="3" width="6" height="18" rx="1"/></svg>`;
  appNarrowBtn.addEventListener("click", () => onModeChange("app-narrow"));

  modeGroup.append(chatNarrowBtn, appNarrowBtn);

  const actionsGroup = document.createElement("div");
  actionsGroup.className = "wm-webview-toolbar-actions";

  const closeBtn = document.createElement("button");
  closeBtn.className = "wm-webview-close-btn";
  closeBtn.title = "Close writer";
  closeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  closeBtn.addEventListener("click", onClose);

  actionsGroup.append(closeBtn);
  toolbar.append(modeGroup, actionsGroup);
  return toolbar;
}

/**
 * Create the writer panel for a target file.
 * Loads file content, renders blocks, and polls for external changes.
 *
 * @param {string} sessionId
 * @param {string} targetFile - Absolute path to the target file
 * @param {Object} deps
 * @param {Function} deps.showToast - Toast notification function
 * @returns {{ panel: HTMLElement, cleanup: Function }}
 */
export function createWriterPanel(sessionId, targetFile, deps) {
  const { showToast } = deps;
  const panel = document.createElement("div");
  panel.className = "wm-writer-panel";

  const blocksContainer = document.createElement("div");
  blocksContainer.className = "wm-writer-blocks";
  panel.append(blocksContainer);

  let blocks = [];
  let lastMtimeMs = null;
  let editingIndex = -1;
  let pollTimer = null;
  let destroyed = false;
  let commitInProgress = false;

  // ── File operations ──────────────────────────────────────────

  async function loadFile() {
    try {
      const resp = await fetch(`/api/docs/file/raw?path=${encodeURIComponent(targetFile)}`);
      if (!resp.ok) {
        showError(`Failed to load file: ${resp.statusText}`);
        return null;
      }
      const data = await resp.json();
      const content = data.base64 ? atob(data.base64) : "";
      lastMtimeMs = data.mtimeMs ?? null;
      return content;
    } catch (err) {
      showError(`Failed to load file: ${err.message}`);
      return null;
    }
  }

  async function saveFile(content) {
    try {
      const resp = await fetch("/api/docs/file", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: targetFile,
          base64: btoa(content),
          expectedMtimeMs: lastMtimeMs,
        }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 409) {
          showToast?.("File was modified externally. Reloading...", { duration: 3000 });
          await refreshContent();
          return false;
        }
        showToast?.(`Save failed: ${data.error ?? resp.statusText}`, { variant: "error" });
        return false;
      }
      const result = await resp.json();
      lastMtimeMs = result.mtimeMs ?? lastMtimeMs;
      return true;
    } catch (err) {
      showToast?.(`Save failed: ${err.message}`, { variant: "error" });
      return false;
    }
  }

  // ── Rendering ────────────────────────────────────────────────

  function showError(message) {
    blocksContainer.innerHTML = "";
    const el = document.createElement("div");
    el.className = "wm-writer-error";
    el.textContent = message;
    blocksContainer.append(el);
  }

  function showLoading() {
    blocksContainer.innerHTML = "";
    const el = document.createElement("div");
    el.className = "wm-writer-loading";
    el.textContent = "Loading\u2026";
    blocksContainer.append(el);
  }

  function renderBlocks() {
    blocksContainer.innerHTML = "";
    if (blocks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wm-writer-loading";
      empty.textContent = "Empty document";
      blocksContainer.append(empty);
      return;
    }

    blocks.forEach((block, index) => {
      const wrapper = document.createElement("div");
      wrapper.className = "wm-writer-block";
      if (block.type === "frontmatter") {
        wrapper.classList.add("wm-writer-frontmatter");
      }
      wrapper.dataset.blockIndex = String(index);
      wrapper.dataset.blockType = block.type;

      if (editingIndex === index) {
        renderEditor(wrapper, block, index);
      } else {
        renderView(wrapper, block, index);
      }

      blocksContainer.append(wrapper);
    });
  }

  function renderView(wrapper, block, index) {
    const rendered = document.createElement("div");
    rendered.className = "wm-writer-block__rendered";

    if (block.type === "frontmatter") {
      rendered.innerHTML = `<pre><code>${escapeHtml(block.raw)}</code></pre>`;
    } else if (block.type === "hr") {
      rendered.innerHTML = "<hr />";
    } else {
      rendered.innerHTML = renderMarkdownToHtml(block.raw);
    }

    rendered.addEventListener("click", () => {
      if (editingIndex >= 0 && editingIndex !== index) {
        commitEdit();
      }
      editingIndex = index;
      renderBlocks();
    });

    wrapper.append(rendered);
  }

  function renderEditor(wrapper, block, index) {
    const editor = document.createElement("textarea");
    editor.className = "wm-writer-block__editor";
    editor.value = block.raw;
    editor.spellcheck = true;

    // Auto-height
    function autoResize() {
      editor.style.height = "auto";
      editor.style.height = editor.scrollHeight + "px";
    }

    editor.addEventListener("input", autoResize);

    editor.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit(index);
      }
    });

    editor.addEventListener("blur", () => {
      commitEdit();
    });

    wrapper.append(editor);
    // Focus after append
    requestAnimationFrame(() => {
      autoResize();
      editor.focus();
    });
  }

  // ── Edit operations ──────────────────────────────────────────

  async function commitEdit() {
    if (commitInProgress) return;
    if (editingIndex < 0 || editingIndex >= blocks.length) {
      editingIndex = -1;
      return;
    }
    const editor = blocksContainer.querySelector(".wm-writer-block__editor");
    if (!editor) {
      editingIndex = -1;
      renderBlocks();
      return;
    }

    commitInProgress = true;
    const newRaw = editor.value;
    const changedIndex = editingIndex;
    editingIndex = -1;

    if (newRaw === blocks[changedIndex].raw) {
      commitInProgress = false;
      renderBlocks();
      return;
    }

    // Build the full content with the edited block replaced
    const fullContent = blocks.map((b, idx) =>
      idx === changedIndex ? newRaw : b.raw
    ).join("\n\n");

    const saved = await saveFile(fullContent);
    if (saved) {
      blocks = parseMarkdownBlocks(fullContent);
    }
    commitInProgress = false;
    renderBlocks();
  }

  function cancelEdit(index) {
    editingIndex = -1;
    renderBlocks();
  }

  // ── Polling for external changes ─────────────────────────────

  async function checkForChanges() {
    if (destroyed || editingIndex >= 0) return;
    try {
      const resp = await fetch(`/api/docs/file/raw?path=${encodeURIComponent(targetFile)}`);
      if (!resp.ok) return;
      const data = await resp.json();
      const mtime = data.mtimeMs ?? null;
      if (mtime !== null && lastMtimeMs !== null && mtime !== lastMtimeMs) {
        const content = data.base64 ? atob(data.base64) : "";
        lastMtimeMs = mtime;
        blocks = parseMarkdownBlocks(content);
        renderBlocks();
      }
    } catch {
      // Silently skip poll errors
    }
  }

  async function refreshContent() {
    const content = await loadFile();
    if (content !== null) {
      blocks = parseMarkdownBlocks(content);
      editingIndex = -1;
      renderBlocks();
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(checkForChanges, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────

  function cleanup() {
    destroyed = true;
    stopPolling();
  }

  // Initial load
  showLoading();
  loadFile().then((content) => {
    if (destroyed) return;
    if (content !== null) {
      blocks = parseMarkdownBlocks(content);
      renderBlocks();
      startPolling();
    }
  });

  return { panel, cleanup };
}
