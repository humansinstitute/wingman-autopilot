function createCard(title, description) {
  const card = document.createElement('section');
  card.className = 'wm-card';
  card.style.cssText = 'padding:14px;margin-top:12px;';

  const heading = document.createElement('h4');
  heading.textContent = title;
  card.append(heading);

  if (description) {
    const note = document.createElement('p');
    note.className = 'wm-settings__port-note';
    note.textContent = description;
    card.append(note);
  }

  return card;
}

function createDetailList(rows) {
  const details = document.createElement('dl');
  details.style.cssText = 'display:grid;grid-template-columns:max-content 1fr;gap:6px 12px;font-size:0.92em;margin:0;';
  rows.forEach(([labelText, valueText]) => {
    const term = document.createElement('dt');
    term.textContent = labelText;
    const value = document.createElement('dd');
    value.textContent = valueText;
    value.style.margin = '0';
    details.append(term, value);
  });
  return details;
}

function createTonePill(label, tone = 'muted') {
  const pill = document.createElement('span');
  const styles = {
    success: 'background:var(--wm-pill-success-bg);border:1px solid var(--wm-pill-success-border);color:var(--wm-pill-success-fg);',
    warning: 'background:var(--wm-pill-warning-bg);border:1px solid var(--wm-pill-warning-border);color:var(--wm-pill-warning-fg);',
    danger: 'background:var(--wm-pill-danger-bg);border:1px solid var(--wm-pill-danger-border);color:var(--wm-pill-danger-fg);',
    muted: 'background:var(--wm-pill-muted-bg);border:1px solid var(--wm-pill-muted-border);color:var(--wm-pill-muted-fg);',
  };
  pill.style.cssText = `display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;font-size:0.85em;${styles[tone] || styles.muted}`;
  pill.textContent = label;
  return pill;
}

function createActionButton(label, testId, ariaLabel, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wm-button secondary';
  button.textContent = label;
  if (testId) {
    button.setAttribute('data-testid', testId);
  }
  if (ariaLabel) {
    button.setAttribute('aria-label', ariaLabel);
  }
  if (typeof onClick === 'function') {
    button.addEventListener('click', onClick);
  }
  return button;
}

function createInlineActions(buttons) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;';
  buttons.forEach((button) => row.append(button));
  return row;
}

function formatTimestamp(value) {
  if (typeof value !== 'string' || !value) {
    return 'None';
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

function appendStep(card, title, description, complete) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:12px;align-items:flex-start;margin-top:12px;';

  const marker = createTonePill(complete ? 'Ready' : 'Needed', complete ? 'success' : 'warning');
  marker.style.marginTop = '2px';

  const body = document.createElement('div');
  body.style.flex = '1';

  const heading = document.createElement('div');
  heading.style.cssText = 'font-weight:600;';
  heading.textContent = title;

  const note = document.createElement('p');
  note.className = 'wm-settings__port-note';
  note.style.margin = '4px 0 0 0';
  note.textContent = description;

  body.append(heading, note);
  row.append(marker, body);
  card.append(row);
}

function countEnabledCapabilities(agent) {
  if (!agent) {
    return 0;
  }
  return Array.isArray(agent.capabilities) && agent.capabilities.length > 0
    ? agent.capabilities.length
    : 1;
}

function getSetupReadyBackendConnections(backendConnections = []) {
  return Array.isArray(backendConnections)
    ? backendConnections.filter((backendConnection) => (
        backendConnection
        && backendConnection.backendConnectionId
        && backendConnection.backendBaseUrl
        && backendConnection.setupWorkspaceOwnerNpub
        && backendConnection.setupSourceAppNpub
      ))
    : [];
}

function getAvailableBackendConnections(backendConnections = []) {
  return Array.isArray(backendConnections)
    ? backendConnections.filter((backendConnection) => backendConnection?.backendConnectionId && backendConnection?.backendBaseUrl)
    : [];
}

function createBackendConnectionChoice(backendConnection, onUseBackendConnection) {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'margin-top:12px;padding:12px;border:1px solid var(--border-primary);border-radius:8px;background:rgba(127,127,127,0.04);';
  wrapper.setAttribute('data-testid', `agent-chat-available-backend-${backendConnection.backendConnectionId}`);

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:650;';
  title.textContent = backendConnection.serviceNpub
    ? `Workspace connection ${backendConnection.serviceNpub}`
    : 'Workspace connection';

  const statusRow = document.createElement('div');
  statusRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;margin-bottom:10px;';
  statusRow.append(
    createTonePill('Available to users and bot', 'success'),
    createTonePill(backendConnection.healthStatus === 'healthy' ? 'Healthy' : backendConnection.healthStatus || 'Unknown', backendConnection.healthStatus === 'healthy' ? 'success' : 'warning'),
  );

  const canUseBackend = Boolean(backendConnection.setupWorkspaceOwnerNpub && backendConnection.setupSourceAppNpub);
  const actionButton = createActionButton(
    canUseBackend ? 'Use Workspace Connection' : 'Missing Setup Hints',
    `agent-chat-use-backend-${backendConnection.backendConnectionId}`,
    `Create your Agent Dispatch subscription from backend ${backendConnection.backendConnectionId}`,
    () => {
      if (canUseBackend) {
        onUseBackendConnection?.(backendConnection);
      }
    },
  );
  actionButton.disabled = !canUseBackend;

  wrapper.append(
    title,
    statusRow,
    createDetailList([
      ['Workspace', backendConnection.setupWorkspaceOwnerNpub || 'None'],
      ['Backend', backendConnection.backendBaseUrl || 'None'],
      ['Source App', backendConnection.setupSourceAppNpub || 'None'],
    ]),
    createInlineActions([actionButton]),
  );
  return wrapper;
}

function createBackendAvailabilityEditor(backendConnection, onSaveBackendAvailability) {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'margin-top:12px;padding:12px;border:1px solid var(--border-primary);border-radius:8px;background:rgba(127,127,127,0.04);';
  wrapper.setAttribute('data-testid', 'agent-chat-backend-availability-editor');

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:650;';
  title.textContent = 'Availability';

  const help = document.createElement('p');
  help.className = 'wm-settings__port-note';
  help.style.margin = '6px 0 0 0';
  help.textContent = 'This workspace connection is available to every whitelisted user on this Wingman instance and to the shared Wingman bot.';

  const grants = Array.isArray(backendConnection.availabilityGrants)
    ? backendConnection.availabilityGrants
    : [];
  const hasSharedServiceGrant = grants.some((grant) => grant?.grantKind === 'shared_service');

  const status = document.createElement('p');
  status.className = 'wm-settings__port-note';
  status.setAttribute('aria-live', 'polite');
  status.textContent = hasSharedServiceGrant
    ? 'Shared availability is enabled.'
    : 'Apply shared availability to make this connection visible to all users.';

  const saveButton = createActionButton(
    hasSharedServiceGrant ? 'Reapply Availability' : 'Apply Availability',
    'agent-chat-save-backend-availability',
    'Apply shared workspace connection availability',
    async () => {
      saveButton.disabled = true;
      status.textContent = 'Saving backend availability...';
      try {
        const updated = await onSaveBackendAvailability?.(backendConnection, {
          allowedManagerNpubs: [],
          grantSharedService: true,
        });
        const updatedGrants = Array.isArray(updated?.availabilityGrants) ? updated.availabilityGrants : [];
        status.textContent = updatedGrants.some((grant) => grant?.grantKind === 'shared_service')
          ? 'Shared availability is enabled.'
          : 'Availability was saved, but the shared grant was not returned.';
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Failed to save backend availability.';
      } finally {
        saveButton.disabled = false;
      }
    },
  );

  wrapper.append(title, help, createInlineActions([saveButton]), status);
  return wrapper;
}

export function createAgentDispatchSetupCards({
  subscription,
  primaryAgent,
  availableBackendConnections = [],
  onConnectWorkspace,
  onEditSubscription,
  onUseBackendConnection,
  onSaveBackendAvailability,
  onEditAgent,
  onCreateAgent,
  onRefresh,
}) {
  const wrapper = document.createElement('div');

  const hasSubscription = Boolean(subscription);
  const hasAgent = Boolean(primaryAgent);
  const visibleBackendConnections = getAvailableBackendConnections(availableBackendConnections);
  const setupReadyBackendConnections = getSetupReadyBackendConnections(availableBackendConnections);
  const subscriptionBackendConnection = hasSubscription && subscription.backendConnectionId
    ? visibleBackendConnections.find((backendConnection) => backendConnection.backendConnectionId === subscription.backendConnectionId) ?? null
    : null;
  const hasAvailableBackend = !hasSubscription && visibleBackendConnections.length > 0;
  const hasSetupReadyBackend = setupReadyBackendConnections.length > 0;
  const overviewCard = createCard(
    'Setup',
    'Connect one workspace, create one local agent, then route events to pipelines.',
  );

  appendStep(
    overviewCard,
    '1. Connect the workspace',
    hasSubscription
      ? 'Workspace connection is ready.'
      : hasSetupReadyBackend
        ? `${setupReadyBackendConnections.length} workspace connection${setupReadyBackendConnections.length === 1 ? ' is' : 's are'} available.`
        : hasAvailableBackend
          ? 'A workspace connection is available, but it does not include all setup hints yet. Use the manual connection fields for the missing workspace facts.'
      : 'Paste the AgentConnect token from Flight Deck so Wingman can read the service, workspace, app, and connection token values.',
    hasSubscription || hasAvailableBackend,
  );
  appendStep(
    overviewCard,
    '2. Configure the primary agent',
    hasAgent
      ? `${primaryAgent.label || primaryAgent.agentId} is using ${countEnabledCapabilities(primaryAgent)} dispatch capability${countEnabledCapabilities(primaryAgent) === 1 ? '' : 'ies'}.`
      : 'Save one local agent identity. The shared subscription will supply the bot and workspace values automatically.',
    hasAgent,
  );
  const overviewActions = [];
  if (!hasSubscription && hasSetupReadyBackend) {
    overviewActions.push(createActionButton(
      'Use Workspace Connection',
      'agent-chat-guided-use-backend',
      'Create Agent Dispatch subscription from an available workspace connection',
      () => onUseBackendConnection?.(setupReadyBackendConnections[0]),
    ));
  } else if (!hasSubscription) {
    overviewActions.push(createActionButton(
      'Connect Workspace',
      'agent-chat-guided-connect',
      'Connect Agent Dispatch workspace',
      () => onConnectWorkspace?.(),
    ));
  } else if (!hasAgent) {
    overviewActions.push(createActionButton(
      'Configure Agent',
      'agent-chat-guided-agent',
      'Configure primary Agent Dispatch agent',
      () => onCreateAgent?.(),
    ));
  } else {
    overviewActions.push(createActionButton(
      'Edit Agent Setup',
      'agent-chat-guided-edit-agent',
      'Edit primary Agent Dispatch agent',
      () => onEditAgent?.(primaryAgent),
    ));
  }
  overviewActions.push(createActionButton(
    'Refresh View',
    'agent-chat-guided-refresh',
    'Refresh Agent Dispatch setup view',
    () => onRefresh?.(),
  ));
  overviewCard.append(createInlineActions(overviewActions));
  wrapper.append(overviewCard);

  const connectionCard = createCard(
    'Workspace Connection',
    hasSubscription
      ? 'All dispatch paths reuse this workspace connection.'
      : hasAvailableBackend
        ? 'A workspace connection is available on this Wingman instance.'
      : 'No subscription is configured yet. AgentConnect import is the preferred setup path.',
  );
  if (hasSubscription) {
    const statusRow = document.createElement('div');
    statusRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;margin-bottom:12px;';
    statusRow.append(
      createTonePill(subscription.sseStatus === 'connected' ? 'SSE Connected' : `SSE ${subscription.sseStatus || 'unknown'}`, subscription.sseStatus === 'connected' ? 'success' : 'warning'),
      createTonePill(subscription.healthStatus === 'healthy' ? 'Healthy' : subscription.healthStatus || 'Unknown', subscription.healthStatus === 'healthy' ? 'success' : 'warning'),
      createTonePill(subscription.botNpub ? 'Bot Bound' : 'Bot Pending', subscription.botNpub ? 'success' : 'warning'),
    );
    connectionCard.append(statusRow);
    connectionCard.append(createDetailList([
      ['Workspace', subscription.workspaceOwnerNpub || 'None'],
      ['Backend', subscription.backendBaseUrl || 'None'],
      ['Source App', subscription.sourceAppNpub || 'None'],
      ['Bot', subscription.botNpub || 'Pending'],
      ['Last Event', formatTimestamp(subscription.lastSseEvent?.at || '')],
    ]));
    if (subscriptionBackendConnection?.operator?.canManageAvailability) {
      connectionCard.append(createBackendAvailabilityEditor(subscriptionBackendConnection, onSaveBackendAvailability));
    }
  } else if (hasAvailableBackend) {
    const note = document.createElement('p');
    note.className = 'wm-settings__port-note';
    note.textContent = hasSetupReadyBackend
      ? 'Use the shared workspace connection to configure this Wingman without retyping backend details.'
      : 'The workspace connection is visible, but it is missing workspace owner or source app setup hints. Use the manual connection fields until those hints are added.';
    connectionCard.append(note);
    const renderedBackendConnections = hasSetupReadyBackend ? setupReadyBackendConnections : visibleBackendConnections;
    renderedBackendConnections.forEach((backendConnection) => {
      connectionCard.append(createBackendConnectionChoice(backendConnection, onUseBackendConnection));
    });
  } else {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'Use Connect Workspace to paste the AgentConnect token. Manual connection remains available for recovery or older workspaces.';
    connectionCard.append(empty);
  }
  if (hasSubscription || !hasSetupReadyBackend) {
    connectionCard.append(createInlineActions([
      createActionButton(
        hasSubscription ? 'Edit Connection' : 'Manual Connection',
        'agent-chat-setup-edit-subscription',
        'Edit Agent Dispatch connection',
        () => onEditSubscription?.(subscription ?? null),
      ),
    ]));
  }
  wrapper.append(connectionCard);

  return wrapper;
}
