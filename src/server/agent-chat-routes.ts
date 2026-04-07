import type { RequestAuthContext } from '../auth/request-context';
import type { WorkspaceSubscriptionManager } from '../agent-chat/subscription-runtime';

type HttpMethod = 'GET' | 'POST' | 'DELETE';

export interface AgentChatApiContext {
  manager: WorkspaceSubscriptionManager;
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
    return Response.json({ subscriptions: ctx.manager.listForManager(viewerNpub) });
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
      return Response.json({ subscription });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent Chat bootstrap failed.';
      return Response.json({ error: message }, { status: 500 });
    }
  }

  const match = url.pathname.match(/^\/api\/agent-chat\/subscriptions\/([^/]+)$/);
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
    return Response.json({ subscription });
  }

  return Response.json({ error: 'Not found' }, { status: 404 });
}
