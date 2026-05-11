import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import { AgentDefinitionStore } from './agent-definition-store';
import { BackendConnectionStore } from './backend-connection-store';
import { DispatchPipelineRuntime } from './dispatch-pipelines/runtime';
import { DispatchRouteStore } from './dispatch-pipelines/route-store';
import { WorkspaceSubscriptionManager } from './subscription-runtime';
import { WorkspaceSubscriptionStore } from './workspace-subscription-store';
import { PipelineStore } from '../pipelines/pipeline-store';
import type {
  AgentDefinitionRecord,
  BackendConnectionRecord,
  BotKeyStoreRecord,
  RuntimeBotIdentity,
  WorkspaceSubscriptionRecord,
} from './types';
import type { WingmanInstanceIdentity } from '../identity/wingman-instance-identity';

function makeTempDb(): string {
  return join(tmpdir(), `agent-chat-subscription-runtime-${randomUUID()}.sqlite`);
}

function encodeToken(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function makeConnectPackage(overrides: Record<string, unknown> = {}) {
  const connectionToken = encodeToken({
    direct_https_url: 'https://tower.example.com',
    service_npub: 'npub1service',
    workspace_owner_npub: 'npub1workspace',
    app_npub: 'npub1sourceapp',
  });
  return {
    kind: 'coworker_agent_connect',
    version: 5,
    generated_at: '2026-05-05T00:00:00.000Z',
    service: {
      direct_https_url: 'https://tower.example.com',
      service_npub: 'npub1service',
      health_url: 'https://tower.example.com/health',
    },
    workspace: { owner_npub: 'npub1workspace' },
    app: { app_npub: 'npub1sourceapp' },
    connection_token: connectionToken,
    capabilities: ['chat_intercept'],
    ...overrides,
  };
}

function makeBotKeyRecord(botNpub: string): BotKeyStoreRecord {
  const now = new Date().toISOString();
  return {
    id: `key-${botNpub}`,
    userNpub: 'npub1manager',
    botPubkeyHex: `${botNpub.slice(-2) || 'ab'}`.padEnd(64, 'a').slice(0, 64),
    botNpub,
    displayName: botNpub,
    encryptedToUser: 'encrypted-user',
    encryptedEscrow: 'encrypted-escrow',
    escrowUuid: 'escrow-1',
    isActive: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function makeInstanceIdentity(overrides: Partial<WingmanInstanceIdentity> = {}): WingmanInstanceIdentity {
  const secretKey = new Uint8Array(32);
  secretKey[0] = 1;
  return {
    nsec: 'nsec1wingman',
    nsecHex: '01'.padEnd(64, '0'),
    secretKey,
    pubkeyHex: 'f'.repeat(64),
    npub: 'npub1wingmanbot',
    displayName: 'wingman-bot',
    source: 'env',
    ...overrides,
  };
}

function createTestManager(
  dbPath: string,
  botKeys: Map<string, BotKeyStoreRecord>,
  checkBackendHealth?: ConstructorParameters<typeof WorkspaceSubscriptionManager>[0]['checkBackendHealth'],
  instanceIdentity: WingmanInstanceIdentity | null = null,
  dispatchPipelineRuntime?: ConstructorParameters<typeof WorkspaceSubscriptionManager>[0]['dispatchPipelineRuntime'],
) {
  const store = new WorkspaceSubscriptionStore(dbPath);
  const agentStore = new AgentDefinitionStore(dbPath);
  const backendStore = new BackendConnectionStore(dbPath);
  const manager = new WorkspaceSubscriptionManager({
    store,
    agentStore,
    backendStore,
    checkBackendHealth: checkBackendHealth ?? (async (record) => ({
      healthStatus: record.healthUrl ? 'healthy' : 'degraded',
      diagnostic: {
        ok: Boolean(record.healthUrl),
        code: record.healthUrl ? null : 'backend_health_unavailable',
        message: record.healthUrl ? 'Backend health check passed.' : 'Backend connection has no health URL.',
        at: new Date().toISOString(),
        details: { health_url: record.healthUrl },
      },
    })),
    botKeyStore: {
      getActiveKeyForUser: () => null,
      getActiveKeyForBotNpub: (botNpub) => botKeys.get(botNpub) ?? null,
    },
    getInstanceIdentity: () => instanceIdentity,
    dispatchPipelineRuntime,
  });

  const managerInternals = manager as unknown as {
    unlockBotIdentity: (record: BotKeyStoreRecord) => RuntimeBotIdentity;
    prepareWorkspaceSession: (record: WorkspaceSubscriptionRecord, botIdentity: RuntimeBotIdentity) => Promise<WorkspaceSubscriptionRecord>;
    registerWorkspaceKey: (record: WorkspaceSubscriptionRecord) => Promise<WorkspaceSubscriptionRecord>;
    refreshGroupKeys: (record: WorkspaceSubscriptionRecord) => Promise<WorkspaceSubscriptionRecord>;
    ensureConnected: (record: WorkspaceSubscriptionRecord) => Promise<void>;
  };
  managerInternals.unlockBotIdentity = (record) => ({
    botNpub: record.botNpub,
    botPubkeyHex: record.botPubkeyHex,
    botSecret: new Uint8Array(32),
  });
  managerInternals.prepareWorkspaceSession = async (record) => store.save({
    ...record,
    wsKeyNpub: `ws-${record.botNpub}`,
    wsKeyBlobJson: JSON.stringify({ bot: record.botNpub }),
  });
  managerInternals.registerWorkspaceKey = async (record) => store.save({
    ...record,
    wsKeyStatus: 'active',
    lastAuthOkAt: new Date().toISOString(),
  });
  managerInternals.refreshGroupKeys = async (record) => store.save({
    ...record,
    groupKeyStatus: 'active',
    healthStatus: 'healthy',
    wrappedGroupKeysJson: JSON.stringify([{ group_npub: `group-${record.botNpub}` }]),
  });
  managerInternals.ensureConnected = async (record) => {
    store.save({
      ...record,
      sseStatus: 'connected',
      healthStatus: 'healthy',
    });
  };

  return { manager, store, agentStore, backendStore };
}

function saveAgent(agentStore: AgentDefinitionStore, input: Partial<AgentDefinitionRecord> & { agentId: string; botNpub: string; managedByNpub: string }) {
  const now = new Date().toISOString();
  agentStore.save({
    agentId: input.agentId,
    label: input.label ?? input.agentId,
    botNpub: input.botNpub,
    workspaceOwnerNpub: input.workspaceOwnerNpub ?? 'npub1workspace',
    groupNpubs: input.groupNpubs ?? ['npub1group'],
    workingDirectory: input.workingDirectory ?? `/tmp/${input.agentId}`,
    capabilities: input.capabilities ?? ['chat_intercept'],
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
    managedByNpub: input.managedByNpub,
  });
}

function saveBackendConnection(
  backendStore: BackendConnectionStore,
  input: Partial<BackendConnectionRecord> & { managedByNpub: string },
): BackendConnectionRecord {
  return backendStore.save({
    ...backendStore.createDefault({
      managedByNpub: input.managedByNpub,
      backendBaseUrl: input.backendBaseUrl ?? 'https://tower.example.com',
      serviceNpub: input.serviceNpub ?? 'npub1service',
      healthUrl: input.healthUrl ?? 'https://tower.example.com/health',
    }),
    ...input,
  });
}

describe('WorkspaceSubscriptionManager', () => {
  test('does not advance the SSE resume point from connected event payload cursors', async () => {
    const dbPath = makeTempDb();
    const store = new WorkspaceSubscriptionStore(dbPath);
    const manager = new WorkspaceSubscriptionManager({
      store,
      botKeyStore: {
        getActiveKeyForUser: () => null,
        getActiveKeyForBotNpub: () => null,
      },
    });
    const record = store.save(store.createDefault({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      botNpub: 'npub1bot',
      sourceAppNpub: 'npub1sourceapp',
    }));

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(record, null, 'connected', JSON.stringify({ event_id: 1011 }));

    expect(next.lastSseEventId).toBeNull();
    expect(store.getBySubscriptionId(record.subscriptionId)?.lastSseEventId).toBeNull();
  });

  test('derives agent groups from refreshed wrapped group keys when none are supplied', async () => {
    const dbPath = makeTempDb();
    const store = new WorkspaceSubscriptionStore(dbPath);
    const agentStore = new AgentDefinitionStore(dbPath);
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      botKeyStore: {
        getActiveKeyForUser: () => null,
        getActiveKeyForBotNpub: () => null,
      },
    });

    const now = new Date().toISOString();
    store.save({
      subscriptionId: 'sub-1',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      botNpub: 'npub1botshared',
      sourceAppNpub: 'npub1sourceapp',
      wsKeyNpub: 'npub1wskey',
      wsKeyStatus: 'active',
      groupKeyStatus: 'active',
      sseStatus: 'connected',
      healthStatus: 'healthy',
      triggerConfigRecordId: null,
      lastSseEventId: null,
      lastAuthOkAt: now,
      lastGroupRefreshAt: now,
      lastErrorCode: null,
      lastErrorAt: null,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
      wsKeyBlobJson: null,
      wrappedGroupKeysJson: JSON.stringify([
        { group_npub: 'npub1groupb' },
        { group_npub: 'npub1groupa' },
        { group_npub: 'npub1groupa' },
        {},
      ]),
      lastAuthResult: null,
      lastGroupRefreshResult: null,
      lastRecordPullResult: null,
      lastDecryptResult: null,
      lastRoutingResult: null,
      lastSseEvent: null,
      recentSseEvents: [],
      recentDispatches: [],
      lastSuccessfulStartupReloadAt: null,
    });

    const record = await manager.saveAgentForManager({
      managedByNpub: 'npub1manager',
      agentId: 'agent_auto',
      label: 'Auto Agent',
      botNpub: 'npub1botshared',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: [],
      workingDirectory: '/tmp/agent-auto',
      capabilities: ['chat_intercept'],
      enabled: true,
    });

    expect(record.groupNpubs).toEqual(['npub1groupa', 'npub1groupb']);
  });

  test('imports the same Agent Connect workspace for two owned profiles with separate bot identities', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([
      ['npub1botone', makeBotKeyRecord('npub1botone')],
      ['npub1bottwo', makeBotKeyRecord('npub1bottwo')],
    ]);
    const { manager, store, agentStore, backendStore } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });
    saveAgent(agentStore, { agentId: 'wm-two', botNpub: 'npub1bottwo', managedByNpub: 'npub1manager' });

    const first = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage(),
      agentProfileId: 'wm-one',
    });
    const second = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage(),
      agentProfileId: 'wm-two',
    });

    expect(first.subscription.subscriptionId).not.toBe(second.subscription.subscriptionId);
    expect(first.subscription.agentProfileId).toBe('wm-one');
    expect(second.subscription.agentProfileId).toBe('wm-two');
    expect(first.subscription.botNpub).toBe('npub1botone');
    expect(second.subscription.botNpub).toBe('npub1bottwo');
    expect(store.listForManagerNpub('npub1manager')).toHaveLength(2);
    expect(backendStore.listForManagerNpub('npub1manager')[0]?.healthStatus).toBe('healthy');
  });

  test('imports wrapped Agent Connect text without a profile when WINGMAN_PRIV is configured', async () => {
    const dbPath = makeTempDb();
    const instanceIdentity = makeInstanceIdentity();
    const { manager, store, backendStore } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
    );

    const tokenText = [
      '======AGENTCONNECT-TOKEN======',
      JSON.stringify(makeConnectPackage(), null, 2),
      '======AGENTCONNECT-TOKEN======',
    ].join('\n');

    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: tokenText,
    });

    expect(imported.subscription.botNpub).toBe(instanceIdentity.npub);
    expect(imported.subscription.agentProfileId).toBeNull();
    expect(imported.subscription.sseStatus).toBe('connected');
    expect(store.listForManagerNpub('npub1manager')).toHaveLength(1);
    expect(backendStore.listForManagerNpub('npub1manager')[0]?.healthStatus).toBe('healthy');
  });

  test('seeds default dispatch routes from Agent Connect capability defaults', async () => {
    const dbPath = makeTempDb();
    const routeStore = new DispatchRouteStore(dbPath);
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      pipelineStore: new PipelineStore(makeTempDb()),
      getSessionApiContext: () => null,
      callbackOrigin: 'http://localhost:3600',
      requirePipelineRoutes: true,
    });
    const { manager } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      makeInstanceIdentity(),
      dispatchPipelineRuntime,
    );

    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage({ capabilities: ['chat_intercept', 'task_dispatch'] }),
    });

    const routes = routeStore.listForSubscription(imported.subscription.subscriptionId);
    expect(routes.map((route) => `${route.triggerKind}:${route.capability}`).sort()).toEqual([
      'chat:chat_intercept',
      'task:task_dispatch',
    ]);
    expect(routes.map((route) => route.pipelineDefinitionId).sort()).toEqual([
      'demo-agent-dispatch-chat-response',
      'demo-agent-dispatch-task-response',
    ]);
  });

  test('rejects missing or foreign Agent Profile ids before importing Agent Connect packages', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'foreign-agent', botNpub: 'npub1botone', managedByNpub: 'npub1othermanager' });

    await expect(manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage(),
    })).rejects.toThrow('No active bot key exists for this user');

    await expect(manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage(),
      agentProfileId: 'missing-agent',
    })).rejects.toThrow('was not found');

    await expect(manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage(),
      agentProfileId: 'foreign-agent',
    })).rejects.toThrow('owned by another manager');

    expect(backendStore.listForManagerNpub('npub1manager')).toHaveLength(0);
  });

  test('rejects a subscription that references a foreign backend connection', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore, store } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });
    const foreignBackend = saveBackendConnection(backendStore, { managedByNpub: 'npub1othermanager' });

    await expect(manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      sourceAppNpub: 'npub1sourceapp',
      backendConnectionId: foreignBackend.backendConnectionId,
      agentProfileId: 'wm-one',
    })).rejects.toThrow('is not available to this manager');

    expect(store.listForManagerNpub('npub1manager')).toHaveLength(0);
  });

  test('allows a selected user grant to create a subscription on a managed backend connection', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });
    const sharedBackend = saveBackendConnection(backendStore, {
      managedByNpub: 'npub1owner',
      backendBaseUrl: 'https://shared-tower.example.com',
    });
    backendStore.replaceAvailabilityGrants({
      backendConnectionId: sharedBackend.backendConnectionId,
      managerNpubs: ['npub1manager'],
    });

    const subscription = await manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://ignored-input.example.com',
      sourceAppNpub: 'npub1sourceapp',
      backendConnectionId: sharedBackend.backendConnectionId,
      agentProfileId: 'wm-one',
    });

    expect(subscription.backendConnectionId).toBe(sharedBackend.backendConnectionId);
    expect(subscription.backendBaseUrl).toBe('https://shared-tower.example.com');
    expect(manager.listBackendConnectionsForManager('npub1manager').map((record) => record.backendConnectionId))
      .toContain(sharedBackend.backendConnectionId);
  });

  test('creates a selected-user subscription from backend setup hints without repeated fields', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });
    const sharedBackend = saveBackendConnection(backendStore, {
      managedByNpub: 'npub1owner',
      backendBaseUrl: 'https://shared-hints.example.com',
      setupWorkspaceOwnerNpub: 'npub1workspacehints',
      setupSourceAppNpub: 'npub1sourcehints',
      setupSourceAppSchemaNamespace: 'cowork',
      setupCapabilityDefaults: ['chat_intercept', 'task_dispatch'],
    });
    backendStore.replaceAvailabilityGrants({
      backendConnectionId: sharedBackend.backendConnectionId,
      managerNpubs: ['npub1manager'],
    });

    const subscription = await manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: '',
      backendBaseUrl: '',
      sourceAppNpub: '',
      backendConnectionId: sharedBackend.backendConnectionId,
      agentProfileId: 'wm-one',
    });

    expect(subscription.backendConnectionId).toBe(sharedBackend.backendConnectionId);
    expect(subscription.backendBaseUrl).toBe('https://shared-hints.example.com');
    expect(subscription.workspaceOwnerNpub).toBe('npub1workspacehints');
    expect(subscription.sourceAppNpub).toBe('npub1sourcehints');
    expect(subscription.sourceAppSchemaNamespace).toBe('cowork');
    expect(subscription.capabilityDefaults).toEqual(['chat_intercept', 'task_dispatch']);
  });

  test('backfills legacy direct subscriptions into reusable backend connections once', () => {
    const dbPath = makeTempDb();
    const botKeys = new Map<string, BotKeyStoreRecord>();
    const { manager, store, backendStore } = createTestManager(dbPath, botKeys);
    const legacy = store.save(store.createDefault({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://legacy-tower.example.com/',
      botNpub: 'npub1legacybot',
      sourceAppNpub: 'npub1sourceapp',
      sourceAppSchemaNamespace: 'cowork',
      capabilityDefaults: ['chat_intercept'],
    }));

    const first = manager.backfillLegacyBackendConnections();
    const linked = store.getBySubscriptionId(legacy.subscriptionId);
    const backends = backendStore.listForManagerNpub('npub1manager');
    const second = manager.backfillLegacyBackendConnections();

    expect(first).toEqual({ backfilled: 1, linkedSubscriptions: 1 });
    expect(second).toEqual({ backfilled: 0, linkedSubscriptions: 0 });
    expect(backends).toHaveLength(1);
    expect(backends[0]?.backendBaseUrl).toBe('https://legacy-tower.example.com');
    expect(backends[0]?.setupWorkspaceOwnerNpub).toBe('npub1workspace');
    expect(backends[0]?.setupSourceAppNpub).toBe('npub1sourceapp');
    expect(backends[0]?.setupCapabilityDefaults).toEqual(['chat_intercept']);
    expect(linked?.backendConnectionId).toBe(backends[0]?.backendConnectionId);
    expect(linked?.wsKeyBlobJson).toBeNull();
  });

  test('rejects an unlisted user for a selected-users backend connection', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore, store } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });
    const sharedBackend = saveBackendConnection(backendStore, {
      managedByNpub: 'npub1owner',
      backendBaseUrl: 'https://selected-tower.example.com',
    });
    backendStore.replaceAvailabilityGrants({
      backendConnectionId: sharedBackend.backendConnectionId,
      managerNpubs: ['npub1anothermanager'],
    });

    await expect(manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://ignored-input.example.com',
      sourceAppNpub: 'npub1sourceapp',
      backendConnectionId: sharedBackend.backendConnectionId,
      agentProfileId: 'wm-one',
    })).rejects.toThrow('is not available to this manager');

    expect(store.listForManagerNpub('npub1manager')).toHaveLength(0);
  });

  test('requires the explicit shared-service marker to use a shared-service backend grant', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });
    const sharedServiceBackend = saveBackendConnection(backendStore, {
      managedByNpub: 'npub1owner',
      backendBaseUrl: 'https://service-tower.example.com',
    });
    backendStore.replaceAvailabilityGrants({
      backendConnectionId: sharedServiceBackend.backendConnectionId,
      sharedService: true,
    });

    await expect(manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://ignored-input.example.com',
      sourceAppNpub: 'npub1sourceapp',
      backendConnectionId: sharedServiceBackend.backendConnectionId,
      agentProfileId: 'wm-one',
    })).rejects.toThrow('is not available to this manager');

    const subscription = await manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://ignored-input.example.com',
      sourceAppNpub: 'npub1sourceapp',
      backendConnectionId: sharedServiceBackend.backendConnectionId,
      backendConnectionGrantKind: 'shared_service',
      agentProfileId: 'wm-one',
    });

    expect(subscription.backendConnectionId).toBe(sharedServiceBackend.backendConnectionId);
    expect(subscription.backendBaseUrl).toBe('https://service-tower.example.com');
  });

  test('reports missing backend connection ids as not found', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });

    await expect(manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      sourceAppNpub: 'npub1sourceapp',
      backendConnectionId: 'missing-backend',
      agentProfileId: 'wm-one',
    })).rejects.toMatchObject({
      code: 'backend_connection_not_found',
      statusCode: 404,
    });
  });

  test('creates a subscription that references an owned backend connection', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });
    const ownedBackend = saveBackendConnection(backendStore, {
      managedByNpub: 'npub1manager',
      backendBaseUrl: 'https://owned-tower.example.com',
    });

    const subscription = await manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://ignored-input.example.com',
      sourceAppNpub: 'npub1sourceapp',
      backendConnectionId: ownedBackend.backendConnectionId,
      agentProfileId: 'wm-one',
    });

    expect(subscription.backendConnectionId).toBe(ownedBackend.backendConnectionId);
    expect(subscription.backendBaseUrl).toBe('https://owned-tower.example.com');
    expect(subscription.managedByNpub).toBe('npub1manager');
  });

  test('persists degraded backend health when Agent Connect has no health URL', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });

    await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage({
        service: {
          direct_https_url: 'https://tower.example.com',
          service_npub: 'npub1service',
        },
      }),
      agentProfileId: 'wm-one',
    });

    const [backend] = backendStore.listForManagerNpub('npub1manager');
    expect(backend?.healthStatus).toBe('degraded');
    expect(backend?.lastHealthResult?.code).toBe('backend_health_unavailable');
  });

  test('persists unhealthy backend health diagnostics during Agent Connect import', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore } = createTestManager(
      dbPath,
      botKeys,
      async () => ({
        healthStatus: 'unhealthy',
        diagnostic: {
          ok: false,
          code: 'backend_health_failed',
          message: 'Service unavailable',
          at: new Date().toISOString(),
          details: { detailCode: 'backend_health_http_error' },
        },
      }),
    );
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });

    await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage(),
      agentProfileId: 'wm-one',
    });

    const [backend] = backendStore.listForManagerNpub('npub1manager');
    expect(backend?.healthStatus).toBe('unhealthy');
    expect(backend?.lastHealthResult?.message).toBe('Service unavailable');
  });
});
