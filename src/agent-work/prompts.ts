import type { AgentDefinitionRecord, InboundApprovalRecord, InboundTaskRecord } from '../agent-chat/types';
import {
  DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE,
  renderPromptTemplate,
} from '../agent-chat/prompt-templates';

function compactText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function buildAgentWorkGoal(task: InboundTaskRecord): string {
  const title = compactText(task.title) || `Task ${task.taskId}`;
  const description = compactText(task.description);
  return description ? `${title}\n\n${description}` : title;
}

function buildScopeLineage(task: InboundTaskRecord): string {
  const values = [
    task.scopeL1Id,
    task.scopeL2Id,
    task.scopeL3Id,
    task.scopeL4Id,
    task.scopeL5Id,
  ].map((value) => compactText(value)).filter(Boolean);
  return values.length > 0 ? values.join(' > ') : '-';
}

export function buildTaskDispatchPrompt(params: {
  agent: AgentDefinitionRecord;
  task: InboundTaskRecord;
  dispatchReason: 'new task' | 'task updated';
}): string {
  const { task, dispatchReason, agent } = params;
  const flowId = compactText(task.flowId) || '-';
  const flowRunId = compactText(task.flowRunId) || '-';
  const flowStep = compactText(task.flowStep) || '-';
  const scopeId = compactText(task.scopeId) || '-';
  const scopeLineage = buildScopeLineage(task);
  const title = compactText(task.title) || `Task ${task.taskId}`;
  const description = compactText(task.description) || '(no description provided)';
  return renderPromptTemplate(agent.taskPromptTemplate || DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE, {
    dispatch_reason: dispatchReason,
    task_id: task.taskId,
    flow_id: flowId,
    flow_run_id: flowRunId,
    flow_step: flowStep,
    scope_id: scopeId,
    scope_lineage: scopeLineage,
    title,
    description,
  });
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
