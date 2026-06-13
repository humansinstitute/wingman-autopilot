import { z } from "zod";

const DEFAULT_SPEECH_MODEL = "tts-1";
const DEFAULT_SPEECH_VOICE = "alloy";
const DEFAULT_SPEECH_FORMAT = "mp3";
const DEFAULT_SPEECH_BASE_URL = "https://api.openai.com/v1";

const speechConfigSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  voice: z.string().min(1),
  format: z.string().min(1),
});

export type AudioSpeechConfig = z.infer<typeof speechConfigSchema>;

export type GenerateSpeechInput = {
  text: string;
  voice?: string | null;
};

function normalizeSpeechText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractProviderErrorMessage(rawBody: string): string {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return "Speech request failed";
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown> & {
      error?: unknown;
      message?: unknown;
    };
    if (parsed && typeof parsed === "object") {
      const nestedError = parsed.error;
      if (nestedError && typeof nestedError === "object") {
        const nestedErrorRecord = nestedError as Record<string, unknown>;
        if (typeof nestedErrorRecord.message === "string") {
          return nestedErrorRecord.message;
        }
      }
      if (typeof parsed.message === "string" && parsed.message) {
        return parsed.message;
      }
      if (typeof parsed.error === "string" && parsed.error) {
        return parsed.error;
      }
    }
  } catch {
    // Fall through to raw text handling.
  }
  return trimmed;
}

export function resolveAudioSpeechConfig(): AudioSpeechConfig | null {
  const apiKey =
    Bun.env.WINGMAN_SPEECH_API_KEY?.trim() ||
    Bun.env.OPENAI_API_KEY?.trim() ||
    Bun.env.CODEX_API_KEY?.trim() ||
    "";
  if (!apiKey) {
    return null;
  }

  const baseUrl =
    Bun.env.WINGMAN_SPEECH_BASE_URL?.trim() ||
    Bun.env.OPENAI_BASE_URL?.trim() ||
    DEFAULT_SPEECH_BASE_URL;

  const model =
    Bun.env.WINGMAN_SPEECH_MODEL?.trim() ||
    Bun.env.OPENAI_SPEECH_MODEL?.trim() ||
    DEFAULT_SPEECH_MODEL;

  const voice =
    Bun.env.WINGMAN_SPEECH_VOICE?.trim() ||
    Bun.env.OPENAI_SPEECH_VOICE?.trim() ||
    DEFAULT_SPEECH_VOICE;

  const format =
    Bun.env.WINGMAN_SPEECH_FORMAT?.trim() ||
    DEFAULT_SPEECH_FORMAT;

  const parsed = speechConfigSchema.safeParse({
    apiKey,
    baseUrl,
    model,
    voice,
    format,
  });
  if (!parsed.success) {
    return null;
  }

  return parsed.data;
}

export function resolveSpeechMimeType(format: string): string {
  const normalized = format.trim().toLowerCase();
  if (normalized === "opus") return "audio/ogg";
  if (normalized === "aac") return "audio/aac";
  if (normalized === "flac") return "audio/flac";
  if (normalized === "wav") return "audio/wav";
  if (normalized === "pcm") return "audio/L16";
  return "audio/mpeg";
}

export function resolveSpeechExtension(format: string): string {
  const normalized = format.trim().toLowerCase();
  if (normalized === "opus") return ".ogg";
  if (["aac", "flac", "wav"].includes(normalized)) return `.${normalized}`;
  if (normalized === "pcm") return ".pcm";
  return ".mp3";
}

export async function generateSpeechAudio(input: GenerateSpeechInput): Promise<{
  audio: Uint8Array;
  mimeType: string;
  model: string;
  voice: string;
  format: string;
}> {
  const config = resolveAudioSpeechConfig();
  if (!config) {
    throw new Error("No speech API key configured");
  }

  const text = normalizeSpeechText(input.text);
  if (!text) {
    throw new Error("Speech text is required");
  }

  const voice = typeof input.voice === "string" && input.voice.trim() ? input.voice.trim() : config.voice;
  const baseUrl = config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
  const response = await fetch(new URL("audio/speech", baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      input: text,
      voice,
      response_format: config.format,
    }),
  });

  if (!response.ok) {
    throw new Error(extractProviderErrorMessage(await response.text()));
  }

  return {
    audio: new Uint8Array(await response.arrayBuffer()),
    mimeType: resolveSpeechMimeType(config.format),
    model: config.model,
    voice,
    format: config.format,
  };
}
