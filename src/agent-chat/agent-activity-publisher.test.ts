import { describe, expect, test } from 'bun:test';

import { AgentActivityPublisher, buildAgentActivityId, normalizeUserVisibleActivity } from './agent-activity-publisher';

const context = {
  backendBaseUrl: 'https://tower', workspaceId: 'workspace-1', appNpub: 'npub1app',
  botIdentity: { botNpub: 'npub1agent', botPubkeyHex: '00', botSecret: new Uint8Array([1]) },
  channelId: 'channel-1', threadId: 'thread-1', triggerMessageId: 'message-1',
  sessionId: 'session-1', agentNpub: 'npub1agent', turnId: 'turn-1',
};

describe('Agent activity publisher', () => {
  test('normalizes bounded explicit commentary and rejects empty content', () => {
    expect(normalizeUserVisibleActivity('  Checking the task.\u0000  ')).toBe('Checking the task.');
    expect(normalizeUserVisibleActivity(' \n ')).toBeNull();
    expect(normalizeUserVisibleActivity('abcdef', 5)).toBe('abcd…');
  });

  test('builds a stable interaction id and publishes monotonic lifecycle snapshots', async () => {
    const delivered: any[] = [];
    const publisher = new AgentActivityPublisher(context, async (input) => { delivered.push(input); return {}; }, 0);
    await publisher.publish('accepted');
    await publisher.publish('working', 'Running validation.');
    await publisher.publish('working', 'Running validation.');
    await publisher.publish('completed');
    await publisher.publish('failed');
    expect(delivered.map((item) => [item.state, item.sequence])).toEqual([
      ['accepted', 1], ['working', 2], ['completed', 3],
    ]);
    expect(delivered[1]).toMatchObject({ channelId: 'channel-1', threadId: 'thread-1',
      triggerMessageId: 'message-1', sessionId: 'session-1', agentNpub: 'npub1agent' });
    expect(delivered[0].activityId).toBe(buildAgentActivityId(context));
  });

  test('retries one delivery failure and never throws into the reply path', async () => {
    let attempts = 0;
    const publisher = new AgentActivityPublisher(context, async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('temporary Tower failure');
      return {};
    });
    await expect(publisher.publish('accepted')).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    const unavailable = new AgentActivityPublisher(context, async () => { throw new Error('offline'); });
    await expect(unavailable.publish('failed')).resolves.toBeUndefined();
  });

  test('serializes deliveries so a slower earlier publish cannot overwrite newer commentary', async () => {
    const delivered: string[] = [];
    let releaseFirst!: () => void;
    const firstDelivery = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const publisher = new AgentActivityPublisher(context, async (input) => {
      if (input.body === 'First commentary') await firstDelivery;
      delivered.push(input.body ?? input.state);
      return {};
    }, 0);
    const first = publisher.publish('working', 'First commentary');
    const second = publisher.publish('working', 'Newest commentary');
    await Promise.resolve();
    releaseFirst();
    await Promise.all([first, second]);
    expect(delivered).toEqual(['First commentary', 'Newest commentary']);
  });

  test('ignores an older commentary read that completes after a newer poll', async () => {
    const delivered: string[] = [];
    let resolveOlder!: (value: any) => void;
    let reads = 0;
    const publisher = new AgentActivityPublisher(context, async (input) => {
      delivered.push(input.body ?? input.state);
      return {};
    }, 0, async () => {
      reads += 1;
      if (reads === 1) return await new Promise((resolve) => { resolveOlder = resolve; });
      return { content: 'Newest commentary', createdAt: '2026-07-24T00:00:03.000Z' };
    });
    const manager = { getSession: () => ({
      agent: 'codex', metadata: { nativeAgentSession: { agent: 'codex', sessionId: 'native-1', workingDirectory: '/repo' } },
    }) } as any;
    const olderPoll = publisher.publishLatestCommentary(manager);
    await publisher.publishLatestCommentary(manager);
    resolveOlder({ content: 'Older commentary', createdAt: '2026-07-24T00:00:02.000Z' });
    await olderPoll;
    expect(delivered).toEqual(['Newest commentary']);
  });
});
