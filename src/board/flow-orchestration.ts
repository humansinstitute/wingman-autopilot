import { randomUUID } from 'node:crypto';

export interface BoardFlowStep {
  stepNumber: number;
  type: 'job_dispatch' | 'approval';
  title: string;
  instruction: string;
  approvalMode: 'manual' | 'agent';
  approverWhitelist: string[];
}

export interface BoardFlowRecord {
  flowId: string;
  title: string;
  description: string;
  steps: BoardFlowStep[];
}

export interface BoardTaskRecord {
  taskId: string;
  title: string;
  description: string;
  state: string | null;
  assignedTo: string | null;
  parentTaskId: string | null;
  flowId: string | null;
  flowRunId: string | null;
  flowStep: number | null;
  predecessorTaskIds: string[];
  scopeId: string | null;
  scopeLineage: Array<string | null>;
  tags: string[];
}

export interface BoardApprovalRecord {
  approvalId: string;
  title: string;
  flowId: string | null;
  flowRunId: string | null;
  flowStep: number | null;
  status: string | null;
  approvalMode: 'manual' | 'agent';
  taskIds: string[];
  brief: string;
  approverWhitelist: string[];
}

export interface BoardTaskCreateInput {
  title: string;
  description: string;
  state?: string | null;
  assignedTo?: string | null;
  parentTaskId?: string | null;
  predecessorTaskIds?: string[];
  flowId?: string | null;
  flowRunId?: string | null;
  flowStep?: number | null;
  scopeId?: string | null;
  tags?: string[];
}

export interface BoardApprovalCreateInput {
  title: string;
  flowId?: string | null;
  flowRunId?: string | null;
  flowStep?: number | null;
  taskIds?: string[];
  approvalMode?: 'manual' | 'agent';
  brief?: string;
  approverWhitelist?: string[];
}

export interface FlowBoard {
  getFlow(flowId: string): Promise<BoardFlowRecord>;
  getTask(taskId: string): Promise<BoardTaskRecord>;
  updateTask(taskId: string, patch: Partial<BoardTaskRecord> & {
    predecessorTaskIds?: string[];
    tags?: string[];
  }): Promise<BoardTaskRecord>;
  commentTask(taskId: string, body: string): Promise<void>;
  createTask(input: BoardTaskCreateInput): Promise<BoardTaskRecord>;
  createApproval(input: BoardApprovalCreateInput): Promise<BoardApprovalRecord>;
  getApproval?(approvalId: string): Promise<BoardApprovalRecord>;
  listFlowRunTasks(flowRunId: string): Promise<BoardTaskRecord[]>;
}

export interface FlowDispatchResult {
  status: 'created' | 'already_instantiated';
  flowRunId: string;
  parentTaskId: string;
  createdTaskIds: string[];
  createdApprovalIds: string[];
}

export interface FlowContinuationResult {
  promotedTaskIds: string[];
}

const SATISFIED_TASK_STATES = new Set([
  'review',
  'done',
  'completed',
  'cancelled',
  'canceled',
  'archived',
]);

function compactText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normaliseStepType(step: Record<string, unknown>): 'job_dispatch' | 'approval' {
  const explicit = compactText(step.type);
  if (explicit === 'approval') {
    return 'approval';
  }
  if (explicit === 'job_dispatch') {
    return 'job_dispatch';
  }
  const mode = compactText(step.approver_mode ?? step.approval_mode);
  if (mode === 'manual' || mode === 'agent') {
    return 'approval';
  }
  return 'job_dispatch';
}

function normaliseApprovalMode(step: Record<string, unknown>): 'manual' | 'agent' {
  return compactText(step.approver_mode ?? step.approval_mode) === 'agent' ? 'agent' : 'manual';
}

function normaliseApproverWhitelist(step: Record<string, unknown>): string[] {
  const whitelist = step.whitelist_approvers ?? step.approver_whitelist;
  if (!Array.isArray(whitelist)) {
    return [];
  }
  return whitelist
    .map((entry) => compactText(entry))
    .filter(Boolean);
}

export function normaliseFlowRecord(raw: Record<string, unknown>): BoardFlowRecord {
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  return {
    flowId: compactText(raw.record_id) || compactText(raw.flow_id),
    title: compactText(raw.title) || 'Flow',
    description: compactText(raw.description),
    steps: steps
      .map((step) => {
        const value = step && typeof step === 'object' ? step as Record<string, unknown> : {};
        const stepNumber = Number(value.step_number);
        return {
          stepNumber: Number.isFinite(stepNumber) ? stepNumber : 0,
          type: normaliseStepType(value),
          title: compactText(value.title) || `Step ${stepNumber}`,
          instruction: compactText(value.instruction ?? value.description ?? value.goals),
          approvalMode: normaliseApprovalMode(value),
          approverWhitelist: normaliseApproverWhitelist(value),
        };
      })
      .filter((step) => step.stepNumber > 0)
      .sort((left, right) => left.stepNumber - right.stepNumber),
  };
}

function normaliseTags(tags: string[] | null | undefined, additions: string[]): string[] {
  return Array.from(new Set([...(tags ?? []), ...additions].filter(Boolean))).sort();
}

function formatStepTitle(step: BoardFlowStep): string {
  return `${String(step.stepNumber).padStart(2, '0')} - ${step.title}`;
}

function enrichParentDescription(input: {
  kickoffTask: BoardTaskRecord;
  flow: BoardFlowRecord;
  flowRunId: string;
}): string {
  const existing = compactText(input.kickoffTask.description);
  const planLines = input.flow.steps.map((step) => `- ${formatStepTitle(step)} (${step.type})`);
  const sections = [
    existing,
    `Flow Dispatch parent task for "${input.flow.title}".`,
    `Flow run id: ${input.flowRunId}`,
    'Planned run graph:',
    ...planLines,
  ].filter(Boolean);
  return sections.join('\n\n');
}

function isTaskSatisfied(task: BoardTaskRecord | null | undefined): boolean {
  return Boolean(task?.state && SATISFIED_TASK_STATES.has(task.state));
}

function hasSatisfiedPredecessors(task: BoardTaskRecord, taskMap: Map<string, BoardTaskRecord>): boolean {
  return task.predecessorTaskIds.every((taskId) => isTaskSatisfied(taskMap.get(taskId)));
}

export async function instantiateFlowRun(board: FlowBoard, kickoffTaskId: string): Promise<FlowDispatchResult> {
  const kickoffTask = await board.getTask(kickoffTaskId);
  if (!kickoffTask.flowId) {
    throw new Error(`Kickoff task ${kickoffTaskId} is missing flowId.`);
  }

  const latestKickoff = await board.getTask(kickoffTaskId);
  if (latestKickoff.flowRunId) {
    return {
      status: 'already_instantiated',
      flowRunId: latestKickoff.flowRunId,
      parentTaskId: latestKickoff.taskId,
      createdTaskIds: [],
      createdApprovalIds: [],
    };
  }

  const flow = await board.getFlow(kickoffTask.flowId);
  if (flow.steps.length === 0) {
    throw new Error(`Flow ${flow.flowId} has no steps.`);
  }

  const flowRunId = randomUUID();
  const parentTask = await board.updateTask(kickoffTask.taskId, {
    state: 'in_progress',
    flowRunId,
    tags: normaliseTags(kickoffTask.tags, ['flow_parent']),
    description: enrichParentDescription({
      kickoffTask,
      flow,
      flowRunId,
    }),
  });

  const createdTaskIds: string[] = [];
  const createdApprovalIds: string[] = [];
  let predecessorTaskIds: string[] = [];

  for (const step of flow.steps) {
    if (step.type === 'approval') {
      const approvalTask = await board.createTask({
        title: formatStepTitle(step),
        description: step.instruction || 'Approval gate.',
        state: predecessorTaskIds.length === 0 ? 'ready' : 'new',
        assignedTo: null,
        parentTaskId: parentTask.taskId,
        predecessorTaskIds,
        flowId: flow.flowId,
        flowRunId,
        flowStep: step.stepNumber,
        scopeId: parentTask.scopeId,
        tags: ['flow_approval', 'flow_step'],
      });
      const approval = await board.createApproval({
        title: formatStepTitle(step),
        flowId: flow.flowId,
        flowRunId,
        flowStep: step.stepNumber,
        taskIds: [approvalTask.taskId],
        approvalMode: step.approvalMode,
        brief: step.instruction || step.title,
        approverWhitelist: step.approverWhitelist,
      });
      createdTaskIds.push(approvalTask.taskId);
      createdApprovalIds.push(approval.approvalId);
      predecessorTaskIds = [approvalTask.taskId];
      continue;
    }

    const childTask = await board.createTask({
      title: formatStepTitle(step),
      description: step.instruction,
      state: predecessorTaskIds.length === 0 ? 'ready' : 'new',
      assignedTo: parentTask.assignedTo,
      parentTaskId: parentTask.taskId,
      predecessorTaskIds,
      flowId: flow.flowId,
      flowRunId,
      flowStep: step.stepNumber,
      scopeId: parentTask.scopeId,
      tags: ['flow_step'],
    });
    createdTaskIds.push(childTask.taskId);
    predecessorTaskIds = [childTask.taskId];
  }

  await board.commentTask(
    parentTask.taskId,
    `Flow Dispatch instantiated run ${flowRunId} with ${createdTaskIds.length} child task(s) and ${createdApprovalIds.length} approval record(s).`,
  );

  return {
    status: 'created',
    flowRunId,
    parentTaskId: parentTask.taskId,
    createdTaskIds,
    createdApprovalIds,
  };
}

export async function continueFlowAfterTaskReview(
  board: FlowBoard,
  reviewedTaskId: string,
): Promise<FlowContinuationResult> {
  const reviewedTask = await board.getTask(reviewedTaskId);
  if (!reviewedTask.flowRunId) {
    throw new Error(`Task ${reviewedTaskId} is not part of a flow run.`);
  }
  const tasks = await board.listFlowRunTasks(reviewedTask.flowRunId);
  const taskMap = new Map(tasks.map((task) => [task.taskId, task]));
  const promotedTaskIds: string[] = [];

  for (const task of tasks) {
    if (task.state !== 'new') {
      continue;
    }
    if (!hasSatisfiedPredecessors(task, taskMap)) {
      continue;
    }
    const updated = await board.updateTask(task.taskId, { state: 'ready' });
    taskMap.set(updated.taskId, updated);
    promotedTaskIds.push(updated.taskId);
  }

  if (promotedTaskIds.length > 0) {
    await board.commentTask(
      reviewedTask.taskId,
      `Task Review promoted ${promotedTaskIds.length} downstream task(s) to ready: ${promotedTaskIds.join(', ')}.`,
    );
  }

  return { promotedTaskIds };
}

export async function continueFlowAfterApproval(
  board: FlowBoard,
  approval: BoardApprovalRecord,
): Promise<FlowContinuationResult> {
  if (!approval.flowRunId) {
    throw new Error(`Approval ${approval.approvalId} is not part of a flow run.`);
  }

  for (const taskId of approval.taskIds) {
    await board.updateTask(taskId, { state: 'done' });
  }

  const tasks = await board.listFlowRunTasks(approval.flowRunId);
  const taskMap = new Map(tasks.map((task) => [task.taskId, task]));
  const promotedTaskIds: string[] = [];

  for (const task of tasks) {
    if (task.state !== 'new') {
      continue;
    }
    if (!hasSatisfiedPredecessors(task, taskMap)) {
      continue;
    }
    const updated = await board.updateTask(task.taskId, { state: 'ready' });
    taskMap.set(updated.taskId, updated);
    promotedTaskIds.push(updated.taskId);
  }

  if (approval.taskIds[0]) {
    await board.commentTask(
      approval.taskIds[0],
      promotedTaskIds.length > 0
        ? `Approval Dispatch promoted ${promotedTaskIds.length} downstream task(s) to ready: ${promotedTaskIds.join(', ')}.`
        : 'Approval Dispatch found no newly-unblocked downstream tasks.',
    );
  }

  return { promotedTaskIds };
}
