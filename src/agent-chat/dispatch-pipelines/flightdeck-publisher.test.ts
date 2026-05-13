import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { beforeEach, describe, expect, mock, test } from 'bun:test';

const yokeCommandCalls: string[][] = [];

const runAgentWorkspaceYokeCommandMock = mock(async (input: { args: string[] }) => {
  yokeCommandCalls.push(input.args);
  if (input.args[0] === 'tasks' && input.args[1] === 'create') {
    return JSON.stringify({
      record_id: 'task-created-1',
      synced: 1,
      created: 1,
      rejected: [],
      warnings: [],
    });
  }
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

const {
  createDispatchImplementationReviewProgressCommenter,
  createDispatchImplementationReviewTaskEnsurer,
  createDispatchTaskStateUpdater,
} = await import('./flightdeck-publisher');
const { DispatchPipelineRuntime } = await import('./runtime');
const { PipelineStore } = await import('../../pipelines/pipeline-store');

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

  test('implementation review loop creates a task, comments manager progress, and closes out to chat', async () => {
    const context = {
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
        payload: { channel_id: 'channel-1' },
        recordFamily: 'chat',
        recordState: null,
        recordVersion: 1,
        updaterNpub: 'npub1requester',
        bindingType: 'thread',
        bindingId: null,
        channelId: 'channel-1',
        threadId: null,
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
    } as never;
    const ensureTask = createDispatchImplementationReviewTaskEnsurer(context);
    const commentProgress = createDispatchImplementationReviewProgressCommenter(context);
    const closeTask = createDispatchTaskStateUpdater(context, 'review');

    const createdTask = await ensureTask({
      implementationPrompt: 'Implement the editor design.',
      workingDirectory: '/repo/app',
      workPlan: {
        taskSummary: 'Implement editor design',
        reviewerNpub: 'npub1requester',
        origin: {
          channelId: 'channel-1',
        },
      },
      maxReviewIterations: 3,
    });
    await commentProgress({
      createdTask,
      workPlan: (createdTask as any).workPlan,
      reviewLoop: { iteration: 1 },
      managerReview: {
        done: false,
        managerSummary: 'The first pass needs one follow-up.',
        pickups: [
          { title: 'Add regression test', action: 'Cover the closeout path.' },
        ],
      },
    });
    const closeout = await closeTask({
      createdTask,
      workPlan: (createdTask as any).workPlan,
      workerResult: {
        summary: 'Implementation loop finished after manager review.',
        taskUpdateComment: 'Final report: implementation reviewed and ready.',
      },
      agentResponse: {
        accepted: true,
        reviewSummary: 'Manager accepted the final implementation.',
        requiredChanges: [],
        risks: [],
      },
      reportTarget: {
        flightDeckChannelId: 'channel-1',
      },
    });

    expect(createdTask).toMatchObject({
      published: true,
      operation: 'tasks.ensure-implementation-review-loop',
      taskId: 'task-created-1',
      created: true,
      state: 'in_progress',
    });
    expect(closeout).toMatchObject({
      published: true,
      operation: 'tasks.move-to-review',
      taskId: 'task-created-1',
      chatNotified: true,
    });

    const createCall = yokeCommandCalls.find((args) => args[0] === 'tasks' && args[1] === 'create');
    expect(createCall).toContain('--state');
    expect(createCall).toContain('in_progress');

    const progressComment = yokeCommandCalls
      .filter((args) => args[0] === 'tasks' && args[1] === 'comment')
      .find((args) => args[args.indexOf('--body') + 1]?.includes('Manager review iteration 1'));
    expect(progressComment?.[progressComment.indexOf('--body') + 1]).toContain('Add regression test');

    const chatCall = yokeCommandCalls.find((args) => args[0] === 'chat' && args[1] === 'reply-current');
    expect(chatCall?.[chatCall.indexOf('--body') + 1]).toContain('Task: @[review task](mention:task:task-created-1)');
    expect(chatCall).toContain('--thread');
    expect(chatCall?.[chatCall.indexOf('--thread') + 1]).toBeTruthy();
  });

  test('stored dispatch child runs resume with Flight Deck publishing functions', async () => {
    const pipelineStore = new PipelineStore(join(tmpdir(), `pipeline-resume-${randomUUID()}.sqlite`));
    const runtime = new DispatchPipelineRuntime({
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      getBotIdentityForSubscription: () => ({
        botNpub: 'npub1bot',
        botPubkeyHex: 'ab'.repeat(32),
        botSecret: new Uint8Array(32),
      }),
      callbackOrigin: 'http://localhost',
      loadFunctions: async () => ({ records: [], registry: {} }),
    });

    const registry = await runtime.loadRegistryForStoredRun({
      sessionApiContext: {} as never,
      definition: {
        id: 'research-and-report',
        slug: 'research-and-report',
        name: 'research-and-report',
        scope: 'shared',
        ownerAlias: null,
        path: '/tmp/research-and-report.json',
        spec: {
          name: 'research-and-report',
          input: {},
          steps: [
            {
              name: 'ensure-review-loop-task',
              type: 'code',
              function: 'dispatch.ensureImplementationReviewTask',
            },
            {
              name: 'move-task-to-review',
              type: 'code',
              function: 'dispatch.markTaskReadyForReview',
            },
          ],
        },
      },
      run: {
        id: 'run-1',
        definitionId: 'research-and-report',
        definitionPath: '/tmp/research-and-report.json',
        name: 'research-and-report',
        status: 'running',
        ownerNpub: 'npub1manager',
        ownerAlias: 'manager',
        scope: 'shared',
        input: {
          dispatch: {
            routeId: 'route-1',
            triggerKind: 'chat',
          },
          workspace: {
            subscriptionId: 'sub-1',
            workspaceOwnerNpub: 'npub1workspace',
            sourceAppNpub: 'npub1source',
            backendBaseUrl: 'https://tower.example.com',
          },
          agent: {
            agentId: 'agent-1',
            botNpub: 'npub1bot',
            workingDirectory: '/tmp/agent-work',
          },
          record: {
            recordId: 'message-1',
            recordFamily: 'chat',
            payload: {},
          },
          routing: {
            bindingType: 'thread',
            bindingId: 'thread-1',
            channelId: 'channel-1',
            threadId: 'thread-1',
          },
          runtime: {
            yokeStateDir: '/tmp/yoke-state',
            commandPrefix: 'node yoke',
            commands: {},
          },
        },
        current: {},
        cursorIndex: 0,
        activeStepId: null,
        result: null,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
      },
    });

    expect(registry?.['dispatch.markTaskReadyForReview']).toBeFunction();
    expect(registry?.['dispatch.ensureImplementationReviewTask']).toBeFunction();
    expect(registry?.['dispatch.commentImplementationReviewProgress']).toBeFunction();
    const result = await registry!['dispatch.markTaskReadyForReview']!({
      workPlan: {
        taskId: 'task-1',
        reviewerNpub: 'npub1requester',
      },
      workerResult: {
        reportTitle: 'Report',
        documentId: 'doc-1',
      },
    });

    expect(result).toMatchObject({
      published: true,
      operation: 'tasks.move-to-review',
      chatNotified: true,
    });
  });
});
