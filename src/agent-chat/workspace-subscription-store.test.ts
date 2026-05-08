import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import { WorkspaceSubscriptionStore } from './workspace-subscription-store';

function makeTempDb(): string {
  return join(tmpdir(), `agent-chat-workspace-store-${randomUUID()}.sqlite`);
}

describe('WorkspaceSubscriptionStore', () => {
  test('scopes same workspace imports by manager and backend connection', () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb());
    const first = store.save(store.createDefault({
      managedByNpub: 'npub1managera',
      backendConnectionId: 'backend-1',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      botNpub: 'npub1botshared',
      sourceAppNpub: 'npub1app',
      connectionTokenRef: 'agent-connect:first',
    }));
    const second = store.save(store.createDefault({
      managedByNpub: 'npub1managerb',
      backendConnectionId: 'backend-1',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      botNpub: 'npub1botshared',
      sourceAppNpub: 'npub1app',
      connectionTokenRef: 'agent-connect:second',
    }));

    expect(first.subscriptionId).not.toBe(second.subscriptionId);
    expect(store.listForManagerNpub('npub1managera')).toHaveLength(1);
    expect(store.listForManagerNpub('npub1managerb')).toHaveLength(1);
    expect(store.getBySubscriptionScope({
      managedByNpub: 'npub1managera',
      backendConnectionId: 'backend-1',
      workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1app',
      botNpub: 'npub1botshared',
    })?.subscriptionId).toBe(first.subscriptionId);
    expect(store.getBySubscriptionScope({
      managedByNpub: 'npub1managerb',
      backendConnectionId: 'backend-1',
      workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1app',
      botNpub: 'npub1botshared',
    })?.subscriptionId).toBe(second.subscriptionId);
  });
});
