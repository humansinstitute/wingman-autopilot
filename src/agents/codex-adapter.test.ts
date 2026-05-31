import { describe, expect, test } from "bun:test";

import { extractCodexErrorMessage } from "./codex-adapter";

describe("extractCodexErrorMessage", () => {
  test("unwraps codex JSON error envelopes", () => {
    const raw = JSON.stringify({
      detail: "The 'gpt-5.5' model requires a newer version of Codex.",
    });
    expect(extractCodexErrorMessage(raw)).toBe(
      "The 'gpt-5.5' model requires a newer version of Codex.",
    );
  });

  test("falls back to the message field when no detail is present", () => {
    expect(extractCodexErrorMessage(JSON.stringify({ message: "boom" }))).toBe("boom");
  });

  test("returns plain strings unchanged", () => {
    expect(extractCodexErrorMessage("something went wrong")).toBe("something went wrong");
  });

  test("returns a default for empty input", () => {
    expect(extractCodexErrorMessage("")).toBe("Codex turn failed");
    expect(extractCodexErrorMessage(null)).toBe("Codex turn failed");
  });

  test("returns malformed JSON verbatim", () => {
    expect(extractCodexErrorMessage("{not json")).toBe("{not json");
  });
});
