import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { fetchSessionMessagesApi } from "./sessions.js";

const source = readFileSync(new URL("./sessions.js", import.meta.url), "utf8");

describe("sessions service source contract", () => {
  test("uses PATCH /api/sessions/:id/metadata for session metadata edits", () => {
    expect(source).toContain("export async function updateSessionMetadataApi(sessionId, metadata)");
    expect(source).toContain("fetch(`/api/sessions/${sessionId}/metadata`, {");
    expect(source).toContain('method: "PATCH"');
    expect(source).toContain('headers: { "content-type": "application/json" }');
    expect(source).toContain("body: JSON.stringify(metadata)");
  });

  test("surfaces API-provided error text for metadata update failures", () => {
    expect(source).toContain('const message = typeof data?.error === "string" ? data.error : response.statusText;');
    expect(source).toContain('throw new Error(message || "Failed to update session metadata")');
  });

  test("loads stored session messages by default", async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls = [];
    globalThis.fetch = async (url) => {
      requestedUrls.push(String(url));
      return new Response(JSON.stringify({ messages: [] }), {
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await fetchSessionMessagesApi("session-1");
      await fetchSessionMessagesApi("session-1", { refresh: true });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestedUrls).toEqual([
      "/api/sessions/session-1/messages",
      "/api/sessions/session-1/messages?refresh=true",
    ]);
  });
});
