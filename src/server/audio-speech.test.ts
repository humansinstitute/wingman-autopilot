import { describe, expect, test } from "bun:test";

import { resolveAudioSpeechConfig } from "./audio-speech";

describe("audio speech config", () => {
  test("allows local OpenAI-compatible speech without an API key", () => {
    const config = resolveAudioSpeechConfig({
      provider: "local",
      baseUrl: "http://127.0.0.1:8880/v1",
      model: "kokoro",
      voice: "am_onyx",
      format: "mp3",
    });

    expect(config).toMatchObject({
      provider: "local",
      baseUrl: "http://127.0.0.1:8880/v1",
      model: "kokoro",
      voice: "am_onyx",
      format: "mp3",
    });
    expect(config?.apiKey).toBeUndefined();
  });

  test("still requires an API key for remote speech", () => {
    const config = resolveAudioSpeechConfig({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "hexgrad/kokoro-82m",
      voice: "am_onyx",
      format: "mp3",
    });

    expect(config).toBeNull();
  });
});
