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
  additionalAgentCount = 0,
  onConnectWorkspace,
  onEditSubscription,
  onUseBackendConnection,
  onSaveBackendAvailability,
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

  const agentCard = createCard(
    'Primary Agent',
    hasAgent
      ? 'This local agent handles dispatch roles for the shared Wingman bot.'
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
    ]));
    agentCard.append(createCapabilityList(primaryAgent.capabilities));
    const note = document.createElement('p');
    note.className = 'wm-settings__port-note';
    note.style.marginTop = '10px';
    note.textContent = additionalAgentCount > 0
      ? 'Additional agents still exist below; this setup path prefers one primary identity.'
      : 'Use Dispatch Capabilities below to turn roles on and off.';
    agentCard.append(note);
  } else {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = hasSubscription
      ? 'The connection is ready. Save one local agent and reuse the subscription bot/workspace automatically.'
      : hasSetupReadyBackend
        ? 'Use the workspace connection first, then save the local agent.'
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

  const routeConfigs = [
    {
      label: 'Chat pipeline',
      testId: 'agent-chat-route-chat-pipeline',
      triggerKind: 'chat',
      capability: 'chat_intercept',
      priority: 10,
      activePolicy: 'queue',
    },
    {
      label: 'Task pipeline',
      testId: 'agent-chat-route-task-pipeline',
      triggerKind: 'task',
      capability: 'task_dispatch',
      priority: 20,
      activePolicy: 'skip',
      matchJson: { assignedTo: 'bot' },
    },
    {
      label: 'Flow pipeline',
      testId: 'agent-chat-route-flow-pipeline',
      triggerKind: 'flow',
      capability: 'flow_dispatch',
      priority: 30,
      activePolicy: 'skip',
    },
    {
      label: 'Task review pipeline',
      testId: 'agent-chat-route-task-review-pipeline',
      triggerKind: 'task_review',
      capability: 'task_review',
      priority: 40,
      activePolicy: 'skip',
    },
    {
      label: 'Approval pipeline',
      testId: 'agent-chat-route-approval-pipeline',
      triggerKind: 'approval',
      capability: 'approval_dispatch',
      priority: 50,
      activePolicy: 'queue',
    },
    {
      label: 'Comment pipeline',
      testId: 'agent-chat-route-comment-pipeline',
      triggerKind: 'comment',
      capability: 'comment_dispatch',
      priority: 60,
      activePolicy: 'queue',
    },
  ];
  const routeFields = routeConfigs.map((config) => {
    const route = findRoute(routes, config.triggerKind, config.capability);
    return {
      ...config,
      route,
      select: createRouteSelect(config.label, config.testId, definitions, route?.pipelineDefinitionId || ''),
    };
  });

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
        const saves = routeFields
          .filter((field) => field.select.select.value)
          .map((field) => onSaveRoute?.({
            routeId: field.route?.routeId,
            subscriptionId: subscription.subscriptionId,
            triggerKind: field.triggerKind,
            capability: field.capability,
            pipelineDefinitionId: field.select.select.value,
            enabled: enabledInput.checked,
            priority: field.priority,
            activePolicy: field.activePolicy,
            matchJson: field.matchJson,
          }));
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
  card.append(
    ...routeFields.map((field) => field.select.row),
    enabledField,
    createInlineActions([saveButton]),
    status,
  );
  return card;
}
