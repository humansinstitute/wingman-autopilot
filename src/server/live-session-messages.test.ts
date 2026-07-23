import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { SessionSnapshot } from "../agents/process-manager";
import { syncLiveSessionMessages } from "./live-session-messages";

const makeSession = (): SessionSnapshot => ({
  id: "wingman-1",
  agent: "codex",
  status: "running",
  npub: "npub1owner",
  port: 3700,
  pid: 1234,
  name: "Codex",
  startedAt: "2026-06-26T00:00:00.000Z",
  command: ["codex"],
  workingDirectory: "/repo",
  logs: [],
  agentRuntimeStatus: "stable",
  origin: null,
  pm2Name: null,
  targetFile: undefined,
  metadata: {
    AGENT: false,
    billingMode: "subscription",
    nativeAgentSession: {
      agent: "codex",
      sessionId: "native-1",
      workingDirectory: "/repo",
      capturedAt: "2026-06-26T00:00:00.000Z",
      source: "manual",
    },
  },
});

describe("syncLiveSessionMessages", () => {
  test("uses phase-aware Codex JSONL history instead of a larger combined live transcript", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codex-sync-test-"));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const sessionDir = join(codexHome, "sessions", "2026", "06", "26");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, "rollout-2026-06-26T00-00-00-native-1.jsonl"), [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-26T00:00:00.000Z",
          payload: { id: "native-1", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-26T00:00:01.000Z",
          payload: { type: "user_message", message: "First" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-26T00:00:02.000Z",
          payload: { type: "agent_message", phase: "commentary", message: "Checking." },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-26T00:00:03.000Z",
          payload: { type: "agent_message", phase: "final_answer", message: "Second" },
        }),
      ].join("\n"));

      const session = makeSession();
      const replaced: unknown[] = [];
      const messages = await syncLiveSessionMessages({
        sessionId: session.id,
        force: true,
        agentHost: "127.0.0.1",
        manager: {
          getSession: () => session,
          getAdapter: () => ({
            fetchMessages: async () => [
              { role: "agent", content: "startup", createdAt: "2026-06-26T00:00:00.000Z" },
              { role: "user", content: "First", createdAt: "2026-06-26T00:00:01.000Z" },
              { role: "agent", content: "Checking.\ntool output\nSecond", createdAt: "2026-06-26T00:00:03.000Z" },
              { role: "system", content: "stable", createdAt: "2026-06-26T00:00:04.000Z" },
            ],
          }),
        } as never,
        messageStore: {
          hasMessages: () => false,
          listSessionMessages: () => replaced,
          replaceMessages: (_sessionId: string, nextMessages: unknown[]) => {
            replaced.splice(0, replaced.length, ...nextMessages);
          },
        } as never,
      });

      expect(messages).toEqual([
        { role: "user", content: "First", createdAt: "2026-06-26T00:00:01.000Z" },
        { role: "agent-working", content: "Checking.", createdAt: "2026-06-26T00:00:02.000Z" },
        { role: "agent", content: "Second", createdAt: "2026-06-26T00:00:03.000Z" },
      ]);
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("uses Claude JSONL history when native transcript is richer than live adapter messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "live-claude-sync-test-"));
    const claudeHome = join(root, ".claude");
    const sessionFile = join(claudeHome, "projects", "-repo", "claude-native-1.jsonl");
    const originalClaudeConfigDir = Bun.env.CLAUDE_CONFIG_DIR;
    try {
      await mkdir(dirname(sessionFile), { recursive: true });
      await writeFile(sessionFile, [
        JSON.stringify({
          type: "user",
          timestamp: "2026-06-26T00:00:01.000Z",
          sessionId: "claude-native-1",
          cwd: "/repo",
          promptSource: "typed",
          message: { role: "user", content: "Hello Claude" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-06-26T00:00:02.000Z",
          sessionId: "claude-native-1",
          cwd: "/repo",
          message: { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }] },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-06-26T00:00:03.000Z",
          sessionId: "claude-native-1",
          cwd: "/repo",
          message: { role: "assistant", content: [{ type: "text", text: "Hello back." }] },
        }),
      ].join("\n"));
      Bun.env.CLAUDE_CONFIG_DIR = claudeHome;

      const replaced: unknown[] = [];
      const session = {
        id: "session-1",
        agent: "claude",
        status: "running",
        port: 4707,
        metadata: {
          nativeAgentSession: {
            agent: "claude",
            sessionId: "claude-native-1",
            workingDirectory: "/repo",
          },
        },
      };
      const result = await syncLiveSessionMessages({
        sessionId: "session-1",
        agentHost: "127.0.0.1",
        manager: {
          getSession: () => session,
          getAdapter: () => ({
            fetchMessages: async () => [{ role: "agent", content: "terminal transcript", createdAt: "2026-06-26T00:00:03.000Z" }],
          }),
        } as never,
        messageStore: {
          hasMessages: () => false,
          listSessionMessages: () => replaced,
          replaceMessages: (_sessionId: string, messages: unknown[]) => {
            replaced.splice(0, replaced.length, ...messages);
          },
        } as never,
      });

      expect(result).toEqual([
        { role: "user", content: "Hello Claude", createdAt: "2026-06-26T00:00:01.000Z" },
        { role: "agent-working", content: "Thinking...", createdAt: "2026-06-26T00:00:02.000Z" },
        { role: "agent", content: "Hello back.", createdAt: "2026-06-26T00:00:03.000Z" },
      ]);
    } finally {
      if (originalClaudeConfigDir === undefined) {
        delete Bun.env.CLAUDE_CONFIG_DIR;
      } else {
        Bun.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
