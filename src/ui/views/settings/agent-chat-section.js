import { createSettingsTabs } from '../settings-tabs.js';
import {
  listAgentChatAgents,
  listAgentChatSubscriptions,
  saveAgentChatAgent,
  saveAgentChatSubscription,
  deleteAgentChatAgent,
  deleteAgentChatSubscription,
  runAgentChatSubscriptionAction,
} from '../../services/agent-chat.js';
import { fetchSessionsApi } from '../../services/sessions.js';
import { createAgentRegistryPanel } from './agent-chat-agent-cards.js';
import {
  createAgentChatOverview,
  createAgentChatSessionPanel,
  createSubscriptionCard,
  filterAgentChatSessions,
} from './agent-chat-operator-cards.js';

function createStatusLine() {
  const line = document.createElement('p');
  line.className = 'wm-settings__port-note';
  line.setAttribute('aria-live', 'polite');
  return line;
}

function createInput(labelText, placeholder, testId, optional = false) {
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

function createCheckbox(labelText, testId, checked = true) {
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

function createButton(label, testId, ariaLabel) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wm-button secondary';
  button.textContent = label;
  if (testId) button.setAttribute('data-testid', testId);
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  return button;
}

function createInlineActions(...buttons) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;';
  row.append(...buttons);
  return row;
}

function setPanelVisible(panel, visible) {
  panel.style.display = visible ? '' : 'none';
}

function createSummaryList(rows) {
  const details = document.createElement('dl');
  details.style.cssText = 'display:grid;grid-template-columns:max-content 1fr;gap:6px 12px;font-size:0.92em;margin:0;';
  rows.forEach(([labelText, valueText]) => {
    const label = document.createElement('dt');
    label.textContent = labelText;
    const value = document.createElement('dd');
    value.textContent = valueText;
    value.style.margin = '0';
    details.append(label, value);
  });
  return details;
}

function createDispatchReferenceCard({ title, enabledAgents, description, promptPreview }) {
  const card = createCard(title, description);
  const enabled = document.createElement('p');
  enabled.className = 'wm-settings__port-note';
  enabled.textContent = enabledAgents.length > 0
    ? `Enabled on: ${enabledAgents.join(', ')}`
    : 'Enabled on: none';
  const promptLabel = document.createElement('div');
  promptLabel.className = 'wm-settings__port-note';
  promptLabel.style.marginTop = '12px';
  promptLabel.textContent = 'Default prompt contract';
  const prompt = document.createElement('pre');
  prompt.style.cssText = 'margin:8px 0 0;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);background:rgba(15,23,42,0.72);overflow:auto;font-size:0.85em;line-height:1.45;white-space:pre-wrap;';
  prompt.textContent = promptPreview;
  card.append(enabled, promptLabel, prompt);
  return card;
}

function createConfiguredDispatchesPanel(agents) {
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
    .filter((agent) => agent.enabled !== false && (agent.capabilities ?? ['chat_intercept']).includes('chat_intercept'))
    .map((agent) => agent.agentId);
  const taskAgents = agentList
    .filter((agent) => agent.enabled !== false && (agent.capabilities ?? []).includes('task_dispatch'))
    .map((agent) => agent.agentId);

  wrapper.append(
    createDispatchReferenceCard({
      title: 'Chat Dispatch',
      enabledAgents: chatAgents,
      description: 'When a workspace chat advisory matches a local agent, Wingmen reuses or creates the routed session and the agent must decide whether to respond in-thread or ignore.',
      promptPreview: [
        'Agent Chat runtime event: new_session | reused_session | interrupt follow-up.',
        '',
        'Thread package:',
        '- agent_id / workspace_owner_npub / channel_id / thread_id / bot_npub',
        '- recent turns and participants',
        '- Yoke commands for context and reply-current',
        '',
        'Instructions:',
        '- Start with AGENT_CHAT_DECISION: respond or ignore',
        '- Nothing is visible unless the agent publishes back into the thread',
        '- If responding, final action must be Yoke reply-current',
      ].join('\n'),
    }),
    createDispatchReferenceCard({
      title: 'Task Dispatch',
      enabledAgents: taskAgents,
      description: 'When a task or approval advisory targets the bot, Wingmen reuses or creates the bound agent-work session, queues the work prompt, and Night Watch keeps the session progressing.',
      promptPreview: [
        'Agent work dispatch.',
        'Dispatch reason: new task | task updated | approval updated.',
        'Task id / Flow id / Flow run id / Flow step',
        'Title / Description',
        '',
        'Instructions:',
        '- Complete only the current actionable task',
        '- Inspect the board before acting',
        '- Update the board with progress or completion',
        '- Stop if blocked or awaiting approval',
      ].join('\n'),
    }),
  );

  return wrapper;
}

function createCapabilityPicker() {
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

async function loadOperatorState() {
  const [subscriptions, agents, sessionPayload] = await Promise.all([
    listAgentChatSubscriptions(),
    listAgentChatAgents(),
    fetchSessionsApi(),
  ]);
  const allSessions = Array.isArray(sessionPayload?.sessions) ? sessionPayload.sessions : [];
  return {
    subscriptions,
    agents,
    chatSessions: filterAgentChatSessions(allSessions),
  };
}

export function createAgentDispatchLauncher({ onNavigate } = {}) {
  const card = createCard(
    'Agent Dispatch',
    'Open the dedicated agent page to manage subscriptions, local agents, SSE activity, and dispatch history.',
  );
  const openButton = createButton('Open Agent Dispatch', 'agent-dispatch-open', 'Open Agent Dispatch settings');
  openButton.addEventListener('click', () => {
    if (typeof onNavigate === 'function') {
      onNavigate();
      return;
    }
    window.history.pushState({ route: 'settings' }, '', '/settings/agents');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  card.append(createInlineActions(openButton));
  return card;
}

export function createAgentChatSection({ standalone = false } = {}) {
  const container = document.createElement('div');
  container.className = 'wm-settings__agent-chat';
  let currentPrimarySubscription = null;

  if (standalone) {
    const heading = document.createElement('h2');
    heading.textContent = 'Agent Dispatch';
    container.append(heading);

    const description = document.createElement('p');
    description.className = 'wm-settings__port-note';
    description.textContent = 'Manage the workspace subscription once, reuse one local agent identity, and inspect the rolling SSE stream and recent dispatch activity without wading through raw diagnostic dumps.';
    container.append(description);
  }

  const workspaceOwnerField = createInput('Workspace Owner npub', 'npub1workspace...', 'agent-chat-workspace-owner');
  const backendUrlField = createInput('Backend Base URL', 'https://tower.example.com', 'agent-chat-backend-url');
  const sourceAppField = createInput('Source App npub', 'npub1flightdeckapp...', 'agent-chat-source-app');
  const agentIdField = createInput('Agent ID', 'agent_wm21', 'agent-chat-agent-id');
  const labelField = createInput('Agent Label', 'Wingman 21', 'agent-chat-agent-label', true);
  const agentBotField = createInput('Agent Bot npub', 'npub1bot...', 'agent-chat-agent-bot');
  const agentWorkspaceField = createInput('Agent Workspace Owner npub', 'npub1workspace...', 'agent-chat-agent-workspace-owner');
  const agentGroupsField = createInput('Group npubs', 'Leave blank to use the bot subscription groups', 'agent-chat-agent-groups', true);
  const workingDirectoryField = createInput('Working Directory', '/Users/mini/code/wingmen', 'agent-chat-agent-directory');
  const capabilityPicker = createCapabilityPicker();
  const enabledField = createCheckbox('Enabled', 'agent-chat-agent-enabled', true);
  const statusLine = createStatusLine();

  const setupSummary = document.createElement('p');
  setupSummary.className = 'wm-settings__port-note';
  setupSummary.textContent = 'The subscription owns the Tower connection. Local agents attach to that subscription and can be expanded with more capabilities over time.';

  const subscriptionSummaryContainer = document.createElement('div');
  const quickActionsCard = createCard(
    'Quick Actions',
    'Only open the editors when you need to change subscription or agent configuration.',
  );
  const openSubscriptionEditorButton = createButton(
    'Edit Subscription',
    'agent-chat-open-subscription-editor',
    'Edit Agent Dispatch subscription',
  );
  const openAgentEditorButton = createButton(
    'Add Local Agent',
    'agent-chat-open-agent-editor',
    'Add Agent Dispatch local agent',
  );
  const refreshOperatorButton = createButton(
    'Refresh View',
    'agent-chat-refresh-view',
    'Refresh Agent Dispatch operator view',
  );
  quickActionsCard.append(createInlineActions(
    openSubscriptionEditorButton,
    openAgentEditorButton,
    refreshOperatorButton,
  ));

  const subscriptionCard = createCard(
    'Workspace Subscription',
    'Create or refresh the shared SSE connection once. Agent dispatch uses the same subscription as chat dispatch.',
  );
  const saveSubscriptionButton = createButton(
    'Create / Refresh Subscription',
    'agent-chat-save',
    'Create or refresh Agent Dispatch subscription',
  );
  const closeSubscriptionEditorButton = createButton(
    'Done',
    'agent-chat-close-subscription-editor',
    'Close Agent Dispatch subscription editor',
  );
  subscriptionCard.append(
    workspaceOwnerField.row,
    backendUrlField.row,
    sourceAppField.row,
    createInlineActions(saveSubscriptionButton, closeSubscriptionEditorButton),
  );
  setPanelVisible(subscriptionCard, false);

  const agentCard = createCard(
    'Local Agent',
    'Keep one local agent and add capabilities to it. When a subscription exists, the bot and workspace fields can be prefilled from it.',
  );
  const saveAgentButton = createButton(
    'Save Local Agent',
    'agent-chat-save-agent',
    'Create or update local Agent Dispatch agent',
  );
  const agentGroupsNote = document.createElement('p');
  agentGroupsNote.className = 'wm-settings__port-note';
  agentGroupsNote.textContent = 'Leave group npubs blank to derive them from the bot groups already refreshed from Tower for this workspace subscription.';
  const closeAgentEditorButton = createButton(
    'Done',
    'agent-chat-close-agent-editor',
    'Close Agent Dispatch local agent editor',
  );
  agentCard.append(
    agentIdField.row,
    labelField.row,
    agentBotField.row,
    agentWorkspaceField.row,
    agentGroupsField.row,
    workingDirectoryField.row,
    capabilityPicker.row,
    enabledField.row,
    agentGroupsNote,
    createInlineActions(saveAgentButton, closeAgentEditorButton),
  );
  setPanelVisible(agentCard, false);

  const setupPanel = document.createElement('div');
  const agentRegistryContainer = document.createElement('div');
  const configuredDispatchesContainer = document.createElement('div');
  setupPanel.append(
    setupSummary,
    quickActionsCard,
    subscriptionSummaryContainer,
    subscriptionCard,
    agentCard,
    statusLine,
    configuredDispatchesContainer,
    agentRegistryContainer,
  );

  const operatorPanel = document.createElement('div');
  const overviewContainer = document.createElement('div');
  const sessionContainer = document.createElement('div');
  sessionContainer.setAttribute('data-testid', 'agent-chat-session-list');
  const listContainer = document.createElement('div');
  listContainer.setAttribute('data-testid', 'agent-chat-subscription-list');
  operatorPanel.append(overviewContainer, sessionContainer, listContainer);

  const populateAgentForm = (agent) => {
    agentIdField.input.value = agent.agentId || '';
    labelField.input.value = agent.label || '';
    agentBotField.input.value = agent.botNpub || '';
    agentWorkspaceField.input.value = agent.workspaceOwnerNpub || '';
    agentGroupsField.input.value = Array.isArray(agent.groupNpubs) ? agent.groupNpubs.join(', ') : '';
    workingDirectoryField.input.value = agent.workingDirectory || '';
    capabilityPicker.setSelectedCapabilities(agent.capabilities);
    enabledField.input.checked = agent.enabled !== false;
    statusLine.textContent = `Editing local agent ${agent.agentId}. Add capabilities and save to keep the same identity.`;
    agentIdField.input.focus();
  };

  const clearAgentForm = () => {
    agentIdField.input.value = '';
    labelField.input.value = '';
    agentBotField.input.value = currentPrimarySubscription?.botNpub || '';
    agentWorkspaceField.input.value = currentPrimarySubscription?.workspaceOwnerNpub || '';
    agentGroupsField.input.value = '';
    workingDirectoryField.input.value = '';
    capabilityPicker.setSelectedCapabilities(['chat_intercept']);
    enabledField.input.checked = true;
  };

  const populateSubscriptionForm = (subscription) => {
    workspaceOwnerField.input.value = subscription?.workspaceOwnerNpub || '';
    backendUrlField.input.value = subscription?.backendBaseUrl || '';
    sourceAppField.input.value = subscription?.sourceAppNpub || '';
  };

  const openSubscriptionEditor = (subscription = null) => {
    populateSubscriptionForm(subscription);
    setPanelVisible(subscriptionCard, true);
    workspaceOwnerField.input.focus();
  };

  const openAgentEditor = (agent = null) => {
    if (agent) {
      populateAgentForm(agent);
    } else {
      clearAgentForm();
      statusLine.textContent = 'Creating a local agent. Add capabilities to the same agent over time.';
    }
    setPanelVisible(agentCard, true);
    agentIdField.input.focus();
  };

  const prefillAgentFieldsFromSubscription = (subscription) => {
    if (!subscription) return;
    if (!agentBotField.input.value.trim()) {
      agentBotField.input.value = subscription.botNpub || '';
    }
    if (!agentWorkspaceField.input.value.trim()) {
      agentWorkspaceField.input.value = subscription.workspaceOwnerNpub || '';
    }
    if (!workspaceOwnerField.input.value.trim()) {
      workspaceOwnerField.input.value = subscription.workspaceOwnerNpub || '';
    }
    if (!backendUrlField.input.value.trim()) {
      backendUrlField.input.value = subscription.backendBaseUrl || '';
    }
    if (!sourceAppField.input.value.trim()) {
      sourceAppField.input.value = subscription.sourceAppNpub || '';
    }
  };

  const refreshList = async () => {
    overviewContainer.replaceChildren();
    subscriptionSummaryContainer.replaceChildren();
    configuredDispatchesContainer.replaceChildren();
    agentRegistryContainer.replaceChildren();
    listContainer.replaceChildren();
    sessionContainer.replaceChildren();
    try {
      const { subscriptions, agents, chatSessions } = await loadOperatorState();
      const primarySubscription = subscriptions[0] ?? null;
      currentPrimarySubscription = primarySubscription;
      prefillAgentFieldsFromSubscription(primarySubscription);
      configuredDispatchesContainer.append(createConfiguredDispatchesPanel(agents));

      const subscriptionSummaryCard = createCard(
        'Current Subscription',
        primarySubscription
          ? 'The shared workspace connection is live here. Open the editor only when something changes.'
          : 'No subscription is configured yet.',
      );
      if (primarySubscription) {
        subscriptionSummaryCard.append(createSummaryList([
          ['Workspace', primarySubscription.workspaceOwnerNpub || 'None'],
          ['Bot', primarySubscription.botNpub || 'pending'],
          ['Backend', primarySubscription.backendBaseUrl || 'None'],
          ['Source App', primarySubscription.sourceAppNpub || 'None'],
          ['SSE', primarySubscription.sseStatus || 'unknown'],
        ]));
        const manageSubscriptionButton = createButton(
          'Edit Subscription',
          'agent-chat-manage-subscription',
          'Edit current Agent Dispatch subscription',
        );
        manageSubscriptionButton.addEventListener('click', () => openSubscriptionEditor(primarySubscription));
        subscriptionSummaryCard.append(createInlineActions(manageSubscriptionButton));
        setPanelVisible(subscriptionCard, false);
      } else {
        const empty = document.createElement('p');
        empty.className = 'wm-settings__port-note';
        empty.textContent = 'Create the workspace subscription first so local agents can reuse it.';
        subscriptionSummaryCard.append(empty);
        setPanelVisible(subscriptionCard, true);
      }
      subscriptionSummaryContainer.append(subscriptionSummaryCard);

      agentRegistryContainer.append(createAgentRegistryPanel(agents, {
        edit: (agent) => openAgentEditor(agent),
        remove: async (agent) => {
          statusLine.textContent = `Removing local agent ${agent.agentId}...`;
          try {
            await deleteAgentChatAgent(agent.agentId);
            statusLine.textContent = `Removed local agent ${agent.agentId}.`;
            await refreshList();
          } catch (error) {
            statusLine.textContent = error instanceof Error ? error.message : 'Failed to remove local agent.';
          }
        },
      }));
      if (agents.length === 0) {
        setPanelVisible(agentCard, true);
      }

      overviewContainer.append(createAgentChatOverview(subscriptions, chatSessions));
      sessionContainer.append(createAgentChatSessionPanel(chatSessions));

      if (subscriptions.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'wm-settings__port-note';
        empty.textContent = 'No workspace subscriptions yet. Create one from the Setup tab first.';
        listContainer.append(empty);
        return;
      }

      const handlers = {
        runAction: async (subscription, action) => {
          statusLine.textContent = `Running ${action}...`;
          try {
            await runAgentChatSubscriptionAction(subscription.subscriptionId, action);
            statusLine.textContent = `Action completed: ${action}.`;
            await refreshList();
          } catch (error) {
            statusLine.textContent = error instanceof Error ? error.message : `Failed to run ${action}.`;
          }
        },
        remove: async (subscription) => {
          statusLine.textContent = 'Removing subscription...';
          try {
            await deleteAgentChatSubscription(subscription.subscriptionId);
            statusLine.textContent = 'Subscription removed.';
            await refreshList();
          } catch (error) {
            statusLine.textContent = error instanceof Error ? error.message : 'Failed to remove subscription.';
          }
        },
      };

      subscriptions.forEach((subscription) => {
        listContainer.append(createSubscriptionCard(subscription, chatSessions, handlers));
      });
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to load Agent Dispatch state.';
    }
  };

  saveSubscriptionButton.addEventListener('click', async () => {
    saveSubscriptionButton.disabled = true;
    statusLine.textContent = 'Bootstrapping subscription...';
    try {
      await saveAgentChatSubscription({
        workspaceOwnerNpub: workspaceOwnerField.input.value.trim(),
        backendBaseUrl: backendUrlField.input.value.trim(),
        sourceAppNpub: sourceAppField.input.value.trim(),
      });
      statusLine.textContent = 'Subscription saved.';
      setPanelVisible(subscriptionCard, false);
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to bootstrap subscription.';
    } finally {
      saveSubscriptionButton.disabled = false;
    }
  });

  saveAgentButton.addEventListener('click', async () => {
    saveAgentButton.disabled = true;
    statusLine.textContent = 'Saving local agent...';
    try {
      await saveAgentChatAgent({
        agentId: agentIdField.input.value.trim(),
        label: labelField.input.value.trim(),
        botNpub: agentBotField.input.value.trim(),
        workspaceOwnerNpub: agentWorkspaceField.input.value.trim(),
        groupNpubs: agentGroupsField.input.value
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        workingDirectory: workingDirectoryField.input.value.trim(),
        capabilities: capabilityPicker.getSelectedCapabilities(),
        enabled: enabledField.input.checked,
      });
      statusLine.textContent = 'Local agent saved.';
      setPanelVisible(agentCard, false);
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to save local agent.';
    } finally {
      saveAgentButton.disabled = false;
    }
  });

  refreshOperatorButton.addEventListener('click', () => {
    statusLine.textContent = 'Refreshing Agent Dispatch view...';
    void refreshList().then(() => {
      if (!statusLine.textContent || statusLine.textContent === 'Refreshing Agent Dispatch view...') {
        statusLine.textContent = 'Agent Dispatch view refreshed.';
      }
    });
  });

  openSubscriptionEditorButton.addEventListener('click', () => openSubscriptionEditor(currentPrimarySubscription));
  openAgentEditorButton.addEventListener('click', () => openAgentEditor());
  closeSubscriptionEditorButton.addEventListener('click', () => setPanelVisible(subscriptionCard, false));
  closeAgentEditorButton.addEventListener('click', () => setPanelVisible(agentCard, false));

  container.append(createSettingsTabs({
    tabDefs: [
      { id: 'setup', label: 'Setup', render: () => setupPanel },
      { id: 'operator', label: 'Operator', render: () => operatorPanel },
    ],
    activeTabId: 'setup',
    onTabChange: () => {},
  }));

  void refreshList();
  return container;
}
