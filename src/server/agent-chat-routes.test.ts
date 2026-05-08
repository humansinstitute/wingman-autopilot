import { describe, expect, test } from 'bun:test';

import type { RequestAuthContext } from '../auth/request-context';
import {
  BackendConnectionNotFoundError,
  WorkspaceSubscriptionAccessError,
  type WorkspaceSubscriptionManager,
} from '../agent-chat/subscription-runtime';
import type { BackendConnectionRecord, WorkspaceSubscriptionRecord } from '../agent-chat/types';
import { handleAgentChatApi } from './agent-chat-routes';

const authContext: RequestAuthContext = {
  npub: 'npub1manager',
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
});
