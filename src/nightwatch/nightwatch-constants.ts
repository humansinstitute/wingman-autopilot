export const NIGHTWATCH_FEATURE_FLAG_KEY = "nightwatch_enabled";

export const NIGHTWATCH_DEFAULT_MODEL = "google/gemini-3-flash-preview";

export const NIGHTWATCH_MODELS = [
  "z-ai/glm-4.6v",
  "moonshotai/kimi-k2.5",
  "z-ai/glm-4.7-flash",
  "google/gemini-3-flash-preview",
  "x-ai/grok-4.1-fast",
  "anthropic/claude-sonnet-4.5",
] as const;

export const NIGHTWATCH_MAX_CYCLE_OPTIONS = [6, 21, 256] as const;

export const NIGHTWATCH_CHECK_IN_PROMPT = "Any progress?";
export const NIGHTWATCH_CHECK_IN_INTERVAL_MS = 5 * 60 * 1000;
export const NIGHTWATCH_RETRY_DELAY_MS = 60 * 1000;

export const NIGHTWATCH_DEFAULT_PROMPT =
  `Night Watchman sends "${NIGHTWATCH_CHECK_IN_PROMPT}" to enabled sessions every 5 minutes.`;

export function getNextNightWatchPromptAt(baseMs = Date.now()): string {
  return new Date(baseMs + NIGHTWATCH_CHECK_IN_INTERVAL_MS).toISOString();
}

export function getNightWatchRetryPromptAt(baseMs = Date.now()): string {
  return new Date(baseMs + NIGHTWATCH_RETRY_DELAY_MS).toISOString();
}
