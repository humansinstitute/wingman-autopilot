import { randomUUID } from 'node:crypto';

import type { DeclarativeFunction, DeclarativePipeline, DeclarativeStep } from '../../pipelines/declarative';
import type { JsonObject } from '../../pipelines/pipeline-store';
import type { AgentDefinitionRecord, RuntimeBotIdentity } from '../types';
import {
  buildAgentChatYokeCommands,
  buildAgentDocumentCommentYokeCommands,
  buildAgentTaskCommentYokeCommands,
  prepareAgentWorkspaceYokeRuntime,
  runAgentWorkspaceYokeCommand,
} from '../yoke-runtime';
import type { DispatchPipelineEventInput } from './runtime';

export interface DispatchPipelineFlightDeckRuntime {
  yokeStateDir: string | null;
  commandPrefix: string | null;
  commands: Record<string, string>;
  error: string | null;
}

interface DispatchPipelineFlightDeckPublisherContext {
  eventInput: DispatchPipelineEventInput;
  agent: AgentDefinitionRecord | null;
  botIdentity: RuntimeBotIdentity | null;
  runtime: DispatchPipelineFlightDeckRuntime;
}

const KNOWN_TASK_STATES = new Set([
  'new',
  'ready',
  'in_progress',
  'review',
  'done',
  'blocked',
  'cancelled',
]);

export function pipelineNeedsFlightDeckPublisher(pipeline: DeclarativePipeline): boolean {
  return pipeline.steps.some(stepNeedsFlightDeckPublisher);
}

export async function prepareDispatchPipelineFlightDeckRuntime(input: {
  eventInput: DispatchPipelineEventInput;
  agent: AgentDefinitionRecord | null;
}): Promise<DispatchPipelineFlightDeckRuntime> {
  const botIdentity = input.eventInput.botIdentity ?? null;
  const workingDirectory = input.agent?.workingDirectory ?? null;
  if (!botIdentity || !workingDirectory) {
    return {
      yokeStateDir: null,
      commandPrefix: null,
      commands: {},
      error: !botIdentity ? 'No runtime bot identity was available.' : 'No agent working directory was available.',
    };
  }

  try {
    const workspace = await prepareAgentWorkspaceYokeRuntime({
      sessionId: `dispatch-pipeline-${safeSessionId(input.eventInput.subscription.subscriptionId)}`,
      workingDirectory,
      subscription: input.eventInput.subscription,
      botIdentity,
    });
    return {
      yokeStateDir: workspace.stateDir,
      commandPrefix: workspace.commandPrefix,
      commands: buildRuntimeCommands(input.eventInput, workspace.stateDir, workspace.commandPrefix),
      error: null,
    };
  } catch (error) {
    return {
      yokeStateDir: null,
      commandPrefix: null,
      commands: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createDispatchFlightDeckPublisher(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!context.botIdentity || !context.agent?.workingDirectory || !context.runtime.yokeStateDir) {
      return {
        published: false,
        status: 'failed',
        operation: 'flightdeck_publish',
        reason: context.runtime.error ?? 'Flight Deck runtime was not prepared.',
      };
    }

    try {
      const triggerKind = context.eventInput.triggerKind;
      if (triggerKind === 'chat') {
        return await publishChatReply(context, input);
      }
      if (triggerKind === 'task') {
        return await publishTaskUpdate(context, input, 'task_dispatch');
      }
      if (triggerKind === 'task_review') {
        return await publishTaskUpdate(context, input, 'task_review');
      }
      if (triggerKind === 'comment') {
        return await publishCommentReply(context, input);
      }
      return {
        published: false,
        status: 'skipped',
        operation: 'flightdeck_publish',
        reason: `Unsupported dispatch trigger kind: ${triggerKind}`,
      };
    } catch (error) {
      return {
        published: false,
        status: 'failed',
        operation: 'flightdeck_publish',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

export function createDispatchChatContextHydrator(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!context.botIdentity || !context.agent?.workingDirectory || !context.runtime.yokeStateDir) {
      return {
        hydrated: false,
        status: 'failed',
        operation: 'chat.hydrate-context',
        reason: context.runtime.error ?? 'Flight Deck runtime was not prepared.',
      };
    }
    if (context.eventInput.triggerKind !== 'chat') {
      return {
        hydrated: false,
        status: 'skipped',
        operation: 'chat.hydrate-context',
        reason: `Unsupported dispatch trigger kind: ${context.eventInput.triggerKind}`,
      };
    }

    const channelId = context.eventInput.channelId ?? getText(context.eventInput.payload.channel_id);
    const threadId = context.eventInput.threadId ?? getText(context.eventInput.payload.thread_id);
    if (!channelId || !threadId) {
      throw new Error('Chat hydration requires channelId and threadId.');
    }

    const thread = await runYokeJson(context, [
      'chat',
      'context',
      '--channel',
      channelId,
      '--thread',
      threadId,
      '--limit',
      '20',
      '--format',
      'json',
    ]);
    const selfAuthored = detectSelfAuthoredChatDispatch(context, input, thread);
    let scopes: unknown = [];
    let referencedRecords: Array<Record<string, unknown>> = [];
    if (!selfAuthored.selfAuthored) {
      try {
        scopes = await runYokeJson(context, ['scopes', 'list', '--json']);
      } catch (error) {
        scopes = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
      referencedRecords = await loadMentionedFlightDeckRecords(context, thread);
    }

    return {
      hydrated: true,
      status: selfAuthored.selfAuthored ? 'skipped' : 'ok',
      operation: 'chat.hydrate-context',
      shouldProceed: !selfAuthored.selfAuthored,
      selfAuthored: selfAuthored.selfAuthored,
      suppressionReason: selfAuthored.reason,
      matchedSelfNpub: selfAuthored.matchedSelfNpub,
      channelId,
      threadId,
      thread,
      scopes,
      referencedRecords,
      availablePipelines: Array.isArray(input.availablePipelines) ? input.availablePipelines : [],
    };
  };
}

function detectSelfAuthoredChatDispatch(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
  thread: unknown,
): {
  selfAuthored: boolean;
  reason: string | null;
  matchedSelfNpub: string | null;
} {
  const selfNpubs = new Set(
    [
      context.eventInput.subscription.botNpub,
      context.eventInput.subscription.wsKeyNpub,
      context.agent?.botNpub,
      context.botIdentity?.botNpub,
    ].filter((value): value is string => Boolean(value)),
  );
  if (selfNpubs.size === 0) {
    return { selfAuthored: false, reason: null, matchedSelfNpub: null };
  }

  const inputRecord = objectValue(input.record);
  const inputPayload = objectValue(inputRecord.payload ?? context.eventInput.payload);
  const inputChat = objectValue(input.chat);
  const threadMessage = findThreadMessageById(thread, context.eventInput.recordId);
  const threadSender = getText(threadMessage?.sender_npub);
  const senderCandidates = [
    getText(context.eventInput.payload.sender_npub),
    getText(inputPayload.sender_npub),
    getText(inputChat.senderNpub),
    threadSender,
  ];
  const updaterCandidates = [
    context.eventInput.updaterNpub,
    getText(inputRecord.updaterNpub),
    getText(inputPayload.signature_npub),
    getText(inputPayload.owner_npub),
  ];
  const matchedSender = senderCandidates.find((value) => Boolean(value && selfNpubs.has(value))) ?? null;
  if (matchedSender) {
    return {
      selfAuthored: true,
      reason: threadSender === matchedSender ? 'trigger_thread_message_sender_is_self' : 'trigger_sender_is_self',
      matchedSelfNpub: matchedSender,
    };
  }
  const matchedUpdater = updaterCandidates.find((value) => Boolean(value && selfNpubs.has(value))) ?? null;
  if (matchedUpdater) {
    return {
      selfAuthored: true,
      reason: 'trigger_updater_is_self',
      matchedSelfNpub: matchedUpdater,
    };
  }
  return { selfAuthored: false, reason: null, matchedSelfNpub: null };
}

function findThreadMessageById(thread: unknown, messageId: string): Record<string, unknown> | null {
  const root = objectValue(thread);
  const nestedThread = objectValue(root.thread);
  const candidates = [
    root.recent_messages,
    root.messages,
    nestedThread.recent_messages,
    nestedThread.messages,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      const message = objectValue(entry);
      const id = getText(message.message_id) ?? getText(message.record_id);
      if (id === messageId) {
        return message;
      }
    }
  }
  return null;
}

export function createDispatchChatTaskCreator(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!context.botIdentity || !context.agent?.workingDirectory || !context.runtime.yokeStateDir) {
      throw new Error(context.runtime.error ?? 'Flight Deck runtime was not prepared.');
    }
    const decision = objectValue(input.decision ?? input.agentResponse ?? input);
    if (decision.dispatchTask !== true) {
      return {
        created: false,
        status: 'skipped',
        operation: 'tasks.create-from-chat',
        reason: 'Decision does not require task-backed work.',
      };
    }

    const taskDraft = objectValue(decision.taskDraft);
    const workPlan = objectValue(decision.workPlan);
    const title = getText(taskDraft.title) ?? getText(workPlan.taskSummary) ?? 'Chat-requested Wingman task';
    const description = buildChatCreatedTaskDescription(context, decision);
    const scopeId = getText(decision.scopeId ?? workPlan.scopeId);
    const assignedTo = context.eventInput.subscription.botNpub;
    const previousTaskIds = await listMatchingTaskIds(context, {
      title,
      state: 'in_progress',
      assignedTo,
    });
    const args = [
      'tasks',
      'create',
      '--title',
      title,
      '--description',
      description,
      '--state',
      'in_progress',
      '--assign',
      assignedTo,
    ];
    if (scopeId) {
      args.push('--scope', scopeId);
    }
    args.push('--json');
    const createResult = await runYokeJson(context, args);
    const taskId = getCreatedRecordId(createResult)
      ?? await findNewlyCreatedTaskId(context, {
        title,
        state: 'in_progress',
        assignedTo,
        previousTaskIds,
      });
    if (!taskId) {
      throw new Error('Task creation succeeded but no created task id was returned.');
    }
    const nextWorkPlan = {
      ...workPlan,
      taskId,
      scopeId,
      assignedToNpub: assignedTo,
      childPipelineDefinitionId: getText(workPlan.childPipelineDefinitionId ?? decision.pipelineDefinitionId),
      pipelineDefinitionId: getText(workPlan.pipelineDefinitionId ?? decision.pipelineDefinitionId),
    };
    return {
      created: true,
      status: 'ok',
      operation: 'tasks.create-from-chat',
      taskId,
      scopeId,
      assignedToNpub: assignedTo,
      pipelineDefinitionId: nextWorkPlan.pipelineDefinitionId,
      workPlan: nextWorkPlan,
      createResult,
    };
  };
}

export function createDispatchCreatedTaskBlocker(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!context.botIdentity || !context.agent?.workingDirectory || !context.runtime.yokeStateDir) {
      throw new Error(context.runtime.error ?? 'Flight Deck runtime was not prepared.');
    }
    const childPipeline = objectValue(input.childPipeline);
    if (childPipeline.started !== false && getText(childPipeline.status) !== 'failed') {
      return {
        updated: false,
        status: 'skipped',
        operation: 'tasks.block-on-pipeline-launch-failure',
      };
    }
    const taskId = resolveTaskId(context, input);
    if (!taskId) {
      throw new Error('Cannot block task after pipeline launch failure without a task id.');
    }
    const reason = getText(childPipeline.reason) ?? getText(childPipeline.error) ?? 'Selected pipeline failed to start.';
    const updateResult = await runYokeJson(context, [
      'tasks',
      'update',
      taskId,
      '--state',
      'blocked',
      '--json',
    ]);
    const commentResult = await runYokeJson(context, [
      'tasks',
      'comment',
      taskId,
      '--body',
      `Pipeline launch failed: ${reason}`,
      '--json',
    ]);
    return {
      updated: true,
      status: 'ok',
      operation: 'tasks.block-on-pipeline-launch-failure',
      taskId,
      updateResult,
      commentResult,
    };
  };
}

export function createDispatchImplementationReviewTaskEnsurer(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!context.botIdentity || !context.agent?.workingDirectory || !context.runtime.yokeStateDir) {
      throw new Error(context.runtime.error ?? 'Flight Deck runtime was not prepared.');
    }

    const existingTaskId = resolveTaskId(context, input);
    const workPlan = objectValue(input.workPlan ?? objectValue(input.createdTask).workPlan);
    const scopeId = getText(input.scopeId ?? workPlan.scopeId);
    const assignedTo = context.eventInput.subscription.botNpub;
    let taskId = existingTaskId;
    let createResult: unknown = null;

    await syncFlightDeckRuntime(context);

    if (!taskId) {
      const title = buildImplementationReviewTaskTitle(input, workPlan);
      const description = buildImplementationReviewTaskDescription(context, input, workPlan);
      const previousTaskIds = await listMatchingTaskIds(context, {
        title,
        state: 'in_progress',
        assignedTo,
      });
      const args = [
        'tasks',
        'create',
        '--title',
        title,
        '--description',
        description,
        '--state',
        'in_progress',
        '--assign',
        assignedTo,
      ];
      if (scopeId) {
        args.push('--scope', scopeId);
      }
      args.push('--json');
      createResult = await runYokeJson(context, args);
      taskId = getCreatedRecordId(createResult)
        ?? await findNewlyCreatedTaskId(context, {
          title,
          state: 'in_progress',
          assignedTo,
          previousTaskIds,
        });
      if (!taskId) {
        throw new Error('Implementation review task creation succeeded but no task id was returned.');
      }
    }

    let updateResult: unknown = null;
    let updateError: string | null = null;
    try {
      updateResult = await runYokeJson(context, [
        'tasks',
        'update',
        taskId,
        '--state',
        'in_progress',
        '--assign',
        assignedTo,
        '--json',
      ]);
    } catch (error) {
      updateError = error instanceof Error ? error.message : String(error);
    }

    let commentResult: unknown = null;
    let commentError: string | null = null;
    try {
      commentResult = await runYokeJson(context, [
        'tasks',
        'comment',
        taskId,
        '--body',
        buildImplementationReviewStartedComment(input, taskId),
        '--json',
      ]);
    } catch (error) {
      commentError = error instanceof Error ? error.message : String(error);
    }

    const nextWorkPlan = {
      ...workPlan,
      taskId,
      scopeId,
      taskSummary: getText(workPlan.taskSummary)
        ?? getText(input.taskTitle)
        ?? compactSingleLine(getText(input.implementationPrompt), 140)
        ?? 'Implementation review loop',
      instructions: getText(workPlan.instructions)
        ?? getText(input.implementationPrompt)
        ?? 'Run the implementation review loop.',
      workdir: getText(workPlan.workdir ?? workPlan.workingDirectory)
        ?? getText(input.workingDirectory)
        ?? context.agent.workingDirectory,
      designDocumentUrl: getText(workPlan.designDocumentUrl) ?? getText(input.designDocumentUrl),
      assignedToNpub: assignedTo,
      reviewerNpub: getText(workPlan.reviewerNpub) ?? resolveRequesterNpub(context, input),
      origin: {
        ...objectValue(workPlan.origin),
        channelId: getText(objectValue(workPlan.origin).channelId)
          ?? context.eventInput.channelId
          ?? getText(context.eventInput.payload.channel_id),
        threadId: getText(objectValue(workPlan.origin).threadId)
          ?? context.eventInput.threadId
          ?? getText(context.eventInput.payload.thread_id),
        messageId: getText(objectValue(workPlan.origin).messageId)
          ?? context.eventInput.recordId,
      },
    };

    return {
      published: true,
      status: updateError || commentError ? 'partial' : 'ok',
      operation: 'tasks.ensure-implementation-review-loop',
      taskId,
      created: !existingTaskId,
      state: 'in_progress',
      assignedToNpub: assignedTo,
      scopeId,
      createResult,
      updateResult,
      updateError,
      commentResult,
      commentError,
      workPlan: nextWorkPlan,
    };
  };
}

export function createDispatchImplementationReviewProgressCommenter(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!context.botIdentity || !context.agent?.workingDirectory || !context.runtime.yokeStateDir) {
      throw new Error(context.runtime.error ?? 'Flight Deck runtime was not prepared.');
    }
    const taskId = resolveTaskId(context, input);
    if (!taskId) {
      throw new Error('Implementation review progress comment requires a task id.');
    }
    const body = buildImplementationReviewProgressComment(input);
    const commentResult = await runYokeJson(context, [
      'tasks',
      'comment',
      taskId,
      '--body',
      body,
      '--json',
    ]);
    return {
      published: true,
      status: 'ok',
      operation: 'tasks.comment-implementation-review-progress',
      taskId,
      commentResult,
    };
  };
}

export function createDispatchTaskStateUpdater(
  context: DispatchPipelineFlightDeckPublisherContext,
  targetState: 'in_progress' | 'review',
): DeclarativeFunction {
  return async (input) => {
    if (!context.botIdentity || !context.agent?.workingDirectory || !context.runtime.yokeStateDir) {
      throw new Error(context.runtime.error ?? 'Flight Deck runtime was not prepared.');
    }
    const taskId = resolveTaskId(context, input);
    if (!taskId) {
      throw new Error('Task update requires a task record id.');
    }
    const reviewerNpub = targetState === 'review' ? resolveRequesterNpub(context, input) : null;
    const updateArgs = ['tasks', 'update', taskId, '--state', targetState];
    if (reviewerNpub) {
      updateArgs.push('--assign', reviewerNpub);
    }
    updateArgs.push('--json');

    await syncFlightDeckRuntime(context);
    let updateResult = await runYokeJson(context, updateArgs);
    let updateFallback: unknown = null;
    let updateStatus: 'ok' | 'fallback' | 'idempotent' = 'ok';
    if (syncResultRejected(updateResult)) {
      const currentTask = await loadFlightDeckTask(context, taskId);
      const currentState = getText(currentTask.state)?.toLowerCase() ?? null;
      if (currentState === targetState) {
        updateStatus = 'idempotent';
      } else if (targetState === 'review' && reviewerNpub) {
        updateFallback = await runYokeJson(context, ['tasks', 'update', taskId, '--state', targetState, '--json']);
        if (syncResultRejected(updateFallback)) {
          const fallbackTask = await loadFlightDeckTask(context, taskId);
          if ((getText(fallbackTask.state)?.toLowerCase() ?? null) !== targetState) {
            throw new Error(`Task ${taskId} update to ${targetState} was rejected: ${summariseSyncRejection(updateFallback)}`);
          }
          updateStatus = 'idempotent';
        } else {
          updateResult = updateFallback;
          updateStatus = 'fallback';
        }
      } else {
        throw new Error(`Task ${taskId} update to ${targetState} was rejected: ${summariseSyncRejection(updateResult)}`);
      }
    }

    const commentBody = targetState === 'review'
      ? buildReadyForReviewComment(input, reviewerNpub)
      : buildInProgressComment(input);
    let commentResult: unknown = null;
    let commentError: string | null = null;
    try {
      commentResult = await runYokeJson(context, [
        'tasks',
        'comment',
        taskId,
        '--body',
        commentBody,
        '--json',
      ]);
    } catch (error) {
      commentError = error instanceof Error ? error.message : String(error);
    }
    const chatNotification = targetState === 'review'
      ? await publishReadyForReviewChatNotification(context, input, taskId, reviewerNpub)
      : { notified: false, result: null, error: null, skippedReason: 'not_review_handoff' };

    return {
      published: true,
      status: commentError || chatNotification.error ? 'partial' : 'ok',
      operation: targetState === 'review' ? 'tasks.move-to-review' : 'tasks.move-to-in-progress',
      taskId,
      state: targetState,
      assignedToNpub: reviewerNpub,
      updateStatus,
      updateResult,
      updateFallback,
      commentResult,
      commentError,
      chatNotified: chatNotification.notified,
      chatResult: chatNotification.result,
      chatError: chatNotification.error,
      chatSkippedReason: chatNotification.skippedReason,
    };
  };
}

async function publishReadyForReviewChatNotification(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
  taskId: string,
  reviewerNpub: string | null,
): Promise<{
  notified: boolean;
  result: unknown;
  error: string | null;
  skippedReason: string | null;
}> {
  const workPlan = objectValue(input.workPlan);
  const origin = objectValue(workPlan.origin);
  const reportTarget = objectValue(input.reportTarget);
  const channelId = context.eventInput.channelId
    ?? getText(origin.channelId)
    ?? getText(reportTarget.flightDeckChannelId)
    ?? getText(reportTarget.channelId);
  const existingThreadId = context.eventInput.threadId
    ?? getText(origin.threadId)
    ?? getText(reportTarget.threadId);
  if (!channelId) {
    return {
      notified: false,
      result: null,
      error: null,
      skippedReason: 'missing_origin_chat_channel',
    };
  }
  const threadId = existingThreadId ?? randomUUID();

  try {
    const result = await runYokeJson(context, [
      'chat',
      'reply-current',
      '--body',
      buildReadyForReviewChatReply(input, taskId, reviewerNpub),
      '--skip-refresh',
      '--channel',
      channelId,
      '--thread',
      threadId,
      '--format',
      'json',
    ]);
    return {
      notified: true,
      result: {
        ...(objectValue(result)),
        createdNewThread: !existingThreadId,
      },
      error: null,
      skippedReason: null,
    };
  } catch (error) {
    return {
      notified: false,
      result: null,
      error: error instanceof Error ? error.message : String(error),
      skippedReason: null,
    };
  }
}

async function publishChatReply(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
): Promise<JsonObject> {
  const response = objectValue(input.agentResponse ?? input.response ?? input);
  if (response.shouldRespond === false) {
    return {
      published: false,
      status: 'skipped',
      operation: 'chat.reply-current',
      reason: getText(response.reasoningSummary) ?? 'Agent decided not to respond.',
      agentResponse: response,
    };
  }
  const body = getText(response.responseDraft)
    ?? getText(response.replyDraft)
    ?? getText(response.body);
  const channelId = context.eventInput.channelId ?? null;
  const threadId = context.eventInput.threadId ?? null;
  if (!body || !channelId || !threadId) {
    throw new Error('Chat publish requires responseDraft, channelId, and threadId.');
  }

  const result = await runYokeJson(context, [
    'chat',
    'reply-current',
    '--body',
    body,
    '--skip-refresh',
    '--channel',
    channelId,
    '--thread',
    threadId,
    '--format',
    'json',
  ]);
  return {
    published: true,
    status: 'ok',
    operation: 'chat.reply-current',
    channelId,
    threadId,
    result,
    agentResponse: response,
  };
}

async function publishTaskUpdate(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
  mode: 'task_dispatch' | 'task_review',
): Promise<JsonObject> {
  const response = objectValue(input.agentResponse ?? input.response ?? input);
  const taskId = getRecordId(context.eventInput);
  if (!taskId) {
    throw new Error('Task publish requires a task record id.');
  }
  const state = mode === 'task_review'
    ? normaliseReviewState(response)
    : normaliseTaskState(response);
  let updateResult: unknown = null;
  let updateError: string | null = null;
  try {
    updateResult = await runYokeJson(context, [
      'tasks',
      'update',
      taskId,
      '--state',
      state,
      '--json',
    ]);
  } catch (error) {
    updateError = error instanceof Error ? error.message : String(error);
  }
  const publishSummary = {
    ...response,
    childPipeline: objectValue(input.childPipeline ?? input.launchResult ?? response.childPipeline),
    updateError,
  };
  const commentBody = buildTaskCommentBody(mode, state, publishSummary);
  let commentResult: unknown = null;
  let commentError: string | null = null;
  try {
    commentResult = await runYokeJson(context, [
      'tasks',
      'comment',
      taskId,
      '--body',
      commentBody,
      '--json',
    ]);
  } catch (error) {
    commentError = error instanceof Error ? error.message : String(error);
  }
  const updateRejected = updateError !== null || syncResultRejected(updateResult);
  const commentRejected = commentError !== null || syncResultRejected(commentResult);

  return {
    published: !commentRejected,
    status: commentRejected ? 'failed' : updateRejected ? 'partial' : 'ok',
    operation: mode === 'task_review' ? 'tasks.update-review' : 'tasks.update',
    taskId,
    state,
    updateResult,
    updateError,
    commentResult,
    commentError,
    agentResponse: publishSummary,
  };
}

async function publishCommentReply(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
): Promise<JsonObject> {
  const response = objectValue(input.agentResponse ?? input.response ?? input);
  const body = getText(response.replyDraft)
    ?? getText(response.responseDraft)
    ?? getText(response.body)
    ?? getText(response.nextAction);
  const commentId = getText(context.eventInput.payload.commentId)
    ?? getText(context.eventInput.payload.comment_id)
    ?? context.eventInput.recordId;
  if (!body || !commentId) {
    throw new Error('Comment publish requires replyDraft and commentId.');
  }

  const family = getText(context.eventInput.payload.targetRecordFamilyHash)
    ?? getText(context.eventInput.payload.target_record_family_hash)
    ?? '';
  const target = context.eventInput.bindingType === 'task' || family.toLowerCase().includes('task')
    ? 'tasks'
    : 'docs';
  const result = await runYokeJson(context, [
    target,
    'reply',
    commentId,
    '--body',
    body,
    '--json',
  ]);

  return {
    published: true,
    status: 'ok',
    operation: `${target}.reply`,
    commentId,
    result,
    agentResponse: response,
  };
}

async function runYokeJson(
  context: DispatchPipelineFlightDeckPublisherContext,
  args: string[],
): Promise<unknown> {
  const stdout = await runAgentWorkspaceYokeCommand({
    args,
    workingDirectory: context.agent!.workingDirectory,
    stateDir: context.runtime.yokeStateDir!,
    botIdentity: context.botIdentity!,
  });
  if (!stdout) {
    return null;
  }
  try {
    return JSON.parse(stdout);
  } catch {
    return stdout;
  }
}

function stepNeedsFlightDeckPublisher(step: DeclarativeStep): boolean {
  if (
    step.type === 'code'
    && (
      step.function === 'dispatch.publishFlightDeckResponse'
      || step.function === 'dispatch.hydrateChatContext'
      || step.function === 'dispatch.createChatTask'
      || step.function === 'dispatch.blockTaskIfPipelineLaunchFailed'
      || step.function === 'dispatch.markTaskInProgress'
      || step.function === 'dispatch.markTaskReadyForReview'
      || step.function === 'dispatch.ensureImplementationReviewTask'
      || step.function === 'dispatch.commentImplementationReviewProgress'
    )
  ) {
    return true;
  }
  if (step.type === 'loop') {
    return (step.steps ?? []).some(stepNeedsFlightDeckPublisher);
  }
  if (step.type === 'parallel') {
    return stepNeedsFlightDeckPublisher(step.step);
  }
  return false;
}

function buildRuntimeCommands(
  eventInput: DispatchPipelineEventInput,
  stateDir: string,
  commandPrefix: string,
): Record<string, string> {
  const commands: Record<string, string> = {
    sync: `${commandPrefix} sync --json`,
  };
  if (eventInput.triggerKind === 'chat' && eventInput.channelId && eventInput.threadId) {
    return {
      ...commands,
      ...buildAgentChatYokeCommands(stateDir, eventInput.channelId, eventInput.threadId),
    };
  }
  if (eventInput.triggerKind === 'task' || eventInput.triggerKind === 'task_review') {
    const taskId = getRecordId(eventInput);
    if (taskId) {
      return {
        ...commands,
        show: `${commandPrefix} tasks show ${shellQuote(taskId)} --json`,
        update: `${commandPrefix} tasks update ${shellQuote(taskId)} --state ${shellQuote('<state>')} --json`,
        comment: `${commandPrefix} tasks comment ${shellQuote(taskId)} --body ${shellQuote('<comment>')} --json`,
      };
    }
  }
  if (eventInput.triggerKind === 'comment') {
    const commentId = getText(eventInput.payload.commentId) ?? getText(eventInput.payload.comment_id) ?? eventInput.recordId;
    const targetRecordId = getText(eventInput.payload.targetRecordId) ?? getText(eventInput.payload.target_record_id) ?? '';
    const family = getText(eventInput.payload.targetRecordFamilyHash)
      ?? getText(eventInput.payload.target_record_family_hash)
      ?? '';
    return {
      ...commands,
      ...(eventInput.bindingType === 'task' || family.toLowerCase().includes('task')
        ? buildAgentTaskCommentYokeCommands(stateDir, targetRecordId, commentId)
        : buildAgentDocumentCommentYokeCommands(stateDir, targetRecordId, commentId)),
    };
  }
  return commands;
}

function buildTaskCommentBody(
  mode: 'task_dispatch' | 'task_review',
  state: string,
  response: Record<string, unknown>,
): string {
  const lines = [`Wingman pipeline ${mode === 'task_review' ? 'review' : 'update'}: ${state}`];
  const summary = getText(response.taskSummary)
    ?? getText(response.reviewSummary)
    ?? getText(response.summary)
    ?? getText(response.replyDraft);
  if (summary) {
    lines.push(`Summary: ${summary}`);
  }
  const childPipeline = objectValue(response.childPipeline);
  const childRunId = getText(childPipeline.pipelineRunId);
  if (childRunId) {
    lines.push(`Started child pipeline: ${childRunId}`);
  }
  const requiredChanges = getStringArray(response.requiredChanges);
  if (requiredChanges.length > 0) {
    lines.push(`Required changes: ${requiredChanges.join('; ')}`);
  }
  const risks = getStringArray(response.risks);
  if (risks.length > 0) {
    lines.push(`Risks: ${risks.join('; ')}`);
  }
  const updateError = getText(response.updateError);
  if (updateError) {
    lines.push(`Update warning: ${updateError}`);
  }
  if (typeof response.confidence === 'number' && Number.isFinite(response.confidence)) {
    lines.push(`Confidence: ${Math.round(response.confidence * 100)}%`);
  }
  return lines.join('\n');
}

function normaliseTaskState(response: Record<string, unknown>): string {
  if (response.accepted === false) {
    return 'blocked';
  }
  const suggested = getText(response.suggestedStatus)?.toLowerCase().replace(/[\s-]+/g, '_');
  return suggested && KNOWN_TASK_STATES.has(suggested) ? suggested : 'in_progress';
}

function normaliseReviewState(response: Record<string, unknown>): string {
  const decision = getText(response.decision)?.toLowerCase().replace(/[\s-]+/g, '_');
  if (decision === 'accept' || decision === 'accepted' || decision === 'approve' || decision === 'approved') {
    return 'done';
  }
  if (decision === 'reject' || decision === 'rejected') {
    return 'blocked';
  }
  return 'in_progress';
}

function syncResultRejected(value: unknown): boolean {
  const result = objectValue(value);
  return Array.isArray(result.rejected) && result.rejected.length > 0;
}

function summariseSyncRejection(value: unknown): string {
  const result = objectValue(value);
  const rejected = Array.isArray(result.rejected) ? result.rejected : [];
  if (rejected.length === 0) {
    return 'unknown rejection';
  }
  return rejected
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }
      const record = objectValue(entry);
      return getText(record.reason)
        ?? getText(record.error)
        ?? getText(record.message)
        ?? JSON.stringify(record);
    })
    .join('; ');
}

async function syncFlightDeckRuntime(context: DispatchPipelineFlightDeckPublisherContext): Promise<void> {
  try {
    await runYokeJson(context, ['sync', '--json']);
  } catch {
    // The following task update still performs its own refresh through Yoke.
  }
}

async function loadFlightDeckTask(
  context: DispatchPipelineFlightDeckPublisherContext,
  taskId: string,
): Promise<Record<string, unknown>> {
  try {
    return objectValue(await runYokeJson(context, ['tasks', 'show', taskId, '--json']));
  } catch {
    return {};
  }
}

function resolveRequesterNpub(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
): string | null {
  const record = objectValue(input.record);
  const payload = objectValue(record.payload ?? context.eventInput.payload);
  const data = objectValue(payload.data);
  const workPlan = objectValue(input.workPlan);
  const createdTask = objectValue(input.createdTask);
  return firstExternalNpub([
    input.reviewerNpub,
    input.requesterNpub,
    workPlan.reviewerNpub,
    workPlan.assignerNpub,
    createdTask.reviewerNpub,
    createdTask.assignerNpub,
    record.updaterNpub,
    context.eventInput.updaterNpub,
    payload.signature_npub,
    data.signature_npub,
    data.created_by_npub,
    data.owner_npub,
    payload.owner_npub,
    context.eventInput.subscription.managedByNpub,
  ], [
    context.eventInput.subscription.botNpub,
    context.eventInput.subscription.wsKeyNpub,
  ]);
}

async function loadMentionedFlightDeckRecords(
  context: DispatchPipelineFlightDeckPublisherContext,
  thread: unknown,
): Promise<Array<Record<string, unknown>>> {
  const mentions = extractMentionRefs(thread).slice(0, 20);
  const records: Array<Record<string, unknown>> = [];
  for (const mention of mentions) {
    const command = commandForMention(mention);
    if (!command) continue;
    try {
      const record = await runYokeJson(context, command);
      records.push({
        type: mention.type,
        id: mention.id,
        status: 'ok',
        record,
      });
    } catch (error) {
      records.push({
        type: mention.type,
        id: mention.id,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return records;
}

function commandForMention(mention: { type: string; id: string }): string[] | null {
  const type = mention.type.toLowerCase();
  if (type === 'task') return ['tasks', 'show', mention.id, '--json'];
  if (type === 'doc' || type === 'document') return ['docs', 'show', mention.id, '--json'];
  if (type === 'flow') return ['flows', 'get', mention.id, '--json'];
  if (type === 'scope') return ['scopes', 'show', mention.id, '--json'];
  return null;
}

function extractMentionRefs(value: unknown): Array<{ type: string; id: string }> {
  const seen = new Set<string>();
  const refs: Array<{ type: string; id: string }> = [];
  const visit = (entry: unknown) => {
    if (typeof entry === 'string') {
      const re = /@\[.*?\]\(mention:(\w+):([^)]+)\)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(entry)) !== null) {
        const type = match[1]?.trim();
        const id = match[2]?.trim();
        if (!type || !id || type === 'person') continue;
        const key = `${type}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ type, id });
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (entry && typeof entry === 'object') {
      for (const item of Object.values(entry as Record<string, unknown>)) visit(item);
    }
  };
  visit(value);
  return refs;
}

function buildChatCreatedTaskDescription(
  context: DispatchPipelineFlightDeckPublisherContext,
  decision: Record<string, unknown>,
): string {
  const workPlan = objectValue(decision.workPlan);
  const taskDraft = objectValue(decision.taskDraft);
  const channelId = context.eventInput.channelId ?? getText(context.eventInput.payload.channel_id);
  const threadId = context.eventInput.threadId ?? getText(context.eventInput.payload.thread_id);
  const requestMessageId = context.eventInput.recordId;
  const lines = [
    getText(taskDraft.instructions) ?? getText(workPlan.instructions) ?? getText(workPlan.taskSummary) ?? 'Task created from chat dispatch.',
    '',
    'Dispatch context:',
    channelId ? `- Channel: ${mention('channel', channelId, 'Flight Deck chat')}` : '',
    threadId ? `- Thread: ${mention('message', threadId, 'thread root')}` : '',
    requestMessageId ? `- Request message: ${mention('message', requestMessageId, 'dispatch request')}` : '',
    getText(workPlan.pipelineDefinitionId ?? workPlan.childPipelineDefinitionId) ? `- Pipeline: ${getText(workPlan.pipelineDefinitionId ?? workPlan.childPipelineDefinitionId)}` : '',
    getText(workPlan.scopeId) ? `- Scope: ${mention('scope', getText(workPlan.scopeId)!, 'selected scope')}` : '',
    getText(workPlan.workdir) ? `- Workdir: ${getText(workPlan.workdir)}` : '',
    getText(workPlan.assignerNpub) ? `- Assigner: ${getText(workPlan.assignerNpub)}` : '',
    getText(workPlan.reviewerNpub) ? `- Reviewer: ${getText(workPlan.reviewerNpub)}` : '',
    '',
    ...formatList('Acceptance criteria', getStringArray(workPlan.acceptanceCriteria)),
    ...formatList('Execution plan', getStringArray(workPlan.executionPlan)),
    ...formatList('Manager checklist', getStringArray(workPlan.managerChecklist)),
  ].filter((line) => line !== '');
  return lines.join('\n');
}

function formatList(title: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return ['', `${title}:`, ...items.map((item) => `- ${item}`)];
}

function mention(type: string, id: string, label: string): string {
  return `@[${label}](mention:${type}:${id})`;
}

function getCreatedRecordId(value: unknown): string | null {
  const result = objectValue(value);
  const direct = getText(result.record_id)
    ?? getText(result.task_id)
    ?? getText(result.recordId)
    ?? getText(result.taskId);
  if (direct) return direct;

  const createdRecordIds = getStringArray(result.created_record_ids ?? result.createdRecordIds);
  if (createdRecordIds.length > 0) return createdRecordIds[0]!;

  const accepted = Array.isArray(result.accepted) ? result.accepted : [];
  for (const record of accepted) {
    const id = getText(objectValue(record).record_id) ?? getText(objectValue(record).recordId);
    if (id) return id;
  }

  const records = Array.isArray(result.records) ? result.records : [];
  for (const record of records) {
    const id = getText(objectValue(record).record_id);
    if (id) return id;
  }
  return null;
}

async function listMatchingTaskIds(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: {
    title: string;
    state: string;
    assignedTo: string;
  },
): Promise<Set<string>> {
  const rows = await listTasks(context);
  return new Set(rows
    .filter((row) => taskMatchesCreatedChatTask(row, input))
    .map((row) => getText(row.record_id))
    .filter((id): id is string => Boolean(id)));
}

async function findNewlyCreatedTaskId(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: {
    title: string;
    state: string;
    assignedTo: string;
    previousTaskIds: Set<string>;
  },
): Promise<string | null> {
  const rows = await listTasks(context);
  const candidates = rows
    .filter((row) => taskMatchesCreatedChatTask(row, input))
    .filter((row) => {
      const id = getText(row.record_id);
      return id && !input.previousTaskIds.has(id);
    })
    .sort((left, right) => parseTime(right.updated_at) - parseTime(left.updated_at));
  return getText(candidates[0]?.record_id);
}

async function listTasks(
  context: DispatchPipelineFlightDeckPublisherContext,
): Promise<Array<Record<string, unknown>>> {
  const result = await runYokeJson(context, ['tasks', 'list', '--json']);
  return Array.isArray(result)
    ? result.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    : [];
}

function taskMatchesCreatedChatTask(
  row: Record<string, unknown>,
  input: {
    title: string;
    state: string;
    assignedTo: string;
  },
): boolean {
  return getText(row.title) === input.title
    && getText(row.state) === input.state
    && getText(row.assigned_to_npub) === input.assignedTo;
}

function parseTime(value: unknown): number {
  const timestamp = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function resolveTaskId(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
): string | null {
  const workPlan = objectValue(input.workPlan);
  const createdTask = objectValue(input.createdTask);
  const record = objectValue(input.record);
  const payload = objectValue(record.payload ?? context.eventInput.payload);
  return getText(input.taskId)
    ?? getText(workPlan.taskId)
    ?? getText(createdTask.taskId)
    ?? getText(payload.taskId)
    ?? getText(payload.task_id)
    ?? getText(payload.record_id)
    ?? (context.eventInput.triggerKind === 'task' || context.eventInput.triggerKind === 'task_review'
      ? getRecordId(context.eventInput)
      : null);
}

function firstExternalNpub(values: unknown[], excludedNpubs: Array<string | null | undefined>): string | null {
  const excluded = new Set(excludedNpubs.filter((value): value is string => typeof value === 'string' && value.length > 0));
  for (const value of values) {
    const npub = getText(value);
    if (npub && !excluded.has(npub)) {
      return npub;
    }
  }
  return null;
}

function buildInProgressComment(input: JsonObject): string {
  const workPlan = objectValue(input.workPlan ?? input.agentResponse ?? input);
  const summary = getText(workPlan.taskSummary) ?? getText(workPlan.summary) ?? 'Task accepted for pipeline dispatch.';
  const workStyle = getText(workPlan.workStyle);
  return [
    'Pipeline intake: moved task to in_progress before dispatch.',
    `Summary: ${summary}`,
    ...(workStyle ? [`Dispatch target: ${workStyle}`] : []),
  ].join('\n');
}

function buildImplementationReviewTaskTitle(
  input: JsonObject,
  workPlan: Record<string, unknown>,
): string {
  return getText(input.taskTitle)
    ?? getText(workPlan.taskSummary)
    ?? getText(workPlan.title)
    ?? compactSingleLine(getText(input.implementationPrompt), 90)
    ?? 'Implementation review loop';
}

function buildImplementationReviewTaskDescription(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
  workPlan: Record<string, unknown>,
): string {
  const lines = [
    getText(input.implementationPrompt)
      ?? getText(workPlan.instructions)
      ?? getText(workPlan.taskSummary)
      ?? 'Run the implementation review loop.',
    '',
    'Implementation review loop context:',
    getText(input.designDocumentUrl ?? workPlan.designDocumentUrl)
      ? `- Design: ${getText(input.designDocumentUrl ?? workPlan.designDocumentUrl)}`
      : '',
    getText(input.workingDirectory ?? workPlan.workdir ?? workPlan.workingDirectory)
      ? `- Working directory: ${getText(input.workingDirectory ?? workPlan.workdir ?? workPlan.workingDirectory)}`
      : '',
    context.eventInput.channelId ? `- Source channel: ${mention('channel', context.eventInput.channelId, 'Flight Deck chat')}` : '',
    context.eventInput.threadId ? `- Source thread: ${mention('message', context.eventInput.threadId, 'thread root')}` : '',
  ].filter((line) => line !== '');
  return lines.join('\n');
}

function buildImplementationReviewStartedComment(input: JsonObject, taskId: string): string {
  const workPlan = objectValue(input.workPlan ?? objectValue(input.createdTask).workPlan);
  const summary = getText(workPlan.taskSummary)
    ?? getText(input.implementationPrompt)
    ?? 'Implementation review loop started.';
  const lines = [
    'Pipeline intake: implementation review loop started.',
    `Task: ${mention('task', taskId, 'implementation task')}`,
    `Summary: ${summary}`,
  ];
  const maxIterations = Number(input.maxReviewIterations ?? workPlan.maxReviewIterations);
  if (Number.isFinite(maxIterations) && maxIterations > 0) {
    lines.push(`Review loop limit: ${Math.floor(maxIterations)} manager pass(es).`);
  }
  return lines.join('\n');
}

function buildImplementationReviewProgressComment(input: JsonObject): string {
  const loop = objectValue(input.reviewLoop);
  const managerReview = objectValue(input.managerReview);
  const iteration = Number(loop.iteration ?? loop.completed ?? 1);
  const done = managerReview.done === true;
  const summary = getText(managerReview.managerSummary)
    ?? getText(managerReview.reviewSummary)
    ?? (done ? 'Manager accepted the implementation.' : 'Manager requested follow-up work.');
  const lines = [
    `Manager review iteration ${Number.isFinite(iteration) ? iteration : 1}: ${done ? 'approved' : 'changes requested'}.`,
    `Summary: ${summary}`,
  ];
  const pickups = Array.isArray(managerReview.pickups) ? managerReview.pickups : [];
  if (pickups.length > 0) {
    lines.push('Pickups:');
    for (const pickup of pickups.slice(0, 5)) {
      const record = objectValue(pickup);
      const title = getText(record.title) ?? 'Untitled pickup';
      const action = getText(record.action);
      lines.push(`- ${title}${action ? `: ${action}` : ''}`);
    }
  }
  const risks = getStringArray(managerReview.risks);
  if (risks.length > 0) {
    lines.push(`Risks: ${risks.join('; ')}`);
  }
  const nextWorkerPrompt = getText(managerReview.nextWorkerPrompt);
  if (!done && nextWorkerPrompt) {
    lines.push(`Next worker prompt: ${compactSingleLine(nextWorkerPrompt, 500)}`);
  }
  return lines.join('\n');
}

function buildReadyForReviewComment(input: JsonObject, reviewerNpub: string | null): string {
  const response = objectValue(input.agentResponse ?? input.response ?? input);
  const workerResult = objectValue(input.workerResult);
  const summary = getText(response.reviewSummary)
    ?? getText(response.summary)
    ?? getText(workerResult.reportSummary)
    ?? getText(workerResult.summary)
    ?? getText(workerResult.result)
    ?? 'Pipeline work is ready for review.';
  const taskUpdateComment = getText(workerResult.taskUpdateComment);
  const lines = [
    reviewerNpub
      ? `Pipeline handoff: moved task to review and assigned it to ${reviewerNpub}.`
      : 'Pipeline handoff: moved task to review.',
    `Summary: ${summary}`,
  ];
  if (taskUpdateComment && taskUpdateComment !== summary) {
    lines.push(taskUpdateComment);
  }
  lines.push(...buildReviewDocumentLines(input));
  const requiredChanges = getStringArray(response.requiredChanges);
  if (requiredChanges.length > 0) {
    lines.push(`Required changes: ${requiredChanges.join('; ')}`);
  }
  const risks = getStringArray(response.risks);
  if (risks.length > 0) {
    lines.push(`Risks: ${risks.join('; ')}`);
  }
  if (typeof response.confidence === 'number' && Number.isFinite(response.confidence)) {
    lines.push(`Confidence: ${Math.round(response.confidence * 100)}%`);
  }
  return lines.join('\n');
}

function buildReadyForReviewChatReply(
  input: JsonObject,
  taskId: string,
  reviewerNpub: string | null,
): string {
  const response = objectValue(input.agentResponse ?? input.response ?? input);
  const workerResult = objectValue(input.workerResult);
  const summary = getText(workerResult.reportSummary)
    ?? getText(response.reviewSummary)
    ?? getText(response.summary)
    ?? 'The pipeline work is ready for review.';
  const lines = [
    'Done: the pipeline work is ready for review.',
    `Task: ${mention('task', taskId, 'review task')}`,
    ...buildReviewDocumentLines(input),
    `Summary: ${summary}`,
  ];
  const taskUpdateComment = getText(workerResult.taskUpdateComment);
  if (taskUpdateComment && taskUpdateComment !== summary) {
    lines.push(taskUpdateComment);
  }
  if (reviewerNpub) {
    lines.push(`Assigned back to: ${reviewerNpub}`);
  }
  return lines.join('\n');
}

function buildReviewDocumentLines(input: JsonObject): string[] {
  const workerResult = objectValue(input.workerResult);
  const documentId = getText(workerResult.documentId)
    ?? getText(workerResult.document_id)
    ?? getText(workerResult.reportDocumentId)
    ?? getText(workerResult.report_document_id);
  if (!documentId) {
    return [];
  }
  const title = getText(workerResult.reportTitle)
    ?? getText(workerResult.documentTitle)
    ?? 'report document';
  return [`Document: ${mention('document', documentId, title)}`];
}

function getRecordId(eventInput: DispatchPipelineEventInput): string | null {
  return getText(eventInput.payload.taskId)
    ?? getText(eventInput.payload.task_id)
    ?? getText(eventInput.payload.record_id)
    ?? eventInput.recordId
    ?? null;
}

function getText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean)
    : [];
}

function compactSingleLine(value: string | null, maxLength: number): string | null {
  if (!value) {
    return null;
  }
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (!compacted) {
    return null;
  }
  return compacted.length > maxLength ? `${compacted.slice(0, Math.max(0, maxLength - 3))}...` : compacted;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeSessionId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-');
}
