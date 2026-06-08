import { Buffer } from 'node:buffer';

import { normaliseBackendBaseUrl } from './tower-client';
import type { AgentCapability, BackendConnectionRecord, CreateWorkspaceSubscriptionInput } from './types';

const SUPPORTED_AGENT_CONNECT_VERSIONS = new Set([5]);

export interface AgentConnectServiceInput {
  directHttpsUrl: string;
  serviceNpub: string | null;
  relayUrls: string[];
  openapiUrl: string | null;
  docsUrl: string | null;
  healthUrl: string | null;
}

export interface AgentConnectValidationResult {
  managedByNpub: string;
  service: AgentConnectServiceInput;
  workspaceOwnerNpub: string;
  workspaceId: string | null;
  workspaceServiceNpub: string | null;
  sourceAppNpub: string;
  sourceAppSchemaNamespace: string | null;
  supportedVersion: string;
  connectionTokenRef: string;
  capabilityDefaults: AgentCapability[];
}

export interface AgentConnectImportResult {
  backendConnection: BackendConnectionRecord;
  subscriptionInput: CreateWorkspaceSubscriptionInput;
  validation: AgentConnectValidationResult;
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map(getString).filter((entry): entry is string => Boolean(entry)))];
}

function normaliseCapabilities(value: unknown): AgentCapability[] {
  const set = new Set<AgentCapability>();
  for (const capability of getStringArray(value)) {
    if (
      capability === 'chat_intercept'
      || capability === 'task_dispatch'
      || capability === 'comment_dispatch'
      || capability === 'flow_dispatch'
      || capability === 'task_review'
      || capability === 'approval_dispatch'
    ) {
      set.add(capability);
    }
  }
  return [...set];
}

export function extractAgentConnectJsonText(rawText: string): string {
  const trimmed = rawText.trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function parseJsonPayload(rawJson: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof rawJson !== 'string') {
    return rawJson;
  }
  try {
    const parsed = JSON.parse(extractAgentConnectJsonText(rawJson)) as unknown;
    const object = getObject(parsed);
    if (!object) {
      throw new Error('Agent Connect package must be a JSON object.');
    }
    return object;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Agent Connect package is not valid JSON.');
    }
    throw error;
  }
}

function decodeConnectionToken(token: string): Record<string, unknown> {
  const normalised = token.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised.padEnd(Math.ceil(normalised.length / 4) * 4, '=');
  try {
    const text = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(text) as unknown;
    const object = getObject(parsed);
    if (!object) {
      throw new Error('connection_token must decode to a JSON object.');
    }
    return object;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('connection_token does not decode to valid JSON.');
    }
    throw error;
  }
}

function assertEqualWhenPresent(
  label: string,
  outerValue: string | null,
  tokenValue: string | null,
  options: { url?: boolean } = {},
): void {
  if (!outerValue || !tokenValue) {
    return;
  }
  const left = options.url ? normaliseBackendBaseUrl(outerValue) : outerValue;
  const right = options.url ? normaliseBackendBaseUrl(tokenValue) : tokenValue;
  if (left !== right) {
    throw new Error(`Agent Connect ${label} does not match connection_token.`);
  }
}

export function validateAgentConnectPackage(input: {
  managedByNpub: string;
  packageJson: string | Record<string, unknown>;
}): AgentConnectValidationResult {
  const payload = parseJsonPayload(input.packageJson);
  const service = getObject(payload.service);
  const workspace = getObject(payload.workspace);
  const app = getObject(payload.app);

  const kind = getString(payload.kind);
  const version = typeof payload.version === 'number' ? payload.version : Number(payload.version);
  const generatedAt = getString(payload.generated_at);
  const directHttpsUrl = getString(service?.direct_https_url);
  const workspaceOwnerNpub = getString(workspace?.owner_npub);
  const sourceAppNpub = getString(app?.app_npub);
  const connectionToken = getString(payload.connection_token);

  if (kind !== 'coworker_agent_connect') {
    throw new Error('Unsupported Agent Connect package kind.');
  }
  if (!SUPPORTED_AGENT_CONNECT_VERSIONS.has(version)) {
    throw new Error(`Unsupported Agent Connect package version: ${Number.isFinite(version) ? version : 'unknown'}.`);
  }
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) {
    throw new Error('Agent Connect generated_at must be an ISO timestamp.');
  }
  if (!directHttpsUrl || !workspaceOwnerNpub || !sourceAppNpub || !connectionToken) {
    throw new Error('Agent Connect requires service.direct_https_url, workspace.owner_npub, app.app_npub, and connection_token.');
  }

  const token = decodeConnectionToken(connectionToken);
  assertEqualWhenPresent('backend URL', directHttpsUrl, getString(token.direct_https_url), { url: true });
  assertEqualWhenPresent('service npub', getString(service?.service_npub), getString(token.service_npub) ?? getString(token.server_npub));
  assertEqualWhenPresent('workspace owner', workspaceOwnerNpub, getString(token.workspace_owner_npub));
  assertEqualWhenPresent('workspace id', getString(workspace?.workspace_id), getString(token.workspace_id));
  assertEqualWhenPresent('workspace service npub', getString(workspace?.workspace_service_npub), getString(token.workspace_service_npub));
  assertEqualWhenPresent('app npub', sourceAppNpub, getString(token.app_npub));

  return {
    managedByNpub: input.managedByNpub,
    service: {
      directHttpsUrl: normaliseBackendBaseUrl(directHttpsUrl),
      serviceNpub: getString(service?.service_npub),
      relayUrls: getStringArray(service?.relay_urls),
      openapiUrl: getString(service?.openapi_url),
      docsUrl: getString(service?.docs_url),
      healthUrl: getString(service?.health_url),
    },
    workspaceOwnerNpub,
    workspaceId: getString(workspace?.workspace_id),
    workspaceServiceNpub: getString(workspace?.workspace_service_npub),
    sourceAppNpub,
    sourceAppSchemaNamespace: getString(app?.schema_namespace),
    supportedVersion: String(version),
    connectionTokenRef: `agent-connect:${workspaceOwnerNpub}:${sourceAppNpub}:${Date.parse(generatedAt)}`,
    capabilityDefaults: normaliseCapabilities(payload.capabilities),
  };
}

export function buildAgentConnectImportResult(
  validation: AgentConnectValidationResult,
  backendConnection: BackendConnectionRecord,
): AgentConnectImportResult {
  return {
    backendConnection,
    validation,
    subscriptionInput: {
      managedByNpub: validation.managedByNpub,
      backendConnectionId: backendConnection.backendConnectionId,
      workspaceOwnerNpub: validation.workspaceOwnerNpub,
      towerServiceNpub: validation.service.serviceNpub,
      workspaceId: validation.workspaceId,
      workspaceServiceNpub: validation.workspaceServiceNpub,
      backendBaseUrl: validation.service.directHttpsUrl,
      sourceAppNpub: validation.sourceAppNpub,
      connectionTokenRef: validation.connectionTokenRef,
      sourceAppSchemaNamespace: validation.sourceAppSchemaNamespace,
      capabilityDefaults: validation.capabilityDefaults,
      dispatchRouteIds: [],
    },
  };
}
