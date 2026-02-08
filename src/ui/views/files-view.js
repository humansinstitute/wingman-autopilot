/**
 * Files view renderer — file browser, preview, git commands, CRUD operations.
 *
 * Depends on: state, file API helpers, file editor, markdown renderer (via DI).
 */

import { createIconSvg, setIconButton, FILE_BROWSER_ICON_DEFS } from "../core/icons.js";
import { copyTextToClipboard } from "../utils/clipboard.js";
import {
  FILES_SHOW_HIDDEN_STORAGE_KEY,
  FILES_BROWSER_SHELVED_STORAGE_KEY,
  FILES_FAVORITES_STORAGE_KEY,
} from "../state/index.js";
import { createWriterPanel } from "../writer/writer-panel.js";

/**
 * Show a small floating agent picker menu anchored to a button.
 * Calls onSelect(agentId) when an agent is chosen, then removes the menu.
 */
function showQuickAgentPicker(anchor, agents, onSelect) {
  // Remove any existing picker
  document.querySelectorAll(".wm-writer-agent-picker").forEach((el) => el.remove());

  const menu = document.createElement("div");
  menu.className = "wm-writer-agent-picker";

  agents.forEach((agent) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "wm-writer-agent-picker__item";
    item.textContent = agent.label || agent.id;
    item.addEventListener("click", () => {
      menu.remove();
      onSelect(agent.id);
    });
    menu.append(item);
  });

  // Position relative to the anchor
  const rect = anchor.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;
  menu.style.zIndex = "1000";

  document.body.append(menu);

  // Close on outside click
  const closeHandler = (e) => {
    if (!menu.contains(e.target) && e.target !== anchor) {
      menu.remove();
      document.removeEventListener("click", closeHandler, true);
    }
  };
  // Delay to avoid immediate close from the button click
  requestAnimationFrame(() => {
    document.addEventListener("click", closeHandler, true);
  });
}

export function initFilesView(deps) {
  const {
    state,
    getCurrentRoute,
    render,
    // File tree / preview
    loadFilesTree,
    loadFilesPreview,
    resetFilesPreview,
    showFilesPreviewUnavailable,
    // File API
    createFilesDirectory,
    createFilesTextFile,
    uploadFilesBinary,
    deleteFilesEntry,
    // File editor (stubs — late-bound)
    openFileEditor,
    canCreateWorktree,
    openWorktreeModal,
    // Directory browser
    openFileTransferDialogForMode,
    // File move
    moveFilesEntry,
    // Session launcher for writer mode
    launchSession,
    getConfig,
    showToast,
  } = deps;

  // ── Active writer panel (persisted across re-renders) ──────────
  let activeFileWriter = null; // { path, panel, cleanup }

  // ── File CRUD helpers ───────────────────────────────────────────

  const promptCreateDirectory = async () => {
    const files = state.files;
    if (files.loading) return;
    const parentPath = files.currentPath;
    const rawName = window.prompt("Folder name", "New Folder");
    const name = rawName?.trim();
    if (!name) return;
    files.loading = true;
    if (getCurrentRoute() === "files") render();
    try {
      const result = await createFilesDirectory(parentPath, name);
      await loadFilesTree(result?.path ?? parentPath);
    } catch (error) {
      files.loading = false;
      if (getCurrentRoute() === "files") render();
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
    if (getCurrentRoute() === "files") render();
    try {
      const result = await createFilesTextFile(parentPath, name, "");
      await loadFilesTree(parentPath);
      if (result?.path) {
        if (result.previewable) {
          void loadFilesPreview(result.path);
        } else {
          resetFilesPreview();
          if (getCurrentRoute() === "files") render();
        }
        void openFileEditor(result.path, result.displayPath ?? null, result.name ?? null);
      }
    } catch (error) {
      files.loading = false;
      if (getCurrentRoute() === "files") render();
      const message = error instanceof Error ? error.message : "Failed to create file";
      window.alert(message);
    }
  };

  const uploadSelectedFile = async (file) => {
    if (!(file instanceof File)) return;
    const files = state.files;
    if (files.loading || files.uploading) return;
    const parentPath = files.currentPath;
    files.uploading = true;
    if (getCurrentRoute() === "files") render();
    try {
      const result = await uploadFilesBinary(parentPath, file);
      await loadFilesTree(parentPath);
      if (result?.path && result.previewable) {
        void loadFilesPreview(result.path);
      }
    } catch (error) {
      files.uploading = false;
      if (getCurrentRoute() === "files") render();
      const message = error instanceof Error ? error.message : "Failed to upload file";
      window.alert(message);
      return;
    }
    files.uploading = false;
    if (getCurrentRoute() === "files") render();
  };

  const promptUploadFile = () => {
    const files = state.files;
    if (files.loading || files.uploading) return;
    const input = document.createElement("input");
    input.type = "file";
    input.hidden = true;
    input.addEventListener("change", () => {
      const [selected] = input.files ?? [];
      if (selected) {
        void uploadSelectedFile(selected);
      }
      input.remove();
    });
    input.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    document.body.append(input);
    input.click();
  };

  // ── Git commands ────────────────────────────────────────────────

  const runGitCommand = async (action) => {
    if (!action) return "cancelled";
    const files = state.files;
    if (files.gitCommandPending) return "cancelled";

    const requiresRepository = action !== "init";
    const gitInfo = files.git;
    const inRepository = Boolean(gitInfo?.isRepository);

    if (requiresRepository && !inRepository) {
      window.alert("Initialize a git repository before running this command.");
      return "cancelled";
    }

    const directory =
      action === "init" && !inRepository ? files.currentPath ?? gitInfo?.repoRoot ?? null : gitInfo?.repoRoot ?? files.currentPath ?? null;

    if (!directory) {
      window.alert("Select a directory before running git commands.");
      return "cancelled";
    }

    const payload = { action, directory };

    if (action === "commit") {
      const rawMessage = window.prompt("Commit message", "");
      if (rawMessage === null) {
        return "cancelled";
      }
      const message = rawMessage.trim();
      if (!message) {
        window.alert("Commit message cannot be empty.");
        return "cancelled";
      }
      payload.message = message;
    } else if (action === "push") {
      const remotePrompt = window.prompt("Remote name (leave blank for tracked remote)", "");
      if (remotePrompt === null) {
        return "cancelled";
      }
      const remote = remotePrompt.trim();
      const defaultBranch =
        gitInfo?.currentBranch && gitInfo.currentBranch !== "HEAD" ? gitInfo.currentBranch : "";
      const branchPrompt = window.prompt("Branch name (leave blank for current tracking branch)", defaultBranch);
      if (branchPrompt === null) {
        return "cancelled";
      }
      const branch = branchPrompt.trim();
      if (remote) {
        payload.remote = remote;
        if (branch) {
          payload.branch = branch;
        }
      }
    } else if (action === "pushUpstream") {
      const remotePrompt = window.prompt("Remote name", "origin");
      if (remotePrompt === null) {
        return "cancelled";
      }
      const remote = remotePrompt.trim() || "origin";
      const defaultBranch =
        gitInfo?.currentBranch && gitInfo.currentBranch !== "HEAD" ? gitInfo.currentBranch : "main";
      const branchPrompt = window.prompt("Branch name", defaultBranch);
      if (branchPrompt === null) {
        return "cancelled";
      }
      const branch = branchPrompt.trim();
      if (!branch) {
        window.alert("Branch name is required to set upstream.");
        return "cancelled";
      }
      payload.remote = remote;
      payload.branch = branch;
    }

    files.gitCommandPending = true;
    if (getCurrentRoute() === "files") {
      render();
    }

    try {
      const response = await fetch("/api/docs/git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      if (!response.ok) {
        const exitCode = typeof data?.exitCode === "number" ? ` (exit ${data.exitCode})` : "";
        const message = typeof data?.error === "string" && data.error.length > 0 ? data.error : "Git command failed";
        throw new Error(`${message}${exitCode}`);
      }

      const stdout = typeof data?.stdout === "string" ? data.stdout.trim() : "";
      const stderr = typeof data?.stderr === "string" ? data.stderr.trim() : "";
      const output = [stdout, stderr].filter((part) => part.length > 0).join("\n");
      window.alert(output || "Git command completed successfully.");

      if (files.currentPath) {
        await loadFilesTree(files.currentPath);
      } else {
        await loadFilesTree();
      }
      return "success";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(message);
      return "error";
    } finally {
      files.gitCommandPending = false;
      if (getCurrentRoute() === "files") {
        render();
      }
    }
  };

  // ── Main renderer ───────────────────────────────────────────────

  const { initFilesFromUrl } = deps;

  const renderFiles = () => {
    const files = state.files;
    if (!files.initialized) {
      files.initialized = true;
      if (typeof initFilesFromUrl === "function") {
        initFilesFromUrl();
      } else {
        void loadFilesTree();
      }
    }

    const wrapper = document.createElement("div");
    wrapper.className = "wm-files";

    const layout = document.createElement("div");
    layout.className = "wm-files-layout";
    if (files.browserShelved) {
      layout.dataset.shelved = "true";
    }

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
    upButton.className = "wm-button secondary wm-button-icon";
    setIconButton(upButton, "arrowUp", "Go up one directory");
    upButton.disabled = files.loading || !files.parent?.path;
    upButton.addEventListener("click", () => {
      if (files.loading) return;
      if (files.parent?.path) {
        void loadFilesTree(files.parent.path);
      }
    });

    // ── Drop target: "Go up" accepts dragged items → moves to parent dir ──
    if (files.parent?.path) {
      upButton.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        upButton.dataset.dragover = "true";
      });
      upButton.addEventListener("dragleave", () => {
        delete upButton.dataset.dragover;
      });
      upButton.addEventListener("drop", async (e) => {
        e.preventDefault();
        delete upButton.dataset.dragover;
        const sourcePath = e.dataTransfer.getData("text/plain");
        if (!sourcePath) return;
        try {
          await moveFilesEntry(sourcePath, files.parent.path, null);
          await loadFilesTree(files.currentPath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to move item";
          window.alert(msg);
        }
      });
    }

    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "wm-button secondary wm-button-icon";
    setIconButton(refreshButton, "refresh", "Refresh directory contents");
    refreshButton.disabled = files.loading;
    refreshButton.addEventListener("click", () => {
      if (files.loading) return;
      void loadFilesTree(files.currentPath);
    });

    const toggleHiddenButton = document.createElement("button");
    toggleHiddenButton.type = "button";
    toggleHiddenButton.className = "wm-button secondary wm-button-icon";
    toggleHiddenButton.disabled = files.loading;
    const syncHiddenButtonIcon = () => {
      const iconKey = files.showHidden ? "eyeOff" : "eye";
      const label = files.showHidden ? "Hide hidden files" : "Show hidden files";
      setIconButton(toggleHiddenButton, iconKey, label);
      toggleHiddenButton.setAttribute("aria-pressed", files.showHidden ? "true" : "false");
    };
    syncHiddenButtonIcon();
    toggleHiddenButton.addEventListener("click", () => {
      if (files.loading) return;
      files.showHidden = !files.showHidden;
      syncHiddenButtonIcon();
      try {
        localStorage.setItem(FILES_SHOW_HIDDEN_STORAGE_KEY, files.showHidden ? "true" : "false");
      } catch {
        // Ignore storage failures
      }
      void loadFilesTree(files.currentPath);
      if (getCurrentRoute() === "files") {
        render();
      }
    });

    const newFolderButton = document.createElement("button");
    newFolderButton.type = "button";
    newFolderButton.className = "wm-button secondary wm-button-icon";
    setIconButton(newFolderButton, "folderPlus", "Create new folder");
    newFolderButton.disabled = files.loading;
    newFolderButton.addEventListener("click", () => {
      if (files.loading) return;
      void promptCreateDirectory();
    });

    const newFileButton = document.createElement("button");
    newFileButton.type = "button";
    newFileButton.className = "wm-button secondary wm-button-icon";
    setIconButton(newFileButton, "filePlus", "Create new file");
    newFileButton.disabled = files.loading;
    newFileButton.addEventListener("click", () => {
      if (files.loading) return;
      void promptCreateFile();
    });

    const uploadButton = document.createElement("button");
    uploadButton.type = "button";
    uploadButton.className = "wm-button secondary wm-button-icon";
    const syncUploadButtonState = () => {
      uploadButton.disabled = files.loading || files.uploading;
      setIconButton(uploadButton, "upload", files.uploading ? "Uploading\u2026" : "Upload file");
      if (files.uploading) {
        uploadButton.dataset.loading = "true";
      } else {
        delete uploadButton.dataset.loading;
      }
    };
    syncUploadButtonState();
    uploadButton.addEventListener("click", () => {
      if (files.loading || files.uploading) return;
      promptUploadFile();
    });

    const gitWrapper = document.createElement("div");
    gitWrapper.className = "wm-files-browser__git";
    const gitSelect = document.createElement("select");
    gitSelect.className = "wm-select";
    gitSelect.setAttribute("aria-label", "Git commands");
    const gitPlaceholder = document.createElement("option");
    gitPlaceholder.value = "";
    gitPlaceholder.textContent = "Git\u2026";
    gitSelect.append(gitPlaceholder);
    const gitOptions = [
      { value: "addAll", label: "git add .", requiresRepo: true },
      { value: "commit", label: "git commit -m", requiresRepo: true },
      { value: "push", label: "git push", requiresRepo: true },
      { value: "pushUpstream", label: "git push -u origin <branch>", requiresRepo: true },
      { value: "init", label: "git init", requiresRepo: false },
    ];
    const repoReady = Boolean(files.git?.isRepository);
    gitOptions.forEach((optionDef) => {
      const option = document.createElement("option");
      option.value = optionDef.value;
      option.textContent = optionDef.label;
      if (optionDef.requiresRepo && !repoReady) {
        option.disabled = true;
      }
      gitSelect.append(option);
    });
    const gitRunButton = document.createElement("button");
    gitRunButton.type = "button";
    gitRunButton.className = "wm-button secondary";
    const updateGitControlsState = () => {
      const disabled = files.loading || files.gitCommandPending;
      gitSelect.disabled = disabled;
      gitRunButton.disabled = disabled || gitSelect.value === "";
      if (files.gitCommandPending) {
        gitRunButton.dataset.loading = "true";
        gitRunButton.textContent = "Running\u2026";
      } else {
        delete gitRunButton.dataset.loading;
        gitRunButton.textContent = "Run";
      }
    };
    updateGitControlsState();
    gitSelect.addEventListener("change", () => {
      updateGitControlsState();
    });
    gitRunButton.addEventListener("click", async () => {
      const action = gitSelect.value;
      if (!action) return;
      const outcome = await runGitCommand(action);
      if (outcome !== "cancelled") {
        gitSelect.value = "";
      }
      updateGitControlsState();
    });
    gitWrapper.append(gitSelect, gitRunButton);

    const shelveButton = document.createElement("button");
    shelveButton.type = "button";
    shelveButton.className = "wm-button secondary wm-button-icon";
    setIconButton(shelveButton, "sidebarClose", "Hide file browser");
    shelveButton.addEventListener("click", () => {
      files.browserShelved = true;
      try {
        localStorage.setItem(FILES_BROWSER_SHELVED_STORAGE_KEY, "true");
      } catch { /* ignore */ }
      if (getCurrentRoute() === "files") render();
    });

    controls.append(
      upButton,
      refreshButton,
      toggleHiddenButton,
      newFolderButton,
      newFileButton,
      uploadButton,
      shelveButton,
      gitWrapper,
    );

    if (canCreateWorktree()) {
      const worktreeButton = document.createElement("button");
      worktreeButton.type = "button";
      worktreeButton.className = "wm-button wm-button-icon";
      setIconButton(worktreeButton, "branchPlus", "Create new worktree");
      worktreeButton.disabled = files.loading || state.files.worktreeModal.submitting;
      worktreeButton.addEventListener("click", () => {
        if (files.loading) return;
        openWorktreeModal();
      });
      if (state.files.worktreeModal.submitting) {
        worktreeButton.dataset.loading = "true";
      }
      controls.append(worktreeButton);
    }

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

        // ── Drag source: every entry is draggable ──
        button.draggable = true;
        button.addEventListener("dragstart", (e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", entry.path);
          e.dataTransfer.setData("application/x-wingman-name", entry.name);
        });

        const name = document.createElement("span");
        name.className = "wm-files-browser__name";
        const iconKey =
          entry.type === "directory"
            ? "folder"
            : entry.previewable
              ? entry.previewFormat === "markdown"
                ? "fileText"
                : "fileCode"
              : "ban";
        const iconDefinition = FILE_BROWSER_ICON_DEFS[iconKey] ?? FILE_BROWSER_ICON_DEFS.file;
        const icon = createIconSvg(iconDefinition);
        const iconWrapper = document.createElement("span");
        iconWrapper.className = "wm-files-browser__icon";
        iconWrapper.setAttribute("aria-hidden", "true");
        iconWrapper.append(icon);
        const label = document.createElement("span");
        label.textContent = entry.name;
        name.append(iconWrapper, label);
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

          // ── Drop target: folders accept dragged items ──
          item.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            item.dataset.dragover = "true";
          });
          item.addEventListener("dragleave", () => {
            delete item.dataset.dragover;
          });
          item.addEventListener("drop", async (e) => {
            e.preventDefault();
            delete item.dataset.dragover;
            const sourcePath = e.dataTransfer.getData("text/plain");
            if (!sourcePath || sourcePath === entry.path) return;
            try {
              await moveFilesEntry(sourcePath, entry.path, null);
              await loadFilesTree(files.currentPath);
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Failed to move item";
              window.alert(msg);
            }
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
          button.addEventListener("click", () => {
            showFilesPreviewUnavailable(entry);
          });
        }

        item.append(button);
        list.append(item);
      });

      if (files.uploading && !files.loading) {
        const uploadingItem = document.createElement("li");
        uploadingItem.className = "wm-files-browser__status";
        uploadingItem.textContent = "Uploading file\u2026";
        list.append(uploadingItem);
      }

      if (files.loading) {
        const loadingItem = document.createElement("li");
        loadingItem.className = "wm-files-browser__status";
        loadingItem.textContent = "Loading\u2026";
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
    if (files.previewLabel) {
      const formatBadge = document.createElement("span");
      formatBadge.className = "wm-files-preview__badge";
      formatBadge.textContent = files.previewLabel;
      previewTitle.append(document.createTextNode(" "), formatBadge);
    }
    previewHeader.append(previewTitle);

    // ── Compact icon toolbar ────────────────────────────────────────
    const toolbar = document.createElement("div");
    toolbar.className = "wm-files-preview__toolbar";
    const hasFileSelection = typeof files.previewPath === "string" && !files.previewLoading;
    const canEdit = hasFileSelection && !files.previewError && files.previewContent !== null;

    /** Helper: create a small icon button for the toolbar */
    function toolbarButton(iconKey, label, extraClass) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wm-files-toolbar-btn" + (extraClass ? " " + extraClass : "");
      setIconButton(btn, iconKey, label);
      return btn;
    }

    // Copy file path
    const copyablePath = files.previewDisplayPath || files.previewPath || null;
    if (copyablePath) {
      const copyPathBtn = toolbarButton("clipboardCopy", "Copy file path");
      copyPathBtn.addEventListener("click", async () => {
        const success = await copyTextToClipboard(copyablePath);
        if (success) {
          copyPathBtn.dataset.copied = "true";
          setTimeout(() => { if (copyPathBtn.isConnected) delete copyPathBtn.dataset.copied; }, 1600);
        }
      });
      toolbar.append(copyPathBtn);
    }

    // Edit file
    if (canEdit) {
      const editBtn = toolbarButton("pencil", "Edit file");
      editBtn.addEventListener("click", () => {
        void openFileEditor(files.previewPath, files.previewDisplayPath ?? null, files.previewName ?? null);
      });
      toolbar.append(editBtn);
    }

    // Writer
    if (canEdit) {
      const writerBtn = toolbarButton("penTool", "Writer");
      writerBtn.addEventListener("click", () => {
        const config = typeof getConfig === "function" ? getConfig() : null;
        const agents = config?.agents ?? [];
        if (agents.length === 0) {
          window.alert("No agents available.");
          return;
        }
        showQuickAgentPicker(writerBtn, agents, (agentId) => {
          if (typeof launchSession === "function") {
            launchSession(agentId, files.currentPath, files.previewName ?? "", null, {
              targetFile: files.previewPath,
            });
          }
        });
      });
      toolbar.append(writerBtn);
    }

    if (hasFileSelection) {
      // Download
      const downloadBtn = toolbarButton("download", "Download file");
      downloadBtn.addEventListener("click", () => {
        const targetPath = typeof files.previewPath === "string" ? files.previewPath : null;
        if (!targetPath) return;
        const downloadUrl = `/api/docs/file/download?path=${encodeURIComponent(targetPath)}`;
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = files.previewName || "";
        a.style.display = "none";
        document.body.append(a);
        a.click();
        a.remove();
      });
      toolbar.append(downloadBtn);

      // Copy URL
      const copyUrlBtn = toolbarButton("link", "Copy URL");
      copyUrlBtn.addEventListener("click", async () => {
        const targetPath = typeof files.previewPath === "string" ? files.previewPath : null;
        if (!targetPath) return;
        const rawUrl = `${window.location.origin}/api/docs/file/raw?path=${encodeURIComponent(targetPath)}`;
        const success = await copyTextToClipboard(rawUrl);
        if (success) {
          copyUrlBtn.dataset.copied = "true";
          setTimeout(() => { if (copyUrlBtn.isConnected) delete copyUrlBtn.dataset.copied; }, 1600);
        } else {
          window.alert("Unable to copy the file URL.");
        }
      });
      toolbar.append(copyUrlBtn);

      // Copy file to…
      const copyToBtn = toolbarButton("clipboardCopy", "Copy file to\u2026");
      copyToBtn.addEventListener("click", () => {
        void openFileTransferDialogForMode("copy");
      });
      toolbar.append(copyToBtn);

      // Move file to…
      const moveToBtn = toolbarButton("arrowRightCircle", "Move file to\u2026");
      moveToBtn.addEventListener("click", () => {
        void openFileTransferDialogForMode("move");
      });
      toolbar.append(moveToBtn);

      // Delete — red destructive
      const deleteBtn = toolbarButton("trash", "Delete file", "wm-files-toolbar-btn--danger");
      deleteBtn.addEventListener("click", async () => {
        const targetPath = typeof files.previewPath === "string" ? files.previewPath : null;
        if (!targetPath) return;
        const displayName = files.previewName ?? files.previewDisplayPath ?? targetPath;
        const confirmed = window.confirm(`Delete "${displayName}"? This cannot be undone.`);
        if (!confirmed) return;
        deleteBtn.disabled = true;
        deleteBtn.dataset.loading = "true";
        try {
          await deleteFilesEntry(targetPath);
          resetFilesPreview();
          render();
          await loadFilesTree(state.files.currentPath);
        } catch (error) {
          deleteBtn.disabled = false;
          delete deleteBtn.dataset.loading;
          const message = error instanceof Error ? error.message : "Failed to delete file";
          window.alert(message);
        }
      });
      toolbar.append(deleteBtn);
    }

    if (toolbar.childElementCount > 0) {
      previewHeader.append(toolbar);
    }

    const previewBody = document.createElement("div");
    previewBody.className = "wm-files-preview__body";

    // Clean up stale writer panel when file changes or view state changes
    const shouldHaveWriter = !files.previewLoading && !files.previewError && files.previewContent !== null;
    if (activeFileWriter && (!shouldHaveWriter || activeFileWriter.path !== files.previewPath)) {
      activeFileWriter.cleanup();
      activeFileWriter = null;
    }

    if (files.previewLoading) {
      previewBody.dataset.loading = "true";
      previewBody.textContent = "Loading preview\u2026";
    } else if (files.previewError) {
      const error = document.createElement("div");
      error.className = "wm-files-browser__status";
      error.textContent = files.previewError;
      previewBody.append(error);
    } else if (files.previewContent !== null) {
      // Reuse existing writer panel if same file, otherwise create a new one
      if (activeFileWriter && activeFileWriter.path === files.previewPath) {
        previewBody.append(activeFileWriter.panel);
      } else {
        const { panel: writerEl, cleanup } = createWriterPanel(null, files.previewPath, { showToast });
        activeFileWriter = { path: files.previewPath, panel: writerEl, cleanup };
        previewBody.append(writerEl);
      }
    } else {
      previewBody.dataset.empty = "true";
      previewBody.textContent = "Select a previewable file to view.";
    }

    previewCard.append(previewHeader, previewBody);

    // Shelve/unshelve: hide browser card and show floating unshelve button
    if (files.browserShelved) {
      browserCard.style.display = "none";
      const unshelveButton = document.createElement("button");
      unshelveButton.type = "button";
      unshelveButton.className = "wm-button secondary wm-button-icon wm-files-unshelve";
      setIconButton(unshelveButton, "sidebarOpen", "Show file browser");
      unshelveButton.addEventListener("click", () => {
        files.browserShelved = false;
        try {
          localStorage.setItem(FILES_BROWSER_SHELVED_STORAGE_KEY, "false");
        } catch { /* ignore */ }
        if (getCurrentRoute() === "files") render();
      });
      previewCard.prepend(unshelveButton);
    }

    layout.append(browserCard, previewCard);
    wrapper.append(layout);
    return wrapper;
  };

  return { renderFiles };
}
