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
  const updateResult = await runYokeJson(context, [
    'tasks',
    'update',
    taskId,
    '--state',
    state,
    '--json',
  ]);
  const commentBody = buildTaskCommentBody(mode, state, response);
  const commentResult = await runYokeJson(context, [
    'tasks',
    'comment',
    taskId,
    '--body',
    commentBody,
    '--json',
  ]);

  return {
    published: true,
    status: 'ok',
    operation: mode === 'task_review' ? 'tasks.update-review' : 'tasks.update',
    taskId,
    state,
    updateResult,
    commentResult,
    agentResponse: response,
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
  if (step.type === 'code' && step.function === 'dispatch.publishFlightDeckResponse') {
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
  const payload = mode === 'task_review'
    ? {
      type: 'wingman_task_review',
      status: state,
      decision: getText(response.decision) ?? 'changes_requested',
      summary: getText(response.reviewSummary) ?? getText(response.replyDraft) ?? '',
      evidenceChecked: getStringArray(response.evidenceChecked),
      requiredChanges: getStringArray(response.requiredChanges),
      confidence: typeof response.confidence === 'number' ? response.confidence : null,
    }
    : {
      type: 'wingman_task_update',
      status: state,
      accepted: response.accepted !== false,
      summary: getText(response.taskSummary) ?? '',
      firstAction: getText(response.firstAction) ?? '',
      executionPlan: getStringArray(response.executionPlan),
      risks: getStringArray(response.risks),
      confidence: typeof response.confidence === 'number' ? response.confidence : null,
    };
  return [
    `Wingman pipeline ${mode === 'task_review' ? 'review' : 'update'}: ${state}`,
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
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
