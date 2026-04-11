import { describe, expect, test } from "bun:test";

import { createLiveSessionToolbar } from "./session-toolbar.js";

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || "").toLowerCase();
    this.className = "";
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.listeners = new Map();
    this.textContent = "";
    this.type = "";
  }

  append(...children) {
    this.children.push(...children.filter(Boolean));
  }

  addEventListener(type, callback) {
    const existing = this.listeners.get(type) || [];
    existing.push(callback);
    this.listeners.set(type, existing);
  }

  setAttribute(name, value) {
    const normalized = String(name || "");
    const stringValue = String(value ?? "");
    this.attributes[normalized] = stringValue;
    if (normalized === "data-testid") {
      this.dataset.testid = stringValue;
    }
  }
}

function withFakeDocument(run) {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement(tagName) {
      return new FakeElement(tagName);
    },
  };

  try {
    return run();
  } finally {
    globalThis.document = originalDocument;
  }
}

function queryByTestId(node, testId) {
  if (!node) return null;
  if (node instanceof FakeElement && node.dataset?.testid === testId) {
    return node;
  }
  if (!Array.isArray(node.children)) return null;
  for (const child of node.children) {
    if (child instanceof FakeElement) {
      const match = queryByTestId(child, testId);
      if (match) return match;
    }
  }
  return null;
}

describe("session-toolbar", () => {
  test("renders a visible live-session drawer control", () => {
    withFakeDocument(() => {
      const toolbar = createLiveSessionToolbar({
        title: "Drawer Test",
        meta: "codex:3700",
        drawerVisible: false,
      });

      expect(toolbar.dataset.testid).toBe("live-session-toolbar");
      expect(queryByTestId(toolbar, "live-session-drawer-toggle")?.textContent).toBe("Open Session Drawer");
    });
  });
});
