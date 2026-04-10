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

function formatCapability(capability) {
  if (capability === 'chat_intercept') {
    return 'Chat Dispatch';
  }
  if (capability === 'task_dispatch') {
    return 'Task Dispatch';
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

  const chatIntercept = createCheckbox('Chat Dispatch', 'agent-chat-capability-chat-dispatch', true);
  const taskDispatch = createCheckbox('Task Dispatch', 'agent-chat-capability-task-dispatch', false);
  fieldset.append(chatIntercept.row, taskDispatch.row);

  return {
    row: fieldset,
    setSelectedCapabilities(capabilities = []) {
      const selected = new Set(Array.isArray(capabilities) ? capabilities : []);
      chatIntercept.input.checked = selected.has('chat_intercept') || selected.size === 0;
      taskDispatch.input.checked = selected.has('task_dispatch');
    },
    getSelectedCapabilities() {
      const capabilities = [];
      if (chatIntercept.input.checked) capabilities.push('chat_intercept');
      if (taskDispatch.input.checked) capabilities.push('task_dispatch');
      return capabilities.length > 0 ? capabilities : ['chat_intercept'];
    },
  };
}

export function createConfiguredDispatchesPanel(agents, options = {}) {
  const wrapper = document.createElement('div');
  wrapper.style.marginTop = '12px';

  const heading = document.createElement('h4');
  heading.textContent = 'Configured Dispatches';
  wrapper.append(heading);

  const note = document.createElement('p');
  note.className = 'wm-settings__port-note';
  note.textContent = 'This is the current local dispatch policy: which agent capabilities are enabled, what they do, and the prompt contract each runtime uses.';
  wrapper.append(note);

  const agentList = Array.isArray(agents) ? agents : [];
  const chatAgents = agentList
    .filter((agent) => agent.enabled !== false && (agent.capabilities ?? ['chat_intercept']).includes('chat_intercept'));
  const taskAgents = agentList
    .filter((agent) => agent.enabled !== false && (agent.capabilities ?? []).includes('task_dispatch'));
  const primaryChatAgent = chatAgents[0] ?? null;
  const primaryTaskAgent = taskAgents[0] ?? null;

  wrapper.append(
    createDispatchReferenceCard({
      title: 'Chat Dispatch',
      enabledAgents: chatAgents.map((agent) => agent.agentId),
      description: 'When a workspace chat advisory matches a local agent, Wingmen reuses or creates the routed session and the agent must decide whether to respond in-thread or ignore.',
      promptPreview: chatAgents[0]?.chatPromptTemplate || 'No enabled chat dispatch template.',
      actionLabel: primaryChatAgent ? 'Edit Chat Template' : 'Add Chat Dispatch Agent',
      actionTestId: 'agent-chat-edit-chat-template',
      onAction: typeof options.onEditChatTemplate === 'function'
        ? () => options.onEditChatTemplate(primaryChatAgent)
        : null,
    }),
    createDispatchReferenceCard({
      title: 'Task Dispatch',
      enabledAgents: taskAgents.map((agent) => agent.agentId),
      description: 'When a task or approval advisory targets the bot, Wingmen reuses or creates the bound agent-work session, queues the work prompt, and Night Watch keeps the session progressing.',
      promptPreview: taskAgents[0]?.taskPromptTemplate || 'No enabled task dispatch template.',
      actionLabel: primaryTaskAgent ? 'Edit Task Template' : 'Add Task Dispatch Agent',
      actionTestId: 'agent-chat-edit-task-template',
      onAction: typeof options.onEditTaskTemplate === 'function'
        ? () => options.onEditTaskTemplate(primaryTaskAgent)
        : null,
    }),
  );

  return wrapper;
}

export { createTonePill, formatCapability };
