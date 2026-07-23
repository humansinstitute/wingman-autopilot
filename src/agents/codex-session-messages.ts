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
  private readonly toolNamesByCallId = new Map<string, string>();
  private commentary: CodexAgentMessage[] = [];
  private finalAnswers: CodexAgentMessage[] = [];

  addRecord(record: Record<string, unknown>): void {
    const event = extractEventMessage(record);
    if (!event) {
      const toolNote = extractToolWorkingNote(record, this.toolNamesByCallId);
      if (toolNote) {
        this.commentary.push({
          phase: "tool",
          content: toolNote.content,
          createdAt: toolNote.createdAt,
        });
      }
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
      return;
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
        role: "agent-working",
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

function extractToolWorkingNote(
  record: Record<string, unknown>,
  toolNamesByCallId: Map<string, string>,
): { content: string; createdAt: string } | null {
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const data = payload as Record<string, unknown>;
  const createdAt = normaliseTimestamp(record.timestamp);

  if (record.type === "response_item") {
    return extractResponseToolNote(data, createdAt, toolNamesByCallId);
  }
  if (record.type === "event_msg") {
    return extractEventToolNote(data, createdAt, toolNamesByCallId);
  }
  return null;
}

function extractResponseToolNote(
  data: Record<string, unknown>,
  createdAt: string,
  toolNamesByCallId: Map<string, string>,
): { content: string; createdAt: string } | null {
  const type = typeof data.type === "string" ? data.type : "";
  const callId = typeof data.call_id === "string" ? data.call_id : "";

  if (type === "function_call" || type === "custom_tool_call") {
    const name = typeof data.name === "string" && data.name.trim()
      ? data.name.trim()
      : type === "custom_tool_call" ? "custom_tool" : "function";
    if (callId) {
      toolNamesByCallId.set(callId, name);
    }
    const detail = summarizeToolInput(name, data);
    return {
      content: detail ? `Tool call: ${name} ${detail}` : `Tool call: ${name}`,
      createdAt,
    };
  }

  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const name = callId ? toolNamesByCallId.get(callId) : null;
    const summary = summarizeToolOutput(data);
    return {
      content: summary
        ? `Tool result: ${name ?? "tool"} ${summary}`
        : `Tool result: ${name ?? "tool"} completed`,
      createdAt,
    };
  }

  if (type === "web_search_call") {
    return {
      content: `Web search: ${summarizeWebSearchAction(data)}`,
      createdAt,
    };
  }

  if (type === "reasoning") {
    const summary = summarizeReasoning(data);
    if (!summary) {
      return null;
    }
    return { content: `Thinking: ${summary}`, createdAt };
  }

  return null;
}

function extractEventToolNote(
  data: Record<string, unknown>,
  createdAt: string,
  toolNamesByCallId: Map<string, string>,
): { content: string; createdAt: string } | null {
  const type = typeof data.type === "string" ? data.type : "";

  if (type === "patch_apply_end") {
    const callId = typeof data.call_id === "string" ? data.call_id : "";
    if (callId) {
      toolNamesByCallId.set(callId, "apply_patch");
    }
    const files = summarizeChangedFiles(data.changes);
    const status = data.success === false ? "failed" : "applied";
    return {
      content: files ? `Patch ${status}: ${files}` : `Patch ${status}`,
      createdAt,
    };
  }

  if (type === "web_search_end") {
    return { content: "Web search completed", createdAt };
  }

  return null;
}

function summarizeToolInput(name: string, data: Record<string, unknown>): string {
  const rawInput = typeof data.arguments === "string"
    ? data.arguments
    : typeof data.input === "string"
      ? data.input
      : "";
  if (!rawInput.trim()) {
    return "";
  }
  if (name === "exec_command") {
    const parsed = parseJsonObject(rawInput);
    const command = typeof parsed?.cmd === "string" ? parsed.cmd.trim() : "";
    return command ? `\`${truncateInline(command, 180)}\`` : "";
  }
  if (name === "write_stdin") {
    const parsed = parseJsonObject(rawInput);
    const sessionId = typeof parsed?.session_id === "number" ? String(parsed.session_id) : "";
    return sessionId ? `session ${sessionId}` : "";
  }
  if (name === "apply_patch") {
    const changedFiles = summarizePatchInput(rawInput);
    return changedFiles ? changedFiles : "patch";
  }
  return truncateInline(rawInput.replace(/\s+/g, " "), 180);
}

function summarizeToolOutput(data: Record<string, unknown>): string {
  const output = typeof data.output === "string" ? data.output.trim() : "";
  if (!output) {
    return "completed";
  }
  const exitMatch = output.match(/(?:Process )?exited with code\s+(-?\d+)|Exit code:\s*(-?\d+)/i);
  const exitCode = exitMatch?.[1] ?? exitMatch?.[2] ?? "";
  const status = exitCode ? `exit ${exitCode}` : "completed";
  const changedMatch = output.match(/Success\. Updated the following files:\s*([\s\S]+)/);
  if (changedMatch?.[1]) {
    const files = changedMatch[1]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(", ");
    return files ? `${status}: ${files}` : status;
  }
  return status;
}

function summarizeWebSearchAction(data: Record<string, unknown>): string {
  const action = data.action;
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return "started";
  }
  const value = action as Record<string, unknown>;
  const type = typeof value.type === "string" ? value.type : "";
  if (type === "search") {
    const query = typeof value.query === "string" ? value.query.trim() : "";
    return query ? `\`${truncateInline(query, 180)}\`` : "query";
  }
  if (type === "open_page") {
    const url = typeof value.url === "string" ? value.url.trim() : "";
    return url ? `open ${truncateInline(url, 180)}` : "open page";
  }
  if (type === "find_in_page") {
    const pattern = typeof value.pattern === "string" ? value.pattern.trim() : "";
    return pattern ? `find \`${truncateInline(pattern, 180)}\`` : "find in page";
  }
  return type || "started";
}

function summarizeReasoning(data: Record<string, unknown>): string {
  const summary = data.summary;
  if (!Array.isArray(summary)) {
    return "";
  }
  const parts = summary
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return "";
      }
      const value = item as Record<string, unknown>;
      return typeof value.text === "string" ? value.text : "";
    })
    .map((value) => value.trim())
    .filter(Boolean);
  return parts.length > 0 ? truncateInline(parts.join(" "), 240) : "";
}

function summarizeChangedFiles(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  return Object.keys(value as Record<string, unknown>)
    .slice(0, 5)
    .join(", ");
}

function summarizePatchInput(value: string): string {
  const files = Array.from(value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm))
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean)
    .slice(0, 5);
  return files.length > 0 ? files.join(", ") : "";
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 14)).trimEnd()}...[truncated]`;
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
