/**
 * Voice note capture and transcription flow for the live composer.
 */

import { uploadVoiceNoteApi } from "../services/voice-notes.js";

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

function createDialogShell() {
  const dialog = document.createElement("dialog");
  dialog.className = "wm-voice-note-dialog";
  dialog.dataset.testid = "voice-note-dialog";
  dialog.innerHTML = `
    <form class="wm-voice-note-dialog__form" method="dialog">
      <div class="wm-voice-note-dialog__header">
        <div>
          <h2 class="wm-voice-note-dialog__title">Record voice note</h2>
          <p class="wm-voice-note-dialog__subtitle">Records from your microphone, uploads to Wingman, transcribes automatically, and sends the text to the session.</p>
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
        <span class="wm-voice-note-dialog__preview-label">Transcript</span>
        <textarea class="wm-voice-note-dialog__transcript" readonly rows="6" data-testid="voice-note-transcript" placeholder="The transcript will appear here after transcription completes."></textarea>
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

export function initVoiceNotes(deps) {
  const {
    getSessionById,
    sendMessage,
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

  function setTranscript(dialog, transcript) {
    const preview = dialog.querySelector(".wm-voice-note-dialog__transcript");
    if (preview) {
      preview.value = transcript ?? "";
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

  async function finalizeRecording(dialog, sessionId, recordingBlob, fileName, mimeType, context) {
    const { cancelToken } = context;
    const session = getSessionById(sessionId);
    if (!session) {
      throw new Error("Unable to locate the live session");
    }

    setButtonState(dialog, "uploading");
    setDialogStatus(dialog, "Uploading audio and transcribing...", "processing");
    setMeterState(dialog, "Uploading");

    const file = new File([recordingBlob], fileName, {
      type: mimeType || recordingBlob.type || "audio/webm",
    });

    const response = await uploadVoiceNoteApi({
      sessionId,
      agent: session.agent,
      file,
      signal: cancelToken.signal,
    });

    const transcript = typeof response?.transcript === "string" ? response.transcript.trim() : "";
    if (!transcript) {
      throw new Error("Transcription completed without any text");
    }

    setTranscript(dialog, transcript);
    setDialogStatus(dialog, "Sending transcript to the session...", "processing");
    setMeterState(dialog, "Sending");

    const sendResult = await sendMessage(sessionId, transcript);
    if (sendResult?.busy) {
      setDialogStatus(dialog, "The session is busy. Transcript was not sent.", "warning");
      setMeterState(dialog, "Busy");
      showToast?.("Session is busy. Transcript was not sent.", { variant: "error", duration: 2600 });
      return { transcript, outcome: "busy" };
    }

    const sendStatus = sendResult?.queued
      ? "Transcript queued for the session."
      : "Transcript sent to the session.";
    setDialogStatus(dialog, sendStatus, "success");
    setMeterState(dialog, "Sent");
    showToast?.("Voice note sent", { duration: 2200 });
    return {
      transcript,
      outcome: sendResult?.queued ? "queued" : "sent",
    };
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
    const status = dialog.querySelector(".wm-voice-note-dialog__status");

    const cleanup = async () => {
      if (dialog.dataset.busy === "true") {
        return;
      }
      await closeDialog(dialog);
    };

    const context = {
      cancelToken: new AbortController(),
    };

    let recordingStartedAt = 0;
    let recordingTimer = null;
    let mediaStream = null;
    let mediaRecorder = null;
    let chunks = [];
    let recordingMimeType = "";
    let cancelled = false;
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

    const teardownRecorder = () => {
      if (recordingTimer) {
        window.clearInterval(recordingTimer);
        recordingTimer = null;
      }
      stopStream(mediaStream);
      mediaStream = null;
      mediaRecorder = null;
      chunks = [];
      dialog.dataset.busy = "false";
    };

    const cancelProcessing = () => {
      cancelled = true;
      context.cancelToken.abort();
      teardownRecorder();
      setDialogStatus(dialog, "Voice note cancelled.", "warning");
      setMeterState(dialog, "Cancelled");
      updateState("idle");
      void cleanup();
    };

    const stopRecording = () => {
      if (!mediaRecorder || recordingState !== "recording") {
        return;
      }
      setDialogStatus(dialog, "Stopping recording...", "processing");
      setMeterState(dialog, "Stopping");
      updateState("processing");
      try {
        mediaRecorder.stop();
      } catch (error) {
        console.warn("[voice-note] failed to stop recorder", error);
      }
    };

    const startRecording = async () => {
      if (recordingState !== "idle") {
        return;
      }
      cancelled = false;
      context.cancelToken = new AbortController();
      updateState("recording");
      setDialogStatus(dialog, "Requesting microphone access...", "processing");
      setMeterState(dialog, "Preparing");

      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recordingMimeType = getPreferredMimeType();
        mediaRecorder = recordingMimeType
          ? new MediaRecorder(mediaStream, { mimeType: recordingMimeType })
          : new MediaRecorder(mediaStream);
        chunks = [];
        recordingStartedAt = Date.now();
        setDialogStatus(dialog, "Recording voice note...", "recording");
        setMeterState(dialog, "Recording");
        setTimer(dialog, 0);
        recordingTimer = window.setInterval(() => {
          if (recordingStartedAt) {
            setTimer(dialog, Date.now() - recordingStartedAt);
          }
        }, 250);

        mediaRecorder.addEventListener("dataavailable", (event) => {
          if (event.data && event.data.size > 0) {
            chunks.push(event.data);
          }
        });

        mediaRecorder.addEventListener("stop", async () => {
          try {
            if (cancelled) {
              return;
            }

            const blob = new Blob(chunks, {
              type: recordingMimeType || mediaRecorder?.mimeType || "audio/webm",
            });
            const fileName = `voice-note-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
            dialog.dataset.busy = "true";
            const result = await finalizeRecording(dialog, sessionId, blob, fileName, blob.type, context);
            dialog.dataset.busy = "false";
            if (result?.outcome === "busy") {
              return;
            }
            window.setTimeout(() => {
              void closeDialog(dialog);
            }, 750);
          } catch (error) {
            dialog.dataset.busy = "false";
            if (!cancelled) {
              const message = error instanceof Error ? error.message : String(error);
              setDialogStatus(dialog, `Voice note failed: ${message}`, "error");
              setMeterState(dialog, "Error");
              setButtonState(dialog, "idle");
              showToast?.(`Voice note failed: ${message}`, { variant: "error", duration: 2600 });
            }
          } finally {
            teardownRecorder();
          }
        }, { once: true });

        mediaRecorder.addEventListener("error", (event) => {
          cancelled = true;
          const error = event.error ?? new Error("Recorder error");
          const message = error instanceof Error ? error.message : String(error);
          setDialogStatus(dialog, `Recorder error: ${message}`, "error");
          setMeterState(dialog, "Error");
          setButtonState(dialog, "idle");
          showToast?.(`Voice note recording failed: ${message}`, { variant: "error", duration: 2600 });
        }, { once: true });

        mediaRecorder.start();
      } catch (error) {
        teardownRecorder();
        updateState("idle");
        const message = error instanceof Error ? error.message : String(error);
        setDialogStatus(dialog, `Recording failed: ${message}`, "error");
        setMeterState(dialog, "Error");
        showToast?.(`Voice note recording failed: ${message}`, { variant: "error", duration: 2600 });
      }
    };

    startButton?.addEventListener("click", () => {
      void startRecording();
    });

    stopButton?.addEventListener("click", () => {
      stopRecording();
    });

    cancelButton?.addEventListener("click", () => {
      if (recordingState === "recording") {
        cancelled = true;
        setDialogStatus(dialog, "Discarding recording...", "warning");
        setMeterState(dialog, "Discarding");
        updateState("processing");
        try {
          mediaRecorder?.stop();
        } catch {
          teardownRecorder();
          updateState("idle");
          void cleanup();
        }
        return;
      }

      if (recordingState === "processing") {
        cancelProcessing();
        return;
      }

      cancelled = true;
      void cleanup();
    });

    closeButton?.addEventListener("click", () => {
      cancelled = true;
      if (recordingState === "recording") {
        try {
          mediaRecorder?.stop();
        } catch {
          teardownRecorder();
        }
      } else if (recordingState === "processing") {
        cancelProcessing();
        return;
      }
      void cleanup();
    });

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      cancelled = true;
      if (recordingState === "recording") {
        try {
          mediaRecorder?.stop();
        } catch {
          teardownRecorder();
        }
      } else if (recordingState === "processing") {
        cancelProcessing();
        return;
      }
      void cleanup();
    });

    dialog.addEventListener("close", () => {
      cancelled = true;
      teardownRecorder();
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
  };
}
