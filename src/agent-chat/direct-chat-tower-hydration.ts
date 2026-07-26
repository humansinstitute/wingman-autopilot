import { fetchFlightDeckPgChannel, fetchFlightDeckPgChannelMessages,
  type FlightDeckPgChannel, type FlightDeckPgMessage } from './tower-client';
import type { RuntimeBotIdentity, WorkspaceSubscriptionRecord } from './types';

interface HydrationDependencies {
  fetchChannel: typeof fetchFlightDeckPgChannel;
  fetchMessages: typeof fetchFlightDeckPgChannelMessages;
}

export async function hydrateDirectChatThread(input: {
  subscription: WorkspaceSubscriptionRecord;
  botIdentity: RuntimeBotIdentity;
  channelId: string;
  threadId: string;
}, deps: HydrationDependencies): Promise<{ channel: FlightDeckPgChannel; messages: FlightDeckPgMessage[] }> {
  if (!input.subscription.workspaceId) throw new Error('Agent Direct Chat requires a Flight Deck PG workspace id.');
  const common = { backendBaseUrl: input.subscription.backendBaseUrl, workspaceId: input.subscription.workspaceId,
    channelId: input.channelId, appNpub: input.subscription.sourceAppNpub, botIdentity: input.botIdentity };
  const messages: FlightDeckPgMessage[] = [];
  let cursor: string | null = null;
  do {
    const page = await deps.fetchMessages({ ...common, threadId: input.threadId, cursor, limit: 200 });
    messages.push(...page.messages);
    cursor = page.next_cursor ?? null;
  } while (cursor);
  let channel: FlightDeckPgChannel;
  try {
    channel = await deps.fetchChannel(common);
  } catch (error) {
    if (!error || typeof error !== 'object' || (error as { status?: unknown }).status !== 404) throw error;
    const firstMessage = messages[0];
    channel = {
      id: input.channelId,
      workspace_id: input.subscription.workspaceId,
      scope_id: firstMessage?.scope_id ?? null,
    };
  }
  return { channel, messages };
}
