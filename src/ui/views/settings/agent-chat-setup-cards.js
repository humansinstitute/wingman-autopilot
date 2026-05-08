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

function formatCapability(capability) {
  if (capability === 'chat_intercept') {
    return 'Chat Dispatch';
  }
  if (capability === 'task_dispatch') {
    return 'Task Dispatch';
  }
  if (capability === 'comment_dispatch') {
    return 'Comment Dispatch';
  }
  if (capability === 'flow_dispatch') {
    return 'Flow Dispatch';
  }
  if (capability === 'task_review') {
    return 'Task Review';
  }
  if (capability === 'approval_dispatch') {
    return 'Approval Dispatch';
  }
  return capability;
}

function createCapabilityList(capabilities = []) {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;';

  const list = Array.isArray(capabilities) && capabilities.length > 0
    ? capabilities
    : ['chat_intercept'];

  list.forEach((capability) => {
    wrapper.append(createTonePill(formatCapability(capability), 'success'));
  });

  return wrapper;
}

function createMetricRow(items) {
  const row = document.createElement('div');
  row.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-top:12px;';
  items.forEach(({ label, value }) => {
    const tile = document.createElement('div');
    tile.style.cssText = 'padding:10px 12px;border-radius:12px;border:1px solid var(--border-primary);background:rgba(127,127,127,0.04);';

    const labelEl = document.createElement('div');
    labelEl.className = 'wm-settings__port-note';
    labelEl.textContent = label;

    const valueEl = document.createElement('div');
    valueEl.style.cssText = 'margin-top:4px;font-weight:650;';
    valueEl.textContent = value;

    tile.append(labelEl, valueEl);
    row.append(tile);
  });
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
    ? `Backend service ${backendConnection.serviceNpub}`
    : `Backend managed by ${backendConnection.managedByNpub || 'another user'}`;

  const statusRow = document.createElement('div');
  statusRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;margin-bottom:10px;';
  statusRow.append(
    createTonePill(backendConnection.sharePolicy === 'selected_users' ? 'Granted Backend' : 'Shared Service', 'success'),
    createTonePill(backendConnection.healthStatus === 'healthy' ? 'Healthy' : backendConnection.healthStatus || 'Unknown', backendConnection.healthStatus === 'healthy' ? 'success' : 'warning'),
  );

  const canUseBackend = Boolean(backendConnection.setupWorkspaceOwnerNpub && backendConnection.setupSourceAppNpub);
  const actionButton = createActionButton(
    canUseBackend ? 'Use Shared Backend' : 'Missing Setup Hints',
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
      ['Manager', backendConnection.managedByNpub || 'None'],
    ]),
    createInlineActions([actionButton]),
  );
  return wrapper;
}

export function createAgentDispatchSetupCards({
  subscription,
  primaryAgent,
  availableBackendConnections = [],
  additionalAgentCount = 0,
  onEditSubscription,
  onUseBackendConnection,
  onEditAgent,
  onCreateAgent,
  onRemoveAgent,
  onRefresh,
}) {
  const wrapper = document.createElement('div');

  const hasSubscription = Boolean(subscription);
  const hasAgent = Boolean(primaryAgent);
  const visibleBackendConnections = getAvailableBackendConnections(availableBackendConnections);
  const setupReadyBackendConnections = getSetupReadyBackendConnections(availableBackendConnections);
  const hasAvailableBackend = !hasSubscription && visibleBackendConnections.length > 0;
  const hasSetupReadyBackend = setupReadyBackendConnections.length > 0;
  const overviewCard = createCard(
    'Guided Setup',
    'Connect the workspace once, keep one local Wingman identity, and layer new dispatch roles onto that same agent instead of repeating the same values across multiple forms.',
  );

  appendStep(
    overviewCard,
    '1. Connect the workspace',
    hasSubscription
      ? `Workspace ${subscription.workspaceOwnerNpub || 'unknown'} is already connected to ${subscription.backendBaseUrl || 'the backend'}.`
      : hasSetupReadyBackend
        ? `${setupReadyBackendConnections.length} shared backend${setupReadyBackendConnections.length === 1 ? ' is' : 's are'} available. Create your own subscription from one without retyping backend details.`
        : hasAvailableBackend
          ? 'A shared backend is available, but it does not include all setup hints yet. Use the manual connection fields for the missing workspace facts.'
      : 'Save the workspace owner, backend URL, and source app once so dispatch can reuse the same live connection.',
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
  appendStep(
    overviewCard,
    '3. Expand capabilities over time',
    hasAgent
      ? 'Add or remove delivery and orchestration roles on the same agent as new runtime features arrive.'
      : 'Once the first agent exists, turn on chat, delivery, and orchestration capabilities without creating a second identity.',
    hasAgent && countEnabledCapabilities(primaryAgent) > 0,
  );

  const overviewActions = [];
  if (!hasSubscription && hasSetupReadyBackend) {
    overviewActions.push(createActionButton(
      'Use Shared Backend',
      'agent-chat-guided-use-backend',
      'Create Agent Dispatch subscription from an available shared backend',
      () => onUseBackendConnection?.(setupReadyBackendConnections[0]),
    ));
  } else if (!hasSubscription) {
    overviewActions.push(createActionButton(
      'Connect Workspace',
      'agent-chat-guided-connect',
      'Connect Agent Dispatch workspace',
      () => onEditSubscription?.(null),
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
    'Shared Connection',
    hasSubscription
      ? 'All dispatch paths reuse this single Tower connection.'
      : hasAvailableBackend
        ? 'A backend managed by another user is available. Reuse it to create your own subscription and local agent state.'
      : 'No subscription is configured yet. This is the only required connection form.',
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
    connectionCard.append(createMetricRow([
      { label: 'Recent Events', value: String(Array.isArray(subscription.recentSseEvents) ? subscription.recentSseEvents.length : 0) },
      { label: 'Dispatches', value: String(Array.isArray(subscription.recentDispatches) ? subscription.recentDispatches.length : 0) },
      { label: 'Last Event', value: formatTimestamp(subscription.lastSseEvent?.at || '') },
    ]));
    connectionCard.append(createDetailList([
      ['Workspace', subscription.workspaceOwnerNpub || 'None'],
      ['Backend', subscription.backendBaseUrl || 'None'],
      ['Backend Connection', subscription.backendConnectionId || 'Legacy direct URL'],
      ['Source App', subscription.sourceAppNpub || 'None'],
      ['Import', subscription.connectionTokenRef ? 'Agent Connect' : 'Manual'],
      ['Bot', subscription.botNpub || 'Pending'],
    ]));
  } else if (hasAvailableBackend) {
    const note = document.createElement('p');
    note.className = 'wm-settings__port-note';
    note.textContent = hasSetupReadyBackend
      ? 'Using a shared backend copies only non-secret setup facts into your user-scoped subscription. Bot identity, route state, diagnostics, and dispatch history stay separate.'
      : 'The shared backend record is visible, but it is missing workspace owner or source app setup hints. Use the manual connection fields until those hints are added.';
    connectionCard.append(note);
    const renderedBackendConnections = hasSetupReadyBackend ? setupReadyBackendConnections : visibleBackendConnections;
    renderedBackendConnections.forEach((backendConnection) => {
      connectionCard.append(createBackendConnectionChoice(backendConnection, onUseBackendConnection));
    });
  } else {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'Set the workspace owner npub, backend base URL, and source app npub here once. The agent editor should not have to repeat them.';
    connectionCard.append(empty);
  }
  if (hasSubscription || !hasSetupReadyBackend) {
    connectionCard.append(createInlineActions([
      createActionButton(
        hasSubscription ? 'Edit Connection' : 'Create Connection',
        'agent-chat-setup-edit-subscription',
        'Edit Agent Dispatch connection',
        () => onEditSubscription?.(subscription ?? null),
      ),
    ]));
  }
  wrapper.append(connectionCard);

  const agentCard = createCard(
    'Primary Agent',
    hasAgent
      ? 'This is the one local identity that should accumulate dispatch roles.'
      : 'No local agent is configured yet.',
  );
  if (hasAgent) {
    const metaRow = document.createElement('div');
    metaRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;margin-bottom:12px;';
    metaRow.append(
      createTonePill(primaryAgent.enabled === false ? 'Disabled' : 'Enabled', primaryAgent.enabled === false ? 'warning' : 'success'),
      createTonePill(`${countEnabledCapabilities(primaryAgent)} Capability${countEnabledCapabilities(primaryAgent) === 1 ? '' : 'ies'}`, countEnabledCapabilities(primaryAgent) > 0 ? 'success' : 'warning'),
      additionalAgentCount > 0
        ? createTonePill(`${additionalAgentCount} Extra Agent${additionalAgentCount === 1 ? '' : 's'}`, 'muted')
        : createTonePill('Single Agent Flow', 'muted'),
    );
    agentCard.append(metaRow);
    agentCard.append(createDetailList([
      ['Agent', primaryAgent.label || primaryAgent.agentId || 'None'],
      ['Agent ID', primaryAgent.agentId || 'None'],
      ['Working Directory', primaryAgent.workingDirectory || 'None'],
      ['Bot', subscription?.botNpub || primaryAgent.botNpub || 'None'],
      ['Workspace', subscription?.workspaceOwnerNpub || primaryAgent.workspaceOwnerNpub || 'None'],
    ]));
    agentCard.append(createCapabilityList(primaryAgent.capabilities));
    const note = document.createElement('p');
    note.className = 'wm-settings__port-note';
    note.style.marginTop = '10px';
    note.textContent = additionalAgentCount > 0
      ? 'Additional agents still exist below, but this page is optimized around one primary identity with role toggles.'
      : 'Use the Dispatch Capabilities section below to turn individual roles on and off for this same agent.';
    agentCard.append(note);
  } else {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = hasSubscription
      ? 'The connection is ready. Save one local agent and reuse the subscription bot/workspace automatically.'
      : hasSetupReadyBackend
        ? 'Use the shared backend first, then save your local agent against the new user-scoped subscription.'
      : 'Create the shared connection first, then save the primary local agent once.';
    agentCard.append(empty);
  }

  const agentActions = [];
  if (hasAgent) {
    agentActions.push(createActionButton(
      'Edit Agent',
      'agent-chat-setup-edit-agent',
      'Edit primary Agent Dispatch agent',
      () => onEditAgent?.(primaryAgent),
    ));
    agentActions.push(createActionButton(
      'Remove Agent',
      'agent-chat-setup-remove-agent',
      'Remove primary Agent Dispatch agent',
      () => onRemoveAgent?.(primaryAgent),
    ));
  } else {
    agentActions.push(createActionButton(
      'Create Agent',
      'agent-chat-setup-create-agent',
      'Create primary Agent Dispatch agent',
      () => onCreateAgent?.(),
    ));
  }
  agentCard.append(createInlineActions(agentActions));
  wrapper.append(agentCard);

  return wrapper;
}

function createRouteSelect(labelText, testId, definitions, selectedId = '') {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:10px;';
  row.textContent = labelText;

  const select = document.createElement('select');
  select.className = 'wm-input';
  select.setAttribute('aria-label', labelText);
  select.setAttribute('data-testid', testId);

  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = 'Select a pipeline';
  select.append(empty);

  definitions.forEach((definition) => {
    const option = document.createElement('option');
    option.value = definition.id || '';
    option.textContent = definition.name || definition.id || 'Pipeline';
    select.append(option);
  });
  select.value = selectedId || '';
  row.append(select);
  return { row, select };
}

function findRoute(routes, triggerKind, capability) {
  return Array.isArray(routes)
    ? routes.find((route) => route.triggerKind === triggerKind && route.capability === capability) ?? null
    : null;
}

export function createDispatchPipelineRouteCards({
  subscription,
  routes = [],
  definitions = [],
  onSaveRoute,
}) {
  const card = createCard(
    'Dispatch Pipelines',
    subscription
      ? 'Select declarative pipelines for incoming workspace advisories. Legacy prompt dispatch remains active for any capability without a route.'
      : 'Connect a workspace before choosing dispatch pipelines.',
  );
  card.setAttribute('data-testid', 'agent-chat-dispatch-pipelines');

  if (!subscription) {
    return card;
  }

  const chatRoute = findRoute(routes, 'chat', 'chat_intercept');
  const taskRoute = findRoute(routes, 'task', 'task_dispatch');
  const chatSelect = createRouteSelect('Chat pipeline', 'agent-chat-route-chat-pipeline', definitions, chatRoute?.pipelineDefinitionId || '');
  const taskSelect = createRouteSelect('Task pipeline', 'agent-chat-route-task-pipeline', definitions, taskRoute?.pipelineDefinitionId || '');

  const enabledField = document.createElement('label');
  enabledField.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:10px;';
  const enabledInput = document.createElement('input');
  enabledInput.type = 'checkbox';
  enabledInput.checked = true;
  enabledInput.setAttribute('aria-label', 'Enable saved dispatch routes');
  enabledInput.setAttribute('data-testid', 'agent-chat-route-enabled');
  const enabledText = document.createElement('span');
  enabledText.textContent = 'Enable saved routes';
  enabledField.append(enabledInput, enabledText);

  const status = document.createElement('p');
  status.className = 'wm-settings__port-note';
  status.setAttribute('aria-live', 'polite');
  status.textContent = routes.length > 0
    ? `${routes.length} route${routes.length === 1 ? '' : 's'} configured for this subscription.`
    : 'No pipeline routes configured yet.';

  const saveButton = createActionButton(
    'Save Pipeline Routes',
    'agent-chat-save-dispatch-routes',
    'Save selected Agent Dispatch pipeline routes',
    async () => {
      saveButton.disabled = true;
      status.textContent = 'Saving dispatch pipeline routes...';
      try {
        const saves = [];
        if (chatSelect.select.value) {
          saves.push(onSaveRoute?.({
            routeId: chatRoute?.routeId,
            subscriptionId: subscription.subscriptionId,
            triggerKind: 'chat',
            capability: 'chat_intercept',
            pipelineDefinitionId: chatSelect.select.value,
            enabled: enabledInput.checked,
            priority: 10,
            activePolicy: 'queue',
          }));
        }
        if (taskSelect.select.value) {
          saves.push(onSaveRoute?.({
            routeId: taskRoute?.routeId,
            subscriptionId: subscription.subscriptionId,
            triggerKind: 'task',
            capability: 'task_dispatch',
            pipelineDefinitionId: taskSelect.select.value,
            enabled: enabledInput.checked,
            priority: 20,
            activePolicy: 'skip',
            matchJson: { assignedTo: 'bot' },
          }));
        }
        await Promise.all(saves.filter(Boolean));
        status.textContent = 'Dispatch pipeline routes saved.';
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Failed to save dispatch pipeline routes.';
      } finally {
        saveButton.disabled = false;
      }
    },
  );

  if (definitions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No pipeline definitions are available yet.';
    card.append(empty);
  }
  card.append(chatSelect.row, taskSelect.row, enabledField, createInlineActions([saveButton]), status);
  return card;
}
