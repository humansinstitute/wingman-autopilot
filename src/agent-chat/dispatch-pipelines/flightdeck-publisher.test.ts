import { beforeEach, describe, expect, mock, test } from 'bun:test';

const yokeCommandCalls: string[][] = [];

const runAgentWorkspaceYokeCommandMock = mock(async (input: { args: string[] }) => {
  yokeCommandCalls.push(input.args);
  if (input.args[0] === 'chat' && input.args[1] === 'reply-current') {
    return JSON.stringify({
      channel_id: input.args[input.args.indexOf('--channel') + 1],
      thread_id: input.args[input.args.indexOf('--thread') + 1],
      message_id: 'chat-reply-1',
      status: 'sent',
    });
  }
  return JSON.stringify({
    synced: 1,
    created: input.args[0] === 'tasks' && input.args[1] === 'comment' ? 1 : 0,
    updated: input.args[0] === 'tasks' && input.args[1] === 'update' ? 1 : 0,
    rejected: [],
    warnings: [],
  });
});

mock.module('../yoke-runtime', () => ({
  buildAgentChatYokeCommands: () => ({}),
  buildAgentDocumentCommentYokeCommands: () => ({}),
  buildAgentTaskCommentYokeCommands: () => ({}),
  prepareAgentWorkspaceYokeRuntime: mock(async () => ({
    stateDir: '/tmp/yoke-state',
    commandPrefix: 'node yoke',
    didSync: true,
  })),
  runAgentWorkspaceYokeCommand: runAgentWorkspaceYokeCommandMock,
}));

const { createDispatchTaskStateUpdater } = await import('./flightdeck-publisher');

describe('dispatch pipeline Flight Deck publisher', () => {
  beforeEach(() => {
    yokeCommandCalls.length = 0;
    runAgentWorkspaceYokeCommandMock.mockClear();
  });

  test('review handoff comments with the report document and notifies the source chat', async () => {
    const updateTask = createDispatchTaskStateUpdater({
      eventInput: {
        subscription: {
          subscriptionId: 'sub-1',
          workspaceOwnerNpub: 'npub1workspace',
          sourceAppNpub: 'npub1source',
          backendBaseUrl: 'https://tower.example.com',
          botNpub: 'npub1bot',
          wsKeyNpub: 'npub1wskey',
        },
        triggerKind: 'chat',
        capability: 'chat_intercept',
        recordId: 'chat-message-1',
        record: {},
        payload: {},
        recordFamily: 'chat',
        recordState: null,
        recordVersion: 1,
        updaterNpub: 'npub1requester',
        bindingType: 'thread',
        bindingId: 'thread-1',
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
      agent: {
        agentId: 'agent-1',
        workingDirectory: '/tmp/agent-work',
      },
      botIdentity: {
        botNpub: 'npub1bot',
        botPubkeyHex: 'ab'.repeat(32),
        botSecret: new Uint8Array(32),
      },
      runtime: {
        yokeStateDir: '/tmp/yoke-state',
        commandPrefix: 'node yoke',
        commands: {},
        error: null,
      },
    } as never, 'review');

    const result = await updateTask({
      workPlan: {
        taskId: 'task-1',
        reviewerNpub: 'npub1requester',
      },
      workerResult: {
        reportTitle: 'Report: The Running Centre, Perth',
        reportSummary: 'The report is complete.',
        documentId: 'doc-1',
        taskUpdateComment: 'Report complete. Created Flight Deck doc "Report: The Running Centre, Perth" (doc-1).',
      },
      agentResponse: {
        accepted: true,
        reviewSummary: 'Accepted.',
        requiredChanges: [],
        risks: [],
        confidence: 0.86,
      },
    });

    expect(result).toMatchObject({
      published: true,
      status: 'ok',
      operation: 'tasks.move-to-review',
      taskId: 'task-1',
      chatNotified: true,
      chatError: null,
    });

    const updateCall = yokeCommandCalls.find((args) => args[0] === 'tasks' && args[1] === 'update');
    expect(updateCall).toEqual(['tasks', 'update', 'task-1', '--state', 'review', '--assign', 'npub1requester', '--json']);

    const commentCall = yokeCommandCalls.find((args) => args[0] === 'tasks' && args[1] === 'comment');
    expect(commentCall?.[commentCall.indexOf('--body') + 1]).toContain(
      '@[Report: The Running Centre, Perth](mention:document:doc-1)',
    );

    const chatCall = yokeCommandCalls.find((args) => args[0] === 'chat' && args[1] === 'reply-current');
    expect(chatCall?.[chatCall.indexOf('--body') + 1]).toContain('Task: @[review task](mention:task:task-1)');
    expect(chatCall?.[chatCall.indexOf('--body') + 1]).toContain(
      '@[Report: The Running Centre, Perth](mention:document:doc-1)',
    );
    expect(chatCall).toContain('--skip-refresh');
    expect(chatCall).toContain('channel-1');
    expect(chatCall).toContain('thread-1');
  });
});
