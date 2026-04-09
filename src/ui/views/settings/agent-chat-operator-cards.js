import { isAgentChatSession } from '../../sessions/session-classification.js';

function isAgentDispatchSession(session) {
  return isAgentChatSession(session) || session?.metadata?.role === 'agent-work' || session?.origin?.type === 'agent-work';
}

function createSection(title, description = '') {
  const wrapper = document.createElement('section');
  wrapper.style.cssText = 'margin-top:16px;';
  const heading = document.createElement('h5');
  heading.textContent = title;
  wrapper.append(heading);
  if (description) {
    const note = document.createElement('p');
    note.className = 'wm-settings__port-note';
    note.textContent = description;
    wrapper.append(note);
  }
  return wrapper;
}

function formatDiagnostic(diagnostic) {
  if (!diagnostic) return 'None';
  const status = diagnostic.ok ? 'ok' : (diagnostic.code || 'failed');
  return `${status} at ${diagnostic.at}`;
}

function formatAdvisory(advisory) {
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

function appendTableCell(row, content) {
  const cell = document.createElement('td');
  cell.textContent = content;
  row.append(cell);
}

function createPill(text, tone = 'default') {
  const pill = document.createElement('span');
  const backgrounds = {
    default: 'rgba(56, 189, 248, 0.12)',
    success: 'rgba(34, 197, 94, 0.12)',
    warning: 'rgba(245, 158, 11, 0.14)',
    danger: 'rgba(239, 68, 68, 0.12)',
  };
  const borders = {
    default: 'rgba(56, 189, 248, 0.28)',
    success: 'rgba(34, 197, 94, 0.28)',
    warning: 'rgba(245, 158, 11, 0.32)',
    danger: 'rgba(239, 68, 68, 0.28)',
  };
  pill.textContent = text;
  pill.style.cssText = `display:inline-flex;align-items:center;padding:5px 10px;border-radius:999px;background:${backgrounds[tone] || backgrounds.default};border:1px solid ${borders[tone] || borders.default};font-size:0.84em;`;
  return pill;
}

function createPillRow(pills) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;';
  row.append(...pills);
  return row;
}

function createMetricGrid(items) {
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:14px;';
  items.forEach(({ label, value }) => {
    const tile = document.createElement('div');
    tile.style.cssText = 'padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);';
    const labelEl = document.createElement('div');
    labelEl.className = 'wm-settings__port-note';
    labelEl.textContent = label;
    const valueEl = document.createElement('div');
    valueEl.style.cssText = 'font-size:1.2rem;font-weight:600;margin-top:4px;';
    valueEl.textContent = value;
    tile.append(labelEl, valueEl);
    grid.append(tile);
  });
  return grid;
}

function createDefinitionGrid(rows) {
  const grid = document.createElement('dl');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px 16px;margin:12px 0 0;';
  rows.forEach(([termText, valueText]) => {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.02);';
    const term = document.createElement('dt');
    term.className = 'wm-settings__port-note';
    term.textContent = termText;
    const value = document.createElement('dd');
    value.style.cssText = 'margin:6px 0 0;font-size:0.95em;word-break:break-word;';
    value.textContent = valueText;
    wrapper.append(term, value);
    grid.append(wrapper);
  });
  return grid;
}

function formatEventSummary(event) {
  const familyHash = typeof event.payload?.family_hash === 'string' ? event.payload.family_hash : 'unknown-family';
  const recordId = typeof event.payload?.record_id === 'string' ? event.payload.record_id : 'no-record';
  return `${event.eventType || 'unknown'} · ${familyHash} · ${recordId}`;
}

function createTimelineList({ title, description, items, emptyText, renderItem, testId }) {
  const section = createSection(title, description);
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = emptyText;
    section.append(empty);
    return section;
  }

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:10px;';
  if (testId) {
    list.setAttribute('data-testid', testId);
  }
  items.forEach((item) => {
    const row = renderItem(item);
    list.append(row);
  });
  section.append(list);
  return section;
}

function createTimelineEntry(titleText, detailText, metaText) {
  const card = document.createElement('article');
  card.style.cssText = 'padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.02);';
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600;';
  title.textContent = titleText;
  const detail = document.createElement('div');
  detail.style.cssText = 'margin-top:4px;font-size:0.92em;word-break:break-word;';
  detail.textContent = detailText;
  const meta = document.createElement('div');
  meta.className = 'wm-settings__port-note';
  meta.style.marginTop = '6px';
  meta.textContent = metaText;
  card.append(title, detail, meta);
  return card;
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

function createLatestSsePanel(subscription) {
  const latest = subscription.lastSseEvent;
  const section = createSection(
    'Latest SSE Message',
    'This is the newest raw event the subscription recorded from the workspace stream.',
  );
  if (!latest) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No SSE message has been captured yet.';
    section.append(empty);
    return section;
  }

  section.append(createDefinitionGrid([
    ['Event ID', latest.eventId || 'None'],
    ['Type', latest.eventType || 'unknown'],
    ['At', formatTimestamp(latest.at)],
    ['Family', typeof latest.payload?.family_hash === 'string' ? latest.payload.family_hash : 'None'],
    ['Record', typeof latest.payload?.record_id === 'string' ? latest.payload.record_id : 'None'],
  ]));

  const payloadHeading = document.createElement('div');
  payloadHeading.className = 'wm-settings__port-note';
  payloadHeading.style.marginTop = '12px';
  payloadHeading.textContent = 'Payload';
  const payload = document.createElement('pre');
  payload.style.cssText = 'margin:8px 0 0;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);background:rgba(15,23,42,0.72);overflow:auto;font-size:0.85em;line-height:1.45;';
  payload.textContent = JSON.stringify(latest.payload ?? null, null, 2);
  section.append(payloadHeading, payload);
  return section;
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
  thead.innerHTML = '<tr><th>Agent</th><th>Decision</th><th>State</th><th>Channel</th><th>Thread</th><th>Pending</th><th>Session</th><th>Last Activity</th></tr>';
  table.append(thead);

  const tbody = document.createElement('tbody');
  intercepts.forEach((intercept) => {
    const row = document.createElement('tr');
    appendTableCell(row, intercept.agentId || 'unknown');
    appendTableCell(row, intercept.lastDecision || 'pending');
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

function createCandidateAgentTable(subscription) {
  const candidateAgents = Array.isArray(subscription.candidateAgents) ? subscription.candidateAgents : [];
  const wrapper = createSection('Candidate Agents');

  if (candidateAgents.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No local agents currently target this subscription bot/workspace pair.';
    wrapper.append(empty);
    return wrapper;
  }

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-top:10px;';
  list.setAttribute('data-testid', `agent-chat-candidates-${subscription.subscriptionId}`);
  candidateAgents.forEach((agent) => {
    const item = document.createElement('article');
    item.style.cssText = 'padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.02);';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;';
    title.textContent = agent.label || agent.agentId || 'unknown';
    const meta = document.createElement('div');
    meta.className = 'wm-settings__port-note';
    meta.style.marginTop = '4px';
    meta.textContent = `${agent.agentId || 'unknown'} · ${agent.enabled ? 'enabled' : 'disabled'} · ${agent.groupNpubs?.length ?? 0} groups`;
    const directory = document.createElement('div');
    directory.style.cssText = 'margin-top:6px;font-size:0.92em;word-break:break-word;';
    directory.textContent = agent.workingDirectory || 'No working directory';
    item.append(title, meta, directory);
    list.append(item);
  });
  wrapper.append(list);
  return wrapper;
}

function createSseHistoryTable(subscription) {
  const events = Array.isArray(subscription.recentSseEvents) ? subscription.recentSseEvents : [];
  return createTimelineList({
    title: 'SSE Event Stream',
    description: 'Rolling feed of the most recent SSE events recorded for this subscription.',
    testId: `agent-chat-sse-history-${subscription.subscriptionId}`,
    items: events.slice().reverse(),
    emptyText: 'No SSE activity captured yet.',
    renderItem: (event) => createTimelineEntry(
      event.eventId ? `Event ${event.eventId}` : 'Event pending',
      formatEventSummary(event),
      formatTimestamp(event.at),
    ),
  });
}

function createDispatchHistoryTable(subscription) {
  const dispatches = Array.isArray(subscription.recentDispatches) ? subscription.recentDispatches : [];
  const chatDispatches = dispatches.filter((entry) => entry.kind === 'chat');
  const workDispatches = dispatches.filter((entry) => entry.kind === 'task' || entry.kind === 'approval');
  const wrapper = document.createElement('div');
  wrapper.style.marginTop = '12px';
  wrapper.append(
    createTimelineList({
      title: 'Chat Dispatches',
      description: 'Recent chat-triggered routing decisions.',
      testId: `agent-chat-dispatch-history-chat-${subscription.subscriptionId}`,
      items: chatDispatches.slice().reverse(),
      emptyText: 'No chat dispatches recorded yet.',
      renderItem: (entry) => createTimelineEntry(
        `${entry.action || 'unknown'} · ${entry.agentId || 'unknown'}`,
        `thread binding=${entry.bindingId || entry.recordId || 'None'} · session=${entry.sessionId || 'None'}`,
        formatTimestamp(entry.at),
      ),
    }),
    createTimelineList({
      title: 'Task And Approval Dispatches',
      description: 'Recent task/approval dispatches that entered the agent-work runtime.',
      testId: `agent-chat-dispatch-history-work-${subscription.subscriptionId}`,
      items: workDispatches.slice().reverse(),
      emptyText: 'No task or approval dispatches recorded yet.',
      renderItem: (entry) => createTimelineEntry(
        `${entry.kind || 'unknown'} · ${entry.action || 'unknown'}`,
        `${entry.agentId || 'unknown'} · binding=${entry.bindingId || entry.recordId || 'None'} · session=${entry.sessionId || 'None'}`,
        formatTimestamp(entry.at),
      ),
    }),
  );
  return wrapper;
}

function findLinkedSessions(subscription, chatSessions) {
  const intercepts = Array.isArray(subscription.intercepts) ? subscription.intercepts : [];
  const sessionIds = new Set(intercepts.map((intercept) => intercept.sessionId).filter(Boolean));
  const dispatchSessionIds = Array.isArray(subscription.recentDispatches)
    ? subscription.recentDispatches.map((entry) => entry.sessionId).filter(Boolean)
    : [];
  dispatchSessionIds.forEach((sessionId) => sessionIds.add(sessionId));
  const routingKeys = new Set(intercepts.map((intercept) => intercept.routingKey).filter(Boolean));
  return chatSessions.filter((session) => sessionIds.has(session.id) || routingKeys.has(session.origin?.id));
}

function createSessionTable(title, sessions, testId) {
  const wrapper = createSection(title);

  if (!Array.isArray(sessions) || sessions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No agent dispatch sessions are currently active.';
    wrapper.append(empty);
    return wrapper;
  }

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-top:10px;';
  list.setAttribute('data-testid', testId);
  sessions.forEach((session) => {
    const item = document.createElement('article');
    item.style.cssText = 'padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.02);';
    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-weight:600;';
    titleEl.textContent = session.name || session.id;
    const meta = document.createElement('div');
    meta.className = 'wm-settings__port-note';
    meta.style.marginTop = '4px';
    meta.textContent = `${session.status || 'unknown'} · ${session.agentRuntimeStatus || 'unknown'} · ${formatTimestamp(session.startedAt)}`;
    const detail = document.createElement('div');
    detail.style.cssText = 'margin-top:6px;font-size:0.92em;word-break:break-word;';
    detail.textContent = `${session.metadata?.agentChatAgentId || session.agent || 'unknown'} · ${session.origin?.id || 'No routing key'}`;
    item.append(titleEl, meta, detail);
    list.append(item);
  });
  wrapper.append(list);
  return wrapper;
}

export function filterAgentChatSessions(sessions) {
  return Array.isArray(sessions) ? sessions.filter(isAgentDispatchSession) : [];
}

export function createAgentChatOverview(subscriptions, chatSessions) {
  const card = document.createElement('article');
  card.className = 'wm-card';
  card.style.cssText = 'margin-top:12px;padding:14px;';
  card.setAttribute('data-testid', 'agent-chat-operator-overview');

  const heading = document.createElement('h4');
  heading.textContent = 'Agent Dispatch Overview';
  card.append(heading);

  const blockedIntercepts = subscriptions.reduce((count, subscription) => (
    count + (subscription.operator?.blockedInterceptCount ?? 0)
  ), 0);

  const summary = document.createElement('p');
  summary.className = 'wm-settings__port-note';
  const agentCount = subscriptions.reduce((count, subscription) => (
    count + (subscription.operator?.candidateAgentCount ?? 0)
  ), 0);
  summary.textContent = `${subscriptions.length} subscriptions, ${agentCount} candidate agents, ${chatSessions.length} active agent sessions, ${blockedIntercepts} blocked chat intercepts.`;
  card.append(summary);
  card.append(createMetricGrid([
    { label: 'Subscriptions', value: String(subscriptions.length) },
    { label: 'Candidates', value: String(agentCount) },
    { label: 'Active Sessions', value: String(chatSessions.length) },
    { label: 'Blocked Intercepts', value: String(blockedIntercepts) },
  ]));

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

  const healthTone = subscription.healthStatus === 'healthy' ? 'success' : 'warning';
  const sseTone = subscription.sseStatus === 'connected' ? 'success' : 'warning';
  card.append(createPillRow([
    createPill(`health ${subscription.healthStatus}`, healthTone),
    createPill(subscription.operator?.enabled ? 'enabled' : 'disabled', subscription.operator?.enabled ? 'success' : 'warning'),
    createPill(`ws ${subscription.wsKeyStatus}`),
    createPill(`groups ${subscription.groupKeyStatus}`),
    createPill(`sse ${subscription.sseStatus}`, sseTone),
  ]));

  card.append(createDefinitionGrid([
    ['Backend', subscription.backendBaseUrl],
    ['Source App', subscription.sourceAppNpub],
    ['Workspace Key', subscription.wsKeyNpub || 'pending'],
    ['Latest Routing Trail', formatTrail(subscription)],
    ['Last SSE Event ID', subscription.diagnostics?.lastSseEventId || 'None'],
    ['Last Advisory', formatAdvisory(subscription.diagnostics?.advisory)],
    ['Last Record Pull', formatDiagnostic(subscription.lastRecordPullResult)],
    ['Last Decrypt', formatDiagnostic(subscription.lastDecryptResult)],
    ['Last Routing', formatDiagnostic(subscription.lastRoutingResult)],
    ['Last Auth', formatDiagnostic(subscription.lastAuthResult)],
    ['Group Refresh', formatDiagnostic(subscription.lastGroupRefreshResult)],
    ['Startup Reload', subscription.lastSuccessfulStartupReloadAt || 'None'],
    ['Last Error', subscription.lastErrorCode ? `${subscription.lastErrorCode} @ ${subscription.lastErrorAt}` : 'None'],
  ]));

  card.append(createLatestSsePanel(subscription));
  card.append(createSseHistoryTable(subscription));
  card.append(createDispatchHistoryTable(subscription));
  card.append(createRecommendedList(subscription));
  card.append(createCandidateAgentTable(subscription));
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
  return createSessionTable('Agent Dispatch Sessions', chatSessions, 'agent-chat-session-panel');
}
