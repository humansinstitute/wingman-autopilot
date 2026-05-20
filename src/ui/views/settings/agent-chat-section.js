import {
  deleteAgentChatAgent,
  deleteAgentChatSubscription,
  importAgentConnectPackage,
  listAgentChatBackendConnections,
  listAgentChatDispatchRoutes,
  listAgentChatAgents,
  listAgentChatSubscriptions,
  runAgentChatSubscriptionAction,
  saveAgentChatAgent,
  saveAgentChatBackendConnectionAvailability,
  saveAgentChatDispatchRoute,
  saveAgentChatSubscription,
} from '../../services/agent-chat.js';
import { fetchSessionsApi } from '../../services/sessions.js';
import { fetchPipelineDefinitions } from '../../pipelines/api.js';
import { createAgentRegistryPanel } from './agent-chat-agent-cards.js';
import {
  createSubscriptionCard,
  filterAgentChatSessions,
} from './agent-chat-operator-cards.js';
import {
  createPrimaryAgentEditorCard,
  createPrimaryAgentNameModal,
  createSubscriptionEditorCard,
} from './agent-chat-editor-cards.js';
import {
  createConfiguredDispatchesPanel,
  formatCapability,
  createStatusLine,
  setPanelVisible,
} from './agent-chat-shared-ui.js';
import { createAgentDispatchSetupCards } from './agent-chat-setup-cards.js';
import { createAgentConnectImportModal } from './agent-chat-connect-import-card.js';
import {
  filterDispatchRoutesForSubscription,
  getAdditionalAgents,
  getAgentForSubscription,
  getRoutesForSubscription,
  getSubscriptionById,
  resolveSelectedSubscriptionId,
} from './agent-chat-section-state.js';

async function loadOperatorState(selectedSubscriptionId = null) {
  const [subscriptions, agentPayload, backendConnections, sessionPayload, definitionPayload, dispatchRoutes] = await Promise.all([
    listAgentChatSubscriptions(),
    listAgentChatAgents(),
    listAgentChatBackendConnections(),
    fetchSessionsApi(),
    fetchPipelineDefinitions().catch(() => ({ definitions: [] })),
    listAgentChatDispatchRoutes().catch(() => []),
  ]);
  const allSessions = Array.isArray(sessionPayload?.sessions) ? sessionPayload.sessions : [];
  const effectiveSelectedSubscriptionId = resolveSelectedSubscriptionId(subscriptions, selectedSubscriptionId);
  const selectedSubscription = getSubscriptionById(subscriptions, effectiveSelectedSubscriptionId);
  return {
    subscriptions,
    agents: Array.isArray(agentPayload?.agents) ? agentPayload.agents : [],
    permissions: subscriptions.permissions || agentPayload?.permissions || { shared: false, canManage: true },
    backendConnections: Array.isArray(backendConnections) ? backendConnections : [],
    defaults: agentPayload?.defaults && typeof agentPayload.defaults === 'object' ? agentPayload.defaults : {},
    chatSessions: filterAgentChatSessions(allSessions),
    dispatchRoutes: filterDispatchRoutesForSubscription(dispatchRoutes, effectiveSelectedSubscriptionId),
    allDispatchRoutes: Array.isArray(dispatchRoutes) ? dispatchRoutes : [],
    selectedSubscription,
    selectedSubscriptionId: effectiveSelectedSubscriptionId,
    pipelineDefinitions: Array.isArray(definitionPayload?.definitions) ? definitionPayload.definitions : [],
  };
}

function normaliseAgentCapabilities(agent) {
  return Array.isArray(agent?.capabilities) && agent.capabilities.length > 0
    ? [...new Set(agent.capabilities)]
    : ['chat_intercept'];
}

export function createAgentChatSection({ standalone = false, openDirectoryBrowser = null } = {}) {
  const container = document.createElement('div');
  container.className = 'wm-settings__agent-chat';
  let currentSelectedSubscription = null;
  let currentAgents = [];
  let selectedSubscriptionId = null;
  let selectedBackendConnection = null;
  let promptDefaults = {
    chatPromptTemplate: '',
    taskPromptTemplate: '',
    flowDispatchPromptTemplate: '',
    taskReviewPromptTemplate: '',
    approvalDispatchPromptTemplate: '',
  };
  if (standalone) {
    const heading = document.createElement('h2');
    heading.textContent = 'Agent Dispatch';
    container.append(heading);
    const description = document.createElement('p');
    description.className = 'wm-settings__port-note';
    description.textContent = 'Connect each workspace separately. The same local agent can serve more than one workspace, while each subscription keeps its own source workspace, thread, task, and routes.';
    container.append(description);
  }
  const statusLine = createStatusLine();
  const subscriptionEditor = createSubscriptionEditorCard();
  const browsePrimaryAgentDirectory = typeof openDirectoryBrowser === 'function'
    ? ({ initialPath, onSelect }) => {
        void openDirectoryBrowser({
          initialPath,
          title: 'Select Local Agent Directory',
          confirmLabel: 'Use This Directory',
          allowCreate: true,
          onSelect,
        });
      }
    : null;
  const agentEditor = createPrimaryAgentEditorCard({
    onBrowseDirectory: browsePrimaryAgentDirectory,
  });
  const setupOverviewContainer = document.createElement('div');
  const configuredDispatchesContainer = document.createElement('div');
  const agentRegistryContainer = document.createElement('div');
  const agentConnectImportModal = createAgentConnectImportModal({
    onImport: async (input) => {
      const payload = await importAgentConnectPackage(input);
      selectedSubscriptionId = payload?.subscription?.subscriptionId ?? selectedSubscriptionId;
      statusLine.textContent = 'AgentConnect token imported.';
      await refreshList();
      return payload;
    },
  });
  const agentNameModal = createPrimaryAgentNameModal({
    onBrowseDirectory: browsePrimaryAgentDirectory,
    onCreate: async (defaults) => {
      if (!currentSelectedSubscription?.botNpub || !currentSelectedSubscription?.workspaceOwnerNpub) {
        throw new Error('Connect a workspace before binding the local agent.');
      }
      const agentId = resolveWorkspaceBindingAgentId(defaults.agentId, currentSelectedSubscription);
      await saveAgentChatAgent({
        agentId,
        label: defaults.label,
        botNpub: currentSelectedSubscription.botNpub,
        workspaceOwnerNpub: currentSelectedSubscription.workspaceOwnerNpub,
        groupNpubs: [],
        workingDirectory: defaults.workingDirectory,
        capabilities: defaults.capabilities,
        chatPromptTemplate: promptDefaults.chatPromptTemplate || '',
        taskPromptTemplate: promptDefaults.taskPromptTemplate || '',
        flowDispatchPromptTemplate: promptDefaults.flowDispatchPromptTemplate || '',
        taskReviewPromptTemplate: promptDefaults.taskReviewPromptTemplate || '',
        approvalDispatchPromptTemplate: promptDefaults.approvalDispatchPromptTemplate || '',
        enabled: true,
      });
      statusLine.textContent = `Local agent binding ${agentId} created for this workspace.`;
      await refreshList();
    },
  });
  const setupPanel = document.createElement('div');
  setupPanel.setAttribute('data-testid', 'agent-chat-setup-panel');
  const setupHeading = document.createElement('h3');
  setupHeading.textContent = 'Setup';
  setupPanel.append(setupHeading);
  setupPanel.append(
    setupOverviewContainer,
    subscriptionEditor.card,
    agentEditor.card,
    statusLine,
    configuredDispatchesContainer,
    agentRegistryContainer,
  );
  const operatorPanel = document.createElement('div');
  operatorPanel.setAttribute('data-testid', 'agent-chat-live-panel');
  const liveHeading = document.createElement('h3');
  liveHeading.textContent = 'Live';
  const listContainer = document.createElement('div');
  listContainer.setAttribute('data-testid', 'agent-chat-subscription-list');
  operatorPanel.append(liveHeading, listContainer);
  function updateAgentIdentityFields() {
    agentEditor.applyInheritedIdentity(currentSelectedSubscription);
  }
  function populateSubscriptionForm(subscription) {
    subscriptionEditor.workspaceOwnerField.input.value = subscription?.workspaceOwnerNpub || '';
    subscriptionEditor.backendUrlField.input.value = subscription?.backendBaseUrl || '';
    subscriptionEditor.sourceAppField.input.value = subscription?.sourceAppNpub || '';
    selectedBackendConnection = subscription?.backendConnectionId ? subscription : null;
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
  function resolveWorkspaceBindingAgentId(agentId, subscription) {
    const baseId = String(agentId || 'agent').trim() || 'agent';
    const collidesOutsideSelectedWorkspace = currentAgents.some((agent) => (
      agent.agentId === baseId
      && (
        agent.workspaceOwnerNpub !== subscription.workspaceOwnerNpub
        || agent.botNpub !== subscription.botNpub
      )
    ));
    if (!collidesOutsideSelectedWorkspace) {
      return baseId;
    }

    const workspaceSuffix = String(subscription.workspaceOwnerNpub || 'workspace')
      .replace(/[^a-zA-Z0-9]+/g, '')
      .slice(-8)
      .toLowerCase() || 'workspace';
    let candidate = `${baseId}-${workspaceSuffix}`;
    let counter = 2;
    while (currentAgents.some((agent) => agent.agentId === candidate)) {
      candidate = `${baseId}-${workspaceSuffix}-${counter}`;
      counter += 1;
    }
    return candidate;
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
    agentEditor.flowDispatchPromptTemplateField.input.value = agent.flowDispatchPromptTemplate || promptDefaults.flowDispatchPromptTemplate || '';
    agentEditor.taskReviewPromptTemplateField.input.value = agent.taskReviewPromptTemplate || promptDefaults.taskReviewPromptTemplate || '';
    agentEditor.approvalDispatchPromptTemplateField.input.value = agent.approvalDispatchPromptTemplate || promptDefaults.approvalDispatchPromptTemplate || '';
    agentEditor.capabilityPicker.setSelectedCapabilities(agent.capabilities);
    agentEditor.enabledField.input.checked = agent.enabled !== false;
    agentEditor.setFocusState(null, {
      openAdvanced: Array.isArray(agent.groupNpubs) && agent.groupNpubs.length > 0,
    });
    statusLine.textContent = `Editing workspace binding ${agent.agentId}. The same backend agent can be bound to other workspaces separately.`;
    updateAgentIdentityFields();
  }
  function clearAgentForm() {
    agentEditor.agentIdField.input.value = '';
    agentEditor.labelField.input.value = '';
    agentEditor.agentBotField.input.value = currentSelectedSubscription?.botNpub || '';
    agentEditor.agentWorkspaceField.input.value = currentSelectedSubscription?.workspaceOwnerNpub || '';
    agentEditor.agentGroupsField.input.value = '';
    agentEditor.workingDirectoryField.input.value = '';
    agentEditor.chatPromptTemplateField.input.value = promptDefaults.chatPromptTemplate || '';
    agentEditor.taskPromptTemplateField.input.value = promptDefaults.taskPromptTemplate || '';
    agentEditor.flowDispatchPromptTemplateField.input.value = promptDefaults.flowDispatchPromptTemplate || '';
    agentEditor.taskReviewPromptTemplateField.input.value = promptDefaults.taskReviewPromptTemplate || '';
    agentEditor.approvalDispatchPromptTemplateField.input.value = promptDefaults.approvalDispatchPromptTemplate || '';
    agentEditor.capabilityPicker.setSelectedCapabilities(['chat_intercept']);
    agentEditor.enabledField.input.checked = true;
    agentEditor.setFocusState(null, {
      openAdvanced: !currentSelectedSubscription?.botNpub || !currentSelectedSubscription?.workspaceOwnerNpub,
    });
    updateAgentIdentityFields();
  }
  function openSubscriptionEditor(subscription = null) {
    populateSubscriptionForm(subscription);
    setPanelVisible(subscriptionEditor.card, true);
    subscriptionEditor.workspaceOwnerField.input.focus();
  }
  async function useBackendConnection(backendConnection) {
    selectedBackendConnection = backendConnection;
    statusLine.textContent = 'Creating a subscription from the workspace connection...';
    try {
      const subscription = await saveAgentChatSubscription({
        backendConnectionId: backendConnection.backendConnectionId,
        backendConnectionGrantKind: backendConnection.sharePolicy === 'shared_service' ? 'shared_service' : null,
        backendBaseUrl: backendConnection.backendBaseUrl || '',
        workspaceOwnerNpub: backendConnection.setupWorkspaceOwnerNpub || '',
        sourceAppNpub: backendConnection.setupSourceAppNpub || '',
        sourceAppSchemaNamespace: backendConnection.setupSourceAppSchemaNamespace || null,
      });
      selectedSubscriptionId = subscription?.subscriptionId ?? selectedSubscriptionId;
      statusLine.textContent = 'Workspace connection is ready.';
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to use workspace connection.';
    }
  }
  function openAgentEditor(agent = null, options = {}) {
    if (agent) {
      populateAgentForm(agent);
    } else {
      clearAgentForm();
      if (Array.isArray(options.capabilities) && options.capabilities.length > 0) {
        agentEditor.capabilityPicker.setSelectedCapabilities(options.capabilities);
      }
      statusLine.textContent = 'Creating a workspace binding for the local agent. Add the roles this workspace should dispatch.';
    }

    agentEditor.setFocusState(options.focusField || null, {
      openAdvanced: Boolean(
        (agent && Array.isArray(agent.groupNpubs) && agent.groupNpubs.length > 0)
        || !currentSelectedSubscription?.botNpub
        || !currentSelectedSubscription?.workspaceOwnerNpub,
      ),
    });
    updateAgentIdentityFields();
    agentEditor.open();

    if (options.focusField === 'chat-template') {
      agentEditor.chatPromptTemplateField.input.focus();
      return;
    }
    if (options.focusField === 'task-template') {
      agentEditor.taskPromptTemplateField.input.focus();
      return;
    }
    if (options.focusField === 'flow-template') {
      agentEditor.flowDispatchPromptTemplateField.input.focus();
      return;
    }
    if (options.focusField === 'review-template') {
      agentEditor.taskReviewPromptTemplateField.input.focus();
      return;
    }
    if (options.focusField === 'approval-template') {
      agentEditor.approvalDispatchPromptTemplateField.input.focus();
      return;
    }
    agentEditor.agentIdField.input.focus();
  }
  async function removeAgent(agent) {
    statusLine.textContent = `Removing workspace binding ${agent.agentId}...`;
    try {
      await deleteAgentChatAgent(agent.agentId);
      statusLine.textContent = `Removed workspace binding ${agent.agentId}.`;
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to remove workspace binding.';
    }
  }
  async function toggleCapability(agent, capability, currentlyEnabled) {
    const nextCapabilities = new Set(normaliseAgentCapabilities(agent));
    if (currentlyEnabled) {
      nextCapabilities.delete(capability);
    } else {
      nextCapabilities.add(capability);
    }
    if (nextCapabilities.size === 0) {
      nextCapabilities.add('chat_intercept');
    }
    statusLine.textContent = `${currentlyEnabled ? 'Disabling' : 'Enabling'} ${formatCapability(capability)} for ${agent.agentId}...`;
    try {
      const effectiveBotNpub = currentSelectedSubscription?.botNpub?.trim() || agent.botNpub?.trim() || '';
      const effectiveWorkspaceOwner = currentSelectedSubscription?.workspaceOwnerNpub?.trim() || agent.workspaceOwnerNpub?.trim() || '';
      await saveAgentChatAgent({
        agentId: agent.agentId,
        label: agent.label || '',
        botNpub: effectiveBotNpub,
        workspaceOwnerNpub: effectiveWorkspaceOwner,
        groupNpubs: Array.isArray(agent.groupNpubs) ? agent.groupNpubs : [],
        workingDirectory: agent.workingDirectory || '',
        capabilities: [...nextCapabilities],
        chatPromptTemplate: typeof agent.chatPromptTemplate === 'string' ? agent.chatPromptTemplate : '',
        taskPromptTemplate: typeof agent.taskPromptTemplate === 'string' ? agent.taskPromptTemplate : '',
        flowDispatchPromptTemplate: typeof agent.flowDispatchPromptTemplate === 'string' ? agent.flowDispatchPromptTemplate : '',
        taskReviewPromptTemplate: typeof agent.taskReviewPromptTemplate === 'string' ? agent.taskReviewPromptTemplate : '',
        approvalDispatchPromptTemplate: typeof agent.approvalDispatchPromptTemplate === 'string' ? agent.approvalDispatchPromptTemplate : '',
        enabled: agent.enabled !== false,
      });
      statusLine.textContent = `${currentlyEnabled ? 'Disabled' : 'Enabled'} ${formatCapability(capability)} for ${agent.agentId}.`;
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to update agent capability.';
    }
  }
  async function refreshList() {
    setupOverviewContainer.replaceChildren();
    configuredDispatchesContainer.replaceChildren();
    agentRegistryContainer.replaceChildren();
    listContainer.replaceChildren();

    try {
      const {
        subscriptions,
        agents,
        permissions,
        backendConnections,
        defaults,
        chatSessions,
        dispatchRoutes,
        allDispatchRoutes,
        selectedSubscription,
        selectedSubscriptionId: effectiveSelectedSubscriptionId,
        pipelineDefinitions,
      } = await loadOperatorState(selectedSubscriptionId);
      promptDefaults = {
        chatPromptTemplate: typeof defaults.chatPromptTemplate === 'string' ? defaults.chatPromptTemplate : promptDefaults.chatPromptTemplate,
        taskPromptTemplate: typeof defaults.taskPromptTemplate === 'string' ? defaults.taskPromptTemplate : promptDefaults.taskPromptTemplate,
        flowDispatchPromptTemplate: typeof defaults.flowDispatchPromptTemplate === 'string'
          ? defaults.flowDispatchPromptTemplate
          : promptDefaults.flowDispatchPromptTemplate,
        taskReviewPromptTemplate: typeof defaults.taskReviewPromptTemplate === 'string'
          ? defaults.taskReviewPromptTemplate
          : promptDefaults.taskReviewPromptTemplate,
        approvalDispatchPromptTemplate: typeof defaults.approvalDispatchPromptTemplate === 'string'
          ? defaults.approvalDispatchPromptTemplate
          : promptDefaults.approvalDispatchPromptTemplate,
      };
      currentAgents = agents;
      selectedSubscriptionId = effectiveSelectedSubscriptionId;
      const selectedAgent = getAgentForSubscription(agents, selectedSubscription);
      currentSelectedSubscription = selectedSubscription;
      prefillFieldsFromSubscription(selectedSubscription);
      updateAgentIdentityFields();
      setupOverviewContainer.append(createAgentDispatchSetupCards({
        subscription: selectedSubscription,
        primaryAgent: selectedAgent,
        canManage: permissions?.canManage !== false,
        shared: permissions?.shared === true,
        availableBackendConnections: backendConnections,
        onEditSubscription: (subscription) => openSubscriptionEditor(subscription),
        onUseBackendConnection: (backendConnection) => {
          void useBackendConnection(backendConnection);
        },
        onSaveBackendAvailability: async (backendConnection, input) => {
          const updated = await saveAgentChatBackendConnectionAvailability(backendConnection.backendConnectionId, input);
          await refreshList();
          return updated;
        },
        onConnectWorkspace: () => {
          agentConnectImportModal.open();
        },
        onEditAgent: (agent) => openAgentEditor(agent),
        onCreateAgent: () => agentNameModal.open(),
        onRefresh: () => {
          statusLine.textContent = 'Refreshing Agent Dispatch view...';
          void refreshList().then(() => {
            if (!statusLine.textContent || statusLine.textContent === 'Refreshing Agent Dispatch view...') {
              statusLine.textContent = 'Agent Dispatch view refreshed.';
            }
          });
        },
      }));
      configuredDispatchesContainer.append(createConfiguredDispatchesPanel(selectedAgent, promptDefaults, {
        subscription: selectedSubscription,
        dispatchRoutes,
        pipelineDefinitions,
        onCreateAgent: permissions?.canManage === false ? null : () => agentNameModal.open(),
        onEditAgent: permissions?.canManage === false ? null : (agent) => openAgentEditor(agent),
        onRemoveAgent: permissions?.canManage === false ? null : (agent) => {
          void removeAgent(agent);
        },
        onSaveRoute: permissions?.canManage === false ? null : async (input) => {
          const route = await saveAgentChatDispatchRoute(input);
          await refreshList();
          return route;
        },
        onEditChatTemplate: permissions?.canManage === false ? null : (agent) => {
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
        onEditTaskTemplate: permissions?.canManage === false ? null : (agent) => {
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
        onEditFlowDispatchTemplate: permissions?.canManage === false ? null : (agent) => {
          if (agent) {
            openAgentEditor(agent, { focusField: 'flow-template' });
            statusLine.textContent = `Editing flow dispatch template for ${agent.agentId}.`;
            return;
          }
          openAgentEditor(null, {
            capabilities: ['flow_dispatch'],
            focusField: 'flow-template',
          });
          statusLine.textContent = 'Create a local agent to save a flow dispatch template.';
        },
        onEditTaskReviewTemplate: permissions?.canManage === false ? null : (agent) => {
          if (agent) {
            openAgentEditor(agent, { focusField: 'review-template' });
            statusLine.textContent = `Editing task review template for ${agent.agentId}.`;
            return;
          }
          openAgentEditor(null, {
            capabilities: ['task_review'],
            focusField: 'review-template',
          });
          statusLine.textContent = 'Create a local agent to save a task review template.';
        },
        onEditApprovalDispatchTemplate: permissions?.canManage === false ? null : (agent) => {
          if (agent) {
            openAgentEditor(agent, { focusField: 'approval-template' });
            statusLine.textContent = `Editing approval dispatch template for ${agent.agentId}.`;
            return;
          }
          openAgentEditor(null, {
            capabilities: ['approval_dispatch'],
            focusField: 'approval-template',
          });
          statusLine.textContent = 'Create a local agent to save an approval dispatch template.';
        },
        onToggleCapability: permissions?.canManage === false ? null : (agent, capability, currentlyEnabled) => {
          void toggleCapability(agent, capability, currentlyEnabled);
        },
      }));
      const additionalAgents = getAdditionalAgents(agents, selectedAgent);
      if (additionalAgents.length > 0) {
        agentRegistryContainer.append(createAgentRegistryPanel(additionalAgents, {
          edit: permissions?.canManage === false ? null : (agent) => openAgentEditor(agent),
          remove: permissions?.canManage === false ? null : (agent) => {
            void removeAgent(agent);
          },
        }, {
          heading: 'Other Workspace Bindings',
          emptyMessage: 'Each workspace subscription can bind to the same backend agent separately.',
        }));
      }
      setPanelVisible(subscriptionEditor.card, false);
      agentEditor.close();
      if (subscriptions.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'wm-settings__port-note';
        empty.textContent = 'No workspace subscriptions yet. Create one from the setup section below.';
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
        select: (subscription) => {
          selectedSubscriptionId = subscription.subscriptionId;
          statusLine.textContent = 'Loading selected workspace subscription...';
          void refreshList();
        },
        edit: (subscription) => openSubscriptionEditor(subscription),
        dispatchRoutes,
        getDispatchRoutes: (subscription) => getRoutesForSubscription(allDispatchRoutes, subscription.subscriptionId),
        selectedSubscriptionId,
        pipelineDefinitions,
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
      const subscription = await saveAgentChatSubscription({
        workspaceOwnerNpub: subscriptionEditor.workspaceOwnerField.input.value.trim(),
        backendBaseUrl: subscriptionEditor.backendUrlField.input.value.trim(),
        sourceAppNpub: subscriptionEditor.sourceAppField.input.value.trim(),
        backendConnectionId: selectedBackendConnection?.backendConnectionId || null,
        backendConnectionGrantKind: selectedBackendConnection?.sharePolicy === 'shared_service' ? 'shared_service' : null,
        sourceAppSchemaNamespace: selectedBackendConnection?.setupSourceAppSchemaNamespace || null,
      });
      selectedSubscriptionId = subscription?.subscriptionId ?? selectedSubscriptionId;
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
    statusLine.textContent = 'Saving workspace binding...';
    try {
      const effectiveBotNpub = currentSelectedSubscription?.botNpub?.trim() || agentEditor.agentBotField.input.value.trim();
      const effectiveWorkspaceOwner = currentSelectedSubscription?.workspaceOwnerNpub?.trim() || agentEditor.agentWorkspaceField.input.value.trim();
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
        flowDispatchPromptTemplate: agentEditor.flowDispatchPromptTemplateField.input.value,
        taskReviewPromptTemplate: agentEditor.taskReviewPromptTemplateField.input.value,
        approvalDispatchPromptTemplate: agentEditor.approvalDispatchPromptTemplateField.input.value,
        enabled: agentEditor.enabledField.input.checked,
      });
      statusLine.textContent = 'Workspace binding saved.';
      agentEditor.close();
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to save workspace binding.';
    } finally {
      agentEditor.saveButton.disabled = false;
    }
  });
  subscriptionEditor.closeButton.addEventListener('click', () => setPanelVisible(subscriptionEditor.card, false));
  agentEditor.closeButton.addEventListener('click', () => agentEditor.close());
  container.append(operatorPanel, setupPanel);
  container.append(agentConnectImportModal.element, agentNameModal.element);
  void refreshList();
  return container;
}
