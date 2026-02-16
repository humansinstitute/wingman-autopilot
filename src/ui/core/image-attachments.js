/**
 * Image and file attachment handling — thumbnails, previews, upload flows.
 *
 * Depends on: state.messageDrafts, getSessionById (via DI).
 */

export function initImageAttachments(deps) {
  const { state, getSessionById } = deps;

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

  // ── Preview tracker ─────────────────────────────────────────────

  const imagePreviewTracker = {
    // sessionId -> Map<markerId, {previewElement, thumbnailUrl}>
    previews: new Map(),

    add: (sessionId, markerId, previewElement, thumbnailUrl) => {
      if (!imagePreviewTracker.previews.has(sessionId)) {
        imagePreviewTracker.previews.set(sessionId, new Map());
      }
      imagePreviewTracker.previews.get(sessionId).set(markerId, {
        previewElement,
        thumbnailUrl
      });
    },

    remove: (sessionId, markerId) => {
      const sessionPreviews = imagePreviewTracker.previews.get(sessionId);
      if (sessionPreviews) {
        const previewData = sessionPreviews.get(markerId);
        if (previewData) {
          previewData.previewElement.remove();
          URL.revokeObjectURL(previewData.thumbnailUrl);
          sessionPreviews.delete(markerId);
        }

        const composerShell = document.querySelector(`.wm-composer-shell[data-session-id="${sessionId}"]`);
        const previewContainer = composerShell?.querySelector('.wm-image-preview-container');
        if (previewContainer && sessionPreviews.size === 0) {
          previewContainer.style.display = 'none';
        }
      }
    },

    clear: (sessionId) => {
      const composerShell = document.querySelector(`.wm-composer-shell[data-session-id="${sessionId}"]`);
      const sessionPreviews = imagePreviewTracker.previews.get(sessionId);

      if (sessionPreviews) {
        const textarea = composerShell?.querySelector('textarea');
        if (textarea) {
          let cleanText = textarea.value;
          sessionPreviews.forEach((_, markerId) => {
            cleanText = imagePreviewTracker.removeMarkerFromText(cleanText, markerId);
          });
          textarea.value = cleanText;
          state.messageDrafts.set(sessionId, cleanText);
        }

        sessionPreviews.forEach((previewData, markerId) => {
          previewData.previewElement.remove();
          URL.revokeObjectURL(previewData.thumbnailUrl);
        });
        sessionPreviews.clear();

        const previewContainer = composerShell?.querySelector('.wm-image-preview-container');
        if (previewContainer) {
          previewContainer.style.display = 'none';
        }
      }
    },

    findMarkerInText: (text, markerId) => {
      const marker = `<!--IMG:${markerId}-->`;
      return text.indexOf(marker);
    },

    removeMarkerFromText: (text, markerId) => {
      const marker = `<!--IMG:${markerId}-->`;
      return text.replace(marker, '');
    }
  };

  // ── Preview DOM helper ──────────────────────────────────────────

  const addImagePreview = (sessionId, file, thumbnailUrl) => {
    const composerShell = document.querySelector(`.wm-composer-shell[data-session-id="${sessionId}"]`);
    if (!composerShell) return;

    const previewContainer = composerShell.querySelector('.wm-image-preview-container');
    if (!previewContainer) return;

    const markerId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const previewItem = document.createElement('div');
    previewItem.className = 'wm-image-preview-item';
    previewItem.style.cssText = `
      position: relative;
      display: inline-block;
      border-radius: 4px;
      overflow: hidden;
      border: 1px solid #e1e5e9;
      background: #f8f9fa;
    `;

    const img = document.createElement('img');
    img.src = thumbnailUrl;
    img.style.cssText = `
      width: 80px;
      height: 80px;
      object-fit: cover;
      display: block;
    `;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.innerHTML = '\u00d7';
    removeBtn.style.cssText = `
      position: absolute;
      top: 2px;
      right: 2px;
      width: 20px;
      height: 20px;
      border: none;
      background: rgba(0, 0, 0, 0.7);
      color: white;
      border-radius: 50%;
      cursor: pointer;
      font-size: 14px;
      font-weight: bold;
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    removeBtn.title = 'Remove image';

    removeBtn.addEventListener('click', () => {
      const textarea = composerShell.querySelector('textarea');
      if (textarea) {
        const currentText = textarea.value;
        const markerIndex = imagePreviewTracker.findMarkerInText(currentText, markerId);
        if (markerIndex !== -1) {
          const newText = imagePreviewTracker.removeMarkerFromText(currentText, markerId);
          textarea.value = newText;
          state.messageDrafts.set(sessionId, newText);
          // Trigger resize if available
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      imagePreviewTracker.remove(sessionId, markerId);
    });

    previewItem.append(img, removeBtn);
    previewContainer.append(previewItem);
    previewContainer.style.display = 'flex';

    imagePreviewTracker.add(sessionId, markerId, previewItem, thumbnailUrl);

    return markerId;
  };

  // ── Public helpers ──────────────────────────────────────────────

  const clearImagePreviews = (sessionId) => {
    imagePreviewTracker.clear(sessionId);
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
      window.alert("Unable to locate session for image upload.");
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
          window.alert(message);
          const currentValue = textarea.value;
          const markerIndex = markerId ? imagePreviewTracker.findMarkerInText(currentValue, markerId) : currentValue.lastIndexOf(uploadingPlaceholder);
          if (markerIndex !== -1) {
            const newText = markerId ? imagePreviewTracker.removeMarkerFromText(currentValue, markerId) : currentValue.replace(uploadingPlaceholder, '');
            textarea.value = newText;
            state.messageDrafts.set(sessionId, textarea.value);
          }

          if (thumbnailUrl && markerId) {
            imagePreviewTracker.remove(sessionId, markerId);
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
          window.alert("Image upload succeeded without a usable reference.");
          const currentValue = textarea.value;
          const markerIndex = markerId ? imagePreviewTracker.findMarkerInText(currentValue, markerId) : currentValue.lastIndexOf(uploadingPlaceholder);
          if (markerIndex !== -1) {
            const newText = markerId ? imagePreviewTracker.removeMarkerFromText(currentValue, markerId) : currentValue.replace(uploadingPlaceholder, '');
            textarea.value = newText;
            state.messageDrafts.set(sessionId, textarea.value);
          }

          if (thumbnailUrl && markerId) {
            imagePreviewTracker.remove(sessionId, markerId);
          } else if (thumbnailUrl) {
            URL.revokeObjectURL(thumbnailUrl);
          }
          continue;
        }

        const currentValue = textarea.value;
        const markerIndex = markerId ? imagePreviewTracker.findMarkerInText(currentValue, markerId) : currentValue.lastIndexOf(uploadingPlaceholder);
        if (markerIndex !== -1) {
          const markerStr = markerId ? `<!--IMG:${markerId}-->[Uploading...]` : uploadingPlaceholder;
          const beforePlaceholder = currentValue.substring(0, markerIndex);
          const afterPlaceholder = currentValue.substring(markerIndex + markerStr.length);
          textarea.value = beforePlaceholder + placeholder + afterPlaceholder;
          state.messageDrafts.set(sessionId, textarea.value);
        }

        if (thumbnailUrl && markerId) {
          const sessionPreviews = imagePreviewTracker.previews.get(sessionId);
          if (sessionPreviews && sessionPreviews.has(markerId)) {
            const previewData = sessionPreviews.get(markerId);
            URL.revokeObjectURL(previewData.thumbnailUrl);
            const imgEl = previewData.previewElement.querySelector('img');
            if (imgEl) {
              imgEl.src = payload.publicPath || '';
            }
            sessionPreviews.set(markerId, { ...previewData, thumbnailUrl: null });
          }
        } else if (thumbnailUrl) {
          URL.revokeObjectURL(thumbnailUrl);
        }

        resizeTextarea();
        textarea.focus({ preventScroll: true });
      } catch (error) {
        console.error("Failed to upload image", error);
        window.alert("Image upload failed. Check console for details.");
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
      window.alert("Unable to locate session for file upload.");
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
          window.alert("File upload succeeded without a usable reference.");
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
        window.alert(message);
      } finally {
        setUploadingState(false);
      }
    }
  };

  /**
   * Remove orphaned image markers — called from textarea input handler
   * when user deletes marker text manually.
   */
  const cleanupOrphanedMarkers = (sessionId, text) => {
    const sessionPreviews = imagePreviewTracker.previews.get(sessionId);
    if (!sessionPreviews) return;
    const markersToRemove = [];
    sessionPreviews.forEach((previewData, markerId) => {
      if (imagePreviewTracker.findMarkerInText(text, markerId) === -1) {
        markersToRemove.push(markerId);
      }
    });
    markersToRemove.forEach(markerId => {
      imagePreviewTracker.remove(sessionId, markerId);
    });
  };

  return {
    insertTextAtCursor,
    createThumbnail,
    addImagePreview,
    clearImagePreviews,
    extractImageFiles,
    extractAttachmentFiles,
    handleImageUploads,
    handleAttachmentUploads,
    cleanupOrphanedMarkers,
  };
}
