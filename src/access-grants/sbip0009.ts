import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { finalizeEvent, nip19, nip44, verifyEvent } from 'nostr-tools';

export const SBIP0009_ACCESS_GRANT_KIND = 33357;
export const SBIP0009_ONBOARDING_PROTOCOL = 'onboarding';
export const SBIP0009_PAYLOAD_TYPE = 'flightdeck_onboarding';

export type AccessGrantStatus = 'active' | 'revoked' | 'superseded';

export interface NostrAccessGrantEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface AccessGrantPayload {
  type: typeof SBIP0009_PAYLOAD_TYPE;
  version: 1;
  protocol: typeof SBIP0009_ONBOARDING_PROTOCOL;
  status?: AccessGrantStatus;
  recipient_npub: string;
  issued_at: string;
  expires_at: string | null;
  issuer?: { npub: string; display_name?: string | null };
  service: {
    direct_https_url: string;
    service_npub?: string | null;
    relay_urls?: string[];
    name?: string | null;
    description?: string | null;
  };
  workspace: {
    owner_npub: string;
    workspace_id?: string | null;
    name?: string | null;
    description?: string | null;
  };
  app: {
    app_npub: string;
    app_pubkey: string;
  };
  agent_connect: Record<string, unknown>;
  verification?: {
    required?: boolean;
    method?: string;
  };
}

export interface DecodedAccessGrant {
  event: NostrAccessGrantEvent;
  payload: AccessGrantPayload;
  recipientNpub: string;
  recipientPubkeyHex: string;
  issuerNpub: string | null;
  serviceNpub: string | null;
  workspaceOwnerNpub: string;
  appNpub: string;
  appPubkey: string;
  grantId: string;
  dedupeKey: string;
  canonicalConnectionKey: string;
}

export interface AccessGrantProcessResult {
  ok: boolean;
  code: string;
  message: string;
  grant?: DecodedAccessGrant;
  imported?: unknown;
  verified?: unknown;
}

export interface AccessGrantSubscriptionManager {
  importAgentConnectPackage(input: {
    managedByNpub: string;
    packageJson: string | Record<string, unknown>;
    agentProfileId?: string | null;
  }): Promise<unknown>;
}

export interface ProcessAccessGrantInput {
  event: NostrAccessGrantEvent;
  recipientSecretKey: Uint8Array;
  recipientNpub: string;
  managedByNpub: string;
  subscriptionManager: AccessGrantSubscriptionManager;
  agentProfileId?: string | null;
  fetchImpl?: typeof fetch;
  now?: Date;
  processedKeys?: Set<string>;
  onPostConnectSync?: (grant: DecodedAccessGrant, imported: unknown) => Promise<unknown>;
}

function getRequiredTag(tags: string[][], name: string): string {
  const value = tags.find((tag) => tag[0] === name)?.[1]?.trim();
  if (!value) {
    throw Object.assign(new Error(`missing required tag: ${name}`), { code: `missing_tag_${name}` });
  }
  return value;
}

function getMarkedPTag(tags: string[][], marker: string): string | null {
  return tags.find((tag) => tag[0] === 'p' && tag[3] === marker)?.[1]?.trim() ?? null;
}

function getOptionalTag(tags: string[][], name: string): string | null {
  return tags.find((tag) => tag[0] === name)?.[1]?.trim() || null;
}

function assertEqual(label: string, left: string | null | undefined, right: string | null | undefined): void {
  if (!left || !right || left !== right) {
    throw Object.assign(new Error(`${label} mismatch`), { code: 'tag_payload_mismatch' });
  }
}

function decodeNpubToHex(npub: string): string {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
    throw Object.assign(new Error(`invalid npub: ${npub}`), { code: 'invalid_npub' });
  }
  return decoded.data.toLowerCase();
}

function parsePayload(value: string): AccessGrantPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw Object.assign(new Error('decrypted payload is not valid JSON'), { code: 'payload_invalid' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('decrypted payload must be an object'), { code: 'payload_invalid' });
  }
  const payload = parsed as AccessGrantPayload;
  if (payload.type !== SBIP0009_PAYLOAD_TYPE || payload.version !== 1 || payload.protocol !== SBIP0009_ONBOARDING_PROTOCOL) {
    throw Object.assign(new Error('unsupported Flight Deck onboarding payload'), { code: 'payload_invalid' });
  }
  if (payload.status && !['active', 'revoked', 'superseded'].includes(payload.status)) {
    throw Object.assign(new Error('invalid grant status'), { code: 'payload_invalid' });
  }
  if (!payload.recipient_npub || !payload.issued_at || Number.isNaN(Date.parse(payload.issued_at))) {
    throw Object.assign(new Error('payload missing recipient or issued_at'), { code: 'payload_invalid' });
  }
  if (
    !payload.service?.direct_https_url
    || !payload.service?.service_npub
    || !payload.workspace?.owner_npub
    || !payload.app?.app_npub
    || !payload.app?.app_pubkey
    || !payload.agent_connect
  ) {
    throw Object.assign(new Error('payload missing service, workspace, app, or Agent Connect package'), { code: 'payload_invalid' });
  }
  return payload;
}

export function buildAccessGrantDedupeKey(input: {
  serviceNpub: string;
  appNpub: string;
  recipientNpub: string;
}): string {
  return `flightdeck-onboarding:v1:${input.serviceNpub}:${input.appNpub}:${input.recipientNpub}`;
}

export function buildAccessGrantId(dedupeKey: string): string {
  return `sha256:${createHash('sha256').update(dedupeKey, 'utf8').digest('hex')}`;
}

export function decodeAccessGrantEvent(input: {
  event: NostrAccessGrantEvent;
  recipientSecretKey: Uint8Array;
  recipientNpub: string;
  now?: Date;
  verifySignature?: boolean;
}): DecodedAccessGrant {
  const { event, recipientSecretKey, recipientNpub } = input;
  if (event.kind !== SBIP0009_ACCESS_GRANT_KIND) {
    throw Object.assign(new Error('wrong event kind'), { code: 'wrong_kind' });
  }
  if (input.verifySignature !== false && !verifyEvent(event)) {
    throw Object.assign(new Error('invalid event signature'), { code: 'signature_invalid' });
  }

  const recipientPubkeyHex = decodeNpubToHex(recipientNpub);
  const taggedRecipientHex = getMarkedPTag(event.tags, 'recipient') ?? getRequiredTag(event.tags, 'p');
  if (taggedRecipientHex.toLowerCase() !== recipientPubkeyHex) {
    throw Object.assign(new Error('recipient p tag mismatch'), { code: 'wrong_recipient' });
  }
  const protocol = getRequiredTag(event.tags, 'protocol');
  if (protocol !== SBIP0009_ONBOARDING_PROTOCOL) {
    throw Object.assign(new Error('protocol tag must be onboarding'), { code: 'wrong_protocol' });
  }
  const appPubkey = getRequiredTag(event.tags, 'app_pub').toLowerCase();

  let plaintext: string;
  try {
    const conversationKey = nip44.v2.utils.getConversationKey(recipientSecretKey, event.pubkey);
    plaintext = nip44.v2.decrypt(event.content, conversationKey);
  } catch {
    throw Object.assign(new Error('failed to decrypt NIP-44 onboarding payload'), { code: 'decrypt_failed' });
  }

  const payload = parsePayload(plaintext);
  const issuerTag = getOptionalTag(event.tags, 'issuer');
  const serviceNpub = payload.service.service_npub;
  const workspaceOwnerNpub = payload.workspace.owner_npub;
  const appNpub = payload.app.app_npub;
  const payloadAppPubkey = payload.app.app_pubkey.toLowerCase();

  assertEqual('recipient target', recipientNpub, payload.recipient_npub);
  assertEqual('app pubkey', appPubkey, payloadAppPubkey);
  if (issuerTag && payload.issuer?.npub) assertEqual('issuer npub', issuerTag, payload.issuer.npub);
  if (appNpub) assertEqual('app pubkey from app npub', decodeNpubToHex(appNpub), appPubkey);

  const expectedDedupeKey = buildAccessGrantDedupeKey({ serviceNpub, appNpub, recipientNpub });
  const grantId = buildAccessGrantId(expectedDedupeKey);

  const expiresAt = payload.expires_at ? Date.parse(payload.expires_at) : null;
  if (expiresAt != null && Number.isFinite(expiresAt) && expiresAt <= (input.now ?? new Date()).getTime()) {
    throw Object.assign(new Error('onboarding announcement is expired'), { code: 'stale_event' });
  }

  return {
    event,
    payload,
    recipientNpub,
    recipientPubkeyHex,
    issuerNpub: payload.issuer?.npub ?? issuerTag ?? null,
    serviceNpub,
    workspaceOwnerNpub,
    appNpub,
    appPubkey,
    grantId,
    dedupeKey: expectedDedupeKey,
    canonicalConnectionKey: `${serviceNpub}:${workspaceOwnerNpub}:${appNpub}:${recipientNpub}`,
  };
}

function createNip98AuthHeader(url: string, method: string, body: unknown, secretKey: Uint8Array): string {
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];
  if (body != null && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
    tags.push(['payload', createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex')]);
  }
  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }, secretKey);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

function responseAllowsAccess(payload: unknown, grant: DecodedAccessGrant): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const body = payload as Record<string, unknown>;
  if (grant.serviceNpub && body.service_npub && body.service_npub !== grant.serviceNpub) return false;
  if (body.workspace_owner_npub && body.workspace_owner_npub !== grant.workspaceOwnerNpub) return false;
  return body.allowed === true || body.active === true || body.verified === true || body.current_member === true;
}

function fallbackPayloadAllowsAccess(payload: unknown, grant: DecodedAccessGrant): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const body = payload as Record<string, unknown>;
  const rows = Array.isArray(body.workspaces)
    ? body.workspaces
    : Array.isArray(body.groups)
      ? body.groups
      : [];
  return rows.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const row = entry as Record<string, unknown>;
    return row.workspace_owner_npub === grant.workspaceOwnerNpub
      || row.owner_npub === grant.workspaceOwnerNpub
      || (grant.serviceNpub ? row.service_npub === grant.serviceNpub : false);
  });
}

export async function verifyAccessGrantWithTower(input: {
  grant: DecodedAccessGrant;
  recipientSecretKey: Uint8Array;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = input.grant.payload.service.direct_https_url.replace(/\/+$/, '');
  const body = {
    grant_id: input.grant.grantId,
    dedupe_key: input.grant.dedupeKey,
    recipient_npub: input.grant.recipientNpub,
    service_npub: input.grant.serviceNpub,
    workspace_owner_npub: input.grant.workspaceOwnerNpub,
    app_npub: input.grant.appNpub,
    app_pubkey: input.grant.appPubkey,
    event_id: input.grant.event.id,
  };
  const verifyUrl = `${baseUrl}/api/v4/access-grants/verify`;
  const verifyResponse = await fetchImpl(verifyUrl, {
    method: 'POST',
    headers: {
      Authorization: createNip98AuthHeader(verifyUrl, 'POST', body, input.recipientSecretKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (verifyResponse.ok) {
    const payload = await verifyResponse.json().catch(() => null);
    if (responseAllowsAccess(payload, input.grant)) return payload;
    throw Object.assign(new Error('Tower verification did not confirm current access'), { code: 'tower_verify_failed' });
  }
  if (!['404', '405', '501'].includes(String(verifyResponse.status))) {
    throw Object.assign(new Error(`Tower verification failed with HTTP ${verifyResponse.status}`), { code: 'tower_verify_failed' });
  }

  for (const path of [
    `/api/v4/workspaces?npub=${encodeURIComponent(input.grant.recipientNpub)}`,
    `/api/v4/groups?npub=${encodeURIComponent(input.grant.recipientNpub)}`,
  ]) {
    const url = `${baseUrl}${path}`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: createNip98AuthHeader(url, 'GET', null, input.recipientSecretKey),
      },
    });
    if (!response.ok) continue;
    const payload = await response.json().catch(() => null);
    if (fallbackPayloadAllowsAccess(payload, input.grant)) return payload;
  }
  throw Object.assign(new Error('Tower fallback verification did not confirm current access'), { code: 'tower_verify_failed' });
}

export async function processAccessGrantEvent(input: ProcessAccessGrantInput): Promise<AccessGrantProcessResult> {
  let grant: DecodedAccessGrant;
  try {
    grant = decodeAccessGrantEvent({
      event: input.event,
      recipientSecretKey: input.recipientSecretKey,
      recipientNpub: input.recipientNpub,
      now: input.now,
    });
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'grant_invalid';
    return { ok: false, code, message: (error as Error).message };
  }

  if (grant.payload.status !== 'active') {
    return { ok: false, code: `grant_${grant.payload.status}`, message: `Grant status is ${grant.payload.status}.`, grant };
  }

  const importKey = `${grant.grantId}:${grant.canonicalConnectionKey}`;
  if (input.processedKeys?.has(importKey)) {
    return { ok: true, code: 'duplicate_skipped', message: 'Onboarding event already processed in this runtime.', grant };
  }

  let verified: unknown;
  try {
    verified = await verifyAccessGrantWithTower({
      grant,
      recipientSecretKey: input.recipientSecretKey,
      fetchImpl: input.fetchImpl,
    });
  } catch (error) {
    return { ok: false, code: 'tower_verify_failed', message: (error as Error).message, grant };
  }

  try {
    const imported = await input.subscriptionManager.importAgentConnectPackage({
      managedByNpub: input.managedByNpub,
      agentProfileId: input.agentProfileId ?? null,
      packageJson: grant.payload.agent_connect,
    });
    await input.onPostConnectSync?.(grant, imported);
    input.processedKeys?.add(importKey);
    return { ok: true, code: 'imported', message: 'Onboarding event verified and imported.', grant, imported, verified };
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'import_failed';
    return { ok: false, code, message: (error as Error).message, grant, verified };
  }
}
