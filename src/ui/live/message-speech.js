import { generateMessageSpeechApi } from "../services/message-speech.js";

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
  if (typeof speechSynthesis !== "undefined") {
    speechSynthesis.cancel();
  }
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

function canUseBrowserSpeech() {
  return typeof SpeechSynthesisUtterance !== "undefined" && typeof speechSynthesis !== "undefined";
}

function readWithBrowserSpeech(text) {
  if (!canUseBrowserSpeech()) {
    return false;
  }
  stopActiveAudio();
  const utterance = new SpeechSynthesisUtterance(text);
  speechSynthesis.speak(utterance);
  return true;
}

async function resolveServerSpeech({ sessionId, message, button = null }) {
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
    throw error;
  } finally {
    if (button) {
      button.disabled = false;
      delete button.dataset.loading;
    }
  }
}

async function readMessageAloud({ sessionId, message, showToast, button = null }) {
  const text = getMessageText(message);
  if (!text) {
    showToast?.("Message has no readable text", { type: "warning" });
    return;
  }

  if (readWithBrowserSpeech(text)) {
    return;
  }

  try {
    const speech = await resolveServerSpeech({ sessionId, message, button });
    playSpeech(speech.publicPath);
  } catch (error) {
    showToast?.(error instanceof Error ? error.message : "Speech is not available in this browser", { type: "error" });
  }
}

export function isSessionAlwaysReadEnabled(session) {
  return Boolean(session?.metadata?.speechAlwaysRead);
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
  button.textContent = "Read";
  button.addEventListener("click", () => {
    void readMessageAloud({ sessionId, message, showToast, button });
  });

  card.append(label, button);
  return card;
}

export async function autoReadLatestAssistantMessage({ sessionId, session, conversation, showToast }) {
  if (!isSessionAlwaysReadEnabled(session) || !Array.isArray(conversation) || conversation.length === 0) {
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
    await readMessageAloud({ sessionId, message: latestSnapshot, showToast });
  }, AUTO_READ_IDLE_MS);
  autoReadTimers.set(cacheKey, timer);
}
