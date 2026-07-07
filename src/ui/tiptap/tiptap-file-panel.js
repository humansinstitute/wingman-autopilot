import { Editor } from "/vendor/@tiptap/core";
import { createAutopilotTiptapExtensions } from "./extensions.js";
import {
  inspectMarkdownForRichEditing,
  markdownToProseMirrorDoc,
  proseMirrorDocToMarkdown,
} from "./markdown-codecs.js";
import {
  decodeBase64ToUint8Array,
  decodeBytesToText,
  encodeTextToBytes,
  encodeUint8ArrayToBase64,
} from "../core/encoding.js";
import { createTiptapToolbar } from "./toolbar.js";
import {
  getParentDirectory,
  rewriteImageSourcesForDisplay,
  toDisplayImageSrc,
} from "./file-paths.js";

const POLL_INTERVAL_MS = 2500;

function guessImageExtension(mimeType) {
  const mime = String(mimeType ?? "").toLowerCase();
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  if (mime === "image/svg+xml") return "svg";
  return "png";
}

function createPastedImageFilename(file) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const random = Math.random().toString(36).slice(2, 8);
  return `pasted-image-${stamp}-${random}.${guessImageExtension(file?.type)}`;
}

export function createTiptapFilePanel(sessionId, targetFile, deps = {}) {
  const { showToast } = deps;
  const panel = document.createElement("section");
  panel.className = "wm-writer-panel wm-tiptap-panel";
  panel.dataset.testid = "tiptap-file-panel";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Markdown file editor");
  if (sessionId) panel.dataset.sessionId = sessionId;

  let editor = null;
  let sourceEditor = null;
  let rawContent = "";
  let initialContent = "";
  let lastMtimeMs = null;
  let mode = "rich";
  let dirty = false;
  let saving = false;
  let destroyed = false;
  let pollTimer = null;
  let warning = null;
  let error = null;
  let statusMessage = "";
  let statusType = "info";
  const fileDirectory = getParentDirectory(targetFile);

  function setStatus(message, type = "info") {
    statusMessage = message || "";
    statusType = type;
    const status = panel.querySelector("[data-tiptap-status]");
    if (!status) return;
    status.textContent = statusMessage;
    status.dataset.type = statusType;
    status.hidden = !statusMessage;
  }

  async function loadFile() {
    const response = await fetch(`/api/docs/file/raw?path=${encodeURIComponent(targetFile)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || response.statusText || "Failed to load file");
    }
    lastMtimeMs = typeof data?.mtimeMs === "number" ? data.mtimeMs : null;
    return data?.base64 ? decodeBytesToText(decodeBase64ToUint8Array(data.base64)) : "";
  }

  async function saveFile(content) {
    saving = true;
    render();
    const response = await fetch("/api/docs/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: targetFile,
        base64: encodeUint8ArrayToBase64(encodeTextToBytes(content)),
        expectedMtimeMs: lastMtimeMs,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error || response.statusText || "Failed to save file";
      throw new Error(message);
    }
    lastMtimeMs = typeof data?.mtimeMs === "number" ? data.mtimeMs : lastMtimeMs;
  }

  function getCurrentMarkdown() {
    if (mode === "source") return sourceEditor?.value ?? rawContent;
    if (!editor) return rawContent;
    return proseMirrorDocToMarkdown(editor.getJSON());
  }

  async function uploadPastedImage(file) {
    const uploadName = createPastedImageFilename(file);
    const base64 = encodeUint8ArrayToBase64(new Uint8Array(await file.arrayBuffer()));
    const response = await fetch("/api/docs/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        directory: fileDirectory,
        name: uploadName,
        base64,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || response.statusText || "Failed to upload pasted image");
    }
    return data?.name || uploadName;
  }

  function handlePaste(event, activeEditor) {
    const items = Array.from(event.clipboardData?.items ?? []);
    const images = items
      .filter((item) => item.kind === "file" && String(item.type || "").startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file) => file instanceof File);
    if (images.length === 0) return false;

    event.preventDefault();
    void (async () => {
      let uploaded = 0;
      for (const image of images) {
        try {
          const savedName = await uploadPastedImage(image);
          activeEditor.chain().focus().setImage({
            src: toDisplayImageSrc(fileDirectory, savedName),
            rawSrc: savedName,
            alt: savedName,
          }).run();
          uploaded += 1;
        } catch (uploadError) {
          showToast?.(uploadError instanceof Error ? uploadError.message : "Failed to upload pasted image", { type: "error" });
        }
      }
      if (uploaded > 0) {
        dirty = true;
        render();
        showToast?.(`Uploaded ${uploaded} image${uploaded > 1 ? "s" : ""}`, { duration: 2000 });
      }
    })();
    return true;
  }

  function createEditor(mount) {
    const markdownInfo = inspectMarkdownForRichEditing(rawContent);
    warning = markdownInfo.risky
      ? `Rich mode may normalize ${markdownInfo.reasons.join(", ")}. Use Source before saving if exact Markdown formatting matters.`
      : null;
    const content = rewriteImageSourcesForDisplay(markdownToProseMirrorDoc(rawContent), fileDirectory);
    editor = new Editor({
      element: mount,
      extensions: createAutopilotTiptapExtensions({ placeholder: "Start writing..." }),
      content,
      editorProps: {
        attributes: {
          "aria-label": "Markdown rich editor",
          "data-testid": "tiptap-editor",
        },
        handlePaste: (_view, event) => handlePaste(event, editor),
      },
      onUpdate() {
        rawContent = proseMirrorDocToMarkdown(editor.getJSON());
        dirty = rawContent !== initialContent;
        updateControls();
      },
      onFocus() {
        stopPolling();
      },
      onBlur() {
        if (!dirty) startPolling();
      },
    });
  }

  function updateControls() {
    const saveButton = panel.querySelector("[data-testid='tiptap-save-button']");
    if (saveButton instanceof HTMLButtonElement) {
      saveButton.disabled = saving || !dirty;
      saveButton.textContent = saving ? "Saving..." : dirty ? "Save" : "Saved";
    }
  }

  function destroyEditor() {
    if (editor) {
      editor.destroy();
      editor = null;
    }
  }

  async function handleSave() {
    if (saving || !dirty) return;
    const nextContent = getCurrentMarkdown();
    try {
      await saveFile(nextContent);
      rawContent = nextContent;
      initialContent = nextContent;
      dirty = false;
      saving = false;
      error = null;
      setStatus("Saved", "success");
      render();
      startPolling();
    } catch (saveError) {
      saving = false;
      const message = saveError instanceof Error ? saveError.message : "Failed to save file";
      error = /changed since it was loaded/i.test(message)
        ? "This file changed on disk. Copy your draft or reload before saving."
        : message;
      render();
    }
  }

  function toggleMode() {
    rawContent = getCurrentMarkdown();
    mode = mode === "source" ? "rich" : "source";
    render();
  }

  function renderConflictActions(container) {
    const actions = document.createElement("div");
    actions.className = "wm-tiptap-conflict__actions";

    const reloadButton = document.createElement("button");
    reloadButton.type = "button";
    reloadButton.className = "wm-button secondary";
    reloadButton.textContent = "Reload";
    reloadButton.addEventListener("click", () => {
      void refreshContent();
    });

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "wm-button secondary";
    copyButton.textContent = "Copy draft";
    copyButton.addEventListener("click", async () => {
      await navigator.clipboard?.writeText(getCurrentMarkdown());
      showToast?.("Draft copied", { duration: 1600 });
    });

    actions.append(reloadButton, copyButton);
    container.append(actions);
  }

  function render() {
    if (destroyed) return;
    destroyEditor();
    panel.innerHTML = "";
    const markdownInfo = inspectMarkdownForRichEditing(rawContent);
    warning = markdownInfo.risky
      ? `Rich mode may normalize ${markdownInfo.reasons.join(", ")}. Use Source before saving if exact Markdown formatting matters.`
      : null;

    const status = document.createElement("div");
    status.className = "wm-tiptap-status";
    status.dataset.tiptapStatus = "true";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = statusMessage;
    status.dataset.type = statusType;
    status.hidden = !statusMessage;
    panel.append(status);

    if (error) {
      const conflict = document.createElement("div");
      conflict.className = "wm-tiptap-conflict";
      conflict.dataset.testid = "tiptap-conflict-banner";
      conflict.setAttribute("role", "alert");
      conflict.textContent = error;
      if (/changed on disk/i.test(error)) renderConflictActions(conflict);
      panel.append(conflict);
    } else if (warning) {
      const warningEl = document.createElement("div");
      warningEl.className = "wm-tiptap-warning";
      warningEl.textContent = warning;
      panel.append(warningEl);
    }

    const body = document.createElement("div");
    body.className = "wm-tiptap-body";
    panel.append(body);

    if (mode === "source") {
      sourceEditor = document.createElement("textarea");
      sourceEditor.className = "wm-tiptap-source";
      sourceEditor.dataset.testid = "tiptap-source-editor";
      sourceEditor.setAttribute("aria-label", "Markdown source editor");
      sourceEditor.spellcheck = false;
      sourceEditor.value = rawContent;
      sourceEditor.addEventListener("input", () => {
        rawContent = sourceEditor.value;
        dirty = rawContent !== initialContent;
        updateControls();
      });
      body.append(sourceEditor);
    } else {
      sourceEditor = null;
      const mount = document.createElement("div");
      mount.className = "wm-tiptap-editor";
      mount.dataset.testid = "tiptap-editor-mount";
      body.append(mount);
      createEditor(mount);
    }

    const toolbar = createTiptapToolbar({
      editor,
      mode,
      dirty,
      saving,
      onSave: () => void handleSave(),
      onToggleMode: toggleMode,
    });
    panel.insertBefore(toolbar, body);
    updateControls();
  }

  async function checkForChanges() {
    if (destroyed || dirty || saving) return;
    try {
      const response = await fetch(`/api/docs/file/raw?path=${encodeURIComponent(targetFile)}`);
      if (!response.ok) return;
      const data = await response.json();
      const mtime = typeof data?.mtimeMs === "number" ? data.mtimeMs : null;
      if (mtime !== null && lastMtimeMs !== null && Math.abs(mtime - lastMtimeMs) > 1) {
        const content = data.base64 ? decodeBytesToText(decodeBase64ToUint8Array(data.base64)) : "";
        lastMtimeMs = mtime;
        rawContent = content;
        initialContent = content;
        setStatus("Reloaded external changes", "info");
        render();
      }
    } catch {
      // Polling is opportunistic.
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

  async function refreshContent() {
    try {
      error = null;
      rawContent = await loadFile();
      initialContent = rawContent;
      dirty = false;
      render();
      startPolling();
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : "Failed to load file";
      render();
    }
  }

  void refreshContent();

  return {
    panel,
    cleanup() {
      destroyed = true;
      stopPolling();
      destroyEditor();
    },
  };
}
