import { describe, expect, test } from 'bun:test';

import { AccessActions } from '../auth/access-control';
import type { RequestAuthContext } from '../auth/request-context';
import { handleAppsApi, type AppsApiContext } from './apps-api-routes';

const authContext: RequestAuthContext = {
  npub: 'npub1viewer',
  actorNpub: 'npub1viewer',
  signerNpub: 'npub1viewer',
  subjectNpub: 'npub1viewer',
  targetOwnerNpub: 'npub1viewer',
  delegatedOwnerNpub: null,
  delegateRelationshipId: null,
  delegateScopes: null,
  session: {
    npub: 'npub1viewer',
    nonce: 'nonce',
    issuedAt: 0,
    expiresAt: 999999,
  },
  authMethod: 'session',
};

function idleStatus(appId: string) {
  return {
    appId,
    status: 'idle' as const,
    lastAction: null,
    lastExitCode: null,
    message: undefined,
    updatedAt: '2026-07-04T00:00:00.000Z',
    lastSuccessAt: undefined,
    lastFailureAt: undefined,
    running: false,
    inProgressAction: null,
  };
}

function createContext(
  overrides: Partial<AppsApiContext> = {},
): AppsApiContext {
  return {
    adminNpub: null,
    sharedInstanceAccess: false,
    workspaceScope: { defaultDirectory: '/workspace' } as AppsApiContext['workspaceScope'],
    viewerNpub: 'npub1viewer',
    AccessActions: { AppsManage: AccessActions.AppsManage },
    ensureApiAccess: async () => null,
    normaliseOptionalString: (value) => {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    },
    normaliseNpub: (npub) => npub ?? null,
    ensureDirectory: async (root) => root,
    ensureWithinAllowedDirectories: () => undefined,
    parseAppScripts: () => ({}),
    parseBooleanInput: () => undefined,
    parsePortInput: () => null,
    parseBooleanFlag: () => false,
    appActions: [],
    canAccessApp: () => true,
    deriveDirectoryNameFromUrl: () => 'starter',
    cloneRepositoryIntoWorkspace: async () => ({
      root: '/workspace/starter',
      label: 'Starter',
      scripts: {},
    }),
    scanDirectoryTree: async () => [],
    buildAppOwnerFilters: () => [],
    defaultAppProcessStatus: idleStatus,
    resolveOwnerAliasCached: () => null,
    buildAppResponse: () => ({}),
    appRegistry: {
      listApps: async () => [],
      getApp: async () => undefined,
      discoverScripts: async () => ({}),
      registerApp: async () => {
        throw new Error('not implemented');
      },
      updateApp: async () => {
        throw new Error('not implemented');
      },
      removeApp: async () => false,
    },
    appProcessManager: {
      listStatuses: async () => [],
      getStatus: async (appId) => idleStatus(appId),
      tailLogs: async () => [],
      clearLogs: async () => undefined,
      forget: () => undefined,
      kill: async () => undefined,
      start: async (appId) => idleStatus(appId),
      stop: async (appId) => idleStatus(appId),
      restart: async (appId) => idleStatus(appId),
      setup: async (appId) => idleStatus(appId),
      build: async (appId) => idleStatus(appId),
    },
    appAliasRegistry: {
      getByAppId: async () => undefined,
    },
    npubProjectStore: {
      getByPath: () => null,
      setAppId: () => undefined,
      createProject: () => null,
      clearAppIdByAppId: () => undefined,
    },
    createCaproverTargetClientsFromEnv: () => [],
    createAppTarball: async () => ({ buffer: new Uint8Array(), fileCount: 0 }),
    caproverStore: {} as AppsApiContext['caproverStore'],
    ...overrides,
  };
}

describe('handleAppsApi', () => {
  test('passes viewer npub to app clone helper for GitHub credentials', async () => {
    const calls: Array<{
      repoUrl: string;
      directoryName: string;
      viewerNpub: string | null;
    }> = [];
    const ctx = createContext({
      cloneRepositoryIntoWorkspace: async (_scope, repoUrl, directoryName, viewerNpub) => {
        calls.push({ repoUrl, directoryName, viewerNpub });
        return {
          root: '/workspace/testwapp',
          label: 'Testwapp',
          scripts: {},
        };
      },
    });
    const request = new Request('http://localhost/api/apps/clone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://github.com/humansinstitute/testwapp.git',
        directory: 'testwapp',
      }),
    });

    const response = await handleAppsApi(
      request,
      new URL(request.url),
      'POST',
      authContext,
      ctx,
    );

    expect(response?.status).toBe(201);
    expect(calls).toEqual([{
      repoUrl: 'https://github.com/humansinstitute/testwapp.git',
      directoryName: 'testwapp',
      viewerNpub: 'npub1viewer',
    }]);
  });
});
