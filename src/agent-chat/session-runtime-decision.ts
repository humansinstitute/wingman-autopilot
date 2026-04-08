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
    return {
      decision: 'failed',
      replyBody: trimmed,
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
