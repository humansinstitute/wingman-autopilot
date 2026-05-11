export async function listAgentChatSubscriptions() {
  const response = await fetch('/api/agent-chat/subscriptions', { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load Agent Chat subscriptions');
  }
  return Array.isArray(payload.subscriptions) ? payload.subscriptions : [];
}

export async function listAgentChatAgents() {
  const response = await fetch('/api/agent-chat/agents', { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load Agent Chat agents');
  }
  return {
    agents: Array.isArray(payload.agents) ? payload.agents : [],
    defaults: payload.defaults && typeof payload.defaults === 'object' ? payload.defaults : {},
  };
}

export async function listAgentChatBackendConnections() {
  const response = await fetch('/api/agent-chat/backend-connections', { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load Agent Chat backend connections');
  }
  return Array.isArray(payload.backendConnections) ? payload.backendConnections : [];
}

export async function saveAgentChatBackendConnectionAvailability(backendConnectionId, input) {
  const response = await fetch(`/api/agent-chat/backend-connections/${encodeURIComponent(backendConnectionId)}/availability`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to update backend connection availability');
  }
  return payload.backendConnection;
}

export async function saveAgentChatSubscription(input) {
  const response = await fetch('/api/agent-chat/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to save Agent Chat subscription');
  }
  return payload.subscription;
}

export async function importAgentConnectPackage(input) {
  const response = await fetch('/api/agent-chat/agent-connect/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to import Agent Connect package');
  }
  return payload;
}

export async function saveAgentChatAgent(input) {
  const response = await fetch('/api/agent-chat/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to save Agent Chat agent');
  }
  return payload.agent;
}

export async function deleteAgentChatSubscription(subscriptionId) {
  const response = await fetch(`/api/agent-chat/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!response.ok && response.status !== 204) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to delete Agent Chat subscription');
  }
}

export async function deleteAgentChatAgent(agentId) {
  const response = await fetch(`/api/agent-chat/agents/${encodeURIComponent(agentId)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!response.ok && response.status !== 204) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to delete Agent Chat agent');
  }
}

export async function runAgentChatSubscriptionAction(subscriptionId, action) {
  const response = await fetch(
    `/api/agent-chat/subscriptions/${encodeURIComponent(subscriptionId)}/actions/${encodeURIComponent(action)}`,
    {
      method: 'POST',
      credentials: 'include',
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to run Agent Chat action');
  }
  return payload.subscription ?? null;
}

export async function listAgentChatDispatchRoutes(subscriptionId = '') {
  const suffix = subscriptionId ? `?subscriptionId=${encodeURIComponent(subscriptionId)}` : '';
  const response = await fetch(`/api/agent-chat/dispatch-routes${suffix}`, { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load Agent Dispatch routes');
  }
  return Array.isArray(payload.dispatchRoutes) ? payload.dispatchRoutes : [];
}

export async function saveAgentChatDispatchRoute(input) {
  const response = await fetch('/api/agent-chat/dispatch-routes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to save Agent Dispatch route');
  }
  return payload.dispatchRoute;
}
