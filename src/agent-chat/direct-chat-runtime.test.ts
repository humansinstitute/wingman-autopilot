import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { AgentDefinitionStore } from './agent-definition-store';
import { ChatInterceptStateStore } from './chat-intercept-state-store';
import { AgentDirectChatRuntime } from './direct-chat-runtime';
import { DirectChatTurnStore } from './direct-chat-turn-store';
import { buildDirectChatClientRequestId, buildDirectChatRoutingKey, buildDirectChatTurnId } from './direct-chat-contract';
import type { FlightDeckPgMessage } from './tower-client';

function fixture(options: {
  publish?: (input: any, attempt: number) => Promise<any>;
  directChat?: { enabled: boolean; sessionAgent: string | null; directory: string; model: string | null; idleRetentionMinutes: number } | null;
  replyRole?: 'assistant' | 'agent';
  includeWorkingMessage?: boolean;
  finalContent?: string;
  channel?: Record<string, unknown>;
} = {}) {
  const db = join(tmpdir(), `agent-direct-${randomUUID()}.sqlite`);
  const agentStore = new AgentDefinitionStore(db);
  const interceptStore = new ChatInterceptStateStore(db);
  const turnStore = new DirectChatTurnStore(db);
  const sessions = new Map<string, any>();
  const prompts: string[] = [];
  const creates: any[] = [];
  const manager = {
    getSession: (id: string) => sessions.get(id) ?? null,
    getAdapter: (id: string) => ({
      waitForReady: async () => {}, fetchStatus: async () => 'stable', deliversPromptsDirectly: () => true, fetchMessages: async () => [...(sessions.get(id).messages ?? [])],
      sendMessage: async (prompt: string) => {
        prompts.push(prompt);
        if (options.includeWorkingMessage) sessions.get(id).messages.push({ role: 'agent-working', content: 'Thinking and tool progress', createdAt: new Date().toISOString() });
        sessions.get(id).messages.push({ role: options.replyRole ?? 'assistant', content: options.finalContent ?? '## Answer\n\nFinal **Markdown**.', createdAt: new Date().toISOString() });
      },
    }),
    createSession: async (...args: any[]) => {
      creates.push(args);
      const metadata = { ...(args[6] ?? {}), nativeAgentSession: args[6]?.nativeAgentSession ?? { agent: args[0], sessionId: `native-${creates.length}`, workingDirectory: args[1], capturedAt: new Date().toISOString(), source: 'manual' } };
      const session = { id: `session-${creates.length}`, agent: args[0], workingDirectory: args[1], name: args[2], status: 'running', startedAt: new Date().toISOString(), port: 1, command: [], logs: [], metadata, model: args[7], messages: [] };
      sessions.set(session.id, session); return session;
    },
  } as never;
  const published: any[] = [];
  const publish = async (input: any) => { published.push(input); return options.publish ? options.publish(input, published.length) : { message: { id: `agent-message-${published.length}` } }; };
  const makeRuntime = () => new AgentDirectChatRuntime({ defaultAgent: 'codex', processManager: manager, agentStore, interceptStore, turnStore, publish });
  const runtime = makeRuntime();
  const now = new Date().toISOString();
  const defaultDirectChat = { enabled: true, sessionAgent: 'codex', directory: '/Users/mini/wingmen/wingman21', model: null, idleRetentionMinutes: 60 };
  agentStore.save({ agentId: 'rick', label: 'Rick', botNpub: 'npub1rick', workspaceOwnerNpub: 'npub1workspace', groupNpubs: [], workingDirectory: '/legacy', capabilities: ['chat_intercept'],
    directChat: options.directChat === null ? undefined : options.directChat ?? defaultDirectChat, enabled: true, createdAt: now, updatedAt: now, managedByNpub: 'npub1manager' });
  const subscription: any = { subscriptionId: 'sub1', workspaceOwnerNpub: 'npub1owner', workspaceServiceNpub: 'npub1workspace', workspaceId: 'workspace-1', towerServiceNpub: 'npub1tower', backendBaseUrl: 'https://tower', sourceAppNpub: 'npub1app', botNpub: 'npub1rick', wsKeyNpub: 'npub1mapped', managedByNpub: 'npub1manager' };
  const channel: any = { id: 'channel-1', scope_id: 'scope-1', kind: 'channel', participant_npubs: [], metadata: { agent_chat: { enabled: true, activation: 'mention_then_continue', context_prompt: 'Context' } }, ...(options.channel ?? {}) };
  const botIdentity: any = { botNpub: 'npub1rick', botPubkeyHex: '00', botSecret: new Uint8Array([1]) };
  const message = (id: string, body: string, mention: false | { type?: string; npub?: string } | true = false, authorNpub = 'npub1human'): FlightDeckPgMessage => ({ id, workspace_id: 'workspace-1', channel_id: 'channel-1', thread_id: 'thread-1', body, created_at: `2026-01-01T00:00:0${id.slice(-1)}Z`, created_by_actor_id: `actor-${id}`, created_by_actor_npub: authorNpub, metadata: mention ? { mentions: [{ type: mention === true ? 'agent' : mention.type ?? '', npub: mention === true ? 'npub1rick' : mention.npub ?? 'npub1rick', label: 'Rick' }] } : {} });
  const handle = (messages: FlightDeckPgMessage[], entityId: string) => runtime.handle({ subscription, botIdentity, channel, messages, event: { entity_id: entityId, channel_id: 'channel-1', cursor: `cursor-${entityId}` } });
  return { runtime, makeRuntime, handle, message, prompts, creates, published, interceptStore, turnStore, sessions, subscription, channel, botIdentity };
}

describe('Agent Direct Chat runtime', () => {
  test('creates one normal Rick session in the configured directory and publishes once', async () => {
    const f = fixture(); const m1 = f.message('m1', '@Rick hello', true);
    expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.creates[0][1]).toBe('/Users/mini/wingmen/wingman21');
    expect(f.prompts[0]).toContain('AGENT DIRECT CHAT'); expect(f.published).toHaveLength(1);
    expect(f.published[0].clientRequestId).toMatch(/^agentdirect:/);
    const state = f.interceptStore.listAll()[0]!;
    expect(state.lastHumanMessageIdDelivered).toBe('m1'); expect(state.lastAgentMessageIdPublished).toBe('agent-message-1'); expect(state.lastCompletedTurnId).toBeTruthy();
  });

  test('publishes only the completed final card returned with the sessions API agent role', async () => {
    const richMarkdown = [
      '# Release notes',
      '',
      'A paragraph with [a link](https://example.com) and `inline code`.',
      '',
      '- First item',
      '- **Second item**',
      '',
      '```ts',
      'const ready = true;',
      '```',
    ].join('\n');
    const f = fixture({ replyRole: 'agent', includeWorkingMessage: true, finalContent: richMarkdown }); const m1 = f.message('m1', '@Rick hello', true);
    expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.published).toHaveLength(1); expect(f.published[0].body).toBe(richMarkdown);
    expect(f.published[0].body.startsWith('```\n')).toBe(false);
    expect(f.published[0].body).not.toContain('Thinking and tool progress');
    expect(f.interceptStore.listAll()[0]?.state).toBe('idle');
  });

  test('defaults a legacy null-config chat agent to Direct Chat in its working directory', async () => {
    const f = fixture({ directChat: null }); const m1 = f.message('m1', '@Rick hello', { type: 'person' });
    expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.creates[0][0]).toBe('codex'); expect(f.creates[0][1]).toBe('/legacy');
  });

  test('preserves an explicit Direct Chat opt-out', async () => {
    const f = fixture({ directChat: { enabled: false, sessionAgent: null, directory: '/legacy', model: null, idleRetentionMinutes: 60 } });
    const m1 = f.message('m1', '@Rick hello', { type: 'person' });
    expect(await f.handle([m1], 'm1')).toEqual({ handled: false, reason: 'no_direct_chat_agent' });
    expect(f.creates).toHaveLength(0);
  });

  test('literal mention text does not activate an unbound thread', async () => {
    const f = fixture(); const m1 = f.message('m1', '@Rick hello');
    expect(await f.handle([m1], 'm1')).toEqual({ handled: false, reason: 'not_activated' });
    expect(f.creates).toHaveLength(0);
  });

  test('activates by matching mention npub even when Tower classifies the actor as a person', async () => {
    const f = fixture(); const m1 = f.message('m1', '@Rick hello', { type: 'person' });
    expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.published).toHaveLength(1);
  });

  test('does not activate for a canonical mention of another npub', async () => {
    const f = fixture(); const m1 = f.message('m1', '@Other hello', { type: 'agent', npub: 'npub1other' });
    expect(await f.handle([m1], 'm1')).toEqual({ handled: false, reason: 'not_activated' });
    expect(f.creates).toHaveLength(0);
  });

  test('skips an unmentioned shared-thread follow-up without disturbing the binding, then reuses it when mentioned', async () => {
    const f = fixture(); const m1 = f.message('m1', 'hello', true); await f.handle([m1], 'm1'); await f.runtime.waitForIdle();
    const m2 = f.message('m2', 'follow up'); await f.handle([m1, m2], 'm2'); await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.prompts).toHaveLength(1); expect(f.published).toHaveLength(1);
    expect(f.interceptStore.listAll()[0]?.lastHumanMessageIdDelivered).toBe('m1');
    const m3 = f.message('m3', '@Rick follow up', true); await f.handle([m1, m2, m3], 'm3'); await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.prompts).toHaveLength(2); expect(f.prompts[1]).toContain('flightdeck_agent_direct_follow_up_v1');
    expect(f.prompts[1]).toContain('"message_id": "m3"'); expect(f.prompts[1]).not.toContain('"message_id": "m2"');
    expect(f.interceptStore.listAll()[0]?.lastHumanMessageIdDelivered).toBe('m3');
  });

  test('routes unmentioned messages only in a strict two-party DM and reuses its session', async () => {
    const f = fixture({ channel: { kind: 'dm', participant_npubs: ['npub1rick', 'npub1human'] } });
    const m1 = f.message('m1', 'hello'); expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' }); await f.runtime.waitForIdle();
    const m2 = f.message('m2', 'follow up'); expect(await f.handle([m1, m2], 'm2')).toEqual({ handled: true, reason: 'direct_chat_queued' }); await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.prompts).toHaveLength(2); expect(f.published).toHaveLength(2);
  });

  test('intrinsically enables a live-shape strict DM and falls back to its legacy basePrompt', async () => {
    const f = fixture({ channel: {
      kind: 'dm',
      participant_npubs: ['npub1human', 'npub1rick'],
      metadata: { basePrompt: 'You are Rick in Pete’s direct Flight Deck chat.' },
    } });
    const m1 = f.message('m1', 'Can you track this?');
    expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain('CHANNEL CONTEXT\nYou are Rick in Pete’s direct Flight Deck chat.');
  });

  test('keeps an explicitly opted-out shared channel disabled even when a canonical mention is present', async () => {
    const f = fixture({ channel: { kind: 'channel', participant_npubs: ['npub1human', 'npub1rick'], metadata: { agent_chat: { enabled: false }, basePrompt: 'Legacy context' } } });
    const m1 = f.message('m1', '@Rick hello', true);
    expect(await f.handle([m1], 'm1')).toEqual({ handled: false, reason: 'channel_disabled' });
    expect(f.creates).toHaveLength(0);
  });

  test('requires a mention for malformed, multi-party, or outsider-authored DMs', async () => {
    const cases = [
      { participants: ['npub1human', 'npub1other'], author: 'npub1human' },
      { participants: ['npub1rick', 'npub1human', 'npub1other'], author: 'npub1human' },
      { participants: ['npub1rick', 'npub1human'], author: 'npub1outsider' },
    ];
    for (const [index, item] of cases.entries()) {
      const f = fixture({ channel: { kind: 'dm', participant_npubs: item.participants } });
      const unmentioned = f.message(`m${index + 1}`, 'hello', false, item.author);
      expect(await f.handle([unmentioned], unmentioned.id)).toEqual({ handled: false, reason: 'not_activated' });
      const mentioned = f.message(`m${index + 4}`, '@Rick hello', true, item.author);
      expect(await f.handle([mentioned], mentioned.id)).toEqual({ handled: true, reason: 'direct_chat_queued' });
      await f.runtime.waitForIdle(); expect(f.creates).toHaveLength(1);
    }
  });

  test('natively resumes a stopped session without increasing generation', async () => {
    const f = fixture(); const m1 = f.message('m1', 'hello', true); await f.handle([m1], 'm1'); await f.runtime.waitForIdle();
    f.sessions.get('session-1').status = 'stopped'; const m2 = f.message('m2', 'again', true); await f.handle([m1, m2], 'm2'); await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(2); expect(f.creates[1][3].type).toBe('native-resume');
    expect(f.interceptStore.listAll()[0]!.sessionGeneration).toBe(1);
  });

  test('creates a generation-two continuity replacement when the session is missing', async () => {
    const f = fixture(); const m1 = f.message('m1', 'hello', true); await f.handle([m1], 'm1'); await f.runtime.waitForIdle();
    f.sessions.delete('session-1'); const m2 = f.message('m2', 'recover', true); await f.handle([m1, m2], 'm2'); await f.runtime.waitForIdle();
    const state = f.interceptStore.listAll()[0]!; expect(state.sessionGeneration).toBe(2); expect(state.previousSessionIds).toEqual(['session-1']);
    expect(f.prompts[1]).toContain('CONTINUITY RECOVERY');
  });

  test('queues quick replies without overlapping turns and preserves order', async () => {
    const f = fixture(); const m1 = f.message('m1', 'one', true); const m2 = f.message('m2', 'two', true);
    await Promise.all([f.handle([m1], 'm1'), f.handle([m1, m2], 'm2')]); await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.prompts).toHaveLength(2);
    expect(f.prompts[0]).toContain('message_id: m1'); expect(f.prompts[1]).toContain('"message_id": "m2"');
  });

  test('retries publication with the same client request id after restart-style replay', async () => {
    const f = fixture({ publish: async (_input, attempt) => {
      if (attempt === 1) throw Object.assign(new Error('temporary'), { status: 503 });
      return { message: { id: 'agent-message-replayed' } };
    } });
    const m1 = f.message('m1', 'hello', true); await f.handle([m1], 'm1'); await f.runtime.waitForIdle();
    expect(f.published).toHaveLength(1);
    await f.handle([m1], 'm1'); await f.runtime.waitForIdle();
    expect(f.published).toHaveLength(2); expect(f.published[1].clientRequestId).toBe(f.published[0].clientRequestId);
    expect(f.prompts).toHaveLength(1); expect(f.interceptStore.listAll()[0]!.lastAgentMessageIdPublished).toBe('agent-message-replayed');
  });

  test('recovers an accepted turn after restart from the existing clean final without resending its prompt', async () => {
    const f = fixture();
    const m1 = f.message('m1', '@Rick survive restart', true);
    const routingKey = buildDirectChatRoutingKey({ towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1', agentNpub: 'npub1rick' });
    const turnId = buildDirectChatTurnId(routingKey, ['m1']);
    const now = new Date().toISOString();
    const seeded = f.interceptStore.upsertMessage({ routingKey, subscriptionId: 'sub1', agentId: 'rick', workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1app', towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1',
      botNpub: 'npub1rick', messageId: 'm1', eventCursor: 'cursor-m1', at: now }).record;
    f.interceptStore.save({ ...seeded, sessionId: 'surviving-session', state: 'active', lastHumanMessageIdDelivered: 'm1', pendingMessageCount: 0 });
    f.turnStore.save({ turnId, routingKey, sourceMessageIds: ['m1'], clientRequestId: buildDirectChatClientRequestId(routingKey, turnId),
      replyBody: null, publishedMessageId: null, state: 'accepted', createdAt: now, updatedAt: now });
    f.sessions.set('surviving-session', { id: 'surviving-session', agent: 'codex', workingDirectory: '/Users/mini/wingmen/wingman21', name: 'Rick Direct Chat',
      status: 'running', startedAt: now, port: 1, command: [], logs: [], metadata: {}, messages: [
        { role: 'user', content: 'AGENT DIRECT CHAT\ntrigger_message_id: m1', createdAt: now },
        { role: 'assistant', content: '## Recovered final\n\nPublished once.', createdAt: now },
      ] });

    const restarted = f.makeRuntime();
    expect(restarted.recover({ subscription: f.subscription, botIdentity: f.botIdentity, channel: f.channel, messages: [m1],
      event: { entity_id: 'm1', channel_id: 'channel-1', cursor: 'cursor-m1' } }, routingKey))
      .toEqual({ handled: true, reason: 'direct_chat_recovery_queued' });
    await restarted.waitForIdle();
    expect(f.prompts).toHaveLength(0); expect(f.published).toHaveLength(1);
    expect(f.published[0].body).toBe('## Recovered final\n\nPublished once.');
    expect(f.published[0].clientRequestId).toBe(buildDirectChatClientRequestId(routingKey, turnId));
    expect(f.turnStore.getPending(routingKey)).toBeNull();
    expect(f.interceptStore.getByRoutingKey(routingKey)?.lastCompletedTurnId).toBe(turnId);
  });

  test('blocks on Tower auth failure without publishing speculative output', async () => {
    const f = fixture({ publish: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); } });
    const m1 = f.message('m1', 'hello', true); await f.handle([m1], 'm1'); await f.runtime.waitForIdle();
    expect(f.interceptStore.listAll()[0]!.state).toBe('blocked_auth'); expect(f.published).toHaveLength(1);
    expect(f.interceptStore.listAll()[0]!.lastAgentMessageIdPublished).toBeNull();
  });
});
