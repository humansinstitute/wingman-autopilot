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
    success: 'background:rgba(71,176,140,0.16);border:1px solid rgba(71,176,140,0.35);color:rgba(194,255,230,0.95);',
    warning: 'background:rgba(245,158,11,0.16);border:1px solid rgba(245,158,11,0.35);color:rgba(255,226,164,0.95);',
    danger: 'background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.35);color:rgba(255,210,210,0.95);',
    muted: 'background:rgba(148,163,184,0.12);border:1px solid rgba(148,163,184,0.24);color:rgba(226,232,240,0.92);',
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

export function createAgentDispatchSetupCards({
  subscription,
  primaryAgent,
  additionalAgentCount = 0,
  onEditSubscription,
  onEditAgent,
  onCreateAgent,
  onRemoveAgent,
  onRefresh,
}) {
  const wrapper = document.createElement('div');

  const hasSubscription = Boolean(subscription);
  const hasAgent = Boolean(primaryAgent);
  const overviewCard = createCard(
    'Guided Setup',
    'Connect the workspace once, keep one local Wingman identity, and layer new dispatch roles onto that same agent instead of repeating the same values across multiple forms.',
  );

  appendStep(
    overviewCard,
    '1. Connect the workspace',
    hasSubscription
      ? `Workspace ${subscription.workspaceOwnerNpub || 'unknown'} is already connected to ${subscription.backendBaseUrl || 'the backend'}.`
      : 'Save the workspace owner, backend URL, and source app once so dispatch can reuse the same live connection.',
    hasSubscription,
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
      ? 'Add or remove Chat Dispatch and Task Dispatch on the same agent as new runtime features arrive.'
      : 'Once the first agent exists, turn on Chat Dispatch or Task Dispatch without creating a second identity.',
    hasAgent && countEnabledCapabilities(primaryAgent) > 0,
  );

  const overviewActions = [];
  if (!hasSubscription) {
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
    connectionCard.append(createDetailList([
      ['Workspace', subscription.workspaceOwnerNpub || 'None'],
      ['Backend', subscription.backendBaseUrl || 'None'],
      ['Source App', subscription.sourceAppNpub || 'None'],
      ['Bot', subscription.botNpub || 'Pending'],
    ]));
  } else {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'Set the workspace owner npub, backend base URL, and source app npub here once. The agent editor should not have to repeat them.';
    connectionCard.append(empty);
  }
  connectionCard.append(createInlineActions([
    createActionButton(
      hasSubscription ? 'Edit Connection' : 'Create Connection',
      'agent-chat-setup-edit-subscription',
      'Edit Agent Dispatch connection',
      () => onEditSubscription?.(subscription ?? null),
    ),
  ]));
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
      ? 'Additional agents still exist below, but the main setup flow is now centered on this primary identity.'
      : 'As new runtime features arrive, add them here as capability toggles instead of creating a second local agent.';
    agentCard.append(note);
  } else {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = hasSubscription
      ? 'The connection is ready. Save one local agent and reuse the subscription bot/workspace automatically.'
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
