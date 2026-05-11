import {
  createButton,
  createInlineActions,
  createStatusLine,
  createTextarea,
} from './agent-chat-shared-ui.js';

function formatImportSummary(payload) {
  const backend = payload?.backendConnection;
  const subscription = payload?.subscription;
  const backendStatus = backend?.healthStatus || 'unknown';
  const workspace = subscription?.workspaceOwnerNpub || 'workspace';
  const bot = subscription?.botNpub || 'Wingman bot';
  return `Connected ${workspace} for ${bot}. Backend health is ${backendStatus}.`;
}

function setModalVisible(overlay, visible) {
  overlay.hidden = !visible;
  overlay.style.display = visible ? 'flex' : 'none';
}

export function createAgentConnectImportModal({
  onImport,
}) {
  const overlay = document.createElement('div');
  overlay.hidden = true;
  overlay.className = 'wm-modal-backdrop';
  overlay.setAttribute('data-testid', 'agent-connect-import-modal');
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:1000',
    'display:none',
    'align-items:center',
    'justify-content:center',
    'padding:20px',
    'background:rgba(0,0,0,0.46)',
  ].join(';');

  const panel = document.createElement('section');
  panel.className = 'wm-card';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'agent-connect-import-title');
  panel.style.cssText = [
    'width:min(860px,100%)',
    'max-height:min(86vh,820px)',
    'overflow:auto',
    'padding:18px',
    'border-radius:8px',
    'box-shadow:0 18px 60px rgba(0,0,0,0.28)',
  ].join(';');

  const heading = document.createElement('h3');
  heading.id = 'agent-connect-import-title';
  heading.textContent = 'Connect Workspace';

  const note = document.createElement('p');
  note.className = 'wm-settings__port-note';
  note.textContent = 'Paste the full AgentConnect token. Wingman will read the service, workspace, app, and connection token values from it and subscribe with the configured Wingman bot identity.';

  const packageField = createTextarea(
    'AgentConnect token',
    '======AGENTCONNECT-TOKEN======\n{ "kind": "coworker_agent_connect", ... }\n======AGENTCONNECT-TOKEN======',
    'agent-connect-json',
    16,
  );
  packageField.input.spellcheck = false;
  packageField.input.style.fontFamily = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';
  packageField.input.style.minHeight = '340px';

  const statusLine = createStatusLine();
  statusLine.setAttribute('data-testid', 'agent-connect-import-status');

  const importButton = createButton(
    'Connect Workspace',
    'agent-connect-import-submit',
    'Import AgentConnect workspace token',
  );
  const cancelButton = createButton(
    'Cancel',
    'agent-connect-import-cancel',
    'Close AgentConnect import',
    'secondary',
  );

  cancelButton.addEventListener('click', () => {
    setModalVisible(overlay, false);
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      setModalVisible(overlay, false);
    }
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setModalVisible(overlay, false);
    }
  });

  importButton.addEventListener('click', async () => {
    const packageJson = packageField.input.value.trim();
    if (!packageJson) {
      statusLine.textContent = 'Paste an AgentConnect token before connecting.';
      packageField.input.focus();
      return;
    }

    importButton.disabled = true;
    statusLine.textContent = 'Connecting workspace...';
    try {
      const payload = await onImport?.({ packageJson });
      statusLine.textContent = formatImportSummary(payload);
      packageField.input.value = '';
      setModalVisible(overlay, false);
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'AgentConnect import failed.';
    } finally {
      importButton.disabled = false;
    }
  });

  panel.append(
    heading,
    note,
    packageField.row,
    createInlineActions(importButton, cancelButton),
    statusLine,
  );
  overlay.append(panel);

  return {
    element: overlay,
    open() {
      statusLine.textContent = '';
      setModalVisible(overlay, true);
      packageField.input.focus();
    },
  };
}
