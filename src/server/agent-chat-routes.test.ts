import { describe, expect, test } from 'bun:test';

import type { RequestAuthContext } from '../auth/request-context';
import {
  BackendConnectionNotFoundError,
  WorkspaceSubscriptionAccessError,
  type WorkspaceSubscriptionManager,
} from '../agent-chat/subscription-runtime';
import type { BackendConnectionRecord, WorkspaceSubscriptionRecord } from '../agent-chat/types';
import type { AgentProfileWorkspaceBundle } from '../agent-chat/agent-profile-policy-store';
import { handleAgentChatApi } from './agent-chat-routes';

const authContext: RequestAuthContext = {
  npub: 'npub1manager',
  session: null,
};

const adminAuthContext: RequestAuthContext = {
  npub: 'npub1admin',
  session: null,
};

function makeSubscription(overrides: Partial<WorkspaceSubscriptionRecord> = {}): WorkspaceSubscriptionRecord {
  const now = new Date().toISOString();
  return {
    subscriptionId: 'sub-1',
    backendConnectionId: 'backend-owned',
    workspaceOwnerNpub: 'npub1workspace',
    backendBaseUrl: 'https://tower.example.com',
    botNpub: 'npub1bot',
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
    wrappedGroupKeysJson: null,
    lastAuthResult: null,
    lastGroupRefreshResult: null,
    lastRecordPullResult: null,
    lastDecryptResult: null,
    lastRoutingResult: null,
    lastSseEvent: null,
    recentSseEvents: [],
    recentDispatches: [],
    lastSuccessfulStartupReloadAt: null,
    ...overrides,
  };
}

function buildManager(createOrUpdate: WorkspaceSubscriptionManager['createOrUpdate']): WorkspaceSubscriptionManager {
  return {
    createOrUpdate,
    listInterceptsForSubscription: () => [],
    listAgentsForWorkspaceBot: () => [],
  } as unknown as WorkspaceSubscriptionManager;
}

function makeBackendConnection(overrides: Partial<BackendConnectionRecord> = {}): BackendConnectionRecord {
  const now = new Date().toISOString();
  return {
    backendConnectionId: 'backend-owned',
    managedByNpub: 'npub1manager',
    backendBaseUrl: 'https://tower.example.com',
    serviceNpub: 'npub1service',
    setupWorkspaceOwnerNpub: 'npub1workspace',
    setupSourceAppNpub: 'npub1sourceapp',
    setupSourceAppSchemaNamespace: 'cowork',
    setupConnectionTokenRef: null,
    setupCapabilityDefaults: ['chat_intercept'],
    relayUrls: [],
    openapiUrl: null,
    docsUrl: null,
    healthUrl: null,
    supportedVersion: '5',
    sharePolicy: 'selected_users',
    healthStatus: 'healthy',
    lastHealthResult: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeProfileWorkspaceBundle(overrides: Partial<AgentProfileWorkspaceBundle> = {}): AgentProfileWorkspaceBundle {
  const now = new Date().toISOString();
  const bundle: AgentProfileWorkspaceBundle = {
    profile: {
      profileId: 'agent-profile-1',
      managedByNpub: 'npub1manager',
      agentNpub: 'npub1bot',
      label: 'Agent Profile',
      defaultPipelineDefinitionId: 'profile-pipeline',
      promptContext: 'Profile context',
      createdAt: now,
      updatedAt: now,
    },
    workspace: {
      profileWorkspaceId: 'profile-workspace-1',
      profileId: 'agent-profile-1',
      managedByNpub: 'npub1manager',
      subscriptionId: 'sub-1',
      backendConnectionId: 'backend-owned',
      workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1sourceapp',
      backendBaseUrl: 'https://tower.example.com',
      workspaceTitle: 'Workspace',
      appPubkey: 'app-pub',
      towerUrl: 'https://tower.example.com',
      connectionHealth: 'healthy',
      yokeSyncStatus: 'synced',
      relayOnboardingStatus: 'ready',
      defaultPipelineDefinitionId: 'workspace-pipeline',
      workspaceContext: 'Workspace context',
      createdAt: now,
      updatedAt: now,
    },
    policies: [
      {
        profileWorkspaceId: 'profile-workspace-1',
        eventType: 'chat_mention',
        enabled: true,
        defaultAction: 'respond',
        pipelineDefinitionId: null,
        promptContext: null,
        quietMode: false,
        lastDiagnostic: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    pipelineOverrides: [],
    appendedContexts: [],
  };
  return { ...bundle, ...overrides };
}

async function postSubscription(manager: WorkspaceSubscriptionManager, backendConnectionId: string) {
  const request = new Request('http://localhost/api/agent-chat/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      sourceAppNpub: 'npub1sourceapp',
      backendConnectionId,
      agentProfileId: 'wm-one',
    }),
  });
  return await handleAgentChatApi(
    request,
    new URL(request.url),
    'POST',
    authContext,
    { manager },
  );
}

async function postSharedSubscription(
  manager: WorkspaceSubscriptionManager,
  auth: RequestAuthContext,
) {
  const request = new Request('http://localhost/api/agent-chat/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      sourceAppNpub: 'npub1sourceapp',
    }),
  });
  return await handleAgentChatApi(
    request,
    new URL(request.url),
    'POST',
    auth,
    {
      manager,
      adminNpub: 'npub1admin',
      sharedAgentDispatch: true,
      isAdminContext: (context) => context.npub === 'npub1admin',
    },
  );
}

describe('agent-chat routes', () => {
  test('maps foreign backendConnectionId failures to 403', async () => {
    const manager = buildManager(async () => {
      throw new WorkspaceSubscriptionAccessError('Backend connection is not available to this manager.');
    });

    const response = await postSubscription(manager, 'backend-foreign');
    const body = await response!.json();

    expect(response?.status).toBe(403);
    expect(body.error).toContain('not available');
  });

  test('maps missing backendConnectionId failures to 404', async () => {
    const manager = buildManager(async () => {
      throw new BackendConnectionNotFoundError('Backend connection missing-backend was not found.');
    });

    const response = await postSubscription(manager, 'missing-backend');
    const body = await response!.json();

    expect(response?.status).toBe(404);
    expect(body.error).toContain('was not found');
  });

  test('returns a subscription for owned backendConnectionId saves', async () => {
    const manager = buildManager(async () => makeSubscription());

    const response = await postSubscription(manager, 'backend-owned');
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.subscription.backendConnectionId).toBe('backend-owned');
    expect(body.subscription.backend.backendConnectionId).toBe('backend-owned');
  });

  test('returns safe setup hints for available backend connections', async () => {
    const manager = {
      listBackendConnectionsForManager: () => [makeBackendConnection()],
      listBackendConnectionGrantsForManager: () => [
        {
          backendConnectionId: 'backend-owned',
          grantKind: 'manager_npub',
          granteeNpub: 'npub1other',
          createdAt: '2026-05-08T00:00:00.000Z',
          updatedAt: '2026-05-08T00:00:00.000Z',
        },
      ],
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/backend-connections');

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'GET',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.backendConnections[0].backendConnectionId).toBe('backend-owned');
    expect(body.backendConnections[0].setupWorkspaceOwnerNpub).toBe('npub1workspace');
    expect(body.backendConnections[0].setupSourceAppNpub).toBe('npub1sourceapp');
    expect(body.backendConnections[0].setupCapabilityDefaults).toEqual(['chat_intercept']);
    expect(body.backendConnections[0].availabilityGrants[0].granteeNpub).toBe('npub1other');
    expect(body.backendConnections[0].operator.canManageAvailability).toBe(true);
  });

  test('updates backend connection availability grants for the owner', async () => {
    const manager = {
      updateBackendConnectionAvailabilityForManager: (input: {
        backendConnectionId: string;
        managedByNpub: string;
        managerNpubs?: string[];
        sharedService?: boolean;
      }) => {
        expect(input.backendConnectionId).toBe('backend-owned');
        expect(input.managedByNpub).toBe('npub1manager');
        expect(input.managerNpubs).toEqual(['npub1other']);
        expect(input.sharedService).toBe(true);
        return {
          backendConnection: makeBackendConnection({ sharePolicy: 'shared_service' }),
          grants: [
            {
              backendConnectionId: 'backend-owned',
              grantKind: 'manager_npub' as const,
              granteeNpub: 'npub1other',
              createdAt: '2026-05-08T00:00:00.000Z',
              updatedAt: '2026-05-08T00:00:00.000Z',
            },
            {
              backendConnectionId: 'backend-owned',
              grantKind: 'shared_service' as const,
              granteeNpub: null,
              createdAt: '2026-05-08T00:00:00.000Z',
              updatedAt: '2026-05-08T00:00:00.000Z',
            },
          ],
        };
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/backend-connections/backend-owned/availability', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allowedManagerNpubs: ['npub1other'],
        grantSharedService: true,
      }),
    });

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'PATCH',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.backendConnection.sharePolicy).toBe('shared_service');
    expect(body.backendConnection.availabilityGrants).toHaveLength(2);
  });

  test('maps backend availability ownership failures to 403', async () => {
    const manager = {
      updateBackendConnectionAvailabilityForManager: () => {
        throw Object.assign(new Error('Only the backend connection owner can manage availability.'), { statusCode: 403 });
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/backend-connections/backend-foreign/availability', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowedManagerNpubs: ['npub1other'] }),
    });

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'PATCH',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(403);
    expect(body.error).toContain('Only the backend connection owner');
  });

  test('returns profile workspace settings for a managed subscription', async () => {
    const manager = {
      getProfileWorkspaceForManager: (subscriptionId: string, npub: string) => {
        expect(subscriptionId).toBe('sub-1');
        expect(npub).toBe('npub1manager');
        return makeProfileWorkspaceBundle();
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/subscriptions/sub-1/profile-workspace');

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'GET',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.profileWorkspace.workspace.profileWorkspaceId).toBe('profile-workspace-1');
    expect(body.profileWorkspace.policies[0].eventType).toBe('chat_mention');
  });

  test('maps missing profile workspace settings to 404', async () => {
    const manager = {
      getProfileWorkspaceForManager: () => null,
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/subscriptions/missing/profile-workspace');

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'GET',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(404);
    expect(body.error).toContain('Subscription not found');
  });

  test('saves profile workspace flat payloads with clears and scope rows', async () => {
    let captured: Parameters<WorkspaceSubscriptionManager['saveProfileWorkspaceForManager']>[0] | null = null;
    const manager = {
      saveProfileWorkspaceForManager: (input: Parameters<WorkspaceSubscriptionManager['saveProfileWorkspaceForManager']>[0]) => {
        captured = input;
        return makeProfileWorkspaceBundle({
          workspace: {
            ...makeProfileWorkspaceBundle().workspace,
            defaultPipelineDefinitionId: 'workspace-pipeline-2',
            workspaceContext: null,
          },
          pipelineOverrides: [
            {
              profileWorkspaceId: 'profile-workspace-1',
              targetKind: 'scope',
              targetId: 'scope-autopilot',
              pipelineDefinitionId: 'scope-pipeline',
              createdAt: '2026-06-06T00:00:00.000Z',
              updatedAt: '2026-06-06T00:00:00.000Z',
            },
          ],
          appendedContexts: [
            {
              profileWorkspaceId: 'profile-workspace-1',
              contextKind: 'channel',
              targetId: 'channel-design',
              eventType: null,
              contextText: 'Channel context',
              createdAt: '2026-06-06T00:00:00.000Z',
              updatedAt: '2026-06-06T00:00:00.000Z',
            },
          ],
        });
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/subscriptions/sub-1/profile-workspace', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileDefaultPipelineDefinitionId: null,
        profilePromptContext: null,
        workspaceDefaultPipelineDefinitionId: 'workspace-pipeline-2',
        workspaceContext: null,
        policies: [
          {
            eventType: 'chat_mention',
            enabled: false,
            defaultAction: 'ignore',
            pipelineDefinitionId: null,
            promptContext: null,
            quietMode: true,
          },
        ],
        pipelineOverrides: [
          { targetKind: 'scope', targetId: 'scope-autopilot', pipelineDefinitionId: 'scope-pipeline' },
          { targetKind: 'channel', targetId: '', pipelineDefinitionId: 'ignored' },
        ],
        appendedContexts: [
          { contextKind: 'channel', targetId: 'channel-design', contextText: 'Channel context' },
          { contextKind: 'scope', targetId: 'scope-empty', contextText: '' },
        ],
      }),
    });

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'PATCH',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(captured).toMatchObject({
      subscriptionId: 'sub-1',
      managedByNpub: 'npub1manager',
      profileDefaultPipelineDefinitionId: null,
      profilePromptContext: null,
      workspaceDefaultPipelineDefinitionId: 'workspace-pipeline-2',
      workspaceContext: null,
    });
    expect(captured?.policies).toEqual([
      {
        eventType: 'chat_mention',
        enabled: false,
        defaultAction: 'ignore',
        pipelineDefinitionId: null,
        promptContext: null,
        quietMode: true,
      },
    ]);
    expect(captured?.pipelineOverrides).toEqual([
      { targetKind: 'scope', targetId: 'scope-autopilot', pipelineDefinitionId: 'scope-pipeline' },
    ]);
    expect(captured?.appendedContexts).toEqual([
      { contextKind: 'channel', targetId: 'channel-design', eventType: null, contextText: 'Channel context' },
      { contextKind: 'scope', targetId: 'scope-empty', eventType: null, contextText: '' },
    ]);
    expect(body.profileWorkspace.workspace.defaultPipelineDefinitionId).toBe('workspace-pipeline-2');
    expect(body.profileWorkspace.pipelineOverrides[0].targetId).toBe('scope-autopilot');
  });

  test('saves nested profile workspace payloads sparsely and supports explicit replacement clears', async () => {
    let captured: Parameters<WorkspaceSubscriptionManager['saveProfileWorkspaceForManager']>[0] | null = null;
    const manager = {
      saveProfileWorkspaceForManager: (input: Parameters<WorkspaceSubscriptionManager['saveProfileWorkspaceForManager']>[0]) => {
        captured = input;
        return makeProfileWorkspaceBundle({ pipelineOverrides: [], appendedContexts: [] });
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/subscriptions/sub-1/profile-workspace', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileWorkspace: {
          profile: { promptContext: 'Nested profile context' },
          workspace: { workspaceContext: 'Nested workspace context' },
          policies: [{ eventType: 'task_assigned', enabled: true }],
          pipelineOverrides: [],
          appendedContexts: [],
        },
      }),
    });

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'PATCH',
      authContext,
      { manager },
    );

    expect(response?.status).toBe(200);
    expect(captured?.profilePromptContext).toBe('Nested profile context');
    expect(captured?.workspaceContext).toBe('Nested workspace context');
    expect('profileDefaultPipelineDefinitionId' in (captured ?? {})).toBe(false);
    expect('workspaceDefaultPipelineDefinitionId' in (captured ?? {})).toBe(false);
    expect(captured?.policies).toEqual([{ eventType: 'task_assigned', enabled: true }]);
    expect(captured?.pipelineOverrides).toEqual([]);
    expect(captured?.appendedContexts).toEqual([]);
  });

  test('denies non-admin profile workspace saves in shared dispatch mode', async () => {
    const manager = {
      saveProfileWorkspaceForManager: () => {
        throw new Error('save should not be called');
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/subscriptions/sub-1/profile-workspace', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceContext: 'blocked' }),
    });

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'PATCH',
      authContext,
      {
        manager,
        adminNpub: 'npub1admin',
        sharedAgentDispatch: true,
        isAdminContext: () => false,
      },
    );
    const body = await response!.json();

    expect(response?.status).toBe(403);
    expect(body.error).toContain('Ask an administrator');
  });

  test('shared agent dispatch lists admin-managed subscriptions for non-admin viewers', async () => {
    const manager = {
      listBackendConnectionsForManager: (npub: string) => {
        expect(npub).toBe('npub1admin');
        return [makeBackendConnection({ managedByNpub: 'npub1admin' })];
      },
      listForManager: (npub: string) => {
        expect(npub).toBe('npub1admin');
        return [makeSubscription({ managedByNpub: 'npub1admin' })];
      },
      listInterceptsForSubscription: (_subscriptionId: string, npub: string) => {
        expect(npub).toBe('npub1admin');
        return [];
      },
      listAgentsForWorkspaceBot: (_workspaceOwnerNpub: string, _botNpub: string, npub: string) => {
        expect(npub).toBe('npub1admin');
        return [];
      },
      listBackendConnectionGrantsForManager: () => {
        throw new Error('non-admin viewers should not receive backend availability grants');
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/subscriptions');

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'GET',
      authContext,
      {
        manager,
        adminNpub: 'npub1admin',
        sharedAgentDispatch: true,
        isAdminContext: () => false,
      },
    );
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.permissions).toEqual({ shared: true, canManage: false });
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].managedByNpub).toBe('npub1admin');
    expect(body.subscriptions[0].operator.canManage).toBe(false);
    expect(body.subscriptions[0].operator.shared).toBe(true);
  });

  test('lists every subscription with backend display information', async () => {
    const manager = {
      listBackendConnectionsForManager: () => [
        makeBackendConnection({
          backendConnectionId: 'backend-one',
          backendBaseUrl: 'https://tower-one.example.com',
          serviceNpub: 'npub1serviceone',
          lastHealthResult: {
            ok: true,
            code: 'backend_healthy',
            message: 'ok',
            at: '2026-05-20T00:00:00.000Z',
            details: { response: { tower_name: 'Tower One' } },
          },
        }),
        makeBackendConnection({
          backendConnectionId: 'backend-two',
          backendBaseUrl: 'https://tower-two.example.com',
          serviceNpub: 'npub1servicetwo',
        }),
      ],
      listForManager: () => [
        makeSubscription({
          subscriptionId: 'sub-one',
          backendConnectionId: 'backend-one',
          backendBaseUrl: 'https://tower-one.example.com',
        }),
        makeSubscription({
          subscriptionId: 'sub-two',
          backendConnectionId: 'backend-two',
          backendBaseUrl: 'https://tower-two.example.com',
        }),
      ],
      listInterceptsForSubscription: () => [],
      listAgentsForWorkspaceBot: () => [],
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/subscriptions');

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'GET',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.subscriptions).toHaveLength(2);
    expect(body.subscriptions.map((subscription: any) => subscription.subscriptionId)).toEqual(['sub-one', 'sub-two']);
    expect(body.subscriptions[0].backend).toMatchObject({
      backendConnectionId: 'backend-one',
      backendBaseUrl: 'https://tower-one.example.com',
      serviceNpub: 'npub1serviceone',
      workspaceName: 'Tower One',
    });
    expect(body.subscriptions[1].backend).toMatchObject({
      backendConnectionId: 'backend-two',
      backendBaseUrl: 'https://tower-two.example.com',
      serviceNpub: 'npub1servicetwo',
    });
  });

  test('lists dispatch routes scoped to the requested subscription', async () => {
    const manager = {
      listDispatchRoutesForSubscription: (subscriptionId: string, npub: string) => {
        expect(subscriptionId).toBe('sub-two');
        expect(npub).toBe('npub1manager');
        return [
          {
            routeId: 'route-two',
            managedByNpub: 'npub1manager',
            subscriptionId: 'sub-two',
            workspaceOwnerNpub: 'npub1workspace',
            botNpub: 'npub1bot',
            sourceAppNpub: 'npub1sourceapp',
            triggerKind: 'chat',
            capability: 'chat_intercept',
            pipelineDefinitionId: 'pipeline-two',
            enabled: true,
            priority: 100,
            matchJson: {},
            inputTemplateJson: {},
            concurrencyKeyTemplate: '${workspace.subscriptionId}:${routing.threadId}:${route.routeId}',
            activePolicy: 'queue',
            dedupeWindowSeconds: 60,
            createdAt: '2026-05-20T00:00:00.000Z',
            updatedAt: '2026-05-20T00:00:00.000Z',
          },
        ];
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/dispatch-routes?subscriptionId=sub-two');

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'GET',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.dispatchRoutes).toHaveLength(1);
    expect(body.dispatchRoutes[0].subscriptionId).toBe('sub-two');
  });

  test('saves dispatch routes through the requested subscription scope', async () => {
    const manager = {
      saveDispatchRouteForManager: (input: any) => {
        expect(input.managedByNpub).toBe('npub1manager');
        expect(input.subscriptionId).toBe('sub-two');
        expect(input.triggerKind).toBe('task');
        expect(input.capability).toBe('task_dispatch');
        return {
          routeId: 'route-two',
          managedByNpub: input.managedByNpub,
          subscriptionId: input.subscriptionId,
          workspaceOwnerNpub: 'npub1workspace',
          botNpub: 'npub1bot',
          sourceAppNpub: 'npub1sourceapp',
          triggerKind: input.triggerKind,
          capability: input.capability,
          pipelineDefinitionId: input.pipelineDefinitionId,
          enabled: true,
          priority: 100,
          matchJson: {},
          inputTemplateJson: {},
          concurrencyKeyTemplate: '${workspace.subscriptionId}:${record.recordId}:${route.routeId}',
          activePolicy: 'skip',
          dedupeWindowSeconds: 60,
          createdAt: '2026-05-20T00:00:00.000Z',
          updatedAt: '2026-05-20T00:00:00.000Z',
        };
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/dispatch-routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscriptionId: 'sub-two',
        triggerKind: 'task',
        capability: 'task_dispatch',
        pipelineDefinitionId: 'pipeline-two',
      }),
    });

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'POST',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.dispatchRoute.subscriptionId).toBe('sub-two');
  });

  test('shared agent dispatch blocks non-admin subscription writes', async () => {
    const manager = {
      createOrUpdate: () => {
        throw new Error('non-admin writes should be blocked before manager calls');
      },
    } as unknown as WorkspaceSubscriptionManager;

    const response = await postSharedSubscription(manager, authContext);
    const body = await response!.json();

    expect(response?.status).toBe(403);
    expect(body.error).toContain('shared');
  });

  test('shared agent dispatch writes as the admin manager for admins', async () => {
    const manager = buildManager(async (input) => {
      expect(input.managedByNpub).toBe('npub1admin');
      return makeSubscription({ managedByNpub: 'npub1admin' });
    });

    const response = await postSharedSubscription(manager, adminAuthContext);
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.subscription.managedByNpub).toBe('npub1admin');
    expect(body.subscription.operator.canManage).toBe(true);
    expect(body.subscription.operator.shared).toBe(true);
  });
});
