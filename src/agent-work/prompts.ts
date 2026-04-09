import type { InboundApprovalRecord, InboundTaskRecord } from '../agent-chat/types';

function compactText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function buildAgentWorkGoal(task: InboundTaskRecord): string {
  const title = compactText(task.title) || `Task ${task.taskId}`;
  const description = compactText(task.description);
  return description ? `${title}\n\n${description}` : title;
}

export function buildTaskDispatchPrompt(params: {
  task: InboundTaskRecord;
  dispatchReason: 'new task' | 'task updated';
}): string {
  const { task, dispatchReason } = params;
  const flowId = compactText(task.flowId) || '-';
  const flowRunId = compactText(task.flowRunId) || '-';
  const flowStep = compactText(task.flowStep) || '-';
  const title = compactText(task.title) || `Task ${task.taskId}`;
  const description = compactText(task.description) || '(no description provided)';

  return [
    'Agent work dispatch.',
    `Dispatch reason: ${dispatchReason}.`,
    `Task id: ${task.taskId}`,
    `Flow id: ${flowId}`,
    `Flow run id: ${flowRunId}`,
    `Flow step: ${flowStep}`,
    `Title: ${title}`,
    `Description: ${description}`,
    'Instructions:',
    '- Complete only the current actionable task.',
    '- Inspect the board before acting so you use current state rather than transcript memory.',
    '- Update the board with progress or completion when you finish meaningful work.',
    '- Stop if blocked, if a predecessor is unresolved, or if you are awaiting approval.',
  ].join('\n');
}

export function buildApprovalDispatchPrompt(approval: InboundApprovalRecord): string {
  const flowId = compactText(approval.flowId) || '-';
  const flowRunId = compactText(approval.flowRunId) || '-';
  const flowStep = compactText(approval.flowStep) || '-';
  const approvalId = compactText(approval.approvalId) || '-';
  const state = compactText(approval.state) || '-';

  return [
    'Agent work approval advisory.',
    'Dispatch reason: approval updated.',
    `Approval id: ${approvalId}`,
    `Flow id: ${flowId}`,
    `Flow run id: ${flowRunId}`,
    `Flow step: ${flowStep}`,
    `Approval state: ${state}`,
    'Inspect the board and continue only if a new step is now actionable. Do not continue speculative work.',
  ].join('\n');
}
