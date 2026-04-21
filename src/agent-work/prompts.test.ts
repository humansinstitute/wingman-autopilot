import { describe, expect, test } from 'bun:test';

import {
  buildAgentWorkGoal,
  buildApprovalDispatchPrompt,
  buildFlowDispatchPrompt,
  buildTaskDispatchPrompt,
  buildTaskReviewPrompt,
} from './prompts';

function makeAgent() {
  return {
    agentId: 'agent_wm21',
    label: 'Wingman 21',
    botNpub: 'npub1bot',
    workspaceOwnerNpub: 'npub1workspace',
    groupNpubs: ['npub1group'],
    workingDirectory: '/tmp/wm21',
    capabilities: ['task_dispatch'],
    chatPromptTemplate: '',
    taskPromptTemplate: 'Task {{task_id}} in {{scope_id}} lineage {{scope_lineage}} :: {{title}}',
    flowDispatchPromptTemplate: 'Flow {{task_id}} {{flow_id}} {{scope_lineage}}',
    taskReviewPromptTemplate: 'Review {{task_id}} {{flow_run_id}} {{state}}',
    approvalDispatchPromptTemplate: 'Approval {{approval_id}} {{approval_state}} {{flow_run_id}}',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    managedByNpub: 'npub1manager',
  };
}

describe('Agent work prompts', () => {
  test('renders task prompt templates with scope placeholders', () => {
    const prompt = buildTaskDispatchPrompt({
      agent: {
        ...makeAgent(),
      },
      dispatchReason: 'new task',
      task: {
        taskId: 'task-1',
        flowId: 'flow-1',
        flowRunId: 'run-1',
        flowStep: '2',
        scopeId: 'scope-7',
        scopeL1Id: 'l1-a',
        scopeL2Id: 'l2-b',
        scopeL3Id: null,
        scopeL4Id: null,
        scopeL5Id: null,
        title: 'Ship it',
        description: 'Complete the task',
        state: 'open',
        assignedTo: 'npub1bot',
        deleted: false,
        done: false,
        predecessorTaskIds: [],
      },
    });

    expect(prompt).toBe('Task task-1 in scope-7 lineage l1-a > l2-b :: Ship it');
  });

  test('builds a reflection goal for task completion and handoff', () => {
    const goal = buildAgentWorkGoal({
      taskId: 'task-1',
      flowId: 'flow-1',
      flowRunId: 'run-1',
      flowStep: '2',
      scopeId: 'scope-7',
      scopeL1Id: 'l1-a',
      scopeL2Id: 'l2-b',
      scopeL3Id: null,
      scopeL4Id: null,
      scopeL5Id: null,
      title: 'Ship it',
      description: 'Complete the task',
      state: 'open',
      assignedTo: 'npub1bot',
      deleted: false,
      done: false,
      predecessorTaskIds: [],
    });

    expect(goal).toContain('reflect and consider if you have adequately achieved the task');
    expect(goal).toContain('bun clis/sessions.ts metadata-update --next-action stop');
    expect(goal).toContain('The task was: Ship it (task_id=task-1, flow_id=flow-1, flow_run_id=run-1, flow_step=2).');
  });

  test('renders flow dispatch, task review, and approval prompts from capability-specific templates', () => {
    const agent = makeAgent();
    const task = {
      taskId: 'task-1',
      flowId: 'flow-1',
      flowRunId: 'run-1',
      flowStep: '2',
      scopeId: 'scope-7',
      scopeL1Id: 'l1-a',
      scopeL2Id: 'l2-b',
      scopeL3Id: null,
      scopeL4Id: null,
      scopeL5Id: null,
      title: 'Ship it',
      description: 'Complete the task',
      state: 'review',
      assignedTo: 'npub1bot',
      deleted: false,
      done: false,
      predecessorTaskIds: [],
    };

    expect(buildFlowDispatchPrompt({
      agent,
      task: { ...task, flowRunId: null, state: 'new' },
      dispatchReason: 'new task',
    })).toBe('Flow task-1 flow-1 l1-a > l2-b');
    expect(buildTaskReviewPrompt({
      agent,
      task,
      dispatchReason: 'task ready for review',
    })).toBe('Review task-1 run-1 review');
    expect(buildApprovalDispatchPrompt({
      agent,
      approval: {
        approvalId: 'approval-1',
        flowId: 'flow-1',
        flowRunId: 'run-1',
        flowStep: '3',
        state: 'approved',
      },
    })).toBe('Approval approval-1 approved run-1');
  });
});
