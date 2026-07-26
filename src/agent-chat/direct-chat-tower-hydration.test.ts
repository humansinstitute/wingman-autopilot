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

test('Agent Direct Chat hydration falls back when Tower has no single-channel route', async () => {
  const result = await hydrateDirectChatThread({
    subscription: { workspaceId: 'workspace', backendBaseUrl: 'https://tower', sourceAppNpub: 'app' } as never,
    botIdentity: {} as never,
    channelId: 'channel',
    threadId: 'thread',
  }, {
    fetchChannel: async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); },
    fetchMessages: async () => ({
      messages: [{ id: 'm1', thread_id: 'thread', scope_id: 'scope' }],
      next_cursor: null,
    }),
  });

  expect(result.channel).toEqual({ id: 'channel', workspace_id: 'workspace', scope_id: 'scope' });
  expect(result.messages.map((message) => message.id)).toEqual(['m1']);
});

test('Agent Direct Chat hydration still rejects non-404 channel failures', async () => {
  const failure = Object.assign(new Error('Forbidden'), { status: 403 });
  await expect(hydrateDirectChatThread({
    subscription: { workspaceId: 'workspace', backendBaseUrl: 'https://tower', sourceAppNpub: 'app' } as never,
    botIdentity: {} as never,
    channelId: 'channel',
    threadId: 'thread',
  }, {
    fetchChannel: async () => { throw failure; },
    fetchMessages: async () => ({ messages: [], next_cursor: null }),
  })).rejects.toBe(failure);
});
