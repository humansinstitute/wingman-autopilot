import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { finalizeEvent, nip19, nip44, verifyEvent } from 'nostr-tools';

export const SBIP0009_ACCESS_GRANT_KIND = 33357;
export const SBIP0009_APP_NAMESPACE = 'wingman-flight-deck';
export const SBIP0009_PAYLOAD_KIND = 'wingman_flightdeck_access_grant';
export const FLIGHTDECK_ONBOARDING_PAYLOAD_TYPE = 'flightdeck_onboarding';

export type AccessGrantAction = 'grant' | 'revoked' | 'deleted';
export type AccessGrantStatus = 'active' | 'revoked' | 'deleted' | 'superseded';

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
  kind?: typeof SBIP0009_PAYLOAD_KIND;
  type?: typeof FLIGHTDECK_ONBOARDING_PAYLOAD_TYPE;
  version: 1;
  protocol?: 'onboarding';
  action: AccessGrantAction;
  status: AccessGrantStatus;
  grant_id?: string;
  dedupe_key?: string;
  issued_at: string;
  issued_by_npub?: string;
  recipient_npub?: string;
  expires_at?: string | null;
  issuer?: { npub: string; display_name?: string | null };
  recipient?: { npub: string };
  service: {
    direct_https_url: string;
    service_npub: string;
    relay_urls?: string[];
    name?: string | null;
    description?: string | null;
  };
  workspace: {
    owner_npub: string;
    workspace_service_npub: string;
    workspace_id?: string | null;
    name?: string | null;
    description?: string | null;
  };
  app: {
    app_npub?: string;
    app_pubkey?: string;
    namespace?: typeof SBIP0009_APP_NAMESPACE | 'flightdeck_pg';
  };
  revocation?: {
    reason?: string | null;
    revoked_at?: string | null;
    source?: string | null;
  };
  grant?: {
    grant_id?: string | null;
    reason?: string | null;
  };
  agent_connect_package?: Record<string, unknown>;
  agent_connect?: Record<string, unknown>;
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
  workspaceServiceNpub: string;
  workspaceOwnerNpub: string;
  appNpub: string;
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
    onboardingSource?: 'manual' | 'agent_connect_import' | 'nostr_33357';
  }): Promise<unknown>;
  handleAccessGrantRevocation?(input: {
    managedByNpub: string;
    agentProfileId?: string | null;
    grant: DecodedAccessGrant;
    verification: TowerRevocationVerificationResult;
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
  onPostRevocationSync?: (
    grant: DecodedAccessGrant,
    handled: unknown,
    verification: TowerRevocationVerificationResult,
  ) => Promise<unknown>;
}

export interface TowerRevocationVerificationResult {
  confirmed: boolean;
  towerResult: 'access_active' | 'workspace_deleted' | 'workspace_not_found' | 'membership_revoked' | 'access_denied' | 'unconfirmed';
  checkedAt: string;
  message: string;
  payload?: unknown;
}

function getRequiredTag(tags: string[][], name: string): string {
  const value = tags.find((tag) => tag[0] === name)?.[1]?.trim();
  if (!value) {
    throw Object.assign(new Error(`missing required tag: ${name}`), { code: `missing_tag_${name}` });
  }
  return value;
}

function getOptionalTag(tags: string[][], name: string): string | null {
  return tags.find((tag) => tag[0] === name)?.[1]?.trim() || null;
}

function getMarkedPTag(tags: string[][], marker: string): string | null {
  return tags.find((tag) => tag[0] === 'p' && tag[3] === marker)?.[1]?.trim() ?? null;
}

function assertEqual(label: string, left: string | null | undefined, right: string | null | undefined): void {
  if (!left || !right || left !== right) {
    throw Object.assign(new Error(`${label} mismatch`), { code: 'tag_payload_mismatch' });
  }
}

function assertEqualWhenPresent(label: string, left: string | null | undefined, right: string | null | undefined): void {
  if (left && right && left !== right) {
    throw Object.assign(new Error(`${label} mismatch`), { code: 'tag_payload_mismatch' });
  }
}

function assertAgentConnectEqual(label: string, left: string | null | undefined, right: string | null | undefined, options: { url?: boolean } = {}): void {
  const normalisedLeft = options.url ? normaliseUrl(left) : left;
  const normalisedRight = options.url ? normaliseUrl(right) : right;
  if (!normalisedLeft || !normalisedRight || normalisedLeft !== normalisedRight) {
    throw Object.assign(new Error(`Agent Connect ${label} mismatch`), { code: 'agent_connect_mismatch' });
  }
}

function assertAgentConnectEqualWhenPresent(label: string, left: string | null | undefined, right: string | null | undefined, options: { url?: boolean } = {}): void {
  if (!left) {
    return;
  }
  assertAgentConnectEqual(label, left, right, options);
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normaliseUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.replace(/\/+$/, '');
  }
}

function decodeNpubToHex(npub: string): string {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
    throw Object.assign(new Error(`invalid npub: ${npub}`), { code: 'invalid_npub' });
  }
  return decoded.data.toLowerCase();
}

function encodeHexToNpub(pubkeyHex: string | null | undefined): string | null {
  const normalized = pubkeyHex?.trim().toLowerCase();
  if (!normalized || !/^[0-9a-f]{64}$/.test(normalized)) {
    return null;
  }
  return nip19.npubEncode(normalized);
}

function normalizePayloadAction(parsed: Record<string, unknown>): AccessGrantAction {
  const action = getString(parsed.action);
  if (action === 'grant' || action === 'revoked' || action === 'deleted') {
    return action;
  }
  const status = getString(parsed.status);
  if (status === 'revoked') return 'revoked';
  if (status === 'deleted') return 'deleted';
  return 'grant';
}

function normalizePayloadStatus(parsed: Record<string, unknown>, action: AccessGrantAction): AccessGrantStatus {
  const status = getString(parsed.status);
  if (status === 'active' || status === 'revoked' || status === 'deleted' || status === 'superseded') {
    return status;
  }
  if (action === 'grant') return 'active';
  return action;
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
  const object = parsed as Record<string, unknown>;
  const payloadKind = getString(object.kind);
  const payloadType = getString(object.type);
  if (payloadKind !== SBIP0009_PAYLOAD_KIND && payloadType !== FLIGHTDECK_ONBOARDING_PAYLOAD_TYPE) {
    throw Object.assign(new Error('unsupported SBIP-0009 access grant payload'), { code: 'payload_invalid' });
  }
  const payload = object as AccessGrantPayload;
  payload.action = normalizePayloadAction(object);
  payload.status = normalizePayloadStatus(object, payload.action);
  if (!['active', 'revoked', 'deleted', 'superseded'].includes(payload.status)) {
    throw Object.assign(new Error('invalid grant status'), { code: 'payload_invalid' });
  }
  if (payload.protocol && payload.protocol !== 'onboarding') {
    throw Object.assign(new Error('invalid onboarding protocol'), { code: 'payload_invalid' });
  }
  const recipientNpub = payload.recipient?.npub ?? payload.recipient_npub;
  const issuerNpub = payload.issuer?.npub ?? payload.issued_by_npub;
  const appNpub = payload.app?.app_npub ?? encodeHexToNpub(payload.app?.app_pubkey);
  const agentConnectPackage = getObject(payload.agent_connect_package) ?? getObject(payload.agent_connect);
  if (agentConnectPackage) {
    payload.agent_connect_package = agentConnectPackage;
  }
  if (
    !recipientNpub
    || !issuerNpub
    || !payload.issued_at
    || Number.isNaN(Date.parse(payload.issued_at))
    || !payload.service?.direct_https_url
    || !payload.service?.service_npub
    || !payload.workspace?.owner_npub
    || !payload.workspace?.workspace_service_npub
    || !appNpub
  ) {
    throw Object.assign(new Error('payload missing required SBIP-0009 fields'), { code: 'payload_invalid' });
  }
  if (payload.action === 'grant' && (!payload.grant_id || !payload.dedupe_key || !payload.agent_connect_package)) {
    throw Object.assign(new Error('active grant payload missing required import fields'), { code: 'payload_invalid' });
  }
  if (payload.app?.namespace && ![SBIP0009_APP_NAMESPACE, 'flightdeck_pg'].includes(payload.app.namespace)) {
    throw Object.assign(new Error('unsupported onboarding app namespace'), { code: 'payload_invalid' });
  }
  payload.recipient = payload.recipient ?? { npub: recipientNpub };
  payload.issuer = payload.issuer ?? { npub: issuerNpub };
  payload.app.app_npub = appNpub;
  return payload;
}

export function buildAccessGrantDedupeKey(input: {
  serviceNpub: string;
  workspaceServiceNpub: string;
  appNpub: string;
  recipientNpub: string;
}): string {
  return `wingman-access-grant:v1:${input.serviceNpub}:${input.workspaceServiceNpub}:${input.appNpub}:${input.recipientNpub}`;
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
  let plaintext: string;
  try {
    const conversationKey = nip44.v2.utils.getConversationKey(recipientSecretKey, event.pubkey);
    plaintext = nip44.v2.decrypt(event.content, conversationKey);
  } catch {
    throw Object.assign(new Error('failed to decrypt NIP-44 onboarding payload'), { code: 'decrypt_failed' });
  }

  const payload = parsePayload(plaintext);
  const d = getOptionalTag(event.tags, 'd');
  const app = getOptionalTag(event.tags, 'app');
  const appPubkey = getOptionalTag(event.tags, 'app_pub') ?? payload.app.app_pubkey ?? null;
  const appNpub = getOptionalTag(event.tags, 'app_npub') ?? payload.app.app_npub ?? encodeHexToNpub(appPubkey);
  const taggedServiceNpub = getOptionalTag(event.tags, 'service_npub') ?? payload.service.service_npub;
  const workspaceServiceNpub = getOptionalTag(event.tags, 'workspace_service_npub') ?? payload.workspace.workspace_service_npub;
  const workspaceOwnerNpub = getOptionalTag(event.tags, 'workspace_owner_npub') ?? payload.workspace.owner_npub;
  const recipientTag = getOptionalTag(event.tags, 'recipient') ?? payload.recipient?.npub ?? payload.recipient_npub ?? null;
  const issuerTag = getOptionalTag(event.tags, 'issuer') ?? payload.issuer?.npub ?? payload.issued_by_npub ?? null;
  const grantTag = getOptionalTag(event.tags, 'grant') ?? payload.grant_id ?? payload.grant?.grant_id ?? null;

  assertEqualWhenPresent('app namespace', app, SBIP0009_APP_NAMESPACE);
  assertEqualWhenPresent('d tag', d, payload.dedupe_key);
  assertEqualWhenPresent('grant id', grantTag, payload.grant_id ?? payload.grant?.grant_id ?? null);
  assertEqualWhenPresent('recipient npub', recipientTag, payload.recipient?.npub ?? payload.recipient_npub);
  assertEqualWhenPresent('issuer npub', issuerTag, payload.issuer?.npub ?? payload.issued_by_npub);
  assertEqualWhenPresent('service npub', taggedServiceNpub, payload.service.service_npub);
  assertEqualWhenPresent('workspace service npub', workspaceServiceNpub, payload.workspace.workspace_service_npub);
  assertEqualWhenPresent('workspace owner npub', workspaceOwnerNpub, payload.workspace.owner_npub);
  assertEqualWhenPresent('app npub', appNpub, payload.app.app_npub ?? encodeHexToNpub(payload.app.app_pubkey));
  assertEqual('recipient target', recipientNpub, payload.recipient.npub);

  if (!appNpub || !taggedServiceNpub || !workspaceServiceNpub || !workspaceOwnerNpub || !issuerTag) {
    throw Object.assign(new Error('payload missing required workspace identity fields'), { code: 'payload_invalid' });
  }

  const serviceNpub = taggedServiceNpub;
  const expectedDedupeKey = buildAccessGrantDedupeKey({ serviceNpub, workspaceServiceNpub, appNpub, recipientNpub });
  const dedupeKey = payload.dedupe_key ?? d ?? expectedDedupeKey;
  const grantId = payload.grant_id ?? grantTag ?? buildAccessGrantId(expectedDedupeKey);
  assertEqualWhenPresent('dedupe key', expectedDedupeKey, dedupeKey);
  if (payload.action === 'grant') {
    assertEqual('dedupe key', expectedDedupeKey, d);
    assertEqual('grant id', buildAccessGrantId(expectedDedupeKey), grantTag);
  }

  const expiresAt = payload.expires_at ? Date.parse(payload.expires_at) : null;
  if (payload.action === 'grant' && expiresAt != null && Number.isFinite(expiresAt) && expiresAt <= (input.now ?? new Date()).getTime()) {
    throw Object.assign(new Error('onboarding announcement is expired'), { code: 'stale_event' });
  }

  return {
    event,
    payload,
    recipientNpub,
    recipientPubkeyHex,
    issuerNpub: issuerTag,
    serviceNpub,
    workspaceServiceNpub,
    workspaceOwnerNpub,
    appNpub,
    grantId,
    dedupeKey,
    canonicalConnectionKey: `${serviceNpub}:${workspaceOwnerNpub}:${appNpub}:${recipientNpub}`,
  };
}

function decodeConnectionToken(token: string): Record<string, unknown> {
  const normalised = token.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised.padEnd(Math.ceil(normalised.length / 4) * 4, '=');
  try {
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as unknown;
    const object = getObject(parsed);
    if (!object) throw new Error('connection_token must decode to a JSON object.');
    return object;
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error('connection_token does not decode to valid JSON.'), {
      code: 'agent_connect_mismatch',
    });
  }
}

function assertAgentConnectMatchesGrant(grant: DecodedAccessGrant): void {
  const pkg = getObject(grant.payload.agent_connect_package);
  const service = getObject(pkg?.service);
  const workspace = getObject(pkg?.workspace);
  const app = getObject(pkg?.app);
  assertAgentConnectEqual('backend URL', getString(service?.direct_https_url), grant.payload.service.direct_https_url, { url: true });
  assertAgentConnectEqual('service npub', getString(service?.service_npub), grant.serviceNpub);
  assertAgentConnectEqual('workspace owner', getString(workspace?.owner_npub), grant.workspaceOwnerNpub);
  assertAgentConnectEqualWhenPresent('workspace id', getString(workspace?.workspace_id), getString(grant.payload.workspace.workspace_id));
  assertAgentConnectEqualWhenPresent('workspace service npub', getString(workspace?.workspace_service_npub), grant.workspaceServiceNpub);
  assertAgentConnectEqual('app npub', getString(app?.app_npub), grant.appNpub);
  const packageNamespace = getString(app?.namespace) ?? getString(app?.schema_namespace);
  if (packageNamespace) {
    assertAgentConnectEqual('app namespace', packageNamespace, grant.payload.app.namespace);
  }
  const token = decodeConnectionToken(getString(pkg?.connection_token) ?? '');
  assertAgentConnectEqual('token backend URL', getString(token.direct_https_url), grant.payload.service.direct_https_url, { url: true });
  assertAgentConnectEqual('token service npub', getString(token.service_npub) ?? getString(token.server_npub), grant.serviceNpub);
  assertAgentConnectEqual('token workspace owner', getString(token.workspace_owner_npub), grant.workspaceOwnerNpub);
  assertAgentConnectEqualWhenPresent('token workspace id', getString(token.workspace_id), getString(grant.payload.workspace.workspace_id));
  assertAgentConnectEqualWhenPresent('token workspace service npub', getString(token.workspace_service_npub), grant.workspaceServiceNpub);
  assertAgentConnectEqual('token app npub', getString(token.app_npub), grant.appNpub);
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
  if (body.workspace_service_npub && body.workspace_service_npub !== grant.workspaceServiceNpub) return false;
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
      || row.workspace_service_npub === grant.workspaceServiceNpub
      || (grant.serviceNpub ? row.service_npub === grant.serviceNpub : false);
  });
}

function payloadConfirmsRevocation(payload: unknown): TowerRevocationVerificationResult['towerResult'] | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;
  const status = getString(body.status) ?? getString(body.state);
  const reason = getString(body.reason) ?? getString(body.detail_code) ?? getString(body.code);
  if (
    body.deleted === true
    || body.tombstoned === true
    || status === 'deleted'
    || status === 'tombstoned'
    || reason === 'workspace_deleted'
    || reason === 'workspace_tombstoned'
  ) {
    return 'workspace_deleted';
  }
  if (
    body.allowed === false
    || body.active === false
    || body.verified === false
    || body.current_member === false
    || body.member === false
    || status === 'revoked'
    || status === 'inactive'
    || reason === 'workspace_access_revoked'
    || reason === 'workspace_membership_revoked'
    || reason === 'not_workspace_member'
  ) {
    return 'membership_revoked';
  }
  return null;
}

function buildRevocationVerification(input: {
  confirmed: boolean;
  towerResult: TowerRevocationVerificationResult['towerResult'];
  message: string;
  payload?: unknown;
}): TowerRevocationVerificationResult {
  return {
    confirmed: input.confirmed,
    towerResult: input.towerResult,
    checkedAt: new Date().toISOString(),
    message: input.message,
    payload: input.payload,
  };
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
    workspace_service_npub: input.grant.workspaceServiceNpub,
    workspace_owner_npub: input.grant.workspaceOwnerNpub,
    app_npub: input.grant.appNpub,
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

export async function verifyAccessGrantRevocationWithTower(input: {
  grant: DecodedAccessGrant;
  recipientSecretKey: Uint8Array;
  fetchImpl?: typeof fetch;
}): Promise<TowerRevocationVerificationResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = input.grant.payload.service.direct_https_url.replace(/\/+$/, '');
  const body = {
    grant_id: input.grant.grantId,
    dedupe_key: input.grant.dedupeKey,
    recipient_npub: input.grant.recipientNpub,
    service_npub: input.grant.serviceNpub,
    workspace_id: input.grant.payload.workspace.workspace_id ?? null,
    workspace_service_npub: input.grant.workspaceServiceNpub,
    workspace_owner_npub: input.grant.workspaceOwnerNpub,
    app_npub: input.grant.appNpub,
    event_id: input.grant.event.id,
    action: input.grant.payload.action,
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
    if (responseAllowsAccess(payload, input.grant)) {
      return buildRevocationVerification({
        confirmed: false,
        towerResult: 'access_active',
        message: 'Tower still confirms current workspace access.',
        payload,
      });
    }
    const confirmedResult = payloadConfirmsRevocation(payload);
    if (confirmedResult) {
      return buildRevocationVerification({
        confirmed: true,
        towerResult: confirmedResult,
        message: 'Tower confirmed revoked or deleted workspace access.',
        payload,
      });
    }
    return buildRevocationVerification({
      confirmed: false,
      towerResult: 'unconfirmed',
      message: 'Tower verification response did not confirm active access or revoked access.',
      payload,
    });
  }

  if (verifyResponse.status === 404) {
    return buildRevocationVerification({
      confirmed: true,
      towerResult: 'workspace_not_found',
      message: 'Tower access-grant verification reported the workspace was not found.',
    });
  }
  if (verifyResponse.status === 410) {
    return buildRevocationVerification({
      confirmed: true,
      towerResult: 'workspace_deleted',
      message: 'Tower access-grant verification reported the workspace was deleted.',
    });
  }
  if (verifyResponse.status === 403) {
    return buildRevocationVerification({
      confirmed: true,
      towerResult: 'access_denied',
      message: 'Tower access-grant verification denied current workspace access.',
    });
  }
  if (!['405', '501'].includes(String(verifyResponse.status))) {
    return buildRevocationVerification({
      confirmed: false,
      towerResult: 'unconfirmed',
      message: `Tower revocation verification failed with HTTP ${verifyResponse.status}.`,
    });
  }

  const checkedPayloads: unknown[] = [];
  const workspaceId = getString(input.grant.payload.workspace.workspace_id);
  if (workspaceId) {
    const meUrl = `${baseUrl}/api/v4/workspaces/${encodeURIComponent(workspaceId)}/me`;
    const meResponse = await fetchImpl(meUrl, {
      method: 'GET',
      headers: {
        Authorization: createNip98AuthHeader(meUrl, 'GET', null, input.recipientSecretKey),
      },
    });
    if (meResponse.ok) {
      const payload = await meResponse.json().catch(() => null);
      checkedPayloads.push(payload);
      if (responseAllowsAccess(payload, input.grant)) {
        return buildRevocationVerification({
          confirmed: false,
          towerResult: 'access_active',
          message: 'Tower /me still confirms current workspace access.',
          payload,
        });
      }
      const confirmedResult = payloadConfirmsRevocation(payload);
      if (confirmedResult) {
        return buildRevocationVerification({
          confirmed: true,
          towerResult: confirmedResult,
          message: 'Tower /me confirmed revoked or deleted workspace access.',
          payload,
        });
      }
    } else if (meResponse.status === 404) {
      return buildRevocationVerification({
        confirmed: true,
        towerResult: 'workspace_not_found',
        message: 'Tower /me reported the workspace was not found.',
      });
    } else if (meResponse.status === 410) {
      return buildRevocationVerification({
        confirmed: true,
        towerResult: 'workspace_deleted',
        message: 'Tower /me reported the workspace was deleted.',
      });
    } else if (meResponse.status === 403) {
      return buildRevocationVerification({
        confirmed: true,
        towerResult: 'access_denied',
        message: 'Tower /me denied current workspace access.',
      });
    }
  }

  let sawWorkspaceList = false;
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
    sawWorkspaceList = true;
    const payload = await response.json().catch(() => null);
    checkedPayloads.push(payload);
    if (fallbackPayloadAllowsAccess(payload, input.grant)) {
      return buildRevocationVerification({
        confirmed: false,
        towerResult: 'access_active',
        message: 'Tower fallback listing still includes the workspace.',
        payload,
      });
    }
  }

  if (sawWorkspaceList) {
    return buildRevocationVerification({
      confirmed: true,
      towerResult: 'workspace_not_found',
      message: 'Tower fallback listings no longer include this workspace.',
      payload: checkedPayloads,
    });
  }

  return buildRevocationVerification({
    confirmed: false,
    towerResult: 'unconfirmed',
    message: 'Tower revocation verification could not confirm current access state.',
    payload: checkedPayloads,
  });
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

  if (grant.payload.action !== 'grant') {
    const revocationKey = `${grant.event.id}:${grant.canonicalConnectionKey}:revocation:${grant.payload.action}`;
    if (input.processedKeys?.has(revocationKey)) {
      return { ok: true, code: 'duplicate_skipped', message: 'Revocation event already processed in this runtime.', grant };
    }
    let verification: TowerRevocationVerificationResult;
    try {
      verification = await verifyAccessGrantRevocationWithTower({
        grant,
        recipientSecretKey: input.recipientSecretKey,
        fetchImpl: input.fetchImpl,
      });
    } catch (error) {
      return { ok: false, code: 'tower_revocation_verify_failed', message: (error as Error).message, grant };
    }
    let handled: unknown = null;
    try {
      handled = await input.subscriptionManager.handleAccessGrantRevocation?.({
        managedByNpub: input.managedByNpub,
        agentProfileId: input.agentProfileId ?? null,
        grant,
        verification,
      });
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'revocation_handle_failed';
      return { ok: false, code, message: (error as Error).message, grant, verified: verification };
    }
    if (!verification.confirmed) {
      return {
        ok: false,
        code: verification.towerResult === 'access_active' ? 'revocation_unconfirmed_access_active' : 'revocation_unconfirmed',
        message: verification.message,
        grant,
        imported: handled,
        verified: verification,
      };
    }
    await input.onPostRevocationSync?.(grant, handled, verification);
    input.processedKeys?.add(revocationKey);
    return {
      ok: true,
      code: 'revocation_confirmed',
      message: 'Tower confirmed revocation and local connection state was refreshed.',
      grant,
      imported: handled,
      verified: verification,
    };
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
    assertAgentConnectMatchesGrant(grant);
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'agent_connect_mismatch';
    return { ok: false, code, message: (error as Error).message, grant, verified };
  }

  try {
    const imported = await input.subscriptionManager.importAgentConnectPackage({
      managedByNpub: input.managedByNpub,
      agentProfileId: input.agentProfileId ?? null,
      packageJson: grant.payload.agent_connect_package,
      onboardingSource: 'nostr_33357',
    });
    await input.onPostConnectSync?.(grant, imported);
    input.processedKeys?.add(importKey);
    return { ok: true, code: 'imported', message: 'Onboarding event verified and imported.', grant, imported, verified };
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'import_failed';
    return { ok: false, code, message: (error as Error).message, grant, verified };
  }
}
