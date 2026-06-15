import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  getLastPromptPillPosition,
  isMessageRectAboveView,
  isMessageRectInView,
} from "./scroll-pill.js";

const source = readFileSync(new URL("./scroll-pill.js", import.meta.url), "utf8");

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

  test("positions the last prompt pill from the visible scroll container", () => {
    expect(getLastPromptPillPosition({
      top: 80,
      bottom: 720,
      left: 40,
      right: 1040,
    }, 16)).toEqual({
      top: 108,
      left: 540,
    });
  });

  test("mounts the last prompt pill outside scroll flow", () => {
    expect(source).toContain("const pillParent = document.body || parent;");
    expect(source).toContain("pillParent.appendChild(button);");
    expect(source).not.toContain("pillParent.insertBefore(button");
  });
});
