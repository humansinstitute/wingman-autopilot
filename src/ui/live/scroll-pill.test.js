import { describe, expect, test } from "bun:test";

import {
  isMessageRectAboveView,
  isMessageRectInView,
} from "./scroll-pill.js";

describe("last prompt pill visibility helpers", () => {
  const scrollRect = {
    top: 100,
    bottom: 700,
  };

  test("identifies the last prompt as above the viewport at the bottom of a long response", () => {
    const lastPromptRect = {
      top: 20,
      bottom: 80,
    };

    expect(isMessageRectInView(lastPromptRect, scrollRect, 12)).toBe(false);
    expect(isMessageRectAboveView(lastPromptRect, scrollRect, 12)).toBe(true);
  });

  test("does not treat a later prompt below the viewport as above the viewport", () => {
    const laterPromptRect = {
      top: 760,
      bottom: 820,
    };

    expect(isMessageRectInView(laterPromptRect, scrollRect, 12)).toBe(false);
    expect(isMessageRectAboveView(laterPromptRect, scrollRect, 12)).toBe(false);
  });

  test("keeps an in-view prompt hidden", () => {
    const visiblePromptRect = {
      top: 180,
      bottom: 260,
    };

    expect(isMessageRectInView(visiblePromptRect, scrollRect, 12)).toBe(true);
    expect(isMessageRectAboveView(visiblePromptRect, scrollRect, 12)).toBe(false);
  });
});
