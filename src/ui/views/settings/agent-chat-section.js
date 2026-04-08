import {
  listAgentChatSubscriptions,
  saveAgentChatSubscription,
  deleteAgentChatSubscription,
  runAgentChatSubscriptionAction,
} from '../../services/agent-chat.js';
import { fetchSessionsApi } from '../../services/sessions.js';
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

async function loadOperatorState() {
  const [subscriptions, sessionPayload] = await Promise.all([
    listAgentChatSubscriptions(),
    fetchSessionsApi(),
  ]);
  const allSessions = Array.isArray(sessionPayload?.sessions) ? sessionPayload.sessions : [];
  return {
    subscriptions,
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
  description.textContent = 'Operator surfaces for workspace subscription health, canonical intercept state, linked Agent Chat sessions, and repair flows. Raw logs remain fallback-only.';
  container.append(description);

  const eventIdNote = document.createElement('p');
  eventIdNote.className = 'wm-settings__port-note';
  eventIdNote.textContent = 'Workspace SSE event IDs are stream counters, not readable chat-message counters. Gaps can be normal when unrelated or unreadable workspace events are present.';
  container.append(eventIdNote);

  const workspaceOwnerField = createInput('Workspace Owner npub', 'npub1workspace...', 'agent-chat-workspace-owner');
  const backendUrlField = createInput('Backend Base URL', 'https://tower.example.com', 'agent-chat-backend-url');
  const sourceAppField = createInput('Source App npub', 'npub1flightdeckapp...', 'agent-chat-source-app');
  const triggerField = createInput('Trigger Record ID', 'uuid or Tower record id', 'agent-chat-trigger-id', true);

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

  const statusLine = createStatusLine();
  const overviewContainer = document.createElement('div');
  const listContainer = document.createElement('div');
  listContainer.setAttribute('data-testid', 'agent-chat-subscription-list');
  const sessionContainer = document.createElement('div');
  sessionContainer.setAttribute('data-testid', 'agent-chat-session-list');

  const refreshList = async () => {
    overviewContainer.replaceChildren();
    listContainer.replaceChildren();
    sessionContainer.replaceChildren();
    try {
      const { subscriptions, chatSessions } = await loadOperatorState();
      overviewContainer.append(createAgentChatOverview(subscriptions, chatSessions));
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
        triggerConfigRecordId: triggerField.input.value.trim() || null,
      });
      statusLine.textContent = 'Subscription saved. Operator diagnostics updated below.';
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to bootstrap subscription.';
    } finally {
      saveButton.disabled = false;
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
    triggerField.row,
    saveButton,
    refreshButton,
    statusLine,
    overviewContainer,
    sessionContainer,
    listContainer,
  );

  void refreshList();
  return container;
}
