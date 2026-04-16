import { mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentAdapter, AdapterSessionContext } from "./agent-adapter";
import type { AgentRuntimeStatus } from "../types/agent-status";
import type { AgentMessage, AgentReadyOptions } from "./agent-client";
import { parsePiSessionMessages } from "./pi-session-messages";

type AdapterState = "initializing" | "ready" | "busy" | "disposed";

const DEFAULT_PI_CLI = "pi";
const PI_STARTUP_MESSAGE = "Pi session started. Send a message to begin.";
const PI_STARTUP_CREATED_AT = "1970-01-01T00:00:00.000Z";
const PI_BUSY_SESSION_FILE_RETRY_MS = 40;
const PI_BUSY_SESSION_FILE_RETRY_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export { parsePiSessionMessages } from "./pi-session-messages";

function buildPiEnv(context: AdapterSessionContext): Record<string, string> {
  const env = {
    ...(process.env as Record<string, string>),
    ...(context.env ?? {}),
  };

  if (!env.OPENROUTER_API_KEY && env.OPENROUTER_API) {
    env.OPENROUTER_API_KEY = env.OPENROUTER_API;
  }

  return env;
}

export class PiAdapter implements AgentAdapter {
  private readonly workingDirectory: string;
  private readonly sessionDirectory: string;
  private readonly piCommand: string;
  private readonly env: Record<string, string>;
  private state: AdapterState = "initializing";
  private messages: AgentMessage[] = [];

  constructor(private readonly context: AdapterSessionContext) {
    this.workingDirectory = context.workingDirectory ?? process.cwd();
    this.sessionDirectory = join(process.env.HOME ?? homedir(), ".wingmen", "pi-sessions", context.id);
    this.piCommand = context.env?.PI_CLI || process.env.PI_CLI || DEFAULT_PI_CLI;
    this.env = buildPiEnv(context);
  }

  async fetchStatus(_timeoutMs?: number): Promise<AgentRuntimeStatus | null> {
    if (this.state === "disposed") {
      return null;
    }
    return this.state === "busy" ? "running" : "stable";
  }

  async sendMessage(content: string, _type = "user"): Promise<void> {
    if (this.state === "disposed") {
      throw new Error("PiAdapter has been disposed");
    }

    await this.waitForReady();
    this.state = "busy";

    try {
      const hasExistingSession = await this.hasExistingSessionFile();
      const command = [
        this.piCommand,
        "--session-dir",
        this.sessionDirectory,
        ...(hasExistingSession ? ["--continue"] : []),
        "-p",
        content,
      ];

      const proc = Bun.spawn(command, {
        cwd: this.workingDirectory,
        env: this.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdoutText, stderrText, exitCode] = await Promise.all([
        proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
        proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
        proc.exited,
      ]);

      await this.reloadMessages();

      if ((exitCode ?? 0) !== 0) {
        const message = stderrText.trim() || stdoutText.trim() || `Pi exited with code ${exitCode ?? 1}`;
        throw new Error(message);
      }
    } finally {
      this.state = this.state === "disposed" ? "disposed" : "ready";
    }
  }

  async fetchMessages(): Promise<AgentMessage[]> {
    await this.reloadMessages();
    return this.messages;
  }

  async interruptCurrentTurn(): Promise<boolean> {
    return false;
  }

  getEventsUrl(): URL | null {
    return null;
  }

  async waitForReady(options?: AgentReadyOptions): Promise<void> {
    if (this.state === "disposed") {
      throw new Error("PiAdapter has been disposed");
    }

    await mkdir(this.sessionDirectory, { recursive: true });
    if (this.state === "initializing") {
      this.state = "ready";
    }

    const timeoutMs = options?.timeoutMs ?? 30000;
    const pollMs = options?.pollIntervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    while (this.state === "busy" && Date.now() < deadline) {
      await sleep(pollMs);
    }
    if (this.state === "busy") {
      throw new Error(`PiAdapter not ready after ${timeoutMs}ms`);
    }
  }

  async dispose(): Promise<void> {
    this.state = "disposed";
  }

  private async hasExistingSessionFile(): Promise<boolean> {
    const file = await this.findLatestSessionFile();
    return Boolean(file);
  }

  private async findLatestSessionFile(): Promise<string | null> {
    try {
      const entries = await readdir(this.sessionDirectory, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name)
        .sort();
      const latest = files.length > 0 ? files[files.length - 1] : null;
      return latest ? join(this.sessionDirectory, latest) : null;
    } catch {
      return null;
    }
  }

  private async reloadMessages(): Promise<void> {
    let sessionFile = await this.findLatestSessionFile();
    if (!sessionFile && this.state === "busy") {
      for (let attempt = 0; attempt < PI_BUSY_SESSION_FILE_RETRY_ATTEMPTS && !sessionFile; attempt += 1) {
        await sleep(PI_BUSY_SESSION_FILE_RETRY_MS);
        sessionFile = await this.findLatestSessionFile();
      }
    }
    if (!sessionFile) {
      this.messages = [
        {
          role: "assistant",
          content: PI_STARTUP_MESSAGE,
          createdAt: PI_STARTUP_CREATED_AT,
        },
      ];
      return;
    }
    const content = await readFile(sessionFile, "utf8");
    const parsedMessages = parsePiSessionMessages(content);
    this.messages = parsedMessages.length > 0
      ? parsedMessages
      : [
          {
            role: "assistant",
            content: PI_STARTUP_MESSAGE,
            createdAt: PI_STARTUP_CREATED_AT,
          },
        ];
  }
}
