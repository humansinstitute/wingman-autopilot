import { generateMessageSpeechApi } from "../services/message-speech.js";

const generatedSpeech = new Map();
const autoPlayedMessages = new Set();
const autoReadingMessages = new Set();
const autoReadTimers = new Map();
let activeAudio = null;
const AUTO_READ_IDLE_MS = 1400;
const PLAY_ICON_SVG =
  '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';

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
    const response = await generateMessageSpeechApi({
      sessionId,
      messageId: getMessageId(message),
      text,
      summary: true,
    });
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
  if (!getMessageText(message)) {
    showToast?.("Message has no readable text", { type: "warning" });
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

export function attachMessageSpeechButton(bubble, { sessionId, message, showToast }) {
  if (!bubble || bubble.dataset.speechAttached === "true") {
    return;
  }
  if (!isAssistantRole(message) || !getMessageId(message) || !getMessageText(message)) {
    return;
  }

  const actions = bubble.querySelector(".wm-message-actions") ?? document.createElement("div");
  actions.className = "wm-message-actions";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "wm-message-speech-play";
  button.dataset.testid = "message-speech-play";
  button.setAttribute("aria-label", "Play spoken summary");
  button.title = "Play spoken summary";
  button.innerHTML = PLAY_ICON_SVG;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void readMessageAloud({ sessionId, message, showToast, button });
  });

  actions.prepend(button);
  if (!actions.parentNode) {
    bubble.append(actions);
  }
  bubble.dataset.speechAttached = "true";
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
    if (autoPlayedMessages.has(cacheKey) || autoReadingMessages.has(cacheKey)) {
      return;
    }
    autoReadingMessages.add(cacheKey);
    try {
      await readMessageAloud({ sessionId, message: latestSnapshot, showToast });
      autoPlayedMessages.add(cacheKey);
    } finally {
      autoReadingMessages.delete(cacheKey);
    }
  }, AUTO_READ_IDLE_MS);
  autoReadTimers.set(cacheKey, timer);
}
