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

export function createAgentChatSection() {
  const container = document.createElement('div');
  container.className = 'wm-settings__agent-chat';

  const heading = document.createElement('h3');
  heading.textContent = 'Agent Chat';
  container.append(heading);

  const description = document.createElement('p');
  description.className = 'wm-settings__port-note';
  description.textContent = 'Operator surfaces for workspace subscription health, local agent registration, canonical intercept state, candidate routing decisions, and repair flows. Raw logs remain fallback-only.';
  container.append(description);

  const modelNote = document.createElement('p');
  modelNote.className = 'wm-settings__port-note';
  modelNote.textContent = 'Agent-first routing is local to Wingmen: subscriptions own Tower transport and keys, while local agents own group-targeted chat intercept policy. Legacy trigger record IDs remain deprecated and are no longer required in the normal path.';
  container.append(modelNote);

  const eventIdNote = document.createElement('p');
  eventIdNote.className = 'wm-settings__port-note';
  eventIdNote.textContent = 'Workspace SSE event IDs are stream counters, not readable chat-message counters. Gaps can be normal when unrelated or unreadable workspace events are present.';
  container.append(eventIdNote);

  const workspaceOwnerField = createInput('Workspace Owner npub', 'npub1workspace...', 'agent-chat-workspace-owner');
  const backendUrlField = createInput('Backend Base URL', 'https://tower.example.com', 'agent-chat-backend-url');
  const sourceAppField = createInput('Source App npub', 'npub1flightdeckapp...', 'agent-chat-source-app');
  const agentIdField = createInput('Agent ID', 'agent_wm21', 'agent-chat-agent-id');
  const labelField = createInput('Agent Label', 'Wingman 21', 'agent-chat-agent-label', true);
  const agentBotField = createInput('Agent Bot npub', 'npub1bot...', 'agent-chat-agent-bot');
  const agentWorkspaceField = createInput('Agent Workspace Owner npub', 'npub1workspace...', 'agent-chat-agent-workspace-owner');
  const agentGroupsField = createInput('Group npubs', 'Leave blank to use the bot subscription groups', 'agent-chat-agent-groups', true);
  const workingDirectoryField = createInput('Working Directory', '/Users/mini/code/wingmen', 'agent-chat-agent-directory');
  const enabledField = createCheckbox('Enabled', 'agent-chat-agent-enabled', true);

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'wm-button secondary';
  saveButton.textContent = 'Create / Refresh Subscription';
  saveButton.setAttribute('aria-label', 'Create or refresh Agent Chat subscription');
  saveButton.setAttribute('data-testid', 'agent-chat-save');
  saveButton.style.marginTop = '12px';

  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.className = 'wm-button secondary';
  refreshButton.textContent = 'Refresh Operator View';
  refreshButton.setAttribute('aria-label', 'Refresh Agent Chat operator view');
  refreshButton.setAttribute('data-testid', 'agent-chat-refresh-view');
  refreshButton.style.margin = '12px 0 0 8px';

  const saveAgentButton = document.createElement('button');
  saveAgentButton.type = 'button';
  saveAgentButton.className = 'wm-button secondary';
  saveAgentButton.textContent = 'Save Local Agent';
  saveAgentButton.setAttribute('aria-label', 'Create or update local Agent Chat agent');
  saveAgentButton.setAttribute('data-testid', 'agent-chat-save-agent');
  saveAgentButton.style.marginTop = '12px';

  const statusLine = createStatusLine();
  const agentGroupsNote = document.createElement('p');
  agentGroupsNote.className = 'wm-settings__port-note';
  agentGroupsNote.textContent = 'Leave group npubs blank to derive them from the bot groups already refreshed from Tower for this workspace subscription.';
  const overviewContainer = document.createElement('div');
  const agentRegistryContainer = document.createElement('div');
  const listContainer = document.createElement('div');
  listContainer.setAttribute('data-testid', 'agent-chat-subscription-list');
  const sessionContainer = document.createElement('div');
  sessionContainer.setAttribute('data-testid', 'agent-chat-session-list');

  const refreshList = async () => {
    overviewContainer.replaceChildren();
    agentRegistryContainer.replaceChildren();
    listContainer.replaceChildren();
    sessionContainer.replaceChildren();
    try {
      const { subscriptions, agents, chatSessions } = await loadOperatorState();
      overviewContainer.append(createAgentChatOverview(subscriptions, chatSessions));
      agentRegistryContainer.append(createAgentRegistryPanel(agents, {
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
      sessionContainer.append(createAgentChatSessionPanel(chatSessions));

      if (subscriptions.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'wm-settings__port-note';
        empty.textContent = 'No Agent Chat subscriptions yet.';
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
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to load Agent Chat operator state.';
    }
  };

  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true;
    statusLine.textContent = 'Bootstrapping subscription...';
    try {
      await saveAgentChatSubscription({
        workspaceOwnerNpub: workspaceOwnerField.input.value.trim(),
        backendBaseUrl: backendUrlField.input.value.trim(),
        sourceAppNpub: sourceAppField.input.value.trim(),
      });
      statusLine.textContent = 'Subscription saved. Operator diagnostics updated below.';
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to bootstrap subscription.';
    } finally {
      saveButton.disabled = false;
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
        capabilities: ['chat_intercept'],
        enabled: enabledField.input.checked,
      });
      statusLine.textContent = 'Local agent saved. Candidate routing diagnostics updated below.';
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to save local agent.';
    } finally {
      saveAgentButton.disabled = false;
    }
  });

  refreshButton.addEventListener('click', () => {
    statusLine.textContent = 'Refreshing operator view...';
    void refreshList().then(() => {
      if (!statusLine.textContent || statusLine.textContent === 'Refreshing operator view...') {
        statusLine.textContent = 'Operator view refreshed.';
      }
    });
  });

  container.append(
    workspaceOwnerField.row,
    backendUrlField.row,
    sourceAppField.row,
    saveButton,
    refreshButton,
    agentIdField.row,
    labelField.row,
    agentBotField.row,
    agentWorkspaceField.row,
    agentGroupsField.row,
    workingDirectoryField.row,
    enabledField.row,
    agentGroupsNote,
    saveAgentButton,
    statusLine,
    overviewContainer,
    agentRegistryContainer,
    sessionContainer,
    listContainer,
  );

  void refreshList();
  return container;
}
