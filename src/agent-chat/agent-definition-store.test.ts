import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import { AgentDefinitionStore } from './agent-definition-store';
import {
  DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE,
} from './prompt-templates';

function makeTempDb(): string {
  return join(tmpdir(), `agent-chat-agent-store-${randomUUID()}.sqlite`);
}

describe('AgentDefinitionStore', () => {
  test('persists and filters local agent definitions', () => {
    const store = new AgentDefinitionStore(makeTempDb());
    const now = new Date().toISOString();

    store.save({
      agentId: 'agent_alpha',
      label: 'Alpha',
      botNpub: 'npub1botalpha',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1groupb', 'npub1groupa', 'npub1groupa'],
      workingDirectory: '/tmp/alpha',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });
    store.save({
      agentId: 'agent_beta',
      label: 'Beta',
      botNpub: 'npub1botbeta',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1groupc'],
      workingDirectory: '/tmp/beta',
      capabilities: ['chat_intercept'],
      enabled: false,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });

    const managedAgents = store.listForManagerNpub('npub1manager');
    expect(managedAgents).toHaveLength(2);
    expect(managedAgents[0]?.agentId).toBe('agent_alpha');
    expect(managedAgents[0]?.groupNpubs).toEqual(['npub1groupa', 'npub1groupb']);

    const workspaceBotAgents = store.listByWorkspaceAndBot('npub1workspace', 'npub1botalpha');
    expect(workspaceBotAgents).toHaveLength(1);
    expect(workspaceBotAgents[0]?.workingDirectory).toBe('/tmp/alpha');
  });

  test('normalises capabilities backward-compatibly', () => {
    const store = new AgentDefinitionStore(makeTempDb());
    const now = new Date().toISOString();

    store.save({
      agentId: 'agent_task',
      label: 'Task Agent',
      botNpub: 'npub1bot',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/task',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });
    store.save({
      agentId: 'agent_legacy',
      label: 'Legacy Agent',
      botNpub: 'npub1bot',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/legacy',
      capabilities: ['unknown' as never],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });

    expect(store.getByAgentId('agent_task')?.capabilities).toEqual(['task_dispatch']);
    expect(store.getByAgentId('agent_legacy')?.capabilities).toEqual(['chat_intercept']);
    expect(store.getByAgentId('agent_legacy')?.chatPromptTemplate).toBe(DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE);
    expect(store.getByAgentId('agent_legacy')?.taskPromptTemplate).toBe(DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE);
  });

  test('persists custom chat and task prompt templates', () => {
    const store = new AgentDefinitionStore(makeTempDb());
    const now = new Date().toISOString();

    store.save({
      agentId: 'agent_prompted',
      label: 'Prompted',
      botNpub: 'npub1botprompted',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/prompted',
      capabilities: ['chat_intercept', 'task_dispatch'],
      chatPromptTemplate: 'Chat {{agent_id}} {{thread_id}}',
      taskPromptTemplate: 'Task {{task_id}} {{scope_id}}',
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });

    const stored = store.getByAgentId('agent_prompted');
    expect(stored?.chatPromptTemplate).toBe('Chat {{agent_id}} {{thread_id}}');
    expect(stored?.taskPromptTemplate).toBe('Task {{task_id}} {{scope_id}}');
  });
});
