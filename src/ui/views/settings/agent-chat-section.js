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
import { createAgentDispatchSetupCards } from './agent-chat-setup-cards.js';
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

function createTextarea(labelText, placeholder, testId, rows = 10) {
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

function createDispatchReferenceCard({ title, enabledAgents, description, promptPreview, actionLabel, onAction, actionTestId }) {
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

function createPlaceholderNote(title, placeholders) {
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

function createConfiguredDispatchesPanel(agents, options = {}) {
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
  const [subscriptions, agentPayload, sessionPayload] = await Promise.all([
    listAgentChatSubscriptions(),
    listAgentChatAgents(),
    fetchSessionsApi(),
  ]);
  const allSessions = Array.isArray(sessionPayload?.sessions) ? sessionPayload.sessions : [];
  return {
    subscriptions,
    agents: Array.isArray(agentPayload?.agents) ? agentPayload.agents : [],
    defaults: agentPayload?.defaults && typeof agentPayload.defaults === 'object' ? agentPayload.defaults : {},
    chatSessions: filterAgentChatSessions(allSessions),
  };
}

function getPrimaryAgent(agents) {
  if (!Array.isArray(agents) || agents.length === 0) {
    return null;
  }
  return agents[0] ?? null;
}

export function createAgentDispatchLauncher({ onNavigate } = {}) {
  const card = createCard(
    'Agent Dispatch',
    'Open the dedicated agent page to manage one shared connection, one primary local agent, SSE activity, and dispatch history.',
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
  let currentPrimaryAgent = null;
  let promptDefaults = {
    chatPromptTemplate: '',
    taskPromptTemplate: '',
  };

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
  const chatPromptTemplateField = createTextarea(
    'Chat Prompt Template',
    'Editable chat dispatch prompt with {{placeholders}}',
    'agent-chat-chat-prompt-template',
    16,
  );
  const taskPromptTemplateField = createTextarea(
    'Task Prompt Template',
    'Editable task dispatch prompt with {{placeholders}}',
    'agent-chat-task-prompt-template',
    14,
  );
  const capabilityPicker = createCapabilityPicker();
  const enabledField = createCheckbox('Enabled', 'agent-chat-agent-enabled', true);
  const statusLine = createStatusLine();
  const setupOverviewContainer = document.createElement('div');
  const openSubscriptionEditorButton = createButton(
    'Edit Connection',
    'agent-chat-open-subscription-editor',
    'Edit Agent Dispatch subscription',
  );
  const openAgentEditorButton = createButton(
    'Configure Agent',
    'agent-chat-open-agent-editor',
    'Configure Agent Dispatch local agent',
  );
  const refreshOperatorButton = createButton(
    'Refresh View',
    'agent-chat-refresh-view',
    'Refresh Agent Dispatch operator view',
  );

  const subscriptionCard = createCard(
    'Workspace Connection',
    'Save the shared workspace connection once. Agent dispatch reuses this same live subscription.',
  );
  const saveSubscriptionButton = createButton(
    'Save Connection',
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
    'Primary Local Agent',
    'Keep one local agent and add capabilities to it. When a shared connection exists, the bot and workspace identity are inherited instead of re-entered.',
  );
  const saveAgentButton = createButton(
    'Save Agent',
    'agent-chat-save-agent',
    'Create or update local Agent Dispatch agent',
  );
  const agentIdentityNote = document.createElement('p');
  agentIdentityNote.className = 'wm-settings__port-note';
  agentIdentityNote.style.display = 'none';
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
    agentIdentityNote,
    agentBotField.row,
    agentWorkspaceField.row,
    agentGroupsField.row,
    workingDirectoryField.row,
    capabilityPicker.row,
    chatPromptTemplateField.row,
    createPlaceholderNote(
      'Chat placeholders',
      [
        '{{chat_runtime_event}}',
        '{{agent_id}}',
        '{{agent_label}}',
        '{{workspace_owner_npub}}',
        '{{channel_id}}',
        '{{thread_id}}',
        '{{bot_npub}}',
        '{{managed_by_npub}}',
        '{{session_id}}',
        '{{recent_turn_count}}',
        '{{participants}}',
        '{{recent_turns}}',
        '{{merge_package_json}}',
        '{{yoke_context_command}}',
        '{{yoke_history_command}}',
        '{{yoke_search_command}}',
        '{{yoke_related_command}}',
        '{{yoke_reply_current_command}}',
        '{{yoke_context_status}}',
        '{{chat_dispatch_instructions}}',
      ],
    ),
    taskPromptTemplateField.row,
    createPlaceholderNote(
      'Task placeholders',
      [
        '{{dispatch_reason}}',
        '{{task_id}}',
        '{{flow_id}}',
        '{{flow_run_id}}',
        '{{flow_step}}',
        '{{scope_id}}',
        '{{scope_lineage}}',
        '{{title}}',
        '{{description}}',
      ],
    ),
    enabledField.row,
    agentGroupsNote,
    createInlineActions(saveAgentButton, closeAgentEditorButton),
  );
  setPanelVisible(agentCard, false);

  const setupPanel = document.createElement('div');
  const agentRegistryContainer = document.createElement('div');
  const configuredDispatchesContainer = document.createElement('div');
  setupPanel.append(
    setupOverviewContainer,
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

  function updateAgentIdentityFields() {
    const inheritedBot = currentPrimarySubscription?.botNpub?.trim() || '';
    const inheritedWorkspace = currentPrimarySubscription?.workspaceOwnerNpub?.trim() || '';
    const hasInheritedIdentity = inheritedBot.length > 0 && inheritedWorkspace.length > 0;
    setPanelVisible(agentBotField.row, !hasInheritedIdentity);
    setPanelVisible(agentWorkspaceField.row, !hasInheritedIdentity);
    agentIdentityNote.style.display = hasInheritedIdentity ? '' : 'none';
    if (hasInheritedIdentity) {
      agentIdentityNote.textContent = `This agent will reuse bot ${inheritedBot} and workspace ${inheritedWorkspace} from the shared connection.`;
      agentBotField.input.value = inheritedBot;
      agentWorkspaceField.input.value = inheritedWorkspace;
      return;
    }
    agentIdentityNote.textContent = '';
  }

  const populateAgentForm = (agent) => {
    agentIdField.input.value = agent.agentId || '';
    labelField.input.value = agent.label || '';
    agentBotField.input.value = agent.botNpub || '';
    agentWorkspaceField.input.value = agent.workspaceOwnerNpub || '';
    agentGroupsField.input.value = Array.isArray(agent.groupNpubs) ? agent.groupNpubs.join(', ') : '';
    workingDirectoryField.input.value = agent.workingDirectory || '';
    chatPromptTemplateField.input.value = agent.chatPromptTemplate || promptDefaults.chatPromptTemplate || '';
    taskPromptTemplateField.input.value = agent.taskPromptTemplate || promptDefaults.taskPromptTemplate || '';
    capabilityPicker.setSelectedCapabilities(agent.capabilities);
    enabledField.input.checked = agent.enabled !== false;
    statusLine.textContent = `Editing local agent ${agent.agentId}. Add capabilities and save to keep the same identity.`;
    updateAgentIdentityFields();
  };

  const clearAgentForm = () => {
    agentIdField.input.value = '';
    labelField.input.value = '';
    agentBotField.input.value = currentPrimarySubscription?.botNpub || '';
    agentWorkspaceField.input.value = currentPrimarySubscription?.workspaceOwnerNpub || '';
    agentGroupsField.input.value = '';
    workingDirectoryField.input.value = '';
    chatPromptTemplateField.input.value = promptDefaults.chatPromptTemplate || '';
    taskPromptTemplateField.input.value = promptDefaults.taskPromptTemplate || '';
    capabilityPicker.setSelectedCapabilities(['chat_intercept']);
    enabledField.input.checked = true;
    updateAgentIdentityFields();
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

  const openAgentEditor = (agent = null, options = {}) => {
    if (agent) {
      populateAgentForm(agent);
    } else {
      clearAgentForm();
      if (Array.isArray(options.capabilities) && options.capabilities.length > 0) {
        capabilityPicker.setSelectedCapabilities(options.capabilities);
      }
      statusLine.textContent = 'Creating a local agent. Add capabilities to the same agent over time.';
    }
    updateAgentIdentityFields();
    setPanelVisible(agentCard, true);
    if (options.focusField === 'chat-template') {
      chatPromptTemplateField.input.focus();
      return;
    }
    if (options.focusField === 'task-template') {
      taskPromptTemplateField.input.focus();
      return;
    }
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

  const removeAgent = async (agent) => {
    statusLine.textContent = `Removing local agent ${agent.agentId}...`;
    try {
      await deleteAgentChatAgent(agent.agentId);
      statusLine.textContent = `Removed local agent ${agent.agentId}.`;
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to remove local agent.';
    }
  };

  const refreshList = async () => {
    overviewContainer.replaceChildren();
    setupOverviewContainer.replaceChildren();
    configuredDispatchesContainer.replaceChildren();
    agentRegistryContainer.replaceChildren();
    listContainer.replaceChildren();
    sessionContainer.replaceChildren();
    try {
      const { subscriptions, agents, defaults, chatSessions } = await loadOperatorState();
      promptDefaults = {
        chatPromptTemplate: typeof defaults.chatPromptTemplate === 'string' ? defaults.chatPromptTemplate : promptDefaults.chatPromptTemplate,
        taskPromptTemplate: typeof defaults.taskPromptTemplate === 'string' ? defaults.taskPromptTemplate : promptDefaults.taskPromptTemplate,
      };
      const primarySubscription = subscriptions[0] ?? null;
      const primaryAgent = getPrimaryAgent(agents);
      currentPrimarySubscription = primarySubscription;
      currentPrimaryAgent = primaryAgent;
      prefillAgentFieldsFromSubscription(primarySubscription);
      updateAgentIdentityFields();
      setupOverviewContainer.append(createAgentDispatchSetupCards({
        subscription: primarySubscription,
        primaryAgent,
        additionalAgentCount: Math.max(0, agents.length - (primaryAgent ? 1 : 0)),
        onEditSubscription: (subscription) => openSubscriptionEditor(subscription),
        onEditAgent: (agent) => openAgentEditor(agent),
        onCreateAgent: () => openAgentEditor(),
        onRemoveAgent: (agent) => {
          void removeAgent(agent);
        },
        onRefresh: () => {
          statusLine.textContent = 'Refreshing Agent Dispatch view...';
          void refreshList().then(() => {
            if (!statusLine.textContent || statusLine.textContent === 'Refreshing Agent Dispatch view...') {
              statusLine.textContent = 'Agent Dispatch view refreshed.';
            }
          });
        },
      }));
      configuredDispatchesContainer.append(createConfiguredDispatchesPanel(agents, {
        onEditChatTemplate: (agent) => {
          if (agent) {
            openAgentEditor(agent, { focusField: 'chat-template' });
            statusLine.textContent = `Editing chat dispatch template for ${agent.agentId}.`;
            return;
          }
          openAgentEditor(null, {
            capabilities: ['chat_intercept'],
            focusField: 'chat-template',
          });
          statusLine.textContent = 'Create a local agent to save a chat dispatch template.';
        },
        onEditTaskTemplate: (agent) => {
          if (agent) {
            openAgentEditor(agent, { focusField: 'task-template' });
            statusLine.textContent = `Editing task dispatch template for ${agent.agentId}.`;
            return;
          }
          openAgentEditor(null, {
            capabilities: ['task_dispatch'],
            focusField: 'task-template',
          });
          statusLine.textContent = 'Create a local agent to save a task dispatch template.';
        },
      }));
      const additionalAgents = primaryAgent ? agents.slice(1) : agents;
      if (additionalAgents.length > 0) {
        agentRegistryContainer.append(createAgentRegistryPanel(additionalAgents, {
          edit: (agent) => openAgentEditor(agent),
          remove: (agent) => {
            void removeAgent(agent);
          },
        }, {
          heading: 'Additional Local Agents',
          emptyMessage: 'The primary flow is designed around one local agent.',
        }));
      }
      setPanelVisible(subscriptionCard, !primarySubscription);
      setPanelVisible(agentCard, Boolean(primarySubscription && agents.length === 0));

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
    statusLine.textContent = 'Saving shared connection...';
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
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to save shared connection.';
    } finally {
      saveSubscriptionButton.disabled = false;
    }
  });

  saveAgentButton.addEventListener('click', async () => {
    saveAgentButton.disabled = true;
    statusLine.textContent = 'Saving primary agent...';
    try {
      const effectiveBotNpub = currentPrimarySubscription?.botNpub?.trim() || agentBotField.input.value.trim();
      const effectiveWorkspaceOwner = currentPrimarySubscription?.workspaceOwnerNpub?.trim() || agentWorkspaceField.input.value.trim();
      await saveAgentChatAgent({
        agentId: agentIdField.input.value.trim(),
        label: labelField.input.value.trim(),
        botNpub: effectiveBotNpub,
        workspaceOwnerNpub: effectiveWorkspaceOwner,
        groupNpubs: agentGroupsField.input.value
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        workingDirectory: workingDirectoryField.input.value.trim(),
        capabilities: capabilityPicker.getSelectedCapabilities(),
        chatPromptTemplate: chatPromptTemplateField.input.value,
        taskPromptTemplate: taskPromptTemplateField.input.value,
        enabled: enabledField.input.checked,
      });
      statusLine.textContent = 'Local agent saved.';
      setPanelVisible(agentCard, false);
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to save primary agent.';
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
  openAgentEditorButton.addEventListener('click', () => openAgentEditor(currentPrimaryAgent));
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
