import { Buffer } from 'node:buffer';

import { describe, expect, test } from 'bun:test';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44 } from 'nostr-tools';

import {
  SBIP0009_APP_NAMESPACE,
  buildAccessGrantDedupeKey,
  buildAccessGrantId,
  decodeAccessGrantEvent,
  processAccessGrantEvent,
  SBIP0009_ACCESS_GRANT_KIND,
  SBIP0009_PAYLOAD_KIND,
} from './sbip0009';

function makeIdentity() {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  return { secret, pubkey, npub: nip19.npubEncode(pubkey) };
}

function encodeToken(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function makeGrantEvent(overrides: {
  payload?: Record<string, unknown>;
  tags?: string[][];
  recipient?: ReturnType<typeof makeIdentity>;
  publisher?: ReturnType<typeof makeIdentity>;
} = {}) {
  const recipient = overrides.recipient ?? makeIdentity();
  const publisher = overrides.publisher ?? makeIdentity();
  const issuer = makeIdentity();
  const service = makeIdentity();
  const workspaceService = makeIdentity();
  const workspaceOwner = makeIdentity();
  const app = makeIdentity();
  const dedupeKey = buildAccessGrantDedupeKey({
    serviceNpub: service.npub,
    workspaceServiceNpub: workspaceService.npub,
    appNpub: app.npub,
    recipientNpub: recipient.npub,
  });
  const grantId = buildAccessGrantId(dedupeKey);
  const connectionToken = encodeToken({
    type: 'superbased_connection',
    direct_https_url: 'https://tower.example.com',
    service_npub: service.npub,
    workspace_owner_npub: workspaceOwner.npub,
    workspace_service_npub: workspaceService.npub,
    app_npub: app.npub,
  });
  const agentConnectPackage = {
    kind: 'coworker_agent_connect',
    version: 5,
    generated_at: '2026-06-06T00:00:00.000Z',
    service: {
      direct_https_url: 'https://tower.example.com',
      service_npub: service.npub,
      relay_urls: ['wss://relay.example'],
    },
    workspace: {
      owner_npub: workspaceOwner.npub,
      workspace_service_npub: workspaceService.npub,
      workspace_id: null,
    },
    app: { app_npub: app.npub, app_pubkey: app.pubkey },
    connection_token: connectionToken,
    capabilities: ['task_dispatch'],
  };
  const payload = {
    kind: SBIP0009_PAYLOAD_KIND,
    version: 1,
    status: 'active',
    grant_id: grantId,
    dedupe_key: dedupeKey,
    issued_at: '2026-06-06T00:00:00.000Z',
    expires_at: null,
    reason: 'workspace_member_added',
    issuer: { npub: issuer.npub, display_name: null },
    recipient: { npub: recipient.npub },
    service: {
      direct_https_url: 'https://tower.example.com',
      service_npub: service.npub,
      relay_urls: ['wss://relay.example'],
    },
    workspace: {
      owner_npub: workspaceOwner.npub,
      workspace_service_npub: workspaceService.npub,
      workspace_id: null,
    },
    app: { app_npub: app.npub, namespace: SBIP0009_APP_NAMESPACE },
    agent_connect_package: agentConnectPackage,
    verification: { required: true, method: 'tower_nip98_current_membership' },
    ...overrides.payload,
  };
  const conversationKey = nip44.v2.utils.getConversationKey(publisher.secret, recipient.pubkey);
  const content = nip44.v2.encrypt(JSON.stringify(payload), conversationKey);
  const tags = overrides.tags ?? [
    ['d', dedupeKey],
    ['p', recipient.pubkey, '', 'recipient'],
    ['app', SBIP0009_APP_NAMESPACE],
    ['app_npub', app.npub],
    ['service_npub', service.npub],
    ['workspace_service_npub', workspaceService.npub],
    ['workspace_owner_npub', workspaceOwner.npub],
    ['recipient', recipient.npub],
    ['issuer', issuer.npub],
    ['grant', grantId],
    ['alt', 'Wingman Flight Deck access grant announcement'],
  ];
  const event = finalizeEvent({
    kind: SBIP0009_ACCESS_GRANT_KIND,
    created_at: Math.floor(Date.parse('2026-06-06T00:00:00.000Z') / 1000),
    tags,
    content,
  }, publisher.secret);
  return { event, recipient, publisher, payload, service, workspaceService, workspaceOwner, app, grantId };
}

describe('Flight Deck 33357 onboarding validation', () => {
  test('validates and decrypts a canonical signed onboarding event', () => {
    const fixture = makeGrantEvent();
    const grant = decodeAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      now: new Date('2026-06-06T00:00:01.000Z'),
    });
    expect(grant.grantId).toBe(fixture.grantId);
    expect(grant.payload.agent_connect_package.kind).toBe('coworker_agent_connect');
    expect(grant.workspaceOwnerNpub).toBe(fixture.workspaceOwner.npub);
    expect(grant.workspaceServiceNpub).toBe(fixture.workspaceService.npub);
  });

  test('rejects public tags and decrypted payload mismatches', () => {
    const fixture = makeGrantEvent({
      payload: {
        app: { app_npub: makeIdentity().npub, namespace: SBIP0009_APP_NAMESPACE },
      },
    });
    expect(() => decodeAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
    })).toThrow(/app npub mismatch|dedupe key mismatch/);
  });

  test('reports decrypt failure before import', async () => {
    const fixture = makeGrantEvent();
    const wrongRecipient = makeIdentity();
    const result = await processAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: wrongRecipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: fixture.recipient.npub,
      subscriptionManager: { importAgentConnectPackage: async () => ({}) },
      fetchImpl: async () => new Response(JSON.stringify({ allowed: true }), { status: 200 }),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('decrypt_failed');
  });

  test('blocks import when Tower verification fails', async () => {
    const fixture = makeGrantEvent();
    let imports = 0;
    const result = await processAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: fixture.recipient.npub,
      subscriptionManager: {
        importAgentConnectPackage: async () => {
          imports += 1;
          return {};
        },
      },
      fetchImpl: async () => new Response(JSON.stringify({ allowed: false }), { status: 200 }),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('tower_verify_failed');
    expect(imports).toBe(0);
  });

  test('imports only once for repeated verified relay events and runs post-connect sync', async () => {
    const fixture = makeGrantEvent();
    const processedKeys = new Set<string>();
    let imports = 0;
    let syncs = 0;
    let importSource = '';
    const input = {
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: fixture.recipient.npub,
      processedKeys,
      subscriptionManager: {
        importAgentConnectPackage: async (input) => {
          imports += 1;
          importSource = input.onboardingSource ?? '';
          return { subscription: { subscriptionId: 'sub-1' } };
        },
      },
      fetchImpl: async () => new Response(JSON.stringify({
        allowed: true,
        service_npub: fixture.service.npub,
        workspace_owner_npub: fixture.workspaceOwner.npub,
      }), { status: 200 }),
      onPostConnectSync: async () => {
        syncs += 1;
      },
    };
    const first = await processAccessGrantEvent(input);
    const second = await processAccessGrantEvent(input);
    expect(first.ok).toBe(true);
    expect(first.code).toBe('imported');
    expect(second.ok).toBe(true);
    expect(second.code).toBe('duplicate_skipped');
    expect(imports).toBe(1);
    expect(importSource).toBe('nostr_33357');
    expect(syncs).toBe(1);
  });

  test('confirms revoked onboarding with Tower before handling local removal', async () => {
    const fixture = makeGrantEvent({
      payload: {
        action: 'deleted',
        status: 'deleted',
        agent_connect_package: undefined,
        revocation: {
          reason: 'workspace_deleted',
          revoked_at: '2026-06-06T00:00:00.000Z',
          source: 'tower',
        },
      },
    });
    let imports = 0;
    let handledVerification = '';
    let revocationSyncs = 0;
    const result = await processAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: fixture.recipient.npub,
      subscriptionManager: {
        importAgentConnectPackage: async () => {
          imports += 1;
          return {};
        },
        handleAccessGrantRevocation: async (input) => {
          handledVerification = input.verification.towerResult;
          return { updatedSubscriptions: ['sub-1'] };
        },
      },
      fetchImpl: async () => new Response('', { status: 410 }),
      onPostRevocationSync: async () => {
        revocationSyncs += 1;
      },
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe('revocation_confirmed');
    expect(handledVerification).toBe('workspace_deleted');
    expect(imports).toBe(0);
    expect(revocationSyncs).toBe(1);
  });

  test('keeps revoked onboarding active when Tower still confirms access', async () => {
    const fixture = makeGrantEvent({
      payload: {
        action: 'revoked',
        status: 'revoked',
        agent_connect_package: undefined,
      },
    });
    let imports = 0;
    let handledConfirmed = true;
    let revocationSyncs = 0;
    const result = await processAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: fixture.recipient.npub,
      subscriptionManager: {
        importAgentConnectPackage: async () => {
          imports += 1;
          return {};
        },
        handleAccessGrantRevocation: async (input) => {
          handledConfirmed = input.verification.confirmed;
          return { diagnostic: 'recorded' };
        },
      },
      fetchImpl: async () => new Response(JSON.stringify({
        allowed: true,
        service_npub: fixture.service.npub,
        workspace_owner_npub: fixture.workspaceOwner.npub,
      }), { status: 200 }),
      onPostRevocationSync: async () => {
        revocationSyncs += 1;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('revocation_unconfirmed_access_active');
    expect(handledConfirmed).toBe(false);
    expect(imports).toBe(0);
    expect(revocationSyncs).toBe(0);
  });

  test('rejects mismatched Agent Connect packages after Tower verification and before import', async () => {
    const otherWorkspace = makeIdentity();
    const fixture = makeGrantEvent({
      payload: {
        agent_connect_package: {
          kind: 'coworker_agent_connect',
          version: 5,
          generated_at: '2026-06-06T00:00:00.000Z',
          service: { direct_https_url: 'https://tower.example.com', service_npub: null },
          workspace: { owner_npub: otherWorkspace.npub },
          app: { app_npub: makeIdentity().npub, namespace: SBIP0009_APP_NAMESPACE },
          connection_token: encodeToken({
            type: 'superbased_connection',
            direct_https_url: 'https://tower.example.com',
            service_npub: makeIdentity().npub,
            workspace_owner_npub: otherWorkspace.npub,
            app_npub: makeIdentity().npub,
          }),
        },
      },
    });
    let imports = 0;
    let syncs = 0;
    const result = await processAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: fixture.recipient.npub,
      subscriptionManager: {
        importAgentConnectPackage: async () => {
          imports += 1;
          return {};
        },
      },
      fetchImpl: async () => new Response(JSON.stringify({
        allowed: true,
        service_npub: fixture.service.npub,
        workspace_service_npub: fixture.workspaceService.npub,
        workspace_owner_npub: fixture.workspaceOwner.npub,
      }), { status: 200 }),
      onPostConnectSync: async () => {
        syncs += 1;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('agent_connect_mismatch');
    expect(imports).toBe(0);
    expect(syncs).toBe(0);
  });

  test('returns stable stale and inactive diagnostics without import or sync', async () => {
    const cases = [
      { name: 'expired', overrides: { expires_at: '2026-06-05T00:00:00.000Z' }, code: 'stale_event' },
      { name: 'superseded', overrides: { status: 'superseded' }, code: 'grant_superseded' },
    ];
    for (const entry of cases) {
      const fixture = makeGrantEvent({ payload: entry.overrides });
      let imports = 0;
      let syncs = 0;
      let verifies = 0;
      const result = await processAccessGrantEvent({
        event: fixture.event,
        recipientSecretKey: fixture.recipient.secret,
        recipientNpub: fixture.recipient.npub,
        managedByNpub: fixture.recipient.npub,
        subscriptionManager: {
          importAgentConnectPackage: async () => {
            imports += 1;
            return {};
          },
        },
        fetchImpl: async () => {
          verifies += 1;
          return new Response(JSON.stringify({ allowed: true }), { status: 200 });
        },
        now: new Date('2026-06-06T00:00:01.000Z'),
        onPostConnectSync: async () => {
          syncs += 1;
        },
      });
      expect(result.code).toBe(entry.code);
      expect(result.ok).toBe(false);
      expect(imports).toBe(0);
      expect(syncs).toBe(0);
      expect(verifies).toBe(0);
    }
  });
});
