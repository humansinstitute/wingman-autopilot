import { createSettingsTabs } from '../settings-tabs.js';
import {
  deleteAgentChatAgent,
  deleteAgentChatSubscription,
  listAgentChatAgents,
  listAgentChatSubscriptions,
  runAgentChatSubscriptionAction,
  saveAgentChatAgent,
  saveAgentChatSubscription,
} from '../../services/agent-chat.js';
import { fetchSessionsApi } from '../../services/sessions.js';
import { createAgentRegistryPanel } from './agent-chat-agent-cards.js';
import {
  createAgentChatOverview,
  createAgentChatSessionPanel,
  createSubscriptionCard,
  filterAgentChatSessions,
} from './agent-chat-operator-cards.js';
import { createPrimaryAgentEditorCard, createSubscriptionEditorCard } from './agent-chat-editor-cards.js';
import {
  createButton,
  createCard,
  createConfiguredDispatchesPanel,
  createInlineActions,
  createStatusLine,
  setPanelVisible,
} from './agent-chat-shared-ui.js';
import { createAgentDispatchSetupCards } from './agent-chat-setup-cards.js';

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
  let promptDefaults = { chatPromptTemplate: '', taskPromptTemplate: '' };
  if (standalone) {
    const heading = document.createElement('h2');
    heading.textContent = 'Agent Dispatch';
    container.append(heading);
    const description = document.createElement('p');
    description.className = 'wm-settings__port-note';
    description.textContent = 'Manage the workspace subscription once, reuse one local agent identity, and inspect the rolling SSE stream and recent dispatch activity without wading through raw diagnostic dumps.';
    container.append(description);
  }
  const statusLine = createStatusLine();
  const subscriptionEditor = createSubscriptionEditorCard();
  const agentEditor = createPrimaryAgentEditorCard();
  const setupOverviewContainer = document.createElement('div');
  const configuredDispatchesContainer = document.createElement('div');
  const agentRegistryContainer = document.createElement('div');
  const setupPanel = document.createElement('div');
  setupPanel.append(
    setupOverviewContainer,
    subscriptionEditor.card,
    agentEditor.card,
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
    agentEditor.applyInheritedIdentity(currentPrimarySubscription);
  }
  function populateSubscriptionForm(subscription) {
    subscriptionEditor.workspaceOwnerField.input.value = subscription?.workspaceOwnerNpub || '';
    subscriptionEditor.backendUrlField.input.value = subscription?.backendBaseUrl || '';
    subscriptionEditor.sourceAppField.input.value = subscription?.sourceAppNpub || '';
  }

  function prefillFieldsFromSubscription(subscription) {
    if (!subscription) {
      return;
    }
    if (!agentEditor.agentBotField.input.value.trim()) {
      agentEditor.agentBotField.input.value = subscription.botNpub || '';
    }
    if (!agentEditor.agentWorkspaceField.input.value.trim()) {
      agentEditor.agentWorkspaceField.input.value = subscription.workspaceOwnerNpub || '';
    }
    if (!subscriptionEditor.workspaceOwnerField.input.value.trim()) {
      subscriptionEditor.workspaceOwnerField.input.value = subscription.workspaceOwnerNpub || '';
    }
    if (!subscriptionEditor.backendUrlField.input.value.trim()) {
      subscriptionEditor.backendUrlField.input.value = subscription.backendBaseUrl || '';
    }
    if (!subscriptionEditor.sourceAppField.input.value.trim()) {
      subscriptionEditor.sourceAppField.input.value = subscription.sourceAppNpub || '';
    }
  }
  function populateAgentForm(agent) {
    agentEditor.agentIdField.input.value = agent.agentId || '';
    agentEditor.labelField.input.value = agent.label || '';
    agentEditor.agentBotField.input.value = agent.botNpub || '';
    agentEditor.agentWorkspaceField.input.value = agent.workspaceOwnerNpub || '';
    agentEditor.agentGroupsField.input.value = Array.isArray(agent.groupNpubs) ? agent.groupNpubs.join(', ') : '';
    agentEditor.workingDirectoryField.input.value = agent.workingDirectory || '';
    agentEditor.chatPromptTemplateField.input.value = agent.chatPromptTemplate || promptDefaults.chatPromptTemplate || '';
    agentEditor.taskPromptTemplateField.input.value = agent.taskPromptTemplate || promptDefaults.taskPromptTemplate || '';
    agentEditor.capabilityPicker.setSelectedCapabilities(agent.capabilities);
    agentEditor.enabledField.input.checked = agent.enabled !== false;
    agentEditor.setFocusState(null, {
      openAdvanced: Array.isArray(agent.groupNpubs) && agent.groupNpubs.length > 0,
    });
    statusLine.textContent = `Editing local agent ${agent.agentId}. Add capabilities and save to keep the same identity.`;
    updateAgentIdentityFields();
  }
  function clearAgentForm() {
    agentEditor.agentIdField.input.value = '';
    agentEditor.labelField.input.value = '';
    agentEditor.agentBotField.input.value = currentPrimarySubscription?.botNpub || '';
    agentEditor.agentWorkspaceField.input.value = currentPrimarySubscription?.workspaceOwnerNpub || '';
    agentEditor.agentGroupsField.input.value = '';
    agentEditor.workingDirectoryField.input.value = '';
    agentEditor.chatPromptTemplateField.input.value = promptDefaults.chatPromptTemplate || '';
    agentEditor.taskPromptTemplateField.input.value = promptDefaults.taskPromptTemplate || '';
    agentEditor.capabilityPicker.setSelectedCapabilities(['chat_intercept']);
    agentEditor.enabledField.input.checked = true;
    agentEditor.setFocusState(null, {
      openAdvanced: !currentPrimarySubscription?.botNpub || !currentPrimarySubscription?.workspaceOwnerNpub,
    });
    updateAgentIdentityFields();
  }
  function openSubscriptionEditor(subscription = null) {
    populateSubscriptionForm(subscription);
    setPanelVisible(subscriptionEditor.card, true);
    subscriptionEditor.workspaceOwnerField.input.focus();
  }
  function openAgentEditor(agent = null, options = {}) {
    if (agent) {
      populateAgentForm(agent);
    } else {
      clearAgentForm();
      if (Array.isArray(options.capabilities) && options.capabilities.length > 0) {
        agentEditor.capabilityPicker.setSelectedCapabilities(options.capabilities);
      }
      statusLine.textContent = 'Creating a local agent. Add capabilities to the same agent over time.';
    }

    agentEditor.setFocusState(options.focusField || null, {
      openAdvanced: Boolean(
        (agent && Array.isArray(agent.groupNpubs) && agent.groupNpubs.length > 0)
        || !currentPrimarySubscription?.botNpub
        || !currentPrimarySubscription?.workspaceOwnerNpub,
      ),
    });
    updateAgentIdentityFields();
    setPanelVisible(agentEditor.card, true);

    if (options.focusField === 'chat-template') {
      agentEditor.chatPromptTemplateField.input.focus();
      return;
    }
    if (options.focusField === 'task-template') {
      agentEditor.taskPromptTemplateField.input.focus();
      return;
    }
    agentEditor.agentIdField.input.focus();
  }
  async function removeAgent(agent) {
    statusLine.textContent = `Removing local agent ${agent.agentId}...`;
    try {
      await deleteAgentChatAgent(agent.agentId);
      statusLine.textContent = `Removed local agent ${agent.agentId}.`;
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to remove local agent.';
    }
  }
  async function refreshList() {
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
      prefillFieldsFromSubscription(primarySubscription);
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
      setPanelVisible(subscriptionEditor.card, !primarySubscription);
      setPanelVisible(agentEditor.card, Boolean(primarySubscription && agents.length === 0));
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
  }
  subscriptionEditor.saveButton.addEventListener('click', async () => {
    subscriptionEditor.saveButton.disabled = true;
    statusLine.textContent = 'Saving shared connection...';
    try {
      await saveAgentChatSubscription({
        workspaceOwnerNpub: subscriptionEditor.workspaceOwnerField.input.value.trim(),
        backendBaseUrl: subscriptionEditor.backendUrlField.input.value.trim(),
        sourceAppNpub: subscriptionEditor.sourceAppField.input.value.trim(),
      });
      statusLine.textContent = 'Subscription saved.';
      setPanelVisible(subscriptionEditor.card, false);
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to save shared connection.';
    } finally {
      subscriptionEditor.saveButton.disabled = false;
    }
  });
  agentEditor.saveButton.addEventListener('click', async () => {
    agentEditor.saveButton.disabled = true;
    statusLine.textContent = 'Saving primary agent...';
    try {
      const effectiveBotNpub = currentPrimarySubscription?.botNpub?.trim() || agentEditor.agentBotField.input.value.trim();
      const effectiveWorkspaceOwner = currentPrimarySubscription?.workspaceOwnerNpub?.trim() || agentEditor.agentWorkspaceField.input.value.trim();
      await saveAgentChatAgent({
        agentId: agentEditor.agentIdField.input.value.trim(),
        label: agentEditor.labelField.input.value.trim(),
        botNpub: effectiveBotNpub,
        workspaceOwnerNpub: effectiveWorkspaceOwner,
        groupNpubs: agentEditor.agentGroupsField.input.value
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        workingDirectory: agentEditor.workingDirectoryField.input.value.trim(),
        capabilities: agentEditor.capabilityPicker.getSelectedCapabilities(),
        chatPromptTemplate: agentEditor.chatPromptTemplateField.input.value,
        taskPromptTemplate: agentEditor.taskPromptTemplateField.input.value,
        enabled: agentEditor.enabledField.input.checked,
      });
      statusLine.textContent = 'Local agent saved.';
      setPanelVisible(agentEditor.card, false);
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to save primary agent.';
    } finally {
      agentEditor.saveButton.disabled = false;
    }
  });
  subscriptionEditor.closeButton.addEventListener('click', () => setPanelVisible(subscriptionEditor.card, false));
  agentEditor.closeButton.addEventListener('click', () => setPanelVisible(agentEditor.card, false));
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
