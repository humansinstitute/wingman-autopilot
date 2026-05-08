import { Buffer } from 'node:buffer';

import { describe, expect, test } from 'bun:test';

import {
  buildAgentConnectImportResult,
  validateAgentConnectPackage,
} from './agent-connect-import';
import type { BackendConnectionRecord } from './types';

function encodeToken(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function makePackage(overrides: Record<string, unknown> = {}) {
  const connectionToken = encodeToken({
    type: 'superbased_connection',
    version: 2,
    direct_https_url: 'https://tower.example.com/',
    service_npub: 'npub1service',
    workspace_owner_npub: 'npub1workspace',
    app_npub: 'npub1app',
  });
  return {
    kind: 'coworker_agent_connect',
    version: 5,
    generated_at: '2026-05-05T00:00:00.000Z',
    service: {
      direct_https_url: 'https://tower.example.com',
      service_npub: 'npub1service',
      relay_urls: ['wss://relay.example.com'],
      openapi_url: 'https://tower.example.com/openapi.json',
      docs_url: 'https://tower.example.com/docs',
      health_url: 'https://tower.example.com/health',
    },
    workspace: { owner_npub: 'npub1workspace' },
    app: { app_npub: 'npub1app', schema_namespace: 'cowork' },
    connection_token: connectionToken,
    capabilities: ['chat_intercept', 'task_dispatch'],
    ...overrides,
  };
}

describe('Agent Connect import validation', () => {
  test('validates packages and builds scoped subscription input', () => {
    const validation = validateAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makePackage(),
    });
    const backendConnection: BackendConnectionRecord = {
      backendConnectionId: 'backend-1',
      managedByNpub: 'npub1manager',
      backendBaseUrl: validation.service.directHttpsUrl,
      serviceNpub: validation.service.serviceNpub,
      relayUrls: validation.service.relayUrls,
      openapiUrl: validation.service.openapiUrl,
      docsUrl: validation.service.docsUrl,
      healthUrl: validation.service.healthUrl,
      supportedVersion: validation.supportedVersion,
      sharePolicy: 'private',
      healthStatus: 'degraded',
      lastHealthResult: null,
      createdAt: '2026-05-05T00:00:00.000Z',
      updatedAt: '2026-05-05T00:00:00.000Z',
    };
    const result = buildAgentConnectImportResult(validation, backendConnection);

    expect(validation.service.directHttpsUrl).toBe('https://tower.example.com');
    expect(validation.capabilityDefaults).toEqual(['chat_intercept', 'task_dispatch']);
    expect(result.subscriptionInput.backendConnectionId).toBe('backend-1');
    expect(result.subscriptionInput.workspaceOwnerNpub).toBe('npub1workspace');
    expect(result.subscriptionInput.sourceAppNpub).toBe('npub1app');
    expect(result.subscriptionInput.connectionTokenRef).toStartWith('agent-connect:npub1workspace:npub1app:');
  });

  test('rejects package and token identity mismatches', () => {
    const badToken = encodeToken({
      direct_https_url: 'https://tower.example.com',
      service_npub: 'npub1other',
      workspace_owner_npub: 'npub1workspace',
      app_npub: 'npub1app',
    });

    expect(() => validateAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makePackage({ connection_token: badToken }),
    })).toThrow('service npub');
  });
});
