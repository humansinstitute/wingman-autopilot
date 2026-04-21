/**
 * Workspace settings sections shared by the Settings view.
 */

import {
  deleteUserSetting,
  fetchUserSettings,
  saveUserSetting,
} from '../../services/user-settings.js';

function loadUserSettings() {
  return fetchUserSettings().catch(() => ({}));
}

function createRowLabel(text, minWidth = 140) {
  const label = document.createElement('label');
  label.textContent = text;
  label.style.cssText = `font-size:0.85em;font-weight:500;min-width:${minWidth}px;`;
  return label;
}

function createInput(placeholder, type = 'text') {
  const input = document.createElement('input');
  input.type = type;
  input.placeholder = placeholder;
  input.className = 'wm-input';
  input.style.cssText = 'flex:1;font-family:monospace;font-size:0.85em;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text);';
  return input;
}

function createStatusText() {
  const status = document.createElement('span');
  status.style.cssText = 'font-size:0.8em;color:var(--text-muted);';
  return status;
}

function setStatus(status, message, color = 'var(--text-muted)') {
  status.textContent = message;
  status.style.color = color;
}

function createActionButton(text) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wm-button secondary';
  button.textContent = text;
  button.style.cssText = 'font-size:0.85em;padding:6px 12px;';
  return button;
}

export function createApiKeysSection() {
  const container = document.createElement('div');
  container.className = 'wm-settings__api-keys';

  const heading = document.createElement('h3');
  heading.textContent = 'API Keys';
  container.append(heading);

  const description = document.createElement('p');
  description.className = 'wm-settings__port-note';
  description.textContent = 'Configure API keys for agent tools. Keys are stored per-user and used when agents generate images or call external APIs.';
  container.append(description);

  const keyRow = document.createElement('div');
  keyRow.className = 'wm-settings__key-row';
  keyRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';

  const label = createRowLabel('OpenRouter API Key');
  const input = createInput('sk-or-...', 'password');
  const saveBtn = createActionButton('Save');
  const clearBtn = createActionButton('Clear');
  const status = createStatusText();

  loadUserSettings().then((settings) => {
    const masked = settings.openrouter_api_key;
    if (masked) {
      input.placeholder = masked;
      setStatus(status, 'Key set', 'var(--success, #4caf50)');
    }
  });

  saveBtn.addEventListener('click', async () => {
    const value = input.value.trim();
    if (!value) return;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      await saveUserSetting('openrouter_api_key', value);
      input.value = '';
      input.placeholder = value.slice(0, 4) + '..' + value.slice(-4);
      setStatus(status, 'Saved', 'var(--success, #4caf50)');
    } catch (error) {
      setStatus(status, error.message || 'Save failed', 'var(--error, #f44336)');
    }

    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  });

  clearBtn.addEventListener('click', async () => {
    clearBtn.disabled = true;
    try {
      await deleteUserSetting('openrouter_api_key');
      input.value = '';
      input.placeholder = 'sk-or-...';
      setStatus(status, 'Cleared');
    } catch (error) {
      setStatus(status, error.message || 'Failed to clear', 'var(--error, #f44336)');
    }
    clearBtn.disabled = false;
  });

  keyRow.append(label, input, saveBtn, clearBtn, status);
  container.append(keyRow);

  const helpText = document.createElement('p');
  helpText.className = 'wm-settings__port-note';
  helpText.style.cssText = 'margin-top:6px;font-size:0.8em;';
  helpText.innerHTML = 'Get your API key from <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>. Used by the <code>generate_image</code> agent tool.';
  container.append(helpText);

  return container;
}

export function createGitHubSection() {
  const container = document.createElement('div');
  container.className = 'wm-settings__github';
  container.style.cssText = 'margin-top:16px;';

  const heading = document.createElement('h3');
  heading.textContent = 'GitHub';
  container.append(heading);

  const description = document.createElement('p');
  description.className = 'wm-settings__port-note';
  description.textContent = 'Optional per-user HTTPS credentials for GitHub remotes. Used by GitHub pull/push actions in Live sessions and stored encrypted at rest.';
  container.append(description);

  const usernameRow = document.createElement('div');
  usernameRow.className = 'wm-settings__key-row';
  usernameRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';

  const usernameLabel = createRowLabel('GitHub Username');
  const usernameInput = createInput('x-access-token');
  usernameRow.append(usernameLabel, usernameInput);

  const tokenRow = document.createElement('div');
  tokenRow.className = 'wm-settings__key-row';
  tokenRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';

  const tokenLabel = createRowLabel('Personal Access Token');
  const tokenInput = createInput('ghp_...', 'password');
  tokenRow.append(tokenLabel, tokenInput);

  const actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';

  const saveBtn = createActionButton('Save');
  const clearBtn = createActionButton('Clear');
  const status = createStatusText();

  let currentUsername = 'x-access-token';

  loadUserSettings().then((settings) => {
    const storedUsername = typeof settings.github_username === 'string' ? settings.github_username.trim() : '';
    const tokenMasked = settings.github_api_key || settings.github_token;

    if (storedUsername) {
      currentUsername = storedUsername;
      usernameInput.value = storedUsername;
    }

    if (tokenMasked) {
      tokenInput.placeholder = tokenMasked;
      setStatus(status, 'Credential set', 'var(--success, #4caf50)');
    }
  });

  saveBtn.addEventListener('click', async () => {
    const token = tokenInput.value.trim();
    const username = usernameInput.value.trim() || currentUsername || 'x-access-token';

    if (!token) {
      setStatus(status, 'Token is required', 'var(--error, #f44336)');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      await Promise.all([
        saveUserSetting('github_username', username),
        saveUserSetting('github_api_key', token),
      ]);
      currentUsername = username;
      usernameInput.value = username;
      tokenInput.value = '';
      tokenInput.placeholder = token.slice(0, 4) + '..' + token.slice(-4);
      setStatus(status, 'Saved', 'var(--success, #4caf50)');
    } catch (error) {
      setStatus(status, error.message || 'Save failed', 'var(--error, #f44336)');
    }

    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  });

  clearBtn.addEventListener('click', async () => {
    clearBtn.disabled = true;
    try {
      await Promise.all([
        deleteUserSetting('github_api_key'),
        deleteUserSetting('github_token'),
        deleteUserSetting('github_username'),
        deleteUserSetting('github_user'),
      ]);

      currentUsername = 'x-access-token';
      usernameInput.value = '';
      usernameInput.placeholder = 'x-access-token';
      tokenInput.value = '';
      tokenInput.placeholder = 'ghp_...';
      setStatus(status, 'Cleared');
    } catch (error) {
      setStatus(status, error.message || 'Failed to clear', 'var(--error, #f44336)');
    }
    clearBtn.disabled = false;
  });

  actionsRow.append(saveBtn, clearBtn, status);

  const helpText = document.createElement('p');
  helpText.className = 'wm-settings__port-note';
  helpText.style.cssText = 'margin-top:6px;font-size:0.8em;';
  helpText.innerHTML = 'Create a token at <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">github.com/settings/tokens</a>. Works with HTTPS remotes on <code>github.com</code>.';

  container.append(usernameRow, tokenRow, actionsRow, helpText);
  return container;
}

export function createGiteaSection(giteaUrl) {
  const container = document.createElement('div');
  container.className = 'wm-settings__gitea';
  container.style.cssText = 'margin-top:16px;';

  const heading = document.createElement('h3');
  heading.textContent = 'Gitea';
  container.append(heading);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:12px;align-items:center;margin-top:8px;';

  const usernameLabel = document.createElement('span');
  usernameLabel.style.cssText = 'font-size:0.85em;font-weight:500;min-width:80px;';
  usernameLabel.textContent = 'Username:';

  const usernameValue = document.createElement('code');
  usernameValue.style.cssText = 'font-size:0.85em;color:var(--text-muted);';
  usernameValue.textContent = 'Loading...';

  const statusBadge = document.createElement('span');
  statusBadge.style.cssText = 'font-size:0.8em;padding:2px 8px;border-radius:10px;';

  const repoLink = document.createElement('a');
  repoLink.style.cssText = 'font-size:0.85em;display:none;';
  repoLink.target = '_blank';
  repoLink.rel = 'noopener';
  repoLink.textContent = 'My Repositories';

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'wm-button secondary';
  resetBtn.textContent = 'Reset';
  resetBtn.style.cssText = 'font-size:0.8em;padding:4px 10px;margin-left:auto;display:none;';
  resetBtn.title = 'Clear stored Gitea credentials — re-provisioned on next login';

  loadUserSettings()
    .then((settings) => {
      const username = settings.gitea_username;
      const token = settings.gitea_api_token;
      if (username && token) {
        usernameValue.textContent = username;
        statusBadge.textContent = 'Account active';
        statusBadge.style.background = 'var(--success, #4caf50)';
        statusBadge.style.color = '#fff';
        repoLink.href = `${giteaUrl}/${username}`;
        repoLink.style.display = 'inline';
        resetBtn.style.display = 'inline-block';
      } else {
        usernameValue.textContent = '—';
        statusBadge.textContent = 'Not provisioned';
        statusBadge.style.background = 'var(--bg-secondary)';
        statusBadge.style.color = 'var(--text-muted)';
      }
    })
    .catch(() => {
      usernameValue.textContent = 'Error loading';
    });

  resetBtn.addEventListener('click', async () => {
    resetBtn.disabled = true;
    resetBtn.textContent = 'Resetting...';
    try {
      await deleteUserSetting('gitea_api_token');
      await deleteUserSetting('gitea_username');
      usernameValue.textContent = '—';
      statusBadge.textContent = 'Reset — log in again to re-provision';
      statusBadge.style.background = 'var(--bg-secondary)';
      statusBadge.style.color = 'var(--text-muted)';
      repoLink.style.display = 'none';
      resetBtn.style.display = 'none';
    } catch (error) {
      resetBtn.textContent = error.message || 'Failed';
    }
    resetBtn.disabled = false;
    resetBtn.textContent = 'Reset';
  });

  row.append(usernameLabel, usernameValue, statusBadge, repoLink, resetBtn);
  container.append(row);

  const helpText = document.createElement('p');
  helpText.className = 'wm-settings__port-note';
  helpText.style.cssText = 'margin-top:6px;font-size:0.8em;';
  helpText.textContent = 'Your Gitea account is auto-provisioned on login. Repos you create via agents are owned by your account.';
  container.append(helpText);

  return container;
}
