import { expect, test } from 'bun:test';
import { hydrateDirectChatThread } from './direct-chat-tower-hydration';

test('Agent Direct Chat hydration reads every authoritative thread page', async () => {
  const cursors: Array<string | null | undefined> = [];
  const result = await hydrateDirectChatThread({
    subscription: { workspaceId: 'workspace', backendBaseUrl: 'https://tower', sourceAppNpub: 'app' } as never,
    botIdentity: {} as never,
    channelId: 'channel',
    threadId: 'thread',
  }, {
    fetchChannel: async () => ({ id: 'channel', metadata: { agent_chat: { enabled: true } } }),
    fetchMessages: async (input) => {
      cursors.push(input.cursor);
      return input.cursor
        ? { messages: [{ id: 'm2', thread_id: 'thread' }], next_cursor: null }
        : { messages: [{ id: 'm1', thread_id: 'thread' }], next_cursor: 'page-2' };
    },
  });
  expect(cursors).toEqual([null, 'page-2']);
  expect(result.messages.map((message) => message.id)).toEqual(['m1', 'm2']);
});
