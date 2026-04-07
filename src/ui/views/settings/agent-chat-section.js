import {
  listAgentChatSubscriptions,
  saveAgentChatSubscription,
  deleteAgentChatSubscription,
} from '../../services/agent-chat.js';

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

function formatDiagnostic(diagnostic) {
  if (!diagnostic) return 'None';
  const status = diagnostic.ok ? 'ok' : (diagnostic.code || 'failed');
  return `${status} at ${diagnostic.at}`;
}

function createSubscriptionCard(subscription, onRemove) {
  const card = document.createElement('article');
  card.className = 'wm-card';
  card.style.cssText = 'margin-top:12px;padding:14px;';
  card.setAttribute('data-testid', `agent-chat-subscription-${subscription.subscriptionId}`);

  const heading = document.createElement('h4');
  heading.textContent = `${subscription.workspaceOwnerNpub} → ${subscription.botNpub}`;
  card.append(heading);

  const status = document.createElement('p');
  status.className = 'wm-settings__port-note';
  status.textContent = `health=${subscription.healthStatus}, ws_key=${subscription.wsKeyStatus}, group_keys=${subscription.groupKeyStatus}, sse=${subscription.sseStatus}`;
  card.append(status);

  const details = document.createElement('dl');
  details.style.cssText = 'display:grid;grid-template-columns:max-content 1fr;gap:6px 12px;font-size:0.9em;';
  const rows = [
    ['Backend', subscription.backendBaseUrl],
    ['Source App', subscription.sourceAppNpub],
    ['ws_key_npub', subscription.wsKeyNpub || 'pending'],
    ['Last SSE Event', subscription.lastSseEvent?.eventType ? `${subscription.lastSseEvent.eventType} @ ${subscription.lastSseEvent.at}` : 'None'],
    ['Last Decrypt', formatDiagnostic(subscription.lastDecryptResult)],
    ['Last Auth', formatDiagnostic(subscription.lastAuthResult)],
    ['Group Refresh', formatDiagnostic(subscription.lastGroupRefreshResult)],
    ['Startup Reload', subscription.lastSuccessfulStartupReloadAt || 'None'],
    ['Last Error', subscription.lastErrorCode ? `${subscription.lastErrorCode} @ ${subscription.lastErrorAt}` : 'None'],
  ];
  rows.forEach(([termText, valueText]) => {
    const term = document.createElement('dt');
    term.textContent = termText;
    const value = document.createElement('dd');
    value.textContent = valueText;
    value.style.margin = '0';
    details.append(term, value);
  });
  card.append(details);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;justify-content:flex-end;margin-top:10px;';
  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'wm-button secondary';
  removeButton.textContent = 'Remove';
  removeButton.setAttribute('aria-label', `Remove Agent Chat subscription for ${subscription.workspaceOwnerNpub}`);
  removeButton.addEventListener('click', () => onRemove(subscription));
  actions.append(removeButton);
  card.append(actions);

  return card;
}

export function createAgentChatSection() {
  const container = document.createElement('div');
  container.className = 'wm-settings__agent-chat';

  const heading = document.createElement('h3');
  heading.textContent = 'Agent Chat';
  container.append(heading);

  const description = document.createElement('p');
  description.className = 'wm-settings__port-note';
  description.textContent = 'Bootstraps a bot-owned workspace subscription, registers its workspace key through the browser signer, refreshes wrapped group keys, and exposes restart-safe diagnostics.';
  container.append(description);

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

  const statusLine = createStatusLine();
  const listContainer = document.createElement('div');
  listContainer.setAttribute('data-testid', 'agent-chat-subscription-list');

  const refreshList = async () => {
    listContainer.replaceChildren();
    try {
      const items = await listAgentChatSubscriptions();
      if (items.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'wm-settings__port-note';
        empty.textContent = 'No Agent Chat subscriptions yet.';
        listContainer.append(empty);
        return;
      }

      items.forEach((subscription) => {
        listContainer.append(createSubscriptionCard(subscription, async (target) => {
          statusLine.textContent = 'Removing subscription...';
          try {
            await deleteAgentChatSubscription(target.subscriptionId);
            statusLine.textContent = 'Subscription removed.';
            await refreshList();
          } catch (error) {
            statusLine.textContent = error instanceof Error ? error.message : 'Failed to remove subscription.';
          }
        }));
      });
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to load subscriptions.';
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
      statusLine.textContent = 'Subscription saved. Check diagnostics below for bootstrap and decrypt status.';
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to bootstrap subscription.';
    } finally {
      saveButton.disabled = false;
    }
  });

  container.append(
    workspaceOwnerField.row,
    backendUrlField.row,
    sourceAppField.row,
    triggerField.row,
    saveButton,
    statusLine,
    listContainer,
  );

  void refreshList();
  return container;
}
