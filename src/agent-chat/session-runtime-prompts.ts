import type { SessionSnapshot } from '../agents/process-manager';
import type { AgentDefinitionRecord, ChatInterceptStateRecord, WorkspaceSubscriptionRecord } from './types';
import { buildAgentChatYokeCommands, type AgentChatYokeContext } from './yoke-runtime';

export interface QueuedChatTurn {
  messageId: string | null;
  senderNpub: string | null;
  sentAt: string;
  content: string;
}

function truncateText(value: string, maxLength = 120): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function formatRecentTurns(context: AgentChatYokeContext | null, fallbackTurn: QueuedChatTurn): string {
  const recentMessages = context?.recent_messages ?? [];
  if (recentMessages.length > 0) {
    return recentMessages
      .map((message, index) => {
        const sender = message.sender_npub ?? 'unknown';
        return `${index + 1}. ${sender}: ${truncateText(message.body, 240) || '[empty]'}`;
      })
      .join('\n');
  }

  const sender = fallbackTurn.senderNpub ?? 'unknown';
  const body = truncateText(fallbackTurn.content, 240) || '[empty]';
  return `1. ${sender}: ${body}`;
}

function formatParticipants(context: AgentChatYokeContext | null, fallbackParticipants: string[]): string {
  const participants = context?.participants?.length ? context.participants : fallbackParticipants;
  return participants.filter((value) => value.length > 0).join(', ') || 'unknown';
}

function buildMergePackage(
  intercept: ChatInterceptStateRecord,
  turns: QueuedChatTurn[],
): string {
  return JSON.stringify(
    {
      type: 'chat_turn_merge_v1',
      routing_key: intercept.routingKey,
      thread_id: intercept.threadId,
      messages: turns.map((turn) => ({
        message_id: turn.messageId,
        sender_npub: turn.senderNpub,
        sent_at: turn.sentAt,
        content: turn.content,
      })),
    },
    null,
    2,
  );
}

export function buildBootstrapPrompt(params: {
  agent: AgentDefinitionRecord;
  isNewSession: boolean;
  subscription: WorkspaceSubscriptionRecord;
  intercept: ChatInterceptStateRecord;
  session: SessionSnapshot;
  yokeStateDir: string;
  context: AgentChatYokeContext | null;
  contextError: string | null;
  latestTurn: QueuedChatTurn;
}): string {
  const fallbackParticipants = [params.subscription.botNpub, params.latestTurn.senderNpub ?? ''].filter(
    (value) => value.length > 0,
  );
  const commands = buildAgentChatYokeCommands(
    params.yokeStateDir,
    params.intercept.channelId,
    params.intercept.threadId,
  );
  const recentTurns = formatRecentTurns(params.context, params.latestTurn);
  const participants = formatParticipants(params.context, fallbackParticipants);
  const bootstrapMode = params.isNewSession ? 'new_session' : 'reused_session';

  return [
    `Agent Chat runtime event: ${bootstrapMode}.`,
    '',
    'Thread package:',
    `- agent_id: ${params.agent.agentId}`,
    `- agent_label: ${params.agent.label}`,
    `- workspace_owner_npub: ${params.subscription.workspaceOwnerNpub}`,
    `- channel_id: ${params.intercept.channelId}`,
    `- thread_id: ${params.intercept.threadId}`,
    `- bot_npub: ${params.agent.botNpub}`,
    `- managed_by_npub: ${params.subscription.managedByNpub ?? 'unknown'}`,
    `- session_id: ${params.session.id}`,
    `- recent_turn_count: ${params.context?.recent_messages?.length ?? 1}`,
    `- participants: ${participants}`,
    '',
    'Recent turns:',
    recentTurns,
    '',
    'Yoke runtime commands:',
    `- Prime current context: ${commands.context}`,
    `- More thread history: ${commands.history}`,
    `- Search active channel: ${commands.search}`,
    `- Related threads: ${commands.related}`,
    `- Publish the thread reply yourself: ${commands.replyCurrent}`,
    '',
    params.contextError
      ? `Yoke context warning: ${params.contextError}`
      : 'Yoke context is ready in the session state dir shown above.',
    '',
    'Instructions:',
    '- You are inspecting the current thread for the registered local agent only.',
    '- Start your answer with exactly one line: AGENT_CHAT_DECISION: respond or AGENT_CHAT_DECISION: ignore',
    '- Nothing you write in this session is visible to the human unless you publish a reply into the chat thread.',
    '- If you decide to respond, your final action must be to publish the reply into the current thread yourself by using the Yoke reply-current command shown above.',
    '- After you have published the reply, end with only the decision line AGENT_CHAT_DECISION: respond and no extra text.',
    '- Use the Yoke commands above if you need more context before answering.',
    '- Only include reply text after the decision line if you are intentionally falling back to Wingmen handoff because you could not publish the reply directly.',
    '- If you choose ignore, do not add any extra text after the decision line.',
    '- Do not tell the human to run commands.',
    '- Do not include tool transcripts in your final answer.',
    '- Wingmen may fall back to relaying a reply body only when the decision is respond and you included one.',
  ].join('\n');
}

export function buildMergedTurnPrompt(params: {
  intercept: ChatInterceptStateRecord;
  yokeStateDir: string;
  contextError: string | null;
  turns: QueuedChatTurn[];
  followUpMode: 'interrupt_resumed' | 'interrupt_failed_follow_up';
}): string {
  const commands = buildAgentChatYokeCommands(
    params.yokeStateDir,
    params.intercept.channelId,
    params.intercept.threadId,
  );
  const mergePackage = buildMergePackage(params.intercept, params.turns);

  return [
    `Agent Chat runtime event: ${params.followUpMode}.`,
    '',
    'A busy thread received additional user turns. Process the merged update package below in arrival order and continue on the same thread.',
    '',
    'Merge package JSON:',
    '```json',
    mergePackage,
    '```',
    '',
    'Yoke runtime commands:',
    `- Prime current context: ${commands.context}`,
    `- More thread history: ${commands.history}`,
    `- Search active channel: ${commands.search}`,
    `- Related threads: ${commands.related}`,
    `- Publish the thread reply yourself: ${commands.replyCurrent}`,
    '',
    params.contextError
      ? `Yoke context warning: ${params.contextError}`
      : 'Yoke context is ready in the session state dir shown above.',
    '',
    'Instructions:',
    '- Stay on the current session and current routing key.',
    '- Start your answer with exactly one line: AGENT_CHAT_DECISION: respond or AGENT_CHAT_DECISION: ignore',
    '- Nothing you write in this session is visible to the human unless you publish a reply into the chat thread.',
    '- If you decide to respond, your final action must be to publish the reply into the current thread yourself by using the Yoke reply-current command shown above.',
    '- After you have published the reply, end with only the decision line AGENT_CHAT_DECISION: respond and no extra text.',
    '- Treat the JSON package as authoritative for the newly arrived user turns.',
    '- Preserve the arrival order of the merged user turns when reasoning about the reply.',
    '- Only include reply text after the decision line if you are intentionally falling back to Wingmen handoff because you could not publish the reply directly.',
    '- If you choose ignore, do not add any extra text after the decision line.',
    '- Do not include the JSON package verbatim in the final answer.',
  ].join('\n');
}
