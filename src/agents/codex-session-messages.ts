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

  const messages: ReplaceMessageInput[] = [];
  for (const line of content.split("\n")) {
    const record = parseJsonLine(line);
    const message = record ? extractMessage(record) : null;
    if (message) {
      messages.push(message);
    }
  }
  return messages;
}

function extractMessage(record: Record<string, unknown>): ReplaceMessageInput | null {
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
    return { role: "user", content, createdAt };
  }
  if (data.type === "agent_message") {
    return { role: "agent", content, createdAt };
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
