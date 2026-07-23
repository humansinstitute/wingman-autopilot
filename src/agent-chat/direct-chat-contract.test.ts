import { describe, expect, test } from 'bun:test';
import {
  buildDirectChatBootstrapPrompt, buildDirectChatClientRequestId, buildDirectChatFollowUpPrompt,
  buildDirectChatTurnId, channelDirectChatConfig, hasCanonicalNpubMention, isImplicitTwoPartyDirectMessage, orderDirectChatMessages,
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

  test('recognises only an authored strict two-party DM as implicit activation', () => {
    const strictDm = { id: 'dm', kind: 'dm', participant_npubs: ['npub1rick', 'npub1human'] };
    expect(isImplicitTwoPartyDirectMessage(strictDm, 'npub1rick', 'npub1human')).toBe(true);
    expect(isImplicitTwoPartyDirectMessage(strictDm, 'npub1rick', 'npub1outsider')).toBe(false);
    expect(isImplicitTwoPartyDirectMessage({ ...strictDm, participant_npubs: ['npub1human', 'npub1other'] }, 'npub1rick', 'npub1human')).toBe(false);
    expect(isImplicitTwoPartyDirectMessage({ ...strictDm, participant_npubs: ['npub1rick', 'npub1human', 'npub1other'] }, 'npub1rick', 'npub1human')).toBe(false);
    expect(isImplicitTwoPartyDirectMessage({ ...strictDm, kind: 'channel' }, 'npub1rick', 'npub1human')).toBe(false);
  });

  test('defaults channels to Direct enabled with explicit false as the opt-out and legacy context fallback', () => {
    expect(channelDirectChatConfig({ id: 'c1', metadata: {} })).toEqual({ enabled: true, contextPrompt: '' });
    expect(channelDirectChatConfig({ id: 'c2', metadata: { contextPrompt: 'Legacy context' } })).toEqual({ enabled: true, contextPrompt: 'Legacy context' });
    expect(channelDirectChatConfig({ id: 'c3', metadata: { basePrompt: 'Base', agent_chat: { context_prompt: 'Direct' } } })).toEqual({ enabled: true, contextPrompt: 'Direct' });
    expect(channelDirectChatConfig({ id: 'c4', metadata: { agent_chat: { enabled: false } } })).toEqual({ enabled: false, contextPrompt: '' });
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
    expect(bootstrap).toContain('polished response using GitHub-Flavored Markdown');
    expect(bootstrap).toContain('normal final response is published verbatim to Flight Deck');
    expect(bootstrap).toContain('do not add a wrapper or envelope');
    expect(bootstrap).toContain('or enclose the whole response in a code fence');
    expect(bootstrap).not.toContain('FLIGHTDECK_REPLY_BEGIN');
    const followUp = buildDirectChatFollowUpPrompt('route', 't1', [messages[1]!]);
    expect(followUp).toContain('flightdeck_agent_direct_follow_up_v1');
    expect(followUp).toContain('polished response using GitHub-Flavored Markdown');
    expect(followUp).toContain('published verbatim to Flight Deck');
    expect(followUp).not.toContain('FLIGHTDECK_REPLY_BEGIN');
  });

  test('derives stable turn and publication ids', () => {
    const turn = buildDirectChatTurnId('route', ['m1', 'm2']);
    expect(turn).toBe(buildDirectChatTurnId('route', ['m1', 'm2']));
    expect(buildDirectChatClientRequestId('route', turn)).toMatch(/^agentdirect:[a-f0-9]{24}:[a-f0-9]{32}$/);
    expect(buildDirectChatRoutingKey({ towerServiceNpub: 'tower', workspaceId: 'workspace', channelId: 'channel', threadId: 'thread', agentNpub: 'rick' }))
      .toBe('agent-direct:v1:tower:workspace:channel:thread:rick');
  });
});
