/**
 * Image and file attachment handling — thumbnails, previews, upload flows.
 *
 * Depends on: state.messageDrafts, getSessionById (via DI).
 */

export function initImageAttachments(deps) {
  const { state, getSessionById, showToast } = deps;

  const ensureImageAttachmentDrafts = () => {
    if (!(state.imageAttachmentDrafts instanceof Map)) {
      state.imageAttachmentDrafts = new Map();
    }
    return state.imageAttachmentDrafts;
  };

  // ── Text cursor helper ──────────────────────────────────────────

  const insertTextAtCursor = (textarea, text, sessionId) => {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const next = before + text + after;
    const nextCursor = start + text.length;
    textarea.value = next;
    textarea.selectionStart = textarea.selectionEnd = nextCursor;
    state.messageDrafts.set(sessionId, next);
  };

  // ── Thumbnail generation ────────────────────────────────────────

  const createThumbnail = (file, maxSize = 80) => {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const img = new Image();

      img.onload = () => {
        let { width, height } = img;
        if (width > height) {
          if (width > maxSize) {
            height = (height * maxSize) / width;
            width = maxSize;
          }
        } else {
          if (height > maxSize) {
            width = (width * maxSize) / height;
            height = maxSize;
          }
        }

        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob((blob) => {
          resolve(URL.createObjectURL(blob));
        }, 'image/jpeg', 0.8);
      };

      img.onerror = () => resolve(null);
      img.src = URL.createObjectURL(file);
    });
  };

  const createAttachmentId = () => `img_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

  const removeUploadMarkerFromText = (text, markerId) => {
    const marker = `<!--IMG:${markerId}-->`;
    return String(text ?? "").replace(marker, '');
  };

  const findUploadMarkerInText = (text, markerId) => {
    const marker = `<!--IMG:${markerId}-->`;
    return String(text ?? "").indexOf(marker);
  };

  const removeUploadPlaceholderFromText = (text, markerId, fallbackPlaceholder) => {
    if (!markerId) {
      return String(text ?? "").replace(fallbackPlaceholder, '');
    }
    return String(text ?? "").replace(`<!--IMG:${markerId}-->[Uploading...]`, '');
  };

  const removeAttachmentReferenceFromText = (text, attachment) => {
    let nextText = removeUploadMarkerFromText(text, attachment.id);
    if (attachment.placeholder) {
      nextText = nextText.replace(attachment.placeholder, '');
    }
    if (attachment.publicPath && attachment.publicPath !== attachment.placeholder) {
      nextText = nextText.replace(attachment.publicPath, '');
    }
    return nextText;
  };

  const getSessionAttachments = (sessionId) => {
    const drafts = ensureImageAttachmentDrafts();
    return drafts.get(sessionId) ?? [];
  };

  const setSessionAttachments = (sessionId, attachments) => {
    const drafts = ensureImageAttachmentDrafts();
    const nextAttachments = Array.isArray(attachments) ? attachments : [];
    if (nextAttachments.length > 0) {
      drafts.set(sessionId, nextAttachments);
    } else {
      drafts.delete(sessionId);
    }
  };

  const upsertSessionAttachment = (sessionId, attachment) => {
    const attachments = getSessionAttachments(sessionId);
    const index = attachments.findIndex((item) => item.id === attachment.id);
    const next = index === -1
      ? [...attachments, attachment]
      : attachments.map((item) => item.id === attachment.id ? { ...item, ...attachment } : item);
    setSessionAttachments(sessionId, next);
  };

  const removeSessionAttachment = (sessionId, markerId) => {
    const attachments = getSessionAttachments(sessionId);
    const removed = attachments.find((item) => item.id === markerId);
    const next = attachments.filter((item) => item.id !== markerId);
    setSessionAttachments(sessionId, next);
    if (removed?.objectUrl) {
      URL.revokeObjectURL(removed.objectUrl);
    }
  };

  const getImagePreviewContainer = (sessionId) => {
    const composerShell = document.querySelector(`.wm-composer-shell[data-session-id="${sessionId}"]`);
    return composerShell?.querySelector('.wm-image-preview-container') ?? null;
  };

  const openImagePreviewModal = (attachment) => {
    const imageSrc = attachment.publicPath || attachment.objectUrl;
    if (!imageSrc) return;

    const existing = document.querySelector('.wm-image-preview-dialog');
    if (existing instanceof HTMLDialogElement) {
      existing.close();
      existing.remove();
    }

    const dialog = document.createElement('dialog');
    dialog.className = 'wm-image-preview-dialog';
    dialog.dataset.testid = 'image-preview-modal';
    dialog.setAttribute('aria-labelledby', 'image-preview-title');
    const panel = document.createElement('div');
    panel.className = 'wm-image-preview-dialog__panel';
    const header = document.createElement('header');
    header.className = 'wm-image-preview-dialog__header';
    const title = document.createElement('h2');
    title.id = 'image-preview-title';
    title.textContent = 'Image preview';
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'wm-image-preview-dialog__close';
    closeButton.setAttribute('aria-label', 'Close image preview');
    closeButton.dataset.testid = 'image-preview-close';
    closeButton.textContent = '\u00d7';
    const body = document.createElement('div');
    body.className = 'wm-image-preview-dialog__body';
    const image = document.createElement('img');
    image.src = imageSrc;
    image.alt = attachment.name || 'Uploaded image preview';
    image.dataset.testid = 'image-preview-full-image';
    header.append(title, closeButton);
    body.append(image);
    panel.append(header, body);
    dialog.append(panel);

    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) {
        dialog.close();
      }
    });
    closeButton.addEventListener('click', () => {
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
    });

    document.body.append(dialog);
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', 'open');
    }
  };

  const syncPreviewContainerVisibility = (container) => {
    if (!container) return;
    container.hidden = container.children.length === 0;
  };

  const createPreviewItem = (sessionId, attachment) => {
    const previewItem = document.createElement('div');
    previewItem.className = 'wm-image-preview-item';
    previewItem.dataset.attachmentId = attachment.id;
    previewItem.dataset.testid = 'image-attachment-thumbnail';

    const previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.className = 'wm-image-preview-thumb';
    previewButton.setAttribute('aria-label', `Open ${attachment.name || 'uploaded image'} preview`);
    previewButton.dataset.testid = 'image-attachment-open';

    const img = document.createElement('img');
    img.src = attachment.publicPath || attachment.objectUrl || '';
    img.alt = attachment.name || 'Uploaded image';
    img.loading = 'lazy';
    previewButton.append(img);
    previewButton.addEventListener('click', () => {
      openImagePreviewModal(attachment);
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'wm-image-preview-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.title = 'Remove image';
    removeBtn.setAttribute('aria-label', `Remove ${attachment.name || 'uploaded image'}`);
    removeBtn.dataset.testid = 'image-attachment-remove';
    removeBtn.addEventListener('click', () => {
      const composerShell = document.querySelector(`.wm-composer-shell[data-session-id="${sessionId}"]`);
      const textarea = composerShell?.querySelector('textarea');
      if (textarea) {
        const nextText = removeAttachmentReferenceFromText(textarea.value, attachment);
        textarea.value = nextText;
        state.messageDrafts.set(sessionId, nextText);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      removeSessionAttachment(sessionId, attachment.id);
      renderImagePreviews(sessionId);
    });

    previewItem.append(previewButton, removeBtn);
    return previewItem;
  };

  function renderImagePreviews(sessionId) {
    const previewContainer = getImagePreviewContainer(sessionId);
    if (!previewContainer) return;
    previewContainer.replaceChildren();
    for (const attachment of getSessionAttachments(sessionId)) {
      previewContainer.append(createPreviewItem(sessionId, attachment));
    }
    syncPreviewContainerVisibility(previewContainer);
  }

  // ── Preview DOM helper ──────────────────────────────────────────

  const addImagePreview = (sessionId, file, thumbnailUrl) => {
    const markerId = createAttachmentId();
    upsertSessionAttachment(sessionId, {
      id: markerId,
      name: file?.name || 'uploaded image',
      objectUrl: thumbnailUrl,
      publicPath: null,
      status: 'uploading',
    });
    renderImagePreviews(sessionId);
    return markerId;
  };

  // ── Public helpers ──────────────────────────────────────────────

  const clearImagePreviews = (sessionId) => {
    for (const attachment of getSessionAttachments(sessionId)) {
      if (attachment.objectUrl) {
        URL.revokeObjectURL(attachment.objectUrl);
      }
    }
    setSessionAttachments(sessionId, []);
    const previewContainer = getImagePreviewContainer(sessionId);
    if (previewContainer) {
      previewContainer.replaceChildren();
      syncPreviewContainerVisibility(previewContainer);
    }
  };

  const prepareImagePreviewsForComposer = (sessionId) => {
    renderImagePreviews(sessionId);
  };

  const extractImageFiles = (items) => {
    if (!items) return [];
    const files = [];
    for (const item of Array.from(items)) {
      if (!item) continue;
      if (item.kind === "file") {
        const file = item.getAsFile?.() ?? item;
        if (file instanceof File && file.type?.startsWith?.("image/")) {
          files.push(file);
        }
      } else if (item instanceof File || item instanceof Blob) {
        if (item.type?.startsWith?.("image/")) {
          files.push(item);
        }
      }
    }
    return files;
  };

  const extractAttachmentFiles = (items) => {
    if (!items) return [];
    const files = [];
    for (const item of Array.from(items)) {
      if (!item) continue;
      if (item.kind === "file") {
        const file = item.getAsFile?.() ?? item;
        if (file instanceof File && !file.type?.startsWith?.("image/")) {
          files.push(file);
        }
      } else if (item instanceof File || item instanceof Blob) {
        if (!item.type || !item.type.startsWith("image/")) {
          files.push(item);
        }
      }
    }
    return files;
  };

  // ── Upload flows ────────────────────────────────────────────────

  const handleImageUploads = async (sessionId, files, textarea, resizeTextarea, setUploadingState) => {
    if (!files || files.length === 0) return;
    const session = getSessionById(sessionId);
    if (!session) {
      showToast?.("Unable to locate session for image upload.", { type: "error" });
      return;
    }

    for (const file of files) {
      if (!file?.type?.startsWith?.("image/")) {
        continue;
      }

      const thumbnailUrl = await createThumbnail(file);
      let markerId = null;
      if (thumbnailUrl) {
        markerId = addImagePreview(sessionId, file, thumbnailUrl);
      }

      const marker = markerId ? `<!--IMG:${markerId}-->` : '';
      const uploadingPlaceholder = markerId ? `${marker}[Uploading...]` : "[Uploading...]";
      const uploadText = textarea.value.endsWith("\n") ? `${uploadingPlaceholder}\n` : `\n${uploadingPlaceholder}\n`;
      insertTextAtCursor(textarea, uploadText, sessionId);
      resizeTextarea();

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
          const errorText = data?.error || response.statusText || "Unknown error";
          const message = `Image upload failed (${response.status}): ${errorText}`;
          console.error("[image-upload]", message, { status: response.status, data });
          showToast?.(message, { type: "error" });
          const currentValue = textarea.value;
          const markerIndex = markerId ? findUploadMarkerInText(currentValue, markerId) : currentValue.lastIndexOf(uploadingPlaceholder);
          if (markerIndex !== -1) {
            const newText = removeUploadPlaceholderFromText(currentValue, markerId, uploadingPlaceholder);
            textarea.value = newText;
            state.messageDrafts.set(sessionId, textarea.value);
          }

          if (thumbnailUrl && markerId) {
            removeSessionAttachment(sessionId, markerId);
            renderImagePreviews(sessionId);
          } else if (thumbnailUrl) {
            URL.revokeObjectURL(thumbnailUrl);
          }
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
          showToast?.("Image upload succeeded without a usable reference.", { type: "error" });
          const currentValue = textarea.value;
          const markerIndex = markerId ? findUploadMarkerInText(currentValue, markerId) : currentValue.lastIndexOf(uploadingPlaceholder);
          if (markerIndex !== -1) {
            const newText = removeUploadPlaceholderFromText(currentValue, markerId, uploadingPlaceholder);
            textarea.value = newText;
            state.messageDrafts.set(sessionId, textarea.value);
          }

          if (thumbnailUrl && markerId) {
            removeSessionAttachment(sessionId, markerId);
            renderImagePreviews(sessionId);
          } else if (thumbnailUrl) {
            URL.revokeObjectURL(thumbnailUrl);
          }
          continue;
        }

        const currentValue = textarea.value;
        const markerIndex = markerId ? findUploadMarkerInText(currentValue, markerId) : currentValue.lastIndexOf(uploadingPlaceholder);
        if (markerIndex !== -1) {
          const markerStr = markerId ? `<!--IMG:${markerId}-->[Uploading...]` : uploadingPlaceholder;
          const beforePlaceholder = currentValue.substring(0, markerIndex);
          const afterPlaceholder = currentValue.substring(markerIndex + markerStr.length);
          textarea.value = beforePlaceholder + placeholder + afterPlaceholder;
          state.messageDrafts.set(sessionId, textarea.value);
        }

        if (thumbnailUrl && markerId) {
          const attachments = getSessionAttachments(sessionId);
          const existing = attachments.find((item) => item.id === markerId);
          if (existing?.objectUrl) {
            URL.revokeObjectURL(existing.objectUrl);
          }
          upsertSessionAttachment(sessionId, {
            ...(existing ?? { id: markerId, name: file?.name || 'uploaded image' }),
            objectUrl: null,
            publicPath: payload.publicPath || placeholder,
            placeholder,
            status: 'uploaded',
          });
          renderImagePreviews(sessionId);
        } else if (thumbnailUrl) {
          URL.revokeObjectURL(thumbnailUrl);
        }

        resizeTextarea();
        textarea.focus({ preventScroll: true });
      } catch (error) {
        console.error("Failed to upload image", error);
        showToast?.("Image upload failed. Check console for details.", { type: "error" });
      } finally {
        setUploadingState(false);
      }
    }
  };

  const uploadLiveAttachment = async (agentId, file) => {
    const form = new FormData();
    form.append("agent", agentId);
    form.append("file", file, file.name);

    const response = await fetch("/api/uploads/files", {
      method: "POST",
      body: form,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const message = data?.error ?? response.statusText ?? "File upload failed";
      throw new Error(message);
    }

    const data = await response.json().catch(() => ({}));
    const first = Array.isArray(data?.files) ? data.files[0] : null;
    if (!first) {
      throw new Error("Upload succeeded without file details");
    }
    return first;
  };

  const handleAttachmentUploads = async (sessionId, files, textarea, resizeTextarea, setUploadingState) => {
    if (!files || files.length === 0) return;
    const session = getSessionById(sessionId);
    if (!session) {
      showToast?.("Unable to locate session for file upload.", { type: "error" });
      return;
    }

    for (const file of files) {
      setUploadingState(true);
      try {
        const payload = await uploadLiveAttachment(session.agent, file);
        const placeholder = typeof payload?.placeholder === "string" ? payload.placeholder : null;
        const fallback =
          typeof payload?.publicPath === "string"
            ? payload.publicPath
            : typeof payload?.absolutePath === "string"
              ? payload.absolutePath
              : "";
        const reference = placeholder || fallback;
        if (!reference) {
          showToast?.("File upload succeeded without a usable reference.", { type: "error" });
          continue;
        }
        const needsPrefix = textarea.value.length > 0 && !textarea.value.endsWith("\n");
        const textToInsert = needsPrefix ? `\n${reference}\n` : `${reference}\n`;
        insertTextAtCursor(textarea, textToInsert, sessionId);
        resizeTextarea();
        textarea.focus({ preventScroll: true });
      } catch (error) {
        console.error("Failed to upload file", error);
        const message = error instanceof Error ? error.message : "File upload failed. Check console for details.";
        showToast?.(message, { type: "error" });
      } finally {
        setUploadingState(false);
      }
    }
  };

  /**
   * Remove orphaned image markers — called from textarea input handler
   * when user deletes marker text manually.
   */
  const cleanupOrphanedMarkers = (_sessionId, _text) => {
    return;
  };

  return {
    insertTextAtCursor,
    createThumbnail,
    addImagePreview,
    clearImagePreviews,
    prepareImagePreviewsForComposer,
    extractImageFiles,
    extractAttachmentFiles,
    handleImageUploads,
    handleAttachmentUploads,
    cleanupOrphanedMarkers,
  };
}
