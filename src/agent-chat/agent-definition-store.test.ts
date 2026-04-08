import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import { AgentDefinitionStore } from './agent-definition-store';

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
});
