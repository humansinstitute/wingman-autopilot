/**
 * Settings page renderer — identity, wingman settings, admin tools.
 *
 * Depends on: state, render, various panel renderers, admin APIs (via DI).
 */

import { createSettingsTabs } from './settings-tabs.js';
import {
  createApiKeysSection,
  createGitHubSection,
  createGiteaSection,
} from './settings/workspace-sections.js';
import { createDefaultAgentSection } from './settings/profile-sections.js';
import { createTeamBillingSection } from './settings/admin-billing-section.js';
import { createAgentChatSection, createAgentDispatchLauncher } from './settings/agent-chat-section.js';

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
    ensureStarterProjectsLoaded,
    renderStarterProjectsPanel,
    npubProjectsState,
    fetchNpubProjects,
    renderNpubProjectsPanel,
  } = deps;

  function navigateToAgentsSettings() {
    window.history.pushState({ route: 'settings' }, '', '/settings/agents');
    render();
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
      wingmanCard.append(createApiKeysSection());
      wingmanCard.append(createGitHubSection());
      wingmanCard.append(createAgentDispatchLauncher({ onNavigate: navigateToAgentsSettings }));
      const giteaPlaceholder = document.createElement('div');
      wingmanCard.append(giteaPlaceholder);
      fetch('/api/config')
        .then((r) => r.json())
        .then((cfg) => {
          if (cfg.giteaUrl) {
            giteaPlaceholder.replaceWith(createGiteaSection(cfg.giteaUrl));
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
    fragment.append(createDefaultAgentSection({ state }));
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
    fragment.append(createTeamBillingSection());
    ensureFeatureFlagsLoaded();
    fragment.append(renderFeatureFlagsPanel());
    ensureStarterProjectsLoaded();
    fragment.append(renderStarterProjectsPanel());

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

    const path = typeof window !== 'undefined' ? window.location.pathname : '/settings';
    if (path.startsWith('/settings/agents')) {
      const pageTitle = document.createElement('h1');
      pageTitle.textContent = 'Settings';
      wrapper.append(pageTitle);

      const backButton = document.createElement('button');
      backButton.type = 'button';
      backButton.className = 'wm-button secondary';
      backButton.textContent = 'Back To Settings';
      backButton.addEventListener('click', () => {
        window.history.pushState({ route: 'settings' }, '', '/settings');
        render();
      });
      wrapper.append(backButton);
      wrapper.append(createAgentChatSection({ standalone: true }));
      return wrapper;
    }

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
