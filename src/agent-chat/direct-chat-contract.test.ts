import { describe, expect, test } from 'bun:test';
import {
  buildDirectChatBootstrapPrompt, buildDirectChatClientRequestId, buildDirectChatFollowUpPrompt,
  buildDirectChatTurnId, hasCanonicalNpubMention, orderDirectChatMessages, parseDirectChatReply,
  buildDirectChatRoutingKey,
  selectUndeliveredHumanMessages,
} from './direct-chat-contract';

describe('Agent Direct Chat contract', () => {
  const messages = orderDirectChatMessages([
    { id: 'm2', body: 'second', created_at: '2026-01-01T00:00:02Z', created_by_actor_npub: 'npub1human' },
    { id: 'm1', body: '@Rick first', created_at: '2026-01-01T00:00:01Z', created_by_actor_npub: 'npub1human', metadata: { mentions: [{ type: 'agent', npub: 'npub1rick', label: 'Rick' }] } },
    { id: 'a1', body: 'reply', created_at: '2026-01-01T00:00:03Z', created_by_actor_npub: 'npub1rick' },
  ]);

  test('requires canonical npub mention metadata and orders authoritative history', () => {
    expect(messages.map((message) => message.messageId)).toEqual(['m1', 'm2', 'a1']);
    expect(hasCanonicalNpubMention(messages[0]!, 'npub1rick')).toBe(true);
    expect(hasCanonicalNpubMention({ ...messages[0]!, mentions: [] }, 'npub1rick')).toBe(false);
  });

  test('routes canonical npubs independently of actor presentation type', () => {
    const base = messages[0]!;
    for (const type of ['agent', 'person', 'actor', '']) {
      expect(hasCanonicalNpubMention({ ...base, mentions: [{ type, npub: 'npub1rick', actorId: 'actor-rick', label: 'Rick' }] }, 'npub1rick')).toBe(true);
    }
    expect(hasCanonicalNpubMention({ ...base, mentions: [{ type: 'agent', npub: 'npub1other', actorId: null, label: 'Other' }] }, 'npub1rick')).toBe(false);
    expect(hasCanonicalNpubMention({ ...base, message: '@Rick', mentions: [] }, 'npub1rick')).toBe(false);
  });

  test('selects only undelivered human deltas', () => {
    expect(selectUndeliveredHumanMessages(messages, { lastHumanMessageIdDelivered: 'm1' } as never, 'npub1rick').map((message) => message.messageId)).toEqual(['m2']);
  });

  test('builds bootstrap and follow-up prompt contracts', () => {
    const intercept = { routingKey: 'route', channelId: 'c1', threadId: 't1', botNpub: 'npub1rick', towerServiceNpub: 'npub1tower', workspaceId: 'w1' } as never;
    const subscription = { towerServiceNpub: 'npub1tower', workspaceId: 'w1' } as never;
    const bootstrap = buildDirectChatBootstrapPrompt({ contextPrompt: 'Project context', subscription, intercept, scopeId: 's1', history: messages, nextMessages: [messages[0]!] });
    expect(bootstrap).toContain('AGENT DIRECT CHAT');
    expect(bootstrap).toContain('tower_service_npub: npub1tower');
    expect(bootstrap).toContain('THREAD HISTORY JSON');
    expect(bootstrap).toContain('NEXT MESSAGE');
    expect(bootstrap).toContain('FLIGHTDECK_REPLY_BEGIN/FLIGHTDECK_REPLY_END');
    expect(buildDirectChatFollowUpPrompt('route', 't1', [messages[1]!])).toContain('flightdeck_agent_direct_follow_up_v1');
  });

  test('accepts exactly one non-empty reply envelope', () => {
    expect(parseDirectChatReply('FLIGHTDECK_REPLY_BEGIN\nHello\nFLIGHTDECK_REPLY_END')).toBe('Hello');
    expect(parseDirectChatReply('prefix\nFLIGHTDECK_REPLY_BEGIN\nHello\nFLIGHTDECK_REPLY_END')).toBeNull();
    expect(parseDirectChatReply('FLIGHTDECK_REPLY_BEGIN\n\nFLIGHTDECK_REPLY_END')).toBeNull();
  });

  test('derives stable turn and publication ids', () => {
    const turn = buildDirectChatTurnId('route', ['m1', 'm2']);
    expect(turn).toBe(buildDirectChatTurnId('route', ['m1', 'm2']));
    expect(buildDirectChatClientRequestId('route', turn)).toMatch(/^agentdirect:[a-f0-9]{24}:[a-f0-9]{32}$/);
    expect(buildDirectChatRoutingKey({ towerServiceNpub: 'tower', workspaceId: 'workspace', channelId: 'channel', threadId: 'thread', agentNpub: 'rick' }))
      .toBe('agent-direct:v1:tower:workspace:channel:thread:rick');
  });
});
