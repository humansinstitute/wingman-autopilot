/**
 * Settings page renderer — identity, wingman settings, admin tools.
 *
 * Depends on: state, render, various panel renderers, admin APIs (via DI).
 */

import { createSettingsTabs } from './settings-tabs.js';

export function initSettingsView(deps) {
  const {
    state,
    appsStore,
    getCurrentRoute,
    render,
    normalisePortList,
    generateAdminPorts,
    renderIdentityPanel,
    renderFeatureFlagsPanel,
    ensureFeatureFlagsLoaded,
    renderAdminUsersPanel,
    fetchAdminUsers,
    renderWingmanCard,
    npubProjectsState,
    fetchNpubProjects,
    renderNpubProjectsPanel,
  } = deps;

  function renderApiKeysSection() {
    const container = document.createElement('div');
    container.className = 'wm-settings__api-keys';

    const heading = document.createElement('h3');
    heading.textContent = 'API Keys';
    container.append(heading);

    const description = document.createElement('p');
    description.className = 'wm-settings__port-note';
    description.textContent = 'Configure API keys for agent tools. Keys are stored per-user and used when agents generate images or call external APIs.';
    container.append(description);

    // OpenRouter API Key
    const keyRow = document.createElement('div');
    keyRow.className = 'wm-settings__key-row';
    keyRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';

    const label = document.createElement('label');
    label.textContent = 'OpenRouter API Key';
    label.style.cssText = 'font-size:0.85em;font-weight:500;min-width:140px;';

    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'sk-or-...';
    input.className = 'wm-input';
    input.style.cssText = 'flex:1;font-family:monospace;font-size:0.85em;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text);';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'wm-button secondary';
    saveBtn.textContent = 'Save';
    saveBtn.style.cssText = 'font-size:0.85em;padding:6px 12px;';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'wm-button secondary';
    clearBtn.textContent = 'Clear';
    clearBtn.style.cssText = 'font-size:0.85em;padding:6px 12px;';

    const status = document.createElement('span');
    status.style.cssText = 'font-size:0.8em;color:var(--text-muted);';

    // Load current masked value
    fetch('/api/user/settings')
      .then((r) => r.json())
      .then((data) => {
        const masked = data.settings?.openrouter_api_key;
        if (masked) {
          input.placeholder = masked;
          status.textContent = 'Key set';
          status.style.color = 'var(--success, #4caf50)';
        }
      })
      .catch(() => {});

    saveBtn.addEventListener('click', async () => {
      const value = input.value.trim();
      if (!value) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        const resp = await fetch('/api/user/settings/openrouter_api_key', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
        if (resp.ok) {
          input.value = '';
          input.placeholder = value.slice(0, 4) + '..' + value.slice(-4);
          status.textContent = 'Saved';
          status.style.color = 'var(--success, #4caf50)';
        } else {
          const err = await resp.json();
          status.textContent = err.error || 'Save failed';
          status.style.color = 'var(--error, #f44336)';
        }
      } catch (_error) {
        status.textContent = 'Network error';
        status.style.color = 'var(--error, #f44336)';
      }
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    });

    clearBtn.addEventListener('click', async () => {
      clearBtn.disabled = true;
      try {
        await fetch('/api/user/settings/openrouter_api_key', { method: 'DELETE' });
        input.value = '';
        input.placeholder = 'sk-or-...';
        status.textContent = 'Cleared';
        status.style.color = 'var(--text-muted)';
      } catch {
        status.textContent = 'Failed to clear';
        status.style.color = 'var(--error, #f44336)';
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

  function renderGiteaSection(giteaUrl) {
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

    // Load user settings to display Gitea info
    fetch('/api/user/settings')
      .then((r) => r.json())
      .then((data) => {
        const username = data.settings?.gitea_username;
        const token = data.settings?.gitea_api_token;
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
        await fetch('/api/user/settings/gitea_api_token', { method: 'DELETE' });
        await fetch('/api/user/settings/gitea_username', { method: 'DELETE' });
        usernameValue.textContent = '—';
        statusBadge.textContent = 'Reset — log in again to re-provision';
        statusBadge.style.background = 'var(--bg-secondary)';
        statusBadge.style.color = 'var(--text-muted)';
        repoLink.style.display = 'none';
        resetBtn.style.display = 'none';
      } catch {
        resetBtn.textContent = 'Failed';
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

  function renderWorkspaceTab() {
    const fragment = document.createDocumentFragment();
    const wingmanCard = document.createElement('section');
    wingmanCard.className = 'wm-card';

    const wingmanHeading = document.createElement('h2');
    wingmanHeading.textContent = 'Workspace';
    const wingmanDescription = document.createElement('p');
    wingmanDescription.textContent = 'Everything related to this Wingman workspace lives here.';
    wingmanCard.append(wingmanHeading, wingmanDescription);

    if (state.identity.authenticated) {
      wingmanCard.append(renderApiKeysSection());
      const giteaPlaceholder = document.createElement('div');
      wingmanCard.append(giteaPlaceholder);
      fetch('/api/config')
        .then((r) => r.json())
        .then((cfg) => {
          if (cfg.giteaUrl) {
            giteaPlaceholder.replaceWith(renderGiteaSection(cfg.giteaUrl));
          }
        })
        .catch(() => {});
    }

    fragment.append(wingmanCard);
    return fragment;
  }

  function renderAssignedPortsSection() {
    const portsContainer = document.createElement('section');
    portsContainer.className = 'wm-card';

    const portsHeading = document.createElement('h2');
    portsHeading.textContent = 'Assigned Web App Ports';
    portsContainer.append(portsHeading);

    const portsList = document.createElement('ul');
    portsList.className = 'wm-settings__port-list';
    const assignedPorts = Array.isArray(state.identity.ports) ? normalisePortList(state.identity.ports) : [];
    if (assignedPorts.length > 0) {
      assignedPorts.forEach((port) => {
        const item = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = String(port);
        item.append(code);
        portsList.append(item);
      });
    } else {
      const item = document.createElement('li');
      item.className = 'wm-settings__port-empty';
      item.textContent = state.identity.authenticated ? 'Assigned ports will appear here once available.' : 'Sign in to view your assigned ports.';
      portsList.append(item);
    }

    const portsNote = document.createElement('p');
    portsNote.className = 'wm-settings__port-note';
    portsNote.textContent = 'These dedicated ports are reserved for your personal Wingman web applications.';
    portsContainer.append(portsList, portsNote);

    if (state.identity.isAdmin) {
      const adminPortsActions = document.createElement('div');
      adminPortsActions.className = 'wm-settings__ports-admin-actions';
      const generatePortsButton = document.createElement('button');
      generatePortsButton.type = 'button';
      generatePortsButton.className = 'wm-button secondary';
      generatePortsButton.textContent = 'Generate 3 More Ports';
      generatePortsButton.addEventListener('click', async () => {
        generatePortsButton.disabled = true;
        generatePortsButton.textContent = 'Generating…';
        const result = await generateAdminPorts(3);
        if (result && result.success) {
          render();
        } else {
          generatePortsButton.disabled = false;
          generatePortsButton.textContent = 'Generate 3 More Ports';
          alert(result?.error || 'Failed to generate ports');
        }
      });
      adminPortsActions.append(generatePortsButton);
      portsContainer.append(adminPortsActions);
    }

    return portsContainer;
  }

  function renderProfileTab() {
    const fragment = document.createDocumentFragment();
    fragment.append(renderIdentityPanel());
    return fragment;
  }

  function renderProjectsTab() {
    const fragment = document.createDocumentFragment();
    if (state.identity.authenticated) {
      if (!npubProjectsState.loading && npubProjectsState.items.length === 0 && !npubProjectsState.error) {
        fetchNpubProjects().then(() => {
          if (getCurrentRoute() === 'settings') {
            render();
          }
        });
      }
      fragment.append(renderNpubProjectsPanel(() => {
        fetchNpubProjects().then(() => {
          if (getCurrentRoute() === 'settings') {
            render();
          }
        });
      }));
    } else {
      const note = document.createElement('section');
      note.className = 'wm-card';
      note.innerHTML = '<h2>Projects</h2><p>Sign in to view and manage Npub Projects.</p>';
      fragment.append(note);
    }
    return fragment;
  }

  function renderUsersTab() {
    const fragment = document.createDocumentFragment();
    fragment.append(renderAssignedPortsSection());

    if (state.identity.isAdmin) {
      if (!state.adminUsers.initialized && !state.adminUsers.loading && !state.adminUsers.error) {
        void fetchAdminUsers();
      }
      fragment.append(renderAdminUsersPanel());
      return fragment;
    }

    const note = document.createElement('section');
    note.className = 'wm-card';
    note.innerHTML = '<h2>Users</h2><p>Admin access is required to view user management and balance tools.</p>';
    fragment.append(note);
    return fragment;
  }

  function renderAdminTab() {
    const fragment = document.createDocumentFragment();
    ensureFeatureFlagsLoaded();
    fragment.append(renderFeatureFlagsPanel());

    const coreApp = appsStore().items.find((item) => item?.id === 'wingman-core');
    if (coreApp) {
      const coreSection = document.createElement('section');
      coreSection.className = 'wm-card wm-app-card-core';
      coreSection.append(renderWingmanCard(coreApp));
      fragment.append(coreSection);
    }

    return fragment;
  }

  function renderSettings() {
    const wrapper = document.createElement('div');
    wrapper.className = 'wm-settings';

    const pageTitle = document.createElement('h1');
    pageTitle.textContent = 'Settings';
    wrapper.append(pageTitle);

    const tabDefs = [
      { id: 'profile', label: 'Profile', render: renderProfileTab },
      { id: 'workspace', label: 'Workspace', render: renderWorkspaceTab },
      { id: 'users', label: 'Users', render: renderUsersTab },
      { id: 'projects', label: 'Projects', render: renderProjectsTab },
    ];

    if (state.identity.isAdmin) {
      tabDefs.push({ id: 'admin', label: 'Admin', render: renderAdminTab });
    }

    wrapper.append(createSettingsTabs({
      tabDefs,
      activeTabId: state.ui?.settingsActiveTabId ?? tabDefs[0]?.id,
      onTabChange: (tabId) => {
        if (!state.ui) state.ui = {};
        state.ui.settingsActiveTabId = tabId;
      },
    }));
    return wrapper;
  }

  return { renderSettings };
}
