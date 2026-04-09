import type { AgentInterceptDecision } from './types';

export interface ParsedAgentChatReply {
  decision: AgentInterceptDecision;
  replyBody: string;
}

const DECISION_PREFIX = 'AGENT_CHAT_DECISION:';

function normaliseDecision(value: string): AgentInterceptDecision {
  switch (value.trim().toLowerCase()) {
    case 'respond':
      return 'respond';
    case 'ignore':
      return 'ignore';
    default:
      return 'failed';
  }
}

function parseFallbackDecision(firstLine: string): AgentInterceptDecision {
  const trimmed = firstLine.trim();
  if (!trimmed) {
    return 'failed';
  }
  const normalised = trimmed.toLowerCase();
  if (/^(respond|ignore)\b/.test(normalised)) {
    return normaliseDecision(normalised);
  }
  const decisionMatch = normalised.match(/^(?:decision:\s*)?(?:i\s+(?:should|will)\s+)?(respond|ignore)\b/);
  return decisionMatch ? normaliseDecision(decisionMatch[1] ?? '') : 'failed';
}

export function parseAgentChatReply(content: string): ParsedAgentChatReply {
  const trimmed = content.trim();
  if (!trimmed) {
    return {
      decision: 'failed',
      replyBody: '',
    };
  }

  const lines = trimmed.split(/\r?\n/);
  const firstLine = lines[0]?.trim() ?? '';
  if (!firstLine.startsWith(DECISION_PREFIX)) {
    const fallbackDecision = parseFallbackDecision(firstLine);
    return {
      decision: fallbackDecision,
      replyBody: lines
        .slice(1)
        .join('\n')
        .trim(),
    };
  }

  const decision = normaliseDecision(firstLine.slice(DECISION_PREFIX.length));
  const replyBody = lines
    .slice(1)
    .join('\n')
    .trim();

  return {
    decision,
    replyBody,
  };
}
