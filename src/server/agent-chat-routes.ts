import type { RequestAuthContext } from '../auth/request-context';
import type { WorkspaceSubscriptionManager } from '../agent-chat/subscription-runtime';
import type {
  AgentChatDiagnostic,
  AgentChatSseEventDiagnostic,
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

function serialiseSubscription(record: WorkspaceSubscriptionRecord, intercepts: ChatInterceptStateRecord[]) {
  const recommendations = buildOperatorRecommendations(record, intercepts);
  return {
    ...record,
    intercepts,
    operator: {
      enabled: record.sseStatus !== 'disabled',
      blockedInterceptCount: intercepts.filter((intercept) => (
        intercept.state === 'blocked_auth' || intercept.state === 'blocked_decrypt'
      )).length,
      activeInterceptCount: intercepts.filter((intercept) => intercept.state === 'active').length,
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

export async function handleAgentChatApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: AgentChatApiContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/agent-chat/subscriptions')) {
    return null;
  }

  const viewerNpub = authContext.session?.npub ?? authContext.npub ?? null;
  if (!viewerNpub) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  if (url.pathname === '/api/agent-chat/subscriptions' && method === 'GET') {
    return Response.json({
      subscriptions: ctx.manager.listForManager(viewerNpub).map((record) => (
        serialiseSubscription(record, ctx.manager.listInterceptsForSubscription(record.subscriptionId, viewerNpub))
      )),
    });
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
    const triggerConfigRecordId = typeof body.triggerConfigRecordId === 'string' && body.triggerConfigRecordId.trim().length > 0
      ? body.triggerConfigRecordId.trim()
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
        triggerConfigRecordId,
      });
      return Response.json({
        subscription: serialiseSubscription(
          subscription,
          ctx.manager.listInterceptsForSubscription(subscription.subscriptionId, viewerNpub),
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent Chat bootstrap failed.';
      return Response.json({ error: message }, { status: 500 });
    }
  }

  const match = url.pathname.match(/^\/api\/agent-chat\/subscriptions\/([^/]+)$/);
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
      ),
    });
  }

  return Response.json({ error: 'Not found' }, { status: 404 });
}
