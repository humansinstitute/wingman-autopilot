import type { RequestAuthContext } from '../auth/request-context';
import type { WorkspaceSubscriptionManager } from '../agent-chat/subscription-runtime';
import {
  DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE,
} from '../agent-chat/prompt-templates';
import type {
  AgentDefinitionRecord,
  AgentChatDiagnostic,
  AgentChatSseEventDiagnostic,
  BackendConnectionGrantRecord,
  BackendConnectionRecord,
  ChatInterceptStateRecord,
  DispatchActivePolicy,
  DispatchRouteRecord,
  DispatchTriggerKind,
  WorkspaceSubscriptionRecord,
} from '../agent-chat/types';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface AgentChatApiContext {
  manager: WorkspaceSubscriptionManager;
}

function getDetailString(
  diagnostic: AgentChatDiagnostic | null | undefined,
  key: string,
): string | null {
  const value = diagnostic?.details?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getPayloadString(
  diagnostic: AgentChatSseEventDiagnostic | null | undefined,
  key: string,
): string | null {
  const value = diagnostic?.payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function buildOperatorRecommendations(record: WorkspaceSubscriptionRecord, intercepts: ChatInterceptStateRecord[]) {
  const recommendations = new Map<string, { action: string; label: string; reason: string }>();
  const addRecommendation = (action: string, label: string, reason: string) => {
    const key = `${action}:${label}`;
    if (!recommendations.has(key)) {
      recommendations.set(key, { action, label, reason });
    }
  };
  const hasBlockedAuth = intercepts.some((intercept) => intercept.state === 'blocked_auth');
  const hasBlockedDecrypt = intercepts.some((intercept) => intercept.state === 'blocked_decrypt');
  const hasInterruptFailure = intercepts.some((intercept) => intercept.state === 'interrupt_failed');

  if (record.sseStatus === 'disabled') {
    addRecommendation('enable', 'Re-enable subscription', 'SSE is disabled, so Agent Chat will not receive workspace advisories.');
  }
  if (record.sseStatus === 'backoff' || record.sseStatus === 'disconnected') {
    addRecommendation('reconnect', 'Reconnect subscription', 'The workspace SSE stream is not currently connected.');
  }
  if (record.wsKeyStatus !== 'active' || hasBlockedAuth) {
    addRecommendation('refresh-keys', 'Refresh workspace key', 'Workspace auth is stale, revoked, or otherwise blocked.');
  }
  if (record.groupKeyStatus === 'refresh_required' || record.groupKeyStatus === 'failed' || hasBlockedDecrypt) {
    addRecommendation('refresh-keys', 'Refresh wrapped group keys', 'Decrypt or group membership state needs to be refreshed.');
  }
  if (hasInterruptFailure) {
    addRecommendation('reconnect', 'Reconnect session runtime', 'An interrupt failed and the runtime is running queued same-session follow-up prompts.');
  }

  return Array.from(recommendations.values());
}

function serialiseAgent(record: AgentDefinitionRecord) {
  return {
    ...record,
    operator: {
      enabled: record.enabled,
      groupCount: record.groupNpubs.length,
      capabilityCount: record.capabilities.length,
    },
  };
}

function serialiseBackendConnection(
  record: BackendConnectionRecord,
  viewerNpub?: string | null,
  grants: BackendConnectionGrantRecord[] = [],
) {
  return {
    ...record,
    availabilityGrants: grants,
    operator: {
      relayCount: record.relayUrls.length,
      hasHealthUrl: Boolean(record.healthUrl),
      canManageAvailability: Boolean(viewerNpub && record.managedByNpub === viewerNpub),
    },
  };
}

function serialiseDispatchRoute(record: DispatchRouteRecord) {
  return { ...record };
}

function getBackendWorkspaceName(record: BackendConnectionRecord | null | undefined): string | null {
  const response = record?.lastHealthResult?.details?.response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return null;
  }
  const towerName = (response as Record<string, unknown>).tower_name;
  return typeof towerName === 'string' && towerName.trim().length > 0 ? towerName.trim() : null;
}

function serialiseSubscription(
  record: WorkspaceSubscriptionRecord,
  intercepts: ChatInterceptStateRecord[],
  candidateAgents: AgentDefinitionRecord[],
  backendConnection?: BackendConnectionRecord | null,
) {
  const recommendations = buildOperatorRecommendations(record, intercepts);
  return {
    ...record,
    workspaceName: getBackendWorkspaceName(backendConnection),
    backend: record.backendConnectionId
      ? { backendConnectionId: record.backendConnectionId }
      : null,
    intercepts,
    candidateAgents: candidateAgents.map(serialiseAgent),
    operator: {
      enabled: record.sseStatus !== 'disabled',
      blockedInterceptCount: intercepts.filter((intercept) => (
        intercept.state === 'blocked_auth' || intercept.state === 'blocked_decrypt'
      )).length,
      activeInterceptCount: intercepts.filter((intercept) => intercept.state === 'active').length,
      candidateAgentCount: candidateAgents.length,
      recommendations,
    },
    diagnostics: {
      lastSseEventId: record.lastSseEventId,
      lastSseEvent: record.lastSseEvent,
      advisory: {
        eventId: record.lastSseEventId ?? record.lastSseEvent?.eventId ?? null,
        eventType: record.lastSseEvent?.eventType ?? null,
        at: record.lastSseEvent?.at ?? null,
        familyHash: getPayloadString(record.lastSseEvent, 'family_hash'),
        recordId: getPayloadString(record.lastSseEvent, 'record_id'),
      },
      recordPull: record.lastRecordPullResult,
      decrypt: record.lastDecryptResult,
      routing: record.lastRoutingResult,
      trail: {
        advisory: {
          seen: Boolean(record.lastSseEventId || record.lastSseEvent),
          eventId: record.lastSseEventId ?? record.lastSseEvent?.eventId ?? null,
          at: record.lastSseEvent?.at ?? null,
          recordId: getPayloadString(record.lastSseEvent, 'record_id'),
        },
        recordPull: {
          ok: record.lastRecordPullResult?.ok ?? null,
          code: record.lastRecordPullResult?.code ?? null,
          at: record.lastRecordPullResult?.at ?? null,
          recordId: getDetailString(record.lastRecordPullResult, 'record_id'),
        },
        decrypt: {
          ok: record.lastDecryptResult?.ok ?? null,
          code: record.lastDecryptResult?.code ?? null,
          at: record.lastDecryptResult?.at ?? null,
          recordId: getDetailString(record.lastDecryptResult, 'record_id'),
        },
        routing: {
          ok: record.lastRoutingResult?.ok ?? null,
          code: record.lastRoutingResult?.code ?? null,
          at: record.lastRoutingResult?.at ?? null,
          recordId: getDetailString(record.lastRoutingResult, 'record_id'),
        },
      },
    },
  };
}

function getAgentChatErrorStatus(error: unknown, fallback: number): number {
  const statusCode = (error as { statusCode?: unknown })?.statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600
    ? statusCode
    : fallback;
}

function getOptionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

function parseJsonObjectField(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseDispatchTriggerKind(value: unknown): DispatchTriggerKind | null {
  return value === 'chat' || value === 'task' || value === 'flow' || value === 'task_review' || value === 'approval' || value === 'comment'
    ? value
    : null;
}

function parseDispatchCapability(value: unknown) {
  return value === 'chat_intercept'
    || value === 'task_dispatch'
    || value === 'comment_dispatch'
    || value === 'flow_dispatch'
    || value === 'task_review'
    || value === 'approval_dispatch'
    ? value
    : null;
}

function parseActivePolicy(value: unknown): DispatchActivePolicy | undefined {
  return value === 'skip' || value === 'queue' || value === 'start_new' ? value : undefined;
}

export async function handleAgentChatApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: AgentChatApiContext,
): Promise<Response | null> {
  if (
    !url.pathname.startsWith('/api/agent-chat/subscriptions')
    && !url.pathname.startsWith('/api/agent-chat/agents')
    && !url.pathname.startsWith('/api/agent-chat/backend-connections')
    && !url.pathname.startsWith('/api/agent-chat/agent-connect')
    && !url.pathname.startsWith('/api/agent-chat/dispatch-routes')
  ) {
    return null;
  }

  const viewerNpub = authContext.session?.npub ?? authContext.npub ?? null;
  if (!viewerNpub) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  if (url.pathname === '/api/agent-chat/subscriptions' && method === 'GET') {
    const backendConnections = ctx.manager.listBackendConnectionsForManager(viewerNpub);
    return Response.json({
      subscriptions: ctx.manager.listForManager(viewerNpub).map((record) => {
        const backendConnection = backendConnections.find((backend) => backend.backendConnectionId === record.backendConnectionId) ?? null;
        return serialiseSubscription(
          record,
          ctx.manager.listInterceptsForSubscription(record.subscriptionId, viewerNpub),
          ctx.manager.listAgentsForWorkspaceBot(record.workspaceOwnerNpub, record.botNpub, viewerNpub),
          backendConnection,
        );
      }),
    });
  }

  if (url.pathname === '/api/agent-chat/agents' && method === 'GET') {
    return Response.json({
      agents: ctx.manager.listAgentsForManager(viewerNpub).map(serialiseAgent),
      defaults: {
        chatPromptTemplate: DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE,
        taskPromptTemplate: DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE,
        flowDispatchPromptTemplate: DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE,
        taskReviewPromptTemplate: DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE,
        approvalDispatchPromptTemplate: DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE,
      },
    });
  }

  if (url.pathname === '/api/agent-chat/backend-connections' && method === 'GET') {
    return Response.json({
      backendConnections: ctx.manager.listBackendConnectionsForManager(viewerNpub).map((record) => (
        serialiseBackendConnection(
          record,
          viewerNpub,
          ctx.manager.listBackendConnectionGrantsForManager(record.backendConnectionId, viewerNpub),
        )
      )),
    });
  }

  const backendAvailabilityMatch = url.pathname.match(/^\/api\/agent-chat\/backend-connections\/([^/]+)\/availability$/);
  if (backendAvailabilityMatch && (method === 'POST' || method === 'PATCH')) {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    const backendConnectionId = decodeURIComponent(backendAvailabilityMatch[1]!);
    const allowedManagerNpubs = getOptionalStringArray(body.allowedManagerNpubs);
    const grantSharedService = body.grantSharedService === true;

    try {
      const result = ctx.manager.updateBackendConnectionAvailabilityForManager({
        backendConnectionId,
        managedByNpub: viewerNpub,
        managerNpubs: allowedManagerNpubs,
        sharedService: grantSharedService,
      });
      return Response.json({
        backendConnection: serialiseBackendConnection(
          result.backendConnection,
          viewerNpub,
          result.grants,
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update backend connection availability.';
      return Response.json({ error: message }, { status: getAgentChatErrorStatus(error, 400) });
    }
  }

  if (url.pathname === '/api/agent-chat/dispatch-routes' && method === 'GET') {
    const subscriptionId = url.searchParams.get('subscriptionId');
    const routes = subscriptionId
      ? ctx.manager.listDispatchRoutesForSubscription(subscriptionId, viewerNpub)
      : ctx.manager.listDispatchRoutesForManager(viewerNpub);
    return Response.json({ dispatchRoutes: routes.map(serialiseDispatchRoute) });
  }

  if (url.pathname === '/api/agent-chat/dispatch-routes' && (method === 'POST' || method === 'PATCH')) {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    const routeId = typeof body.routeId === 'string' && body.routeId.trim().length > 0 ? body.routeId.trim() : undefined;
    const subscriptionId = typeof body.subscriptionId === 'string' ? body.subscriptionId.trim() : '';
    const triggerKind = parseDispatchTriggerKind(body.triggerKind);
    const capability = parseDispatchCapability(body.capability);
    const pipelineDefinitionId = typeof body.pipelineDefinitionId === 'string' ? body.pipelineDefinitionId.trim() : '';
    if (!subscriptionId || !triggerKind || !capability || !pipelineDefinitionId) {
      return Response.json(
        { error: 'subscriptionId, triggerKind, capability, and pipelineDefinitionId are required.' },
        { status: 400 },
      );
    }

    try {
      const route = ctx.manager.saveDispatchRouteForManager({
        routeId,
        managedByNpub: viewerNpub,
        subscriptionId,
        triggerKind,
        capability,
        pipelineDefinitionId,
        enabled: body.enabled !== false,
        priority: Number.isFinite(body.priority) ? Number(body.priority) : undefined,
        matchJson: parseJsonObjectField(body.matchJson),
        inputTemplateJson: parseJsonObjectField(body.inputTemplateJson),
        concurrencyKeyTemplate: typeof body.concurrencyKeyTemplate === 'string' ? body.concurrencyKeyTemplate : undefined,
        activePolicy: parseActivePolicy(body.activePolicy),
        dedupeWindowSeconds: Number.isFinite(body.dedupeWindowSeconds) ? Number(body.dedupeWindowSeconds) : undefined,
      });
      return Response.json({ dispatchRoute: serialiseDispatchRoute(route) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save dispatch route.';
      return Response.json({ error: message }, { status: getAgentChatErrorStatus(error, 400) });
    }
  }

  if (url.pathname === '/api/agent-chat/agent-connect/import' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    const rawPackage = typeof body.packageJson === 'string'
      ? body.packageJson
      : typeof body.agentConnectJson === 'string'
        ? body.agentConnectJson
        : body.package && typeof body.package === 'object'
          ? body.package as Record<string, unknown>
          : null;
    const agentProfileId = typeof body.agentProfileId === 'string' && body.agentProfileId.trim().length > 0
      ? body.agentProfileId.trim()
      : null;
    const allowedManagerNpubs = getOptionalStringArray(body.allowedManagerNpubs);
    const grantSharedService = body.grantSharedService === true;

    if (!rawPackage) {
      return Response.json({ error: 'packageJson or package is required.' }, { status: 400 });
    }

    try {
      const imported = await ctx.manager.importAgentConnectPackage({
        managedByNpub: viewerNpub,
        packageJson: rawPackage,
        agentProfileId,
        allowedManagerNpubs,
        grantSharedService,
      });
      return Response.json({
        backendConnection: serialiseBackendConnection(
          imported.backendConnection,
          viewerNpub,
          ctx.manager.listBackendConnectionGrantsForManager(imported.backendConnection.backendConnectionId, viewerNpub),
        ),
        subscription: serialiseSubscription(
          imported.subscription,
          ctx.manager.listInterceptsForSubscription(imported.subscription.subscriptionId, viewerNpub),
          ctx.manager.listAgentsForWorkspaceBot(imported.subscription.workspaceOwnerNpub, imported.subscription.botNpub, viewerNpub),
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Agent Connect import failed.');
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (url.pathname === '/api/agent-chat/subscriptions' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    const workspaceOwnerNpub = typeof body.workspaceOwnerNpub === 'string' ? body.workspaceOwnerNpub.trim() : '';
    const backendBaseUrl = typeof body.backendBaseUrl === 'string' ? body.backendBaseUrl.trim() : '';
    const sourceAppNpub = typeof body.sourceAppNpub === 'string' ? body.sourceAppNpub.trim() : '';
    const backendConnectionId = typeof body.backendConnectionId === 'string' && body.backendConnectionId.trim().length > 0
      ? body.backendConnectionId.trim()
      : null;
    const backendConnectionGrantKind = body.backendConnectionGrantKind === 'shared_service'
      ? 'shared_service'
      : null;
    const sourceAppSchemaNamespace = typeof body.sourceAppSchemaNamespace === 'string' && body.sourceAppSchemaNamespace.trim().length > 0
      ? body.sourceAppSchemaNamespace.trim()
      : null;
    const triggerConfigRecordId = typeof body.triggerConfigRecordId === 'string' && body.triggerConfigRecordId.trim().length > 0
      ? body.triggerConfigRecordId.trim()
      : null;
    const agentProfileId = typeof body.agentProfileId === 'string' && body.agentProfileId.trim().length > 0
      ? body.agentProfileId.trim()
      : null;

    if (!backendConnectionId && (!workspaceOwnerNpub || !backendBaseUrl || !sourceAppNpub)) {
      return Response.json(
        { error: 'workspaceOwnerNpub, backendBaseUrl, and sourceAppNpub are required unless backendConnectionId has setup hints.' },
        { status: 400 },
      );
    }

    try {
      const subscription = await ctx.manager.createOrUpdate({
        managedByNpub: viewerNpub,
        workspaceOwnerNpub,
        backendBaseUrl,
        sourceAppNpub,
        backendConnectionId,
        backendConnectionGrantKind,
        agentProfileId,
        sourceAppSchemaNamespace,
        triggerConfigRecordId,
      });
      return Response.json({
        subscription: serialiseSubscription(
          subscription,
          ctx.manager.listInterceptsForSubscription(subscription.subscriptionId, viewerNpub),
          ctx.manager.listAgentsForWorkspaceBot(subscription.workspaceOwnerNpub, subscription.botNpub, viewerNpub),
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent Chat bootstrap failed.';
      return Response.json({ error: message }, { status: getAgentChatErrorStatus(error, 500) });
    }
  }

  if (url.pathname === '/api/agent-chat/agents' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const botNpub = typeof body.botNpub === 'string' ? body.botNpub.trim() : '';
    const workspaceOwnerNpub = typeof body.workspaceOwnerNpub === 'string' ? body.workspaceOwnerNpub.trim() : '';
    const workingDirectory = typeof body.workingDirectory === 'string' ? body.workingDirectory.trim() : '';
    const enabled = body.enabled !== false;
    const groupNpubs = Array.isArray(body.groupNpubs)
      ? body.groupNpubs.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
      : [];
    const capabilityInput = Array.isArray(body.capabilities)
      ? body.capabilities.filter((value): value is string => typeof value === 'string')
      : [];
    const capabilities = capabilityInput.some((value) => (
      value === 'chat_intercept'
      || value === 'task_dispatch'
      || value === 'comment_dispatch'
      || value === 'flow_dispatch'
      || value === 'task_review'
      || value === 'approval_dispatch'
    ))
      ? [
          ...(capabilityInput.includes('chat_intercept') ? ['chat_intercept'] as const : []),
          ...(capabilityInput.includes('task_dispatch') ? ['task_dispatch'] as const : []),
          ...(capabilityInput.includes('comment_dispatch') ? ['comment_dispatch'] as const : []),
          ...(capabilityInput.includes('flow_dispatch') ? ['flow_dispatch'] as const : []),
          ...(capabilityInput.includes('task_review') ? ['task_review'] as const : []),
          ...(capabilityInput.includes('approval_dispatch') ? ['approval_dispatch'] as const : []),
        ]
      : ['chat_intercept'] as const;
    const chatPromptTemplate = typeof body.chatPromptTemplate === 'string' ? body.chatPromptTemplate : undefined;
    const taskPromptTemplate = typeof body.taskPromptTemplate === 'string' ? body.taskPromptTemplate : undefined;
    const flowDispatchPromptTemplate = typeof body.flowDispatchPromptTemplate === 'string'
      ? body.flowDispatchPromptTemplate
      : undefined;
    const taskReviewPromptTemplate = typeof body.taskReviewPromptTemplate === 'string'
      ? body.taskReviewPromptTemplate
      : undefined;
    const approvalDispatchPromptTemplate = typeof body.approvalDispatchPromptTemplate === 'string'
      ? body.approvalDispatchPromptTemplate
      : undefined;

    if (!agentId || !botNpub || !workspaceOwnerNpub || !workingDirectory) {
      return Response.json(
        { error: 'agentId, botNpub, workspaceOwnerNpub, and workingDirectory are required.' },
        { status: 400 },
      );
    }

    try {
      const agent = await ctx.manager.saveAgentForManager({
        managedByNpub: viewerNpub,
        agentId,
        label,
        botNpub,
        workspaceOwnerNpub,
        groupNpubs,
        workingDirectory,
        capabilities: [...capabilities],
        chatPromptTemplate,
        taskPromptTemplate,
        flowDispatchPromptTemplate,
        taskReviewPromptTemplate,
        approvalDispatchPromptTemplate,
        enabled,
      });
      return Response.json({ agent: serialiseAgent(agent) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save Agent Chat agent.';
      return Response.json({ error: message }, { status: 400 });
    }
  }

  const match = url.pathname.match(/^\/api\/agent-chat\/subscriptions\/([^/]+)$/);
  const agentMatch = url.pathname.match(/^\/api\/agent-chat\/agents\/([^/]+)$/);
  const dispatchRouteMatch = url.pathname.match(/^\/api\/agent-chat\/dispatch-routes\/([^/]+)$/);
  const actionMatch = url.pathname.match(/^\/api\/agent-chat\/subscriptions\/([^/]+)\/actions\/([^/]+)$/);
  if (dispatchRouteMatch && method === 'DELETE') {
    const routeId = decodeURIComponent(dispatchRouteMatch[1]!);
    const removed = ctx.manager.deleteDispatchRouteForManager(routeId, viewerNpub);
    if (!removed) {
      return Response.json({ error: 'Dispatch route not found' }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  }
  if (actionMatch && method === 'POST') {
    const subscriptionId = decodeURIComponent(actionMatch[1]!);
    const action = decodeURIComponent(actionMatch[2]!);
    try {
      let subscription: WorkspaceSubscriptionRecord | null = null;
      if (action === 'reconnect') {
        subscription = await ctx.manager.reconnectForManager(subscriptionId, viewerNpub);
      } else if (action === 'refresh-keys') {
        subscription = await ctx.manager.refreshKeysForManager(subscriptionId, viewerNpub);
      } else if (action === 'disable') {
        subscription = await ctx.manager.setEnabledForManager(subscriptionId, viewerNpub, false);
      } else if (action === 'enable') {
        subscription = await ctx.manager.setEnabledForManager(subscriptionId, viewerNpub, true);
      } else {
        return Response.json({ error: 'Unknown Agent Chat action' }, { status: 404 });
      }

      if (!subscription) {
        return Response.json({ error: 'Subscription not found' }, { status: 404 });
      }

      return Response.json({
        subscription: serialiseSubscription(
          subscription,
          ctx.manager.listInterceptsForSubscription(subscription.subscriptionId, viewerNpub),
          ctx.manager.listAgentsForWorkspaceBot(subscription.workspaceOwnerNpub, subscription.botNpub, viewerNpub),
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent Chat repair action failed.';
      return Response.json({ error: message }, { status: 500 });
    }
  }

  if (match && method === 'DELETE') {
    const subscriptionId = decodeURIComponent(match[1]!);
    const removed = ctx.manager.removeForManager(subscriptionId, viewerNpub);
    if (!removed) {
      return Response.json({ error: 'Subscription not found' }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  }

  if (match && method === 'GET') {
    const subscriptionId = decodeURIComponent(match[1]!);
    const subscription = ctx.manager.getForManager(subscriptionId, viewerNpub);
    if (!subscription) {
      return Response.json({ error: 'Subscription not found' }, { status: 404 });
    }
    return Response.json({
      subscription: serialiseSubscription(
        subscription,
        ctx.manager.listInterceptsForSubscription(subscription.subscriptionId, viewerNpub),
        ctx.manager.listAgentsForWorkspaceBot(subscription.workspaceOwnerNpub, subscription.botNpub, viewerNpub),
      ),
    });
  }

  if (agentMatch && method === 'DELETE') {
    const agentId = decodeURIComponent(agentMatch[1]!);
    const removed = ctx.manager.removeAgentForManager(agentId, viewerNpub);
    if (!removed) {
      return Response.json({ error: 'Agent not found' }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  }

  return Response.json({ error: 'Not found' }, { status: 404 });
}
