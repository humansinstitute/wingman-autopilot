function formatDiagnostic(diagnostic) {
  if (!diagnostic) return 'None';
  const status = diagnostic.ok ? 'ok' : (diagnostic.code || 'failed');
  return `${status} at ${diagnostic.at}`;
}

function formatKeyValueDetails(details) {
  if (!details || typeof details !== 'object') {
    return 'None';
  }
  const entries = Object.entries(details)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`);
  return entries.length > 0 ? entries.join(', ') : 'None';
}

function formatAdvisory(subscription) {
  const advisory = subscription.diagnostics?.advisory;
  if (!advisory || !advisory.at) {
    return 'None';
  }
  const parts = [
    advisory.eventType || 'unknown',
    advisory.eventId ? `event_id=${advisory.eventId}` : null,
    advisory.recordId ? `record_id=${advisory.recordId}` : null,
    advisory.familyHash ? `family_hash=${advisory.familyHash}` : null,
    `at ${advisory.at}`,
  ].filter(Boolean);
  return parts.join(', ');
}

function formatTrail(subscription) {
  const trail = subscription.diagnostics?.trail;
  if (!trail) {
    return 'No advisory trail yet.';
  }

  const advisoryStep = trail.advisory?.seen
    ? `advisory seen${trail.advisory.recordId ? ` for ${trail.advisory.recordId}` : ''}${trail.advisory.eventId ? ` (${trail.advisory.eventId})` : ''}`
    : 'advisory pending';
  const pullStep = trail.recordPull?.at
    ? `pull ${trail.recordPull.ok ? 'ok' : (trail.recordPull.code || 'failed')}`
    : 'pull pending';
  const decryptStep = trail.decrypt?.at
    ? `decrypt ${trail.decrypt.ok ? 'ok' : (trail.decrypt.code || 'failed')}`
    : 'decrypt pending';
  const routingStep = trail.routing?.at
    ? `routing ${trail.routing.ok ? 'ok' : (trail.routing.code || 'failed')}`
    : 'routing pending';

  return `${advisoryStep} -> ${pullStep} -> ${decryptStep} -> ${routingStep}`;
}

function formatTimestamp(value) {
  if (typeof value !== 'string' || !value) {
    return 'None';
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

function isAgentChatSession(session) {
  return session?.metadata?.role === 'agent-chat' || session?.origin?.type === 'agent-chat';
}

function appendTableCell(row, content) {
  const cell = document.createElement('td');
  cell.textContent = content;
  row.append(cell);
}

function createDetailList(rows, subscriptionId) {
  const details = document.createElement('dl');
  details.style.cssText = 'display:grid;grid-template-columns:max-content 1fr;gap:6px 12px;font-size:0.9em;';
  rows.forEach(([termText, valueText]) => {
    const term = document.createElement('dt');
    term.textContent = termText;
    const value = document.createElement('dd');
    value.textContent = valueText;
    value.style.margin = '0';
    if (termText === 'Latest Chat Trail') {
      value.setAttribute('data-testid', `agent-chat-latest-trail-${subscriptionId}`);
    }
    if (termText === 'Last SSE Event ID') {
      value.setAttribute('data-testid', `agent-chat-last-sse-event-id-${subscriptionId}`);
    }
    if (termText === 'Last Record Pull') {
      value.setAttribute('data-testid', `agent-chat-last-record-pull-${subscriptionId}`);
    }
    if (termText === 'Last Decrypt') {
      value.setAttribute('data-testid', `agent-chat-last-decrypt-${subscriptionId}`);
    }
    details.append(term, value);
  });
  return details;
}

function createActionButton(label, ariaLabel, testId, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wm-button secondary';
  button.textContent = label;
  button.setAttribute('aria-label', ariaLabel);
  button.setAttribute('data-testid', testId);
  button.addEventListener('click', onClick);
  return button;
}

function createRecommendedList(subscription) {
  const recommendations = Array.isArray(subscription.operator?.recommendations)
    ? subscription.operator.recommendations
    : [];
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'margin-top:10px;';
  const heading = document.createElement('h5');
  heading.textContent = 'Recommended Repair Flows';
  wrapper.append(heading);

  if (recommendations.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No repair action is currently recommended.';
    wrapper.append(empty);
    return wrapper;
  }

  const list = document.createElement('ul');
  list.style.cssText = 'margin:6px 0 0 18px;padding:0;';
  recommendations.forEach((entry) => {
    const item = document.createElement('li');
    item.textContent = `${entry.label}: ${entry.reason}`;
    list.append(item);
  });
  wrapper.append(list);
  return wrapper;
}

function createInterceptTable(subscription) {
  const intercepts = Array.isArray(subscription.intercepts) ? subscription.intercepts : [];
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'margin-top:12px;';
  const heading = document.createElement('h5');
  heading.textContent = 'Chat Intercepts';
  wrapper.append(heading);

  if (intercepts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No routed intercepts yet.';
    wrapper.append(empty);
    return wrapper;
  }

  const table = document.createElement('table');
  table.className = 'wm-table';
  table.setAttribute('aria-label', `Agent Chat intercepts for ${subscription.workspaceOwnerNpub}`);
  table.setAttribute('data-testid', `agent-chat-intercepts-${subscription.subscriptionId}`);
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>State</th><th>Channel</th><th>Thread</th><th>Pending</th><th>Session</th><th>Last Activity</th></tr>';
  table.append(thead);

  const tbody = document.createElement('tbody');
  intercepts.forEach((intercept) => {
    const row = document.createElement('tr');
    appendTableCell(row, intercept.state || 'pending');
    appendTableCell(row, intercept.channelId || 'None');
    appendTableCell(row, intercept.threadId || 'None');
    appendTableCell(row, String(intercept.pendingMessageCount ?? 0));
    appendTableCell(row, intercept.sessionId || 'None');
    appendTableCell(row, formatTimestamp(intercept.lastActivityAt));
    tbody.append(row);
  });
  table.append(tbody);
  wrapper.append(table);
  return wrapper;
}

function findLinkedSessions(subscription, chatSessions) {
  const intercepts = Array.isArray(subscription.intercepts) ? subscription.intercepts : [];
  const sessionIds = new Set(intercepts.map((intercept) => intercept.sessionId).filter(Boolean));
  const routingKeys = new Set(intercepts.map((intercept) => intercept.routingKey).filter(Boolean));
  return chatSessions.filter((session) => sessionIds.has(session.id) || routingKeys.has(session.origin?.id));
}

function createSessionTable(title, sessions, testId) {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'margin-top:12px;';
  const heading = document.createElement('h5');
  heading.textContent = title;
  wrapper.append(heading);

  if (!Array.isArray(sessions) || sessions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No Agent Chat sessions are currently active.';
    wrapper.append(empty);
    return wrapper;
  }

  const table = document.createElement('table');
  table.className = 'wm-table';
  table.setAttribute('aria-label', title);
  table.setAttribute('data-testid', testId);
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Name</th><th>Status</th><th>Runtime</th><th>Agent</th><th>Routing</th><th>Started</th></tr>';
  table.append(thead);

  const tbody = document.createElement('tbody');
  sessions.forEach((session) => {
    const row = document.createElement('tr');
    appendTableCell(row, session.name || session.id);
    appendTableCell(row, session.status || 'unknown');
    appendTableCell(row, session.agentRuntimeStatus || 'unknown');
    appendTableCell(row, session.agent || 'unknown');
    appendTableCell(row, session.origin?.id || 'None');
    appendTableCell(row, formatTimestamp(session.startedAt));
    tbody.append(row);
  });
  table.append(tbody);
  wrapper.append(table);
  return wrapper;
}

export function filterAgentChatSessions(sessions) {
  return Array.isArray(sessions) ? sessions.filter(isAgentChatSession) : [];
}

export function createAgentChatOverview(subscriptions, chatSessions) {
  const card = document.createElement('article');
  card.className = 'wm-card';
  card.style.cssText = 'margin-top:12px;padding:14px;';
  card.setAttribute('data-testid', 'agent-chat-operator-overview');

  const heading = document.createElement('h4');
  heading.textContent = 'Operator Overview';
  card.append(heading);

  const blockedIntercepts = subscriptions.reduce((count, subscription) => (
    count + (subscription.operator?.blockedInterceptCount ?? 0)
  ), 0);

  const summary = document.createElement('p');
  summary.className = 'wm-settings__port-note';
  summary.textContent = `${subscriptions.length} subscriptions, ${chatSessions.length} Agent Chat sessions, ${blockedIntercepts} blocked intercepts.`;
  card.append(summary);

  return card;
}

export function createSubscriptionCard(subscription, chatSessions, handlers) {
  const card = document.createElement('article');
  card.className = 'wm-card';
  card.style.cssText = 'margin-top:12px;padding:14px;';
  card.setAttribute('data-testid', `agent-chat-subscription-${subscription.subscriptionId}`);

  const heading = document.createElement('h4');
  heading.textContent = `${subscription.workspaceOwnerNpub} → ${subscription.botNpub}`;
  card.append(heading);

  const status = document.createElement('p');
  status.className = 'wm-settings__port-note';
  status.textContent = `health=${subscription.healthStatus}, enabled=${subscription.operator?.enabled ? 'yes' : 'no'}, ws_key=${subscription.wsKeyStatus}, group_keys=${subscription.groupKeyStatus}, sse=${subscription.sseStatus}`;
  card.append(status);

  card.append(createDetailList([
    ['Backend', subscription.backendBaseUrl],
    ['Source App', subscription.sourceAppNpub],
    ['ws_key_npub', subscription.wsKeyNpub || 'pending'],
    ['Latest Chat Trail', formatTrail(subscription)],
    ['Last SSE Event ID', subscription.diagnostics?.lastSseEventId || 'None'],
    ['Last Advisory', formatAdvisory(subscription)],
    ['Advisory Payload', formatKeyValueDetails(subscription.lastSseEvent?.payload)],
    ['Last Record Pull', formatDiagnostic(subscription.lastRecordPullResult)],
    ['Record Pull Details', formatKeyValueDetails(subscription.lastRecordPullResult?.details)],
    ['Last Decrypt', formatDiagnostic(subscription.lastDecryptResult)],
    ['Decrypt Details', formatKeyValueDetails(subscription.lastDecryptResult?.details)],
    ['Last Routing', formatDiagnostic(subscription.lastRoutingResult)],
    ['Routing Details', formatKeyValueDetails(subscription.lastRoutingResult?.details)],
    ['Last Auth', formatDiagnostic(subscription.lastAuthResult)],
    ['Group Refresh', formatDiagnostic(subscription.lastGroupRefreshResult)],
    ['Startup Reload', subscription.lastSuccessfulStartupReloadAt || 'None'],
    ['Last Error', subscription.lastErrorCode ? `${subscription.lastErrorCode} @ ${subscription.lastErrorAt}` : 'None'],
  ], subscription.subscriptionId));

  card.append(createRecommendedList(subscription));
  card.append(createInterceptTable(subscription));
  card.append(createSessionTable(
    'Linked Chat Sessions',
    findLinkedSessions(subscription, chatSessions),
    `agent-chat-linked-sessions-${subscription.subscriptionId}`,
  ));

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;';
  actions.append(
    createActionButton(
      'Reconnect',
      `Reconnect Agent Chat subscription for ${subscription.workspaceOwnerNpub}`,
      `agent-chat-reconnect-${subscription.subscriptionId}`,
      () => handlers.runAction(subscription, 'reconnect'),
    ),
    createActionButton(
      'Refresh Keys',
      `Refresh Agent Chat keys for ${subscription.workspaceOwnerNpub}`,
      `agent-chat-refresh-keys-${subscription.subscriptionId}`,
      () => handlers.runAction(subscription, 'refresh-keys'),
    ),
    createActionButton(
      subscription.operator?.enabled ? 'Disable' : 'Enable',
      `${subscription.operator?.enabled ? 'Disable' : 'Enable'} Agent Chat subscription for ${subscription.workspaceOwnerNpub}`,
      `agent-chat-toggle-enabled-${subscription.subscriptionId}`,
      () => handlers.runAction(subscription, subscription.operator?.enabled ? 'disable' : 'enable'),
    ),
    createActionButton(
      'Remove',
      `Remove Agent Chat subscription for ${subscription.workspaceOwnerNpub}`,
      `agent-chat-remove-${subscription.subscriptionId}`,
      () => handlers.remove(subscription),
    ),
  );
  card.append(actions);

  return card;
}

export function createAgentChatSessionPanel(chatSessions) {
  return createSessionTable('Agent Chat Sessions', chatSessions, 'agent-chat-session-panel');
}
