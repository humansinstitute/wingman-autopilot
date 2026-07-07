import { describe, expect, test } from "bun:test";

import { createCommentAutosave } from "./comment-autosave.js";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("comment-autosave", () => {
  test("debounces saves until changes settle", async () => {
    let saves = 0;
    const autosave = createCommentAutosave({
      delayMs: 10,
      canSave: () => true,
      save: () => {
        saves += 1;
      },
    });

    autosave.queue();
    autosave.queue();
    await wait(30);

    expect(saves).toBe(1);
  });

  test("does not save when the panel is not in a savable state", async () => {
    let saves = 0;
    const autosave = createCommentAutosave({
      delayMs: 10,
      canSave: () => false,
      save: () => {
        saves += 1;
      },
    });

    autosave.queue();
    await wait(30);

    expect(saves).toBe(0);
  });
});
