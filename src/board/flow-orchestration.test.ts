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
      references: [],
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

  async listFlowRunApprovals(flowRunId: string): Promise<BoardApprovalRecord[]> {
    return Array.from(this.approvals.values()).filter((approval) => approval.flowRunId === flowRunId);
  }
}

function makeKickoffTask(): BoardTaskRecord {
  return {
    taskId: 'kickoff-1',
    title: 'Design kickoff: dispatch a chat thread into a flow from the ellipsis menu',
    description: [
      'Review and action the source chat thread below. Follow the selected flow end-to-end and develop all tasks required to produce the design.',
      '',
      'Requested flow behavior:',
      '- Treat this as if Flight Deck started the flow from a thread message using the existing start-flow machinery.',
      '- The feature to design is an ellipsis-menu action on a chat thread message that can dispatch the thread into a flow.',
      '- Model it off the current Flight Deck start-flow function.',
      '- The dispatch prompt should be generated from general dispatch details plus the chat history.',
      '',
      'Boilerplate instruction:',
      'Review and action this chat thread. Follow the Design flow. Develop all tasks needed to design the feature cleanly. Preserve source-thread provenance in resulting records.',
      '',
      'Source thread metadata:',
      '- workspace_owner_npub: npub1workspace',
      '- channel_id: channel-1',
      '- thread_id: thread-1',
      '- source_scope_id: scope-1',
      '- selected_flow_id: flow-1',
      '- source_commit_message_id: message-2',
      '',
      'Resolved run contract:',
      '- repo_root: /Users/mini/code/wingmen',
      '- primary_workdir: /Users/mini/code/wingmen',
      '- docs_dir: /Users/mini/code/wingmen/docs',
      '- primary_artifact_path: /Users/mini/code/wingmen/docs/feature-links.md',
      '- cross_repo_review_targets:',
      '  - /Users/mini/code/wingmanbefree/wingman-fd/src/flows-manager.js',
      '  - /Users/mini/code/wingmanbefree/wingman-fd/src/chat-message-manager.js',
      '  - /Users/mini/code/wingmen/docs/design/flight-deck-flow-dispatch-contract.md',
    ].join('\n'),
    state: 'new',
    assignedTo: 'npub1bot',
    parentTaskId: null,
    flowId: 'flow-1',
    flowRunId: null,
    flowStep: null,
    predecessorTaskIds: [],
    scopeId: 'scope-1',
    scopeLineage: ['scope-1', null, null, null, null],
    references: [
      { type: 'scope', id: 'scope-1' },
      { type: 'flow', id: 'flow-1' },
      { type: 'channel', id: 'channel-1' },
      { type: 'message', id: 'thread-1' },
      { type: 'message', id: 'message-2' },
    ],
    tags: [],
  };
}

function makeLinearFlow(): BoardFlowRecord {
  return {
    flowId: 'flow-1',
    title: 'Linear Flow',
    description: 'A linear test flow',
    steps: [
      {
        stepNumber: 1,
        type: 'job_dispatch',
        title: 'Research',
        instruction: 'Review the design brief in <project directory>/docs/feature-<name>.md.',
        approvalMode: 'manual',
        approverWhitelist: [],
        artifactsExpected: ['document'],
        briefTemplate: '',
        managerGuidance: '',
        workerGuidance: 'Keep the handoff doc current.',
        directoryOverride: '',
      },
      {
        stepNumber: 2,
        type: 'approval',
        title: 'Review',
        instruction: 'Prepare approval for the feature brief.',
        approvalMode: 'manual',
        approverWhitelist: ['npub1reviewer'],
        artifactsExpected: ['document'],
        briefTemplate: 'Review the completed design in <project directory>/docs/feature-<name>.md.',
        managerGuidance: '',
        workerGuidance: '',
        directoryOverride: '',
      },
      {
        stepNumber: 3,
        type: 'job_dispatch',
        title: 'Publish',
        instruction: 'Ship it once the approval is complete.',
        approvalMode: 'manual',
        approverWhitelist: [],
        artifactsExpected: [],
        briefTemplate: '',
        managerGuidance: '',
        workerGuidance: '',
        directoryOverride: '',
      },
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
    expect(approvalTask?.assignedTo).toBe('npub1bot');
    expect(childTasks[0]?.description).toContain('Requested behavior:');
    expect(childTasks[0]?.description).toContain('Source provenance:');
    expect(childTasks[0]?.description).toContain('@[Flight Deck chat](mention:channel:channel-1)');
    expect(childTasks[0]?.description).toContain('@[thread root](mention:message:thread-1)');
    expect(childTasks[0]?.description).toContain('@[dispatch request](mention:message:message-2)');
    expect(childTasks[0]?.description).toContain('Cross-repo review targets:');
    expect(childTasks[0]?.description).toContain('/Users/mini/code/wingmanbefree/wingman-fd/src/flows-manager.js');
    expect(childTasks[0]?.description).toContain(`Flow run id: ${first.flowRunId}`);
    expect(childTasks[0]?.description).toContain('Docs directory: /Users/mini/code/wingmen/docs');
    expect(childTasks[0]?.description).toContain('Expected artifacts: Feature brief at /Users/mini/code/wingmen/docs/feature-links.md');
    expect(board.tasks.get('kickoff-1')?.description).toContain('Primary artifact: /Users/mini/code/wingmen/docs/feature-links.md');
    expect(approvalTask?.description).toContain('Approval prep task. Keep this task assigned to the agent while it is actionable.');
    expect(publishTask?.predecessorTaskIds).toEqual(approvalTask ? [approvalTask.taskId] : undefined);
    expect(approvalRecord?.approverWhitelist).toEqual(['npub1reviewer']);
    expect(approvalRecord?.brief).toContain('Approval package requirements:');
    expect(approvalRecord?.brief).toContain('/Users/mini/code/wingmen/docs/feature-links.md');

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
      references: [],
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
      references: [],
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
      references: [],
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
      references: [],
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

  test('approval prep review hands the task to the human approver before downstream work is promoted', async () => {
    const board = new FakeBoard();
    board.tasks.set('approval-task-1', {
      taskId: 'approval-task-1',
      title: 'Review',
      description: 'Approval prep task.',
      state: 'review',
      assignedTo: 'npub1bot',
      parentTaskId: 'kickoff-1',
      flowId: 'flow-1',
      flowRunId: 'run-1',
      flowStep: 2,
      predecessorTaskIds: ['task-a'],
      scopeId: 'scope-1',
      scopeLineage: ['scope-1', null, null, null, null],
      references: [],
      tags: ['flow_approval', 'flow_approval_prep', 'flow_step'],
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
      references: [],
      tags: [],
    });
    board.approvals.set('approval-1', {
      approvalId: 'approval-1',
      title: 'Review',
      flowId: 'flow-1',
      flowRunId: 'run-1',
      flowStep: 2,
      status: 'pending',
      approvalMode: 'manual',
      taskIds: ['approval-task-1'],
      brief: 'Review the completed design.',
      approverWhitelist: ['npub1reviewer'],
    });

    const result = await continueFlowAfterTaskReview(board, 'approval-task-1');

    expect(result.promotedTaskIds).toEqual([]);
    expect(board.tasks.get('approval-task-1')?.assignedTo).toBe('npub1reviewer');
    expect(board.tasks.get('approval-task-1')?.state).toBe('review');
    expect(board.tasks.get('task-next')?.state).toBe('new');
  });

  test('approval dispatch marks approval task done and promotes downstream tasks', async () => {
    const board = new FakeBoard();
    board.tasks.set('approval-task-1', {
      taskId: 'approval-task-1',
      title: 'Review',
      description: '',
      state: 'review',
      assignedTo: 'npub1reviewer',
      parentTaskId: 'kickoff-1',
      flowId: 'flow-1',
      flowRunId: 'run-1',
      flowStep: 2,
      predecessorTaskIds: ['task-a'],
      scopeId: 'scope-1',
      scopeLineage: ['scope-1', null, null, null, null],
      references: [],
      tags: ['flow_approval', 'flow_approval_prep'],
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
      references: [],
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
