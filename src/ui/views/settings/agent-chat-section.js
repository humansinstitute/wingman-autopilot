import {
  listAgentChatDispatchRoutes,
  listAgentChatAgents,
  listAgentChatSubscriptions,
  runAgentChatSubscriptionAction,
  saveAgentChatDispatchRoute,
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
import {
  filterDispatchRoutesForSubscription,
  getAgentForSubscription,
  getRoutesForSubscription,
  getSubscriptionById,
  resolveSelectedSubscriptionId,
} from './agent-chat-section-state.js';

async function loadOperatorState(selectedSubscriptionId = null) {
  const [subscriptions, agentPayload, sessionPayload, definitionPayload, dispatchRoutes] = await Promise.all([
    listAgentChatSubscriptions(),
    listAgentChatAgents(),
    fetchSessionsApi(),
    fetchPipelineDefinitions().catch(() => ({ definitions: [] })),
    listAgentChatDispatchRoutes().catch(() => []),
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
  };
}

export function createAgentChatSection({ standalone = false } = {}) {
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
  const configuredDispatchesContainer = document.createElement('div');
  const profileWorkspaceContainer = document.createElement('div');
  const setupPanel = document.createElement('div');
  setupPanel.setAttribute('data-testid', 'agent-chat-setup-panel');
  const setupHeading = document.createElement('h3');
  setupHeading.textContent = 'Workspace Runtime';
  setupPanel.append(setupHeading);
  setupPanel.append(
    statusLine,
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
        dispatchRoutes,
        getDispatchRoutes: (subscription) => getRoutesForSubscription(allDispatchRoutes, subscription.subscriptionId),
        selectedSubscriptionId,
        pipelineDefinitions,
        allowConnectionManagement: false,
      };

      subscriptions.forEach((subscription) => {
        listContainer.append(createSubscriptionCard(subscription, chatSessions, handlers));
      });
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to load Agent Dispatch state.';
    }
  }
  container.append(operatorPanel, setupPanel);
  void refreshList();
  return container;
}
