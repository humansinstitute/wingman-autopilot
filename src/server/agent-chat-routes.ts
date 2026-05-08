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
  BackendConnectionRecord,
  ChatInterceptStateRecord,
  WorkspaceSubscriptionRecord,
} from '../agent-chat/types';

type HttpMethod = 'GET' | 'POST' | 'DELETE';

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

function serialiseBackendConnection(record: BackendConnectionRecord) {
  return {
    ...record,
    operator: {
      relayCount: record.relayUrls.length,
      hasHealthUrl: Boolean(record.healthUrl),
    },
  };
}

function serialiseSubscription(
  record: WorkspaceSubscriptionRecord,
  intercepts: ChatInterceptStateRecord[],
  candidateAgents: AgentDefinitionRecord[],
) {
  const recommendations = buildOperatorRecommendations(record, intercepts);
  return {
    ...record,
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
  ) {
    return null;
  }

  const viewerNpub = authContext.session?.npub ?? authContext.npub ?? null;
  if (!viewerNpub) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  if (url.pathname === '/api/agent-chat/subscriptions' && method === 'GET') {
    return Response.json({
      subscriptions: ctx.manager.listForManager(viewerNpub).map((record) => (
        serialiseSubscription(
          record,
          ctx.manager.listInterceptsForSubscription(record.subscriptionId, viewerNpub),
          ctx.manager.listAgentsForWorkspaceBot(record.workspaceOwnerNpub, record.botNpub, viewerNpub),
        )
      )),
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
      backendConnections: ctx.manager.listBackendConnectionsForManager(viewerNpub).map(serialiseBackendConnection),
    });
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

    if (!rawPackage) {
      return Response.json({ error: 'packageJson or package is required.' }, { status: 400 });
    }

    try {
      const imported = await ctx.manager.importAgentConnectPackage({
        managedByNpub: viewerNpub,
        packageJson: rawPackage,
        agentProfileId,
      });
      return Response.json({
        backendConnection: serialiseBackendConnection(imported.backendConnection),
        subscription: serialiseSubscription(
          imported.subscription,
          ctx.manager.listInterceptsForSubscription(imported.subscription.subscriptionId, viewerNpub),
          ctx.manager.listAgentsForWorkspaceBot(imported.subscription.workspaceOwnerNpub, imported.subscription.botNpub, viewerNpub),
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent Connect import failed.';
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
    const triggerConfigRecordId = typeof body.triggerConfigRecordId === 'string' && body.triggerConfigRecordId.trim().length > 0
      ? body.triggerConfigRecordId.trim()
      : null;
    const agentProfileId = typeof body.agentProfileId === 'string' && body.agentProfileId.trim().length > 0
      ? body.agentProfileId.trim()
      : null;

    if (!workspaceOwnerNpub || !backendBaseUrl || !sourceAppNpub) {
      return Response.json(
        { error: 'workspaceOwnerNpub, backendBaseUrl, and sourceAppNpub are required.' },
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
        agentProfileId,
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
      const agent = ctx.manager.saveAgentForManager({
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
  const actionMatch = url.pathname.match(/^\/api\/agent-chat\/subscriptions\/([^/]+)\/actions\/([^/]+)$/);
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
