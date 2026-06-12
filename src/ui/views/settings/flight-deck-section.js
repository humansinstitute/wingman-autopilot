import {
  listAgentChatAgents,
  listAgentChatBackendConnections,
  listAgentChatDispatchRoutes,
  listAgentChatSubscriptions,
} from '../../services/agent-chat.js';
import { fetchSessionsApi } from '../../services/sessions.js';
import { isAgentChatSession } from '../../sessions/session-classification.js';
import { createTonePill, createButton, createInlineActions, createStatusLine } from './agent-chat-shared-ui.js';

function filterFlightDeckSessions(sessions) {
  return Array.isArray(sessions)
    ? sessions.filter((session) => (
      isAgentChatSession(session)
      || session?.metadata?.role === 'agent-work'
      || session?.origin?.type === 'agent-work'
    ))
    : [];
}

function shortenIdentifier(value, { head = 14, tail = 8 } = {}) {
  if (typeof value !== 'string' || !value) {
    return 'None';
  }
  if (value.length <= head + tail + 1) {
    return value;
  }
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function titleCaseStatus(value) {
  if (typeof value !== 'string' || !value) {
    return 'Unknown';
  }
  return value
    .split(/[_\s-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function resolveWorkspaceTitle(subscription, backendConnection = null) {
  return subscription?.profileWorkspace?.workspace?.workspaceTitle
    || subscription?.profileWorkspace?.workspace?.workspaceId
    || subscription?.workspaceId
    || subscription?.workspaceName
    || subscription?.backend?.workspaceName
    || backendConnection?.workspaceName
    || subscription?.workspaceOwnerNpub
    || 'Flight Deck Workspace';
}

function resolveWorkspaceNpub(subscription) {
  return subscription?.workspaceServiceNpub || subscription?.workspaceOwnerNpub || '';
}

function toneForStatus(value, successValues = ['healthy', 'connected', 'ready', 'verified', 'synced']) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (successValues.includes(normalized)) {
    return 'success';
  }
  if (normalized === 'disabled' || normalized === 'failed' || normalized === 'error') {
    return 'danger';
  }
  if (!normalized || normalized === 'unknown') {
    return 'muted';
  }
  return 'warning';
}

function createEventPollPill(subscription) {
  if (!subscription || subscription.onboardingSource !== 'nostr_33357') {
    return createTonePill('Poll N/A', 'muted');
  }
  const okAt = Date.parse(subscription.lastEventPollOkAt || '');
  const errorAt = Date.parse(subscription.lastEventPollErrorAt || '');
  if (Number.isFinite(errorAt) && (!Number.isFinite(okAt) || errorAt > okAt)) {
    return createTonePill('Poll Error', 'danger');
  }
  if (!Number.isFinite(okAt)) {
    return createTonePill('Poll Pending', 'warning');
  }
  const ageSeconds = Math.max(0, Math.round((Date.now() - okAt) / 1000));
  if (ageSeconds > 45) {
    return createTonePill(`Poll Stale ${ageSeconds}s`, 'danger');
  }
  return createTonePill(`Poll OK ${ageSeconds}s`, 'success');
}

function createPillRow(pills) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;';
  row.append(...pills);
  return row;
}

function createMetricGrid(items) {
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:10px;margin-top:12px;';

  items.forEach(({ label, value }) => {
    const tile = document.createElement('div');
    tile.style.cssText = 'padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.025);';

    const labelEl = document.createElement('div');
    labelEl.className = 'wm-settings__port-note';
    labelEl.textContent = label;

    const valueEl = document.createElement('div');
    valueEl.style.cssText = 'font-size:1.1rem;font-weight:700;margin-top:4px;word-break:break-word;';
    valueEl.textContent = String(value ?? 0);
    valueEl.title = valueEl.textContent;

    tile.append(labelEl, valueEl);
    grid.append(tile);
  });

  return grid;
}

function createDefinitionGrid(rows) {
  const grid = document.createElement('dl');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px 16px;margin:12px 0 0;';

  rows.forEach(([label, value]) => {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.02);';

    const term = document.createElement('dt');
    term.className = 'wm-settings__port-note';
    term.textContent = label;

    const detail = document.createElement('dd');
    detail.style.cssText = 'margin:4px 0 0;word-break:break-word;';
    detail.textContent = value || 'None';
    detail.title = value || '';

    wrapper.append(term, detail);
    grid.append(wrapper);
  });

  return grid;
}

function formatDiagnosticTime(value) {
  if (typeof value !== 'string' || !value) return 'None';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function summarizeObject(value) {
  if (!value || typeof value !== 'object') return '';
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== null && entryValue !== undefined && entryValue !== '')
    .slice(0, 5);
  return entries.map(([key, entryValue]) => `${key}: ${String(entryValue)}`).join(' · ');
}

function createDiagnosticTable({ title, rows, columns, emptyText, testId }) {
  const section = document.createElement('section');
  section.style.cssText = 'margin-top:14px;';
  section.setAttribute('data-testid', testId);

  const heading = document.createElement('h4');
  heading.textContent = title;
  heading.style.cssText = 'margin:0 0 8px;font-size:0.95rem;';
  section.append(heading);

  if (!Array.isArray(rows) || rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = emptyText;
    section.append(empty);
    return section;
  }

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'overflow:auto;border:1px solid rgba(255,255,255,0.08);border-radius:8px;';
  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:0.86rem;min-width:680px;';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  columns.forEach((column) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = column.label;
    th.style.cssText = 'text-align:left;padding:8px;border-bottom:1px solid rgba(255,255,255,0.08);color:var(--muted);font-weight:600;';
    headerRow.append(th);
  });
  thead.append(headerRow);

  const tbody = document.createElement('tbody');
  rows.forEach((row, rowIndex) => {
    const tr = document.createElement('tr');
    tr.setAttribute('data-testid', `${testId}-row-${rowIndex}`);
    columns.forEach((column) => {
      const td = document.createElement('td');
      td.style.cssText = 'padding:8px;border-top:1px solid rgba(255,255,255,0.05);vertical-align:top;word-break:break-word;';
      const value = column.render(row);
      td.textContent = value || 'None';
      td.title = value || '';
      tr.append(td);
    });
    tbody.append(tr);
  });

  table.append(thead, tbody);
  wrapper.append(table);
  section.append(wrapper);
  return section;
}

function createConnectionDiagnosticsTables(subscription) {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'margin-top:12px;';
  wrapper.setAttribute('data-testid', `flight-deck-event-diagnostics-${subscription?.subscriptionId || 'unknown'}`);

  const recentSseEvents = Array.isArray(subscription?.recentSseEvents) ? subscription.recentSseEvents : [];
  const recentDispatches = Array.isArray(subscription?.recentDispatches) ? subscription.recentDispatches : [];
  const routing = subscription?.lastRoutingResult;

  wrapper.append(createDiagnosticTable({
    title: 'SSE Events',
    rows: recentSseEvents.slice().reverse().slice(0, 12),
    emptyText: 'No SSE events have been recorded for this workspace connection.',
    testId: `flight-deck-sse-events-${subscription?.subscriptionId || 'unknown'}`,
    columns: [
      { label: 'Seen', render: (event) => formatDiagnosticTime(event?.at) },
      { label: 'Type', render: (event) => event?.eventType || event?.type || '' },
      { label: 'Event id', render: (event) => shortenIdentifier(String(event?.eventId || event?.event_id || ''), { head: 14, tail: 8 }) },
      { label: 'Payload', render: (event) => summarizeObject(event?.payload) },
    ],
  }));

  wrapper.append(createDiagnosticTable({
    title: 'Dispatches',
    rows: recentDispatches.slice().reverse().slice(0, 12),
    emptyText: 'No dispatches have been recorded for this workspace connection.',
    testId: `flight-deck-dispatch-events-${subscription?.subscriptionId || 'unknown'}`,
    columns: [
      { label: 'At', render: (dispatch) => formatDiagnosticTime(dispatch?.at) },
      { label: 'Kind', render: (dispatch) => dispatch?.kind || '' },
      { label: 'Action', render: (dispatch) => dispatch?.action || '' },
      { label: 'Session', render: (dispatch) => shortenIdentifier(String(dispatch?.sessionId || ''), { head: 10, tail: 6 }) },
      { label: 'Details', render: (dispatch) => summarizeObject(dispatch?.details) },
    ],
  }));

  wrapper.append(createDiagnosticTable({
    title: 'Last Routing Result',
    rows: routing ? [routing] : [],
    emptyText: 'No routing result has been recorded for this workspace connection.',
    testId: `flight-deck-routing-result-${subscription?.subscriptionId || 'unknown'}`,
    columns: [
      { label: 'At', render: (result) => formatDiagnosticTime(result?.at) },
      { label: 'OK', render: (result) => String(result?.ok ?? '') },
      { label: 'Code', render: (result) => result?.code || '' },
      { label: 'Message', render: (result) => result?.message || '' },
      { label: 'Details', render: (result) => summarizeObject(result?.details) },
    ],
  }));

  return wrapper;
}

function getBackendConnectionForSubscription(subscription, backendConnections) {
  if (!subscription?.backendConnectionId || !Array.isArray(backendConnections)) {
    return null;
  }
  return backendConnections.find((connection) => connection?.backendConnectionId === subscription.backendConnectionId) ?? null;
}

function getAgentForSubscription(subscription, agents) {
  if (!subscription || !Array.isArray(agents)) {
    return null;
  }
  const workspaceNpub = subscription.workspaceServiceNpub || subscription.workspaceOwnerNpub;
  return agents.find((agent) => (
    agent?.workspaceOwnerNpub === workspaceNpub
    && agent?.botNpub === subscription.botNpub
  )) ?? null;
}

function getRoutesForSubscription(subscription, dispatchRoutes) {
  if (!subscription?.subscriptionId || !Array.isArray(dispatchRoutes)) {
    return [];
  }
  return dispatchRoutes.filter((route) => route?.subscriptionId === subscription.subscriptionId);
}

function countEnabledRoutes(routes) {
  return Array.isArray(routes) ? routes.filter((route) => route?.enabled !== false).length : 0;
}

function countVisibleTargets(subscription) {
  const visibleContext = subscription?.profileWorkspace?.visibleContext;
  const scopes = Array.isArray(visibleContext?.scopes) ? visibleContext.scopes.length : 0;
  const channels = Array.isArray(visibleContext?.channels) ? visibleContext.channels.length : 0;
  return { scopes, channels };
}

function countAppendedContext(subscription) {
  const contexts = subscription?.profileWorkspace?.appendedContexts;
  return Array.isArray(contexts) ? contexts.length : 0;
}

function isExplicitOnboardedWorkspace(subscription) {
  return subscription?.onboardingSource === 'nostr_33357';
}

function isRevokedOrDeletedWorkspace(subscription) {
  const onboardingStatus = subscription?.profileWorkspace?.workspace?.relayOnboardingStatus;
  return onboardingStatus === 'revoked'
    || onboardingStatus === 'deleted'
    || subscription?.wsKeyStatus === 'revoked'
    || subscription?.groupKeyStatus === 'revoked'
    || subscription?.lastErrorCode === 'workspace_access_revoked';
}

function isExplicitActiveOnboardedWorkspace(subscription) {
  return isExplicitOnboardedWorkspace(subscription) && !isRevokedOrDeletedWorkspace(subscription);
}

function createDiagnosticHistorySection(subscriptions) {
  const diagnostics = document.createElement('section');
  diagnostics.className = 'wm-card';
  diagnostics.style.cssText = 'padding:14px;margin-top:12px;';
  diagnostics.setAttribute('data-testid', 'flight-deck-diagnostics-history');

  const heading = document.createElement('h3');
  heading.textContent = 'Diagnostics';
  diagnostics.append(heading);

  subscriptions.forEach((subscription) => {
    const status = subscription?.profileWorkspace?.workspace?.relayOnboardingStatus
      || subscription?.lastAuthResult?.details?.tower_result
      || 'revoked';
    const row = document.createElement('div');
    row.style.cssText = 'padding:10px 0;border-top:1px solid rgba(255,255,255,0.08);';
    row.setAttribute('data-testid', `flight-deck-diagnostic-${subscription?.subscriptionId || 'unknown'}`);

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700;word-break:break-word;';
    title.textContent = resolveWorkspaceTitle(subscription);

    const detail = document.createElement('p');
    detail.className = 'wm-settings__port-note';
    detail.textContent = [
      `Onboarding ${titleCaseStatus(status)}`,
      subscription?.lastAuthResult?.message || subscription?.lastRecordPullResult?.message || '',
      subscription?.lastAuthResult?.details?.source_33357_event_id
        ? `event ${shortenIdentifier(subscription.lastAuthResult.details.source_33357_event_id)}`
        : '',
    ].filter(Boolean).join(' · ');

    row.append(title, detail);
    diagnostics.append(row);
  });

  return diagnostics;
}

export function createFlightDeckConnectionsPanel({
  subscriptions,
  backendConnections = [],
  agents = [],
  chatSessions = [],
  dispatchRoutes = [],
  onManageDispatch,
  onRefresh,
} = {}) {
  const explicitList = Array.isArray(subscriptions) ? subscriptions.filter(isExplicitOnboardedWorkspace) : [];
  const list = explicitList.filter(isExplicitActiveOnboardedWorkspace);
  const diagnosticList = explicitList.filter(isRevokedOrDeletedWorkspace);
  const panel = document.createElement('div');
  panel.className = 'wm-settings__flight-deck';
  panel.setAttribute('data-testid', 'flight-deck-settings-panel');

  const summaryCard = document.createElement('section');
  summaryCard.className = 'wm-card';
  summaryCard.style.cssText = 'padding:14px;';

  const heading = document.createElement('h2');
  heading.textContent = 'Flight Deck';
  summaryCard.append(heading);

  summaryCard.append(createMetricGrid([
    { label: 'Onboarded Workspaces', value: list.length },
    { label: 'Healthy', value: list.filter((subscription) => subscription?.healthStatus === 'healthy').length },
    { label: 'Events Connected', value: list.filter((subscription) => subscription?.sseStatus === 'connected').length },
    { label: 'Diagnostics', value: diagnosticList.length },
    { label: 'Default Dispatch', value: list.filter((subscription) => {
      const agent = getAgentForSubscription(subscription, agents);
      return Boolean(agent && countEnabledRoutes(getRoutesForSubscription(subscription, dispatchRoutes)) > 0);
    }).length },
    { label: 'Active Sessions', value: Array.isArray(chatSessions) ? chatSessions.length : 0 },
  ]));

  const summaryActions = [];
  if (typeof onRefresh === 'function') {
    const refreshButton = createButton('Refresh', 'flight-deck-refresh', 'Refresh Flight Deck connections');
    refreshButton.addEventListener('click', () => onRefresh());
    summaryActions.push(refreshButton);
  }
  if (typeof onManageDispatch === 'function') {
    const manageButton = createButton('Manage Dispatch', 'flight-deck-manage-dispatch', 'Open Agent Dispatch settings');
    manageButton.addEventListener('click', () => onManageDispatch());
    summaryActions.push(manageButton);
  }
  if (summaryActions.length > 0) {
    summaryCard.append(createInlineActions(...summaryActions));
  }
  panel.append(summaryCard);

  if (list.length === 0) {
    const empty = document.createElement('section');
    empty.className = 'wm-card';
    empty.style.cssText = 'padding:14px;margin-top:12px;';
    const emptyHeading = document.createElement('h3');
    emptyHeading.textContent = 'No Onboarded Workspaces';
    const emptyNote = document.createElement('p');
    emptyNote.className = 'wm-settings__port-note';
    emptyNote.textContent = 'No kind 33357 workspace onboarding events have been imported for this agent.';
    empty.append(emptyHeading, emptyNote);
    panel.append(empty);
    if (diagnosticList.length > 0) {
      panel.append(createDiagnosticHistorySection(diagnosticList));
    }
    return panel;
  }

  list.forEach((subscription) => {
    const backendConnection = getBackendConnectionForSubscription(subscription, backendConnections);
    const agent = getAgentForSubscription(subscription, agents);
    const routes = getRoutesForSubscription(subscription, dispatchRoutes);
    const enabledRoutes = countEnabledRoutes(routes);
    const dispatchReady = Boolean(agent && enabledRoutes > 0);
    const targets = countVisibleTargets(subscription);
    const appendedContextCount = countAppendedContext(subscription);
    const profileWorkspace = subscription?.profileWorkspace?.workspace;
    const workspaceTitle = resolveWorkspaceTitle(subscription, backendConnection);
    const onboardingStatus = profileWorkspace?.relayOnboardingStatus || 'unknown';
    const yokeStatus = profileWorkspace?.yokeSyncStatus || subscription?.groupKeyStatus || 'unknown';

    const card = document.createElement('article');
    card.className = 'wm-card';
    card.style.cssText = 'padding:14px;margin-top:12px;';
    card.setAttribute('data-testid', `flight-deck-connection-${subscription?.subscriptionId || 'unknown'}`);

    const cardHeading = document.createElement('h3');
    cardHeading.textContent = workspaceTitle;
    card.append(cardHeading);

    const identity = document.createElement('p');
    identity.className = 'wm-settings__port-note';
    identity.textContent = `workspace ${shortenIdentifier(resolveWorkspaceNpub(subscription), { head: 18, tail: 10 })} · tower ${subscription?.backendBaseUrl || profileWorkspace?.towerUrl || 'unknown'} · app ${shortenIdentifier(subscription?.sourceAppNpub)} · bot ${shortenIdentifier(subscription?.botNpub)}`;
    identity.title = [
      subscription?.backendBaseUrl || profileWorkspace?.towerUrl || '',
      resolveWorkspaceNpub(subscription),
      subscription?.workspaceOwnerNpub || '',
      subscription?.botNpub || '',
      subscription?.sourceAppNpub || '',
    ].filter(Boolean).join('\n');
    card.append(identity);

    card.append(createPillRow([
      createTonePill(titleCaseStatus(subscription?.healthStatus), toneForStatus(subscription?.healthStatus, ['healthy'])),
      createTonePill(subscription?.sseStatus === 'connected' ? 'Events Connected' : `Events ${titleCaseStatus(subscription?.sseStatus)}`, toneForStatus(subscription?.sseStatus, ['connected'])),
      createEventPollPill(subscription),
      createTonePill(`Onboarding ${titleCaseStatus(onboardingStatus)}`, toneForStatus(onboardingStatus)),
      createTonePill(`Yoke ${titleCaseStatus(yokeStatus)}`, toneForStatus(yokeStatus)),
      createTonePill(dispatchReady ? 'Default Dispatch Ready' : 'Dispatch Setup Pending', dispatchReady ? 'success' : 'warning'),
    ]));

    card.append(createDefinitionGrid([
      ['Workspace id', subscription?.workspaceId || profileWorkspace?.workspaceId || 'unknown'],
      ['Workspace service', shortenIdentifier(resolveWorkspaceNpub(subscription), { head: 20, tail: 10 })],
      ['Workspace member owner', shortenIdentifier(subscription?.workspaceOwnerNpub, { head: 20, tail: 10 })],
      ['Tower service', subscription?.backendBaseUrl || profileWorkspace?.towerUrl || 'unknown'],
      ['Connection source', 'kind 33357'],
      ['Default dispatch routes', `${enabledRoutes}/${routes.length} enabled`],
      ['Visible scopes', String(targets.scopes)],
      ['Visible channels', String(targets.channels)],
      ['Appended context', String(appendedContextCount)],
    ]));

    card.append(createConnectionDiagnosticsTables(subscription));

    if (typeof onManageDispatch === 'function') {
      const manageButton = createButton('Manage Dispatch', `flight-deck-manage-${subscription?.subscriptionId || 'unknown'}`, `Open Agent Dispatch settings for ${workspaceTitle}`);
      manageButton.addEventListener('click', () => onManageDispatch(subscription));
      card.append(createInlineActions(manageButton));
    }

    panel.append(card);
  });

  if (diagnosticList.length > 0) {
    panel.append(createDiagnosticHistorySection(diagnosticList));
  }

  return panel;
}

export function createFlightDeckSection({ onManageDispatch } = {}) {
  const container = document.createElement('div');
  container.className = 'wm-settings__flight-deck-shell';
  const statusLine = createStatusLine();

  async function refresh() {
    statusLine.textContent = 'Loading Flight Deck connections...';
    try {
      const [subscriptions, backendConnections, agentPayload, sessionPayload, dispatchRoutes] = await Promise.all([
        listAgentChatSubscriptions(),
        listAgentChatBackendConnections().catch(() => []),
        listAgentChatAgents().catch(() => ({ agents: [] })),
        fetchSessionsApi().catch(() => ({ sessions: [] })),
        listAgentChatDispatchRoutes().catch(() => []),
      ]);
      const allSessions = Array.isArray(sessionPayload?.sessions) ? sessionPayload.sessions : [];
      const panel = createFlightDeckConnectionsPanel({
        subscriptions,
        backendConnections,
        agents: Array.isArray(agentPayload?.agents) ? agentPayload.agents : [],
        chatSessions: filterFlightDeckSessions(allSessions),
        dispatchRoutes,
        onManageDispatch,
        onRefresh: refresh,
      });
      container.replaceChildren(panel, statusLine);
      const onboardedCount = Array.isArray(subscriptions) ? subscriptions.filter(isExplicitActiveOnboardedWorkspace).length : 0;
      statusLine.textContent = `Flight Deck onboarded workspaces refreshed: ${onboardedCount} workspace${onboardedCount === 1 ? '' : 's'}.`;
    } catch (error) {
      const failed = document.createElement('section');
      failed.className = 'wm-card';
      failed.style.cssText = 'padding:14px;';
      const heading = document.createElement('h2');
      heading.textContent = 'Flight Deck';
      const note = document.createElement('p');
      note.className = 'wm-settings__port-note';
      note.textContent = error instanceof Error ? error.message : 'Failed to load Flight Deck connections.';
      failed.append(heading, note);
      container.replaceChildren(failed, statusLine);
      statusLine.textContent = '';
    }
  }

  void refresh();
  container.append(statusLine);
  return container;
}
