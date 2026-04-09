import { describe, expect, test } from 'bun:test';

import { buildTaskDispatchPrompt } from './prompts';

describe('Agent work prompts', () => {
  test('renders task prompt templates with scope placeholders', () => {
    const prompt = buildTaskDispatchPrompt({
      agent: {
        agentId: 'agent_wm21',
        label: 'Wingman 21',
        botNpub: 'npub1bot',
        workspaceOwnerNpub: 'npub1workspace',
        groupNpubs: ['npub1group'],
        workingDirectory: '/tmp/wm21',
        capabilities: ['task_dispatch'],
        chatPromptTemplate: '',
        taskPromptTemplate: 'Task {{task_id}} in {{scope_id}} lineage {{scope_lineage}} :: {{title}}',
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        managedByNpub: 'npub1manager',
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
});
