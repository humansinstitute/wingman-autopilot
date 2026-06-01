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
      options: {
        syncMode: 'lazy',
        minSyncIntervalMs: 5 * 60 * 1000,
      },
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
  operation: 'chat.hydrate-context' | 'chat.reload-thread' = 'chat.hydrate-context',
): DeclarativeFunction {
  return async (input) => {
    if (!context.botIdentity || !context.agent?.workingDirectory || !context.runtime.yokeStateDir) {
      return {
        hydrated: false,
        status: 'failed',
        operation,
        reason: context.runtime.error ?? 'Flight Deck runtime was not prepared.',
      };
    }
    if (context.eventInput.triggerKind !== 'chat') {
      return {
        hydrated: false,
        status: 'skipped',
        operation,
        reason: `Unsupported dispatch trigger kind: ${context.eventInput.triggerKind}`,
      };
    }

    const channelId = context.eventInput.channelId ?? getText(context.eventInput.payload.channel_id);
    const threadId = context.eventInput.threadId ?? getText(context.eventInput.payload.thread_id);
    if (!channelId || !threadId) {
      throw new Error('Chat hydration requires channelId and threadId.');
    }

    const hydratedThread = await hydrateChatThreadWithFallback(context, channelId, threadId);
    const thread = hydratedThread.thread;
    const selfAuthored = detectSelfAuthoredChatDispatch(context, input, thread);
    const acknowledgement = !selfAuthored.selfAuthored && operation === 'chat.hydrate-context'
      ? await acknowledgeChatDispatchMessage(context, channelId)
      : {
          acknowledged: false,
          status: 'skipped',
          operation: 'chat.acknowledge-message',
          reason: selfAuthored.selfAuthored ? 'self_authored_dispatch' : 'not_initial_hydration',
        };
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
      hydrated: hydratedThread.hydrated,
      status: selfAuthored.selfAuthored ? 'skipped' : hydratedThread.status,
      operation,
      shouldProceed: !selfAuthored.selfAuthored,
      selfAuthored: selfAuthored.selfAuthored,
      suppressionReason: selfAuthored.reason,
      matchedSelfNpub: selfAuthored.matchedSelfNpub,
      channelId,
      threadId,
      thread,
      acknowledgement,
      hydrationWarnings: hydratedThread.warnings,
      fallbackContext: hydratedThread.fallbackContext,
      scopes,
      referencedRecords,
      availablePipelines: Array.isArray(input.availablePipelines) ? input.availablePipelines : [],
    };
  };
}

async function acknowledgeChatDispatchMessage(
  context: DispatchPipelineFlightDeckPublisherContext,
  channelId: string,
): Promise<JsonObject> {
  try {
    const result = await runYokeJson(context, [
      'chat',
      'react',
      '--channel',
      channelId,
      '--message',
      context.eventInput.recordId,
      '--emoji',
      'shaka',
      '--skip-refresh',
      '--format',
      'json',
    ]);
    return {
      acknowledged: true,
      status: 'ok',
      operation: 'chat.acknowledge-message',
      emoji: 'shaka',
      targetMessageId: context.eventInput.recordId,
      result,
    };
  } catch (error) {
    return {
      acknowledged: false,
      status: 'failed',
      operation: 'chat.acknowledge-message',
      emoji: 'shaka',
      targetMessageId: context.eventInput.recordId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createDispatchChatThreadReloader(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return createDispatchChatContextHydrator(context, 'chat.reload-thread');
}

export function createDispatchDiscussionDocumentEnsurer(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!context.botIdentity || !context.agent?.workingDirectory || !context.runtime.yokeStateDir) {
      return {
        ensured: false,
        status: 'failed',
        operation: 'docs.ensure-discussion-document',
        reason: context.runtime.error ?? 'Flight Deck runtime was not prepared.',
      };
    }
    const existing = findDiscussionDocumentReference(input);
    if (existing.documentId) {
      return {
        ensured: true,
        status: 'reused',
        operation: 'docs.ensure-discussion-document',
        documentId: existing.documentId,
        documentTitle: existing.documentTitle ?? 'Discussion document',
        documentUrl: existing.documentUrl,
        documentMention: mention('document', existing.documentId, existing.documentTitle ?? 'Discussion document'),
      };
    }

    const workPlan = objectValue(input.workPlan ?? objectValue(input.decision).discussionWorkPlan);
    const title = buildDiscussionDocumentTitle(input, workPlan);
    const body = buildDiscussionDocumentScaffold(input, workPlan, title);
    const scopeId = getText(workPlan.scopeId ?? objectValue(input.decision).scopeId);
    const args = [
      'docs',
      'create',
      '--title',
      title,
      '--body',
      body,
    ];
    if (scopeId) {
      args.push('--scope', scopeId);
    }
    args.push('--json');

    try {
      const result = await runYokeJson(context, args);
      const documentId = getCreatedRecordId(result);
      if (!documentId) {
        return {
          ensured: false,
          status: 'failed',
          operation: 'docs.ensure-discussion-document',
          reason: 'Document creation succeeded but no document id was returned.',
          createResult: result,
        };
      }
      return {
        ensured: true,
        status: 'created',
        operation: 'docs.ensure-discussion-document',
        documentId,
        documentTitle: title,
        documentUrl: null,
        documentMention: mention('document', documentId, title),
        createResult: result,
      };
    } catch (error) {
      return {
        ensured: false,
        status: 'failed',
        operation: 'docs.ensure-discussion-document',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

export function createDispatchReviewTaskCompleter(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!context.botIdentity || !context.agent?.workingDirectory || !context.runtime.yokeStateDir) {
      return {
        completed: false,
        status: 'failed',
        operation: 'tasks.complete-review-from-chat',
        reason: context.runtime.error ?? 'Flight Deck runtime was not prepared.',
      };
    }
    const reviewApproval = objectValue(input.reviewApproval);
    const taskId = getText(reviewApproval.taskId);
    if (!taskId) {
      return {
        completed: false,
        status: 'skipped',
        operation: 'tasks.complete-review-from-chat',
        reason: 'missing_task_id',
      };
    }
    try {
      const updateResult = await runYokeJson(context, [
        'tasks',
        'update',
        taskId,
        '--state',
        'done',
        '--json',
      ]);
      const taskTitle = getText(reviewApproval.taskTitle) ?? 'review task';
      const evidence = getText(reviewApproval.evidence);
      const commentBody = [
        `Marked "${taskTitle}" done from chat approval.`,
        evidence ? `Approval text: ${evidence}` : '',
      ].filter(Boolean).join('\n');
      const commentResult = await runYokeJson(context, [
        'tasks',
        'comment',
        taskId,
        '--body',
        commentBody,
        '--json',
      ]);
      return {
        completed: true,
        status: 'done',
        operation: 'tasks.complete-review-from-chat',
        taskId,
        taskTitle,
        updateResult,
        commentResult,
      };
    } catch (error) {
      return {
        completed: false,
        status: 'failed',
        operation: 'tasks.complete-review-from-chat',
        taskId,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

async function hydrateChatThreadWithFallback(
  context: DispatchPipelineFlightDeckPublisherContext,
  channelId: string,
  threadId: string,
): Promise<{
  hydrated: boolean;
  status: 'ok' | 'partial';
  thread: unknown;
  warnings: string[];
  fallbackContext: boolean;
}> {
  const args = [
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
  ];
  const warnings: string[] = [];

  try {
    return {
      hydrated: true,
      status: 'ok',
      thread: await runYokeJson(context, args),
      warnings,
      fallbackContext: false,
    };
  } catch (error) {
    warnings.push(`initial chat context failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await runYokeJson(context, ['sync', '--json']);
  } catch (error) {
    warnings.push(`sync before chat context retry failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return {
      hydrated: true,
      status: 'ok',
      thread: await runYokeJson(context, args),
      warnings,
      fallbackContext: false,
    };
  } catch (error) {
    warnings.push(`retry chat context failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    hydrated: true,
    status: 'partial',
    thread: buildFallbackChatThread(context, channelId, threadId),
    warnings,
    fallbackContext: true,
  };
}

function buildFallbackChatThread(
  context: DispatchPipelineFlightDeckPublisherContext,
  channelId: string,
  threadId: string,
): JsonObject {
  const payload = context.eventInput.payload;
  const messageId = context.eventInput.recordId;
  const parentMessageId = getText(payload.parent_message_id);
  const message = {
    message_id: messageId,
    record_id: messageId,
    parent_message_id: parentMessageId,
    sender_npub: getText(payload.sender_npub),
    body: getText(payload.body) ?? '',
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
    updated_at: getText(payload.updated_at),
    record_state: getText(payload.record_state),
    version: typeof payload.version === 'number' ? payload.version : null,
  };
  return {
    channel_id: channelId,
    thread_id: threadId,
    fallback_context: true,
    fallback_reason: 'local chat context was unavailable; using the dispatch record payload',
    recent_messages: [message],
    messages: [message],
    thread: {
      message_id: threadId,
      record_id: threadId,
      recent_messages: [message],
      messages: [message],
    },
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
    let createResult: unknown = null;
    let taskId: string | null = null;
    try {
      createResult = await runYokeJson(context, args);
      taskId = getCreatedRecordId(createResult)
        ?? await findNewlyCreatedTaskId(context, {
          title,
          state: 'in_progress',
          assignedTo,
          previousTaskIds,
        });
    } catch (error) {
      return {
        created: false,
        status: 'failed',
        operation: 'tasks.create-from-chat',
        reason: error instanceof Error ? error.message : String(error),
        scopeId,
        assignedToNpub: assignedTo,
        pipelineDefinitionId: null,
        workPlan: {
          ...workPlan,
          taskId: null,
          scopeId,
          assignedToNpub: assignedTo,
          childPipelineDefinitionId: null,
          pipelineDefinitionId: null,
        },
      };
    }
    if (!taskId) {
      return {
        created: false,
        status: 'failed',
        operation: 'tasks.create-from-chat',
        reason: 'Task creation succeeded but no created task id was returned.',
        scopeId,
        assignedToNpub: assignedTo,
        pipelineDefinitionId: null,
        createResult,
        workPlan: {
          ...workPlan,
          taskId: null,
          scopeId,
          assignedToNpub: assignedTo,
          childPipelineDefinitionId: null,
          pipelineDefinitionId: null,
        },
      };
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
      return {
        updated: false,
        status: 'skipped',
        operation: 'tasks.block-on-pipeline-launch-failure',
        reason: 'Cannot block task after pipeline launch failure without a task id.',
      };
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

export function createDispatchNeedsInputPublisher(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!context.botIdentity || !context.agent?.workingDirectory || !context.runtime.yokeStateDir) {
      return {
        published: false,
        status: 'failed',
        operation: 'tasks.needs-input',
        reason: context.runtime.error ?? 'Flight Deck runtime was not prepared.',
      };
    }

    const question = buildNeedsInputQuestion(input);
    const taskId = resolveTaskId(context, input);
    let commentResult: unknown = null;
    let commentError: string | null = null;
    if (taskId) {
      try {
        commentResult = await runYokeJson(context, [
          'tasks',
          'comment',
          taskId,
          '--body',
          buildNeedsInputTaskComment(input, question),
          '--json',
        ]);
      } catch (error) {
        commentError = error instanceof Error ? error.message : String(error);
      }
    }

    const chatNotification = await publishNeedsInputChatNotification(context, input, taskId, question);

    return {
      published: !commentError && (Boolean(commentResult) || chatNotification.notified),
      status: commentError || chatNotification.error ? 'partial' : 'ok',
      operation: 'tasks.needs-input',
      taskId,
      question,
      commentResult,
      commentError,
      chatNotified: chatNotification.notified,
      chatResult: chatNotification.result,
      chatError: chatNotification.error,
      chatSkippedReason: chatNotification.skippedReason,
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
  const normalizedBody = body ? normalisePublishedMarkdownBody(body) : null;
  const channelId = context.eventInput.channelId ?? null;
  const threadId = context.eventInput.threadId ?? null;
  if (!normalizedBody || !channelId || !threadId) {
    throw new Error('Chat publish requires responseDraft, channelId, and threadId.');
  }

  const result = await runYokeJson(context, [
    'chat',
    'reply-current',
    '--body',
    normalizedBody,
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
    agentResponse: {
      ...response,
      responseDraft: normalizedBody,
    },
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
      || step.function === 'dispatch.reloadChatThread'
      || step.function === 'dispatch.createChatTask'
      || step.function === 'dispatch.blockTaskIfPipelineLaunchFailed'
      || step.function === 'dispatch.publishNeedsInput'
      || step.function === 'dispatch.markTaskInProgress'
      || step.function === 'dispatch.markTaskReadyForReview'
      || step.function === 'dispatch.ensureImplementationReviewTask'
      || step.function === 'dispatch.commentImplementationReviewProgress'
      || step.function === 'dispatch.ensureDiscussionDocument'
      || step.function === 'dispatch.completeReviewTaskFromChat'
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
    ...formatOriginThreadContext(workPlan.originThread),
    ...formatReferencedRecordsContext(workPlan.referencedRecords),
    '',
    ...formatList('Acceptance criteria', getStringArray(workPlan.acceptanceCriteria)),
    ...formatList('Execution plan', getStringArray(workPlan.executionPlan)),
    ...formatList('Manager checklist', getStringArray(workPlan.managerChecklist)),
  ].filter((line) => line !== '');
  return lines.join('\n');
}

function normalisePublishedMarkdownBody(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        return normalisePublishedMarkdownBody(parsed);
      }
    } catch {
      // Fall through to escape normalization below.
    }
  }
  if (!value.includes('\n') && /\\[nr]/.test(value)) {
    return value
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\n');
  }
  return value;
}

function findDiscussionDocumentReference(input: JsonObject): {
  documentId: string | null;
  documentTitle: string | null;
  documentUrl: string | null;
} {
  const documentContext = objectValue(input.documentContext);
  const directId = getText(documentContext.documentId);
  if (directId) {
    return {
      documentId: directId,
      documentTitle: getText(documentContext.documentTitle),
      documentUrl: getText(documentContext.documentUrl),
    };
  }

  const contexts = [
    objectValue(input.chatContext),
    objectValue(input.originalChatContext),
    objectValue(input.freshChatContext),
  ];
  for (const context of contexts) {
    const referencedRecords = Array.isArray(context.referencedRecords) ? context.referencedRecords : [];
    for (const entry of referencedRecords) {
      const record = objectValue(entry);
      const nested = objectValue(record.record);
      const candidate = Object.keys(nested).length > 0 ? nested : record;
      const type = getText(record.type ?? candidate.type ?? candidate.recordFamily ?? candidate.record_family)?.toLowerCase();
      const id = getText(record.id ?? record.recordId ?? record.record_id ?? candidate.recordId ?? candidate.record_id);
      if (id && (type === 'doc' || type === 'document' || type === 'documents')) {
        return {
          documentId: id,
          documentTitle: getText(candidate.title ?? objectValue(candidate.payload).title),
          documentUrl: getText(candidate.url ?? objectValue(candidate.payload).url),
        };
      }
    }
  }

  const mention = extractMentionRefs([
    input.chatDispatchInput,
    input.chatContext,
    input.originalChatContext,
    input.freshChatContext,
    input.workPlan,
  ]).find((ref) => ref.type.toLowerCase() === 'doc' || ref.type.toLowerCase() === 'document');
  return {
    documentId: mention?.id ?? null,
    documentTitle: null,
    documentUrl: null,
  };
}

function buildDiscussionDocumentTitle(input: JsonObject, workPlan: Record<string, unknown>): string {
  return compactSingleLine(
    getText(workPlan.taskSummary)
      ?? getText(workPlan.title)
      ?? getText(objectValue(input.documentContext).discussionGoal)
      ?? getText(workPlan.originalPrompt),
    80,
  ) ?? 'Flight Deck discussion';
}

function buildDiscussionDocumentScaffold(input: JsonObject, workPlan: Record<string, unknown>, title: string): string {
  const originalPrompt = getText(workPlan.originalPrompt)
    ?? getText(objectValue(input.documentContext).discussionGoal)
    ?? 'Continue the document-centred discussion from the linked Flight Deck chat thread.';
  const origin = objectValue(workPlan.origin);
  const originThread = Array.isArray(workPlan.originThread)
    ? workPlan.originThread
    : Array.isArray(objectValue(input.chatDispatchInput).latestThread)
      ? objectValue(input.chatDispatchInput).latestThread as unknown[]
      : [];
  const lines = [
    `# ${title}`,
    '',
    '## Discussion Goal',
    originalPrompt,
    '',
    '## Working Notes',
    '- Capture decisions, constraints, open questions, and design changes here as the discussion evolves.',
    '',
    '## Source Thread',
    getText(origin.channelId) ? `- Channel: ${mention('channel', getText(origin.channelId)!, 'source chat')}` : '',
    getText(origin.threadId) ? `- Thread: ${mention('message', getText(origin.threadId)!, 'discussion thread')}` : '',
    getText(origin.messageId) ? `- Request: ${mention('message', getText(origin.messageId)!, 'latest request')}` : '',
    ...formatOriginThreadContext(originThread),
  ].filter((line) => line !== '');
  return lines.join('\n');
}

function formatOriginThreadContext(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }
  const lines = ['', 'Originating chat context:'];
  for (const entry of value.slice(-8)) {
    const message = objectValue(entry);
    const body = compactSingleLine(getText(message.body), 700);
    if (!body) continue;
    const sender = compactSingleLine(getText(message.senderNpub), 24) ?? 'unknown sender';
    const messageId = getText(message.messageId);
    lines.push(`- ${sender}${messageId ? ` (${messageId})` : ''}: ${body}`);
  }
  return lines.length > 2 ? lines : [];
}

function formatReferencedRecordsContext(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }
  const lines = ['', 'Referenced Flight Deck records:'];
  for (const entry of value.slice(0, 8)) {
    const record = objectValue(entry);
    const label = getText(record.title)
      ?? getText(record.recordId)
      ?? getText(record.id)
      ?? 'Untitled record';
    const family = getText(record.family) ?? 'record';
    const summary = compactSingleLine(getText(record.summary), 500);
    lines.push(`- ${family}: ${label}${summary ? ` - ${summary}` : ''}`);
  }
  return lines.length > 2 ? lines : [];
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

async function publishNeedsInputChatNotification(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
  taskId: string | null,
  question: string,
): Promise<{
  notified: boolean;
  result: unknown;
  error: string | null;
  skippedReason: string | null;
}> {
  const workPlan = objectValue(input.workPlan);
  const origin = objectValue(workPlan.origin);
  const channelId = context.eventInput.channelId
    ?? getText(origin.channelId)
    ?? getText(objectValue(input.routing).channelId);
  const threadId = context.eventInput.threadId
    ?? getText(origin.threadId)
    ?? getText(objectValue(input.routing).threadId);
  if (!channelId || !threadId) {
    return {
      notified: false,
      result: null,
      error: null,
      skippedReason: 'missing_origin_chat_thread',
    };
  }

  try {
    const result = await runYokeJson(context, [
      'chat',
      'reply-current',
      '--body',
      buildNeedsInputChatReply(input, taskId, question),
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
      result,
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

function buildNeedsInputTaskComment(input: JsonObject, question: string): string {
  const workerResult = extractNeedsInputPayload(input);
  const summary = getText(workerResult.summary) ?? 'The pipeline needs input before it can continue.';
  const lines = [
    'Pipeline needs input before it can continue.',
    `Summary: ${summary}`,
    `Question: ${question}`,
  ];
  const blockers = getStringArray(workerResult.blockers);
  if (blockers.length > 0) {
    lines.push(`Blockers: ${blockers.join('; ')}`);
  }
  return lines.join('\n');
}

function buildNeedsInputChatReply(input: JsonObject, taskId: string | null, question: string): string {
  const lines = [
    'I need more information before I can continue.',
    ...(taskId ? [`Task: ${mention('task', taskId, 'needs-input task')}`] : []),
    `Question: ${question}`,
  ];
  const blockers = getStringArray(extractNeedsInputPayload(input).blockers);
  if (blockers.length > 0) {
    lines.push(`Blockers: ${blockers.join('; ')}`);
  }
  return lines.join('\n');
}

function buildNeedsInputQuestion(input: JsonObject): string {
  const workerResult = extractNeedsInputPayload(input);
  const result = getText(workerResult.result);
  const resultQuestion = result?.replace(/^needs_input:\s*/i, '').trim();
  const blockers = getStringArray(workerResult.blockers);
  return getText(workerResult.taskUpdateComment)
    ?? getText(workerResult.clarifyingQuestion)
    ?? getText(workerResult.question)
    ?? (resultQuestion && resultQuestion.length > 0 ? resultQuestion : null)
    ?? (blockers.length > 0 ? `Please resolve: ${blockers.join('; ')}` : null)
    ?? 'What information should I use to continue this task?';
}

function extractNeedsInputPayload(input: JsonObject): Record<string, unknown> {
  for (const candidate of [input.workerResult, input.agentResponse, input.result]) {
    const value = objectValue(candidate);
    if (Object.keys(value).length > 0) {
      return value;
    }
  }
  return input;
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
