export function resolveSelectedSubscriptionId(subscriptions, selectedSubscriptionId = null) {
  const list = Array.isArray(subscriptions) ? subscriptions : [];
  if (selectedSubscriptionId && list.some((subscription) => subscription?.subscriptionId === selectedSubscriptionId)) {
    return selectedSubscriptionId;
  }
  return list[0]?.subscriptionId ?? null;
}

export function getSubscriptionById(subscriptions, subscriptionId) {
  return Array.isArray(subscriptions)
    ? subscriptions.find((subscription) => subscription?.subscriptionId === subscriptionId) ?? null
    : null;
}

export function filterDispatchRoutesForSubscription(routes, subscriptionId) {
  return Array.isArray(routes) && subscriptionId
    ? routes.filter((route) => route?.subscriptionId === subscriptionId)
    : [];
}

export function getAgentForSubscription(agents, subscription) {
  if (!Array.isArray(agents) || agents.length === 0) {
    return null;
  }
  if (!subscription) {
    return null;
  }
  return agents.find((agent) => (
    agent?.workspaceOwnerNpub === subscription.workspaceOwnerNpub
    && agent?.botNpub === subscription.botNpub
  )) ?? null;
}

export function getAdditionalAgents(agents, selectedAgent) {
  return Array.isArray(agents)
    ? agents.filter((agent) => agent?.agentId !== selectedAgent?.agentId)
    : [];
}

export function getRoutesForSubscription(routes, subscriptionId) {
  return Array.isArray(routes)
    ? routes.filter((route) => route?.subscriptionId === subscriptionId)
    : [];
}
