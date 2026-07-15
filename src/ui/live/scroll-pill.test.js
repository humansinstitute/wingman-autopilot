import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  isMessageRectAboveView,
  isMessageRectInView,
} from "./scroll-pill.js";

const source = readFileSync(new URL("./scroll-pill.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

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

  test("mounts the last prompt pill in the composer control row", () => {
    expect(source).toContain("const pillParent = parent;");
    expect(source).toContain("pillParent.appendChild(button);");
    expect(source).not.toContain("const pillParent = document.body || parent;");
  });

  test("assigns left and right dock classes to scroll pills", () => {
    expect(source).toContain('button.className = "wm-scroll-pill wm-scroll-pill--last-prompt";');
    expect(source).toContain('button.className = "wm-scroll-pill wm-scroll-pill--scroll-bottom";');
  });

  test("updates the bottom pill from scroll position", () => {
    expect(source).toContain("function updateBottomPillVisibility(state)");
    expect(source).toContain("updateBottomPillVisibility(bottomPillState);");
  });

  test("centers the two pills in the left and right halves", () => {
    const lastPromptRule = styles.match(/\.wm-scroll-pill--last-prompt\s*\{(?<body>[^}]+)\}/);
    const scrollBottomRule = styles.match(/\.wm-scroll-pill--scroll-bottom\s*\{(?<body>[^}]+)\}/);

    expect(lastPromptRule?.groups?.body).toContain("left: 25%;");
    expect(lastPromptRule?.groups?.body).toContain("transform: translateX(-50%);");
    expect(scrollBottomRule?.groups?.body).toContain("left: 75%;");
    expect(scrollBottomRule?.groups?.body).toContain("transform: translateX(-50%);");
  });
});
