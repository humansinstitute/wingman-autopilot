/**
 * Voice note capture for the live composer.
 *
 * Flow:
 * 1. Record audio in-browser.
 * 2. Upload/save it immediately on stop.
 * 3. Insert the saved link into the composer.
 * 4. Transcribe that saved link only when the user sends the message.
 */

import { transcribeVoiceNoteApi, uploadVoiceNoteApi } from "../services/voice-notes.js";

const AUDIO_LINK_PATTERN = /\[([^\]]+)\]\((\/uploads\/files\/[^)\s]+)\)/g;

function getPreferredMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];

  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }

  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return "";
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function sanitizeTranscriptLabel(value) {
  const cleaned = String(value ?? "").replace(/\s+/g, " ").trim();
  return cleaned || "voice note";
}

function createDialogShell() {
  const dialog = document.createElement("dialog");
  dialog.className = "wm-voice-note-dialog";
  dialog.dataset.testid = "voice-note-dialog";
  dialog.innerHTML = `
    <form class="wm-voice-note-dialog__form" method="dialog">
      <div class="wm-voice-note-dialog__header">
        <div>
          <h2 class="wm-voice-note-dialog__title">Record voice note</h2>
          <p class="wm-voice-note-dialog__subtitle">Records from your microphone, uploads immediately, inserts a saved link into the composer, and waits until Send to transcribe.</p>
        </div>
        <button type="button" class="wm-voice-note-dialog__close" aria-label="Close voice note recorder" data-action="close">&times;</button>
      </div>
      <p class="wm-voice-note-dialog__status" role="status" aria-live="polite" data-testid="voice-note-status"></p>
      <div class="wm-voice-note-dialog__meter" aria-hidden="true">
        <span class="wm-voice-note-dialog__meter-dot"></span>
        <span class="wm-voice-note-dialog__meter-label" data-part="meter-label">Idle</span>
        <span class="wm-voice-note-dialog__timer" data-part="timer">00:00</span>
      </div>
      <label class="wm-voice-note-dialog__preview">
        <span class="wm-voice-note-dialog__preview-label">Saved note</span>
        <textarea class="wm-voice-note-dialog__transcript" readonly rows="6" data-testid="voice-note-transcript" placeholder="The saved voice note link will appear here after upload completes."></textarea>
      </label>
      <div class="wm-voice-note-dialog__actions">
        <button type="button" class="wm-button secondary" data-action="start" data-testid="voice-note-start">Start recording</button>
        <button type="button" class="wm-button" data-action="stop" data-testid="voice-note-stop" disabled>Stop</button>
        <button type="button" class="wm-button secondary" data-action="cancel" data-testid="voice-note-cancel">Cancel</button>
      </div>
    </form>
  `;
  return dialog;
}

function buildTranscriptReplacement(label, transcript) {
  return `Voice note transcript (${sanitizeTranscriptLabel(label)}):\n${transcript.trim()}`;
}

function findVoiceNoteLinks(draft) {
  const text = typeof draft === "string" ? draft : "";
  const matches = [];
  AUDIO_LINK_PATTERN.lastIndex = 0;

  let match = AUDIO_LINK_PATTERN.exec(text);
  while (match) {
    const [raw, label, publicPath] = match;
    if (publicPath.includes("voice-note-")) {
      matches.push({ raw, label, publicPath });
    }
    match = AUDIO_LINK_PATTERN.exec(text);
  }

  return matches;
}

export function initVoiceNotes(deps) {
  const {
    getSessionById,
    insertTextAtCursor,
    showToast,
  } = deps;

  let activeDialog = null;

  function setDialogStatus(dialog, message, tone = "neutral") {
    const status = dialog.querySelector(".wm-voice-note-dialog__status");
    if (status) {
      status.textContent = message;
      status.dataset.state = tone;
    }
  }

  function setMeterState(dialog, stateText) {
    const label = dialog.querySelector('[data-part="meter-label"]');
    if (label) {
      label.textContent = stateText;
    }
  }

  function setTimer(dialog, elapsedMs) {
    const timer = dialog.querySelector('[data-part="timer"]');
    if (timer) {
      timer.textContent = formatDuration(elapsedMs);
    }
  }

  function setPreviewValue(dialog, value) {
    const preview = dialog.querySelector(".wm-voice-note-dialog__transcript");
    if (preview) {
      preview.value = value ?? "";
    }
  }

  function setButtonState(dialog, state) {
    const startButton = dialog.querySelector('[data-action="start"]');
    const stopButton = dialog.querySelector('[data-action="stop"]');
    const cancelButton = dialog.querySelector('[data-action="cancel"]');
    const closeButton = dialog.querySelector('[data-action="close"]');

    if (startButton) startButton.disabled = state !== "idle";
    if (stopButton) stopButton.disabled = state !== "recording";
    if (cancelButton) cancelButton.disabled = false;
    if (closeButton) closeButton.disabled = false;
  }

  async function closeDialog(dialog, options = {}) {
    if (!dialog.isConnected) {
      return;
    }
    const { skipClose = false } = options;
    if (!skipClose) {
      try {
        dialog.close();
      } catch {
        // Ignore close errors from detached dialogs.
      }
    }
    dialog.remove();
    if (activeDialog === dialog) {
      activeDialog = null;
    }
  }

  function stopStream(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Ignore track shutdown failures.
      }
    }
  }

  function findComposerTextarea(sessionId) {
    return document.querySelector(`.wm-composer-shell[data-session-id="${sessionId}"] textarea`);
  }

  function insertVoiceNoteReference(sessionId, reference) {
    const textarea = findComposerTextarea(sessionId);
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Unable to find the live composer for this session");
    }

    const needsPrefix = textarea.value.length > 0 && !textarea.value.endsWith("\n");
    const textToInsert = needsPrefix ? `\n${reference}\n` : `${reference}\n`;
    insertTextAtCursor(textarea, textToInsert, sessionId);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus({ preventScroll: true });
  }

  async function uploadRecording(dialog, sessionId, recordingBlob, fileName, mimeType, signal) {
    const session = getSessionById(sessionId);
    if (!session) {
      throw new Error("Unable to locate the live session");
    }

    setDialogStatus(dialog, "Uploading voice note...", "processing");
    setMeterState(dialog, "Uploading");
    setPreviewValue(dialog, "");

    const file = new File([recordingBlob], fileName, {
      type: mimeType || recordingBlob.type || "audio/webm",
    });

    const response = await uploadVoiceNoteApi({
      agent: session.agent,
      file,
      signal,
    });

    const reference =
      typeof response?.placeholder === "string" && response.placeholder.trim().length > 0
        ? response.placeholder.trim()
        : typeof response?.publicPath === "string" && response.publicPath.trim().length > 0
          ? `[${fileName}](${response.publicPath.trim()})`
          : "";

    if (!reference) {
      throw new Error("Voice note upload succeeded without a usable link");
    }

    insertVoiceNoteReference(sessionId, reference);
    setPreviewValue(dialog, reference);
    setDialogStatus(dialog, "Voice note saved to the composer. It will transcribe when you send.", "success");
    setMeterState(dialog, "Saved");
    showToast?.("Voice note saved to composer", { duration: 2200 });
  }

  async function prepareDraftForSend(_sessionId, draft) {
    const matches = findVoiceNoteLinks(draft);
    if (matches.length === 0) {
      return draft;
    }

    let nextDraft = draft;
    const transcriptCache = new Map();
    showToast?.(
      `Transcribing ${matches.length} voice note${matches.length === 1 ? "" : "s"} before send`,
      { variant: "info", duration: 2200 },
    );

    for (const match of matches) {
      let transcript = transcriptCache.get(match.publicPath);
      if (!transcript) {
        const response = await transcribeVoiceNoteApi({ publicPath: match.publicPath });
        transcript = typeof response?.transcript === "string" ? response.transcript.trim() : "";
        if (!transcript) {
          throw new Error(`Voice note transcription returned no text for ${match.label}`);
        }
        transcriptCache.set(match.publicPath, transcript);
      }

      nextDraft = nextDraft.replace(match.raw, buildTranscriptReplacement(match.label, transcript));
    }

    return nextDraft;
  }

  async function openVoiceNoteRecorder(sessionId) {
    const session = getSessionById(sessionId);
    if (!session) {
      window.alert("Unable to locate session for voice note recording.");
      return;
    }

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      window.alert("Voice note recording is not supported in this browser.");
      return;
    }

    if (activeDialog) {
      activeDialog.focus();
      return;
    }

    const dialog = createDialogShell();
    activeDialog = dialog;
    document.body.append(dialog);
    dialog.showModal();

    const startButton = dialog.querySelector('[data-action="start"]');
    const stopButton = dialog.querySelector('[data-action="stop"]');
    const cancelButton = dialog.querySelector('[data-action="cancel"]');
    const closeButton = dialog.querySelector('[data-action="close"]');

    let uploadAbortController = new AbortController();
    let mediaStream = null;
    let mediaRecorder = null;
    let recordingChunks = [];
    let recordingMimeType = "";
    let recordingStartedAt = 0;
    let recordingTimer = null;
    let discardOnStop = false;
    let recordingState = "idle";

    const updateState = (nextState) => {
      recordingState = nextState;
      dialog.dataset.state = nextState;
      setButtonState(dialog, nextState);
      if (nextState === "idle") {
        setMeterState(dialog, "Idle");
        setTimer(dialog, 0);
      }
    };

    const teardownRecording = () => {
      if (recordingTimer) {
        window.clearInterval(recordingTimer);
        recordingTimer = null;
      }
      stopStream(mediaStream);
      mediaStream = null;
      mediaRecorder = null;
      recordingChunks = [];
    };

    const finishAndClose = () => {
      window.setTimeout(() => {
        void closeDialog(dialog);
      }, 700);
    };

    const cancelUploadAndClose = () => {
      uploadAbortController.abort();
      teardownRecording();
      setDialogStatus(dialog, "Voice note cancelled.", "warning");
      setMeterState(dialog, "Cancelled");
      updateState("idle");
      void closeDialog(dialog);
    };

    const startRecording = async () => {
      if (recordingState !== "idle") {
        return;
      }

      discardOnStop = false;
      uploadAbortController = new AbortController();
      setDialogStatus(dialog, "Requesting microphone access...", "processing");
      setMeterState(dialog, "Preparing");
      setPreviewValue(dialog, "");

      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recordingMimeType = getPreferredMimeType();
        mediaRecorder = recordingMimeType
          ? new MediaRecorder(mediaStream, { mimeType: recordingMimeType })
          : new MediaRecorder(mediaStream);
        recordingChunks = [];
        recordingStartedAt = Date.now();
        updateState("recording");
        setDialogStatus(dialog, "Recording voice note...", "recording");
        setMeterState(dialog, "Recording");
        setTimer(dialog, 0);

        recordingTimer = window.setInterval(() => {
          setTimer(dialog, Date.now() - recordingStartedAt);
        }, 250);

        mediaRecorder.addEventListener("dataavailable", (event) => {
          if (event.data && event.data.size > 0) {
            recordingChunks.push(event.data);
          }
        });

        mediaRecorder.addEventListener("stop", async () => {
          const finalMimeType = recordingMimeType || mediaRecorder?.mimeType || "audio/webm";
          const recordingBlob = new Blob(recordingChunks, { type: finalMimeType });
          const fileName = `voice-note-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;

          teardownRecording();

          if (discardOnStop) {
            setDialogStatus(dialog, "Voice note discarded.", "warning");
            setMeterState(dialog, "Discarded");
            updateState("idle");
            finishAndClose();
            return;
          }

          if (recordingBlob.size === 0) {
            setDialogStatus(dialog, "No audio was captured. Please try again.", "error");
            setMeterState(dialog, "Error");
            updateState("idle");
            return;
          }

          try {
            dialog.dataset.busy = "true";
            updateState("uploading");
            await uploadRecording(dialog, sessionId, recordingBlob, fileName, finalMimeType, uploadAbortController.signal);
            dialog.dataset.busy = "false";
            finishAndClose();
          } catch (error) {
            dialog.dataset.busy = "false";
            const message = error instanceof Error ? error.message : String(error);
            setDialogStatus(dialog, `Voice note failed: ${message}`, "error");
            setMeterState(dialog, "Error");
            updateState("idle");
            showToast?.(`Voice note failed: ${message}`, { variant: "error", duration: 2600 });
          }
        }, { once: true });

        mediaRecorder.addEventListener("error", (event) => {
          const message = event.error instanceof Error ? event.error.message : "Recorder error";
          teardownRecording();
          setDialogStatus(dialog, `Recording failed: ${message}`, "error");
          setMeterState(dialog, "Error");
          updateState("idle");
          showToast?.(`Voice note recording failed: ${message}`, { variant: "error", duration: 2600 });
        }, { once: true });

        mediaRecorder.start(1000);
      } catch (error) {
        teardownRecording();
        updateState("idle");
        const message = error instanceof Error ? error.message : String(error);
        setDialogStatus(dialog, `Recording failed: ${message}`, "error");
        setMeterState(dialog, "Error");
        showToast?.(`Voice note recording failed: ${message}`, { variant: "error", duration: 2600 });
      }
    };

    const stopRecording = () => {
      if (!mediaRecorder || recordingState !== "recording") {
        return;
      }
      setDialogStatus(dialog, "Stopping recording...", "processing");
      setMeterState(dialog, "Stopping");
      try {
        mediaRecorder.stop();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setDialogStatus(dialog, `Stop failed: ${message}`, "error");
        setMeterState(dialog, "Error");
        updateState("idle");
      }
    };

    const cancelRecorder = () => {
      if (recordingState === "recording") {
        discardOnStop = true;
        setDialogStatus(dialog, "Discarding recording...", "warning");
        setMeterState(dialog, "Discarding");
        try {
          mediaRecorder?.stop();
        } catch {
          teardownRecording();
          updateState("idle");
          void closeDialog(dialog);
        }
        return;
      }

      if (recordingState === "uploading") {
        cancelUploadAndClose();
        return;
      }

      teardownRecording();
      void closeDialog(dialog);
    };

    startButton?.addEventListener("click", () => {
      void startRecording();
    });

    stopButton?.addEventListener("click", () => {
      stopRecording();
    });

    cancelButton?.addEventListener("click", () => {
      cancelRecorder();
    });

    closeButton?.addEventListener("click", () => {
      cancelRecorder();
    });

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      cancelRecorder();
    });

    dialog.addEventListener("close", () => {
      teardownRecording();
      if (activeDialog === dialog) {
        activeDialog = null;
      }
      dialog.remove();
    }, { once: true });

    setDialogStatus(dialog, "Choose Start recording when you are ready.", "neutral");
    setMeterState(dialog, "Idle");
    setTimer(dialog, 0);
    setButtonState(dialog, "idle");

    requestAnimationFrame(() => {
      startButton?.focus();
    });
  }

  return {
    openVoiceNoteRecorder,
    prepareDraftForSend,
  };
}
