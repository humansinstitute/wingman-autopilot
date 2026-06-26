import { readFile } from "node:fs/promises";

import type { ReplaceMessageInput } from "../storage/message-store";
import { findCodexSessionFile, resolveCodexHome } from "./codex-session-fork";

export interface CodexSessionMessagesInput {
  codexHome?: string;
  sessionId: string;
  workingDirectory: string;
}

export async function readCodexSessionMessages(
  input: CodexSessionMessagesInput,
): Promise<ReplaceMessageInput[]> {
  const sessionId = input.sessionId.trim();
  const workingDirectory = input.workingDirectory.trim();
  if (!sessionId || !workingDirectory) {
    return [];
  }

  const filePath = await findCodexSessionFile({
    codexHome: resolveCodexHome(input.codexHome),
    sessionId,
    workingDirectory,
  });
  if (!filePath) {
    return [];
  }

  return readCodexSessionMessagesFromFile(filePath);
}

export async function readCodexSessionMessagesFromFile(
  filePath: string,
): Promise<ReplaceMessageInput[]> {
  const content = await readFile(filePath, "utf8").catch(() => "");
  if (!content) {
    return [];
  }

  const importer = new CodexMessageImporter();
  for (const line of content.split("\n")) {
    const record = parseJsonLine(line);
    if (record) {
      importer.addRecord(record);
    }
  }
  return importer.finish();
}

interface CodexAgentMessage {
  phase: string;
  content: string;
  createdAt: string;
}

class CodexMessageImporter {
  private readonly messages: ReplaceMessageInput[] = [];
  private commentary: CodexAgentMessage[] = [];
  private finalAnswers: CodexAgentMessage[] = [];

  addRecord(record: Record<string, unknown>): void {
    const event = extractEventMessage(record);
    if (!event) {
      return;
    }

    if (event.type === "user_message") {
      this.flushAgentTurn();
      this.messages.push({ role: "user", content: event.content, createdAt: event.createdAt });
      return;
    }

    if (event.type === "agent_message") {
      const target = event.phase === "final_answer" ? this.finalAnswers : this.commentary;
      target.push({
        phase: event.phase,
        content: event.content,
        createdAt: event.createdAt,
      });
    }
  }

  finish(): ReplaceMessageInput[] {
    this.flushAgentTurn();
    return this.messages;
  }

  private flushAgentTurn(): void {
    if (this.finalAnswers.length > 0) {
      if (this.commentary.length > 0) {
        this.messages.push({
          role: "agent-working",
          content: joinMessageParts(this.commentary),
          createdAt: this.commentary[0]!.createdAt,
        });
      }
      this.messages.push({
        role: "agent",
        content: joinMessageParts(this.finalAnswers),
        createdAt: this.finalAnswers[0]!.createdAt,
      });
    } else if (this.commentary.length > 0) {
      this.messages.push({
        role: "agent",
        content: joinMessageParts(this.commentary),
        createdAt: this.commentary[0]!.createdAt,
      });
    }

    this.commentary = [];
    this.finalAnswers = [];
  }
}

function joinMessageParts(messages: CodexAgentMessage[]): string {
  return messages.map((message) => message.content).join("\n\n");
}

function extractEventMessage(record: Record<string, unknown>): {
  type: "user_message" | "agent_message";
  phase: string;
  content: string;
  createdAt: string;
} | null {
  if (record.type !== "event_msg") {
    return null;
  }
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const data = payload as Record<string, unknown>;
  const content = typeof data.message === "string" ? data.message.trim() : "";
  if (!content) {
    return null;
  }

  const createdAt = normaliseTimestamp(record.timestamp);
  if (data.type === "user_message") {
    return { type: "user_message", phase: "", content, createdAt };
  }
  if (data.type === "agent_message") {
    const phase = typeof data.phase === "string" ? data.phase.trim() : "";
    return { type: "agent_message", phase, content, createdAt };
  }
  return null;
}

function normaliseTimestamp(value: unknown): string {
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      return new Date(timestamp).toISOString();
    }
  }
  return new Date().toISOString();
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
