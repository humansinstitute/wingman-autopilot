import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePiSessionMessages, PiAdapter } from "./pi-adapter";

describe("parsePiSessionMessages", () => {
  test("extracts user and assistant text messages from session jsonl", () => {
    const content = [
      JSON.stringify({ type: "session", id: "abc" }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-15T13:10:14.631Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Reply with alpha" }],
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-15T13:10:21.116Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "..." },
            { type: "text", text: "alpha" },
          ],
        },
      }),
    ].join("\n");

    expect(parsePiSessionMessages(content)).toEqual([
      {
        role: "user",
        content: "Reply with alpha",
        createdAt: "2026-04-15T13:10:14.631Z",
      },
      {
        role: "assistant",
        content: "alpha",
        createdAt: "2026-04-15T13:10:21.116Z",
      },
    ]);
  });
});

describe("PiAdapter", () => {
  let scratchDir = "";
  const originalHome = process.env.HOME;

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (scratchDir) {
      await rm(scratchDir, { recursive: true, force: true });
      scratchDir = "";
    }
  });

  test("uses pi session-dir continuation to preserve context across sends", async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "wingmen-pi-adapter-"));
    process.env.HOME = scratchDir;

    const piAgentDir = join(scratchDir, ".pi", "agent");
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(piAgentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-5.3-codex" }),
    );
    await writeFile(join(piAgentDir, "auth.json"), JSON.stringify({ "openai-codex": { token: "test" } }));

    const fakePiPath = join(scratchDir, "fake-pi.js");
    await writeFile(
      fakePiPath,
      `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1];
const prompt = args[args.indexOf("-p") + 1];
fs.mkdirSync(sessionDir, { recursive: true });
const sessionFile = path.join(sessionDir, "session.jsonl");
const existing = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, "utf8").trim() : "";
if (!existing) {
  fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-1" }) + "\\n");
}
const previousPrompt = existing
  .split("\\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  })
  .filter(Boolean)
  .filter((entry) => entry.type === "message" && entry.message && entry.message.role === "user")
  .map((entry) => entry.message.content?.[0]?.text ?? "")
  .at(-1);
const reply = prompt.includes("previous requested reply") ? (previousPrompt ?? "unknown") : prompt.replace("Reply with exactly: ", "");
const now = new Date().toISOString();
fs.appendFileSync(sessionFile, JSON.stringify({ type: "message", timestamp: now, message: { role: "user", content: [{ type: "text", text: prompt }] } }) + "\\n");
fs.appendFileSync(sessionFile, JSON.stringify({ type: "message", timestamp: now, message: { role: "assistant", content: [{ type: "text", text: reply }] } }) + "\\n");
process.stdout.write(reply + "\\n");
`,
    );
    await chmod(fakePiPath, 0o755);

    const adapter = new PiAdapter({
      id: "session-123",
      port: 3703,
      agent: "pi",
      host: "127.0.0.1",
      workingDirectory: scratchDir,
      env: { PI_CLI: fakePiPath },
    });

    await adapter.sendMessage("Reply with exactly: alpha");
    await adapter.sendMessage("What was my previous requested reply? Answer with one word.");

    await expect(adapter.fetchMessages()).resolves.toEqual([
      {
        role: "user",
        content: "Reply with exactly: alpha",
        createdAt: expect.any(String),
      },
      {
        role: "assistant",
        content: "alpha",
        createdAt: expect.any(String),
      },
      {
        role: "user",
        content: "What was my previous requested reply? Answer with one word.",
        createdAt: expect.any(String),
      },
      {
        role: "assistant",
        content: "Reply with exactly: alpha",
        createdAt: expect.any(String),
      },
    ]);
  });
});
