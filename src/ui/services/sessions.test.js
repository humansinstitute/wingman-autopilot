import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

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
});
