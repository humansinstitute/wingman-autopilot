import { describe, expect, test } from 'bun:test';

import { buildBootstrapPrompt, buildMergedTurnPrompt } from './session-runtime-prompts';

describe('Agent chat prompts', () => {
  test('bootstrap prompt states that the agent must publish the thread reply itself', () => {
    const prompt = buildBootstrapPrompt({
      agent: {
        agentId: 'agent_wm21',
        label: 'Wingman 21',
        botNpub: 'npub1bot',
        workspaceOwnerNpub: 'npub1workspace',
        groupNpubs: ['npub1group'],
        workingDirectory: '/tmp/wm21',
        capabilities: ['chat_intercept'],
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        managedByNpub: 'npub1manager',
      },
      isNewSession: true,
      subscription: {
        subscriptionId: 'sub-1',
        workspaceOwnerNpub: 'npub1workspace',
        backendBaseUrl: 'https://tower.example.com',
        botNpub: 'npub1bot',
        sourceAppNpub: 'npub1source',
        wsKeyNpub: null,
        wsKeyStatus: 'active',
        groupKeyStatus: 'active',
        sseStatus: 'connected',
        healthStatus: 'healthy',
        triggerConfigRecordId: null,
        lastSseEventId: null,
        lastAuthOkAt: null,
        lastGroupRefreshAt: null,
        lastErrorCode: null,
        lastErrorAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        managedByNpub: 'npub1manager',
        wsKeyBlobJson: null,
        wrappedGroupKeysJson: null,
        lastAuthResult: null,
        lastGroupRefreshResult: null,
        lastRecordPullResult: null,
        lastDecryptResult: null,
        lastRoutingResult: null,
        lastSseEvent: null,
        lastSuccessfulStartupReloadAt: null,
      },
      intercept: {
        routingKey: 'routing-key',
        subscriptionId: 'sub-1',
        agentId: 'agent_wm21',
        sessionId: 'session-1',
        sessionClass: 'chat',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        channelId: 'channel-1',
        threadId: 'thread-1',
        botNpub: 'npub1bot',
        lastMessageIdSeen: null,
        pendingMessageCount: 0,
        state: 'pending',
        lastDecision: 'pending',
        lastActivityAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      session: {
        id: 'session-1',
        agent: 'codex',
        port: 0,
        name: 'Agent Chat',
        status: 'running',
        startedAt: new Date().toISOString(),
        command: [],
        workingDirectory: '/tmp/wm21',
        logs: [],
      },
      yokeStateDir: '/tmp/state',
      context: null,
      contextError: null,
      latestTurn: {
        messageId: 'msg-1',
        senderNpub: 'npub1human',
        sentAt: new Date().toISOString(),
        content: 'Hello',
      },
    });

    expect(prompt).toContain('Nothing you write in this session is visible to the human unless you publish a reply into the chat thread.');
    expect(prompt).toContain('your final action must be to publish the reply into the current thread yourself by using the Yoke reply-current command shown above.');
    expect(prompt).toContain('After you have published the reply, end with only the decision line AGENT_CHAT_DECISION: respond and no extra text.');
  });

  test('merged prompt states that the agent must publish the reply back into the same thread', () => {
    const prompt = buildMergedTurnPrompt({
      intercept: {
        routingKey: 'routing-key',
        subscriptionId: 'sub-1',
        agentId: 'agent_wm21',
        sessionId: 'session-1',
        sessionClass: 'chat',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        channelId: 'channel-1',
        threadId: 'thread-1',
        botNpub: 'npub1bot',
        lastMessageIdSeen: null,
        pendingMessageCount: 0,
        state: 'active',
        lastDecision: 'pending',
        lastActivityAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      yokeStateDir: '/tmp/state',
      contextError: null,
      turns: [
        {
          messageId: 'msg-1',
          senderNpub: 'npub1human',
          sentAt: new Date().toISOString(),
          content: 'Follow up',
        },
      ],
      followUpMode: 'interrupt_failed_follow_up',
    });

    expect(prompt).toContain('Nothing you write in this session is visible to the human unless you publish a reply into the chat thread.');
    expect(prompt).toContain('your final action must be to publish the reply into the current thread yourself by using the Yoke reply-current command shown above.');
    expect(prompt).toContain('After you have published the reply, end with only the decision line AGENT_CHAT_DECISION: respond and no extra text.');
  });
});
