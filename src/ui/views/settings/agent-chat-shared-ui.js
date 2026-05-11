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

function createDispatchReferenceCard({
  title,
  enabledAgents,
  description,
  promptPreview,
  actionLabel,
  onAction,
  actionTestId,
}) {
  const card = createCard(title, description);
  const enabled = document.createElement('p');
  enabled.className = 'wm-settings__port-note';
  enabled.textContent = enabledAgents.length > 0
    ? `Enabled on: ${enabledAgents.join(', ')}`
    : 'Enabled on: none';
  const promptLabel = document.createElement('div');
  promptLabel.className = 'wm-settings__port-note';
  promptLabel.style.marginTop = '12px';
  promptLabel.textContent = 'Current prompt template';
  const prompt = document.createElement('pre');
  prompt.style.cssText = 'margin:8px 0 0;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);background:rgba(15,23,42,0.72);overflow:auto;font-size:0.85em;line-height:1.45;white-space:pre-wrap;';
  prompt.textContent = promptPreview;
  card.append(enabled, promptLabel, prompt);
  if (typeof onAction === 'function' && typeof actionLabel === 'string' && actionLabel) {
    const actionButton = createButton(actionLabel, actionTestId, actionLabel);
    actionButton.addEventListener('click', () => onAction());
    card.append(createInlineActions(actionButton));
  }
  return card;
}

export function createStatusLine() {
  const line = document.createElement('p');
  line.className = 'wm-settings__port-note';
  line.setAttribute('aria-live', 'polite');
  return line;
}

export function createInput(labelText, placeholder, testId, optional = false) {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:10px;';
  row.textContent = labelText + (optional ? ' (optional)' : '');

  const input = document.createElement('input');
  input.className = 'wm-input';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', labelText);
  input.setAttribute('data-testid', testId);
  row.append(input);

  return { row, input };
}

export function createTextarea(labelText, placeholder, testId, rows = 10) {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:10px;';
  row.textContent = labelText;

  const textarea = document.createElement('textarea');
  textarea.className = 'wm-input';
  textarea.rows = rows;
  textarea.placeholder = placeholder;
  textarea.setAttribute('aria-label', labelText);
  textarea.setAttribute('data-testid', testId);
  textarea.style.whiteSpace = 'pre-wrap';
  row.append(textarea);

  return { row, input: textarea };
}

export function createCheckbox(labelText, testId, checked = true) {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:10px;';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('aria-label', labelText);
  input.setAttribute('data-testid', testId);

  const text = document.createElement('span');
  text.textContent = labelText;
  row.append(input, text);

  return { row, input };
}

export function createCard(title, description) {
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

export function createButton(label, testId, ariaLabel) {
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
  return button;
}

export function createInlineActions(...buttons) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;';
  row.append(...buttons);
  return row;
}

export function setPanelVisible(panel, visible) {
  panel.style.display = visible ? '' : 'none';
}

export function createPlaceholderNote(title, placeholders) {
  const wrapper = document.createElement('div');
  wrapper.style.marginTop = '10px';
  const heading = document.createElement('div');
  heading.className = 'wm-settings__port-note';
  heading.textContent = title;
  const body = document.createElement('div');
  body.className = 'wm-settings__port-note';
  body.style.marginTop = '4px';
  body.textContent = placeholders.join(', ');
  wrapper.append(heading, body);
  return wrapper;
}

export function createCapabilityPicker() {
  const fieldset = document.createElement('fieldset');
  fieldset.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:12px;padding:12px;border:1px solid var(--wm-border-muted, rgba(255,255,255,0.12));border-radius:10px;';
  fieldset.setAttribute('aria-label', 'Agent capabilities');
  fieldset.setAttribute('data-testid', 'agent-chat-agent-capabilities');

  const legend = document.createElement('legend');
  legend.textContent = 'Capabilities';
  legend.style.cssText = 'padding:0 6px;font-weight:600;';
  fieldset.append(legend);

  const note = document.createElement('p');
  note.className = 'wm-settings__port-note';
  note.style.margin = '0 0 4px 0';
  note.textContent = 'Use one local agent identity and add dispatch roles to it as new features arrive.';
  fieldset.append(note);

  const capabilityControls = [
    ['chat_intercept', createCheckbox('Chat Dispatch', 'agent-chat-capability-chat-dispatch', true)],
    ['task_dispatch', createCheckbox('Task Dispatch', 'agent-chat-capability-task-dispatch', false)],
    ['comment_dispatch', createCheckbox('Comment Dispatch', 'agent-chat-capability-comment-dispatch', false)],
    ['flow_dispatch', createCheckbox('Flow Dispatch', 'agent-chat-capability-flow-dispatch', false)],
    ['task_review', createCheckbox('Task Review', 'agent-chat-capability-task-review', false)],
    ['approval_dispatch', createCheckbox('Approval Dispatch', 'agent-chat-capability-approval-dispatch', false)],
  ];
  fieldset.append(...capabilityControls.map(([, control]) => control.row));

  return {
    row: fieldset,
    setSelectedCapabilities(capabilities = []) {
      const selected = new Set(Array.isArray(capabilities) ? capabilities : []);
      capabilityControls.forEach(([capability, control]) => {
        control.input.checked = capability === 'chat_intercept'
          ? selected.has('chat_intercept') || selected.size === 0
          : selected.has(capability);
      });
    },
    getSelectedCapabilities() {
      const capabilities = [];
      capabilityControls.forEach(([capability, control]) => {
        if (control.input.checked) {
          capabilities.push(capability);
        }
      });
      return capabilities.length > 0 ? capabilities : ['chat_intercept'];
    },
  };
}

function normaliseAgentCapabilities(agent) {
  return Array.isArray(agent?.capabilities) && agent.capabilities.length > 0
    ? agent.capabilities
    : ['chat_intercept'];
}

function findDispatchRoute(routes, triggerKind, capability) {
  return Array.isArray(routes)
    ? routes.find((route) => route.triggerKind === triggerKind && route.capability === capability) ?? null
    : null;
}

function createPipelineSelect({ title, definitions, selectedId }) {
  const label = document.createElement('label');
  label.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:12px;';
  label.textContent = `${title} pipeline`;

  const select = document.createElement('select');
  select.className = 'wm-input';
  select.setAttribute('aria-label', `${title} pipeline`);
  select.setAttribute('data-testid', `agent-chat-capability-pipeline-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);

  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = 'Use prompt dispatch';
  select.append(empty);

  definitions.forEach((definition) => {
    const option = document.createElement('option');
    option.value = definition.id || '';
    option.textContent = definition.name || definition.id || 'Pipeline';
    select.append(option);
  });
  select.value = selectedId || '';
  label.append(select);
  return { label, select };
}

function createPromptPreview({ sourceLabel, promptPreview }) {
  const details = document.createElement('details');
  details.style.marginTop = '10px';

  const summary = document.createElement('summary');
  summary.style.cssText = 'cursor:pointer;font-size:0.92em;color:var(--text-secondary);';
  summary.textContent = `Prompt preview · ${sourceLabel}`;

  const prompt = document.createElement('pre');
  prompt.className = 'wm-agent-dispatch-preview';
  prompt.textContent = promptPreview;

  details.append(summary, prompt);
  return details;
}

function createCapabilityCard({
  title,
  description,
  enabled,
  subscription,
  routeConfig,
  route,
  pipelineDefinitions = [],
  promptSource,
  promptPreview,
  onEdit,
  onToggle,
  onSaveRoute,
  onDeleteRoute,
  toggleLabel,
  toggleDisabled = false,
  toggleDisabledReason = '',
}) {
  const card = document.createElement('article');
  card.className = 'wm-agent-dispatch-capability-card';

  const headingRow = document.createElement('div');
  headingRow.style.cssText = 'display:flex;justify-content:space-between;gap:12px;align-items:flex-start;';

  const headingBlock = document.createElement('div');
  headingBlock.style.flex = '1';

  const heading = document.createElement('h5');
  heading.style.cssText = 'margin:0;';
  heading.textContent = title;

  const note = document.createElement('p');
  note.className = 'wm-settings__port-note';
  note.style.margin = '6px 0 0 0';
  note.textContent = description;
  headingBlock.append(heading, note);

  const status = createTonePill(enabled ? 'On' : 'Off', enabled ? 'success' : 'muted');
  headingRow.append(headingBlock, status);
  card.append(headingRow);

  const sourceNote = document.createElement('p');
  sourceNote.className = 'wm-settings__port-note';
  sourceNote.style.margin = '12px 0 0 0';
  sourceNote.textContent = `Prompt source: ${promptSource}`;
  card.append(sourceNote);

  card.append(createPromptPreview({ sourceLabel: promptSource, promptPreview }));

  const toggleButton = createButton(toggleLabel, null, toggleLabel);
  toggleButton.disabled = toggleDisabled;
  if (toggleDisabledReason) {
    toggleButton.title = toggleDisabledReason;
  }
  toggleButton.addEventListener('click', () => onToggle?.());

  const editButton = createButton('Edit Prompt', null, `Edit ${title} prompt`);
  editButton.disabled = typeof onEdit !== 'function';
  if (editButton.disabled) {
    editButton.title = 'Prompt editing is not available for this dispatch path yet.';
  }
  editButton.addEventListener('click', () => onEdit?.());

  card.append(createInlineActions(toggleButton, editButton));

  if (enabled && subscription && routeConfig) {
    const pipelineSelect = createPipelineSelect({
      title,
      definitions: pipelineDefinitions,
      selectedId: route?.pipelineDefinitionId || '',
    });
    const routeStatus = document.createElement('p');
    routeStatus.className = 'wm-settings__port-note';
    routeStatus.setAttribute('aria-live', 'polite');
    routeStatus.textContent = route
      ? `Pipeline route saved${route.enabled === false ? ' but disabled' : ''}.`
      : 'No pipeline route saved. Prompt dispatch will be used.';

    const savePipelineButton = createButton(
      route ? 'Update Pipeline' : 'Save Pipeline',
      null,
      `Save ${title} pipeline route`,
    );
    savePipelineButton.disabled = pipelineDefinitions.length === 0;
    savePipelineButton.addEventListener('click', async () => {
      savePipelineButton.disabled = true;
      routeStatus.textContent = 'Saving pipeline route...';
      try {
        if (!pipelineSelect.select.value) {
          routeStatus.textContent = 'Select a pipeline first, or use the prompt dispatch action.';
          return;
        }
        await onSaveRoute?.({
          routeId: route?.routeId,
          subscriptionId: subscription.subscriptionId,
          triggerKind: routeConfig.triggerKind,
          capability: routeConfig.capability,
          pipelineDefinitionId: pipelineSelect.select.value,
          enabled: true,
          priority: routeConfig.priority,
          activePolicy: routeConfig.activePolicy,
          matchJson: routeConfig.matchJson,
        });
        routeStatus.textContent = 'Pipeline route saved.';
      } catch (error) {
        routeStatus.textContent = error instanceof Error ? error.message : 'Failed to save pipeline route.';
      } finally {
        savePipelineButton.disabled = false;
      }
    });

    const removePipelineButton = createButton('Use Prompt Dispatch', null, `Remove ${title} pipeline route`);
    removePipelineButton.disabled = !route || typeof onDeleteRoute !== 'function';
    removePipelineButton.addEventListener('click', async () => {
      if (!route?.routeId) {
        return;
      }
      removePipelineButton.disabled = true;
      routeStatus.textContent = 'Removing pipeline route...';
      try {
        await onDeleteRoute(route.routeId);
        routeStatus.textContent = 'Pipeline route removed. Prompt dispatch will be used.';
      } catch (error) {
        routeStatus.textContent = error instanceof Error ? error.message : 'Failed to remove pipeline route.';
      } finally {
        removePipelineButton.disabled = false;
      }
    });

    card.append(
      pipelineSelect.label,
      createInlineActions(savePipelineButton, removePipelineButton),
      routeStatus,
    );
  }

  return card;
}

export function createConfiguredDispatchesPanel(primaryAgent, defaults = {}, options = {}) {
  const wrapper = document.createElement('div');
  wrapper.style.marginTop = '12px';

  const heading = document.createElement('h4');
  heading.textContent = 'Primary Agent';
  wrapper.append(heading);

  const note = document.createElement('p');
  note.className = 'wm-settings__port-note';
  note.textContent = primaryAgent
    ? 'Manage the shared agent identity, enabled dispatch roles, and the pipeline route for each capability.'
    : 'Create the primary agent first, then enable the dispatch roles it should handle.';
  wrapper.append(note);

  if (!primaryAgent) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No primary agent is configured yet.';
    wrapper.append(empty);
    if (typeof options.onCreateAgent === 'function') {
      const createAgentButton = createButton('Create Agent', 'agent-chat-capabilities-create-agent', 'Create primary Agent Dispatch agent');
      createAgentButton.addEventListener('click', () => options.onCreateAgent());
      wrapper.append(createInlineActions(createAgentButton));
    }
    return wrapper;
  }

  const summary = document.createElement('section');
  summary.className = 'wm-card';
  summary.style.cssText = 'padding:14px;margin-top:12px;';

  const summaryHeading = document.createElement('h5');
  summaryHeading.style.cssText = 'margin:0;';
  summaryHeading.textContent = primaryAgent.label || primaryAgent.agentId || 'Primary agent';

  const summaryNote = document.createElement('p');
  summaryNote.className = 'wm-settings__port-note';
  summaryNote.style.margin = '8px 0 0 0';
  summaryNote.textContent = `Working directory: ${primaryAgent.workingDirectory || 'Not set'}`;

  const summaryPills = document.createElement('div');
  summaryPills.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;';
  summaryPills.append(
    createTonePill(primaryAgent.enabled === false ? 'Agent Disabled' : 'Agent Enabled', primaryAgent.enabled === false ? 'warning' : 'success'),
    createTonePill(`${normaliseAgentCapabilities(primaryAgent).length} Capabilities`, 'muted'),
  );
  const summaryActions = [];
  if (typeof options.onEditAgent === 'function') {
    const editButton = createButton('Edit Agent', 'agent-chat-capabilities-edit-agent', 'Edit primary Agent Dispatch agent');
    editButton.addEventListener('click', () => options.onEditAgent(primaryAgent));
    summaryActions.push(editButton);
  }
  if (typeof options.onRemoveAgent === 'function') {
    const removeButton = createButton('Remove Agent', 'agent-chat-capabilities-remove-agent', 'Remove primary Agent Dispatch agent');
    removeButton.addEventListener('click', () => options.onRemoveAgent(primaryAgent));
    summaryActions.push(removeButton);
  }
  summary.append(summaryHeading, summaryNote, summaryPills);
  if (summaryActions.length > 0) {
    summary.append(createInlineActions(...summaryActions));
  }
  wrapper.append(summary);

  const grid = document.createElement('div');
  grid.className = 'wm-agent-dispatch-capability-grid';

  const dispatchCards = [
    {
      capability: 'chat_intercept',
      triggerKind: 'chat',
      priority: 10,
      activePolicy: 'queue',
      title: 'Chat Dispatch',
      description: 'When a workspace chat advisory matches a local agent, Wingmen reuses or creates the routed session and the agent must decide whether to respond in-thread or ignore.',
      promptKey: 'chatPromptTemplate',
      onEdit: options.onEditChatTemplate,
    },
    {
      capability: 'task_dispatch',
      triggerKind: 'task',
      priority: 20,
      activePolicy: 'skip',
      matchJson: { assignedTo: 'bot' },
      title: 'Task Dispatch',
      description: 'When a concrete ready task targets the bot, Wingmen reuses or creates the delivery session, queues the task prompt, and Night Watch keeps the worker moving.',
      promptKey: 'taskPromptTemplate',
      onEdit: options.onEditTaskTemplate,
    },
    {
      capability: 'comment_dispatch',
      triggerKind: 'comment',
      priority: 60,
      activePolicy: 'queue',
      title: 'Comment Dispatch',
      description: 'When a task or document comment arrives, Wingmen records the advisory on the comment-specific path. Execution is currently disabled while the loop guard is hardened.',
      promptKey: 'commentDispatchPromptTemplate',
      onEdit: null,
    },
    {
      capability: 'flow_dispatch',
      triggerKind: 'flow',
      priority: 30,
      activePolicy: 'skip',
      title: 'Flow Dispatch',
      description: 'When a kickoff task is new, assigned to the bot, and has a flow without a flow run, Wingmen routes it into a short-lived orchestration session.',
      promptKey: 'flowDispatchPromptTemplate',
      onEdit: options.onEditFlowDispatchTemplate,
    },
    {
      capability: 'task_review',
      triggerKind: 'task_review',
      priority: 40,
      activePolicy: 'skip',
      title: 'Task Review',
      description: 'When a flow-run task moves to review, Wingmen routes it into orchestration so newly-unblocked downstream tasks can be promoted in one pass.',
      promptKey: 'taskReviewPromptTemplate',
      onEdit: options.onEditTaskReviewTemplate,
    },
    {
      capability: 'approval_dispatch',
      triggerKind: 'approval',
      priority: 50,
      activePolicy: 'queue',
      title: 'Approval Dispatch',
      description: 'When an approval record transitions to approved for a live flow run, Wingmen routes it into orchestration so downstream tasks can continue.',
      promptKey: 'approvalDispatchPromptTemplate',
      onEdit: options.onEditApprovalDispatchTemplate,
    },
  ];

  const selectedCapabilities = new Set(normaliseAgentCapabilities(primaryAgent));
  grid.append(...dispatchCards.map((cardConfig) => {
    const promptOverride = typeof primaryAgent?.[cardConfig.promptKey] === 'string'
      ? primaryAgent[cardConfig.promptKey]
      : '';
    const defaultPrompt = typeof defaults?.[cardConfig.promptKey] === 'string'
      ? defaults[cardConfig.promptKey]
      : '';
    const preview = promptOverride || defaultPrompt || `No ${cardConfig.title.toLowerCase()} prompt is configured yet.`;
    const promptSource = promptOverride
      ? 'Agent override'
      : defaultPrompt
        ? 'Workspace default'
        : 'Missing';
    const enabled = primaryAgent.enabled !== false && selectedCapabilities.has(cardConfig.capability);
    const lastEnabledCapability = selectedCapabilities.size === 1 && selectedCapabilities.has(cardConfig.capability);
    const route = findDispatchRoute(options.dispatchRoutes, cardConfig.triggerKind, cardConfig.capability);

    return createCapabilityCard({
      title: cardConfig.title,
      description: cardConfig.description,
      enabled,
      subscription: options.subscription,
      routeConfig: cardConfig,
      route,
      pipelineDefinitions: Array.isArray(options.pipelineDefinitions) ? options.pipelineDefinitions : [],
      promptSource,
      promptPreview: preview,
      onEdit: typeof cardConfig.onEdit === 'function' ? () => cardConfig.onEdit(primaryAgent) : null,
      onToggle: typeof options.onToggleCapability === 'function'
        ? () => options.onToggleCapability(primaryAgent, cardConfig.capability, enabled)
        : null,
      onSaveRoute: options.onSaveRoute,
      onDeleteRoute: options.onDeleteRoute,
      toggleLabel: enabled ? 'Turn Off' : 'Turn On',
      toggleDisabled: primaryAgent.enabled === false || (lastEnabledCapability && enabled),
      toggleDisabledReason: primaryAgent.enabled === false
        ? 'Enable the agent first.'
        : lastEnabledCapability && enabled
          ? 'At least one dispatch capability must remain enabled on the agent.'
          : '',
    });
  }));
  wrapper.append(grid);

  return wrapper;
}

export { createTonePill, formatCapability };
