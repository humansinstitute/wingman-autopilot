import { describe, expect, test } from 'bun:test';

import {
  continueFlowAfterApproval,
  continueFlowAfterTaskReview,
  instantiateFlowRun,
  type BoardApprovalRecord,
  type BoardFlowRecord,
  type BoardTaskCreateInput,
  type BoardTaskRecord,
  type FlowBoard,
} from './flow-orchestration';

class FakeBoard implements FlowBoard {
  flows = new Map<string, BoardFlowRecord>();
  tasks = new Map<string, BoardTaskRecord>();
  approvals = new Map<string, BoardApprovalRecord>();
  comments: Array<{ taskId: string; body: string }> = [];
  private taskCounter = 1;
  private approvalCounter = 1;

  async getFlow(flowId: string): Promise<BoardFlowRecord> {
    const flow = this.flows.get(flowId);
    if (!flow) throw new Error(`Missing flow ${flowId}`);
    return flow;
  }

  async getTask(taskId: string): Promise<BoardTaskRecord> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Missing task ${taskId}`);
    return task;
  }

  async updateTask(taskId: string, patch: Partial<BoardTaskRecord> & { predecessorTaskIds?: string[]; tags?: string[] }): Promise<BoardTaskRecord> {
    const existing = await this.getTask(taskId);
    const next: BoardTaskRecord = {
      ...existing,
      ...patch,
      predecessorTaskIds: patch.predecessorTaskIds ?? existing.predecessorTaskIds,
      tags: patch.tags ?? existing.tags,
    };
    this.tasks.set(taskId, next);
    return next;
  }

  async commentTask(taskId: string, body: string): Promise<void> {
    this.comments.push({ taskId, body });
  }

  async createTask(input: BoardTaskCreateInput): Promise<BoardTaskRecord> {
    const task: BoardTaskRecord = {
      taskId: `task-${this.taskCounter++}`,
      title: input.title,
      description: input.description,
      state: input.state ?? 'new',
      assignedTo: input.assignedTo ?? null,
      parentTaskId: input.parentTaskId ?? null,
      flowId: input.flowId ?? null,
      flowRunId: input.flowRunId ?? null,
      flowStep: input.flowStep ?? null,
      predecessorTaskIds: input.predecessorTaskIds ?? [],
      scopeId: input.scopeId ?? null,
      scopeLineage: [input.scopeId ?? null, null, null, null, null],
      tags: input.tags ?? [],
    };
    this.tasks.set(task.taskId, task);
    return task;
  }

  async createApproval(input: {
    title: string;
    flowId?: string | null;
    flowRunId?: string | null;
    flowStep?: number | null;
    taskIds?: string[];
    approvalMode?: 'manual' | 'agent';
    brief?: string;
    approverWhitelist?: string[];
  }): Promise<BoardApprovalRecord> {
    const approval: BoardApprovalRecord = {
      approvalId: `approval-${this.approvalCounter++}`,
      title: input.title,
      flowId: input.flowId ?? null,
      flowRunId: input.flowRunId ?? null,
      flowStep: input.flowStep ?? null,
      status: 'pending',
      approvalMode: input.approvalMode ?? 'manual',
      taskIds: input.taskIds ?? [],
      brief: input.brief ?? '',
      approverWhitelist: input.approverWhitelist ?? [],
    };
    this.approvals.set(approval.approvalId, approval);
    return approval;
  }

  async listFlowRunTasks(flowRunId: string): Promise<BoardTaskRecord[]> {
    return Array.from(this.tasks.values()).filter((task) => task.flowRunId === flowRunId);
  }
}

function makeKickoffTask(): BoardTaskRecord {
  return {
    taskId: 'kickoff-1',
    title: 'Kickoff',
    description: 'Start the run',
    state: 'new',
    assignedTo: 'npub1bot',
    parentTaskId: null,
    flowId: 'flow-1',
    flowRunId: null,
    flowStep: null,
    predecessorTaskIds: [],
    scopeId: 'scope-1',
    scopeLineage: ['scope-1', null, null, null, null],
    tags: [],
  };
}

function makeLinearFlow(): BoardFlowRecord {
  return {
    flowId: 'flow-1',
    title: 'Linear Flow',
    description: 'A linear test flow',
    steps: [
      { stepNumber: 1, type: 'job_dispatch', title: 'Research', instruction: 'Do research', approvalMode: 'manual', approverWhitelist: [] },
      { stepNumber: 2, type: 'approval', title: 'Review', instruction: 'Approve the work', approvalMode: 'manual', approverWhitelist: ['npub1reviewer'] },
      { stepNumber: 3, type: 'job_dispatch', title: 'Publish', instruction: 'Ship it', approvalMode: 'manual', approverWhitelist: [] },
    ],
  };
}

describe('flow orchestration', () => {
  test('instantiates a kickoff task exactly once and stamps one flow run across children', async () => {
    const board = new FakeBoard();
    board.tasks.set('kickoff-1', makeKickoffTask());
    board.flows.set('flow-1', makeLinearFlow());

    const first = await instantiateFlowRun(board, 'kickoff-1');
    expect(first.status).toBe('created');
    expect(first.createdTaskIds).toHaveLength(3);
    expect(first.createdApprovalIds).toHaveLength(1);
    expect(board.tasks.get('kickoff-1')?.state).toBe('in_progress');
    expect(board.tasks.get('kickoff-1')?.flowRunId).toBe(first.flowRunId);

    const runTasks = await board.listFlowRunTasks(first.flowRunId);
    const childTasks = runTasks.filter((task) => task.taskId !== 'kickoff-1');
    const approvalTask = childTasks[1];
    const publishTask = childTasks[2];
    const approvalRecord = Array.from(board.approvals.values())[0];
    expect(runTasks.every((task) => task.flowRunId === first.flowRunId)).toBe(true);
    expect(childTasks.map((task) => task.state)).toEqual(['ready', 'new', 'new']);
    expect(approvalTask?.assignedTo).toBeNull();
    expect(publishTask?.predecessorTaskIds).toEqual(approvalTask ? [approvalTask.taskId] : undefined);
    expect(approvalRecord?.approverWhitelist).toEqual(['npub1reviewer']);

    const second = await instantiateFlowRun(board, 'kickoff-1');
    expect(second.status).toBe('already_instantiated');
    expect(
      (await board.listFlowRunTasks(first.flowRunId))
        .filter((task) => task.taskId !== 'kickoff-1')
        .map((task) => task.taskId),
    ).toEqual(childTasks.map((task) => task.taskId));
  });

  test('task review promotes fan-out successors and waits for fan-in completion', async () => {
    const board = new FakeBoard();
    board.tasks.set('task-a', {
      taskId: 'task-a',
      title: 'A',
      description: '',
      state: 'review',
      assignedTo: 'npub1bot',
      parentTaskId: 'kickoff-1',
      flowId: 'flow-1',
      flowRunId: 'run-1',
      flowStep: 1,
      predecessorTaskIds: [],
      scopeId: 'scope-1',
      scopeLineage: ['scope-1', null, null, null, null],
      tags: [],
    });
    board.tasks.set('task-b', {
      taskId: 'task-b',
      title: 'B',
      description: '',
      state: 'new',
      assignedTo: 'npub1bot',
      parentTaskId: 'kickoff-1',
      flowId: 'flow-1',
      flowRunId: 'run-1',
      flowStep: 2,
      predecessorTaskIds: ['task-a'],
      scopeId: 'scope-1',
      scopeLineage: ['scope-1', null, null, null, null],
      tags: [],
    });
    board.tasks.set('task-c', {
      taskId: 'task-c',
      title: 'C',
      description: '',
      state: 'new',
      assignedTo: 'npub1bot',
      parentTaskId: 'kickoff-1',
      flowId: 'flow-1',
      flowRunId: 'run-1',
      flowStep: 3,
      predecessorTaskIds: ['task-a'],
      scopeId: 'scope-1',
      scopeLineage: ['scope-1', null, null, null, null],
      tags: [],
    });
    board.tasks.set('task-d', {
      taskId: 'task-d',
      title: 'D',
      description: '',
      state: 'new',
      assignedTo: 'npub1bot',
      parentTaskId: 'kickoff-1',
      flowId: 'flow-1',
      flowRunId: 'run-1',
      flowStep: 4,
      predecessorTaskIds: ['task-b', 'task-c'],
      scopeId: 'scope-1',
      scopeLineage: ['scope-1', null, null, null, null],
      tags: [],
    });

    const afterA = await continueFlowAfterTaskReview(board, 'task-a');
    expect(afterA.promotedTaskIds.sort()).toEqual(['task-b', 'task-c']);
    expect(board.tasks.get('task-d')?.state).toBe('new');

    await board.updateTask('task-b', { state: 'review' });
    const afterB = await continueFlowAfterTaskReview(board, 'task-b');
    expect(afterB.promotedTaskIds).toEqual([]);

    await board.updateTask('task-c', { state: 'review' });
    const afterC = await continueFlowAfterTaskReview(board, 'task-c');
    expect(afterC.promotedTaskIds).toEqual(['task-d']);
  });

  test('approval dispatch marks approval task done and promotes downstream tasks', async () => {
    const board = new FakeBoard();
    board.tasks.set('approval-task-1', {
      taskId: 'approval-task-1',
      title: 'Review',
      description: '',
      state: 'ready',
      assignedTo: null,
      parentTaskId: 'kickoff-1',
      flowId: 'flow-1',
      flowRunId: 'run-1',
      flowStep: 2,
      predecessorTaskIds: ['task-a'],
      scopeId: 'scope-1',
      scopeLineage: ['scope-1', null, null, null, null],
      tags: ['flow_approval'],
    });
    board.tasks.set('task-next', {
      taskId: 'task-next',
      title: 'Next',
      description: '',
      state: 'new',
      assignedTo: 'npub1bot',
      parentTaskId: 'kickoff-1',
      flowId: 'flow-1',
      flowRunId: 'run-1',
      flowStep: 3,
      predecessorTaskIds: ['approval-task-1'],
      scopeId: 'scope-1',
      scopeLineage: ['scope-1', null, null, null, null],
      tags: [],
    });

    const result = await continueFlowAfterApproval(board, {
      approvalId: 'approval-1',
      title: 'Review',
      flowId: 'flow-1',
      flowRunId: 'run-1',
      flowStep: 2,
      status: 'approved',
      approvalMode: 'manual',
      taskIds: ['approval-task-1'],
      brief: 'Approve the work',
      approverWhitelist: [],
    });

    expect(board.tasks.get('approval-task-1')?.state).toBe('done');
    expect(result.promotedTaskIds).toEqual(['task-next']);
  });
});
