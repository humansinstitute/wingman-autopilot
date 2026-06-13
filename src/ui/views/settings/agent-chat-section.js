import {
  importAgentConnectPackage,
  deleteAgentChatSubscription,
  listAgentChatBackendConnections,
  listAgentChatDispatchRoutes,
  listAgentChatAgents,
  listAgentChatSubscriptions,
  runAgentChatSubscriptionAction,
  saveAgentChatAgent,
  saveAgentChatBackendConnectionAvailability,
  saveAgentChatDispatchRoute,
  saveAgentChatSubscription,
  saveAgentChatProfileWorkspace,
} from '../../services/agent-chat.js';
import { fetchSessionsApi } from '../../services/sessions.js';
import { fetchPipelineDefinitions } from '../../pipelines/api.js';
import {
  createSubscriptionCard,
  filterAgentChatSessions,
} from './agent-chat-operator-cards.js';
import {
  createConfiguredDispatchesPanel,
  createStatusLine,
} from './agent-chat-shared-ui.js';
import { createProfileWorkspaceSettingsPanel } from './agent-chat-profile-workspace-card.js';
import { createAgentDispatchSetupCards } from './agent-chat-setup-cards.js';
import { createAgentConnectImportModal } from './agent-chat-connect-import-card.js';
import {
  createPrimaryAgentNameModal,
  createSubscriptionEditorCard,
} from './agent-chat-editor-cards.js';
import {
  buildAgentBindingInput,
  buildBackendSubscriptionInput,
  filterDispatchRoutesForSubscription,
  getAgentForSubscription,
  getRoutesForSubscription,
  getSubscriptionById,
  hasDuplicateWorkspaceAppOnAnotherTower,
  resolveSelectedSubscriptionId,
} from './agent-chat-section-state.js';

async function loadOperatorState(selectedSubscriptionId = null) {
  const [subscriptions, agentPayload, sessionPayload, definitionPayload, dispatchRoutes, backendConnections] = await Promise.all([
    listAgentChatSubscriptions(),
    listAgentChatAgents(),
    fetchSessionsApi(),
    fetchPipelineDefinitions().catch(() => ({ definitions: [] })),
    listAgentChatDispatchRoutes().catch(() => []),
    listAgentChatBackendConnections().catch(() => []),
  ]);
  const onboardedSubscriptions = Array.isArray(subscriptions)
    ? subscriptions.filter((subscription) => subscription?.onboardingSource === 'nostr_33357')
    : [];
  const subscriptionPermissions = subscriptions?.permissions;
  const allSessions = Array.isArray(sessionPayload?.sessions) ? sessionPayload.sessions : [];
  const effectiveSelectedSubscriptionId = resolveSelectedSubscriptionId(onboardedSubscriptions, selectedSubscriptionId);
  const selectedSubscription = getSubscriptionById(onboardedSubscriptions, effectiveSelectedSubscriptionId);
  return {
    subscriptions: onboardedSubscriptions,
    agents: Array.isArray(agentPayload?.agents) ? agentPayload.agents : [],
    permissions: subscriptionPermissions || agentPayload?.permissions || { shared: false, canManage: true },
    defaults: agentPayload?.defaults && typeof agentPayload.defaults === 'object' ? agentPayload.defaults : {},
    chatSessions: filterAgentChatSessions(allSessions),
    dispatchRoutes: filterDispatchRoutesForSubscription(dispatchRoutes, effectiveSelectedSubscriptionId),
    allDispatchRoutes: Array.isArray(dispatchRoutes) ? dispatchRoutes : [],
    selectedSubscription,
    selectedSubscriptionId: effectiveSelectedSubscriptionId,
    pipelineDefinitions: Array.isArray(definitionPayload?.definitions) ? definitionPayload.definitions : [],
    backendConnections: Array.isArray(backendConnections) ? backendConnections : [],
  };
}

export function createAgentChatSection({ standalone = false, openDirectoryBrowser = null } = {}) {
  const container = document.createElement('div');
  container.className = 'wm-settings__agent-chat';
  let selectedSubscriptionId = null;
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
  const setupCardsContainer = document.createElement('div');
  setupCardsContainer.setAttribute('data-testid', 'agent-chat-setup-cards');
  const configuredDispatchesContainer = document.createElement('div');
  const profileWorkspaceContainer = document.createElement('div');
  const subscriptionEditor = createSubscriptionEditorCard();
  const connectImportModal = createAgentConnectImportModal({
    onImport: async (input) => {
      const result = await importAgentConnectPackage(input);
      selectedSubscriptionId = result?.subscription?.subscriptionId || selectedSubscriptionId;
      await refreshList();
      return result;
    },
  });
  const agentNameModal = createPrimaryAgentNameModal({
    onBrowseDirectory: openDirectoryBrowser,
    onCreate: async (defaults) => {
      if (!selectedSubscriptionId) {
        throw new Error('Select a workspace subscription before creating a binding.');
      }
      const state = await loadOperatorState(selectedSubscriptionId);
      if (!state.selectedSubscription) {
        throw new Error('Selected workspace subscription was not found.');
      }
      await saveAgentChatAgent(buildAgentBindingInput(state.selectedSubscription, defaults));
      await refreshList();
    },
  });
  const setupPanel = document.createElement('div');
  setupPanel.setAttribute('data-testid', 'agent-chat-setup-panel');
  const setupHeading = document.createElement('h3');
  setupHeading.textContent = 'Workspace Runtime';
  setupPanel.append(setupHeading);
  setupPanel.append(
    statusLine,
    setupCardsContainer,
    subscriptionEditor.card,
    profileWorkspaceContainer,
    configuredDispatchesContainer,
  );
  const operatorPanel = document.createElement('div');
  operatorPanel.setAttribute('data-testid', 'agent-chat-live-panel');
  const liveHeading = document.createElement('h3');
  liveHeading.textContent = 'Live';
  const listContainer = document.createElement('div');
  listContainer.setAttribute('data-testid', 'agent-chat-subscription-list');
  operatorPanel.append(liveHeading, listContainer);
  async function refreshList() {
    setupCardsContainer.replaceChildren();
    configuredDispatchesContainer.replaceChildren();
    profileWorkspaceContainer.replaceChildren();
    listContainer.replaceChildren();

    try {
      const {
        subscriptions,
        agents,
        permissions,
        defaults,
        chatSessions,
        dispatchRoutes,
        allDispatchRoutes,
        selectedSubscription,
        selectedSubscriptionId: effectiveSelectedSubscriptionId,
        pipelineDefinitions,
        backendConnections,
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
      selectedSubscriptionId = effectiveSelectedSubscriptionId;
      const selectedAgent = getAgentForSubscription(agents, selectedSubscription);
      setupCardsContainer.append(createAgentDispatchSetupCards({
        subscription: selectedSubscription,
        primaryAgent: selectedAgent,
        canManage: permissions?.canManage !== false,
        shared: permissions?.shared === true,
        availableBackendConnections: backendConnections,
        onConnectWorkspace: () => connectImportModal.open(),
        onEditSubscription: (subscription) => {
          subscriptionEditor.workspaceOwnerField.input.value = subscription?.workspaceOwnerNpub || '';
          subscriptionEditor.backendUrlField.input.value = subscription?.backendBaseUrl || '';
          subscriptionEditor.sourceAppField.input.value = subscription?.sourceAppNpub || '';
          subscriptionEditor.card.style.display = '';
          subscriptionEditor.workspaceOwnerField.input.focus();
        },
        onUseBackendConnection: async (backendConnection) => {
          statusLine.textContent = 'Creating workspace subscription...';
          const subscription = await saveAgentChatSubscription(buildBackendSubscriptionInput(backendConnection));
          selectedSubscriptionId = subscription?.subscriptionId || selectedSubscriptionId;
          statusLine.textContent = 'Workspace subscription created.';
          await refreshList();
        },
        onSaveBackendAvailability: async (backendConnection, input) => (
          saveAgentChatBackendConnectionAvailability(backendConnection.backendConnectionId, input)
        ),
        onCreateAgent: () => agentNameModal.open(selectedSubscription?.profileWorkspace?.workspace?.workspaceTitle || ''),
        onEditAgent: null,
        onRefresh: refreshList,
      }));
      configuredDispatchesContainer.append(createConfiguredDispatchesPanel(selectedAgent, promptDefaults, {
        subscription: selectedSubscription,
        dispatchRoutes,
        pipelineDefinitions,
        onCreateAgent: null,
        onEditAgent: null,
        onRemoveAgent: null,
        onSaveRoute: permissions?.canManage === false ? null : async (input) => {
          const route = await saveAgentChatDispatchRoute(input);
          await refreshList();
          return route;
        },
        onEditChatTemplate: null,
        onEditTaskTemplate: null,
        onEditFlowDispatchTemplate: null,
        onEditTaskReviewTemplate: null,
        onEditApprovalDispatchTemplate: null,
        onToggleCapability: null,
      }));
      profileWorkspaceContainer.append(createProfileWorkspaceSettingsPanel({
        subscription: selectedSubscription,
        pipelineDefinitions,
        canManage: permissions?.canManage !== false,
        onSave: permissions?.canManage === false || !selectedSubscription
          ? null
          : async (input) => {
              await saveAgentChatProfileWorkspace(selectedSubscription.subscriptionId, input);
              statusLine.textContent = 'Profile workspace settings saved.';
              await refreshList();
          },
      }));
      if (subscriptions.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'wm-settings__port-note';
        empty.textContent = 'No Flight Deck workspace onboarding events have been imported for this agent yet.';
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
        select: (subscription) => {
          selectedSubscriptionId = subscription.subscriptionId;
          statusLine.textContent = 'Loading selected workspace subscription...';
          void refreshList();
        },
        edit: (subscription) => {
          selectedSubscriptionId = subscription.subscriptionId;
          subscriptionEditor.workspaceOwnerField.input.value = subscription?.workspaceOwnerNpub || '';
          subscriptionEditor.backendUrlField.input.value = subscription?.backendBaseUrl || '';
          subscriptionEditor.sourceAppField.input.value = subscription?.sourceAppNpub || '';
          subscriptionEditor.card.style.display = '';
          subscriptionEditor.workspaceOwnerField.input.focus();
        },
        remove: async (subscription) => {
          statusLine.textContent = 'Removing workspace subscription...';
          try {
            await deleteAgentChatSubscription(subscription.subscriptionId);
            if (selectedSubscriptionId === subscription.subscriptionId) {
              selectedSubscriptionId = null;
            }
            statusLine.textContent = 'Workspace subscription removed.';
            await refreshList();
          } catch (error) {
            statusLine.textContent = error instanceof Error ? error.message : 'Failed to remove workspace subscription.';
          }
        },
        dispatchRoutes,
        getDispatchRoutes: (subscription) => getRoutesForSubscription(allDispatchRoutes, subscription.subscriptionId),
        hasDuplicateWorkspaceApp: (subscription) => hasDuplicateWorkspaceAppOnAnotherTower(subscriptions, subscription),
        selectedSubscriptionId,
        pipelineDefinitions,
        allowConnectionManagement: true,
      };

      subscriptions.forEach((subscription) => {
        listContainer.append(createSubscriptionCard(subscription, chatSessions, handlers));
      });
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to load Agent Dispatch state.';
    }
  }
  subscriptionEditor.saveButton.addEventListener('click', async () => {
    const workspaceOwnerNpub = subscriptionEditor.workspaceOwnerField.input.value.trim();
    const backendBaseUrl = subscriptionEditor.backendUrlField.input.value.trim();
    const sourceAppNpub = subscriptionEditor.sourceAppField.input.value.trim();
    if (!workspaceOwnerNpub || !backendBaseUrl || !sourceAppNpub) {
      statusLine.textContent = 'Workspace owner, backend URL, and source app are required.';
      return;
    }
    subscriptionEditor.saveButton.disabled = true;
    statusLine.textContent = 'Saving workspace subscription...';
    try {
      const subscription = await saveAgentChatSubscription({
        workspaceOwnerNpub,
        backendBaseUrl,
        sourceAppNpub,
      });
      selectedSubscriptionId = subscription?.subscriptionId || selectedSubscriptionId;
      subscriptionEditor.card.style.display = 'none';
      statusLine.textContent = 'Workspace subscription saved.';
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to save workspace subscription.';
    } finally {
      subscriptionEditor.saveButton.disabled = false;
    }
  });
  subscriptionEditor.closeButton.addEventListener('click', () => {
    subscriptionEditor.card.style.display = 'none';
  });
  container.append(operatorPanel, setupPanel);
  container.append(connectImportModal.element, agentNameModal.element);
  void refreshList();
  return container;
}
