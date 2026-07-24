import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { readCodexSessionMessagesFromFile, readLatestCodexUserVisibleActivity } from "./codex-session-messages";

describe("Codex session message importer", () => {
  test("selects only explicit commentary for cross-suite activity", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codex-activity-"));
    const sessionId = "activity-session";
    const sessionDir = join(codexHome, "sessions", "2026", "07", "24");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, `rollout-${sessionId}.jsonl`), [
      JSON.stringify({ type: "session_meta", timestamp: "2026-07-24T00:00:00Z", payload: { id: sessionId, cwd: "/repo" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-24T00:00:01Z", payload: { type: "reasoning", summary: [{ text: "hidden" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-24T00:00:02Z", payload: { type: "function_call", name: "exec_command", arguments: "{\\\"cmd\\\":\\\"secret\\\"}" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-24T00:00:03Z", payload: { type: "agent_message", phase: "commentary", message: "Running focused validation." } }),
    ].join("\n"));
    expect(await readLatestCodexUserVisibleActivity({ codexHome, sessionId, workingDirectory: "/repo" })).toEqual({
      content: "Running focused validation.", createdAt: "2026-07-24T00:00:03.000Z",
    });
    await rm(codexHome, { recursive: true, force: true });
  });
  test("groups commentary as working notes before final answers", async () => {
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
          payload: { type: "agent_message", phase: "commentary", message: "Checking files." },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-26T00:00:03.250Z",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "call-1",
            arguments: JSON.stringify({ cmd: "bun test src/agents/codex-session-messages.test.ts" }),
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-26T00:00:03.500Z",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output: "Chunk ID: abc\nProcess exited with code 0\nOutput:\npass",
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-26T00:00:03.750Z",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            call_id: "call-2",
            input: [
              "*** Begin Patch",
              "*** Update File: src/agents/codex-session-messages.ts",
              "@@",
              "+changed",
              "*** End Patch",
            ].join("\n"),
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-26T00:00:03.900Z",
          payload: {
            type: "patch_apply_end",
            call_id: "call-2",
            success: true,
            changes: {
              "/repo/src/agents/codex-session-messages.ts": { type: "update" },
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-26T00:00:04.000Z",
          payload: { type: "agent_message", phase: "commentary", message: "Running tests." },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-26T00:00:05.000Z",
          payload: { type: "agent_message", phase: "final_answer", message: "Ship the small fix." },
        }),
      ].join("\n"));

      const messages = await readCodexSessionMessagesFromFile(filePath);

      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({ role: "user", content: "What next?", createdAt: "2026-06-26T00:00:01.000Z" });
      expect(messages[1]?.role).toBe("agent-working");
      expect(messages[1]?.createdAt).toBe("2026-06-26T00:00:03.000Z");
      expect(messages[1]?.content).toContain("Checking files.");
      expect(messages[1]?.content).toContain("Tool call: exec_command `bun test src/agents/codex-session-messages.test.ts`");
      expect(messages[1]?.content).toContain("Tool result: exec_command exit 0");
      expect(messages[1]?.content).toContain("Tool call: apply_patch src/agents/codex-session-messages.ts");
      expect(messages[1]?.content).toContain("Patch applied: /repo/src/agents/codex-session-messages.ts");
      expect(messages[1]?.content).toContain("Running tests.");
      expect(messages[2]).toEqual({ role: "agent", content: "Ship the small fix.", createdAt: "2026-06-26T00:00:05.000Z" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps commentary as working output when there is no final answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-messages-test-"));
    const filePath = join(root, "rollout.jsonl");
    try {
      await writeFile(filePath, [
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-26T00:00:01.000Z",
          payload: { type: "user_message", message: "Status?" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-26T00:00:02.000Z",
          payload: { type: "agent_message", phase: "commentary", message: "Still checking." },
        }),
      ].join("\n"));

      await expect(readCodexSessionMessagesFromFile(filePath)).resolves.toEqual([
        { role: "user", content: "Status?", createdAt: "2026-06-26T00:00:01.000Z" },
        { role: "agent-working", content: "Still checking.", createdAt: "2026-06-26T00:00:02.000Z" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
