import { generateMessageSpeechApi } from "../services/message-speech.js";

const ALWAYS_READ_STORAGE_KEY = "wingman:message-speech:always-read";
const generatedSpeech = new Map();
const autoPlayedMessages = new Set();
const autoReadTimers = new Map();
let activeAudio = null;
const AUTO_READ_IDLE_MS = 1400;

function isAssistantRole(message) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  return role === "assistant" || role === "agent";
}

function getMessageId(message) {
  const id = typeof message?.id === "string" ? message.id.trim() : "";
  return id || "";
}

function getMessageText(message) {
  return String(message?.content ?? message?.message ?? "").replace(/\s+/g, " ").trim();
}

function getSpeech(message) {
  return message?.speech && typeof message.speech === "object" ? message.speech : null;
}

function getSpeechCacheKey(sessionId, message) {
  const messageId = getMessageId(message);
  return messageId ? `${sessionId}:${messageId}` : "";
}

function stopActiveAudio() {
  if (!activeAudio) {
    return;
  }
  try {
    activeAudio.pause();
    activeAudio.currentTime = 0;
  } catch {
    // Ignore browser audio state errors.
  }
  activeAudio = null;
}

function playSpeech(publicPath) {
  if (!publicPath) {
    return;
  }
  stopActiveAudio();
  const audio = new Audio(publicPath);
  activeAudio = audio;
  audio.addEventListener("ended", () => {
    if (activeAudio === audio) {
      activeAudio = null;
    }
  }, { once: true });
  void audio.play();
}

function readAlwaysReadPreference() {
  try {
    return localStorage.getItem(ALWAYS_READ_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeAlwaysReadPreference(enabled) {
  try {
    localStorage.setItem(ALWAYS_READ_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore localStorage failures.
  }
}

async function resolveSpeech({ sessionId, message, showToast, button = null }) {
  const existing = getSpeech(message);
  if (existing?.publicPath) {
    return existing;
  }

  const cacheKey = getSpeechCacheKey(sessionId, message);
  if (!cacheKey) {
    throw new Error("Message cannot be read aloud yet");
  }

  const cached = generatedSpeech.get(cacheKey);
  if (cached?.publicPath) {
    return cached;
  }

  const text = getMessageText(message);
  if (!text) {
    throw new Error("Message has no readable text");
  }

  if (button) {
    button.disabled = true;
    button.dataset.loading = "true";
  }

  try {
    const response = await generateMessageSpeechApi({ sessionId, messageId: getMessageId(message), text });
    const speech = response?.speech ?? null;
    if (!speech?.publicPath) {
      throw new Error("Speech generation returned no audio");
    }
    generatedSpeech.set(cacheKey, speech);
    return speech;
  } catch (error) {
    showToast?.(error instanceof Error ? error.message : "Speech generation failed", { type: "error" });
    throw error;
  } finally {
    if (button) {
      button.disabled = false;
      delete button.dataset.loading;
    }
  }
}

export function isAlwaysReadEnabled() {
  return readAlwaysReadPreference();
}

export function setAlwaysReadEnabled(enabled) {
  writeAlwaysReadPreference(Boolean(enabled));
}

export function toggleAlwaysRead() {
  const next = !readAlwaysReadPreference();
  writeAlwaysReadPreference(next);
  return next;
}

export function createMessageSpeechCard({ sessionId, message, showToast }) {
  if (!isAssistantRole(message) || !getMessageId(message) || !getMessageText(message)) {
    return null;
  }

  const card = document.createElement("div");
  card.className = "wm-message-speech-card";
  card.dataset.testid = "message-speech-card";

  const label = document.createElement("span");
  label.className = "wm-message-speech-card__label";
  label.textContent = "Audio";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "wm-message-speech-card__button";
  button.dataset.testid = "message-speech-play";
  button.setAttribute("aria-label", "Read this response aloud");
  button.textContent = getSpeech(message)?.publicPath ? "Play" : "Create and play";
  button.addEventListener("click", async () => {
    try {
      const speech = await resolveSpeech({ sessionId, message, showToast, button });
      button.textContent = "Play";
      playSpeech(speech.publicPath);
    } catch {
      // Error toast handled in resolveSpeech.
    }
  });

  card.append(label, button);
  return card;
}

export async function autoReadLatestAssistantMessage({ sessionId, conversation, showToast }) {
  if (!readAlwaysReadPreference() || !Array.isArray(conversation) || conversation.length === 0) {
    return;
  }

  const latest = [...conversation].reverse().find((message) => isAssistantRole(message) && getMessageText(message));
  const cacheKey = latest ? getSpeechCacheKey(sessionId, latest) : "";
  if (!latest || !cacheKey || autoPlayedMessages.has(cacheKey)) {
    return;
  }

  const existingTimer = autoReadTimers.get(cacheKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  const latestSnapshot = { ...latest };
  const timer = setTimeout(async () => {
    autoReadTimers.delete(cacheKey);
    if (autoPlayedMessages.has(cacheKey)) {
      return;
    }
    autoPlayedMessages.add(cacheKey);
    try {
      const speech = await resolveSpeech({ sessionId, message: latestSnapshot, showToast });
      playSpeech(speech.publicPath);
    } catch {
      // Error toast handled in resolveSpeech.
    }
  }, AUTO_READ_IDLE_MS);
  autoReadTimers.set(cacheKey, timer);
}
