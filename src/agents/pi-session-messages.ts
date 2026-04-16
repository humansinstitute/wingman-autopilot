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
  id?: string;
  type?: string;
  timestamp?: string;
  message?: PiSessionMessage;
}

interface PiToolCallSummary {
  label: string;
  content: string;
}

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

function truncatePiDetail(value: string, maxLength = 120): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function readPiToolArgument(args: Record<string, unknown> | null, key: string): string {
  if (!args) {
    return '';
  }
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

function buildPiToolCallSummary(part: PiSessionContentPart): PiToolCallSummary {
  const toolName = typeof part.name === 'string' && part.name.trim().length > 0
    ? part.name.trim()
    : 'tool';
  const args = part.arguments && typeof part.arguments === 'object' ? part.arguments : null;
  const command = readPiToolArgument(args, 'command');
  const path = readPiToolArgument(args, 'path');
  const target = command || path;
  const label = target ? `${toolName}: ${truncatePiDetail(target)}` : toolName;
  const content = target
    ? `${toolName}\n${target}`
    : toolName;

  return {
    label,
    content,
  };
}

function extractPiToolCalls(message: PiSessionMessage | undefined): PiSessionContentPart[] {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts.filter((part) => part?.type === 'toolCall');
}

function buildPiToolCallContent(parts: PiSessionContentPart[]): string {
  const summaries = parts.map((part) => buildPiToolCallSummary(part));
  if (summaries.length === 0) {
    return '';
  }
  if (summaries.length === 1) {
    return summaries[0]!.content;
  }
  return summaries
    .map((summary, index) => `[${index + 1}] ${summary.content}`)
    .join('\n\n');
}

function buildPiToolResultContent(
  message: PiSessionMessage,
  toolCallsById: Map<string, PiToolCallSummary>,
): string {
  const body = extractPiTextParts(message);
  const toolName = typeof message.toolName === 'string' && message.toolName.trim().length > 0
    ? message.toolName.trim()
    : 'tool';
  const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
  const callSummary = toolCallsById.get(toolCallId);
  const header = callSummary?.label ?? toolName;

  if (!body) {
    return header;
  }

  return `${header}\n\n${body}`;
}

export function parsePiSessionMessages(content: string): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const toolCallsById = new Map<string, PiToolCallSummary>();

  for (const entry of safeParsePiEntries(content)) {
    if (entry.type !== 'message' || !entry.message) {
      continue;
    }

    const createdAt = resolvePiCreatedAt(entry);
    const role = entry.message.role;

    if (role === 'user') {
      const text = extractPiTextParts(entry.message);
      if (text) {
        messages.push({
          role: 'user',
          content: text,
          createdAt,
        });
      }
      continue;
    }

    if (role === 'assistant') {
      const text = extractPiTextParts(entry.message);
      if (text) {
        messages.push({
          role: 'assistant',
          content: text,
          createdAt,
        });
      }

      const toolCalls = extractPiToolCalls(entry.message);
      if (toolCalls.length > 0) {
        for (const toolCall of toolCalls) {
          const toolCallId = typeof toolCall.id === 'string' ? toolCall.id : '';
          if (toolCallId) {
            toolCallsById.set(toolCallId, buildPiToolCallSummary(toolCall));
          }
        }

        messages.push({
          role: 'assistant',
          content: buildPiToolCallContent(toolCalls),
          createdAt,
        });
      }
      continue;
    }

    if (role === 'toolResult') {
      const content = buildPiToolResultContent(entry.message, toolCallsById);
      if (content) {
        messages.push({
          role: 'assistant',
          content,
          createdAt,
        });
      }
    }
  }

  return messages;
}

export function parsePiSessionMessagesWithProgress(content: string): AgentMessage[] {
  return parsePiSessionMessages(content);
}
