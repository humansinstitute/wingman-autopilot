import {
  createButton,
  createCard,
  createInlineActions,
  createStatusLine,
  createTextarea,
} from './agent-chat-shared-ui.js';

function createAgentOption(agent) {
  const option = document.createElement('option');
  option.value = agent.agentId || '';
  option.textContent = agent.label && agent.label !== agent.agentId
    ? `${agent.label} (${agent.agentId})`
    : agent.agentId || 'Unnamed agent';
  return option;
}

function createAgentSelect(agents) {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:10px;';
  row.textContent = 'Local Agent Profile';

  const select = document.createElement('select');
  select.className = 'wm-input';
  select.setAttribute('aria-label', 'Local Agent Profile');
  select.setAttribute('data-testid', 'agent-connect-agent-profile');

  if (!Array.isArray(agents) || agents.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Create an Agent Profile first';
    select.append(option);
    select.disabled = true;
  } else {
    agents.forEach((agent) => select.append(createAgentOption(agent)));
  }

  row.append(select);
  return { row, select };
}

function formatImportSummary(payload) {
  const backend = payload?.backendConnection;
  const subscription = payload?.subscription;
  const backendStatus = backend?.healthStatus || 'unknown';
  const workspace = subscription?.workspaceOwnerNpub || 'workspace';
  const bot = subscription?.botNpub || 'selected bot';
  return `Imported ${workspace} for ${bot}. Backend health is ${backendStatus}.`;
}

export function createAgentConnectImportCard({
  agents = [],
  onImport,
}) {
  const card = createCard(
    'Agent Connect Import',
    'Paste the Flight Deck Agent Connect package, select the local Agent Profile whose bot identity should subscribe, then import the workspace connection.',
  );
  card.setAttribute('data-testid', 'agent-connect-import-card');

  const agentSelect = createAgentSelect(agents);
  const packageField = createTextarea(
    'Agent Connect JSON',
    '{ "kind": "coworker_agent_connect", ... }',
    'agent-connect-json',
    8,
  );
  const statusLine = createStatusLine();
  statusLine.setAttribute('data-testid', 'agent-connect-import-status');

  const importButton = createButton(
    'Import Workspace',
    'agent-connect-import-submit',
    'Import Agent Connect workspace',
  );
  importButton.disabled = agentSelect.select.disabled;
  importButton.addEventListener('click', async () => {
    const packageJson = packageField.input.value.trim();
    const agentProfileId = agentSelect.select.value.trim();
    if (!agentProfileId) {
      statusLine.textContent = 'Select a local Agent Profile before importing.';
      return;
    }
    if (!packageJson) {
      statusLine.textContent = 'Paste Agent Connect JSON before importing.';
      packageField.input.focus();
      return;
    }

    importButton.disabled = true;
    statusLine.textContent = 'Importing Agent Connect package...';
    try {
      const payload = await onImport?.({ packageJson, agentProfileId });
      statusLine.textContent = formatImportSummary(payload);
      packageField.input.value = '';
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Agent Connect import failed.';
    } finally {
      importButton.disabled = agentSelect.select.disabled;
    }
  });

  card.append(
    agentSelect.row,
    packageField.row,
    createInlineActions(importButton),
    statusLine,
  );
  return card;
}
