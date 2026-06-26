export type BranchConversationMode = "full" | "recent";

export interface BranchConversationInput {
  sourceSessionId: string;
  name?: string;
  mode: BranchConversationMode;
  messageCount?: number;
}

export interface BranchConversationMessage {
  role: string;
  content: string;
  createdAt?: string;
}

const DEFAULT_RECENT_MESSAGE_COUNT = 40;
const MAX_RECENT_MESSAGE_COUNT = 200;
const MAX_MESSAGE_CHARS = 6_000;
const MAX_CONTEXT_CHARS = 120_000;

export function validateBranchConversationInput(payload: unknown): BranchConversationInput {
  if (!payload || typeof payload !== "object") {
    return {
      sourceSessionId: "",
      mode: "full",
    };
  }

  const record = payload as Record<string, unknown>;
  const rawMode = typeof record.mode === "string" ? record.mode.trim().toLowerCase() : "";
  const mode: BranchConversationMode = rawMode === "recent" ? "recent" : "full";
  if (rawMode && rawMode !== "recent" && rawMode !== "full") {
    throw new Error("Branch mode must be full or recent");
  }

  const rawName = typeof record.name === "string" ? record.name.trim() : "";
  const rawMessageCount = typeof record.messageCount === "number"
    ? Math.floor(record.messageCount)
    : DEFAULT_RECENT_MESSAGE_COUNT;
  const messageCount = Math.min(Math.max(1, rawMessageCount), MAX_RECENT_MESSAGE_COUNT);

  return {
    sourceSessionId: "",
    name: rawName ? rawName.slice(0, 120) : undefined,
    mode,
    messageCount,
  };
}

export function normalizeBranchConversationMessages(messages: unknown[]): BranchConversationMessage[] {
  return messages
    .map((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return null;
      }
      const record = message as Record<string, unknown>;
      const role = typeof record.role === "string"
        ? record.role.trim()
        : typeof record.type === "string"
          ? record.type.trim()
          : "";
      const content = typeof record.content === "string"
        ? record.content
        : typeof record.message === "string"
          ? record.message
          : typeof record.text === "string"
            ? record.text
            : "";
      if (!role || !content.trim()) {
        return null;
      }
      const createdAt = typeof record.createdAt === "string"
        ? record.createdAt
        : typeof record.timestamp === "string"
          ? record.timestamp
          : undefined;
      return {
        role,
        content,
        createdAt,
      };
    })
    .filter((message): message is BranchConversationMessage => Boolean(message));
}

export function selectBranchConversationMessages(
  messages: BranchConversationMessage[],
  input: BranchConversationInput,
): BranchConversationMessage[] {
  if (input.mode === "recent") {
    return messages.slice(-(input.messageCount ?? DEFAULT_RECENT_MESSAGE_COUNT));
  }
  return messages;
}

export function formatBranchConversationPrompt(options: {
  sourceSessionId: string;
  sourceName: string;
  messages: BranchConversationMessage[];
  mode: BranchConversationMode;
}): string {
  const lines: string[] = [
    `This is a branched conversation from Autopilot session ${options.sourceSessionId}.`,
    "",
    "You are now in a new, independent Codex session. Use the transcript below as context from the source session, but do not write back to or pollute the source session. Answer questions, analyze what happened, or continue in this branch only.",
    "",
    `Source session: ${options.sourceName}`,
    `Context mode: ${options.mode}`,
    "",
    "--- Transcript ---",
    "",
  ];

  let totalChars = lines.join("\n").length;
  let omittedMessages = 0;

  for (const message of options.messages) {
    const role = formatRole(message.role);
    const timestamp = message.createdAt ? ` ${message.createdAt}` : "";
    const content = truncateText(message.content.trim(), MAX_MESSAGE_CHARS);
    const block = [`[${role}${timestamp}]`, content, ""].join("\n");
    if (totalChars + block.length > MAX_CONTEXT_CHARS) {
      omittedMessages += 1;
      continue;
    }
    lines.push(block);
    totalChars += block.length;
  }

  if (omittedMessages > 0) {
    lines.push(`[${omittedMessages} messages omitted to keep this branch prompt bounded.]`, "");
  }

  lines.push("--- End Transcript ---", "");
  lines.push("Start by acknowledging that you are operating in the branched session and wait for the operator's next direction unless they included one after this context.");
  return lines.join("\n");
}

function formatRole(role: string): string {
  const normalized = role.trim().toLowerCase();
  if (normalized === "user") return "User";
  if (normalized === "assistant" || normalized === "agent") return "Assistant";
  return normalized ? normalized[0]!.toUpperCase() + normalized.slice(1) : "Message";
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...[truncated]`;
}
