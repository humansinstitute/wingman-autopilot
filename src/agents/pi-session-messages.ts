import type { AgentMessage } from './agent-client';

interface PiSessionContentPart {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  arguments?: Record<string, unknown> | null;
}

interface PiSessionMessage {
  role?: string;
  timestamp?: string | number;
  content?: PiSessionContentPart[];
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
}

interface PiSessionEntry {
  type?: string;
  timestamp?: string;
  message?: PiSessionMessage;
}

const PI_PROGRESS_CREATED_AT = '1970-01-01T00:00:01.000Z';
const PI_WORKING_MESSAGE = 'Pi is working on your request...';
const PI_REASONING_MESSAGE = 'Pi is reasoning about your request...';

function safeParsePiEntries(content: string): PiSessionEntry[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as PiSessionEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is PiSessionEntry => Boolean(entry));
}

function extractPiTextParts(message: PiSessionMessage | undefined): string {
  const parts = Array.isArray(message?.content) ? message.content : [];
  const text = parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('')
    .trim();
  if (text.length > 0) {
    return text;
  }
  return typeof message?.errorMessage === 'string' ? message.errorMessage.trim() : '';
}

function resolvePiCreatedAt(entry: PiSessionEntry): string {
  const messageTimestamp = entry.message?.timestamp;
  if (typeof entry.timestamp === 'string' && entry.timestamp.trim().length > 0) {
    return entry.timestamp;
  }
  if (typeof messageTimestamp === 'string' && messageTimestamp.trim().length > 0) {
    return messageTimestamp;
  }
  if (typeof messageTimestamp === 'number') {
    return new Date(messageTimestamp).toISOString();
  }
  return new Date().toISOString();
}

function truncatePiDetail(value: string, maxLength = 64): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function summarizePiToolCall(part: PiSessionContentPart): string {
  const toolName = typeof part.name === 'string' && part.name.trim().length > 0
    ? part.name.trim()
    : 'tool';
  const args = part.arguments && typeof part.arguments === 'object' ? part.arguments : null;
  const command = typeof args?.command === 'string' ? args.command.trim() : '';
  if (command) {
    return `${toolName}: ${truncatePiDetail(command)}`;
  }
  const path = typeof args?.path === 'string' ? args.path.trim() : '';
  if (path) {
    return `${toolName}: ${truncatePiDetail(path)}`;
  }
  return toolName;
}

function summarizePiToolCalls(parts: PiSessionContentPart[]): string | null {
  const calls = parts
    .filter((part) => part?.type === 'toolCall')
    .map((part) => summarizePiToolCall(part))
    .filter((value) => value.length > 0);

  if (calls.length === 0) {
    return null;
  }

  if (calls.length === 1) {
    return `Pi is working... ${calls[0]}`;
  }

  const [first, second, ...rest] = calls;
  const summary = [first, second].filter(Boolean).join(', ');
  if (rest.length === 0) {
    return `Pi is working... ${summary}`;
  }
  return `Pi is working... ${summary} (+${rest.length} more)`;
}

function buildPiProgressMessage(
  entry: PiSessionEntry | null,
  fallbackCreatedAt: string,
): AgentMessage {
  const message = entry?.message;
  const parts = Array.isArray(message?.content) ? message.content : [];
  const toolCallSummary = summarizePiToolCalls(parts);
  if (toolCallSummary) {
    return {
      role: 'assistant',
      content: toolCallSummary,
      createdAt: resolvePiCreatedAt(entry!),
    };
  }

  if (message?.role === 'toolResult') {
    const toolName = typeof message.toolName === 'string' && message.toolName.trim().length > 0
      ? message.toolName.trim()
      : 'tool';
    return {
      role: 'assistant',
      content: `Pi is working... completed ${toolName}`,
      createdAt: resolvePiCreatedAt(entry!),
    };
  }

  const hasThinking = parts.some((part) => part?.type === 'thinking');
  return {
    role: 'assistant',
    content: hasThinking ? PI_REASONING_MESSAGE : PI_WORKING_MESSAGE,
    createdAt: entry ? resolvePiCreatedAt(entry) : fallbackCreatedAt,
  };
}

export function parsePiSessionMessages(content: string): AgentMessage[] {
  const messages: AgentMessage[] = [];

  for (const entry of safeParsePiEntries(content)) {
    if (entry.type !== 'message' || !entry.message) {
      continue;
    }

    const role =
      entry.message.role === 'user' || entry.message.role === 'assistant'
        ? entry.message.role
        : null;
    if (!role) {
      continue;
    }

    const text = extractPiTextParts(entry.message);
    if (!text) {
      continue;
    }

    messages.push({
      role,
      content: text,
      createdAt: resolvePiCreatedAt(entry),
    });
  }

  return messages;
}

export function parsePiSessionMessagesWithProgress(
  content: string,
  options?: { includeProgress?: boolean },
): AgentMessage[] {
  const messages = parsePiSessionMessages(content);
  if (!options?.includeProgress) {
    return messages;
  }

  const entries = safeParsePiEntries(content).filter((entry) => entry.type === 'message' && entry.message);
  const lastEntry = entries.length > 0 ? entries[entries.length - 1]! : null;
  const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user');
  const lastAssistantIndex = messages.map((message) => message.role).lastIndexOf('assistant');
  const awaitingAssistantReply = lastUserIndex > lastAssistantIndex;
  if (!awaitingAssistantReply) {
    return messages;
  }

  const progressMessage = buildPiProgressMessage(
    lastEntry,
    messages[lastUserIndex]?.createdAt ?? PI_PROGRESS_CREATED_AT,
  );
  return [...messages, progressMessage];
}
