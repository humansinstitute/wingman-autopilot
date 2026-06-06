import { Buffer } from 'node:buffer';

import { describe, expect, test } from 'bun:test';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44 } from 'nostr-tools';

import {
  buildAccessGrantDedupeKey,
  buildAccessGrantId,
  decodeAccessGrantEvent,
  processAccessGrantEvent,
  SBIP0009_ACCESS_GRANT_KIND,
  SBIP0009_ONBOARDING_PROTOCOL,
  SBIP0009_PAYLOAD_TYPE,
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
  const workspaceOwner = makeIdentity();
  const app = makeIdentity();
  const dedupeKey = buildAccessGrantDedupeKey({
    serviceNpub: service.npub,
    appNpub: app.npub,
    recipientNpub: recipient.npub,
  });
  const grantId = buildAccessGrantId(dedupeKey);
  const connectionToken = encodeToken({
    type: 'superbased_connection',
    direct_https_url: 'https://tower.example.com',
    service_npub: service.npub,
    workspace_owner_npub: workspaceOwner.npub,
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
    workspace: { owner_npub: workspaceOwner.npub },
    app: { app_npub: app.npub, app_pubkey: app.pubkey },
    connection_token: connectionToken,
    capabilities: ['task_dispatch'],
  };
  const payload = {
    type: SBIP0009_PAYLOAD_TYPE,
    version: 1,
    protocol: SBIP0009_ONBOARDING_PROTOCOL,
    status: 'active',
    recipient_npub: recipient.npub,
    issued_at: '2026-06-06T00:00:00.000Z',
    expires_at: null,
    reason: 'workspace_member_added',
    issuer: { npub: issuer.npub, display_name: null },
    service: {
      direct_https_url: 'https://tower.example.com',
      service_npub: service.npub,
      relay_urls: ['wss://relay.example'],
    },
    workspace: {
      owner_npub: workspaceOwner.npub,
      workspace_id: null,
    },
    app: { app_npub: app.npub, app_pubkey: app.pubkey },
    agent_connect: agentConnectPackage,
    verification: { required: true, method: 'tower_nip98_current_membership' },
    ...overrides.payload,
  };
  const conversationKey = nip44.v2.utils.getConversationKey(publisher.secret, recipient.pubkey);
  const content = nip44.v2.encrypt(JSON.stringify(payload), conversationKey);
  const tags = overrides.tags ?? [
    ['p', recipient.pubkey],
    ['app_pub', app.pubkey],
    ['protocol', SBIP0009_ONBOARDING_PROTOCOL],
    ['issuer', issuer.npub],
    ['alt', 'Wingman Flight Deck onboarding announcement'],
  ];
  const event = finalizeEvent({
    kind: SBIP0009_ACCESS_GRANT_KIND,
    created_at: Math.floor(Date.parse('2026-06-06T00:00:00.000Z') / 1000),
    tags,
    content,
  }, publisher.secret);
  return { event, recipient, publisher, payload, service, workspaceOwner, app, grantId };
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
    expect(grant.payload.agent_connect.kind).toBe('coworker_agent_connect');
    expect(grant.workspaceOwnerNpub).toBe(fixture.workspaceOwner.npub);
    expect(grant.appPubkey).toBe(fixture.app.pubkey);
  });

  test('rejects public app_pub and decrypted payload mismatches', () => {
    const fixture = makeGrantEvent({
      payload: {
        app: { app_npub: makeIdentity().npub, app_pubkey: makeIdentity().pubkey },
      },
    });
    expect(() => decodeAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
    })).toThrow(/app pubkey mismatch|app pubkey from app npub mismatch/);
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
    const input = {
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: fixture.recipient.npub,
      processedKeys,
      subscriptionManager: {
        importAgentConnectPackage: async () => {
          imports += 1;
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
    expect(syncs).toBe(1);
  });
});
