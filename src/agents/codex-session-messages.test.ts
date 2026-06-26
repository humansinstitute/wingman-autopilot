import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { readCodexSessionMessagesFromFile } from "./codex-session-messages";

describe("Codex session message importer", () => {
  test("extracts user and agent bubbles from Codex event messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-messages-test-"));
    const filePath = join(root, "rollout.jsonl");
    try {
      await writeFile(filePath, [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-26T00:00:00.000Z",
          payload: { id: "native-1", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-26T00:00:01.000Z",
          payload: { type: "user_message", message: "What next?" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-26T00:00:02.000Z",
          payload: { type: "message", role: "assistant", content: [{ text: "duplicate" }] },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-26T00:00:03.000Z",
          payload: { type: "agent_message", message: "Ship the small fix." },
        }),
      ].join("\n"));

      await expect(readCodexSessionMessagesFromFile(filePath)).resolves.toEqual([
        { role: "user", content: "What next?", createdAt: "2026-06-26T00:00:01.000Z" },
        { role: "agent", content: "Ship the small fix.", createdAt: "2026-06-26T00:00:03.000Z" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
