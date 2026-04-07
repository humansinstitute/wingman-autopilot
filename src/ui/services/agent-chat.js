export async function listAgentChatSubscriptions() {
  const response = await fetch('/api/agent-chat/subscriptions', { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load Agent Chat subscriptions');
  }
  return Array.isArray(payload.subscriptions) ? payload.subscriptions : [];
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
